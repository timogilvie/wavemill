/**
 * Loader for the MQ-0.1 cost-per-task baseline (HOK-3336).
 *
 * Reads only data wavemill already writes — it adds no telemetry:
 *
 * - `.wavemill/evals/evals.jsonl` (streamed; ~78 MB) — merged tasks in the
 *   window, their measured sessions (`executionEconomics`), phase durations
 *   and CI checks.
 * - `.wavemill/state-archive/tombstones.jsonl` — terminal outcome counts.
 * - `.wavemill/merge-lane/<pr>/progress.json` — lane entry, merge attempts,
 *   rebases and CI restarts.
 * - `.wavemill/label-writes.jsonl` — `wm:ready` / `wm:merging` / `wm:merged`
 *   / `wm:blocked` writes (the enqueue boundary for queue wait and depth).
 * - the review stage result (live or archived) via `readStageResult` — review rounds.
 * - optionally, one `gh pr list` call for PR merge/close times (labels
 *   persist on closed PRs, so the ledger cannot say when a PR left the queue).
 *
 * Session costs are read as the cost engine recorded them on the eval row
 * (`actualCostUsd`, else `estimatedCostUsd`); nothing is re-priced here.
 *
 * @module cost-baseline/loader
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveEvalsDir } from '../evals-paths.ts';
import { resolveFromMainRepo } from '../git-utils.ts';
import { readStageResult } from '../stage-result.ts';
import { isChallengerTaskId } from '../task-identity.ts';
import type {
  ArchivedReview,
  BaselineCiCheck,
  BaselineReviewIteration,
  BaselineSession,
  BaselineTask,
  BaselineWindow,
  CohortCounts,
  LabelEvent,
  LaneProgress,
  LoadedBaseline,
  PrState,
} from './types.ts';

/** Every input file the baseline reads. Tests inject temp paths. */
export interface BaselineSources {
  repoDir: string;
  evalsPath: string;
  tombstonesPath: string;
  mergeLaneDir: string;
  labelWritesPath: string;
}

/** Resolve the input files from the main checkout of `repoDir` (worktree-aware). */
export function resolveBaselineSources(repoDir: string): BaselineSources {
  return {
    repoDir,
    evalsPath: join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl'),
    tombstonesPath: resolveFromMainRepo('.wavemill/state-archive/tombstones.jsonl', repoDir),
    mergeLaneDir: resolveFromMainRepo('.wavemill/merge-lane', repoDir),
    labelWritesPath: resolveFromMainRepo('.wavemill/label-writes.jsonl', repoDir),
  };
}

type Json = Record<string, unknown>;

/** A task as read from its eval row, before the lane/label/review/PR joins. */
export type EvalCohortTask = Omit<BaselineTask, 'lane' | 'labelEvents' | 'review' | 'prState'>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function inWindow(timestamp: string | null, window: BaselineWindow): boolean {
  if (!timestamp) return false;
  const t = Date.parse(timestamp);
  return Number.isFinite(t) && t >= Date.parse(window.since) && t <= Date.parse(window.until);
}

