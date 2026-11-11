/**
 * HOK-3177 / HOK-3182 — unattended-rate, time-stuck and per-class operator
 * touch metrics.
 *
 * Pure functions over these evidence feeds:
 *   - operator events (`.operator-events.jsonl`, `.operator-intervention.json`)
 *   - intervention records (`.wavemill/evals/evals.jsonl`)
 *   - the repo-level operator touch log (`.wavemill/operator-touches.jsonl`,
 *     interactive `workflow-state.json` edits)
 *   - human prompts typed into the agent session (Claude session JSONL)
 *   - the GitHub PR timeline: `wm:*` label edits not made by the mill or tend
 *     (`.wavemill/label-writes.jsonl` disambiguates a shared login), commits
 *     outside every recorded agent window (manual pushes)
 *   - merges with no tend merge-lane receipt (`.wavemill/merge-lane/<pr>`)
 *   - task-progress replays (`.terminal-history.jsonl`, stage results, agent
 *     session activity) via the HOK-3101 `deriveTaskProgress` primitive
 *
 * Every touch carries a design §8f class (O/L/S/R, `classifyOperatorTouch`
 * in operator-intervention.ts). Each feed reads the live feature dir first and
 * falls back to the reap archive (`.wavemill/evals/artifacts/<issue>/`).
 *
 * Collectors never throw: a missing or malformed file is reported through a
 * per-task `coverage` field so the aggregate can be honest about its
 * denominator rather than silently excluding tasks or treating them as
 * unattended.
 *
 * Known gap: a `workflow-state.json` edit is only seen when it goes through
 * `state_mutate` in an interactive shell; a hand edit with an editor or a
 * bare `jq … > file` leaves no evidence.
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
  type TransitionInput,
} from './task-progress.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { getReliabilityConfig, loadWavemillConfig, type ResolvedWorkingHoursConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import {
  INTERVENTION_CLASSES,
  classifyOperatorTouch,
  emptyClassCounts,
  evalDetectorName,
  readOperatorTouchLog,
  type ClassifiableTouch,
  type CommitAttribution,
  type InterventionClass,
  type OperatorTouchAttribution,
  type OperatorTouchKind,
  type OperatorTouchLogEntry,
  type SessionMessageProvenance,
} from './operator-intervention.ts';
import {
  deriveAgentActivityWindows,
  detectManualEdits,
  readOperatorHandoffIntervals,
  readStageResultSync,
  detectSessionRedirects,
  type PrCommit,
} from './intervention-detector.ts';
import { locateOwnershipRows } from './session-ownership.ts';
import {
  indexMillLabelWrites,
  matchesMillLabelWrite,
  readMillLabelWrites,
  type LabelWriteIndex,
} from './label-write-ledger.ts';
import { fetchPrTimeline, type GhRunner, type PrTimelineEvent } from './pr-timeline.ts';
import { readLaneProgress, mergeLaneStateDir } from './merge-queue.ts';
import { resolveProjectsDirs } from './wavemill-session-paths.ts';
import { parseTaskId } from './task-identity.ts';
import {
  aggregateStallCauses,
  aggregateStallGates,
  deriveGateTimeline,
  deriveStallGate,
  STALL_CAUSES,
  STALL_GATES,
  STALL_STAGES,
  type GateEvidence,
  type StallCause,
  type StallGate,
  type StallGateAggregate,
  type StallGateIntervalInput,
  type StallStage,
} from './stall-cause.ts';
import { isAgentWaitingState } from './attention.ts';
import { readEscalationMarker } from './operator-escalation.ts';
import { locateHeadMoves } from './head-move-record.ts';

export type { InterventionClass } from './operator-intervention.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type TouchKind = OperatorTouchKind;

export interface TouchEvent {
  kind: TouchKind;
  at: string;
  detail?: string;
  /** Whether this is a human touch, mill automation, or an approval. */
  attribution: OperatorTouchAttribution;
  /** Design §8f class (O/L/S/R). */
  class: InterventionClass;
  /** GitHub login or local user, when the source records one. */
  actor?: string;
  /** De-dupe bucket key: `<minute-slot>|<kind>` for near-coincident records. */
  bucket: string;
}

export type MetricCoverage = 'full' | 'partial' | 'none';

export interface MergedTaskRef {
  /** Task id if recoverable (e.g. "HOK-3170" or "HOK-3170_c"), else undefined. */
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
  /** Path to the task's worktree, if known (may no longer exist). */
  worktree?: string;
  /** Reap archive (`.wavemill/evals/artifacts/<issue>/`), when present. */
  archiveDir?: string;
  /** False for spot-checked PRs that closed without merging. */
  merged?: boolean;
}

export interface TaskReliability {
  task: MergedTaskRef;
  touches: TouchEvent[];
  touchCount: number;
  /** Per-class touch counts after dedup. */
  touchClasses: Record<InterventionClass, number>;
  /** Plan approvals (not human touches). */
  approvals: number;
  /** Mill automation touches (not human touches). */
  automationCount: number;
  /** Commits that could not be attributed to agent or operator. */
  unattributedCommits: number;
  stuckMs: number;
  stuckCoverage: MetricCoverage;
  stallIntervals: StallInterval[];
  /**
   * True when the mill ran this task (a live or archived feature dir, hook
   * history or a stage launch). False for an operator PR (fix/, docs/, …),
   * which counts toward the all-PR rate but not the mill-only rate.
   */
  isMillTask: boolean;
}

export interface StallInterval {
  /** ISO start of the stalled interval. */
  from: string;
  /** ISO end of the stalled interval. */
  to: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Derived stall cause (HOK-3455). */
  cause?: StallCause;
  /** Supporting fact for the cause. */
  causeDetail?: string;
  /** The gate that held the task for most of the interval (HOK-3468). */
  gate?: StallGate;
  /** The stage that gate belongs to. */
  stage?: StallStage;
  /** How the interval's duration divides across gates. */
  gateSplit?: Array<{ gate: StallGate; stage: StallStage; ms: number; missing?: string[] }>;
  /** Records that were looked for and not found, for `unknown` portions. */
  missingEvidence?: string[];
  /** A person acted in the window around the interval's end (HOK-3468). */
  endedByPerson?: boolean;
  /** The interval's duration outside working hours (HOK-3468). */
  offHoursMs?: number;
  /** The agent's own last HOK-3101 record state when the interval opened. */
  agentLastState?: HookState | null;
}

/** One gate's totals in a bucket (HOK-3468). */
export type StallGateRow = StallGateAggregate;

/** `unknown` stuck time in a bucket, with the records that were missing. */
export interface UnknownStallEvidence {
  issue: string | null;
  from: string;
  to: string;
  hours: number;
  missing: string[];
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
  /** Touch counts per design §8f class, summed over the bucket's tasks. */
  touchClasses: Record<InterventionClass, number>;
  /** Tasks with at least one touch of each class. */
  touchedTasksByClass: Record<InterventionClass, number>;
  /** Plan approvals summed over the bucket's tasks. */
  approvals: number;
  /** Tasks with at least one approval. */
  tasksWithApprovals: number;
  /** Mill automation touches by kind. */
  automationByKind: Record<TouchKind, number>;
  /** Tasks with at least one unattributed commit. */
  tasksWithUnattributedCommits: number;
  /** Stalls over 1h by cause. */
  stallCauses: Record<StallCause, { stalls: number; hours: number }>;
  /** Stuck time split by the gate that held each task (HOK-3468), fixed order. */
  stallGates: StallGateRow[];
  /** Off-hours stuck time on intervals that ended with an operator action. */
  waitedForPerson: { hours: number; stuckHours: number; share: number | null };
  /** `unknown` portions of stalls, each naming the records that were missing. */
  unknownEvidence: UnknownStallEvidence[];
  /** Mill-run tasks only (`TaskReliability.isMillTask`); the fields above cover every merged PR. */
  millMerged: number;
  millUnattended: number;
  millUnattendedRate: number | null;
  millStuckP50Ms: number | null;
  millStuckP90Ms: number | null;
}

/** How much of the touch evidence each run could actually see. */
export interface SourceCoverage {
  /** PRs whose GitHub timeline was read (cache or network). */
  githubTimelines: number;
  /** PRs whose timeline could not be read (gh missing/offline). */
  githubUnavailable: number;
  /** False when GitHub sources were disabled for this run. */
  githubEnabled: boolean;
  /** Earliest mill label write on record; label edits before it are unattributable. */
  labelLedgerSince: string | null;
  /** Earliest tend merge-lane receipt; merges before it are not judged. */
  mergeLaneSince: string | null;
  /** Tasks whose evidence came from the reap archive (feature dir gone). */
  archivedTasks: number;
}

export interface ReliabilitySummary {
  generatedAt: string;
  /** Absolute repo the figures were computed for (HOK-3245: the dashboard labels it). */
  repoDir?: string;
  since: string;
  until: string;
  bucket: 'daily' | 'rolling7d';
  overall: ReliabilityBucket;
  buckets: ReliabilityBucket[];
  tasks: TaskReliability[];
  sources?: SourceCoverage;
  /** Spot-checked PRs (`--pr`), computed whether or not they merged. */
  spotChecks?: TaskReliability[];
  /** Median native prompt-cache hit rate per (model, provider route) (HOK-3260). */
  promptCache?: PromptCacheRouteMedian[];
}

