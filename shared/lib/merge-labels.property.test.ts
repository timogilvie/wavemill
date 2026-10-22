/**
 * HOK-3230 property-based tests for `deriveMergeLabel` and
 * `reconcileMergeLabelsForPr`.
 *
 * Pins the HOK-3181 invariants:
 *   - `deriveMergeLabel` is a pure function of (task, pr, liveState).
 *   - Every decision resolves to one of `wm:ready | wm:blocked | null`.
 *   - `reconcileMergeLabelsForPr` converges to the derived label in one tick
 *     (never two: no `wm:ready` and `wm:blocked` on the same PR after a run).
 *   - Reconciling twice equals reconciling once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  deriveMergeLabel,
  reconcileMergeLabelsForPr,
  type MergeLabelTaskView,
  type MergeLabelLiveState,
  type ReconcileMergeLabelsDeps,
} from './merge-labels.ts';
import { assertPropertyAsync, assertProperty } from './fast-check-utils.ts';
import {
  arbitraryHexSha,
  arbitraryMergeable,
  arbitraryMergeStateStatus,
  arbitraryReadyAtHead,
  arbitraryHandoffAtHead,
  arbitraryStatusCheckRollup,
  arbitraryPrLabels,
} from './property-generators.ts';

interface Scenario {
  task: MergeLabelTaskView;
  pr: { number: number; labels: string[]; headSha: string };
  liveState: MergeLabelLiveState;
}

/**
 * One generator that produces a complete (task, pr, liveState) scenario.
 * The PR number is anchored at a small positive integer so we can tell
 * fixtures apart in a counter-example without inflating the shrink space.
 */
function arbitraryScenario(): fc.Arbitrary<Scenario> {
  return fc
    .record({
      prNumber: fc.integer({ min: 1, max: 999 }),
      taskHead: arbitraryHexSha(7),
      // Independent-head coin flip: 75% of generated scenarios have the PR
      // head equal to the task head so rules 2–8 are exercised; 25% diverge
      // so rule 1 (head-mismatch) is still sampled.
      headMatchesTask: fc.integer({ min: 0, max: 3 }),
      divergentPrHead: arbitraryHexSha(7),
      mergeable: arbitraryMergeable(),
      mergeStateStatus: arbitraryMergeStateStatus(),
      rollup: arbitraryStatusCheckRollup(),
      labels: arbitraryPrLabels(),
      challengeRole: fc.oneof(
        fc.constant<'primary' | 'challenger' | undefined>(undefined),
        fc.constant<'primary' | 'challenger' | undefined>('primary'),
        fc.constant<'primary' | 'challenger' | undefined>('challenger'),
      ),
    })
    .chain((base) => {
      const prHead = base.headMatchesTask === 0 ? base.divergentPrHead : base.taskHead;
      return fc
        .record({
          readyAtHead: arbitraryReadyAtHead(prHead),
          handoffAtHead: arbitraryHandoffAtHead(prHead, base.prNumber),
        })
        .map(({ readyAtHead, handoffAtHead }) => ({
          task: {
            prNumber: base.prNumber,
            headSha: base.taskHead,
            phase: 'ready',
            challengeRole: base.challengeRole,
            featureDir: `/tmp/feat-${base.prNumber}`,
          } satisfies MergeLabelTaskView,
          pr: {
            number: base.prNumber,
            labels: base.labels,
            headSha: prHead,
          },
          liveState: {
            prHeadSha: prHead,
            mergeable: base.mergeable,
            mergeStateStatus: base.mergeStateStatus,
            statusCheckRollup: base.rollup,
            readyAtHead,
            handoffAtHead,
          } satisfies MergeLabelLiveState,
        }));
    });
}

/** All of the labels wm:ready / wm:blocked / `null`. */
const VALID_LABELS: ReadonlySet<string | null> = new Set(['wm:ready', 'wm:blocked', null]);

test('P1: deriveMergeLabel is a pure function (same args → same decision)', () => {
  assertProperty(
    fc.property(arbitraryScenario(), ({ task, pr, liveState }) => {
      const a = deriveMergeLabel(task, pr, liveState);
      const b = deriveMergeLabel(task, pr, liveState);
      assert.deepEqual(a, b, 'deriveMergeLabel must be deterministic');
    }),
    { name: 'P1 purity', numRuns: 300 },
  );
});

test('P2: deriveMergeLabel is total — label is always wm:ready | wm:blocked | null', () => {
  assertProperty(
    fc.property(arbitraryScenario(), ({ task, pr, liveState }) => {
      const d = deriveMergeLabel(task, pr, liveState);
      assert.ok(
        VALID_LABELS.has(d.label),
        `label must be in {'wm:ready','wm:blocked',null}, got ${JSON.stringify(d.label)}`,
      );
      if (d.label === 'wm:blocked') {
        assert.ok(d.reason && d.reason.length > 0, 'wm:blocked decisions must carry a non-empty reason');
      }
    }),
    { name: 'P2 totality', numRuns: 300 },
  );
});

