import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  aggregateBaseline,
  evaluateDecisionRules,
  meanOfRatios,
  ratioOfSums,
  summarize,
  type ComponentShare,
  type Stats,
} from './aggregator.ts';
import { formatBaselineMarkdown, formatBaselineSummaryJson } from './report.ts';
import type { QueueDepthResult } from './queue-depth.ts';
import { label, lane, session, task } from './cost-baseline.fixtures.ts';
import type { LoadedBaseline } from './types.ts';

// protects: cohort statistics (nearest-rank p90, even-n median, nulls counted as missing)
test('summarize computes n, mean, median, p90 and max over present values', () => {
  const stats = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null, undefined]);
  assert.deepEqual(stats, { n: 10, missing: 2, mean: 5.5, median: 5.5, p90: 9, max: 10, sum: 55 });
  assert.deepEqual(summarize([]), { n: 0, missing: 0, mean: null, median: null, p90: null, max: null, sum: 0 });
});

// protects: shares mixing tasks where only one side was measured; one long task deciding a wall-clock share
test('ratioOfSums and meanOfRatios skip unpaired rows', () => {
  assert.deepEqual(ratioOfSums([[1, 4], [3, 4], [5, null], [null, 2]]), { share: 0.5, n: 2 });
  assert.deepEqual(meanOfRatios([[1, 2], [1, 100], [1, 0], [null, 3]]), { share: 0.255, n: 2 });
  assert.deepEqual(ratioOfSums([]), { share: null, n: 0 });
});

function stats(overrides: Partial<Stats> = {}): Stats {
  return { n: 10, missing: 0, mean: 0, median: 0, p90: 0, max: 0, sum: 0, ...overrides };
}

function share(key: string, value: number | null): ComponentShare {
  return { key, label: key, boundary: '', stats: stats(), share: value, shareN: 10 };
}

/** Inputs that fire no rule; each test perturbs one signal. */
function quietInputs() {
  const queueDepth: Pick<QueueDepthResult, 'ledger'> = {
    ledger: {
      coverageFrom: '2026-10-13T00:00:00Z',
      coverageTo: '2026-10-30T00:00:00Z',
      unterminatedPrs: [],
      prStatesFetched: true,
      queued: { from: '', to: '', totalSeconds: 100, secondsByDepth: [50, 30, 20], shareDepthGt0: 0.5, shareDepthGt1: 0.2, shareDepthGt2: 0, maxDepth: 2, meanDepthWhenNonEmpty: 1.4 },
      waiting: null,
      arrivals: null,
    },
  };
  return {
    cost: { components: [share('repairLoop', 0.05), share('reviewLoop', 0.1), share('ci', 0.01)] },
    wallClock: { components: [share('queueWait', 0.2), share('repairLoop', 0.01), share('reviewLoop', 0.1), share('ciCriticalPath', 0.05)], endToEnd: stats() },
    review: { rounds: stats({ p90: 2 }) },
    integrationFailures: { failedMergeAttempts: { ...stats({ median: 0, mean: 3, max: 164 }), tasksWithAny: 2 } },
    ci: { passRate: 0.99 },
    queueDepth,
  };
}

function firedIds(input: ReturnType<typeof quietInputs>): string[] {
  return evaluateDecisionRules(input).filter((r) => r.fired).map((r) => r.id);
}

// protects: a rule firing without its signal (the baseline's gate decision)
test('evaluateDecisionRules fires nothing on quiet inputs, even with an outlier mean', () => {
  assert.deepEqual(firedIds(quietInputs()), []);
});

// protects: R1 — queue rarely deep OR queue wait a small share
test('R1 fires on a shallow queue or on a small queue-wait share', () => {
  const shallow = quietInputs();
  shallow.queueDepth.ledger.queued!.shareDepthGt1 = 0.05;
  assert.deepEqual(firedIds(shallow), ['R1']);
  const smallWait = quietInputs();
  smallWait.wallClock.components[0] = share('queueWait', 0.05);
  assert.deepEqual(firedIds(smallWait), ['R1']);
  const noLedger = quietInputs();
  noLedger.queueDepth.ledger.queued = null;
  noLedger.wallClock.components[0] = share('queueWait', null);
  assert.deepEqual(firedIds(noLedger), []);
});

// protects: R2 — repair cost/time share or the typical task needing several merge attempts
test('R2 fires on repair share or median merge attempts', () => {
  const costly = quietInputs();
  costly.cost.components[0] = share('repairLoop', 0.3);
  assert.deepEqual(firedIds(costly), ['R2']);
  const retries = quietInputs();
  retries.integrationFailures.failedMergeAttempts.median = 1;
  assert.deepEqual(firedIds(retries), ['R2']);
});

// protects: R3 — review cost share, round p90 or review wall-clock share
test('R3 fires on any review-loop signal', () => {
  const costly = quietInputs();
  costly.cost.components[1] = share('reviewLoop', 0.3);
  assert.deepEqual(firedIds(costly), ['R3']);
  const rounds = quietInputs();
  rounds.review.rounds.p90 = 4;
  assert.deepEqual(firedIds(rounds), ['R3']);
  rounds.review.rounds.n = 4;
  assert.deepEqual(firedIds(rounds), [], 'a p90 over fewer than MIN_ATTRIBUTED_TASKS tasks is not evidence');
  const slow = quietInputs();
  slow.wallClock.components[2] = share('reviewLoop', 0.31);
  assert.deepEqual(firedIds(slow), ['R3']);
});