/** One (model, provider route) row of the prompt-cache section (HOK-3260). */
export interface PromptCacheRouteMedian {
  model: string;
  providerRoute: string;
  /** Median of per-run `cacheHitRate` (turns 2..n) across native stage results. */
  medianHitRate: number;
  /** Stage results that contributed a hit rate. */
  samples: number;
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
/** Head branch in a classic merge subject: `Merge pull request #N from owner/<branch>`. */
const MERGE_PR_BRANCH_RE = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/;
// allow-task-identity: detect-only heuristic over a git commit subject — the bounded 2–6 team-key length and capture group are intentional for merge-subject scanning, not task-ID parsing.
const ISSUE_IN_SUBJECT_RE = /\b([A-Z]{2,6}-\d+(?:_c)?)\b/;

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

/** A touch as a source emits it; `attribution`, `class` and `bucket` are filled on dedupe. */
export type RawTouch = Omit<TouchEvent, 'attribution' | 'class' | 'bucket'> & {
  attribution?: OperatorTouchAttribution;
  class?: InterventionClass;
  bucket?: string;
};

const ATTRIBUTION_PRECEDENCE: Record<OperatorTouchAttribution, number> = {
  human: 2,
  approval: 1,
  automation: 0,
};

/**
 * De-duplicate touches by `(kind, 60s minute bucket)`. If the bucket sees
 * multiple raw touches, keep the one with the highest attribution precedence
 * (human > approval > automation); otherwise keep earliest. Every surviving
 * touch carries an attribution and class from `classifyOperatorTouch`, so
 * persisted rows without them classify on read.
 */
export function dedupeTouches(touches: RawTouch[]): TouchEvent[] {
  const candidates = new Map<string, RawTouch[]>();
  for (const t of touches.slice().sort((a, b) => parseMs(a.at)! - parseMs(b.at)!)) {
    const key = dedupBucketKey(t.at, t.kind);
    const list = candidates.get(key) ?? [];
    list.push(t);
    candidates.set(key, list);
  }

  const result: TouchEvent[] = [];
  for (const [key, list] of candidates) {
    let chosen = list[0];
    for (const t of list) {
      const a = t.attribution ?? classifyOperatorTouch(t).attribution;
      const b = chosen.attribution ?? classifyOperatorTouch(chosen).attribution;
      if (ATTRIBUTION_PRECEDENCE[a] > ATTRIBUTION_PRECEDENCE[b]) {
        chosen = t;
      }
    }
    const classified = chosen.class !== undefined && chosen.attribution !== undefined
      ? (chosen as TouchEvent)
      : { ...chosen, ...classifyOperatorTouch(chosen) };
    result.push({ ...classified, bucket: key } as TouchEvent);
  }
  return result.sort((a, b) => parseMs(a.at)! - parseMs(b.at)!);
}

/** Per-class counts over already-deduped touches. */
export function countTouchClasses(touches: TouchEvent[]): Record<InterventionClass, number> {
  const counts = emptyClassCounts();
  for (const t of touches) counts[t.class] += 1;
  return counts;
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

/** Default replay sampling interval for `replayStallIntervals`. */
export const STALL_REPLAY_TICK_MS = 5 * 60_000;

/** One piece of progress evidence on a task's timeline. */
export interface ProgressEvidence {
  atMs: number;
  kind: 'hook' | 'commit' | 'transition';
  /** Hook payload (state/event/writer/agent) for `kind=hook`. */
  hook?: HookArchivePayload;
  detail?: string;
}

/**
 * Replay a task's progress evidence through the HOK-3101 primitive on a fixed
 * tick and return the stalled intervals.
 *
 * Snapshots are taken every `tickMs` from the first evidence to `endMs` (the
 * merge). At each tick the primitive sees what a live observer would have
 * seen: the newest hook (an agent's own record survives later monitor writes,
 * invariant 3), the newest commit and the newest stage transition. At
 * `endMs` the task is terminal, which closes any open interval. A stall is
 * counted from the first tick where no progress was seen for more than
 * `stallMinutes` — the time past the threshold, not since the last progress.
 */
export function replayStallIntervals(
  evidence: ProgressEvidence[],
  opts: { endMs: number; stallMinutes?: number; tickMs?: number },
): StallInterval[] {
  const sorted = evidence.filter((e) => Number.isFinite(e.atMs) && e.atMs <= opts.endMs)
    .sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) return [];
  const tickMs = opts.tickMs ?? STALL_REPLAY_TICK_MS;
  const ticks = new Set<number>(sorted.map((e) => e.atMs));
  for (let t = sorted[0].atMs; t < opts.endMs; t += tickMs) ticks.add(t);
  ticks.add(opts.endMs);

  let i = 0;
  let lastTop: HookArchivePayload | null = null;
  let lastAgent: HookArchivePayload | null = null;
  let lastAgentWorkMs: number | null = null;
  let lastCommitMs: number | null = null;
  let lastTransition: ProgressEvidence | null = null;
  // HOK-3422: the earliest stage-started transition is a controller-authored
  // "the stage was launched" fact — a legitimate stall-clock anchor even
  // though it is never a progress source. Replays of historical tasks whose
  // archives carry only stage results (no transcripts) rely on it.
  let firstLaunchMs: number | null = null;
  const frames: SnapshotFrame[] = [];
  for (const t of [...ticks].sort((a, b) => a - b)) {
    while (i < sorted.length && sorted[i].atMs <= t) {
      const e = sorted[i++];
      if (e.kind === 'hook' && e.hook) {
        lastTop = e.hook;
        if (hookWriter(e.hook) === 'agent') {
          lastAgent = e.hook;
          if (e.hook.state && e.hook.state !== 'idle') lastAgentWorkMs = e.atMs;
        }
      } else if (e.kind === 'commit') {
        lastCommitMs = e.atMs;
      } else if (e.kind === 'transition') {
        lastTransition = e;
        if (firstLaunchMs === null && typeof e.detail === 'string' && e.detail.endsWith(':started')) {
          firstLaunchMs = e.atMs;
        }
      }
    }
    const terminal = t >= opts.endMs;
    // HOK-3422: controller-authored transitions feed only `lastTransitionAt`,
    // not progress. Carry them through as `transitionInputs` so the derived
    // snapshot still exposes the controller's last move, but the stall math
    // is agent-only.
    const transitionInputs: TransitionInput[] = [];
    if (lastTransition) {
      transitionInputs.push({ at: iso(lastTransition.atMs), ...(lastTransition.detail ? { detail: lastTransition.detail } : {}) });
    }
    // The agent's last real work stays the progress anchor after it idles: a
    // live observer reads it from the history archive, not the idle record.
    // HOK-3422: this is agent-written evidence, so synthesize it as an agent
    // hook record on `lastAgent` (invariant 2 preserved) — not as a
    // `transition`, which would be a controller write.
    let agentWorkHook: HookArchivePayload | null = lastAgent;
    if (lastAgentWorkMs !== null) {
      agentWorkHook = {
        state: 'working' as HookState,
        event: 'ReplayAgentWork',
        writer: 'agent',
        agent: lastAgent?.agent ?? 'replay',
        timestamp: Math.floor(lastAgentWorkMs / 1000),
      };
    }
    frames.push({
      atMs: t,
      inputs: {
        ...emptyProgressInputs(),
        hookFile: lastTop ? synthesizeHookFile(lastTop, agentWorkHook) : null,
        latestCommitAt: lastCommitMs !== null ? iso(lastCommitMs) : null,
        launchAt: firstLaunchMs !== null ? iso(firstLaunchMs) : null,
        transitionInputs,
        terminal: terminal
          ? { prState: 'MERGED', prNumber: null, lifecycleOutcome: null, at: iso(opts.endMs) }
          : { prState: null, prNumber: null, lifecycleOutcome: null, at: null },
      },
    });
  }
  return deriveStallIntervals(frames, { stallMinutes: opts.stallMinutes });
}

// ── IO: shared evidence context ──────────────────────────────────────────────

/** Durable merge receipt written on pane release (`terminal-record.json`). */
interface TerminalRecordRef {
  issue: string;
  prNumber?: string;
  branch?: string;
  slug?: string;
  worktree?: string;
  archiveDir: string;
}

interface EvalRecordRow {
  issueId?: string;
  prUrl?: string;
  timestamp?: string;
  interventionCount?: number;
  interventions?: Array<{ timestamp?: string; type?: string; note?: string }>;
}

/** `evals.jsonl` rows indexed by task id and PR number (read once per report). */
export interface EvalsIndex {
  byIssue: Map<string, EvalRecordRow[]>;
  byPr: Map<string, EvalRecordRow[]>;
}

/**
 * Repo-wide evidence read once per report run and shared by every task: the
 * evals index, the archive index, the operator touch log, the mill
 * label-write ledger and the GitHub timeline reader. Every field is optional
 * so unit tests can inject only what they exercise.
 */
export interface ReliabilityContext {
  repoDir: string;
  evals?: EvalsIndex;
  /** `terminal-record.json` receipts keyed by PR number. */
  archiveByPr?: Map<string, TerminalRecordRef>;
  touchLog?: OperatorTouchLogEntry[];
  labelWrites?: LabelWriteIndex;
  /** Earliest tend merge-lane receipt; merges before it are not judged. */
  mergeLaneSinceMs?: number | null;
  /** GitHub timeline access; `enabled: false` skips label/push sources. */
  github?: { enabled: boolean; gh?: GhRunner; nwo?: string; cacheDir?: string | null };
  /** Logins used only by the mill/tend (dedicated bot accounts). */
  millActorLogins?: Set<string>;
  /** Claude projects root override (tests). */
  claudeProjectsDirs?: (worktree: string) => string[];
  /** Mutable per-run counters surfaced as `SourceCoverage`. */
  stats?: { githubTimelines: number; githubUnavailable: number };
}

function archiveRoot(repoDir: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, 'artifacts');
}

/** Index `evals.jsonl` by task id and PR number. */
export function buildEvalsIndex(evalsPath: string): EvalsIndex {
  const index: EvalsIndex = { byIssue: new Map(), byPr: new Map() };
  if (!existsSync(evalsPath)) return index;
  try {
    for (const row of readJsonlFile<EvalRecordRow>(evalsPath)) {
      const hasEvidence = (row.interventionCount ?? 0) > 0 || (row.interventions?.length ?? 0) > 0;
      if (!hasEvidence) continue;
      if (row.issueId) pushTo(index.byIssue, row.issueId, row);
      const pr = row.prUrl?.match(/\/pull\/(\d+)/)?.[1];
      if (pr) pushTo(index.byPr, pr, row);
    }
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to read ${evalsPath}: ${errorMessage(err)}`);
  }
  return index;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Index every archived `terminal-record.json` by PR number. */
export function buildArchiveIndex(repoDir: string): Map<string, TerminalRecordRef> {
  const root = archiveRoot(repoDir);
  const byPr = new Map<string, TerminalRecordRef>();
  if (!existsSync(root)) return byPr;
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return byPr; }
  for (const entry of entries) {
    const recordPath = join(root, entry, 'terminal-record.json');
    if (!existsSync(recordPath)) continue;
    try {
      const rec = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record<string, unknown>;
      const pr = rec.prNumber !== undefined && rec.prNumber !== null ? String(rec.prNumber) : undefined;
      if (!pr) continue;
      byPr.set(pr, {
        issue: typeof rec.issue === 'string' ? rec.issue : entry,
        prNumber: pr,
        branch: typeof rec.branch === 'string' ? rec.branch : undefined,
        slug: typeof rec.slug === 'string' ? rec.slug : undefined,
        worktree: typeof rec.worktree === 'string' ? rec.worktree : undefined,
        archiveDir: join(root, entry),
      });
    } catch {
      continue;
    }
  }
  return byPr;
}

/** Earliest `enteredLaneAt` across tend merge-lane receipts. */
function earliestMergeLaneMs(repoDir: string): number | null {
  const root = join(resolve(repoDir), '.wavemill', 'merge-lane');
  if (!existsSync(root)) return null;
  let earliest: number | null = null;
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return null; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const ms = parseMs(readLaneProgress(entry, repoDir)?.enteredLaneAt);
    if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
  }
  return earliest;
}

export interface BuildContextOptions {
  repoDir: string;
  evalsPath?: string;
  github?: boolean;
  gh?: GhRunner;
  /**
   * PR timeline cache directory: omitted = `.wavemill/cache/pr-timeline/`,
   * `null` = no cache (read-only run), string = that directory.
   */
  cacheDir?: string | null;
}

/** Read every repo-wide evidence feed once. */
export function buildReliabilityContext(opts: BuildContextOptions): ReliabilityContext {
  const config = getReliabilityConfig(opts.repoDir);
  return {
    repoDir: opts.repoDir,
    evals: buildEvalsIndex(opts.evalsPath ?? defaultEvalsPath(opts.repoDir)),
    archiveByPr: buildArchiveIndex(opts.repoDir),
    touchLog: readOperatorTouchLog(opts.repoDir),
    labelWrites: indexMillLabelWrites(readMillLabelWrites(opts.repoDir)),
    mergeLaneSinceMs: earliestMergeLaneMs(opts.repoDir),
    github: {
      enabled: opts.github ?? config.github,
      ...(opts.gh ? { gh: opts.gh } : {}),
      ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
    },
    millActorLogins: new Set(config.millActorLogins),
    stats: { githubTimelines: 0, githubUnavailable: 0 },
  };
}

// ── IO: merged tasks ─────────────────────────────────────────────────────────

export interface CollectMergedOptions {
  repoDir: string;
  sinceIso: string;
  untilIso: string;
  /** Branches to scan with `git log --merges`. */
  branches?: string[];
  /** Archive index (built from the repo when omitted). */
  archiveByPr?: Map<string, TerminalRecordRef>;
}

/**
 * Collect merged tasks over the window by scanning `git log --merges` on the
 * configured branches. Reaped tasks are **gone** from workflow-state.json, so
 * git is the authoritative merge-event source — the metric is honest about
 * its denominator even when state has been cleaned up.
 *
 * Classic merge subjects carry no issue id (`Merge pull request #N from
 * owner/task/<slug>`), so the task is recovered from the PR's archived
 * `terminal-record.json` when the subject does not name it.
 */
export function collectMergedTasks(opts: CollectMergedOptions): MergedTaskRef[] {
  const branches = opts.branches && opts.branches.length > 0 ? opts.branches : ['main', 'auto/integration'];
  const archiveByPr = opts.archiveByPr ?? buildArchiveIndex(opts.repoDir);
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

      const key = `pr:${prNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(resolveTaskRef(opts.repoDir, {
        prNumber,
        title: subject,
        mergedAt: committedIso,
        branch: subject.match(MERGE_PR_BRANCH_RE)?.[1],
      }, archiveByPr));
    }
  }
  return results;
}

