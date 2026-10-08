/**
 * HOK-3177 — unattended-rate and time-stuck reliability metrics.
 *
 * Pure functions over three evidence feeds:
 *   - operator events (`.operator-events.jsonl`, `.operator-intervention.json`)
 *   - intervention records (`.wavemill/evals/evals.jsonl`)
 *   - task-progress replays (`.terminal-history.jsonl` + live hook) via the
 *     HOK-3101 `deriveTaskProgress` primitive
 *
 * Collectors never throw: a missing or malformed file is reported through a
 * per-task `coverage` field so the aggregate can be honest about its
 * denominator rather than silently excluding tasks or treating them as
 * unattended.
 *
 * Callers (CLI `tools/report-reliability.ts`, dashboard refresher, replay
 * harness) consume the same pure helpers — the IO adapters live below the
 * core.
 *
 * @module reliability-metrics
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { readJsonlFile } from './jsonl-utils.ts';
import {
  CONTROLLER_HOOK_EVENTS,
  deriveTaskProgress,
  type HookState,
  type TaskProgressInputs,
} from './task-progress.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type TouchKind =
  | 'operator-event'
  | 'operator-intervention'
  | 'eval-intervention'
  | 'pane-message'
  | 'session-redirect';

export interface TouchEvent {
  kind: TouchKind;
  at: string;
  detail?: string;
  /** De-dupe bucket key: `<minute-ISO>|<kind>` for near-coincident records. */
  bucket: string;
}

export type MetricCoverage = 'full' | 'partial' | 'none';

export interface MergedTaskRef {
  /** Linear issue id if recoverable (e.g. "HOK-3170"), else undefined. */
  issue?: string;
  /** PR number parsed from the merge-commit subject's `(#N)`. */
  prNumber?: string;
  /** PR title / merge commit subject. */
  title: string;
  mergedAt: string;
  branch?: string;
  slug?: string;
  /** Path to the (possibly reaped) feature directory, if known. */
  featureDir?: string;
  /** Path to the task's worktree, if known. */
  worktree?: string;
}

export interface TaskReliability {
  task: MergedTaskRef;
  touches: TouchEvent[];
  touchCount: number;
  stuckMs: number;
  stuckCoverage: MetricCoverage;
  stallIntervals: StallInterval[];
}

