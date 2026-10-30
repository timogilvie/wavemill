/**
 * Per-task cost and wall-clock dimensions for the MQ-0.1 baseline (HOK-3336).
 *
 * Every function returns a `DimResult` naming the boundary it measured
 * between. Dollars and latency are kept apart: queue wait is latency only,
 * because a task's agent sessions have ended before its PR is queued — no
 * agent holds context (or spends tokens) while the PR waits.
 *
 * Dollars are the session costs the cost engine already recorded on the eval
 * row (`executionEconomics[].sessions[]`, provider charge else local
 * estimate). The row's `workflowCost` is not used: from Aug 2026 it charged a
 * shared native-session pool to every task (HOK-3256). Sessions the cohort
 * attributes to more than one task are excluded and counted, as are
 * operator-owned sessions, which are never task cost (HOK-3328).
 *
 * @module cost-baseline/dimensions
 */

import { computeIntegrationFailures } from './integration-failures.ts';
import { computeReviewLoop, isReviewKind, orderedLaunches } from './review-rounds.ts';
import type {
  BaselineSession,
  BaselineTask,
  CostBuckets,
  DimResult,
  LabelEvent,
  TaskDimensions,
} from './types.ts';

/**
 * GitHub-hosted Linux runner list price (USD per minute). CI minutes are
 * priced at this rate only to put them on the same axis as agent spend; it is
 * a list-price equivalent, not what the repository is billed.
 */
export const DEFAULT_CI_USD_PER_MINUTE = 0.008;

export interface DimensionContext {
  /** Session ids that appear on more than one cohort task. */
  sharedSessionIds: ReadonlySet<string>;
  ciUsdPerMinute: number;
}

const REPAIR_KINDS = new Set(['conflict-resolution', 'ready-remediation', 'ci-fix']);
const AUTHORING_KINDS = new Set(['planning', 'coding', 'native-arm']);

/** Cost bucket for an ownership kind; `operator` sessions are excluded from task cost. */
export function costBucketForKind(kind: string): keyof CostBuckets | 'operator' {
  if (kind === 'operator') return 'operator';
  if (REPAIR_KINDS.has(kind)) return 'repairLoop';
  if (isReviewKind(kind)) return 'reviewLoop';
  if (AUTHORING_KINDS.has(kind) || kind.startsWith('helper:')) return 'authoring';
  return 'unattributed';
}

/** Session ids that occur on more than one task of the cohort. */
export function findSharedSessionIds(tasks: Array<Pick<BaselineTask, 'sessions'>>): Set<string> {
  const owners = new Map<string, number>();
  for (const task of tasks) {
    for (const id of new Set(task.sessions.map((s) => s.sessionId))) {
      owners.set(id, (owners.get(id) ?? 0) + 1);
    }
  }
  return new Set([...owners].filter(([, count]) => count > 1).map(([id]) => id));
}

function dim(value: number | null, start: string | null, end: string | null, coverage: DimResult['coverage'], notes: string[] = []): DimResult {
  return { value, start, end, coverage, notes };
}

function seconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const delta = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function minIso(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => v !== null && Number.isFinite(Date.parse(v)));
  return present.length > 0 ? present.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

function maxIso(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => v !== null && Number.isFinite(Date.parse(v)));
  return present.length > 0 ? present.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/**
 * Split the task's session spend into cost buckets. A coding launch after the
 * first is a recode round, so its spend belongs to the review loop.
 */
export function computeCostBuckets(
  sessions: BaselineSession[],
  sharedSessionIds: ReadonlySet<string>,
): { buckets: CostBuckets; excluded: TaskDimensions['excludedSessions']; taskSessions: BaselineSession[] } {
  const buckets: CostBuckets = { authoring: 0, reviewLoop: 0, repairLoop: 0, unattributed: 0 };
  const excluded = { operator: 0, shared: 0, unpriced: 0, operatorUsd: 0, sharedUsd: 0 };
  const firstCodingLaunch = orderedLaunches(sessions, 'coding')[0] ?? null;
  const taskSessions: BaselineSession[] = [];
  for (const session of sessions) {
    const bucket = costBucketForKind(session.kind);
    if (bucket === 'operator') {
      excluded.operator++;
      excluded.operatorUsd += session.costUsd ?? 0;
      continue;
    }
    if (sharedSessionIds.has(session.sessionId)) {
      excluded.shared++;
      excluded.sharedUsd += session.costUsd ?? 0;
      continue;
    }
    taskSessions.push(session);
    if (session.costUsd === null) {
      excluded.unpriced++;
      continue;
    }
    const isRecode = session.kind === 'coding' && session.launchEvidence !== null && firstCodingLaunch !== null
      && session.launchEvidence !== firstCodingLaunch;
    buckets[isRecode ? 'reviewLoop' : bucket] += session.costUsd;
  }
  return { buckets, excluded, taskSessions };
}