/**
 * Fill in issue, branch, worktree, feature dir and reap archive for a task
 * known by PR number + subject.
 */
export function resolveTaskRef(
  repoDir: string,
  base: { prNumber?: string; title: string; mergedAt: string; branch?: string; merged?: boolean },
  archiveByPr: Map<string, TerminalRecordRef>,
): MergedTaskRef {
  const record = base.prNumber ? archiveByPr.get(base.prNumber) : undefined;
  const subjectIssue = base.title.match(ISSUE_IN_SUBJECT_RE)?.[1];
  const issue = record?.issue ?? (parseTaskId(subjectIssue)?.taskId ?? subjectIssue);
  const branch = base.branch ?? record?.branch;
  const paths = resolveTaskPathsForMerged(repoDir, issue, branch);
  const archiveDir = record?.archiveDir ?? resolveArchiveDir(repoDir, issue);
  const worktree = paths.worktree ?? record?.worktree;
  return {
    ...base,
    ...(issue ? { issue } : {}),
    ...(branch ? { branch } : {}),
    ...paths,
    ...(worktree ? { worktree } : {}),
    ...(archiveDir ? { archiveDir } : {}),
  };
}

function resolveArchiveDir(repoDir: string, issue: string | undefined): string | undefined {
  if (!issue) return undefined;
  const dir = join(archiveRoot(repoDir), issue);
  return existsSync(dir) ? dir : undefined;
}

function resolveTaskPathsForMerged(
  repoDir: string,
  issue: string | undefined,
  branch: string | undefined,
): { featureDir?: string; worktree?: string; slug?: string } {
  const branchSlug = branch?.match(/^(?:task|feature|bugfix|bug)\/(.+)$/)?.[1];
  if (!issue && !branchSlug) return {};
  const config = loadWavemillConfig(repoDir);
  const configuredRoot = config.mill?.worktreeRoot;
  const worktreeRoots = [configuredRoot, 'worktrees'].filter((v): v is string => Boolean(v));
  const matches = (entry: string): boolean => {
    const lower = entry.toLowerCase();
    if (branchSlug && lower === branchSlug.toLowerCase()) return true;
    return Boolean(issue && lower.startsWith(issue.toLowerCase()));
  };

  for (const root of worktreeRoots) {
    const absRoot = resolve(repoDir, root);
    if (!existsSync(absRoot)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(absRoot); } catch { entries = []; }
    for (const entry of entries) {
      // The worktree slug is the branch's `task/<slug>`, or legacy
      // `<issue-lowercase>-<description>`.
      if (!matches(entry)) continue;
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
      if (!matches(entry)) continue;
      return { featureDir: join(base, entry), slug: entry };
    }
  }
  return branchSlug ? { slug: branchSlug } : {};
}

/**
 * Locate one task evidence file: the live feature dir first, then the reap
 * archive. HOK-2891: both carry the same dotted basename, so there is no
 * dual-name reader.
 */
export function resolveTaskSource(task: MergedTaskRef, name: string): string | undefined {
  const dotted = `.${name}`;
  if (task.featureDir) {
    const live = join(task.featureDir, dotted);
    if (existsSync(live)) return live;
  }
  if (task.archiveDir) {
    const archived = join(task.archiveDir, dotted);
    if (existsSync(archived)) return archived;
  }
  return undefined;
}

// ── IO: native prompt-cache hit rate (HOK-3260) ──────────────────────────────

const PROMPT_CACHE_STAGES = ['planning', 'coding', 'review'] as const;

interface StageResultUsageView {
  model?: string;
  executedModel?: string | null;
  artifacts?: { usage?: { cacheHitRate?: unknown; providerRoute?: unknown } };
}

/**
 * Median prompt-cache hit rate per (model, provider route) over the native
 * planning / coding / review stage results of `tasks`. Stage results without a
 * numeric `artifacts.usage.cacheHitRate` (legacy, non-native, or runs of fewer
 * than two turns) are skipped. Rows are sorted by model, then route.
 */
export function collectPromptCacheHitRates(tasks: MergedTaskRef[]): PromptCacheRouteMedian[] {
  const rates = new Map<string, { model: string; providerRoute: string; values: number[] }>();
  for (const task of tasks) {
    for (const stage of PROMPT_CACHE_STAGES) {
      const path = resolveTaskSource(task, `${stage}-result.json`);
      if (!path) continue;
      let result: StageResultUsageView;
      try {
        result = JSON.parse(readFileSync(path, 'utf-8')) as StageResultUsageView;
      } catch {
        continue;
      }
      const usage = result?.artifacts?.usage;
      const rate = usage?.cacheHitRate;
      if (typeof rate !== 'number' || !Number.isFinite(rate)) continue;
      const model = (result.executedModel || result.model || 'unknown').trim() || 'unknown';
      const providerRoute = typeof usage.providerRoute === 'string' && usage.providerRoute
        ? usage.providerRoute
        : 'unknown';
      const key = `${model}\u0000${providerRoute}`;
      const entry = rates.get(key) ?? { model, providerRoute, values: [] };
      entry.values.push(rate);
      rates.set(key, entry);
    }
  }
  return [...rates.values()]
    .map(({ model, providerRoute, values }) => ({
      model,
      providerRoute,
      medianHitRate: percentile(values.slice().sort((a, b) => a - b), 50)!,
      samples: values.length,
    }))
    .sort((a, b) => a.model.localeCompare(b.model) || a.providerRoute.localeCompare(b.providerRoute));
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
  operator?: string;
}



export interface CollectTouchesOptions {
  repoDir: string;
  task: MergedTaskRef;
  evalsPath?: string;
  /** Shared repo-wide evidence; built on demand (without GitHub) when omitted. */
  context?: ReliabilityContext;
  /** Pre-fetched PR timeline; when omitted it is fetched (if GitHub is enabled). */
  timeline?: PrTimelineEvent[] | null;
}

/**
 * Collect operator touches for one task from every source, classify each
 * one (O/L/S/R) and de-dupe by a 60-second kind-bucket so the same touch seen
 * through two feeds of one kind counts once.
 */
export function collectOperatorTouches(opts: CollectTouchesOptions): TouchEvent[] {
  const { task } = opts;
  const ctx: ReliabilityContext = opts.context ?? {
    repoDir: opts.repoDir,
    evals: buildEvalsIndex(opts.evalsPath ?? defaultEvalsPath(opts.repoDir)),
    touchLog: readOperatorTouchLog(opts.repoDir),
    github: { enabled: false },
  };
  const raw: RawTouch[] = [];

  // HOK-3468: transcripts carry the provenance flags the eval copies lack, so
  // when they were readable they are the source of truth for session redirects
  // and the eval copies of the same messages are dropped. Eval rows remain the
  // fallback once the transcripts are gone (reaped archives).
  const sessionRedirects = readSessionRedirectTouches(task, ctx);

  raw.push(...readOperatorEvents(resolveTaskSource(task, 'operator-events.jsonl')));
  raw.push(...readOperatorInterventionArtifacts(resolveTaskSource(task, 'operator-intervention.json')));
  raw.push(...readOperatorHandoffTouches(task, ctx));
  raw.push(...readPaneMessageTouches(resolveTaskSource(task, 'terminal-history.jsonl')));
  raw.push(...readEvalInterventions(ctx.evals, task, { dropSessionRedirects: sessionRedirects.transcriptsRead }));
  raw.push(...readTouchLog(ctx.touchLog, task));
  raw.push(...sessionRedirects.touches);

  const timeline = opts.timeline !== undefined ? opts.timeline : readTaskTimeline(task, ctx);
  if (timeline) {
    raw.push(...readLabelEditTouches(task, timeline, ctx));
    raw.push(...readManualPushTouches(task, timeline, ctx));
  }
  raw.push(...readExternalMergeTouches(task, timeline, ctx));

  return dedupeTouches(raw);
}

function readOperatorEvents(path: string | undefined): RawTouch[] {
  if (!path) return [];
  const touches: RawTouch[] = [];
  try {
    for (const entry of readJsonlFile<OperatorEventRecord>(path)) {
      if (!entry.at) continue;
      touches.push({
        kind: 'operator-event',
        at: entry.at,
        detail: `${entry.command ?? 'operator'}${entry.detail ? `: ${entry.detail}` : ''}`,
      });
    }
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to read ${path}: ${errorMessage(err)}`);
  }
  return touches;
}

function readOperatorInterventionArtifacts(path: string | undefined): RawTouch[] {
  if (!path) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to parse ${path}: ${errorMessage(err)}`);
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const touches: RawTouch[] = [];
  for (const v of values) {
    const rec = v as OperatorInterventionRecordRaw | null;
    if (!rec || !rec.occurredAt) continue;
    touches.push({
      kind: 'operator-intervention',
      at: rec.occurredAt,
      detail: rec.trigger ?? rec.summary,
      ...(rec.operator ? { actor: rec.operator } : {}),
    });
  }
  return touches;
}

/**
 * Resolved dirty-tree handoffs (`.coding-uncommitted-output.resolved.jsonl`):
 * the coding agent exited with uncommitted output, the arm parked, and it
 * was recovered. The eval pipeline treats the interval as an operator
 * handoff; the touch is counted once, at resolution.
 */
function readOperatorHandoffTouches(task: MergedTaskRef, ctx: ReliabilityContext): RawTouch[] {
  const dirs = {
    featureDirs: task.featureDir && existsSync(task.featureDir) ? [task.featureDir] : [],
    ...(task.archiveDir ? { archiveDir: task.archiveDir } : {}),
  };
  const now = Date.now();
  const ownership = locateOwnershipRows({ repoDir: ctx.repoDir, issueId: task.issue, slug: task.slug, worktreePath: task.worktree });
  return readOperatorHandoffIntervals(dirs)
    .filter((interval) => interval.resolvedAt < now - 1000)
    .map((interval) => {
      const selfRecovered = ownership.rows.some((row) => {
        const launched = Date.parse(row.launchedAt);
        return launched >= interval.detectedAt && launched <= interval.resolvedAt;
      });
      return {
        kind: 'operator-intervention' as const,
        at: iso(interval.resolvedAt),
        detail: 'dirty-tree handoff recovery',
        selfRecovered,
      };
    });
}

