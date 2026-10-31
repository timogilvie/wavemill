/**
 * Cohort aggregation and decision rules for the MQ-0.1 baseline (HOK-3336).
 *
 * Shares only use tasks where both the component and the denominator were
 * measured (`n` is reported with every share), so a task missing one source
 * cannot inflate or deflate another component's share. Cost shares are
 * ratio-of-sums (share of total spend); wall-clock shares are the mean of
 * per-task shares, because one long-lived task (weeks between first session
 * and merge) would otherwise decide every wall-clock share.
 *
 * @module cost-baseline/aggregator
 */

import { computeTaskDimensions, DEFAULT_CI_USD_PER_MINUTE, findSharedSessionIds } from './dimensions.ts';
import { computeQueueDepth, type QueueDepthResult } from './queue-depth.ts';
import type { BaselineTaskRow, BaselineWindow, CohortCounts, DimResult, LoadedBaseline, TaskDimensions } from './types.ts';

export interface Stats {
  n: number;
  missing: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  sum: number;
}

export interface ComponentShare {
  key: string;
  label: string;
  /** Boundary (or composition, for dollars) the component was measured over. */
  boundary: string;
  stats: Stats;
  /**
   * Over tasks where both are measured: Σ component / Σ denominator for cost,
   * mean of per-task component / denominator for wall-clock. Null when none.
   */
  share: number | null;
  shareN: number;
}

export interface DecisionRule {
  id: 'R1' | 'R2' | 'R3' | 'R4';
  title: string;
  fired: boolean;
  evidence: string[];
  recommendation: string;
}

export interface BaselineSummary {
  window: BaselineWindow;
  generatedFrom: { tasks: number; challengers: number };
  counts: CohortCounts;
  excludedSessions: { operator: number; shared: number; unpriced: number; operatorUsd: number; sharedUsd: number };
  ciUsdPerMinute: number;
  cost: { total: Stats; components: ComponentShare[] };
  /**
   * The same decomposition over tasks whose sessions are (nearly) all
   * stage-labelled — unattributed spend ≤ ATTRIBUTED_TASK_MAX_UNATTRIBUTED of
   * agent spend. The decision rules read this subset when it has at least
   * MIN_ATTRIBUTED_TASKS tasks, else the whole cohort.
   */
  attributedCost: { total: Stats; components: ComponentShare[] };
  /** Which cost decomposition the decision rules read. */
  ruleCostBasis: 'attributed' | 'cohort';
  wallClock: { endToEnd: Stats; components: ComponentShare[] };
  review: {
    rounds: Stats;
    roundsSource: Record<string, number>;
    reviewLaunches: Stats;
    recodeRounds: Stats;
    findings: { tasks: number; total: number; onChangedFiles: number; onUnchangedFiles: number; unresolvable: number };
  };
  integrationFailures: Record<string, Stats & { tasksWithAny: number }>;
  ci: { passRate: number | null; passRateN: number; computeMinutes: Stats };
  queueDepth: QueueDepthResult;
  decisionRules: DecisionRule[];
  coverage: Record<string, Record<string, number>>;
}

/** A task counts as stage-attributed when unattributed spend is at most this share of its agent spend. */
export const ATTRIBUTED_TASK_MAX_UNATTRIBUTED = 0.1;
/** Minimum attributed tasks before the decision rules prefer that subset. */
export const MIN_ATTRIBUTED_TASKS = 5;

/** Decision thresholds — stated in the report so a reader can re-decide. */
export const DECISION_THRESHOLDS = {
  queueDepthGt1Share: 0.1,
  queueWaitShareOfEndToEnd: 0.1,
  repairCostShare: 0.25,
  medianMergeAttempts: 1.5,
  reviewCostShare: 0.25,
  reviewRoundsP90: 3,
  reviewWallClockShare: 0.3,
  ciWallClockShare: 0.4,
  ciPassRate: 0.95,
} as const;

