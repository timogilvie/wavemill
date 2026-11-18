import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectMergeCandidates,
  isCandidateStuck,
  isCiGreen,
  readyVerdictInvalidation,
  MERGE_QUEUE_STATES,
  isMergeQueueState,
  mergeLanePosition,
  planMergeQueueTick,
  isTerminalWorkflowStatus,
  isClosedOrMergedPrState,
  isSelectableMergeQueuePr,
  classifyMergeQueueConsumability,
  type MergeQueueConfigResolved,
  type MergeQueuePr,
} from './merge-queue.ts';
import { enrichReadyPrsWithTendRebaseConflicts } from '../../tools/merge-queue-select.ts';
import { TEND_ATTEMPT_FACT_FILE, writeTendAttemptFact } from './tend-attempt-fact.ts';

const config: MergeQueueConfigResolved = {
  enabled: true,
  maxConcurrentCandidates: 2,
  stuckTimeoutSeconds: 900,
  conflictGroupingEnabled: true,
  skipCooldownSeconds: 60,
};

function pr(overrides: Partial<MergeQueuePr>): MergeQueuePr {
  return {
    issue: 'HOK-1',
    slug: 'one',
    prNumber: 1,
    branch: 'task/one',
    queueState: 'ready-stale',
    readyAt: '2026-05-06T12:00:00.000Z',
    unblocksCount: 0,
    changedFiles: ['a.ts'],
    ci: { conclusion: 'pass' },
    labels: [],
    ...overrides,
  };
}

test('same-file overlap selects only one candidate', () => {
  const selected = selectMergeCandidates({
    readyPrs: [pr({ issue: 'HOK-1' }), pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two' })],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-1']);
});

test('disjoint files can select two candidates', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts'] }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['b.ts'] }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-1', 'HOK-2']);
});

test('maxConcurrentCandidates caps output', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts'] }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['b.ts'] }),
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'] }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 2 },
  });
  assert.equal(selected.length, 2);
});

test('priority order honors unblocking count before file count before age', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts', 'b.ts'], unblocksCount: 1, readyAt: '2026-05-06T12:00:00.000Z' }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['c.ts'], unblocksCount: 2 }),
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['d.ts'], unblocksCount: 1, readyAt: '2026-05-06T11:00:00.000Z' }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 3, conflictGroupingEnabled: false },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-2', 'HOK-3', 'HOK-1']);
});

test('stuck timeout boundary is deterministic', () => {
  assert.equal(
    isCandidateStuck(
      { candidatePromotedAt: '2026-05-06T12:00:00.000Z' },
      '2026-05-06T12:15:00.000Z',
      config,
    ),
    true,
  );
});

test('the declared queue-state list is exactly the four monitor-written values (HOK-3453)', () => {
  assert.deepEqual([...MERGE_QUEUE_STATES], ['ready', 'ready-stale', 'merge-candidate', 'merge-needed']);
  assert.equal(isMergeQueueState('merge-needed'), true);
  for (const value of ['', 'merged', 'terminal', null, undefined, 3]) {
    assert.equal(isMergeQueueState(value), false, String(value));
  }
});

test('mergeLanePosition names merge-needed apart from the tend lane (HOK-3453)', () => {
  const cases: Array<[unknown, string | undefined, string]> = [
    ['ready', 'completed', 'tend-lane'],
    ['ready', 'running', 'not-in-lane'],
    ['ready', undefined, 'not-in-lane'],
    ['ready-stale', 'completed', 'tend-lane'],
    ['merge-candidate', 'running', 'tend-lane'],
    ['merge-needed', 'completed', 'merge-needed'],
    ['merge-needed', undefined, 'merge-needed'],
    [undefined, 'completed', 'not-in-lane'],
    ['bogus', 'completed', 'not-in-lane'],
  ];
  for (const [queueState, status, expected] of cases) {
    assert.equal(mergeLanePosition(queueState, status), expected, `${String(queueState)}/${String(status)}`);
  }
});
test('disabled conflict grouping selects by priority up to max', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts'], unblocksCount: 0 }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['a.ts'], unblocksCount: 3 }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, conflictGroupingEnabled: false },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-2', 'HOK-1']);
});