export interface StallInterval {
  /** ISO start of the stalled interval. */
  from: string;
  /** ISO end of the stalled interval. */
  to: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

export interface ReliabilityBucket {
  /** `YYYY-MM-DD` for a daily bucket; a `YYYY-MM-DD..YYYY-MM-DD` window for rolling. */
  key: string;
  /** Human-readable label (e.g. "2026-10-08" or "7d rolling"). */
  label: string;
  merged: number;
  unattended: number;
  unattendedRate: number | null;
  stuckP50Ms: number | null;
  stuckP90Ms: number | null;
  coverage: {
    full: number;
    partial: number;
    none: number;
  };
}

export interface ReliabilitySummary {
  generatedAt: string;
  since: string;
  until: string;
  bucket: 'daily' | 'rolling7d';
  overall: ReliabilityBucket;
  buckets: ReliabilityBucket[];
  tasks: TaskReliability[];
}

// ── Config / tunables ────────────────────────────────────────────────────────

/** Dedup window for near-coincident touches of the same `kind`. */
export const TOUCH_DEDUP_WINDOW_SECONDS = 60;

/** Default stall threshold mirrors task-progress.ts. */
export const DEFAULT_STALL_MINUTES = 30;

/**
 * Patterns recognized as merge commits on the integration/main lanes.
 *
 * - Squash/semantic merges put `(#1234)` at the end of the subject
 *   (`HOK-3170: foo (#1600)`).
 * - Classic merge commits say `Merge pull request #1234 from <branch>`.
 *
 * Promotion merges (`auto/integration` → `main`) with no PR number in the
 * subject are intentionally kept out of the denominator — they are not
 * independent task merges.
 */
const MERGE_SUBJECT_PR_RE = /\(#(\d+)\)\s*$/;
const MERGE_PR_PREFIX_RE = /^Merge pull request #(\d+) from /;
const PROMOTION_BRANCH_RE = /\bauto\/(?:promotion|integration)\b/;
const ISSUE_IN_SUBJECT_RE = /\b([A-Z]{2,6}-\d+)\b/;

// ── Pure helpers ─────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseMs(input: string | null | undefined): number | null {
  if (!input) return null;
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
}

function dedupBucketKey(iso: string, kind: TouchKind): string {
  const ms = parseMs(iso);
  const window = TOUCH_DEDUP_WINDOW_SECONDS * 1000;
  const slot = ms !== null ? Math.floor(ms / window) : 0;
  return `${slot}|${kind}`;
}

/** De-duplicate touches by `(kind, 60s minute bucket)`; keep earliest. */
export function dedupeTouches(touches: TouchEvent[]): TouchEvent[] {
  const seen = new Map<string, TouchEvent>();
  for (const t of touches.slice().sort((a, b) => parseMs(a.at)! - parseMs(b.at)!)) {
    const key = dedupBucketKey(t.at, t.kind);
    if (!seen.has(key)) seen.set(key, { ...t, bucket: key });
  }
  return [...seen.values()].sort((a, b) => parseMs(a.at)! - parseMs(b.at)!);
}

/**
 * Compute percentile over an already-sorted ascending array of numbers.
 * Returns `null` for an empty array.
 */
export function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Derive stall intervals by replaying a sequence of `TaskProgressInputs`
 * snapshots through `deriveTaskProgress`, finding ranges where `stalled` is
 * true. Each entry is treated as a snapshot taken at `atMs`.
 *
 * The replay is intentionally pure — `now` is injected per snapshot so the
 * caller can replay historical hooks.
 */
export function deriveStallIntervals(
  snapshots: Array<{ atMs: number; inputs: TaskProgressInputs }>,
  opts: { stallMinutes?: number } = {},
): StallInterval[] {
  const stallMinutes = opts.stallMinutes ?? DEFAULT_STALL_MINUTES;
  const intervals: StallInterval[] = [];
  let openFromMs: number | null = null;
  let lastSnapshotMs: number | null = null;

  for (const snap of snapshots) {
    const result = deriveTaskProgress(snap.inputs, {
      now: new Date(snap.atMs),
      stallMinutes,
    });
    if (result.stalled && openFromMs === null) {
      openFromMs = snap.atMs;
    } else if (!result.stalled && openFromMs !== null) {
      intervals.push({
        from: iso(openFromMs),
        to: iso(snap.atMs),
        durationMs: Math.max(0, snap.atMs - openFromMs),
      });
      openFromMs = null;
    }
    lastSnapshotMs = snap.atMs;
  }
  if (openFromMs !== null && lastSnapshotMs !== null && lastSnapshotMs > openFromMs) {
    intervals.push({
      from: iso(openFromMs),
      to: iso(lastSnapshotMs),
      durationMs: lastSnapshotMs - openFromMs,
    });
  }
  return intervals;
}

/** Sum of stall interval durations in ms. */
export function sumStallMs(intervals: StallInterval[]): number {
  return intervals.reduce((acc, i) => acc + i.durationMs, 0);
}

// ── IO: merged tasks ─────────────────────────────────────────────────────────

export interface CollectMergedOptions {
  repoDir: string;
  sinceIso: string;
  untilIso: string;
  /** Branches to scan with `git log --merges`. */
  branches?: string[];
}

/**
 * Collect merged tasks over the window by scanning `git log --merges` on the
 * configured branches. Reaped tasks are **gone** from workflow-state.json, so
 * git is the authoritative merge-event source — the metric is honest about
 * its denominator even when state has been cleaned up.
 */
export function collectMergedTasks(opts: CollectMergedOptions): MergedTaskRef[] {
  const branches = opts.branches && opts.branches.length > 0 ? opts.branches : ['main', 'auto/integration'];
  const results: MergedTaskRef[] = [];
  const seen = new Set<string>();

  for (const branch of branches) {
    // Scan all commits on the branch (squash merges don't produce merge
    // commits; both styles are detected via subject-pattern filtering below).
    const out = safeGit(opts.repoDir, [
      'log',
      `--since=${opts.sinceIso}`,
      `--until=${opts.untilIso}`,
      '--format=%H%x1f%cI%x1f%s%x1e',
      branch,
    ]);
    if (!out) continue;
    const records = out.split('\x1e').map((r) => r.trim()).filter(Boolean);
    for (const r of records) {
      const [sha, committedIso, subject] = r.split('\x1f');
      if (!sha || !subject) continue;

      // Try squash-merge style first, then classic merge-commit style.
      const squashMatch = subject.match(MERGE_SUBJECT_PR_RE);
      const classicMatch = subject.match(MERGE_PR_PREFIX_RE);
      const prNumber = squashMatch ? squashMatch[1] : classicMatch ? classicMatch[1] : undefined;

      // Skip promotion/integration merges that don't represent a task.
      if (!prNumber || PROMOTION_BRANCH_RE.test(subject)) continue;

      const issueMatch = subject.match(ISSUE_IN_SUBJECT_RE);
      const issue = issueMatch ? issueMatch[1] : undefined;
      const key = `pr:${prNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        issue,
        prNumber,
        title: subject,
        mergedAt: committedIso,
        ...resolveTaskPathsForMerged(opts.repoDir, issue),
      });
    }
  }
  return results;
}

function resolveTaskPathsForMerged(repoDir: string, issue: string | undefined): { featureDir?: string; worktree?: string; slug?: string } {
  if (!issue) return {};
  const config = loadWavemillConfig(repoDir);
  const configuredRoot = config.mill?.worktreeRoot;
  const worktreeRoots = [configuredRoot, 'worktrees'].filter((v): v is string => Boolean(v));
  const slugCandidates = [issue.toLowerCase(), issue];

  for (const root of worktreeRoots) {
    const absRoot = resolve(repoDir, root);
    if (!existsSync(absRoot)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(absRoot); } catch { entries = []; }
    for (const entry of entries) {
      // The worktree slug is typically `<issue-lowercase>-<description>`.
      const lower = entry.toLowerCase();
      if (!slugCandidates.some((s) => lower.startsWith(s.toLowerCase()))) continue;
      const wt = join(absRoot, entry);
      for (const kind of ['features', 'bugs']) {
        const featureDir = join(wt, kind, entry);
        if (existsSync(featureDir)) {
          return { featureDir, worktree: wt, slug: entry };
        }
      }
    }
  }

  // Fall back to main-checkout features/bugs
  for (const kind of ['features', 'bugs']) {
    const base = resolve(repoDir, kind);
    if (!existsSync(base)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { entries = []; }
    for (const entry of entries) {
      if (!slugCandidates.some((s) => entry.toLowerCase().startsWith(s.toLowerCase()))) continue;
      return { featureDir: join(base, entry), slug: entry };
    }
  }
  return {};
}

// ── IO: operator touches ─────────────────────────────────────────────────────

interface OperatorEventRecord {
  seq?: number;
  command?: string;
  issue?: string;
  at?: string;
  detail?: string;
}

interface OperatorInterventionRecordRaw {
  occurredAt?: string;
  trigger?: string;
  summary?: string;
}

interface EvalRecordRow {
  issueId?: string;
  timestamp?: string;
  interventionCount?: number;
  interventions?: Array<{ timestamp?: string; type?: string; note?: string }>;
}

export interface CollectTouchesOptions {
  repoDir: string;
  task: MergedTaskRef;
  evalsPath?: string;
}

/**
 * Collect operator touches for one task from four source classes, de-duped
 * by a 60-second kind-bucket so a `.operator-events.jsonl` entry and an eval
 * `interventions[]` entry recorded within the same minute count as one touch.
 */
export function collectOperatorTouches(opts: CollectTouchesOptions): TouchEvent[] {
  const raw: TouchEvent[] = [];
  const { task } = opts;

  if (task.featureDir) {
    raw.push(...readOperatorEvents(task.featureDir));
    raw.push(...readOperatorInterventionArtifacts(task.featureDir));
    raw.push(...readPaneMessageTouches(task.featureDir));
  }

  const evalsPath = opts.evalsPath ?? defaultEvalsPath(opts.repoDir);
  if (evalsPath && task.issue) {
    raw.push(...readEvalInterventions(evalsPath, task.issue));
  }

  return dedupeTouches(raw);
}

function readOperatorEvents(featureDir: string): TouchEvent[] {
  const path = join(featureDir, '.operator-events.jsonl');
  if (!existsSync(path)) return [];
  const touches: TouchEvent[] = [];
  try {
    for (const entry of readJsonlFile<OperatorEventRecord>(path)) {
      if (!entry.at) continue;
      touches.push({
        kind: 'operator-event',
        at: entry.at,
        detail: `${entry.command ?? 'operator'}${entry.detail ? `: ${entry.detail}` : ''}`,
        bucket: '',
      });
    }
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to read ${path}: ${errorMessage(err)}`);
  }
  return touches;
}

function readOperatorInterventionArtifacts(featureDir: string): TouchEvent[] {
  const path = join(featureDir, '.operator-intervention.json');
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to parse ${path}: ${errorMessage(err)}`);
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const touches: TouchEvent[] = [];
  for (const v of values) {
    const rec = v as OperatorInterventionRecordRaw | null;
    if (!rec || !rec.occurredAt) continue;
    touches.push({
      kind: 'operator-intervention',
      at: rec.occurredAt,
      detail: rec.trigger ?? rec.summary,
      bucket: '',
    });
  }
  return touches;
}

/**
 * Pane-message touches: hook archives whose record carries `writer=user`.
 * Current adapters never emit `user` directly, but the primitive classifies
 * missing-writer legacy entries sensibly, so this stays conservative and only
 * promotes an *explicit* `writer=user` to a touch.
 */
function readPaneMessageTouches(featureDir: string): TouchEvent[] {
  const path = join(featureDir, '.terminal-history.jsonl');
  if (!existsSync(path)) return [];
  const touches: TouchEvent[] = [];
  try {
    for (const entry of readJsonlFile<{ archivedAt?: string; payload?: { writer?: string; timestamp?: number; event?: string } }>(path)) {
      const w = entry.payload?.writer;
      if (w !== 'user') continue;
      const ts = entry.payload?.timestamp;
      const at = typeof ts === 'number' && Number.isFinite(ts)
        ? iso(ts * 1000)
        : (entry.archivedAt ?? new Date().toISOString());
      touches.push({
        kind: 'pane-message',
        at,
        detail: entry.payload?.event,
        bucket: '',
      });
    }
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to read ${path}: ${errorMessage(err)}`);
  }
  return touches;
}