/**
 * Pane-message touches: hook archives whose record carries `writer=user`.
 * Current adapters never emit `user` directly, but the primitive classifies
 * missing-writer legacy entries sensibly, so this stays conservative and only
 * promotes an *explicit* `writer=user` to a touch. Typed prompts are counted
 * from the agent session instead (`readSessionRedirectTouches`).
 */
function readPaneMessageTouches(path: string | undefined): RawTouch[] {
  if (!path) return [];
  const touches: RawTouch[] = [];
  try {
    for (const entry of readJsonlFile<HookArchiveEntry>(path)) {
      if (entry.payload?.writer !== 'user') continue;
      const ts = entry.payload?.timestamp;
      const at = typeof ts === 'number' && Number.isFinite(ts)
        ? iso(ts * 1000)
        : (entry.archivedAt ?? new Date().toISOString());
      touches.push({ kind: 'pane-message', at, detail: entry.payload?.event });
    }
  } catch (err) {
    console.warn(`[reliability-metrics] Failed to read ${path}: ${errorMessage(err)}`);
  }
  return touches;
}

/** Eval rows for a task, matched by task id, Linear id or PR number. */
function evalRowsForTask(evals: EvalsIndex | undefined, task: MergedTaskRef): EvalRecordRow[] {
  if (!evals) return [];
  const rows = new Set<EvalRecordRow>();
  if (task.issue) {
    for (const row of evals.byIssue.get(task.issue) ?? []) rows.add(row);
  }
  if (task.prNumber) {
    for (const row of evals.byPr.get(task.prNumber) ?? []) rows.add(row);
  }
  return [...rows];
}

function readEvalInterventions(
  evals: EvalsIndex | undefined,
  task: MergedTaskRef,
  opts: { dropSessionRedirects?: boolean } = {},
): RawTouch[] {
  const touches: RawTouch[] = [];
  for (const row of evalRowsForTask(evals, task)) {
    // Prefer per-event timestamps when available
    const events = Array.isArray(row.interventions) ? row.interventions : [];
    if (events.length > 0) {
      for (const ev of events) {
        const at = ev.timestamp || row.timestamp;
        if (!at) continue;
        // Notes are `[detector] detail`; legacy rows carry only `type`.
        const detail = ev.note ? ev.note.slice(0, 200) : ev.type;
        const detector = evalDetectorName(detail);
        // Map eval detectors to the same kinds as their native sources so they
        // dedupe correctly. Session-redirect eval rows dedupe with transcript
        // redirects; operator_recovery dedupes with operator-intervention artifacts.
        let kind: TouchKind;
        if (detector === 'session_redirect') {
          // HOK-3468: the transcript source is better informed; when it was
          // readable these rows are stale copies and must not outvote it.
          if (opts.dropSessionRedirects) continue;
          kind = 'session-redirect';
        } else if (detector === 'operator_recovery') kind = 'operator-intervention';
        else if (detector === 'manual_edit') kind = 'manual-push';
        else kind = 'eval-intervention';
        const raw = (ev.note ?? '').replace(/^\[[a-z_]+\]\s*/, '');
        touches.push({ kind, at, detail, ...(kind === 'session-redirect' ? { text: raw } : {}) });
      }
    } else if ((row.interventionCount ?? 0) > 0 && row.timestamp) {
      // Fall back to the row's `timestamp` with count=N as a single touch each
      for (let i = 0; i < row.interventionCount!; i++) {
        touches.push({ kind: 'eval-intervention', at: row.timestamp });
      }
    }
  }
  return touches;
}

/** Entries of the repo-level touch log recorded against this task. */
function readTouchLog(log: OperatorTouchLogEntry[] | undefined, task: MergedTaskRef): RawTouch[] {
  if (!log || !task.issue) return [];
  return log
    .filter((e) => e.issue === task.issue)
    .map((e) => ({
      kind: e.kind,
      at: e.at,
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.class ? { class: e.class } : {}),
      ...(e.actor ? { actor: e.actor } : {}),
    }));
}

/**
 * Human prompts typed into the agent's Claude session after the launch
 * prompt (tmux send-keys from outside the mill). Reuses the eval pipeline's
 * `detectSessionRedirects`, which already drops the mill's own injections.
 */
function sessionKindForWindow(windows: import('./session-ownership.ts').OwnedSessionWindow[], sessionId: string): string | undefined {
  return windows.find((w) => w.sessionRef === sessionId)?.kind;
}

function readSessionRedirectTouches(
  task: MergedTaskRef,
  ctx: ReliabilityContext,
): { touches: RawTouch[]; transcriptsRead: boolean } {
  if (!task.worktree || !task.branch) return { touches: [], transcriptsRead: false };
  const result = detectSessionRedirects(task.worktree, task.branch, task.issue, ctx.repoDir);
  const touches = result.messages.map((msg) => ({
    kind: 'session-redirect' as const,
    at: msg.timestamp ?? task.mergedAt,
    detail: msg.content.slice(0, 100),
    text: msg.content,
    provenance: msg.provenance,
    sessionKind: sessionKindForWindow(result.ownedWindows, msg.sessionId),
    firstInSession: msg.firstInSession === true,
  }));
  return { touches, transcriptsRead: result.transcriptsRead };
}

function readTaskTimeline(task: MergedTaskRef, ctx: ReliabilityContext): PrTimelineEvent[] | null {
  if (!task.prNumber || !ctx.github?.enabled) return null;
  const timeline = fetchPrTimeline(task.prNumber, {
    repoDir: ctx.repoDir,
    ...(ctx.github.nwo ? { nwo: ctx.github.nwo } : {}),
    ...(ctx.github.gh ? { gh: ctx.github.gh } : {}),
    ...(ctx.github.cacheDir !== undefined ? { cacheDir: ctx.github.cacheDir } : {}),
  });
  if (ctx.stats) {
    if (timeline) ctx.stats.githubTimelines += 1;
    else ctx.stats.githubUnavailable += 1;
  }
  return timeline;
}

/** Bot accounts and dedicated mill logins never count as operators. */
function isMillActor(actor: string | null | undefined, ctx: ReliabilityContext): boolean {
  if (!actor) return false;
  return actor.endsWith('[bot]') || Boolean(ctx.millActorLogins?.has(actor));
}

/**
 * `wm:*` label edits on the PR timeline that the mill or tend did not make.
 *
 * The mill usually acts under the operator's own login, so the actor alone
 * cannot decide. A label event is the mill's when its actor is a bot or a
 * configured mill login, or when the mill label-write ledger recorded the
 * same write within two minutes. Events from before the ledger's first entry
 * cannot be attributed under a shared login and are not counted (reported as
 * `labelLedgerSince`).
 */
export function readLabelEditTouches(
  task: MergedTaskRef,
  timeline: PrTimelineEvent[],
  ctx: ReliabilityContext,
): RawTouch[] {
  if (!task.prNumber) return [];
  const prNumber = Number(task.prNumber);
  const ledger = ctx.labelWrites ?? { startMs: null, byPr: new Map() };
  const touches: RawTouch[] = [];
  for (const e of timeline) {
    if (e.event !== 'labeled' && e.event !== 'unlabeled') continue;
    if (!e.label?.startsWith('wm:')) continue;
    if (isMillActor(e.actor, ctx)) continue;
    const ms = parseMs(e.at);
    if (ms === null) continue;
    const dedicatedHuman = Boolean(ctx.millActorLogins && ctx.millActorLogins.size > 0);
    if (!dedicatedHuman) {
      // Shared login: only the ledger can tell the mill from a human.
      if (ledger.startMs === null || ms < ledger.startMs) continue;
      if (matchesMillLabelWrite(ledger, { prNumber, label: e.label, action: e.event, at: e.at })) continue;
    }
    touches.push({
      kind: 'label-edit',
      at: e.at,
      detail: `${e.event}:${e.label}`,
      ...(e.actor ? { actor: e.actor } : {}),
    });
  }
  return touches;
}

/**
 * Commits on the PR that fall outside every recorded agent activity window
 * (manual pushes) or inside an operator-handoff interval. Reuses the eval
 * pipeline's commit attribution, fed with the timeline's commits so no
 * second GitHub call is made.
 */
function commitAttributionFromDetail(detail: string): CommitAttribution {
  if (detail.includes('operator handoff commit')) return 'operator_handoff';
  if (detail.includes('outside all recorded agent activity windows')) return 'operator_out_of_window';
  if (detail.includes('no stage-result attribution data available')) return 'unattributed';
  return 'unknown';
}

export function readManualPushTouches(
  task: MergedTaskRef,
  timeline: PrTimelineEvent[],
  ctx: ReliabilityContext,
): RawTouch[] {
  if (!task.prNumber) return [];
  const prCommits: PrCommit[] = timeline
    .filter((e) => e.event === 'committed' && e.sha)
    .map((e) => ({ sha: e.sha!, message: e.message ?? '', author: e.author ?? '', date: e.at }));
  if (prCommits.length === 0) return [];
  const { manualEdit, unknownAttribution } = detectManualEdits({
    prNumber: task.prNumber,
    prCommits,
    branchName: task.branch,
    repoDir: ctx.repoDir,
    worktreePath: task.worktree,
    issueId: task.issue,
    attributeByWindows: true,
  });
  const raw: RawTouch[] = manualEdit.details.map((detail, i) => ({
    kind: 'manual-push' as const,
    at: manualEdit.timestamps?.[i] ?? task.mergedAt,
    detail: detail.slice(0, 200),
    commitAttribution: commitAttributionFromDetail(detail),
  }));
  for (let i = 0; i < unknownAttribution.details.length; i++) {
    raw.push({
      kind: 'manual-push' as const,
      at: unknownAttribution.timestamps?.[i] ?? task.mergedAt,
      detail: unknownAttribution.details[i].slice(0, 200),
      commitAttribution: 'unattributed',
    });
  }
  return raw;
}

/**
 * A merged PR with no tend merge-lane receipt was merged outside tend.
 *
 * Tend stamps `.wavemill/merge-lane/<pr>/progress.json` with
 * `lastEvent: "merged"` when it merges; GitHub's merge actor is the shared
 * login either way, so it cannot decide. Merges from before the first lane
 * receipt on record are not judged (tend was not recording yet).
 */
export function readExternalMergeTouches(
  task: MergedTaskRef,
  timeline: PrTimelineEvent[] | null,
  ctx: ReliabilityContext,
): RawTouch[] {
  if (!task.prNumber || task.merged === false) return [];
  const mergedEvent = timeline?.find((e) => e.event === 'merged');
  const hasTendReceipt = readLaneProgress(task.prNumber, ctx.repoDir)?.lastEvent === 'merged';
  const millActor = Boolean(mergedEvent) && isMillActor(mergedEvent!.actor, ctx);
  if (hasTendReceipt || millActor) return [];
  const mergedAt = mergedEvent?.at ?? task.mergedAt;
  const mergedMs = parseMs(mergedAt);
  const sinceMs = ctx.mergeLaneSinceMs ?? null;
  if (sinceMs === null || mergedMs === null || mergedMs < sinceMs) return [];
  const laneDir = mergeLaneStateDir(task.prNumber, ctx.repoDir);
  return [{
    kind: 'external-merge',
    at: mergedAt,
    detail: existsSync(laneDir) ? 'merged outside tend (lane entered, no tend merge)' : 'merged outside tend',
    hasTendReceipt: false,
    millActor: false,
    ...(mergedEvent?.actor ? { actor: mergedEvent.actor } : {}),
  }];
}

