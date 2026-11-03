/**
 * Queue / CI / repair derived metrics (HOK-3340, MQ-1.4).
 *
 * "How long did this PR wait, run CI, repair, and take to land?" gets one
 * answer: {@link deriveQueueMetrics}, a pure, versioned derivation
 * (`queue-metrics/v1`) over a PR's `.queue-events.jsonl` log. It is the one
 * place every metric's start- and end-event boundary is defined.
 *
 * This module exists because HOK-2895 shipped `wall_clock` including queue
 * idle, inflating latency by ~96×. The fix pattern is HOK-3380's one time
 * share (`nativeStageTimeSplit`): one versioned derivation, no per-site
 * arithmetic, boundaries documented once.
 *
 * ## Metric boundaries
 *
 * | Metric | Start event | End event |
 * | --- | --- | --- |
 * | `queueWait` (per cycle) | `enqueued` | next `candidate_prepared` |
 * | `ciRun` (per attempt window) | `candidate_prepared` | last `check_run_completed` before the window closes |
 * | `repairLoop` (per cycle) | `ejected` or `abandoned` | next `enqueued` |
 * | `timeToLand` | first `enqueued` | `merged` |
 * | `attemptsToLand` | count of `candidate_prepared` events | — |
 * | `ejections` | count of `ejected` + `abandoned` events | — |
 * | `reruns` | count of `rerun_requested` events | — |
 *
 * ## Modeling decisions
 *
 *  1. **No explicit `check_started` event in the schema.** `candidate_prepared`
 *     is emitted at the top of `executeMerge()`, immediately before
 *     rebase/checks — the nearest real proxy for "first candidate check
 *     start". `queueWait` and `ciRun` boundaries both use it.
 *  2. **`candidateId` is never populated** by any real call site in the
 *     wavemill codebase. Attempts cannot be grouped by it, so they are
 *     segmented by consecutive `candidate_prepared` events: each one opens a
 *     new attempt window that runs until the next `candidate_prepared`,
 *     `merged`, `ejected`, or `abandoned`, whichever comes first.
 *  3. **Two "left the queue without landing" event types exist**: `ejected`
 *     (tend/mill eligibility disagreement, HOK-3092 class) and `abandoned`
 *     (merge attempt failed during rebase/checks/ready/merge). The issue's
 *     "ejections" / repair-loop boundary is modeled as the **union** of the
 *     two — both represent a candidate leaving its current attempt without
 *     merging. The schema does not distinguish them for this purpose.
 *  4. **Missing vs. zero:** an **empty / absent** event log makes every
 *     metric `'unknown'`, never `0` — this is the regression class HOK-2895
 *     shipped. A **populated** log that genuinely contains zero ejections
 *     reports `ejections: 0`, which is a real fact.
 *  5. **`enqueued`/`ejected` are level-triggered, not edge-triggered.**
 *     `tend-controller.ts::selectNextCandidate` runs on every poll tick and
 *     re-emits a fresh `enqueued` for every still-eligible PR and a fresh
 *     `ejected` for every still-blocked PR — not only on the transition into
 *     that state. Each re-affirmation carries a distinct timestamp-based
 *     `eventId`, so `appendQueueEventBestEffort`'s eventId dedup never
 *     collapses them. Pairing every re-affirmation with the same next
 *     transition event (instead of only the one that actually entered the
 *     state) would reproduce HOK-2895's inflation class inside this module.
 *     {@link collapseReaffirmedRuns} collapses each run of consecutive
 *     same-type `enqueued`/`ejected` events down to its first event, once,
 *     before any cycle or count is derived.
 *
 * ## I/O boundary
 *
 * {@link deriveQueueMetrics} is pure: no clock reads, no file reads, no
 * environment. {@link deriveQueueMetricsForPr} is the thin I/O wrapper that
 * resolves the lane state dir and calls {@link readQueueEvents} from
 * `queue-events.ts`. This mirrors `nativeStageTimeSplit` /
 * `resolveNativeStageTimeSplit`.
 *
 * ## Cost-ledger join
 *
 * CLAUDE.md names `session-ownership.ts` + `sdk-task-cost/meter.ts` as the
 * **one** cost engine — "Never add a second cost engine." The event schema
 * carries no durations or tokens, so cost/duration data is an **optional
 * injected join**, never read here. When provided, the module sums whatever
 * falls inside each derived window; when absent, `ciComputeMinutes` /
 * `repairTokens` are `'unknown'`. The caller assembles the join from
 * whatever data source it already owns (GH check durations, the cost
 * engine's session rows, etc.).
 *
 * ## Ad-hoc calculations earmarked for follow-up migration (HOK-3337)
 *
 * The following live in `shared/lib/cost-baseline/` and today derive the
 * same facts from the label-write ledger and lane `progress.json`, not from
 * `queue-events.jsonl`. They are left in place — the label ledger predates
 * the event log (ledger from 2026-10-13; the event log only exists from
 * HOK-3339 onward), so a wholesale swap would lose coverage of every
 * historical baseline task. MQ-0.1 re-run (a separate issue) is the natural
 * place to migrate them once there is enough live event-log data:
 *
 *   - `cost-baseline/dimensions.ts::computeQueueWait` — reads
 *     `wm:ready` label-ledger intervals.
 *   - `cost-baseline/dimensions.ts::computeCi` — reads eval-record
 *     `ciChecks` durations.
 *   - `cost-baseline/dimensions.ts::computeTaskDimensions` — reads session
 *     spans and `mergeAt()`.
 *   - `cost-baseline/integration-failures.ts` — reads `wm:merging` label
 *     applications and lane `progress.json` counters.
 *
 * @see docs/queue-metrics.md
 * @see shared/lib/queue-events.ts
 * @module queue-metrics
 */

