/**
 * Tend blocked-lane candidates for incident correlation (HOK-2595).
 *
 * The stalled-lifecycle correlator needs to know which PRs Tend is holding
 * and why. Two read-only sources feed it:
 *
 * 1. `services.tend.blockedLane` in `.wavemill/backstage-health.json`, written
 *    by every idle Tend poll (see `buildTendBlockedLane` in `tend-loop.ts`).
 *    It is the primary source: it covers every blocked PR and is fresh each
 *    tick, but it only counts while `laneCondition === 'idle-blocked-stall'`
 *    and the heartbeat is recent — ordinary short holds are not stalls.
 * 2. The consume-once `merge-lane-idle-stall` observer finding, emitted on
 *    the 30/120-poll thresholds. Secondary; kept so a stall marker from a
 *    Tend build without `blockedLane` is still correlated.
 *
 * Nothing here mutates state or calls GitHub.
 *
 * @module wavemill-incident-tend-candidates
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TendCandidateDiagnostic } from './wavemill-incident-detector.ts';
import { ISSUE_ID_WORD_RE } from './task-identity.ts';

/** Marker kinds the Tend loop uses for an idle-blocked stall. */
export const TEND_STALL_MARKER_KINDS = new Set(['merge-lane-idle-stall', 'merge-lane-idle-stalled']);

/** A heartbeat older than this means Tend is not currently reporting the lane. */
export const TEND_BLOCKED_LANE_FRESH_MS = 15 * 60_000;

/** Bound on candidates correlated per observer tick (each may cost a `gh pr view`). */
export const TEND_CANDIDATES_MAX_PER_TICK = 10;

/** Minimal task shape needed to attribute a blocked PR to its owning task. */
export interface TendCandidateTask {
  issue?: string;
  pr?: string;
  branch?: string;
  challengePairId?: string;
}

/** Minimal finding shape (observer `Finding`) read for marker candidates. */
export interface TendMarkerFinding {
  id: string;
  repoDir?: string;
  issue?: string;
  evidence: string[];
}

/**
 * Candidates from `services.tend.blockedLane`. Returns `[]` when the file is
 * missing or malformed, the heartbeat is stale, or the lane is not in an
 * idle-blocked stall.
 */
export function readTendBlockedLaneCandidates(
  repoDir: string,
  now: Date,
  tasks: TendCandidateTask[] = [],
): TendCandidateDiagnostic[] {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  const tend = readTendService(healthPath);
  if (!tend) return [];
  if (tend.laneCondition !== 'idle-blocked-stall') return [];
  const heartbeatAt = typeof tend.heartbeatAt === 'string' ? tend.heartbeatAt : undefined;
  const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  if (!Number.isFinite(heartbeatMs) || now.getTime() - heartbeatMs > TEND_BLOCKED_LANE_FRESH_MS) return [];
  const lane = Array.isArray(tend.blockedLane) ? tend.blockedLane : [];
  const blockedStreak = typeof tend.blockedStreak === 'number' && Number.isFinite(tend.blockedStreak)
    ? tend.blockedStreak
    : undefined;

  const candidates: TendCandidateDiagnostic[] = [];
  for (const raw of lane) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const pr = typeof entry.pr === 'number' && Number.isInteger(entry.pr) && entry.pr > 0 ? entry.pr : undefined;
    if (!pr) continue;
    const headBranch = typeof entry.headBranch === 'string' ? entry.headBranch : undefined;
    const gate = typeof entry.gate === 'string' && entry.gate.length > 0 ? entry.gate : undefined;
    const labels = Array.isArray(entry.labels)
      ? entry.labels.filter((label): label is string => typeof label === 'string').slice(0, 20)
      : [];
    const task = findTask(tasks, pr, headBranch);
    candidates.push({
      taskId: task?.issue ?? issueIdFromBranch(headBranch),
      pr,
      headBranch: headBranch ?? task?.branch,
      markerKind: 'merge-lane-idle-stall',
      firstBlockedGate: gate,
      pairId: task?.challengePairId,
      labels,
      source: 'backstage-health',
      blockedStreak,
      observedAt: heartbeatAt,
    });
  }
  return candidates;
}

/**
 * Candidates from `merge-lane-idle-stall` marker findings. Every PR in
 * `blockedPrs` becomes a candidate; the recorded gate/labels belong to the
 * first blocked PR only, so they are attached to that PR alone.
 */