test('tick planner demotes stuck candidate and promotes disjoint replacement', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-1',
        queueState: 'merge-candidate',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
      pr({
        issue: 'HOK-2',
        prNumber: 2,
        branch: 'task/two',
        queueState: 'ready-stale',
        changedFiles: ['b.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, ['HOK-1']);
  assert.deepEqual(plan.selectedIssues, ['HOK-2']);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('active transient merge retry candidates are not demoted as stuck', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-1',
        queueState: 'merge-candidate',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        candidateLastProgressAt: '2026-05-06T12:00:00.000Z',
        mergeRetryInProgressUntil: '2026-05-06T12:35:00.000Z',
        changedFiles: ['a.ts'],
      }),
      pr({
        issue: 'HOK-2',
        prNumber: 2,
        branch: 'task/two',
        queueState: 'ready-stale',
        changedFiles: ['b.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, ['HOK-1', 'HOK-2']);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('expired transient merge retry candidates can still be demoted as stuck', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-1',
        queueState: 'merge-candidate',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        candidateLastProgressAt: '2026-05-06T12:00:00.000Z',
        mergeRetryInProgressUntil: '2026-05-06T12:20:00.000Z',
        changedFiles: ['a.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, ['HOK-1']);
  assert.deepEqual(plan.selectedIssues, []);
  assert.deepEqual(plan.invalidatedIssues, []);
});

// --- Terminal workflow status predicate tests ---

test('isTerminalWorkflowStatus: merged is terminal', () => {
  assert.equal(isTerminalWorkflowStatus('merged'), true);
});

test('isTerminalWorkflowStatus: completed-external is terminal', () => {
  assert.equal(isTerminalWorkflowStatus('completed-external'), true);
});

test('isTerminalWorkflowStatus: aborted is terminal', () => {
  assert.equal(isTerminalWorkflowStatus('aborted'), true);
});

test('isTerminalWorkflowStatus: undefined is not terminal', () => {
  assert.equal(isTerminalWorkflowStatus(undefined), false);
});

test('isTerminalWorkflowStatus: unknown status is not terminal', () => {
  assert.equal(isTerminalWorkflowStatus('coding'), false);
});

test('isClosedOrMergedPrState: MERGED is closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('MERGED'), true);
});

test('isClosedOrMergedPrState: CLOSED is closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('CLOSED'), true);
});

test('isClosedOrMergedPrState: lowercase merged is closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('merged'), true);
});

test('isClosedOrMergedPrState: undefined is not closed/merged', () => {
  assert.equal(isClosedOrMergedPrState(undefined), false);
});

test('isClosedOrMergedPrState: OPEN is not closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('OPEN'), false);
});

test('isSelectableMergeQueuePr: missing both fields is selectable', () => {
  assert.equal(isSelectableMergeQueuePr({}), true);
});

test('isSelectableMergeQueuePr: merged workflow status is not selectable', () => {
  assert.equal(isSelectableMergeQueuePr({ workflowStatus: 'merged' }), false);
});

test('isSelectableMergeQueuePr: CLOSED prState is not selectable', () => {
  assert.equal(isSelectableMergeQueuePr({ prState: 'CLOSED' }), false);
});

// --- Selection: terminal active candidates do not block ready PRs ---

test('terminal active candidates are excluded before slot accounting', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'], queueState: 'ready-stale' }),
    ],
    activeCandidates: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['a.ts'] }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['b.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 2 },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-3']);
});

test('with maxConcurrentCandidates=1, terminal candidates still allow a clean PR', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'], queueState: 'ready-stale' }),
    ],
    activeCandidates: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['a.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 1 },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-3']);
});

test('healthy non-terminal candidates select in priority order', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'], queueState: 'ready-stale' }),
    ],
    activeCandidates: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', changedFiles: ['a.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 2 },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-1', 'HOK-3']);
});

// --- Planner: terminal candidates excluded from selectedIssues and stuckIssues ---