/**
 * The moment the PR merged: lane `lastProgressAt` of a merged lane, else the
 * last `wm:merged` write, else GitHub `mergedAt` (operator merges bypass both).
 */
export function mergeAt(task: Pick<BaselineTask, 'lane' | 'labelEvents' | 'prState'>): string | null {
  if (task.lane?.lastEvent === 'merged' && task.lane.lastProgressAt) return task.lane.lastProgressAt;
  const merged = task.labelEvents.filter((e) => e.label === 'wm:merged' && e.action === 'labeled');
  if (merged.length > 0) return merged[merged.length - 1].at;
  return task.prState?.mergedAt ?? null;
}

/**
 * Intervals the PR held `wm:ready` — waiting for the merge executor. An
 * interval still open at the end closes at `fallbackEnd` (the merge) when known.
 */
export function readyIntervals(events: LabelEvent[], fallbackEnd: string | null): Array<{ start: string; end: string }> {
  const intervals: Array<{ start: string; end: string }> = [];
  let openAt: string | null = null;
  for (const event of events) {
    if (event.label !== 'wm:ready') continue;
    if (event.action === 'labeled' && openAt === null) openAt = event.at;
    else if (event.action === 'unlabeled' && openAt !== null) {
      intervals.push({ start: openAt, end: event.at });
      openAt = null;
    }
  }
  if (openAt !== null && fallbackEnd && Date.parse(fallbackEnd) >= Date.parse(openAt)) {
    intervals.push({ start: openAt, end: fallbackEnd });
  }
  return intervals;
}

/**
 * Queue wait: Σ time the PR held `wm:ready` (enqueued, waiting for the merge
 * executor). Time the PR spent blocked or merging is excluded by construction.
 */
export function computeQueueWait(task: Pick<BaselineTask, 'lane' | 'labelEvents' | 'prState'>): DimResult {
  if (task.labelEvents.length === 0) {
    return dim(null, null, null, 'missing', ['no label-ledger rows for this PR (ledger starts 2026-10-13)']);
  }
  const intervals = readyIntervals(task.labelEvents, mergeAt(task));
  if (intervals.length === 0) {
    return dim(null, null, null, 'missing', ['PR never held wm:ready in the ledger']);
  }
  const total = intervals.reduce((sum, i) => sum + (seconds(i.start, i.end) ?? 0), 0);
  return dim(total, intervals[0].start, intervals[intervals.length - 1].end, 'full', [
    `${intervals.length} wm:ready interval(s)`,
  ]);
}

/** CI compute minutes and critical path over the evaluated head's checks. */
export function computeCi(task: Pick<BaselineTask, 'ciChecks'>, ciUsdPerMinute: number): Pick<TaskDimensions, 'ciComputeMinutes' | 'ciCriticalPath' | 'ciCost'> {
  const timed = task.ciChecks.filter((c) => c.durationSeconds !== null);
  if (timed.length === 0) {
    const missing = dim(null, null, null, 'missing', ['no timed CI checks on the eval record']);
    return { ciComputeMinutes: missing, ciCriticalPath: missing, ciCost: missing };
  }
  const coverage = timed.length === task.ciChecks.length ? 'full' : 'partial';
  const notes = coverage === 'partial' ? [`${task.ciChecks.length - timed.length} check(s) without a duration`] : [];
  const totalSeconds = timed.reduce((sum, c) => sum + (c.durationSeconds ?? 0), 0);
  const minutes = totalSeconds / 60;
  const longest = Math.max(...timed.map((c) => c.durationSeconds ?? 0));
  return {
    ciComputeMinutes: dim(minutes, 'check startedAt', 'check completedAt', coverage, [...notes, 'evaluated PR head only']),
    ciCriticalPath: dim(longest, 'check startedAt', 'check completedAt', coverage, [...notes, 'longest single check']),
    ciCost: dim(minutes * ciUsdPerMinute, 'check startedAt', 'check completedAt', coverage, [
      ...notes,
      `${ciUsdPerMinute} USD/min list-price equivalent`,
    ]),
  };
}