function defaultEvalsPath(repoDir: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');
}

// ── IO: time stuck ───────────────────────────────────────────────────────────

export interface ComputeTimeStuckOptions {
  task: MergedTaskRef;
  session?: string;
  stallMinutes?: number;
  /** Shared evidence (Claude projects override, GitHub timeline). */
  context?: ReliabilityContext;
  /** Pre-fetched PR timeline: its commits count as progress. */
  timeline?: PrTimelineEvent[] | null;
}

export interface ComputeTimeStuckResult {
  stuckMs: number;
  coverage: MetricCoverage;
  stallIntervals: StallInterval[];
  /** Facts naming each stall's gate (HOK-3468); absent when there was no evidence. */
  gateEvidence?: GateEvidence;
}

/**
 * Replay a task's progress evidence through the HOK-3101 primitive
 * (`replayStallIntervals`) and sum the stalled-interval durations.
 *
 * Coverage:
 * - `full`: the hook archive (`.terminal-history.jsonl`, live or archived)
 *   has two or more records.
 * - `partial`: no usable hook archive, but the timeline was reconstructed
 *   from stage results, agent session activity, commits and tend's lane
 *   receipt — every task reaped before the archive existed.
 * - `none`: no hook history and no stage launch (no evidence, or a
 *   hand-authored PR); excluded from p50/p90.
 *
 * The replay window runs from the first stage launch to the merge.
 */
export function computeTimeStuck(opts: ComputeTimeStuckOptions): ComputeTimeStuckResult {
  const { task } = opts;
  const historyPath = resolveTaskSource(task, 'terminal-history.jsonl');
  const liveHookPath = opts.session && task.issue
    ? `/tmp/wavemill-${opts.session}-${task.issue}.hook`
    : null;
  const hookEvidence = loadHookEvidence(historyPath, liveHookPath);
  const historyRecords = hookEvidence.filter((e) => e.detail !== 'live').length;

  const evidence: ProgressEvidence[] = [...hookEvidence];
  evidence.push(...stageTransitionEvidence(task));
  evidence.push(...sessionActivityEvidence(task, opts.context));
  for (const e of opts.timeline ?? []) {
    const ms = parseMs(e.at);
    if (e.event === 'committed' && ms !== null) evidence.push({ atMs: ms, kind: 'commit' });
  }
  evidence.push(...laneProgressEvidence(task, opts.context));

  const endMs = parseMs(task.mergedAt);
  if (evidence.length === 0 || endMs === null) {
    return { stuckMs: 0, coverage: 'none', stallIntervals: [] };
  }

  // The task is live from its first stage launch. Expansion sessions and
  // queue wait before it are not "stuck" — the primitive only judges tasks
  // that hold a slot.
  const launches = evidence.filter((e) => e.kind === 'transition' && e.detail?.endsWith(':started')).map((e) => e.atMs);
  // Without a stage launch or hook history this is not a mill-run task (a
  // hand-authored PR): commit spacing is not time stuck.
  if (launches.length === 0 && historyRecords === 0) {
    return { stuckMs: 0, coverage: 'none', stallIntervals: [] };
  }
  const startMs = launches.length > 0 ? Math.min(...launches) : -Infinity;
  const live = evidence.filter((e) => e.atMs >= startMs);
  const stallIntervals = replayStallIntervals(live, { endMs, stallMinutes: opts.stallMinutes });
  const coverage: MetricCoverage = historyRecords >= 2 ? 'full' : 'partial';
  const gateEvidence = opts.context ? readGateEvidence(task, opts.context, hookEvidence) : undefined;
  return {
    stuckMs: sumStallMs(stallIntervals),
    coverage,
    stallIntervals,
    ...(gateEvidence ? { gateEvidence } : {}),
  };
}

/** Task artifact locations, live first then the reap archive (HOK-2891). */
function taskArtifactDirs(task: MergedTaskRef): Parameters<typeof readOperatorHandoffIntervals>[0] {
  return {
    featureDirs: task.featureDir && existsSync(task.featureDir) ? [task.featureDir] : [],
    ...(task.archiveDir ? { archiveDir: task.archiveDir } : {}),
  };
}

/** The task's state dir (live feature dir, else the archive) for marker reads. */
function taskStateDir(task: MergedTaskRef): string | null {
  if (task.featureDir && existsSync(task.featureDir)) return task.featureDir;
  if (task.archiveDir) return task.archiveDir;
  return null;
}

/** Local evidence (`resolveTaskSource`) name missing, for the `missing` list. */
function missingRecord(task: MergedTaskRef, name: string): string | null {
  return resolveTaskSource(task, name) ? null : `no .${name}`;
}

/**
 * Read every record the gate timeline needs (HOK-3468). Pure IO over existing
 * artifacts: it makes no liveness, retry or failure decision — the timeline in
 * `stall-cause.ts` turns these facts into gates.
 */
export function readGateEvidence(
  task: MergedTaskRef,
  ctx: ReliabilityContext,
  hookEvidence: ProgressEvidence[] = [],
): GateEvidence {
  const launchRows = locateOwnershipRows({
    repoDir: ctx.repoDir,
    issueId: task.issue,
    slug: task.slug,
    worktreePath: task.worktree,
  });
  const launches = [];
  const helperLaunches = [];
  for (const row of launchRows.rows) {
    const atMs = parseMs(row.launchedAt);
    if (atMs === null) continue;
    if (row.kind.startsWith('helper:')) {
      helperLaunches.push({ atMs });
    } else {
      launches.push({ kind: row.kind, atMs, ...(row.stage ? { stage: row.stage } : {}) });
    }
  }
  launches.sort((a, b) => a.atMs - b.atMs);

  // Stage results (planning/coding/review/ready), one file each.
  const stageResults: NonNullable<GateEvidence['stageResults']> = [];
  const resultByName = new Map<string, ReturnType<typeof readStageResultSync>>();
  const stageResultPresent = new Set<string>();
  for (const stage of ['planning', 'coding', 'review', 'ready'] as const) {
    const resultPath = resolveTaskSource(task, `${stage}-result.json`);
    if (resultPath) stageResultPresent.add(stage);
    const result = readStageResultSync(resultPath ?? '');
    resultByName.set(stage, result);
    const startedAtMs = parseMs(result?.startedAt);
    if (result == null || startedAtMs === null) continue;
    const finishedAtMs = parseMs(result.finishedAt);
    const verdict = (result.artifacts as { verdict?: unknown } | undefined)?.verdict;
    stageResults.push({
      stage,
      status: result.status,
      startedAtMs,
      finishedAtMs,
      ...(typeof verdict === 'string' ? { verdict } : {}),
    });
  }

  // Agent-own hook records (HOK-3101 invariant 2: only agent writes). This is
  // evidence, not a liveness decision — the shared `isAgentWaitingState`
  // predicate in `attention.ts` reads it.
  const agentRecords = hookEvidence
    .filter((e) => e.kind === 'hook' && e.hook && e.hook.event !== 'SessionActivity' && hookWriter(e.hook) === 'agent')
    .map((e) => ({ atMs: e.atMs, state: String(e.hook?.state ?? '') }));
  const reviewCompleteHookMs = firstHookEventMs(hookEvidence, 'review_complete');
  const readyCompleteHookMs = firstHookEventMs(hookEvidence, 'ready_complete');

  // Head moves: stage publication times.
  const headMoves = locateHeadMoves({
    repoDir: ctx.repoDir,
    issueId: task.issue,
    slug: task.slug,
    worktreePath: task.worktree,
  });
  const headMoveMs = (stage: string): number | null => {
    let best: number | null = null;
    for (const row of headMoves) {
      if (row.stage !== stage) continue;
      const ms = parseMs(row.publishedAt);
      if (ms === null) continue;
      if (best === null || ms < best) best = ms;
    }
    return best;
  };

  // Plan approval (HOK-3253 binding, else a completed planning result, else an
  // `approve` operator event).
  const planApprovalMs = readPlanApprovalMs(task, resultByName.get('planning'));

  const reviewCompleteMs = earliestFinite([
    completedFinishedMs(resultByName.get('review')),
    headMoveMs('review'),
    reviewCompleteHookMs,
  ]);
  const readyCompleteMs = earliestFinite([
    completedFinishedMs(resultByName.get('ready')),
    headMoveMs('ready'),
    readyCompleteHookMs,
  ]);
  const laneEnteredMs = task.prNumber
    ? parseMs(readLaneProgress(task.prNumber, ctx.repoDir)?.enteredLaneAt)
    : null;

  // Attention spans: resolved dirty-tree handoffs, plus a live escalation marker.
  const attentionSpans = readOperatorHandoffIntervals(taskArtifactDirs(task)).map((interval) => ({
    fromMs: interval.detectedAt,
    toMs: interval.resolvedAt,
    detail: 'dirty-tree handoff',
  }));
  const stateDir = taskStateDir(task);
  const marker = stateDir ? readEscalationMarker(stateDir) : null;
  const markerMs = parseMs(marker?.writtenAt);
  if (markerMs !== null) {
    const nextLaunch = launches.find((launch) => launch.atMs > markerMs)?.atMs;
    const endMs = parseMs(task.mergedAt) ?? Date.now();
    const toMs = Math.min(endMs, nextLaunch ?? endMs);
    if (toMs > markerMs) {
      attentionSpans.push({ fromMs: markerMs, toMs, detail: marker?.reason ?? 'operator escalation' });
    }
  }

  const missingRecords: string[] = [];
  if (launchRows.files.length === 0) missingRecords.push('no .session-ownership.jsonl');
  const absent = (name: string) => {
    const value = missingRecord(task, name);
    if (value) missingRecords.push(value);
  };
  // Reuse the stage-result lookup above rather than naming the file again, so
  // this diagnostic label cannot drift into a second private lookup site.
  if (!stageResultPresent.has('review')) missingRecords.push('no .review-result.json');
  absent('plan-packet-hash');
  absent('head-moves.jsonl');
  if (agentRecords.length === 0) missingRecords.push('no .terminal-history.jsonl');
  if (task.prNumber && laneEnteredMs === null) {
    missingRecords.push(`no tend lane receipt (.wavemill/merge-lane/${task.prNumber}/progress.json)`);
  }

  return {
    launches,
    helperLaunches,
    stageResults,
    agentRecords,
    planApprovalMs,
    reviewCompleteMs,
    readyCompleteMs,
    laneEnteredMs,
    mergedMs: parseMs(task.mergedAt),
    attentionSpans,
    missingRecords,
  };
}

function firstHookEventMs(evidence: ProgressEvidence[], event: string): number | null {
  let best: number | null = null;
  for (const e of evidence) {
    if (e.kind !== 'hook' || e.hook?.event !== event) continue;
    if (best === null || e.atMs < best) best = e.atMs;
  }
  return best;
}

function completedFinishedMs(result: ReturnType<typeof readStageResultSync>): number | null {
  if (!result || result.status !== 'completed') return null;
  return parseMs(result.finishedAt);
}