import { readQueueEvents, type QueueEventType, type QueueLifecycleEvent } from './queue-events.ts';
import { mergeLaneStateDir } from './merge-queue.ts';

export const QUEUE_METRICS_VERSION = 'queue-metrics/v1';

/**
 * A single derived duration. `'unknown'` means the input events did not
 * cover the metric's start-or-end boundary (e.g. PR not yet merged for
 * `timeToLand`). It is never produced by a missing join; it is never 0.
 */
export type DurationSeconds = number | 'unknown';

/** A single derived count. Zero is reported when the event log is populated. */
export type CountOrUnknown = number | 'unknown';

/** A single derived cost/duration join scalar. `'unknown'` means "no join data was supplied for this window". */
export type JoinScalar = number | 'unknown';

/**
 * One queue-wait cycle: time from an `enqueued` event to the next
 * `candidate_prepared`. If the PR is still queued (no subsequent
 * `candidate_prepared`), the cycle's end is `'unknown'`.
 */
export interface QueueWaitCycle {
  /** `enqueued` event id. */
  startEventId: string;
  startTimestamp: string;
  /** `candidate_prepared` event id (null if the cycle is still open). */
  endEventId: string | null;
  endTimestamp: string | null;
  seconds: DurationSeconds;
}

/**
 * One attempt window: time from one `candidate_prepared` to the last
 * `check_run_completed` seen before the window closes (a terminal event:
 * next `candidate_prepared`, `merged`, `ejected`, or `abandoned`).
 */
export interface CiRunAttempt {
  /** `candidate_prepared` event id. */
  startEventId: string;
  startTimestamp: string;
  /** Last `check_run_completed` event id inside the window (null if none). */
  lastCheckEventId: string | null;
  lastCheckTimestamp: string | null;
  seconds: DurationSeconds;
  /** Number of `check_run_completed` events seen in this window. */
  checkRunCount: number;
  /** Event that closed the window. */
  closedBy: 'candidate_prepared' | 'merged' | 'ejected' | 'abandoned' | 'open';
}

/**
 * One repair cycle: from `ejected`/`abandoned` to the next `enqueued`. If
 * the PR never re-enqueued after being ejected/abandoned, the cycle's end
 * is `'unknown'`.
 */