test('planMergeQueueTick excludes terminal candidates from selectedIssues', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['a.ts'], candidatePromotedAt: '2026-05-06T12:20:00.000Z' }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', queueState: 'merge-candidate', workflowStatus: 'completed-external', changedFiles: ['b.ts'], candidatePromotedAt: '2026-05-06T12:20:00.000Z' }),
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', queueState: 'ready-stale', changedFiles: ['c.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.selectedIssues, ['HOK-3']);
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('terminal stale active candidates do not appear in stuckIssues', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-1',
        queueState: 'merge-candidate',
        workflowStatus: 'merged',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, []);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('closed unmerged active candidates are excluded from selectedIssues and stuckIssues', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-CLOSED',
        queueState: 'merge-candidate',
        workflowStatus: 'active',
        prState: 'CLOSED',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, []);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('closed unmerged candidate does not block open clean ready PR selection', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-CLOSED',
        queueState: 'merge-candidate',
        workflowStatus: 'active',
        prState: 'CLOSED',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
      pr({
        issue: 'HOK-OPEN',
        prNumber: 2,
        branch: 'task/open',
        queueState: 'ready-stale',
        prState: 'OPEN',
        changedFiles: ['b.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 1 },
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, ['HOK-OPEN']);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('closed prState is excluded case-insensitively', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-CLOSED',
        queueState: 'merge-candidate',
        workflowStatus: 'active',
        prState: 'closed',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
      pr({
        issue: 'HOK-OPEN',
        prNumber: 2,
        branch: 'task/open',
        queueState: 'ready-stale',
        prState: 'OPEN',
        changedFiles: ['b.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 1 },
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, ['HOK-OPEN']);
  assert.deepEqual(plan.invalidatedIssues, []);
});

test('HOK-2850: partial live CI is not selected', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({
        issue: 'HOK-2850',
        ci: { conclusion: 'pending', observed: 1, required: 15 },
      }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), []);
});

test('missing live CI is not selected', () => {
  const selected = selectMergeCandidates({
    readyPrs: [pr({ issue: 'HOK-NOCI', ci: undefined })],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), []);
});

test('failing active candidate is invalidated and green replacement can be selected', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-RED',
        queueState: 'merge-candidate',
        changedFiles: ['a.ts'],
        ci: { conclusion: 'fail', failing: ['Shell and Unit Tests'] },
      }),
      pr({
        issue: 'HOK-GREEN',
        prNumber: 2,
        branch: 'task/green',
        changedFiles: ['b.ts'],
        ci: { conclusion: 'pass' },
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 1 },
  });
  assert.deepEqual(plan.invalidatedIssues, [{ issue: 'HOK-RED', prNumber: 1, cause: 'ci-failing' }]);
  assert.deepEqual(plan.selectedIssues, ['HOK-GREEN']);
  assert.deepEqual(plan.stuckIssues, []);
});