function percentile(sorted: number[], p: number): number {
  // Nearest-rank percentile.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** n / mean / median / p90 / max over the non-null values. */
export function summarize(values: Array<number | null | undefined>): Stats {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const sorted = [...present].sort((a, b) => a - b);
  const sum = present.reduce((a, b) => a + b, 0);
  const n = present.length;
  let median: number | null = null;
  if (n > 0) median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    missing: values.length - n,
    mean: n > 0 ? sum / n : null,
    median,
    p90: n > 0 ? percentile(sorted, 90) : null,
    max: n > 0 ? sorted[n - 1] : null,
    sum,
  };
}

/** Σ numerator / Σ denominator over the rows where both are present. */
export function ratioOfSums(pairs: Array<[number | null, number | null]>): { share: number | null; n: number } {
  let num = 0;
  let den = 0;
  let n = 0;
  for (const [a, b] of pairs) {
    if (a === null || b === null) continue;
    num += a;
    den += b;
    n++;
  }
  return { share: den > 0 ? num / den : null, n };
}

/** Mean of per-task a / b over the rows where both are present and b > 0. */
export function meanOfRatios(pairs: Array<[number | null, number | null]>): { share: number | null; n: number } {
  let total = 0;
  let n = 0;
  for (const [a, b] of pairs) {
    if (a === null || b === null || !(b > 0)) continue;
    total += a / b;
    n++;
  }
  return { share: n > 0 ? total / n : null, n };
}

function value(d: DimResult): number | null {
  return d.value;
}

/** Compute every task's dimensions. */
export function buildTaskRows(loaded: Pick<LoadedBaseline, 'tasks'>, ciUsdPerMinute = DEFAULT_CI_USD_PER_MINUTE): BaselineTaskRow[] {
  const sharedSessionIds = findSharedSessionIds(loaded.tasks);
  return loaded.tasks.map((task) => ({
    issueId: task.issueId,
    isChallenger: task.isChallenger,
    prNumber: task.prNumber,
    evalTimestamp: task.evalTimestamp,
    dimensions: computeTaskDimensions(task, { sharedSessionIds, ciUsdPerMinute }),
  }));
}

/** True when a task's unattributed spend is a small enough share for its decomposition to be trusted. */
export function isStageAttributed(d: TaskDimensions): boolean {
  const total = d.agentCost.value;
  return total !== null && total > 0 && d.costBuckets.unattributed <= ATTRIBUTED_TASK_MAX_UNATTRIBUTED * total;
}

function costComponents(rows: BaselineTaskRow[]): { total: Stats; components: ComponentShare[] } {
  const totalOf = (d: TaskDimensions) => (d.agentCost.value === null ? null : d.agentCost.value + (d.ciCost.value ?? 0));
  const totals = rows.map((r) => totalOf(r.dimensions));
  const defs: Array<{ key: string; label: string; boundary: string; pick: (d: TaskDimensions) => number | null }> = [
    { key: 'authoring', label: 'Agent tokens — authoring (planning + first coding launch)', boundary: 'Σ session cost, first → last turn of planning/coding/native/helper sessions', pick: (d) => (d.agentCost.value === null ? null : d.costBuckets.authoring) },
    { key: 'reviewLoop', label: 'Review loop (review sessions, review helpers, recode launches)', boundary: 'Σ session cost of review-kind sessions + coding launches after the first', pick: (d) => (d.agentCost.value === null ? null : d.costBuckets.reviewLoop) },
    { key: 'repairLoop', label: 'Repair loop (conflict resolution, Ready remediation, CI fix)', boundary: 'Σ session cost of repair-kind sessions', pick: (d) => (d.agentCost.value === null ? null : d.costBuckets.repairLoop) },
    { key: 'unattributed', label: 'Agent tokens — unattributed sessions', boundary: 'Σ session cost of sessions with no stage label (pre-launch-record era)', pick: (d) => (d.agentCost.value === null ? null : d.costBuckets.unattributed) },
    { key: 'ci', label: 'CI compute (list-price equivalent)', boundary: 'Σ check startedAt → completedAt on the evaluated head × rate', pick: (d) => value(d.ciCost) },
    { key: 'queueWait', label: 'Queue wait', boundary: 'latency only — no agent session is live while the PR waits ($0)', pick: (d) => (d.agentCost.value === null ? null : 0) },
  ];
  return {
    total: summarize(totals),
    components: defs.map((def) => {
      const picked = rows.map((r) => def.pick(r.dimensions));
      const { share, n } = ratioOfSums(rows.map((r, i) => [picked[i], totals[i]]));
      return { key: def.key, label: def.label, boundary: def.boundary, stats: summarize(picked), share, shareN: n };
    }),
  };
}

