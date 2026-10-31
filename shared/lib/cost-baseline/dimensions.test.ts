import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeCi,
  computeCostBuckets,
  computeQueueWait,
  computeTaskDimensions,
  costBucketForKind,
  findSharedSessionIds,
  mergeAt,
} from './dimensions.ts';
import { label, lane, session, task } from './cost-baseline.fixtures.ts';

const CODING_A = 'launch coding@aaaaaaa#1793000000 at 2026-10-20T08:00:00.000Z';
const CODING_B = 'launch coding@bbbbbbb#1793009000 at 2026-10-20T10:30:00.000Z';

// protects: a session landing in the wrong bucket (repair counted as review,
// operator or shared sessions counted as task spend, a recode launch counted as authoring)
test('computeCostBuckets splits spend by ownership kind and treats later coding launches as recode', () => {
  const sessions = [
    session({ sessionId: 'p', kind: 'planning', costUsd: 2 }),
    session({ sessionId: 'c1', kind: 'coding', launchEvidence: CODING_A, costUsd: 6 }),
    session({ sessionId: 'c2', kind: 'coding', launchEvidence: CODING_A, costUsd: 4 }),
    session({ sessionId: 'c3', kind: 'coding', launchEvidence: CODING_B, costUsd: 3 }),
    session({ sessionId: 'r', kind: 'review', costUsd: 1 }),
    session({ sessionId: 'h', kind: 'helper:json-code-review', costUsd: 0.5 }),
    session({ sessionId: 'x', kind: 'conflict-resolution', costUsd: 0.7 }),
    session({ sessionId: 'o', kind: 'operator', costUsd: 9 }),
    session({ sessionId: 'u', kind: 'unattributed', costUsd: 1.5 }),
    session({ sessionId: 's', kind: 'coding', costUsd: 5 }),
    session({ sessionId: 'n', kind: 'review', costUsd: null }),
  ];
  const { buckets, excluded } = computeCostBuckets(sessions, new Set(['s']));
  assert.deepEqual(buckets, { authoring: 12, reviewLoop: 4.5, repairLoop: 0.7, unattributed: 1.5 });
  assert.deepEqual(excluded, { operator: 1, shared: 1, unpriced: 1, operatorUsd: 9, sharedUsd: 5 });
});

// protects: a misclassified ownership kind silently moving spend between components
test('costBucketForKind maps every ownership kind', () => {
  assert.equal(costBucketForKind('planning'), 'authoring');
  assert.equal(costBucketForKind('native-arm'), 'authoring');
  assert.equal(costBucketForKind('helper:expand'), 'authoring');
  assert.equal(costBucketForKind('helper:json-code-review'), 'reviewLoop');
  assert.equal(costBucketForKind('ready-remediation'), 'repairLoop');
  assert.equal(costBucketForKind('ci-fix'), 'repairLoop');
  assert.equal(costBucketForKind('operator'), 'operator');
  assert.equal(costBucketForKind('something-new'), 'unattributed');
});

// protects: a session shared by several tasks (HOK-3256 pool) charged to each of them
test('findSharedSessionIds returns only ids present on more than one task', () => {
  const shared = findSharedSessionIds([
    { sessions: [session({ sessionId: 'a' }), session({ sessionId: 'a' }), session({ sessionId: 'b' })] },
    { sessions: [session({ sessionId: 'b' }), session({ sessionId: 'c' })] },
  ]);
  assert.deepEqual([...shared], ['b']);
});

// protects: HOK-2895 — queue wait absorbing blocked time; it must count only wm:ready holding
test('computeQueueWait sums wm:ready intervals and excludes the blocked gap', () => {
  const result = computeQueueWait(task({
    labelEvents: [
      label('2026-10-20T10:00:00.000Z', 'wm:ready', 'labeled'),
      label('2026-10-20T10:05:00.000Z', 'wm:ready', 'unlabeled'),
      label('2026-10-20T10:05:01.000Z', 'wm:blocked', 'labeled'),
      label('2026-10-20T11:00:00.000Z', 'wm:ready', 'labeled'),
      label('2026-10-20T11:10:00.000Z', 'wm:ready', 'unlabeled'),
      label('2026-10-20T11:10:01.000Z', 'wm:merging', 'labeled'),
    ],
  }));
  assert.equal(result.value, 900);
  assert.equal(result.start, '2026-10-20T10:00:00.000Z');
  assert.equal(result.end, '2026-10-20T11:10:00.000Z');
  assert.equal(result.coverage, 'full');
});