function earliestFinite(values: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const ms of values) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) continue;
    if (best === null || ms < best) best = ms;
  }
  return best;
}

/**
 * When the plan was approved (HOK-3253). Prefers the plan-packet binding's
 * `approvedAt`, then a `completed` planning result's `finishedAt` (what
 * `approve_plan` writes), then the first `approve` operator event.
 */
function readPlanApprovalMs(
  task: MergedTaskRef,
  planningResult: ReturnType<typeof readStageResultSync>,
): number | null {
  const bindingPath = resolveTaskSource(task, 'plan-packet-hash');
  if (bindingPath) {
    try {
      const binding = JSON.parse(readFileSync(bindingPath, 'utf-8')) as { approvedAt?: unknown };
      const ms = parseMs(typeof binding.approvedAt === 'string' ? binding.approvedAt : null);
      if (ms !== null) return ms;
    } catch (err) {
      console.warn(`[reliability-metrics] Failed to read ${bindingPath}: ${errorMessage(err)}`);
    }
  }
  const completed = completedFinishedMs(planningResult);
  if (completed !== null) return completed;
  const eventsPath = resolveTaskSource(task, 'operator-events.jsonl');
  if (!eventsPath) return null;
  try {
    const approved = readJsonlFile<OperatorEventRecord>(eventsPath)
      .filter((e) => (e.command ?? '').trim().toLowerCase() === 'approve')
      .map((e) => parseMs(e.at ?? null))
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b)[0];
    return approved ?? null;
  } catch {
    return null;
  }
}

/**
 * A person acted on the task in this window around a stall's end (HOK-3468).
 * An approval counts: it is a person acting, even though it is not a touch for
 * the unattended rate.
 */
export const ENDED_BY_PERSON_BEFORE_MS = 30 * 60_000;
export const ENDED_BY_PERSON_AFTER_MS = 15 * 60_000;

function personActedNear(touches: TouchEvent[], toMs: number): boolean {
  const from = toMs - ENDED_BY_PERSON_BEFORE_MS;
  const to = toMs + ENDED_BY_PERSON_AFTER_MS;
  return touches.some((touch) => {
    if (touch.attribution !== 'human' && touch.attribution !== 'approval') return false;
    const ms = parseMs(touch.at);
    return ms !== null && ms >= from && ms <= to;
  });
}

/** Working hours as configured for the report. */
export type { ResolvedWorkingHoursConfig } from './config.ts';

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? 'system';
  const existing = ZONE_FORMATTERS.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: 'h23',
    weekday: 'short',
    hour: 'numeric',
  });
  ZONE_FORMATTERS.set(key, formatter);
  return formatter;
}

const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** `{weekday, hour}` at `ms` in the configured zone. */
function localWeekdayHour(ms: number, timeZone: string | undefined): { weekday: number; hour: number } {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(ms));
  let weekday = 0;
  let hour = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = ISO_WEEKDAY[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
  }
  return { weekday, hour };
}

/** Whether `ms` falls inside the configured working hours. */
export function isWorkingMoment(ms: number, hours: ResolvedWorkingHoursConfig): boolean {
  if (hours.end <= hours.start) return false;
  const { weekday, hour } = localWeekdayHour(ms, hours.timeZone);
  return hours.days.includes(weekday) && hour >= hours.start && hour < hours.end;
}

/** Walking step for the off-hours split (aligned to the quarter hour). */
const OFF_HOURS_STEP_MS = 15 * 60_000;

/**
 * The part of `[fromMs, toMs)` outside working hours (HOK-3468). Walks the
 * interval in quarter-hour steps clipped to its ends, asking the configured
 * zone for the local weekday and hour at each step, so DST and weekends are
 * handled by the calendar rather than by fixed offsets.
 */
export function computeOffHoursMs(
  fromMs: number,
  toMs: number,
  hours: ResolvedWorkingHoursConfig,
): number {
  if (toMs <= fromMs) return 0;
  if (hours.end <= hours.start || hours.days.length === 0) return toMs - fromMs;
  let cursor = fromMs;
  let offMs = 0;
  while (cursor < toMs) {
    const aligned = Math.floor(cursor / OFF_HOURS_STEP_MS) * OFF_HOURS_STEP_MS + OFF_HOURS_STEP_MS;
    const next = Math.min(toMs, aligned > cursor ? aligned : cursor + OFF_HOURS_STEP_MS);
    if (!isWorkingMoment(cursor, hours)) offMs += next - cursor;
    cursor = next;
  }
  return offMs;
}

/** Off-hours stuck time on intervals that ended with a person acting. */
export function computeWaitedForPerson(intervals: StallInterval[]): {
  hours: number;
  stuckHours: number;
  share: number | null;
} {
  let waitedMs = 0;
  let stuckMs = 0;
  for (const interval of intervals) {
    stuckMs += interval.durationMs;
    if (interval.endedByPerson) waitedMs += interval.offHoursMs ?? 0;
  }
  return {
    hours: waitedMs / (60 * 60 * 1000),
    stuckHours: stuckMs / (60 * 60 * 1000),
    share: stuckMs > 0 ? waitedMs / stuckMs : null,
  };
}

/**
 * Attribute each stall interval to the gate that held the task (HOK-3468).
 *
 * The timeline is built once per task from `gateEvidence`; each interval is
 * then split across the gates it overlaps. `cause` is derived from the primary
 * gate through `GATE_TO_CAUSE`, so the coarse headline line and the gate table
 * cannot disagree.
 */
export function attachStallGates(
  task: MergedTaskRef,
  stuck: ComputeTimeStuckResult,
  ctx: ReliabilityContext,
  opts: { touches: TouchEvent[]; workingHours: ResolvedWorkingHoursConfig },
): StallInterval[] {
  const evidence = stuck.gateEvidence;
  const endMs = parseMs(task.mergedAt);
  if (!evidence || endMs === null) return stuck.stallIntervals;
  const spans = deriveGateTimeline(evidence, { endMs });
  const agentRecords = [...(evidence.agentRecords ?? [])].sort((a, b) => a.atMs - b.atMs);

  return stuck.stallIntervals.map((interval) => {
    const fromMs = parseMs(interval.from);
    const toMs = parseMs(interval.to);
    if (fromMs === null || toMs === null) return interval;
    const decision = deriveStallGate({ fromMs, toMs }, spans);
    const missing = [...new Set(
      decision.gateSplit.flatMap((entry) => (entry.gate === 'unknown' ? entry.missing ?? [] : [])),
    )];
    let lastState: HookState | null = null;
    for (const record of agentRecords) {
      if (record.atMs > fromMs) break;
      lastState = record.state as HookState;
    }
    return {
      ...interval,
      cause: decision.cause,
      ...(decision.causeDetail ? { causeDetail: decision.causeDetail } : {}),
      gate: decision.gate,
      stage: decision.stage,
      gateSplit: decision.gateSplit,
      ...(missing.length > 0 ? { missingEvidence: missing } : {}),
      endedByPerson: personActedNear(opts.touches, toMs),
      offHoursMs: computeOffHoursMs(fromMs, toMs, opts.workingHours),
      agentLastState: lastState,
    };
  });
}

interface HookArchivePayload {
  state?: HookState | null;
  event?: string;
  writer?: string;
  agent?: string;
  timestamp?: number;
  detail?: string;
}

interface HookArchiveEntry {
  archivedAt?: string;
  payload?: HookArchivePayload;
}

interface SnapshotFrame {
  atMs: number;
  inputs: TaskProgressInputs;
}

/** Hook records from the archived history plus the current live hook file. */
function loadHookEvidence(historyPath: string | undefined, liveHookPath: string | null): ProgressEvidence[] {
  const evidence: ProgressEvidence[] = [];
  if (historyPath) {
    try {
      for (const e of readJsonlFile<HookArchiveEntry>(historyPath)) {
        if (e.payload?.timestamp) evidence.push({ atMs: e.payload.timestamp * 1000, kind: 'hook', hook: e.payload });
      }
    } catch (err) {
      console.warn(`[reliability-metrics] Failed to read ${historyPath}: ${errorMessage(err)}`);
    }
  }
  if (liveHookPath && existsSync(liveHookPath)) {
    try {
      const parsed = JSON.parse(readFileSync(liveHookPath, 'utf-8')) as HookArchivePayload;
      if (parsed && typeof parsed.timestamp === 'number') {
        evidence.push({ atMs: parsed.timestamp * 1000, kind: 'hook', hook: parsed, detail: 'live' });
      }
    } catch (err) {
      console.warn(`[reliability-metrics] Failed to read live hook ${liveHookPath}: ${errorMessage(err)}`);
    }
  }
  return evidence;
}

/** Stage `startedAt` / `finishedAt` from live or archived stage results. */
function stageTransitionEvidence(task: MergedTaskRef): ProgressEvidence[] {
  const dirs = {
    featureDirs: task.featureDir && existsSync(task.featureDir) ? [task.featureDir] : [],
    ...(task.archiveDir ? { archiveDir: task.archiveDir } : {}),
  };
  const evidence: ProgressEvidence[] = [];
  for (const w of deriveAgentActivityWindows(dirs)) {
    evidence.push({ atMs: w.start, kind: 'transition', detail: `${w.stage}:started` });
    // An unfinished stage reports `end = now`; only real finish times count.
    if (w.end < Date.now() - 1000) evidence.push({ atMs: w.end, kind: 'transition', detail: `${w.stage}:finished` });
  }
  return evidence;
}

/**
 * Agent activity from session transcripts: the Claude session JSONL for the
 * task branch, and archived native-agent sessions. Each record is the agent
 * working at that moment (one per minute is enough for a 5-minute replay).
 */
function sessionActivityEvidence(task: MergedTaskRef, ctx: ReliabilityContext | undefined): ProgressEvidence[] {
  const minutes = new Set<number>();
  const add = (ms: number) => { if (Number.isFinite(ms)) minutes.add(Math.floor(ms / 60_000)); };

  if (task.worktree && task.branch) {
    const dirs = (ctx?.claudeProjectsDirs ?? resolveProjectsDirs)(task.worktree).filter((d) => existsSync(d));
    for (const dir of dirs) {
      for (const file of safeReaddir(dir).filter((f) => f.endsWith('.jsonl'))) {
        try {
          for (const entry of readJsonlFile<{ gitBranch?: string; timestamp?: string; type?: string }>(join(dir, file))) {
            if (entry.gitBranch !== task.branch || typeof entry.timestamp !== 'string') continue;
            if (entry.type !== 'assistant' && entry.type !== 'user') continue;
            add(Date.parse(entry.timestamp));
          }
        } catch {
          continue;
        }
      }
    }
  }
  if (task.archiveDir) {
    const nativeDir = join(task.archiveDir, 'native-sessions');
    for (const file of safeReaddir(nativeDir).filter((f) => f.endsWith('.jsonl'))) {
      try {
        for (const entry of readJsonlFile<{ timestamp?: number | string }>(join(nativeDir, file))) {
          add(typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp ?? ''));
        }
      } catch {
        continue;
      }
    }
  }

  return [...minutes].map((minute) => {
    const atMs = minute * 60_000;
    return {
      atMs,
      kind: 'hook' as const,
      hook: { state: 'working' as HookState, event: 'SessionActivity', writer: 'agent', agent: 'session', timestamp: Math.floor(atMs / 1000) },
    };
  });
}