export interface RepairLoopCycle {
  /** `ejected` or `abandoned` event id. */
  startEventId: string;
  startEventType: 'ejected' | 'abandoned';
  startTimestamp: string;
  endEventId: string | null;
  endTimestamp: string | null;
  seconds: DurationSeconds;
  /** `rerun_requested` events seen between start and end. */
  reruns: number;
}

/** Optional cost/duration join rows. See module docstring. */
export interface CiCheckDuration {
  name: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
}

export interface RepairCostEntry {
  sessionRef: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  costUsd?: number;
  tokens?: number;
}

export interface DeriveQueueMetricsOptions {
  ciCheckDurations?: readonly CiCheckDuration[];
  repairCostEntries?: readonly RepairCostEntry[];
}

export interface QueueMetricsResult {
  version: typeof QUEUE_METRICS_VERSION;
  /** Number of validated, deduplicated events the derivation ran over. */
  eventCount: number;
  queueWait: {
    cycles: QueueWaitCycle[];
    totalSeconds: DurationSeconds;
  };
  ciRun: {
    attempts: CiRunAttempt[];
    totalSeconds: DurationSeconds;
  };
  repairLoop: {
    cycles: RepairLoopCycle[];
    totalSeconds: DurationSeconds;
  };
  timeToLand: {
    startEventId: string | null;
    startTimestamp: string | null;
    endEventId: string | null;
    endTimestamp: string | null;
    seconds: DurationSeconds;
  };
  attemptsToLand: CountOrUnknown;
  ejections: CountOrUnknown;
  reruns: CountOrUnknown;
  /** Sum of `ciCheckDurations[*].durationSeconds` that fall inside any CI run window, in minutes. `'unknown'` when no `ciCheckDurations` was provided. */
  ciComputeMinutes: JoinScalar;
  /** Sum of `repairCostEntries[*].tokens` that overlap any repair window. `'unknown'` when no `repairCostEntries` was provided. */
  repairTokens: JoinScalar;
  /** Sum of `repairCostEntries[*].costUsd` that overlap any repair window. `'unknown'` when no `repairCostEntries` was provided. */
  repairCostUsd: JoinScalar;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const REPAIR_START_TYPES = new Set<QueueEventType>(['ejected', 'abandoned']);
const ATTEMPT_CLOSING_TYPES = new Set<QueueEventType>([
  'candidate_prepared',
  'merged',
  'ejected',
  'abandoned',
]);

/**
 * `enqueued` and `ejected` are re-emitted every poll tick for as long as a
 * PR stays eligible/blocked (see modeling decision 5 above) — they mark a
 * persistent state, not a one-off transition.
 */
const REAFFIRMED_EVENT_TYPES = new Set<QueueEventType>(['enqueued', 'ejected']);

/**
 * Collapse each run of consecutive same-type {@link REAFFIRMED_EVENT_TYPES}
 * events (in arrival order) down to its first event. Every other event type
 * — including interleaved occurrences of the *other* reaffirmed type — is
 * left untouched, so this only removes redundant re-affirmations of a state
 * that never changed, never a real transition.
 */
function collapseReaffirmedRuns(ordered: readonly QueueLifecycleEvent[]): QueueLifecycleEvent[] {
  const collapsed: QueueLifecycleEvent[] = [];
  let previousType: QueueEventType | null = null;
  for (const ev of ordered) {
    if (ev.eventType === previousType && REAFFIRMED_EVENT_TYPES.has(ev.eventType)) {
      continue;
    }
    collapsed.push(ev);
    previousType = ev.eventType;
  }
  return collapsed;
}

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function secondsBetween(startIso: string, endIso: string | null): DurationSeconds {
  const start = toEpochMs(startIso);
  const end = toEpochMs(endIso);
  if (start === null || end === null) return 'unknown';
  const delta = (end - start) / 1000;
  if (!Number.isFinite(delta)) return 'unknown';
  // Negative durations (out-of-order timestamps) are clamped to 0: the
  // events happened, their order is just unreliable. This is the same
  // treatment `cost-baseline/dimensions.ts::seconds` applies.
  return Math.max(0, delta);
}

function sumDurations(values: readonly DurationSeconds[]): DurationSeconds {
  // Empty-cycle list in a populated log is a real fact (no repair
  // happened, no queue wait cycles), total = 0. A single `'unknown'`
  // among present cycles makes the total `'unknown'` — "missing inputs
  // → unknown, never 0" (HOK-2895).
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) {
    if (v === 'unknown') return 'unknown';
    total += v;
  }
  return total;
}