// protects: a wm:ready label left on a merged PR counting as queue wait forever
test('computeQueueWait closes a still-open wm:ready interval at the merge', () => {
  const result = computeQueueWait(task({
    labelEvents: [label('2026-10-20T10:00:00.000Z', 'wm:ready', 'labeled')],
    lane: lane({ lastEvent: 'merged', lastProgressAt: '2026-10-20T10:30:00.000Z' }),
  }));
  assert.equal(result.value, 1800);
});

// protects: tasks predating the label ledger being reported as zero wait instead of missing
test('computeQueueWait is missing without ledger rows', () => {
  const result = computeQueueWait(task());
  assert.equal(result.value, null);
  assert.equal(result.coverage, 'missing');
});

// protects: CI minutes/critical path/price math and partial coverage when a check has no duration
test('computeCi derives compute minutes, critical path and list-price cost', () => {
  const ci = computeCi(task({
    ciChecks: [
      { name: 'a', status: 'success', durationSeconds: 60 },
      { name: 'b', status: 'success', durationSeconds: 120 },
      { name: 'c', status: 'success', durationSeconds: null },
    ],
  }), 0.01);
  assert.equal(ci.ciComputeMinutes.value, 3);
  assert.equal(ci.ciCriticalPath.value, 120);
  assert.ok(Math.abs((ci.ciCost.value ?? 0) - 0.03) < 1e-12);
  assert.equal(ci.ciComputeMinutes.coverage, 'partial');
  assert.equal(computeCi(task(), 0.01).ciCost.coverage, 'missing');
});

// protects: merge time falling back in the wrong order, or an operator merge yielding no end boundary
test('mergeAt prefers the merged lane, then wm:merged, then GitHub mergedAt', () => {
  const merged = label('2026-10-20T12:05:00.000Z', 'wm:merged', 'labeled');
  const gh = { prNumber: 100, state: 'MERGED' as const, mergedAt: '2026-10-20T12:09:00Z', closedAt: '2026-10-20T12:09:00Z' };
  assert.equal(mergeAt(task({ lane: lane({ lastEvent: 'merged', lastProgressAt: '2026-10-20T12:00:00.000Z' }), labelEvents: [merged], prState: gh })), '2026-10-20T12:00:00.000Z');
  assert.equal(mergeAt(task({ lane: lane({ lastEvent: 'ci-restart', lastProgressAt: '2026-10-20T11:00:00.000Z' }), labelEvents: [merged], prState: gh })), '2026-10-20T12:05:00.000Z');
  assert.equal(mergeAt(task({ prState: gh })), '2026-10-20T12:09:00Z');
  assert.equal(mergeAt(task()), null);
});

// protects: end-to-end/authoring/repair boundaries drifting from the stated ones
test('computeTaskDimensions propagates explicit boundaries', () => {
  const d = computeTaskDimensions(task({
    phaseDurations: { planning: 600, coding: 3000 },
    sessions: [
      session({ sessionId: 'p', kind: 'planning', costUsd: 1, firstTurnAt: '2026-10-20T08:00:00.000Z', lastTurnAt: '2026-10-20T08:10:00.000Z' }),
      session({ sessionId: 'x', kind: 'ready-remediation', costUsd: 1, firstTurnAt: '2026-10-20T11:00:00.000Z', lastTurnAt: '2026-10-20T11:20:00.000Z' }),
    ],
    lane: lane({ lastEvent: 'merged', enteredLaneAt: '2026-10-20T11:58:00.000Z', lastProgressAt: '2026-10-20T12:00:00.000Z', laneHoldSeconds: 120 }),
  }), { sharedSessionIds: new Set(), ciUsdPerMinute: 0.008 });
  assert.deepEqual([d.endToEnd.value, d.endToEnd.start, d.endToEnd.end], [14400, '2026-10-20T08:00:00.000Z', '2026-10-20T12:00:00.000Z']);
  assert.deepEqual([d.authoringWallClock.value, d.authoringWallClock.coverage], [3600, 'full']);
  assert.equal(d.reviewWallClock.coverage, 'missing');
  assert.deepEqual([d.repairWallClock.value, d.repairWallClock.start, d.repairWallClock.end], [1200, '2026-10-20T11:00:00.000Z', '2026-10-20T11:20:00.000Z']);
  assert.deepEqual([d.mergeExecution.value, d.mergeExecution.start], [120, '2026-10-20T11:58:00.000Z']);
  assert.deepEqual([d.agentCost.value, d.agentCost.coverage], [2, 'full']);
});

// protects: a task with no measured sessions reported as $0 instead of missing
test('computeTaskDimensions reports agent cost as missing without sessions', () => {
  const d = computeTaskDimensions(task(), { sharedSessionIds: new Set(), ciUsdPerMinute: 0.008 });
  assert.equal(d.agentCost.value, null);
  assert.equal(d.agentCost.coverage, 'missing');
  assert.equal(d.endToEnd.coverage, 'missing');
});