test('readyVerdictInvalidation identifies only positive live invalidation evidence', () => {
  assert.equal(readyVerdictInvalidation(pr({ ci: { conclusion: 'fail' } })), 'ci-failing');
  for (const conclusion of ['pass', 'pending', 'unknown'] as const) {
    assert.equal(readyVerdictInvalidation(pr({
      ci: { conclusion, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    })), 'conflict');
  }
  assert.equal(readyVerdictInvalidation(pr({
    ci: { conclusion: 'pass', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
  })), null);
  assert.equal(readyVerdictInvalidation(pr({ ci: { conclusion: 'pass' } })), null);
  assert.equal(readyVerdictInvalidation(pr({
    ci: { conclusion: 'pass', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', readError: { reason: 'stale read' } },
  })), null);
  for (const mergeStateStatus of ['BLOCKED', 'UNSTABLE']) {
    const candidate = pr({ ci: { conclusion: 'pass', mergeStateStatus } });
    assert.equal(readyVerdictInvalidation(candidate), null);
    assert.equal(isCiGreen(candidate), false);
  }
});

test('readyVerdictInvalidation re-runs Ready once for each newer tend rebase fact', () => {
  const readyAt = '2026-05-06T12:00:00.000Z';
  assert.equal(readyVerdictInvalidation(pr({ readyAt, tendRebaseConflictAt: '2026-05-06T12:00:01.000Z' })), 'tend-rebase-conflict');
  assert.equal(readyVerdictInvalidation(pr({ readyAt: undefined, tendRebaseConflictAt: '2026-05-06T12:00:01.000Z' })), 'tend-rebase-conflict');
  assert.equal(readyVerdictInvalidation(pr({ readyAt, tendRebaseConflictAt: '2026-05-06T11:59:59.000Z' })), null);
  assert.equal(readyVerdictInvalidation(pr({ readyAt, tendRebaseConflictAt: readyAt })), null);
});

test('blocked merge state is not green even with passing checks', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({
        issue: 'HOK-BLOCKED',
        ci: { conclusion: 'pass', mergeStateStatus: 'BLOCKED' },
      }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), []);
});

test('a DIRTY wm:blocked PR is invalidated before label exclusion', () => {
  const plan = planMergeQueueTick({
    readyPrs: [pr({
      issue: 'HOK-DIRTY',
      prNumber: 42,
      queueState: 'ready-stale',
      labels: ['wm:blocked'],
      ci: { conclusion: 'pass', headSha: 'head-42', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    })],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.invalidatedIssues, [{
    issue: 'HOK-DIRTY', prNumber: 42, headSha: 'head-42', cause: 'conflict',
  }]);
  assert.deepEqual(plan.excludedIssues, []);
  assert.deepEqual(plan.selectedIssues, []);
});

test('a DIRTY non-candidate with pending CI is still invalidated', () => {
  const plan = planMergeQueueTick({
    readyPrs: [pr({
      issue: 'HOK-PENDING-DIRTY',
      prNumber: 43,
      queueState: 'ready-stale',
      ci: { conclusion: 'pending', headSha: 'head-43', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    })],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.equal(plan.invalidatedIssues[0]?.cause, 'conflict');
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, []);
});

test('a DIRTY candidate is neither stuck nor selected while a clean candidate advances', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-CONFLICTED',
        prNumber: 44,
        queueState: 'merge-candidate',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        ci: { conclusion: 'pass', headSha: 'head-44', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      }),
      pr({
        issue: 'HOK-CLEAN',
        prNumber: 45,
        branch: 'task/clean',
        changedFiles: ['clean.ts'],
        ci: { conclusion: 'pass', headSha: 'head-45', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 1 },
  });
  assert.equal(plan.invalidatedIssues[0]?.issue, 'HOK-CONFLICTED');
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, ['HOK-CLEAN']);
});

test('merge-queue-select feeds only a current tend rebase fact into Ready invalidation (HOK-3316)', async (t) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const stateDir = mkdtempSync(join(tmpdir(), 'merge-queue-tend-fact-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const base = 'c'.repeat(40);
  const inputPr = (overrides: Partial<MergeQueuePr> = {}) => ({
    ...pr({
      issue: 'HOK-3316',
      prNumber: 1591,
      ci: { conclusion: 'pass', headSha: head, mergeStateStatus: 'CLEAN' },
      ...overrides,
    }),
    stateDir,
    integrationBaseSha: base,
  });
  const writeRebaseFact = (writtenAt: string) => {
    writeTendAttemptFact(stateDir, {
      phase: 'rebase', prNumber: 1591, headSha: head, baseSha: base,
      excerpt: 'CONFLICT (content)', failureClass: 'code-failure',
    });
    const factPath = join(stateDir, TEND_ATTEMPT_FACT_FILE);
    const fact = JSON.parse(readFileSync(factPath, 'utf8')) as { writtenAt: string };
    fact.writtenAt = writtenAt;
    writeFileSync(factPath, JSON.stringify(fact));
  };

  let enriched = enrichReadyPrsWithTendRebaseConflicts([inputPr()]);
  assert.equal(enriched[0].tendRebaseConflictAt, undefined, 'no fact: no Ready re-run');

  writeRebaseFact('2026-10-22T17:12:29.000Z');
  enriched = enrichReadyPrsWithTendRebaseConflicts([
    inputPr({ readyAt: '2026-10-22T12:05:00.000Z' }),
  ]);
  assert.equal(enriched[0].tendRebaseConflictAt, '2026-10-22T17:12:29.000Z');
  let plan = planMergeQueueTick({
    readyPrs: enriched,
    now: '2026-10-22T17:13:00.000Z',
    config,
  });
  assert.deepEqual(plan.invalidatedIssues, [{
    issue: 'HOK-3316', prNumber: 1591, headSha: head, cause: 'tend-rebase-conflict',
  }], 'newer fact at the live head and base: re-run Ready');

  enriched = enrichReadyPrsWithTendRebaseConflicts([
    { ...inputPr(), integrationBaseSha: 'd'.repeat(40) },
  ]);
  assert.equal(enriched[0].tendRebaseConflictAt, undefined, 'base moved: tend retries instead');

  enriched = enrichReadyPrsWithTendRebaseConflicts([
    inputPr({ ci: { conclusion: 'pass', headSha: 'b'.repeat(40), mergeStateStatus: 'CLEAN' } }),
  ]);
  assert.equal(enriched[0].tendRebaseConflictAt, undefined, 'head moved: old fact does not hold');

  enriched = enrichReadyPrsWithTendRebaseConflicts([
    inputPr({ readyAt: '2026-10-22T17:13:00.000Z' }),
  ]);
  plan = planMergeQueueTick({ readyPrs: enriched, now: '2026-10-22T17:14:00.000Z', config });
  assert.deepEqual(plan.invalidatedIssues, [], 'Ready already re-ran after the fact: no second re-run');
});

test('lane progress telemetry (HOK-2919)', async (t) => {
  const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { laneProgressPath, mergeLaneStateDir, readLaneProgress, recordLaneProgress } = await import('./merge-queue.ts');

  await t.test('records lane entry, wait time, and per-event counters', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-lane-progress-'));
    try {
      await recordLaneProgress(42, repoDir, 'merge-attempt', {
        now: '2026-08-28T12:10:00Z',
        readyAt: '2026-08-28T12:00:00Z',
      });
      await recordLaneProgress(42, repoDir, 'rebase', { now: '2026-08-28T12:11:00Z' });
      await recordLaneProgress(42, repoDir, 'ci-restart', { now: '2026-08-28T12:11:30Z' });
      await recordLaneProgress(42, repoDir, 'stale-base-refresh', { now: '2026-08-28T12:20:00Z' });
      const record = await recordLaneProgress(42, repoDir, 'merged', { now: '2026-08-28T12:30:00Z' });

      assert.equal(record.prNumber, 42);
      assert.equal(record.enteredLaneAt, '2026-08-28T12:10:00Z');
      assert.equal(record.laneWaitSeconds, 600);
      assert.equal(record.lastProgressAt, '2026-08-28T12:30:00Z');
      assert.equal(record.lastEvent, 'merged');
      assert.equal(record.laneHoldSeconds, 1200);
      // stale-base-refresh counts as both a rebase and a CI restart.
      assert.equal(record.rebaseCount, 2);
      assert.equal(record.ciRestartCount, 2);
      assert.equal(record.mergeAttemptCount, 1);

      const roundTrip = readLaneProgress(42, repoDir);
      assert.deepEqual(roundTrip, record);
      assert.equal(laneProgressPath(42, repoDir), join(mergeLaneStateDir(42, repoDir), 'progress.json'));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  await t.test('readLaneProgress returns null for absent or malformed records', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-lane-progress-'));
    try {
      assert.equal(readLaneProgress(99, repoDir), null);
      mkdirSync(mergeLaneStateDir(99, repoDir), { recursive: true });
      writeFileSync(laneProgressPath(99, repoDir), 'not json', 'utf-8');
      assert.equal(readLaneProgress(99, repoDir), null);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  await t.test('poll ticks never move lastProgressAt: only recorded events do', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-lane-progress-'));
    try {
      await recordLaneProgress(7, repoDir, 'merge-attempt', { now: '2026-08-28T12:00:00Z' });
      const before = readFileSync(laneProgressPath(7, repoDir), 'utf-8');
      // Reading (what a poll does) leaves the record byte-identical.
      readLaneProgress(7, repoDir);
      readLaneProgress(7, repoDir);
      assert.equal(readFileSync(laneProgressPath(7, repoDir), 'utf-8'), before);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// --- HOK-3111: tend-refusal labels exclude PRs from the merge lane ---

test('classifyMergeQueueConsumability: empty labels are consumable', () => {
  const verdict = classifyMergeQueueConsumability({ labels: [] });
  assert.equal(verdict.consumable, true);
});

test('classifyMergeQueueConsumability: wm:blocked is not consumable', () => {
  const verdict = classifyMergeQueueConsumability({ labels: ['wm:blocked'] });
  assert.equal(verdict.consumable, false);
  if (!verdict.consumable) {
    assert.equal(verdict.blockingLabel, 'wm:blocked');
    assert.match(verdict.reason, /wm:blocked/);
  }
});

test('classifyMergeQueueConsumability: undefined labels fail closed', () => {
  const verdict = classifyMergeQueueConsumability({ labels: undefined });
  assert.equal(verdict.consumable, false);
  if (!verdict.consumable) {
    assert.match(verdict.reason, /live labels unknown/);
  }
});

test('wm:blocked green PR is excluded, not promoted, not selected', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-3106',
        prNumber: 1518,
        queueState: 'ready-stale',
        labels: ['wavemill', 'wm:blocked'],
        ci: { conclusion: 'pass', headSha: 'aaaaaaa', mergeStateStatus: 'CLEAN' },
      }),
      pr({
        issue: 'HOK-OK',
        prNumber: 2,
        branch: 'task/ok',
        queueState: 'ready-stale',
        labels: ['wm:ready'],
        changedFiles: ['b.ts'],
        ci: { conclusion: 'pass' },
      }),
    ],
    now: '2026-09-29T12:00:00.000Z',
    config,
  });
  assert.deepEqual(plan.selectedIssues, ['HOK-OK']);
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.invalidatedIssues, []);
  assert.equal(plan.excludedIssues.length, 1);
  assert.equal(plan.excludedIssues[0].issue, 'HOK-3106');
  assert.equal(plan.excludedIssues[0].blockingLabel, 'wm:blocked');
  assert.equal(plan.excludedIssues[0].prNumber, 1518);
  assert.equal(plan.excludedIssues[0].headSha, 'aaaaaaa');
});

test('wm:blocked candidate does not enter stuckIssues after timeout', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-3106',
        queueState: 'merge-candidate',
        candidatePromotedAt: '2026-09-29T11:00:00.000Z',
        labels: ['wm:blocked'],
        changedFiles: ['a.ts'],
      }),
    ],
    now: '2026-09-29T12:00:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, []);
  assert.deepEqual(plan.invalidatedIssues, []);
  assert.equal(plan.excludedIssues.length, 1);
  assert.equal(plan.excludedIssues[0].blockingLabel, 'wm:blocked');
});

test('unknown live labels fail closed (excluded, not promoted)', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-NOLABELS',
        queueState: 'ready-stale',
        labels: undefined,
      }),
    ],
    now: '2026-09-29T12:00:00.000Z',
    config,
  });
  assert.deepEqual(plan.selectedIssues, []);
  assert.equal(plan.excludedIssues.length, 1);
  assert.match(plan.excludedIssues[0].reason, /live labels unknown/);
});

test('isCandidateStuck honors tend lane progress (HOK-2919)', () => {
  const config = { stuckTimeoutSeconds: 900 };
  const now = '2026-08-28T12:30:00Z';
  // Queue-side progress is old, but tend refreshed the branch recently.
  assert.equal(isCandidateStuck({
    candidatePromotedAt: '2026-08-28T11:00:00Z',
    candidateLastProgressAt: '2026-08-28T11:00:00Z',
    lastProgressAt: '2026-08-28T12:25:00Z',
  }, now, config), false);
  // Without the tend stamp the same candidate would be stuck.
  assert.equal(isCandidateStuck({
    candidatePromotedAt: '2026-08-28T11:00:00Z',
    candidateLastProgressAt: '2026-08-28T11:00:00Z',
  }, now, config), true);
});
