import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveMergeLabel,
  reconcileMergeLabelsForPr,
  type MergeLabelTaskView,
  type MergeLabelLiveState,
  type MergeLabelDecision,
  type ReconcileMergeLabelsDeps,
} from './merge-labels.ts';

describe('deriveMergeLabel', () => {
  const baseTask: MergeLabelTaskView = {
    prNumber: 123,
    headSha: 'abc123',
    phase: 'ready',
    featureDir: '/path/to/feature',
  };

  const basePr = {
    number: 123,
    labels: [] as string[],
    headSha: 'abc123',
  };

  const baseLiveState: MergeLabelLiveState = {
    prHeadSha: 'abc123',
    mergeable: 'MERGEABLE' as const,
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ],
    readyAtHead: {
      verdict: 'ready' as const,
      sha: 'abc123',
    },
    handoffAtHead: {
      state: 'ready-published' as const,
      headSha: 'abc123',
      prNumber: 123,
    },
  };

  describe('Rule 1: Live PR head ≠ task head', () => {
    it('returns null when PR head does not match task head', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        prHeadSha: 'different',
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'head-mismatch' });
    });

    it('proceeds when heads match', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.equal(result.label, 'wm:ready');
    });
  });

  describe('Rule 2: Live PR head ≠ readyAtHead.sha', () => {
    it('returns null when readyAtHead is for a different head', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        readyAtHead: {
          verdict: 'ready',
          sha: 'old-sha',
        },
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'ready-evidence-stale' });
    });

    it('proceeds when readyAtHead matches PR head', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.equal(result.label, 'wm:ready');
    });
  });

  describe('Rule 3: Ready verdict is errored or not-ready', () => {
    it('returns wm:blocked when ready verdict is errored', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        readyAtHead: {
          verdict: 'errored',
          sha: 'abc123',
        },
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'ready-errored' });
    });

    it('returns wm:blocked when ready verdict is not-ready', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        readyAtHead: {
          verdict: 'not-ready',
          sha: 'abc123',
        },
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'ready-not-ready' });
    });

    it('proceeds when ready verdict is ready', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.equal(result.label, 'wm:ready');
    });
  });

  describe('Rule 4: Ready verdict is running or missing', () => {
    it('returns null when ready verdict is running', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        readyAtHead: {
          verdict: 'running',
          sha: 'abc123',
        },
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'ready-pending' });
    });

    it('returns null when readyAtHead is missing', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        readyAtHead: undefined,
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'ready-pending' });
    });

    it('proceeds when ready verdict is ready', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.equal(result.label, 'wm:ready');
    });
  });

  describe('Rule 5: Ready is ready but merge state or CI is blocked', () => {
    it('returns wm:blocked when mergeStateStatus is BLOCKED', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        mergeStateStatus: 'BLOCKED',
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'merge-state-blocked' });
    });

    it('returns wm:blocked when mergeStateStatus is DIRTY', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        mergeStateStatus: 'DIRTY',
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'merge-state-dirty' });
    });

    it('returns wm:blocked when mergeStateStatus is UNKNOWN', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        mergeStateStatus: 'UNKNOWN',
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'merge-state-unknown' });
    });

    it('returns wm:blocked when mergeable is CONFLICTING', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        mergeable: 'CONFLICTING',
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'merge-conflict' });
    });

    it('returns wm:blocked when mergeable is UNKNOWN', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        mergeable: 'UNKNOWN',
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'mergeable-unknown' });
    });

    it('returns wm:blocked when any check has FAILURE conclusion', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'ci-failing' });
    });

    it('returns wm:blocked when any check is CANCELLED', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: 'CANCELLED', status: 'COMPLETED' },
        ],
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'ci-failing' });
    });

    it('returns wm:blocked when any check is TIMED_OUT', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: 'TIMED_OUT', status: 'COMPLETED' },
        ],
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'ci-failing' });
    });

    it('proceeds when all checks are successful', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.equal(result.label, 'wm:ready');
    });
  });

  describe('Rule 6: Ready is ready but checks still pending', () => {
    it('returns null when any check is not COMPLETED', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { name: 'lint', conclusion: '', status: 'IN_PROGRESS' },
        ],
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'checks-pending' });
    });

    it('proceeds when all checks are completed', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.equal(result.label, 'wm:ready');
    });
  });

  describe('Rule 7: Ready is ready, all green, handoff exists', () => {
    it('returns wm:ready when all conditions met', () => {
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.deepEqual(result, { label: 'wm:ready' });
    });

    it('returns null when handoff is missing', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        handoffAtHead: undefined,
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'no-handoff' });
    });

    it('returns null when handoff is at different head', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        handoffAtHead: {
          state: 'ready-published',
          headSha: 'old-sha',
          prNumber: 123,
        },
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'no-handoff' });
    });
  });

  describe('Rule 8: Fallthrough', () => {
    it('returns null when mergeable but no handoff', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        handoffAtHead: undefined,
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'no-handoff' });
    });
  });

  describe('Acceptance fixtures', () => {
    it('Fixture 1: stale wm:blocked on green PR whose Ready passed → derives wm:ready', () => {
      const pr = { ...basePr, labels: ['wm:blocked'] };
      const result = deriveMergeLabel(baseTask, pr, baseLiveState);
      assert.deepEqual(result, { label: 'wm:ready' });
    });

    it('Fixture 2: wm:ready on PR whose checks went red → derives wm:blocked', () => {
      const pr = { ...basePr, labels: ['wm:ready'] };
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      };
      const result = deriveMergeLabel(baseTask, pr, liveState);
      assert.deepEqual(result, { label: 'wm:blocked', reason: 'ci-failing' });
    });

    it('Fixture 3: handoff at old head after update-branch → derives null', () => {
      const task = { ...baseTask, headSha: 'new-sha' };
      const pr = { ...basePr, headSha: 'new-sha' };
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        prHeadSha: 'new-sha',
        readyAtHead: {
          verdict: 'ready',
          sha: 'new-sha',
        },
        handoffAtHead: {
          state: 'ready-published',
          headSha: 'old-sha',
          prNumber: 123,
        },
      };
      const result = deriveMergeLabel(task, pr, liveState);
      assert.deepEqual(result, { label: null, reason: 'no-handoff' });
    });
  });

  describe('Edge cases', () => {
    it('MERGEABLE with pending check → null', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: '', status: 'QUEUED' },
        ],
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'checks-pending' });
    });

    it('CLEAN with no handoff → null', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        handoffAtHead: undefined,
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'no-handoff' });
    });

    it('CLEAN with handoff at wrong head → null', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        handoffAtHead: {
          state: 'ready-published',
          headSha: 'wrong-head',
          prNumber: 123,
        },
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: null, reason: 'no-handoff' });
    });

    it('Transient failure: ready errored reclassifies to ready on next tick', () => {
      // First tick: errored
      const erroredState: MergeLabelLiveState = {
        ...baseLiveState,
        readyAtHead: {
          verdict: 'errored',
          sha: 'abc123',
        },
      };
      const erroredResult = deriveMergeLabel(baseTask, basePr, erroredState);
      assert.deepEqual(erroredResult, { label: 'wm:blocked', reason: 'ready-errored' });

      // Next tick: ready
      const result = deriveMergeLabel(baseTask, basePr, baseLiveState);
      assert.deepEqual(result, { label: 'wm:ready' });
    });

    it('Empty statusCheckRollup is considered all checks completed', () => {
      const liveState: MergeLabelLiveState = {
        ...baseLiveState,
        statusCheckRollup: [],
      };
      const result = deriveMergeLabel(baseTask, basePr, liveState);
      assert.deepEqual(result, { label: 'wm:ready' });
    });
  });
});