/** Tend's lane entry and last lane progress (rebase, CI restart, merge). */
function laneProgressEvidence(task: MergedTaskRef, ctx: ReliabilityContext | undefined): ProgressEvidence[] {
  if (!task.prNumber || !ctx) return [];
  const record = readLaneProgress(task.prNumber, ctx.repoDir);
  if (!record) return [];
  const evidence: ProgressEvidence[] = [];
  const entered = parseMs(record.enteredLaneAt);
  const last = parseMs(record.lastProgressAt);
  if (entered !== null) evidence.push({ atMs: entered, kind: 'transition', detail: 'lane:entered' });
  if (last !== null) evidence.push({ atMs: last, kind: 'transition', detail: `lane:${record.lastEvent ?? 'progress'}` });
  return evidence;
}

function safeReaddir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir); } catch { return []; }
}

function emptyProgressInputs(): TaskProgressInputs {
  return {
    issue: '',
    hookFile: null,
    terminalHistoryIdleAt: null,
    latestCommitAt: null,
    launchAt: null,
    worktreeMtimeAt: null,
    statusFileMtimeAt: null,
    transitionInputs: [],
    terminal: { prState: null, prNumber: null, lifecycleOutcome: null, at: null },
    agentProcessLive: null,
    backgroundWork: null,
    blockingPrompt: null,
  };
}

function hookWriter(payload: HookArchivePayload): 'agent' | 'monitor' {
  const event = payload.event ?? '';
  const writerRaw = payload.writer;
  const isController = writerRaw === 'monitor'
    || (writerRaw !== 'agent' && event.length > 0 && CONTROLLER_HOOK_EVENTS.has(event));
  return isController ? 'monitor' : 'agent';
}

function hookRecord(payload: HookArchivePayload) {
  return {
    state: payload.state ?? null,
    event: payload.event ?? '',
    agent: payload.agent ?? '',
    timestamp: payload.timestamp ?? 0,
    ...(payload.detail ? { detail: payload.detail } : {}),
  };
}

/**
 * Build the primitive's hook view from the newest record plus the agent's
 * own newest record, which a later monitor write must not erase (HOK-3101
 * invariant 3).
 */