function arrivalOrderedByTimestamp(
  events: readonly QueueLifecycleEvent[],
): QueueLifecycleEvent[] {
  // `readQueueEvents()` deduplicates by eventId but preserves insertion
  // order (Map iteration), which is append order on disk. A log written by
  // a single atomic appender is already timestamp-ordered, but we sort
  // defensively — the derivation is a pure function over "the events in
  // chronological order", and a crash/resume could interleave.
  return [...events].sort((a, b) => {
    const ta = toEpochMs(a.timestamp) ?? 0;
    const tb = toEpochMs(b.timestamp) ?? 0;
    if (ta !== tb) return ta - tb;
    // Stable within a timestamp: fall back to eventId so the output is
    // reproducible.
    return a.eventId.localeCompare(b.eventId);
  });
}

function overlapSeconds(
  winStartMs: number,
  winEndMs: number,
  itemStartIso: string,
  itemEndIso: string,
): number {
  const itemStart = toEpochMs(itemStartIso);
  const itemEnd = toEpochMs(itemEndIso);
  if (itemStart === null || itemEnd === null) return 0;
  const start = Math.max(winStartMs, itemStart);
  const end = Math.min(winEndMs, itemEnd);
  return end > start ? (end - start) / 1000 : 0;
}

// ────────────────────────────────────────────────────────────────
// Pure derivation
// ────────────────────────────────────────────────────────────────

/**
 * Derive queue/CI/repair metrics from a validated, deduplicated event
 * stream (as returned by {@link readQueueEvents}).
 *
 * Pure: no clock reads, no I/O, no environment. Recomputable at any time
 * from the same input.
 */