/** Σ (last turn − first turn) over the given sessions. */
function sessionSpan(sessions: BaselineSession[]): DimResult {
  if (sessions.length === 0) return dim(0, null, null, 'full', ['no sessions']);
  const spans = sessions.map((s) => seconds(s.firstTurnAt, s.lastTurnAt));
  const known = spans.filter((s): s is number => s !== null);
  const coverage = known.length === spans.length ? 'full' : known.length > 0 ? 'partial' : 'missing';
  return dim(
    known.length > 0 ? known.reduce((a, b) => a + b, 0) : null,
    minIso(sessions.map((s) => s.firstTurnAt)),
    maxIso(sessions.map((s) => s.lastTurnAt)),
    coverage,
    [`${sessions.length} session(s)`],
  );
}

function phaseSum(task: Pick<BaselineTask, 'phaseDurations'>, phases: Array<'planning' | 'coding' | 'review'>, start: string, end: string): DimResult {
  const present = phases.filter((p) => task.phaseDurations[p] !== undefined);
  if (present.length === 0) return dim(null, start, end, 'missing', ['no phaseDurationsSeconds on the eval record']);
  const value = present.reduce((sum, p) => sum + (task.phaseDurations[p] ?? 0), 0);
  return dim(value, start, end, present.length === phases.length ? 'full' : 'partial', present.length === phases.length ? [] : [`missing ${phases.filter((p) => !present.includes(p)).join(', ')}`]);
}

/** Every dimension for one task. */
export function computeTaskDimensions(task: BaselineTask, ctx: DimensionContext): TaskDimensions {
  const { buckets, excluded, taskSessions } = computeCostBuckets(task.sessions, ctx.sharedSessionIds);
  const agentTotal = buckets.authoring + buckets.reviewLoop + buckets.repairLoop + buckets.unattributed;
  const firstTurn = minIso(taskSessions.map((s) => s.firstTurnAt));
  const lastTurn = maxIso(taskSessions.map((s) => s.lastTurnAt));
  const agentNotes: string[] = [];
  if (excluded.shared > 0) agentNotes.push(`${excluded.shared} session(s) shared with other tasks excluded`);
  if (excluded.unpriced > 0) agentNotes.push(`${excluded.unpriced} unpriced session(s)`);
  const agentCoverage = taskSessions.length === 0 ? 'missing' : excluded.unpriced > 0 || excluded.shared > 0 ? 'partial' : 'full';

  const merged = mergeAt(task);
  const lane = task.lane;
  return {
    costBuckets: buckets,
    agentCost: dim(taskSessions.length === 0 ? null : agentTotal, firstTurn, lastTurn, agentCoverage, agentNotes),
    ...computeCi(task, ctx.ciUsdPerMinute),
    authoringWallClock: phaseSum(task, ['planning', 'coding'], 'planning stage startedAt', 'coding stage finishedAt'),
    reviewWallClock: phaseSum(task, ['review'], 'review stage startedAt', 'review stage finishedAt'),
    repairWallClock: sessionSpan(taskSessions.filter((s) => costBucketForKind(s.kind) === 'repairLoop')),
    queueWait: computeQueueWait(task),
    mergeExecution: lane?.laneHoldSeconds != null
      ? dim(lane.laneHoldSeconds, lane.enteredLaneAt, lane.lastProgressAt, 'full')
      : dim(null, null, null, 'missing', ['no merge-lane progress for this PR']),
    endToEnd: firstTurn && merged
      ? dim(seconds(firstTurn, merged), firstTurn, merged, 'full')
      : dim(null, firstTurn, merged, 'missing', [!firstTurn ? 'no timed agent session' : 'merge time unknown']),
    reviewLoop: computeReviewLoop(task),
    integrationFailures: computeIntegrationFailures(task),
    excludedSessions: excluded,
  };
}