test('coverage: documented rule branches are each hit at least once', () => {
  // Combines the random generator with a few hand-crafted happy-path
  // scenarios. The random stream covers rules 1–6 and 8 (the labelled
  // dead ends); rule 7 (wm:ready) requires all preconditions to align
  // and is reached deterministically here.
  const sha = 'abc1234';
  const happyPath: Scenario = {
    task: { prNumber: 42, headSha: sha, phase: 'ready', featureDir: '/tmp/feat-42' },
    pr: { number: 42, labels: [], headSha: sha },
    liveState: {
      prHeadSha: sha,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      readyAtHead: { verdict: 'ready', sha },
      handoffAtHead: { state: 'ready-published', headSha: sha, prNumber: 42 },
    },
  };
  const checksPending: Scenario = {
    ...happyPath,
    liveState: {
      ...happyPath.liveState,
      statusCheckRollup: [{ name: 'ci', conclusion: '', status: 'IN_PROGRESS' }],
    },
  };
  const seen = new Set<string>();
  for (const scen of [happyPath, checksPending]) {
    const d = deriveMergeLabel(scen.task, scen.pr, scen.liveState);
    seen.add(`${d.label ?? 'null'}:${d.reason ?? ''}`);
  }
  const samples = fc.sample(arbitraryScenario(), { numRuns: 500, seed: 0x30303017 });
  for (const scen of samples) {
    const d = deriveMergeLabel(scen.task, scen.pr, scen.liveState);
    seen.add(`${d.label ?? 'null'}:${d.reason ?? ''}`);
  }
  const expectedReasons = [
    'null:head-mismatch',
    'null:ready-evidence-stale',
    'wm:blocked:ready-errored',
    'wm:blocked:ready-not-ready',
    'null:ready-pending',
    'wm:ready:',
    'null:checks-pending',
    'null:no-handoff',
  ];
  for (const want of expectedReasons) {
    assert.ok(seen.has(want), `expected to see decision "${want}" at least once; saw ${JSON.stringify([...seen])}`);
  }
});

function makeDeps(
  task: MergeLabelTaskView,
  liveState: MergeLabelLiveState,
): ReconcileMergeLabelsDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    readTaskView: async () => task,
    probeLiveState: async () => liveState,
    applyLabel: {
      setReady: async (pr) => { calls.push(`setReady:${pr}`); },
      setBlocked: async (pr, reason) => { calls.push(`setBlocked:${pr}:${reason}`); },
      clear: async (pr) => { calls.push(`clear:${pr}`); },
    },
    logger: {
      info: () => {},
      warn: () => {},
    },
    calls,
  };
}

test('P3: reconcileMergeLabelsForPr converges to deriveMergeLabel in one tick', async () => {
  await assertPropertyAsync(
    fc.asyncProperty(arbitraryScenario(), async ({ task, pr, liveState }) => {
      const expected = deriveMergeLabel(task, pr, liveState);
      const deps = makeDeps(task, liveState);
      const result = await reconcileMergeLabelsForPr(pr, deps);
      assert.deepEqual(
        result.decision,
        expected,
        'reconciler must surface the derived decision verbatim',
      );
      const updatedSet = new Set(result.updatedLabels);
      // Never both labels at once.
      assert.ok(
        !(updatedSet.has('wm:ready') && updatedSet.has('wm:blocked')),
        `updated labels must never carry both wm:ready and wm:blocked: ${JSON.stringify(result.updatedLabels)}`,
      );
      // The target label is present iff the decision picked one.
      if (expected.label === 'wm:ready') {
        assert.ok(updatedSet.has('wm:ready'), 'wm:ready must land after convergence');
        assert.ok(!updatedSet.has('wm:blocked'), 'wm:blocked must not persist after convergence to ready');
      } else if (expected.label === 'wm:blocked') {
        assert.ok(updatedSet.has('wm:blocked'), 'wm:blocked must land after convergence');
        assert.ok(!updatedSet.has('wm:ready'), 'wm:ready must not persist after convergence to blocked');
      } else {
        assert.ok(!updatedSet.has('wm:ready'), 'wm:ready must be cleared under a null decision');
        assert.ok(!updatedSet.has('wm:blocked'), 'wm:blocked must be cleared under a null decision');
      }
      // Non-wavemill labels are preserved as a set.
      const originalNoise = new Set(pr.labels.filter((l) => l !== 'wm:ready' && l !== 'wm:blocked'));
      for (const noise of originalNoise) {
        assert.ok(
          updatedSet.has(noise),
          `non-wavemill label ${noise} must be preserved`,
        );
      }
    }),
    { name: 'P3 one-tick convergence', numRuns: 150 },
  );
});

test('P4: reconcileMergeLabelsForPr is idempotent (second run is a no-op)', async () => {
  await assertPropertyAsync(
    fc.asyncProperty(arbitraryScenario(), async ({ task, pr, liveState }) => {
      const deps1 = makeDeps(task, liveState);
      const r1 = await reconcileMergeLabelsForPr(pr, deps1);
      // Second call starts from r1.updatedLabels — modelling the next tick.
      const pr2 = { number: pr.number, labels: [...r1.updatedLabels], headSha: pr.headSha };
      const deps2 = makeDeps(task, liveState);
      const r2 = await reconcileMergeLabelsForPr(pr2, deps2);
      assert.deepEqual(
        r2.decision,
        r1.decision,
        'the second tick must emit the same decision',
      );
      assert.deepEqual(
        new Set(r2.updatedLabels),
        new Set(r1.updatedLabels),
        'the second tick must leave labels unchanged as a set',
      );
      assert.deepEqual(
        deps2.calls,
        [],
        `the second tick must not call any applyLabel.* method; got ${JSON.stringify(deps2.calls)}`,
      );
    }),
    { name: 'P4 idempotent reconcile', numRuns: 100 },
  );
});