function wallClockComponents(rows: BaselineTaskRow[]): { endToEnd: Stats; components: ComponentShare[] } {
  const e2e = rows.map((r) => r.dimensions.endToEnd.value);
  const defs: Array<{ key: string; label: string; boundary: string; pick: (d: TaskDimensions) => DimResult }> = [
    { key: 'authoring', label: 'Agent authoring (planning + coding stages)', boundary: 'planning startedAt → finishedAt + coding startedAt → finishedAt', pick: (d) => d.authoringWallClock },
    { key: 'reviewLoop', label: 'Review loop (review stage, incl. in-stage fix passes)', boundary: 'review stage startedAt → finishedAt', pick: (d) => d.reviewWallClock },
    { key: 'repairLoop', label: 'Repair loop (repair sessions)', boundary: 'Σ repair session first turn → last turn', pick: (d) => d.repairWallClock },
    { key: 'ciCriticalPath', label: 'CI critical path (longest check)', boundary: 'check startedAt → completedAt, evaluated head', pick: (d) => d.ciCriticalPath },
    { key: 'queueWait', label: 'Queue wait (holding wm:ready)', boundary: 'Σ wm:ready labeled → unlabeled (or merge)', pick: (d) => d.queueWait },
    { key: 'mergeExecution', label: 'Merge execution (lane hold)', boundary: 'lane enteredLaneAt → lastProgressAt', pick: (d) => d.mergeExecution },
  ];
  return {
    endToEnd: summarize(e2e),
    components: defs.map((def) => {
      const picked = rows.map((r) => value(def.pick(r.dimensions)));
      const { share, n } = meanOfRatios(rows.map((r, i) => [picked[i], e2e[i]]));
      return { key: def.key, label: def.label, boundary: def.boundary, stats: summarize(picked), share, shareN: n };
    }),
  };
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function componentShare(components: ComponentShare[], key: string): number | null {
  return components.find((c) => c.key === key)?.share ?? null;
}

/** Evaluate the four HOK-3336 decision rules; several may fire. */
export function evaluateDecisionRules(input: {
  cost: { components: ComponentShare[] };
  wallClock: { components: ComponentShare[]; endToEnd: Stats };
  review: { rounds: Stats };
  integrationFailures: BaselineSummary['integrationFailures'];
  ci: { passRate: number | null };
  queueDepth: Pick<QueueDepthResult, 'ledger'>;
}): DecisionRule[] {
  const t = DECISION_THRESHOLDS;
  const depthGt1 = input.queueDepth.ledger.queued?.shareDepthGt1 ?? null;
  const queueShare = componentShare(input.wallClock.components, 'queueWait');
  const queueRarelyDeep = depthGt1 !== null && depthGt1 < t.queueDepthGt1Share;
  const queueSmallShare = queueShare !== null && queueShare < t.queueWaitShareOfEndToEnd;

  const repairShare = componentShare(input.cost.components, 'repairLoop');
  const repairWallShare = componentShare(input.wallClock.components, 'repairLoop');
  const failed = input.integrationFailures.failedMergeAttempts;
  // The median, not the mean: one pathological retry loop (165 attempts on one
  // PR, HOK-3316) would otherwise decide the rule for the whole cohort.
  const medianAttempts = failed?.median == null ? null : failed.median + 1;
  const meanAttempts = failed?.mean == null ? null : failed.mean + 1;

  const reviewCostShare = componentShare(input.cost.components, 'reviewLoop');
  const reviewWallShare = componentShare(input.wallClock.components, 'reviewLoop');
  // A p90 over a handful of tasks is noise; require the subset minimum.
  const roundsP90 = input.review.rounds.n >= MIN_ATTRIBUTED_TASKS ? input.review.rounds.p90 : null;

  const ciWallShare = componentShare(input.wallClock.components, 'ciCriticalPath');
  const ciCostShare = componentShare(input.cost.components, 'ci');

  return [
    {
      id: 'R1',
      title: 'Queue rarely >1 deep, or queue wait a small share',
      fired: queueRarelyDeep || queueSmallShare,
      evidence: [
        `time with >1 PR queued: ${pct(depthGt1)} (threshold < ${pct(t.queueDepthGt1Share)})`,
        `queue wait share of end-to-end wall-clock: ${pct(queueShare)} (threshold < ${pct(t.queueWaitShareOfEndToEnd)})`,
      ],
      recommendation: 'Defer Tend speculation epic steps T2–T6.',
    },
    {
      id: 'R2',
      title: 'Repair loops dominate',
      fired: (repairShare !== null && repairShare > t.repairCostShare)
        || (repairWallShare !== null && repairWallShare > t.repairCostShare)
        || (medianAttempts !== null && medianAttempts > t.medianMergeAttempts),
      evidence: [
        `repair-loop share of cost: ${pct(repairShare)} (threshold > ${pct(t.repairCostShare)})`,
        `repair-loop share of end-to-end wall-clock: ${pct(repairWallShare)} (threshold > ${pct(t.repairCostShare)})`,
        `median merge attempts per task: ${medianAttempts ?? 'n/a'} (threshold > ${t.medianMergeAttempts}); mean ${meanAttempts === null ? 'n/a' : meanAttempts.toFixed(2)}, max ${failed?.max == null ? 'n/a' : failed.max + 1}, tasks needing >1 attempt ${failed?.tasksWithAny ?? 'n/a'}/${failed?.n ?? 0}`,
      ],
      recommendation: 'Prioritise MQ-3.1 (rule-based recovery) over speculation.',
    },
    {
      id: 'R3',
      title: 'Review loops dominate',
      fired: (reviewCostShare !== null && reviewCostShare > t.reviewCostShare)
        || (roundsP90 !== null && roundsP90 > t.reviewRoundsP90)
        || (reviewWallShare !== null && reviewWallShare > t.reviewWallClockShare),
      evidence: [
        `review-loop share of cost: ${pct(reviewCostShare)} (threshold > ${pct(t.reviewCostShare)})`,
        `review rounds p90: ${input.review.rounds.p90 ?? 'n/a'} over ${input.review.rounds.n} task(s) (threshold > ${t.reviewRoundsP90}; needs n ≥ ${MIN_ATTRIBUTED_TASKS})`,
        `review-loop share of end-to-end wall-clock: ${pct(reviewWallShare)} (threshold > ${pct(t.reviewWallClockShare)})`,
      ],
      recommendation: 'Cap review rounds / limit re-review to the new diff before any queue work.',
    },
    {
      id: 'R4',
      title: 'CI compute on PRs that pass anyway dominates',
      fired: ciWallShare !== null && ciWallShare > t.ciWallClockShare && input.ci.passRate !== null && input.ci.passRate > t.ciPassRate,
      evidence: [
        `CI critical-path share of end-to-end wall-clock: ${pct(ciWallShare)} (threshold > ${pct(t.ciWallClockShare)})`,
        `CI pass rate on merged PRs' evaluated head: ${pct(input.ci.passRate)} (threshold > ${pct(t.ciPassRate)})`,
        `CI share of cost (list-price equivalent): ${pct(ciCostShare)}`,
      ],
      recommendation: 'Invest in CI scheduling / test selection (a wavemill feature), not a model.',
    },
  ];
}

function coverageCounts(rows: BaselineTaskRow[], pick: (d: TaskDimensions) => DimResult): Record<string, number> {
  const counts: Record<string, number> = { full: 0, partial: 0, missing: 0 };
  for (const row of rows) counts[pick(row.dimensions).coverage]++;
  return counts;
}

/** Aggregate a loaded baseline into the summary the report renders. */
export function aggregateBaseline(loaded: LoadedBaseline, ciUsdPerMinute = DEFAULT_CI_USD_PER_MINUTE): { rows: BaselineTaskRow[]; summary: BaselineSummary } {
  const rows = buildTaskRows(loaded, ciUsdPerMinute);
  const cost = costComponents(rows);
  const attributedRows = rows.filter((r) => isStageAttributed(r.dimensions));
  const attributedCost = costComponents(attributedRows);
  const ruleCostBasis = attributedRows.length >= MIN_ATTRIBUTED_TASKS ? 'attributed' : 'cohort';
  const wallClock = wallClockComponents(rows);

  const excludedSessions = { operator: 0, shared: 0, unpriced: 0, operatorUsd: 0, sharedUsd: 0 };
  const roundsSource: Record<string, number> = {};
  const findings = { tasks: 0, total: 0, onChangedFiles: 0, onUnchangedFiles: 0, unresolvable: 0 };
  for (const row of rows) {
    const d = row.dimensions;
    for (const key of Object.keys(excludedSessions) as Array<keyof typeof excludedSessions>) excludedSessions[key] += d.excludedSessions[key];
    roundsSource[d.reviewLoop.roundsSource] = (roundsSource[d.reviewLoop.roundsSource] ?? 0) + 1;
    if (d.reviewLoop.findings) {
      findings.tasks++;
      findings.total += d.reviewLoop.findings.total;
      findings.onChangedFiles += d.reviewLoop.findings.onChangedFiles;
      findings.onUnchangedFiles += d.reviewLoop.findings.onUnchangedFiles;
      findings.unresolvable += d.reviewLoop.findings.unresolvable;
    }
  }

  const failureKeys = [
    'failedMergeAttempts', 'ejections', 'rebases', 'ciRestarts', 'blockedAfterReady',
    'conflictResolutionLaunches', 'readyRemediationLaunches', 'ciFixLaunches',
  ] as const;
  const integrationFailures: BaselineSummary['integrationFailures'] = {};
  for (const key of failureKeys) {
    const values = rows.map((r) => r.dimensions.integrationFailures[key]);
    integrationFailures[key] = { ...summarize(values), tasksWithAny: values.filter((v) => (v ?? 0) > 0).length };
  }

  const ciKnown = loaded.tasks.filter((t) => t.ciPassed !== null);
  const ci = {
    passRate: ciKnown.length > 0 ? ciKnown.filter((t) => t.ciPassed).length / ciKnown.length : null,
    passRateN: ciKnown.length,
    computeMinutes: summarize(rows.map((r) => r.dimensions.ciComputeMinutes.value)),
  };
  const review = {
    rounds: summarize(rows.map((r) => r.dimensions.reviewLoop.rounds)),
    roundsSource,
    reviewLaunches: summarize(rows.map((r) => r.dimensions.reviewLoop.reviewLaunches)),
    recodeRounds: summarize(rows.map((r) => r.dimensions.reviewLoop.recodeRounds)),
    findings,
  };
  const queueDepth = computeQueueDepth(loaded.labelEvents, loaded.laneProgress, loaded.window, loaded.prStates);

  return {
    rows,
    summary: {
      window: loaded.window,
      generatedFrom: { tasks: rows.length, challengers: rows.filter((r) => r.isChallenger).length },
      counts: loaded.counts,
      excludedSessions,
      ciUsdPerMinute,
      cost,
      attributedCost,
      ruleCostBasis,
      wallClock,
      review,
      integrationFailures,
      ci,
      queueDepth,
      decisionRules: evaluateDecisionRules({ cost: ruleCostBasis === 'attributed' ? attributedCost : cost, wallClock, review, integrationFailures, ci, queueDepth }),
      coverage: {
        agentCost: coverageCounts(rows, (d) => d.agentCost),
        authoringWallClock: coverageCounts(rows, (d) => d.authoringWallClock),
        reviewWallClock: coverageCounts(rows, (d) => d.reviewWallClock),
        repairWallClock: coverageCounts(rows, (d) => d.repairWallClock),
        ciComputeMinutes: coverageCounts(rows, (d) => d.ciComputeMinutes),
        queueWait: coverageCounts(rows, (d) => d.queueWait),
        mergeExecution: coverageCounts(rows, (d) => d.mergeExecution),
        endToEnd: coverageCounts(rows, (d) => d.endToEnd),
      },
    },
  };
}