describe('reconcileMergeLabelsForPr', () => {
  const baseTask: MergeLabelTaskView = {
    prNumber: 123,
    headSha: 'abc123',
    phase: 'ready',
    featureDir: '/path/to/feature',
  };

  const baseLiveState: MergeLabelLiveState = {
    prHeadSha: 'abc123',
    mergeable: 'MERGEABLE' as const,
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ],
    readyAtHead: {
      verdict: 'ready' as const,
      sha: 'abc123',
    },
    handoffAtHead: {
      state: 'ready-published' as const,
      headSha: 'abc123',
      prNumber: 123,
    },
  };

  function createMockDeps(overrides?: Partial<ReconcileMergeLabelsDeps>): ReconcileMergeLabelsDeps {
    return {
      readTaskView: async () => baseTask,
      probeLiveState: async () => baseLiveState,
      applyLabel: {
        setReady: async () => {},
        setBlocked: async () => {},
        clear: async () => {},
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
      ...overrides,
    };
  }

  it('returns null when task view is not available', async () => {
    const deps = createMockDeps({
      readTaskView: async () => null,
    });
    const pr = { number: 123, labels: [], headSha: 'abc123' };
    const result = await reconcileMergeLabelsForPr(pr, deps);
    assert.equal(result, null);
  });

  it('no-op when wm:ready label matches derived decision', async () => {
    let setReadyCalled = false;
    const deps = createMockDeps({
      applyLabel: {
        setReady: async () => { setReadyCalled = true; },
        setBlocked: async () => {},
        clear: async () => {},
      },
    });
    const pr = { number: 123, labels: ['wm:ready'], headSha: 'abc123' };
    const result = await reconcileMergeLabelsForPr(pr, deps);
    assert.deepEqual(result, { label: 'wm:ready' });
    assert.equal(setReadyCalled, false, 'setReady should not be called');
  });

  it('applies wm:ready when PR has wm:blocked but should be ready', async () => {
    let setReadyCalled = false;
    const deps = createMockDeps({
      applyLabel: {
        setReady: async () => { setReadyCalled = true; },
        setBlocked: async () => {},
        clear: async () => {},
      },
    });
    const pr = { number: 123, labels: ['wm:blocked'], headSha: 'abc123' };
    const result = await reconcileMergeLabelsForPr(pr, deps);
    assert.deepEqual(result, { label: 'wm:ready' });
    assert.equal(setReadyCalled, true, 'setReady should be called');
  });

  it('applies wm:blocked when PR has wm:ready but should be blocked', async () => {
    let setBlockedCalled = false;
    let blockedReason = '';
    const deps = createMockDeps({
      probeLiveState: async () => ({
        ...baseLiveState,
        statusCheckRollup: [
          { name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      }),
      applyLabel: {
        setReady: async () => {},
        setBlocked: async (_pr, reason) => {
          setBlockedCalled = true;
          blockedReason = reason;
        },
        clear: async () => {},
      },
    });
    const pr = { number: 123, labels: ['wm:ready'], headSha: 'abc123' };
    const result = await reconcileMergeLabelsForPr(pr, deps);
    assert.deepEqual(result, { label: 'wm:blocked', reason: 'ci-failing' });
    assert.equal(setBlockedCalled, true, 'setBlocked should be called');
    assert.equal(blockedReason, 'ci-failing');
  });

  it('clears labels when derived decision is null', async () => {
    let clearCalled = false;
    const deps = createMockDeps({
      probeLiveState: async () => ({
        ...baseLiveState,
        readyAtHead: undefined,
      }),
      applyLabel: {
        setReady: async () => {},
        setBlocked: async () => {},
        clear: async () => { clearCalled = true; },
      },
    });
    const pr = { number: 123, labels: ['wm:blocked'], headSha: 'abc123' };
    const result = await reconcileMergeLabelsForPr(pr, deps);
    assert.deepEqual(result, { label: null, reason: 'ready-pending' });
    assert.equal(clearCalled, true, 'clear should be called');
  });

  it('no-op when no labels and derived decision is null', async () => {
    let clearCalled = false;
    const deps = createMockDeps({
      probeLiveState: async () => ({
        ...baseLiveState,
        readyAtHead: undefined,
      }),
      applyLabel: {
        setReady: async () => {},
        setBlocked: async () => {},
        clear: async () => { clearCalled = true; },
      },
    });
    const pr = { number: 123, labels: [], headSha: 'abc123' };
    const result = await reconcileMergeLabelsForPr(pr, deps);
    assert.deepEqual(result, { label: null, reason: 'ready-pending' });
    assert.equal(clearCalled, false, 'clear should not be called when no labels present');
  });

  it('logs label changes', async () => {
    const logMessages: Array<{ msg: string; meta?: unknown }> = [];
    const deps = createMockDeps({
      applyLabel: {
        setReady: async () => {},
        setBlocked: async () => {},
        clear: async () => {},
      },
      logger: {
        info: (msg, meta) => logMessages.push({ msg, meta }),
        warn: () => {},
      },
    });
    const pr = { number: 123, labels: ['wm:blocked'], headSha: 'abc123' };
    await reconcileMergeLabelsForPr(pr, deps);
    assert.equal(logMessages.length, 1);
    assert.match(logMessages[0].msg, /wm:ready/);
    assert.deepEqual(logMessages[0].meta, {
      pr: 123,
      before: 'wm:blocked',
      after: 'wm:ready',
    });
  });
});