function readEvalInterventions(evalsPath: string, issueId: string): TouchEvent[] {
  if (!existsSync(evalsPath)) return [];
  const touches: TouchEvent[] = [];
  try {
    for (const row of readJsonlFile<EvalRecordRow>(evalsPath)) {
      if (row.issueId !== issueId) continue;
      // Prefer per-event timestamps when available
      const events = Array.isArray(row.interventions) ? row.interventions : [];
      if (events.length > 0) {
        for (const ev of events) {
          const at = ev.timestamp || row.timestamp;
          if (!at) continue;
          touches.push({
            kind: ev.type === 'session_redirect' ? 'session-redirect' : 'eval-intervention',
            at,
            detail: ev.type,
            bucket: '',
          });
        }
      } else if ((row.interventionCount ?? 0) > 0 && row.timestamp) {
        // Fall back to the row's `timestamp` with count=N as a single touch each
        for (let i = 0; i < row.interventionCount!; i++) {
          touches.push({
            kind: 'eval-intervention',
            at: row.timestamp,
            bucket: '',
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to read ${evalsPath}: ${errorMessage(err)}`);
  }
  return touches;
}

function defaultEvalsPath(repoDir: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');
}

// ── IO: time stuck ───────────────────────────────────────────────────────────

export interface ComputeTimeStuckOptions {
  task: MergedTaskRef;
  session?: string;
  stallMinutes?: number;
}

export interface ComputeTimeStuckResult {
  stuckMs: number;
  coverage: MetricCoverage;
  stallIntervals: StallInterval[];
}

/**
 * Replay a task's hook archive through the HOK-3101 primitive and sum the
 * stalled-interval durations. The replay is bounded by the archive — a reaped
 * task with no `.terminal-history.jsonl` is reported as `coverage=none` so
 * the aggregator can be honest about missing data.
 */
export function computeTimeStuck(opts: ComputeTimeStuckOptions): ComputeTimeStuckResult {
  const { task } = opts;
  if (!task.featureDir) return { stuckMs: 0, coverage: 'none', stallIntervals: [] };
  const historyPath = join(task.featureDir, '.terminal-history.jsonl');
  const hasHistory = existsSync(historyPath);
  const liveHookPath = opts.session && task.issue
    ? `/tmp/wavemill-${opts.session}-${task.issue}.hook`
    : null;
  const hasLiveHook = Boolean(liveHookPath && existsSync(liveHookPath));

  if (!hasHistory && !hasLiveHook) {
    return { stuckMs: 0, coverage: 'none', stallIntervals: [] };
  }

  const snapshots = loadHookSnapshots(historyPath, liveHookPath);
  if (snapshots.length === 0) {
    return { stuckMs: 0, coverage: hasHistory ? 'partial' : 'none', stallIntervals: [] };
  }

  const stallIntervals = deriveStallIntervals(snapshots, { stallMinutes: opts.stallMinutes });
  const stuckMs = sumStallMs(stallIntervals);
  const coverage: MetricCoverage = hasHistory && snapshots.length >= 2 ? 'full' : 'partial';
  return { stuckMs, coverage, stallIntervals };
}

interface HookArchiveEntry {
  archivedAt?: string;
  payload?: {
    state?: HookState | null;
    event?: string;
    writer?: string;
    agent?: string;
    timestamp?: number;
    detail?: string;
  };
}

interface SnapshotFrame {
  atMs: number;
  inputs: TaskProgressInputs;
}

/**
 * Build an ascending-time list of `(atMs, TaskProgressInputs)` snapshots from
 * the archived hook history plus the current live hook file. Each snapshot's
 * `inputs` only vary in the hook record; the other fields are left empty so
 * the derivation becomes a pure function of hook evidence.
 */
function loadHookSnapshots(historyPath: string, liveHookPath: string | null): SnapshotFrame[] {
  const entries: HookArchiveEntry[] = [];
  if (existsSync(historyPath)) {
    try {
      for (const e of readJsonlFile<HookArchiveEntry>(historyPath)) {
        if (e.payload?.timestamp) entries.push(e);
      }
    } catch (err) {
      console.warn(`[reliability-metrics] Failed to read ${historyPath}: ${errorMessage(err)}`);
    }
  }
  // Live hook: synthesize an archive-shaped frame so the primitive can read it.
  if (liveHookPath && existsSync(liveHookPath)) {
    try {
      const content = readFileSync(liveHookPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.timestamp === 'number') {
        entries.push({ payload: parsed });
      }
    } catch (err) {
      console.warn(`[reliability-metrics] Failed to read live hook ${liveHookPath}: ${errorMessage(err)}`);
    }
  }

  entries.sort((a, b) => (a.payload!.timestamp! - b.payload!.timestamp!));
  const frames: SnapshotFrame[] = [];
  for (const entry of entries) {
    const payload = entry.payload!;
    const atMs = payload.timestamp! * 1000;
    const inputs: TaskProgressInputs = {
      issue: '',
      hookFile: synthesizeHookFile(payload),
      terminalHistoryIdleAt: null,
      latestCommitAt: null,
      launchAt: null,
      worktreeMtimeAt: null,
      statusFileMtimeAt: null,
      transitionSources: [],
      terminal: { prState: null, prNumber: null, lifecycleOutcome: null, at: null },
      agentProcessLive: null,
      backgroundWork: null,
      blockingPrompt: null,
    };
    frames.push({ atMs, inputs });
  }
  return frames;
}

function synthesizeHookFile(payload: NonNullable<HookArchiveEntry['payload']>) {
  const event = payload.event ?? '';
  const writerRaw = payload.writer;
  const isController = writerRaw === 'monitor'
    || (writerRaw !== 'agent' && event.length > 0 && CONTROLLER_HOOK_EVENTS.has(event));
  const writer: 'agent' | 'monitor' = isController ? 'monitor' : 'agent';
  const record = {
    state: payload.state ?? null,
    event,
    agent: payload.agent ?? '',
    timestamp: payload.timestamp ?? 0,
    ...(payload.detail ? { detail: payload.detail } : {}),
  };
  return {
    top: record,
    writer,
    agentRecord: writer === 'agent' ? record : null,
    topTimestamp: payload.timestamp ?? 0,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export interface AggregateOptions {
  sinceIso: string;
  untilIso: string;
  bucket: 'daily' | 'rolling7d';
}

export function aggregateReliability(tasks: TaskReliability[], opts: AggregateOptions): ReliabilitySummary {
  const buckets = opts.bucket === 'daily'
    ? aggregateDaily(tasks, opts.sinceIso, opts.untilIso)
    : [aggregateRolling7d(tasks, opts.sinceIso, opts.untilIso)];
  const overall = aggregateBucket(tasks, `${opts.sinceIso}..${opts.untilIso}`, `${opts.sinceIso.slice(0, 10)} → ${opts.untilIso.slice(0, 10)}`);
  return {
    generatedAt: new Date().toISOString(),
    since: opts.sinceIso,
    until: opts.untilIso,
    bucket: opts.bucket,
    overall,
    buckets,
    tasks,
  };
}

function aggregateDaily(tasks: TaskReliability[], sinceIso: string, untilIso: string): ReliabilityBucket[] {
  const sinceMs = parseMs(sinceIso)!;
  const untilMs = parseMs(untilIso)!;
  const dayMs = 24 * 3600 * 1000;
  const dayStartMs = Math.floor(sinceMs / dayMs) * dayMs;
  const buckets: ReliabilityBucket[] = [];
  for (let d = dayStartMs; d < untilMs; d += dayMs) {
    const key = iso(d).slice(0, 10);
    const dayEnd = d + dayMs;
    const dayTasks = tasks.filter((t) => {
      const ms = parseMs(t.task.mergedAt);
      return ms !== null && ms >= d && ms < dayEnd;
    });
    buckets.push(aggregateBucket(dayTasks, key, key));
  }
  return buckets;
}

function aggregateRolling7d(tasks: TaskReliability[], sinceIso: string, untilIso: string): ReliabilityBucket {
  const untilMs = parseMs(untilIso)!;
  const windowStartMs = untilMs - 7 * 24 * 3600 * 1000;
  const windowStartIso = iso(windowStartMs);
  const windowTasks = tasks.filter((t) => {
    const ms = parseMs(t.task.mergedAt);
    return ms !== null && ms >= windowStartMs && ms <= untilMs;
  });
  const key = `${windowStartIso.slice(0, 10)}..${untilIso.slice(0, 10)}`;
  return aggregateBucket(windowTasks, key, '7d rolling');
}

function aggregateBucket(tasks: TaskReliability[], key: string, label: string): ReliabilityBucket {
  const merged = tasks.length;
  const unattended = tasks.filter((t) => t.touchCount === 0).length;
  const unattendedRate = merged > 0 ? unattended / merged : null;
  const stuckSeries = tasks
    .filter((t) => t.stuckCoverage !== 'none')
    .map((t) => t.stuckMs)
    .sort((a, b) => a - b);
  const coverage = {
    full: tasks.filter((t) => t.stuckCoverage === 'full').length,
    partial: tasks.filter((t) => t.stuckCoverage === 'partial').length,
    none: tasks.filter((t) => t.stuckCoverage === 'none').length,
  };
  return {
    key,
    label,
    merged,
    unattended,
    unattendedRate,
    stuckP50Ms: percentile(stuckSeries, 50),
    stuckP90Ms: percentile(stuckSeries, 90),
    coverage,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface RenderOptions {
  color?: boolean;
  includeTaskTable?: boolean;
}

const COLOR = {
  dim: '\u001b[2m',
  reset: '\u001b[0m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

function paint(enabled: boolean, color: keyof typeof COLOR, text: string): string {
  if (!enabled) return text;
  return `${COLOR[color]}${text}${COLOR.reset}`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms === 0) return '0m';
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes.toFixed(0)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

function fmtRate(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${(rate * 100).toFixed(1)}%`;
}

export function renderReliabilitySummary(summary: ReliabilitySummary, opts: RenderOptions = {}): string {
  const color = opts.color ?? false;
  const lines: string[] = [];
  const title = `Reliability report  ${summary.since.slice(0, 10)} → ${summary.until.slice(0, 10)}`;
  lines.push(title);
  lines.push('─'.repeat(Math.min(80, title.length)));

  const o = summary.overall;
  lines.push(`Merged tasks:                 ${o.merged}`);
  lines.push(`Unattended rate:              ${fmtRate(o.unattendedRate)} (${o.unattended}/${o.merged})`);
  lines.push(`Median time stuck:            ${fmtMs(o.stuckP50Ms)}`);
  lines.push(`P90 time stuck:               ${fmtMs(o.stuckP90Ms)}`);
  lines.push(`Coverage: full=${o.coverage.full}, partial=${o.coverage.partial}, none=${o.coverage.none}`);
  lines.push('');

  if (summary.bucket === 'rolling7d') {
    for (const b of summary.buckets) {
      lines.push(`Rolling 7-day:                ${fmtRate(b.unattendedRate)} · p50 ${fmtMs(b.stuckP50Ms)} · p90 ${fmtMs(b.stuckP90Ms)}  (${b.merged} merged)`);
    }
  } else if (summary.buckets.length > 0) {
    lines.push('Daily breakdown:');
    for (const b of summary.buckets) {
      const rate = fmtRate(b.unattendedRate);
      const parts = [
        `  ${b.key}`,
        `merged=${b.merged}`,
        `unattended=${b.unattended}`,
        `rate=${paint(color, 'green', rate)}`,
        `p50=${fmtMs(b.stuckP50Ms)}`,
        `p90=${fmtMs(b.stuckP90Ms)}`,
      ];
      lines.push(parts.join('  '));
    }
  }

  if (opts.includeTaskTable && summary.tasks.length > 0) {
    lines.push('');
    lines.push('Per-task:');
    for (const t of summary.tasks.slice().sort((a, b) => parseMs(b.task.mergedAt)! - parseMs(a.task.mergedAt)!)) {
      const id = t.task.issue ?? (t.task.prNumber ? `#${t.task.prNumber}` : t.task.title.slice(0, 32));
      lines.push(`  ${t.task.mergedAt.slice(0, 10)}  ${id.padEnd(14)} touches=${t.touchCount}  stuck=${fmtMs(t.stuckMs)}  coverage=${t.stuckCoverage}`);
    }
  }
  return lines.join('\n');
}

/**
 * Compact one-line dashboard rendering, suitable for a status bar. Returns
 * empty string when no merged tasks are in the rolling window.
 */
export function renderReliabilityDashboardLine(summary: ReliabilitySummary): string {
  const rolling = summary.bucket === 'rolling7d'
    ? summary.buckets[0]
    : null;
  const b = rolling ?? summary.overall;
  if (b.merged === 0) return '';
  return `7d unattended: ${fmtRate(b.unattendedRate)} · stuck p50 ${fmtMs(b.stuckP50Ms)} · p90 ${fmtMs(b.stuckP90Ms)} (${b.merged} merged)`;
}

// ── Top-level orchestrator ───────────────────────────────────────────────────

export interface ComputeReliabilityOptions {
  repoDir: string;
  sinceIso: string;
  untilIso: string;
  bucket: 'daily' | 'rolling7d';
  branches?: string[];
  session?: string;
  stallMinutes?: number;
}

export function computeReliability(opts: ComputeReliabilityOptions): ReliabilitySummary {
  const merged = collectMergedTasks({
    repoDir: opts.repoDir,
    sinceIso: opts.sinceIso,
    untilIso: opts.untilIso,
    branches: opts.branches,
  });

  const tasks: TaskReliability[] = merged.map((task) => {
    const touches = collectOperatorTouches({ repoDir: opts.repoDir, task });
    const stuck = computeTimeStuck({ task, session: opts.session, stallMinutes: opts.stallMinutes });
    return {
      task,
      touches,
      touchCount: touches.length,
      stuckMs: stuck.stuckMs,
      stuckCoverage: stuck.coverage,
      stallIntervals: stuck.stallIntervals,
    };
  });

  return aggregateReliability(tasks, {
    sinceIso: opts.sinceIso,
    untilIso: opts.untilIso,
    bucket: opts.bucket,
  });
}

// ── Shell helpers ────────────────────────────────────────────────────────────

function safeGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// ── Window parsing ───────────────────────────────────────────────────────────

/**
 * Parse a shorthand window like `14d`, `7d`, `30d` into since/until ISO
 * timestamps bounded by `now`.
 */
export function parseWindow(spec: string, now: Date = new Date()): { since: string; until: string } {
  const match = spec.trim().match(/^(\d+)([dhw])$/);
  if (!match) {
    throw new Error(`Unsupported window: ${spec} (expected like "14d", "7d", or "48h")`);
  }
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  const unitMs = unit === 'd' ? 86_400_000 : unit === 'w' ? 7 * 86_400_000 : 3_600_000;
  const until = now;
  const since = new Date(until.getTime() - n * unitMs);
  return { since: since.toISOString(), until: until.toISOString() };
}