export function deriveQueueMetrics(
  events: readonly QueueLifecycleEvent[],
  options: DeriveQueueMetricsOptions = {},
): QueueMetricsResult {
  const ordered = arrivalOrderedByTimestamp(events);
  const hasEvents = ordered.length > 0;
  // See modeling decision 5: collapse per-tick `enqueued`/`ejected`
  // re-affirmations to their first occurrence before any pairing or
  // counting below. `eventCount` (returned further down) deliberately
  // keeps using `ordered.length`, not `collapsed.length` — it reports how
  // many validated, deduplicated events the derivation read, not how many
  // state transitions it found.
  const collapsed = collapseReaffirmedRuns(ordered);

  // ── Queue-wait cycles: each `enqueued` → next `candidate_prepared` ──
  const queueWaitCycles: QueueWaitCycle[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const ev = collapsed[i];
    if (ev.eventType !== 'enqueued') continue;
    let endIdx = -1;
    for (let j = i + 1; j < collapsed.length; j++) {
      if (collapsed[j].eventType === 'candidate_prepared') {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) {
      queueWaitCycles.push({
        startEventId: ev.eventId,
        startTimestamp: ev.timestamp,
        endEventId: null,
        endTimestamp: null,
        seconds: 'unknown',
      });
    } else {
      const endEv = collapsed[endIdx];
      queueWaitCycles.push({
        startEventId: ev.eventId,
        startTimestamp: ev.timestamp,
        endEventId: endEv.eventId,
        endTimestamp: endEv.timestamp,
        seconds: secondsBetween(ev.timestamp, endEv.timestamp),
      });
    }
  }

  // ── CI-run attempt windows: `candidate_prepared` → next window-closer ──
  const ciRunAttempts: CiRunAttempt[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const ev = collapsed[i];
    if (ev.eventType !== 'candidate_prepared') continue;
    let closeBy: CiRunAttempt['closedBy'] = 'open';
    let closeIdx = collapsed.length;
    for (let j = i + 1; j < collapsed.length; j++) {
      const nx = collapsed[j];
      if (ATTEMPT_CLOSING_TYPES.has(nx.eventType)) {
        closeBy = nx.eventType as CiRunAttempt['closedBy'];
        closeIdx = j;
        break;
      }
    }
    let lastCheckEv: QueueLifecycleEvent | null = null;
    let checkRunCount = 0;
    for (let j = i + 1; j < closeIdx; j++) {
      if (collapsed[j].eventType === 'check_run_completed') {
        lastCheckEv = collapsed[j];
        checkRunCount += 1;
      }
    }
    ciRunAttempts.push({
      startEventId: ev.eventId,
      startTimestamp: ev.timestamp,
      lastCheckEventId: lastCheckEv?.eventId ?? null,
      lastCheckTimestamp: lastCheckEv?.timestamp ?? null,
      seconds: lastCheckEv ? secondsBetween(ev.timestamp, lastCheckEv.timestamp) : 'unknown',
      checkRunCount,
      closedBy: closeBy,
    });
  }

  // ── Repair cycles: `ejected`/`abandoned` → next `enqueued` ──
  const repairCycles: RepairLoopCycle[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const ev = collapsed[i];
    if (!REPAIR_START_TYPES.has(ev.eventType)) continue;
    let endIdx = -1;
    let reruns = 0;
    for (let j = i + 1; j < collapsed.length; j++) {
      if (collapsed[j].eventType === 'rerun_requested') reruns += 1;
      if (collapsed[j].eventType === 'enqueued') {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) {
      // No re-enqueue; still count reruns through end of stream.
      repairCycles.push({
        startEventId: ev.eventId,
        startEventType: ev.eventType as 'ejected' | 'abandoned',
        startTimestamp: ev.timestamp,
        endEventId: null,
        endTimestamp: null,
        seconds: 'unknown',
        reruns,
      });
    } else {
      const endEv = collapsed[endIdx];
      repairCycles.push({
        startEventId: ev.eventId,
        startEventType: ev.eventType as 'ejected' | 'abandoned',
        startTimestamp: ev.timestamp,
        endEventId: endEv.eventId,
        endTimestamp: endEv.timestamp,
        seconds: secondsBetween(ev.timestamp, endEv.timestamp),
        reruns,
      });
    }
  }

  // ── timeToLand: first `enqueued` → `merged` ──
  const firstEnqueued = collapsed.find((e) => e.eventType === 'enqueued') ?? null;
  const mergedEvent = collapsed.find((e) => e.eventType === 'merged') ?? null;
  const timeToLandSeconds: DurationSeconds =
    firstEnqueued && mergedEvent
      ? secondsBetween(firstEnqueued.timestamp, mergedEvent.timestamp)
      : 'unknown';

  // ── Counts: populated log → real integer, empty log → 'unknown' ──
  const attemptsToLand: CountOrUnknown = hasEvents ? ciRunAttempts.length : 'unknown';
  const ejectionsCount: CountOrUnknown = hasEvents
    ? collapsed.filter((e) => REPAIR_START_TYPES.has(e.eventType)).length
    : 'unknown';
  const rerunsCount: CountOrUnknown = hasEvents
    ? collapsed.filter((e) => e.eventType === 'rerun_requested').length
    : 'unknown';

  // ── Optional cost/duration join ──
  const ciComputeMinutes = computeCiComputeMinutes(ciRunAttempts, options.ciCheckDurations);
  const { tokens: repairTokens, cost: repairCostUsd } = computeRepairJoin(
    repairCycles,
    options.repairCostEntries,
  );

  return {
    version: QUEUE_METRICS_VERSION,
    eventCount: ordered.length,
    queueWait: {
      cycles: queueWaitCycles,
      totalSeconds: hasEvents
        ? sumDurations(queueWaitCycles.map((c) => c.seconds))
        : 'unknown',
    },
    ciRun: {
      attempts: ciRunAttempts,
      totalSeconds: hasEvents
        ? sumDurations(ciRunAttempts.map((a) => a.seconds))
        : 'unknown',
    },
    repairLoop: {
      cycles: repairCycles,
      totalSeconds: hasEvents
        ? sumDurations(repairCycles.map((c) => c.seconds))
        : 'unknown',
    },
    timeToLand: {
      startEventId: firstEnqueued?.eventId ?? null,
      startTimestamp: firstEnqueued?.timestamp ?? null,
      endEventId: mergedEvent?.eventId ?? null,
      endTimestamp: mergedEvent?.timestamp ?? null,
      seconds: timeToLandSeconds,
    },
    attemptsToLand,
    ejections: ejectionsCount,
    reruns: rerunsCount,
    ciComputeMinutes,
    repairTokens,
    repairCostUsd,
  };
}

function computeCiComputeMinutes(
  attempts: readonly CiRunAttempt[],
  rows: readonly CiCheckDuration[] | undefined,
): JoinScalar {
  if (!rows) return 'unknown';
  if (attempts.length === 0 || rows.length === 0) return 0;
  let totalSeconds = 0;
  for (const attempt of attempts) {
    if (attempt.lastCheckTimestamp === null) continue;
    const winStart = toEpochMs(attempt.startTimestamp);
    const winEnd = toEpochMs(attempt.lastCheckTimestamp);
    if (winStart === null || winEnd === null || winEnd <= winStart) continue;
    for (const row of rows) {
      totalSeconds += overlapSeconds(winStart, winEnd, row.startedAt, row.completedAt);
    }
  }
  return totalSeconds / 60;
}

function computeRepairJoin(
  cycles: readonly RepairLoopCycle[],
  rows: readonly RepairCostEntry[] | undefined,
): { tokens: JoinScalar; cost: JoinScalar } {
  if (!rows) return { tokens: 'unknown', cost: 'unknown' };
  if (cycles.length === 0 || rows.length === 0) return { tokens: 0, cost: 0 };
  let tokens = 0;
  let cost = 0;
  for (const cycle of cycles) {
    if (cycle.endTimestamp === null) continue;
    const winStart = toEpochMs(cycle.startTimestamp);
    const winEnd = toEpochMs(cycle.endTimestamp);
    if (winStart === null || winEnd === null || winEnd <= winStart) continue;
    for (const row of rows) {
      const rowStart = toEpochMs(row.startedAt);
      const rowEnd = toEpochMs(row.endedAt);
      if (rowStart === null || rowEnd === null) continue;
      // Row overlaps the window at all → attribute the row's full
      // tokens/cost. Repair sessions are indivisible units of work and the
      // canonical `session-ownership.ts` / cost engine tracks them whole;
      // proportional slicing by wall clock would be a second cost formula
      // this module is explicitly forbidden from introducing.
      if (rowEnd > winStart && rowStart < winEnd) {
        tokens += row.tokens ?? 0;
        cost += row.costUsd ?? 0;
      }
    }
  }
  return { tokens, cost };
}

// ────────────────────────────────────────────────────────────────
// I/O wrapper
// ────────────────────────────────────────────────────────────────

/**
 * Thin I/O wrapper around {@link deriveQueueMetrics}. Resolves the PR's
 * merge-lane state directory, reads `.queue-events.jsonl` via
 * {@link readQueueEvents} (which validates + deduplicates), and calls the
 * pure function.
 *
 * Returns the same `QueueMetricsResult` as the pure function. An absent
 * log yields `eventCount: 0` and every metric `'unknown'`.
 */
export async function deriveQueueMetricsForPr(
  prNumber: number | string,
  repoDir: string,
  options: DeriveQueueMetricsOptions = {},
): Promise<QueueMetricsResult> {
  const stateDir = mergeLaneStateDir(prNumber, repoDir);
  const events = await readQueueEvents(stateDir);
  return deriveQueueMetrics(events, options);
}