/** PR number from a GitHub PR URL; null for anything else. */
export function prNumberFromUrl(prUrl: unknown): number | null {
  const match = typeof prUrl === 'string' ? /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Reduce one `executionEconomics[].sessions[]` entry. Turn arrays are reduced
 * to their first/last timestamps (turns are chronological in the record).
 */
function reduceSession(raw: Json, harness: string | null): BaselineSession | null {
  const sessionId = str(raw.sessionId);
  if (!sessionId) return null;
  const role = asObject(raw.stageRole);
  const kind = str(role?.kind) ?? str(role?.value) ?? 'unattributed';
  const evidence = str(role?.evidence);
  const turns = asArray(raw.turns).map(asObject).filter((t): t is Json => t !== null);
  const usage = asObject(raw.usage) ?? {};
  return {
    sessionId,
    harness,
    kind,
    confidence: str(role?.confidence),
    launchEvidence: evidence && evidence.startsWith('launch ') ? evidence : null,
    costUsd: num(raw.actualCostUsd) ?? num(raw.estimatedCostUsd),
    costSource: str(raw.costSource),
    firstTurnAt: turns.length > 0 ? str(turns[0].timestamp) : null,
    lastTurnAt: turns.length > 0 ? str(turns[turns.length - 1].timestamp) : null,
    turnCount: num(raw.turnCount) ?? turns.length,
    tokens: {
      input: num(usage.inputTokens) ?? 0,
      output: num(usage.outputTokens) ?? 0,
      cacheRead: num(usage.cacheReadTokens) ?? 0,
      cacheWrite: num(usage.cacheWriteTokens) ?? 0,
    },
  };
}

/** Reduce an eval row to the cohort fields; label/lane/review joins come later. */
export function reduceEvalRecord(record: Json): EvalCohortTask | null {
  const issueId = str(record.issueId);
  const timestamp = str(record.timestamp);
  if (!issueId || !timestamp) return null;
  const outcomes = asObject(record.outcomes) ?? {};
  const ci = asObject(outcomes.ci) ?? {};
  const delivery = asObject(outcomes.delivery) ?? {};
  const durations = asObject(record.phaseDurationsSeconds) ?? {};
  const sessions: BaselineSession[] = [];
  for (const economics of asArray(record.executionEconomics)) {
    const econ = asObject(economics);
    if (!econ) continue;
    const harness = str(econ.harness);
    for (const session of asArray(econ.sessions)) {
      const raw = asObject(session);
      const reduced = raw ? reduceSession(raw, harness) : null;
      if (reduced) sessions.push(reduced);
    }
  }
  const ciChecks: BaselineCiCheck[] = asArray(ci.checks)
    .map(asObject)
    .filter((c): c is Json => c !== null)
    .map((c) => ({ name: str(c.name) ?? '?', status: str(c.status) ?? '?', durationSeconds: num(c.durationSeconds) }));
  const phaseDurations: BaselineTask['phaseDurations'] = {};
  for (const phase of ['planning', 'coding', 'review', 'total'] as const) {
    const value = num(durations[phase]);
    if (value !== null) phaseDurations[phase] = value;
  }
  return {
    issueId,
    isChallenger: isChallengerTaskId(issueId),
    evalTimestamp: timestamp,
    prNumber: prNumberFromUrl(record.prUrl),
    workflowCost: num(record.workflowCost),
    workflowCostStatus: str(record.workflowCostStatus),
    phaseDurations,
    timeToMergeSeconds: num(delivery.timeToMergeSeconds),
    ciChecks,
    ciPassed: typeof ci.passed === 'boolean' ? ci.passed : null,
    sessions,
  };
}

async function* readJsonLines(path: string, onMalformed: () => void): AsyncGenerator<Json> {
  if (!existsSync(path)) return;
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = asObject(JSON.parse(line));
      if (parsed) yield parsed;
      else onMalformed();
    } catch {
      onMalformed();
    }
  }
}

/** Stream `evals.jsonl`; keep the latest merged row per issue in the window. */
export async function loadMergedEvalCohort(
  evalsPath: string,
  window: BaselineWindow,
): Promise<{ tasks: Array<EvalCohortTask>; counts: Omit<CohortCounts, 'tombstonesByOutcome'> }> {
  const counts = { evalRowsInWindow: 0, mergedRows: 0, duplicateRowsCollapsed: 0, malformedLines: 0 };
  const byIssue = new Map<string, EvalCohortTask>();
  for await (const record of readJsonLines(evalsPath, () => counts.malformedLines++)) {
    if (!inWindow(str(record.timestamp), window)) continue;
    counts.evalRowsInWindow++;
    const delivery = asObject(asObject(record.outcomes)?.delivery);
    if (delivery?.merged !== true) continue;
    const reduced = reduceEvalRecord(record);
    if (!reduced) continue;
    counts.mergedRows++;
    const previous = byIssue.get(reduced.issueId);
    if (previous) {
      counts.duplicateRowsCollapsed++;
      if (Date.parse(previous.evalTimestamp) > Date.parse(reduced.evalTimestamp)) continue;
    }
    byIssue.set(reduced.issueId, reduced);
  }
  const tasks = [...byIssue.values()].sort((a, b) => a.evalTimestamp.localeCompare(b.evalTimestamp));
  return { tasks, counts };
}

/** Tombstones created inside the window, counted by `workflowOutcome`. */
export async function loadTombstoneCounts(path: string, window: BaselineWindow): Promise<Record<string, number>> {
  const byOutcome: Record<string, number> = {};
  for await (const row of readJsonLines(path, () => {})) {
    if (!inWindow(str(row.createdAt), window)) continue;
    const outcome = str(row.workflowOutcome) ?? 'unknown';
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }
  return byOutcome;
}