function synthesizeHookFile(top: HookArchivePayload, agent: HookArchivePayload | null) {
  return {
    top: hookRecord(top),
    writer: hookWriter(top),
    agentRecord: agent ? hookRecord(agent) : null,
    topTimestamp: top.timestamp ?? 0,
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

function unattendedAndStuck(tasks: TaskReliability[]) {
  const merged = tasks.length;
  const unattended = tasks.filter((t) => t.touchCount === 0).length;
  const stuckSeries = tasks
    .filter((t) => t.stuckCoverage !== 'none')
    .map((t) => t.stuckMs)
    .sort((a, b) => a - b);
  return {
    merged,
    unattended,
    unattendedRate: merged > 0 ? unattended / merged : null,
    stuckP50Ms: percentile(stuckSeries, 50),
    stuckP90Ms: percentile(stuckSeries, 90),
  };
}

function emptyAutomationByKind(): Record<TouchKind, number> {
  return {
    'operator-event': 0,
    'operator-intervention': 0,
    'eval-intervention': 0,
    'pane-message': 0,
    'session-redirect': 0,
    'label-edit': 0,
    'external-merge': 0,
    'manual-push': 0,
    'state-edit': 0,
  };
}

function aggregateStallCausesForTasks(tasks: TaskReliability[]): Record<StallCause, { stalls: number; hours: number }> {
  return aggregateStallCauses(tasks.flatMap((t) => t.stallIntervals));
}

/**
 * Intervals as the gate aggregator sees them. An interval without a split
 * (computed before HOK-3468, or without gate evidence) still contributes its
 * whole duration to its primary gate, so per-gate hours always sum to total
 * stuck hours.
 */
function buildGateIntervalInputs(tasks: TaskReliability[]): StallGateIntervalInput[] {
  const inputs: StallGateIntervalInput[] = [];
  for (const t of tasks) {
    for (const interval of t.stallIntervals) {
      const split = interval.gateSplit && interval.gateSplit.length > 0
        ? interval.gateSplit
        : [{ gate: interval.gate ?? 'unknown', stage: interval.stage ?? 'unknown', ms: interval.durationMs }];
      inputs.push({
        ...(t.task.issue ? { issue: t.task.issue } : {}),
        durationMs: interval.durationMs,
        gateSplit: split,
        endedByPerson: interval.endedByPerson === true,
        offHoursMs: interval.offHoursMs ?? 0,
      });
    }
  }
  return inputs;
}

function collectUnknownEvidence(tasks: TaskReliability[]): UnknownStallEvidence[] {
  const rows: UnknownStallEvidence[] = [];
  for (const t of tasks) {
    for (const interval of t.stallIntervals) {
      const unknownMs = (interval.gateSplit ?? [])
        .filter((entry) => entry.gate === 'unknown')
        .reduce((sum, entry) => sum + entry.ms, 0);
      // No split: the whole interval is unknown unless it was attributed.
      const wholeUnknown = !interval.gateSplit && (interval.gate ?? 'unknown') === 'unknown';
      const ms = unknownMs > 0 ? unknownMs : wholeUnknown ? interval.durationMs : 0;
      if (ms <= 0) continue;
      rows.push({
        issue: t.task.issue ?? (t.task.prNumber ? `#${t.task.prNumber}` : null),
        from: interval.from,
        to: interval.to,
        hours: ms / (60 * 60 * 1000),
        missing: interval.missingEvidence ?? [],
      });
    }
  }
  return rows.sort((a, b) => b.hours - a.hours);
}

function aggregateBucket(tasks: TaskReliability[], key: string, label: string): ReliabilityBucket {
  const all = unattendedAndStuck(tasks);
  const mill = unattendedAndStuck(tasks.filter((t) => t.isMillTask));
  const coverage = {
    full: tasks.filter((t) => t.stuckCoverage === 'full').length,
    partial: tasks.filter((t) => t.stuckCoverage === 'partial').length,
    none: tasks.filter((t) => t.stuckCoverage === 'none').length,
  };
  const touchClasses = emptyClassCounts();
  const touchedTasksByClass = emptyClassCounts();
  let approvals = 0;
  const automationByKind = emptyAutomationByKind();
  let tasksWithApprovals = 0;
  let tasksWithUnattributedCommits = 0;
  for (const t of tasks) {
    const counts = t.touchClasses ?? countTouchClasses(t.touches);
    for (const cls of INTERVENTION_CLASSES) {
      touchClasses[cls] += counts[cls];
      if (counts[cls] > 0) touchedTasksByClass[cls] += 1;
    }
    approvals += t.approvals;
    if (t.approvals > 0) tasksWithApprovals += 1;
    if (t.unattributedCommits > 0) tasksWithUnattributedCommits += 1;
  }
  const stallCauses = aggregateStallCausesForTasks(tasks);
  const stallGates = aggregateStallGates(buildGateIntervalInputs(tasks));
  const waitedForPerson = computeWaitedForPerson(tasks.flatMap((t) => t.stallIntervals));
  const unknownEvidence = collectUnknownEvidence(tasks);
  return {
    key,
    label,
    ...all,
    coverage,
    touchClasses,
    touchedTasksByClass,
    approvals,
    tasksWithApprovals,
    automationByKind,
    tasksWithUnattributedCommits,
    stallCauses,
    stallGates,
    waitedForPerson,
    unknownEvidence,
    millMerged: mill.merged,
    millUnattended: mill.unattended,
    millUnattendedRate: mill.unattendedRate,
    millStuckP50Ms: mill.stuckP50Ms,
    millStuckP90Ms: mill.stuckP90Ms,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface RenderOptions {
  color?: boolean;
  includeTaskTable?: boolean;
  /** Add each task's per-class touch counts to the per-task table. */
  includeClasses?: boolean;
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
  lines.push(`Merged tasks (all PRs):       ${o.merged}`);
  lines.push(`Unattended rate:              ${fmtRate(o.unattendedRate)} (${o.unattended}/${o.merged})`);
  lines.push(`Median time stuck:            ${fmtMs(o.stuckP50Ms)}`);
  lines.push(`P90 time stuck:               ${fmtMs(o.stuckP90Ms)}`);
  lines.push(`Mill tasks:                   ${o.millMerged} · unattended ${fmtRate(o.millUnattendedRate)} (${o.millUnattended}/${o.millMerged}) · p50 ${fmtMs(o.millStuckP50Ms)} · p90 ${fmtMs(o.millStuckP90Ms)}`);
  lines.push(`Coverage: full=${o.coverage.full}, partial=${o.coverage.partial}, none=${o.coverage.none}`);
  lines.push(`Touches by class:             ${fmtClasses(o.touchClasses)}`);
  lines.push(`Tasks touched by class:       ${fmtClasses(o.touchedTasksByClass)}`);
  lines.push(`Approvals:                    ${o.approvals} (${o.tasksWithApprovals} tasks)`);
  lines.push(`Stall causes (>1h):           ${fmtStallCauses(o.stallCauses)}`);
  lines.push(...renderGateSection(o));
  if (summary.sources) lines.push(renderSources(summary.sources));
  lines.push('');

  if (summary.bucket === 'rolling7d') {
    for (const b of summary.buckets) {
      lines.push(`Rolling 7-day:                all ${fmtRate(b.unattendedRate)} · mill ${fmtRate(b.millUnattendedRate)} · p50 ${fmtMs(b.stuckP50Ms)} · p90 ${fmtMs(b.stuckP90Ms)}  (${b.millMerged}/${b.merged} mill/all merged)`);
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
      lines.push(renderTaskLine(t, Boolean(opts.includeClasses)));
    }
  }

  if (summary.promptCache && summary.promptCache.length > 0) {
    lines.push('');
    lines.push('Prompt-cache hit rate (median, turns 2..n):');
    for (const row of summary.promptCache) {
      lines.push(`  ${row.model.padEnd(36)} ${row.providerRoute.padEnd(12)} ${fmtRate(row.medianHitRate).padStart(6)}  (${row.samples} run${row.samples === 1 ? '' : 's'})`);
    }
  }

  if (summary.spotChecks && summary.spotChecks.length > 0) {
    lines.push('');
    lines.push('Spot check:');
    for (const t of summary.spotChecks) {
      const verdict = t.touchCount > 0 ? 'touched' : 'UNTOUCHED';
      const kinds = [...new Set(t.touches.map((touch) => touch.kind))].join(',') || '—';
      lines.push(`  #${(t.task.prNumber ?? '?').padEnd(6)} ${verdict.padEnd(10)} touches=${t.touchCount}  ${fmtClasses(t.touchClasses)}  via ${kinds}`);
    }
  }
  return lines.join('\n');
}

function fmtClasses(counts: Record<InterventionClass, number>): string {
  return INTERVENTION_CLASSES.map((cls) => `${cls}=${counts[cls]}`).join('  ');
}

function fmtStallCauses(causes: Record<StallCause, { stalls: number; hours: number }>): string {
  const parts = STALL_CAUSES
    .filter((cause) => cause !== 'unknown' || causes[cause].stalls > 0)
    .map((cause) => `${cause}=${causes[cause].stalls}/${causes[cause].hours.toFixed(1)}h`);
  return parts.join('  ');
}

/** `MM-DD HH:MM` for the gate table's unknown-evidence rows. */
function shortStamp(iso: string): string {
  return iso.slice(5, 16).replace('T', ' ');
}

/**
 * The gate table (HOK-3468): which gate held each task, for how long, how much
 * of it a person ended, and how much of it was outside working hours. Prints
 * exactly the rows and figures carried in `ReliabilityBucket.stallGates`,
 * `waitedForPerson` and `unknownEvidence`.
 */
function renderGateSection(bucket: ReliabilityBucket): string[] {
  const lines: string[] = [];
  lines.push('Stuck time by gate (all stalls; hours sum to total stuck):');
  lines.push(`  ${'gate'.padEnd(20)} ${'tasks'.padStart(5)} ${'stalls'.padStart(6)} ${'hours'.padStart(7)}  ${'ended-by-person'.padStart(15)}  ${'off-hours'.padStart(9)}`);
  for (const row of bucket.stallGates) {
    lines.push(
      `  ${row.gate.padEnd(20)} ${String(row.tasks).padStart(5)} ${String(row.intervals).padStart(6)} ${row.hours.toFixed(1).padStart(7)}  ${String(row.endedByPerson).padStart(15)}  ${`${row.offHoursHours.toFixed(1)}h`.padStart(9)}`,
    );
  }
  const stageHours = new Map<StallStage, number>();
  for (const row of bucket.stallGates) {
    for (const [stage, hours] of Object.entries(row.byStage)) {
      stageHours.set(stage as StallStage, (stageHours.get(stage as StallStage) ?? 0) + (hours ?? 0));
    }
  }
  const stages = STALL_STAGES
    .filter((stage) => stage !== 'unknown')
    .map((stage) => `${stage} ${(stageHours.get(stage) ?? 0).toFixed(1)}h`)
    .join(' · ');
  lines.push(`  By stage: ${stages}`);

  const stuckHours = bucket.waitedForPerson.stuckHours;
  lines.push(
    `  Waited for a person (off-hours, ended by an operator action): ${bucket.waitedForPerson.hours.toFixed(1)}h of ${stuckHours.toFixed(1)}h (${fmtRate(bucket.waitedForPerson.share)})`,
  );

  const unknownHours = bucket.stallGates.find((row) => row.gate === 'unknown')?.hours ?? 0;
  const unknownShare = stuckHours > 0 ? unknownHours / stuckHours : 0;
  if (bucket.unknownEvidence.length === 0) {
    lines.push(`  Unknown ${(unknownShare * 100).toFixed(1)}% of stuck hours`);
  } else {
    lines.push(`  Unknown ${(unknownShare * 100).toFixed(1)}% of stuck hours — missing evidence:`);
    for (const row of bucket.unknownEvidence) {
      const missing = row.missing.length > 0 ? row.missing.join(', ') : 'no record named';
      lines.push(`    ${(row.issue ?? '?').padEnd(12)} ${shortStamp(row.from)}→${shortStamp(row.to)}  ${row.hours.toFixed(1)}h  ${missing}`);
    }
  }
  return lines;
}

function renderSources(sources: SourceCoverage): string {
  const github = sources.githubEnabled
    ? `github timelines=${sources.githubTimelines}${sources.githubUnavailable ? ` (unavailable=${sources.githubUnavailable})` : ''}`
    : 'github=off';
  const ledger = `label ledger since ${sources.labelLedgerSince?.slice(0, 10) ?? 'never'}`;
  const lane = `tend lane since ${sources.mergeLaneSince?.slice(0, 10) ?? 'never'}`;
  return `Sources: ${github} · ${ledger} · ${lane} · archived tasks=${sources.archivedTasks}`;
}

/** Per-task gate hours, largest first, for `--include-tasks` (HOK-3468). */
function taskGateSummary(t: TaskReliability): string {
  const byGate = new Map<StallGate, number>();
  for (const interval of t.stallIntervals) {
    for (const entry of interval.gateSplit ?? []) {
      byGate.set(entry.gate, (byGate.get(entry.gate) ?? 0) + entry.ms);
    }
  }
  if (byGate.size === 0) return '';
  const parts = [...byGate.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([gate, ms]) => `${gate} ${(ms / (60 * 60 * 1000)).toFixed(1)}h`);
  return `  gates=${parts.join(' · ')}`;
}

function renderTaskLine(t: TaskReliability, includeClasses: boolean): string {
  const id = t.task.issue ?? (t.task.prNumber ? `#${t.task.prNumber}` : t.task.title.slice(0, 32));
  const classes = includeClasses ? `  ${fmtClasses(t.touchClasses)}` : '';
  return `  ${t.task.mergedAt.slice(0, 10)}  ${id.padEnd(14)} touches=${t.touchCount}${classes}  stuck=${fmtMs(t.stuckMs)}  coverage=${t.stuckCoverage}${taskGateSummary(t)}`;
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
  return `7d unattended: mill ${fmtRate(b.millUnattendedRate)} · all ${fmtRate(b.unattendedRate)} · stuck p50 ${fmtMs(b.stuckP50Ms)} · p90 ${fmtMs(b.stuckP90Ms)} (${b.millMerged}/${b.merged} merged)`;
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
  /** Read GitHub PR timelines (default: `reliability.github`, true). */
  github?: boolean;
  /** PR timeline cache directory (`BuildContextOptions.cacheDir`). */
  cacheDir?: string | null;
  /** PR numbers to spot-check whether or not they merged in the window. */
  spotCheckPrs?: string[];
  /** Pre-built evidence context (tests); built from the repo when omitted. */
  context?: ReliabilityContext;
}

/** Compute touches, classes and time stuck for one task. */
export function computeTaskReliability(
  task: MergedTaskRef,
  ctx: ReliabilityContext,
  opts: { session?: string; stallMinutes?: number } = {},
): TaskReliability {
  const timeline = readTaskTimeline(task, ctx);
  const allTouches = collectOperatorTouches({ repoDir: ctx.repoDir, task, context: ctx, timeline });
  const humanTouches = allTouches.filter((t) => t.attribution === 'human');
  const approvals = allTouches.filter((t) => t.attribution === 'approval').length;
  const automation = allTouches.filter((t) => t.attribution === 'automation');
  const unattributedCommits = automation.filter((t) => t.kind === 'manual-push').length;
  const stuck = computeTimeStuck({
    task,
    session: opts.session,
    stallMinutes: opts.stallMinutes,
    context: ctx,
    timeline,
  });
  const stallIntervals = attachStallGates(task, stuck, ctx, {
    touches: allTouches,
    workingHours: getReliabilityConfig(ctx.repoDir).workingHours,
  });
  return {
    task,
    touches: humanTouches,
    touchCount: humanTouches.length,
    // HOK-3468: the class table counts human touches only. Approvals stay in
    // `approvals` and mill automation in `automationCount`; neither is a person
    // having to act.
    touchClasses: countTouchClasses(humanTouches),
    approvals,
    automationCount: automation.length,
    unattributedCommits,
    stuckMs: stuck.stuckMs,
    stuckCoverage: stuck.coverage,
    stallIntervals,
    isMillTask: Boolean(task.featureDir || task.archiveDir) || stuck.coverage !== 'none',
  };
}

/**
 * Resolve a spot-checked PR (merged or closed) into a task ref: its merge
 * time from the timeline when it merged, else its close time.
 */
function spotCheckTask(prNumber: string, ctx: ReliabilityContext): MergedTaskRef {
  const timeline = ctx.github?.enabled ? fetchPrTimeline(prNumber, {
    repoDir: ctx.repoDir,
    ...(ctx.github.nwo ? { nwo: ctx.github.nwo } : {}),
    ...(ctx.github.gh ? { gh: ctx.github.gh } : {}),
    ...(ctx.github.cacheDir !== undefined ? { cacheDir: ctx.github.cacheDir } : {}),
  }) : null;
  const merged = timeline?.find((e) => e.event === 'merged');
  const closed = timeline?.find((e) => e.event === 'closed');
  const record = ctx.archiveByPr?.get(prNumber);
  return resolveTaskRef(ctx.repoDir, {
    prNumber,
    title: record?.issue ? `${record.issue} (#${prNumber})` : `#${prNumber}`,
    mergedAt: merged?.at ?? closed?.at ?? new Date().toISOString(),
    ...(merged || !closed ? {} : { merged: false }),
  }, ctx.archiveByPr ?? new Map());
}

export function computeReliability(opts: ComputeReliabilityOptions): ReliabilitySummary {
  const ctx = opts.context ?? buildReliabilityContext({
    repoDir: opts.repoDir,
    github: opts.github,
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
  });
  const stallMinutes = opts.stallMinutes ?? getReliabilityConfig(opts.repoDir).stallMinutes;
  const merged = collectMergedTasks({
    repoDir: opts.repoDir,
    sinceIso: opts.sinceIso,
    untilIso: opts.untilIso,
    branches: opts.branches,
    archiveByPr: ctx.archiveByPr,
  });

  const taskOpts = { session: opts.session, stallMinutes };
  const tasks = merged.map((task) => computeTaskReliability(task, ctx, taskOpts));
  const summary = aggregateReliability(tasks, {
    sinceIso: opts.sinceIso,
    untilIso: opts.untilIso,
    bucket: opts.bucket,
  });

  if (opts.spotCheckPrs && opts.spotCheckPrs.length > 0) {
    summary.spotChecks = opts.spotCheckPrs.map((pr) =>
      tasks.find((t) => t.task.prNumber === pr) ?? computeTaskReliability(spotCheckTask(pr, ctx), ctx, taskOpts));
  }
  summary.repoDir = resolve(opts.repoDir);
  summary.sources = {
    githubEnabled: Boolean(ctx.github?.enabled),
    githubTimelines: ctx.stats?.githubTimelines ?? 0,
    githubUnavailable: ctx.stats?.githubUnavailable ?? 0,
    labelLedgerSince: ctx.labelWrites?.startMs != null ? iso(ctx.labelWrites.startMs) : null,
    mergeLaneSince: ctx.mergeLaneSinceMs != null ? iso(ctx.mergeLaneSinceMs) : null,
    archivedTasks: tasks.filter((t) => !t.task.featureDir && t.task.archiveDir).length,
  };
  const promptCache = collectPromptCacheHitRates(tasks.map((t) => t.task));
  if (promptCache.length > 0) summary.promptCache = promptCache;
  return summary;
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
 * Parse a shorthand window like `14d`, `7d`, `30d` — or an absolute start
 * date like `2026-09-25` — into since/until ISO timestamps bounded by `now`.
 */
export function parseWindow(spec: string, now: Date = new Date()): { since: string; until: string } {
  const trimmed = spec.trim();
  // Absolute start: `2026-09-25` or a full ISO timestamp, through `now`.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const sinceMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
    if (!Number.isFinite(sinceMs) || sinceMs > now.getTime()) {
      throw new Error(`Unsupported window start: ${spec} (expected a past date like "2026-09-25")`);
    }
    return { since: new Date(sinceMs).toISOString(), until: now.toISOString() };
  }
  const match = trimmed.match(/^(\d+)([dhw])$/);
  if (!match) {
    throw new Error(`Unsupported window: ${spec} (expected like "14d", "7d", "48h", or "2026-09-25")`);
  }
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  const unitMs = unit === 'd' ? 86_400_000 : unit === 'w' ? 7 * 86_400_000 : 3_600_000;
  const until = now;
  const since = new Date(until.getTime() - n * unitMs);
  return { since: since.toISOString(), until: until.toISOString() };
}