// protects: R4 — requires both a dominant CI share AND PRs that pass anyway
test('R4 fires only when CI dominates and passes', () => {
  const dominant = quietInputs();
  dominant.wallClock.components[3] = share('ciCriticalPath', 0.5);
  assert.deepEqual(firedIds(dominant), ['R4']);
  dominant.ci.passRate = 0.9;
  assert.deepEqual(firedIds(dominant), []);
});

// protects: several rules firing together being collapsed to one
test('multiple rules can fire together', () => {
  const input = quietInputs();
  input.queueDepth.ledger.queued!.shareDepthGt1 = 0;
  input.cost.components[0] = share('repairLoop', 0.4);
  input.review.rounds.p90 = 5;
  assert.deepEqual(firedIds(input), ['R1', 'R2', 'R3']);
});

function loadedFixture(): LoadedBaseline {
  const launch = 'launch coding@aaaaaaa#1793000000 at 2026-10-20T08:00:00.000Z';
  const attributedTask = (issueId: string, prNumber: number, hour: number) => task({
    issueId,
    prNumber,
    phaseDurations: { planning: 600, coding: 3000, review: 1200 },
    ciChecks: [{ name: 'unit', status: 'success', durationSeconds: 300 }],
    sessions: [
      session({ sessionId: `${issueId}-p`, kind: 'planning', costUsd: 2, firstTurnAt: `2026-10-20T${String(hour).padStart(2, '0')}:00:00.000Z`, lastTurnAt: `2026-10-20T${String(hour).padStart(2, '0')}:10:00.000Z` }),
      session({ sessionId: `${issueId}-c`, kind: 'coding', launchEvidence: launch, costUsd: 6 }),
      session({ sessionId: `${issueId}-r`, kind: 'review', costUsd: 2 }),
    ],
    lane: lane({ prNumber, lastEvent: 'merged', enteredLaneAt: `2026-10-20T${String(hour + 2).padStart(2, '0')}:00:00.000Z`, lastProgressAt: `2026-10-20T${String(hour + 2).padStart(2, '0')}:00:00.000Z`, laneHoldSeconds: 0, mergeAttemptCount: 1 }),
    labelEvents: [
      label(`2026-10-20T${String(hour + 1).padStart(2, '0')}:50:00.000Z`, 'wm:ready', 'labeled', prNumber),
      label(`2026-10-20T${String(hour + 2).padStart(2, '0')}:00:00.000Z`, 'wm:ready', 'unlabeled', prNumber),
    ],
  });
  const tasks = [1, 2, 3, 4, 5].map((n) => attributedTask(`HOK-${n}`, 100 + n, n * 3));
  tasks.push(task({ issueId: 'HOK-9', prNumber: 109, sessions: [session({ sessionId: 'u', kind: 'unattributed', costUsd: 90 })] }));
  return {
    window: { since: '2026-10-20T00:00:00.000Z', until: '2026-10-21T00:00:00.000Z' },
    tasks,
    counts: { evalRowsInWindow: 6, mergedRows: 6, duplicateRowsCollapsed: 0, malformedLines: 0, tombstonesByOutcome: { merged: 6 } },
    labelEvents: tasks.flatMap((t) => t.labelEvents),
    laneProgress: tasks.flatMap((t) => (t.lane ? [t.lane] : [])),
    prStates: new Map(),
  };
}

// protects: the end-to-end aggregation — attributed subset used for rules, shares and report wiring
test('aggregateBaseline decomposes cost, prefers the attributed subset and renders the outcome', () => {
  const { rows, summary } = aggregateBaseline(loadedFixture(), 0.01);
  assert.equal(rows.length, 6);
  assert.equal(summary.ruleCostBasis, 'attributed');
  assert.equal(summary.attributedCost.total.n, 5);
  const attributed = Object.fromEntries(summary.attributedCost.components.map((c) => [c.key, c.share]));
  // Per attributed task: authoring 8, review 2, CI 5 min × 0.01 = 0.05 → total 10.05.
  assert.ok(Math.abs((attributed.authoring ?? 0) - 8 / 10.05) < 1e-9);
  assert.ok(Math.abs((attributed.reviewLoop ?? 0) - 2 / 10.05) < 1e-9);
  assert.equal(attributed.queueWait, 0);
  const cohort = Object.fromEntries(summary.cost.components.map((c) => [c.key, c.share]));
  assert.ok((cohort.unattributed ?? 0) > 0.6, 'the unattributed task dominates the whole-cohort view');
  // Queue: 10 minutes of a 2-hour end-to-end per task.
  const queueWait = summary.wallClock.components.find((c) => c.key === 'queueWait');
  assert.equal(queueWait?.stats.median, 600);
  assert.ok(Math.abs((queueWait?.share ?? 0) - 600 / 7200) < 1e-9);
  assert.equal(summary.queueDepth.ledger.queued?.maxDepth, 1);
  const fired = summary.decisionRules.filter((r) => r.fired).map((r) => r.id);
  assert.deepEqual(fired, ['R1']);

  const markdown = formatBaselineMarkdown(summary);
  assert.match(markdown, /\*\*Fired: R1\.\*\*/);
  assert.match(markdown, /Queue wait is \*\*not a dollar cost\*\*/);
  assert.match(markdown, /## Known gaps/);
  assert.equal(formatBaselineSummaryJson(summary), formatBaselineSummaryJson(aggregateBaseline(loadedFixture(), 0.01).summary), 'summary is deterministic');
});