/** Every `merge-lane/<pr>/progress.json`; unreadable files are skipped. */
export function loadLaneProgress(mergeLaneDir: string): LaneProgress[] {
  if (!existsSync(mergeLaneDir)) return [];
  const rows: LaneProgress[] = [];
  for (const entry of readdirSync(mergeLaneDir)) {
    const path = join(mergeLaneDir, entry, 'progress.json');
    if (!existsSync(path)) continue;
    let raw: Json | null;
    try {
      raw = asObject(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      continue;
    }
    const prNumber = num(raw?.prNumber) ?? (Number.isInteger(Number(entry)) ? Number(entry) : null);
    if (!raw || prNumber === null) continue;
    rows.push({
      prNumber,
      enteredLaneAt: str(raw.enteredLaneAt),
      lastProgressAt: str(raw.lastProgressAt),
      lastEvent: str(raw.lastEvent),
      laneHoldSeconds: num(raw.laneHoldSeconds),
      mergeAttemptCount: num(raw.mergeAttemptCount),
      rebaseCount: num(raw.rebaseCount),
      ciRestartCount: num(raw.ciRestartCount),
    });
  }
  return rows.sort((a, b) => a.prNumber - b.prNumber);
}

/** Every label-ledger row, sorted by time. */
export async function loadLabelEvents(path: string): Promise<LabelEvent[]> {
  const events: LabelEvent[] = [];
  for await (const row of readJsonLines(path, () => {})) {
    const at = str(row.at);
    const prNumber = num(row.prNumber);
    const label = str(row.label);
    const action = row.action === 'labeled' || row.action === 'unlabeled' ? row.action : null;
    if (!at || prNumber === null || !label || !action || !Number.isFinite(Date.parse(at))) continue;
    events.push({ at, prNumber, label, action });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function reduceReviewIteration(raw: Json): BaselineReviewIteration | null {
  const iteration = num(raw.iteration);
  if (iteration === null) return null;
  const delta = asObject(raw.reviewerDelta);
  const filesChanged = delta && Array.isArray(delta.filesChanged)
    ? delta.filesChanged.filter((f): f is string => typeof f === 'string')
    : null;
  return {
    iteration,
    recordedAt: str(raw.recordedAt),
    verdict: str(raw.verdict),
    findings: asArray(raw.findings)
      .map(asObject)
      .filter((f): f is Json => f !== null)
      .map((f) => ({ location: str(f.location) ?? '', severity: str(f.severity) ?? '?' })),
    filesChanged,
  };
}

/** Reduce a review stage result to what round counting reads; null when it is not one. */
export function reduceArchivedReview(result: unknown): ArchivedReview | null {
  const artifacts = asObject(asObject(result)?.artifacts);
  if (!artifacts) return null;
  const reviewIterations = Array.isArray(artifacts.reviewIterations)
    ? artifacts.reviewIterations
        .map(asObject)
        .filter((r): r is Json => r !== null)
        .map(reduceReviewIteration)
        .filter((r): r is BaselineReviewIteration => r !== null)
    : null;
  return { iterations: num(artifacts.iterations), reviewIterations };
}

/**
 * The task's review stage result, live or archived, through the one
 * stage-artifact lookup (HOK-2891). Archives written before the archiver
 * kept the dotted name need `tools/migrate-archived-stage-artifacts.ts`.
 */
export async function loadArchivedReview(issueId: string, repoDir: string): Promise<ArchivedReview | null> {
  return reduceArchivedReview(await readStageResult({ issueId, stage: 'review', repoDir }));
}

/** Parse `gh pr list --json number,state,mergedAt,closedAt` output. */
export function parsePrStates(json: string): Map<number, PrState> {
  const states = new Map<number, PrState>();
  for (const item of asArray(JSON.parse(json))) {
    const row = asObject(item);
    const prNumber = num(row?.number);
    const state = row?.state;
    if (!row || prNumber === null || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) continue;
    states.set(prNumber, { prNumber, state, mergedAt: str(row.mergedAt), closedAt: str(row.closedAt) });
  }
  return states;
}

/**
 * Fetch every PR's state in one read-only `gh pr list` call. Opt-in
 * (`--fetch-pr-state`): the rest of the baseline reads local files only.
 */
export function fetchPrStates(repoDir: string, limit = 2000): Map<number, PrState> {
  const out = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', 'number,state,mergedAt,closedAt'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return parsePrStates(out);
}

export interface LoadBaselineOptions {
  /** GitHub PR states (e.g. from `fetchPrStates`); omitted = local data only. */
  prStates?: Map<number, PrState>;
}

/** Load and join every input for the window. */
export async function loadBaseline(sources: BaselineSources, window: BaselineWindow, options: LoadBaselineOptions = {}): Promise<LoadedBaseline> {
  const prStates = options.prStates ?? new Map<number, PrState>();
  const [cohort, tombstonesByOutcome, labelEvents] = await Promise.all([
    loadMergedEvalCohort(sources.evalsPath, window),
    loadTombstoneCounts(sources.tombstonesPath, window),
    loadLabelEvents(sources.labelWritesPath),
  ]);
  const laneProgress = loadLaneProgress(sources.mergeLaneDir);
  const laneByPr = new Map(laneProgress.map((row) => [row.prNumber, row]));
  const labelsByPr = new Map<number, LabelEvent[]>();
  for (const event of labelEvents) {
    const list = labelsByPr.get(event.prNumber) ?? [];
    list.push(event);
    labelsByPr.set(event.prNumber, list);
  }
  const tasks: BaselineTask[] = [];
  for (const task of cohort.tasks) {
    tasks.push({
      ...task,
      lane: task.prNumber !== null ? laneByPr.get(task.prNumber) ?? null : null,
      labelEvents: task.prNumber !== null ? labelsByPr.get(task.prNumber) ?? [] : [],
      review: await loadArchivedReview(task.issueId, sources.repoDir),
      prState: task.prNumber !== null ? prStates.get(task.prNumber) ?? null : null,
    });
  }
  return {
    window,
    tasks,
    counts: { ...cohort.counts, tombstonesByOutcome },
    labelEvents,
    laneProgress,
    prStates,
  };
}