export function candidatesFromMarkerFindings(
  findings: TendMarkerFinding[],
  repoDir: string,
  tasks: TendCandidateTask[] = [],
): TendCandidateDiagnostic[] {
  const candidates: TendCandidateDiagnostic[] = [];
  for (const finding of findings) {
    if (finding.repoDir !== repoDir || !finding.id.startsWith('marker-')) continue;
    const fields = evidenceKeyValueMap(finding.evidence);
    const markerKind = fields.get('markerKind');
    if (!markerKind || !TEND_STALL_MARKER_KINDS.has(markerKind)) continue;
    const firstPr = numberFromString(fields.get('firstBlockedPr')) ?? numberFromString(fields.get('prNumber'));
    const prs = uniqueNumbers([
      ...(firstPr ? [firstPr] : []),
      ...numbersFromCsv(fields.get('blockedPrs')),
    ]);
    for (const pr of prs) {
      const task = findTask(tasks, pr, undefined);
      const isFirst = pr === (firstPr ?? prs[0]);
      const firstLabels = fields.get('firstBlockedLabels');
      candidates.push({
        taskId: (isFirst ? finding.issue : undefined) ?? task?.issue,
        pr,
        headBranch: task?.branch,
        markerKind,
        firstBlockedGate: isFirst ? (fields.get('firstBlockedGate') || fields.get('gate') || undefined) : undefined,
        pairId: (isFirst ? fields.get('pairId') : undefined) ?? task?.challengePairId,
        blockedReason: isFirst ? (fields.get('blockedReason') ?? fields.get('tendBlockReason')) : undefined,
        labels: isFirst && firstLabels ? firstLabels.split(',').filter(Boolean).slice(0, 20) : undefined,
        source: 'observer-marker',
        blockedStreak: numberFromString(fields.get('consecutivePolls')),
        observedAt: fields.get('observedAt'),
      });
    }
  }
  return candidates;
}

/**
 * Merge both sources by PR (health wins over marker; marker fills gaps such
 * as a pairId), order by PR number for determinism, and cap per tick.
 */
export function buildTendCandidates(input: {
  repoDir: string;
  now: Date;
  findings: TendMarkerFinding[];
  tasks?: TendCandidateTask[];
  maxCandidates?: number;
}): TendCandidateDiagnostic[] {
  const tasks = input.tasks ?? [];
  const byPr = new Map<number, TendCandidateDiagnostic>();
  for (const candidate of readTendBlockedLaneCandidates(input.repoDir, input.now, tasks)) {
    if (candidate.pr && !byPr.has(candidate.pr)) byPr.set(candidate.pr, candidate);
  }
  for (const candidate of candidatesFromMarkerFindings(input.findings, input.repoDir, tasks)) {
    if (!candidate.pr) continue;
    const existing = byPr.get(candidate.pr);
    if (!existing) {
      byPr.set(candidate.pr, candidate);
      continue;
    }
    byPr.set(candidate.pr, {
      ...existing,
      taskId: existing.taskId ?? candidate.taskId,
      pairId: existing.pairId ?? candidate.pairId,
      firstBlockedGate: existing.firstBlockedGate ?? candidate.firstBlockedGate,
      blockedReason: existing.blockedReason ?? candidate.blockedReason,
    });
  }
  return [...byPr.values()]
    .sort((a, b) => (a.pr ?? 0) - (b.pr ?? 0))
    .slice(0, input.maxCandidates ?? TEND_CANDIDATES_MAX_PER_TICK);
}

function readTendService(healthPath: string): Record<string, unknown> | null {
  if (!existsSync(healthPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(healthPath, 'utf-8')) as unknown;
    const services = isRecord(parsed) && isRecord(parsed.services) ? parsed.services : null;
    return services && isRecord(services.tend) ? services.tend : null;
  } catch {
    return null;
  }
}

function findTask(tasks: TendCandidateTask[], pr: number, headBranch: string | undefined): TendCandidateTask | undefined {
  return tasks.find((task) => prNumberFromTask(task) === pr)
    ?? (headBranch ? tasks.find((task) => task.branch === headBranch) : undefined);
}

function prNumberFromTask(task: TendCandidateTask): number | undefined {
  const match = task.pr?.match(/\d+/);
  return match ? numberFromString(match[0]) : undefined;
}

/** Issue ID embedded in a branch name, via the task-identity invariant's regex. */
function issueIdFromBranch(branch: string | undefined): string | undefined {
  return branch?.match(ISSUE_ID_WORD_RE)?.[0];
}

function evidenceKeyValueMap(evidence: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of evidence) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    map.set(line.slice(0, index), line.slice(index + 1));
  }
  return map;
}

function numberFromString(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/^#/, ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function numbersFromCsv(value: string | undefined): number[] {
  if (!value) return [];
  return value.split(',').map((part) => numberFromString(part.trim())).filter((pr): pr is number => pr !== undefined);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
