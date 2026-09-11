import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyChallengePairGates,
  classifyChallengeState,
  classifyPairUnresolvableState,
  getSiblingBranch,
  isUnresolvableReason,
  isSiblingLive,
  loadWorkflowStateChallengeData,
  pairHasPendingChallengeArm,
  parseRemoteBranchOutput,
  UNRESOLVABLE_REASONS,
  type ChallengeBlockedCandidate,
  type ChallengeEligibleWorkItem,
  type ChallengeGateOptions,
  type PairTaskState,
} from './tend-challenge-gate.ts';

describe('unresolvable reason helpers', () => {
  it('recognizes every supported unresolvable reason', () => {
    assert.deepEqual(UNRESOLVABLE_REASONS, [
      'orphan-sibling',
      'sibling-eval-hard-failed',
      'both-eval-hard-failed',
      'sibling-challenge-aborted',
      'both-challenge-aborted',
    ]);
    assert.equal(isUnresolvableReason('both-challenge-aborted'), true);
    assert.equal(isUnresolvableReason('foo'), false);
  });

  it('classifies eval hard failures before aborted challenge state', () => {
    const task = (role: 'primary' | 'challenger', overrides: { evalFailed?: boolean; retry?: number; aborted?: string }) => ({
      issueId: role === 'primary' ? 'HOK-1' : 'HOK-1_c',
      prNumber: role === 'primary' ? 101 : 102,
      role,
      branch: null,
      model: null,
      updatedAt: null,
      evalFailed: overrides.evalFailed ?? false,
      evalCompleted: false,
      evalHardFailureRetryCount: overrides.retry ?? 0,
      comparisonState: null,
      challengeAborted: overrides.aborted ?? null,
      challengeAbortedDetail: null,
      challengeAbortedNextAction: null,
      challengeAbortedStage: null,
    });

    assert.equal(classifyPairUnresolvableState({
      primary: task('primary', { evalFailed: true, retry: 2, aborted: 'terminal' }),
      challenger: task('challenger', { aborted: 'terminal' }),
    }, 2), 'sibling-eval-hard-failed');
    assert.equal(classifyPairUnresolvableState({
      primary: task('primary', { aborted: 'terminal' }),
      challenger: task('challenger', { aborted: 'terminal' }),
    }, 2), 'both-challenge-aborted');
  });
});

describe('pending deferred challenger arms (HOK-2813)', () => {
  it('projects the pending arm and keeps the pair unresolved instead of orphaned', () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      writeWorkflowState(repoDir, {
        'HOK-2813': {
          pr: 500,
          branch: 'task/deferred-primary',
          updated: '2026-07-01T00:00:00Z',
          challengePairId: 'HOK-2813',
          challengeRole: 'primary',
          challengeArms: [{
            key: 'HOK-2813_c',
            role: 'challenger',
            variedStage: 'review',
            challengeArmState: 'awaiting_fork',
          }],
        },
      });

      const data = loadWorkflowStateChallengeData(repoDir);
      const pairState = data.taskStateByPair.get('HOK-2813');
      assert.equal(pairHasPendingChallengeArm(pairState), true);
      assert.deepEqual(classifyChallengeState(
        500,
        { challenge: true, challengePairId: 'HOK-2813' },
        data.challengePairMap,
        [],
        false,
        new Set([500]),
        {
          taskStateByPair: data.taskStateByPair,
          activeJobsByPair: data.activeJobsByPair,
          nowMs: () => Date.parse('2026-07-02T00:00:00Z'),
        },
      ), {
        kind: 'pair-unresolved',
        pairId: 'HOK-2813',
        otherPr: null,
        reason: 'pair-unresolved:challenger-awaiting-fork',
      });
    } finally {
      cleanup();
    }
  });
});

describe('workflow state challenge data', () => {
  it('derives missing challenge roles from canonical task keys', () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      writeWorkflowState(repoDir, {
        HOK_2870: {
          pr: 1226,
          branch: 'task/eight-test-files',
          challengePairId: 'HOK-2870',
          challengeRole: '',
          challengeModel: 'gpt-5',
          evalCompleted: true,
        },
        HOK_2870_c: {
          pr: 1225,
          branch: 'task/eight-test-files-challenger',
          challengePairId: 'HOK-2870',
          challengeRole: 'challenger',
          challengeModel: 'claude-sonnet-4',
          evalCompleted: true,
        },
      });

      const state = loadWorkflowStateChallengeData(repoDir);
      const pair = state.taskStateByPair.get('HOK-2870');
      assert.equal(pair?.primary?.role, 'primary');
      assert.equal(pair?.primary?.prNumber, 1226);
      assert.equal(pair?.challenger?.role, 'challenger');
      assert.equal(pair?.challenger?.prNumber, 1225);
    } finally {
      cleanup();
    }
  });

  it('preserves challenge abort detail, next action, and stage', () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      writeWorkflowState(repoDir, {
        HOK_1_c: {
          challengePairId: 'HOK-1',
          challengeRole: 'challenger',
          challengeModel: 'qwen-2.5-coder-32b',
          challengeAborted: 'terminal_stage_failure:tool-use-unsupported',
          challengeAbortedDetail: '404 No endpoints found that support tool use',
          challengeAbortedNextAction: 'route this stage to a tool-capable model',
          challengeAbortedStage: 'coding',
        },
      });

      const state = loadWorkflowStateChallengeData(repoDir);
      const challenger = state.taskStateByPair.get('HOK-1')?.challenger;
      assert.equal(challenger?.challengeAborted, 'terminal_stage_failure:tool-use-unsupported');
      assert.equal(challenger?.challengeAbortedDetail, '404 No endpoints found that support tool use');
      assert.equal(challenger?.challengeAbortedNextAction, 'route this stage to a tool-capable model');
      assert.equal(challenger?.challengeAbortedStage, 'coding');
    } finally {
      cleanup();
    }
  });
});

function makeWorkItem(overrides: {
  number?: number;
  title?: string;
  headRefName?: string;
  createdAt?: string;
  labels?: Array<{ name: string }>;
  challengePairId?: string;
  challenge?: boolean;
}): ChallengeEligibleWorkItem {
  return {
    pr: {
      number: overrides.number ?? 101,
      title: overrides.title ?? 'Test PR',
      headRefName: overrides.headRefName ?? 'task/test-pr',
      createdAt: overrides.createdAt ?? '2026-04-01T00:00:00Z',
      labels: overrides.labels ?? [],
    },
    metadata: {
      challengePairId: overrides.challengePairId,
      challenge: overrides.challenge,
    },
  };
}

function setupRepoDir(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-gate-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: { integrationBranch: 'auto/integration' },
      ...config,
    }),
  );
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function writeWorkflowState(
  repoDir: string,
  tasks: Record<string, unknown>,
  jobs: Record<string, unknown> = {},
): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks, jobs }));
}

describe('getSiblingBranch', () => {
  it('returns challenger sibling for a primary task branch', () => {
    assert.equal(getSiblingBranch('task/foo'), 'task/foo-challenger');
  });

  it('returns primary sibling for a challenger task branch', () => {
    assert.equal(getSiblingBranch('task/foo-challenger'), 'task/foo');
  });

  it('returns null for non-task branches', () => {
    assert.equal(getSiblingBranch('feature/bar'), null);
    assert.equal(getSiblingBranch('main'), null);
  });

  it('handles double-challenger suffix correctly', () => {
    assert.equal(getSiblingBranch('task/foo-challenger-challenger'), 'task/foo-challenger');
  });

  it('handles nested task branch paths', () => {
    assert.equal(getSiblingBranch('task/some/nested/path'), 'task/some/nested/path-challenger');
  });
});

describe('isSiblingLive', () => {
  const pairState: PairTaskState = {
    primary: {
      issueId: 'HOK-1',
      prNumber: 101,
      branch: 'task/pair-primary',
      role: 'primary',
      model: null,
      evalCompleted: false,
      evalFailed: false,
      evalHardFailureRetryCount: 0,
      comparisonState: null,
      challengeAborted: null,
      updatedAt: 0,
    },
    challenger: {
      issueId: 'HOK-1-c',
      prNumber: 102,
      branch: 'task/pair-primary-challenger',
      role: 'challenger',
      model: null,
      evalCompleted: false,
      evalFailed: false,
      evalHardFailureRetryCount: 0,
      comparisonState: null,
      challengeAborted: null,
      updatedAt: 0,
    },
  };

  it('treats missing and untracked sibling refs as not live', () => {
    assert.equal(isSiblingLive({
      hasSiblingBranch: false,
      openPrNumbers: new Set([102]),
      pairState,
      side: 'primary',
    }), false);
    assert.equal(isSiblingLive({
      hasSiblingBranch: true,
      openPrNumbers: new Set([102]),
      pairState: { primary: pairState.primary },
      side: 'primary',
    }), false);
  });

  it('treats aborted siblings as not live', () => {
    assert.equal(isSiblingLive({
      hasSiblingBranch: true,
      openPrNumbers: new Set([102]),
      pairState: {
        ...pairState,
        challenger: { ...pairState.challenger!, challengeAborted: 'terminal_launch_failure:invalid-model-id' },
      },
      side: 'primary',
    }), false);
  });

  it('treats tracked siblings without a PR as live', () => {
    assert.equal(isSiblingLive({
      hasSiblingBranch: true,
      openPrNumbers: new Set(),
      pairState: {
        ...pairState,
        challenger: { ...pairState.challenger!, prNumber: null },
      },
      side: 'primary',
    }), true);
  });

  it('keys tracked siblings with PRs on whether the PR is open', () => {
    assert.equal(isSiblingLive({
      hasSiblingBranch: true,
      openPrNumbers: new Set([102]),
      pairState,
      side: 'primary',
    }), true);
    assert.equal(isSiblingLive({
      hasSiblingBranch: true,
      openPrNumbers: new Set([101]),
      pairState,
      side: 'primary',
    }), false);
  });
});

describe('parseRemoteBranchOutput', () => {
  it('parses full refs from git ls-remote output', () => {
    const output = [
      'abc123\trefs/heads/task/foo',
      'def456\trefs/heads/task/bar-challenger',
    ].join('\n');
    assert.deepEqual(parseRemoteBranchOutput(output), ['task/foo', 'task/bar-challenger']);
  });

  it('handles plain branch names without refs/heads/', () => {
    const output = 'abc123\ttask/baz\n';
    assert.deepEqual(parseRemoteBranchOutput(output), ['task/baz']);
  });

  it('skips non-task branches', () => {
    const output = [
      'abc123\trefs/heads/main',
      'def456\trefs/heads/task/foo',
      'ghi789\trefs/heads/feature/bar',
    ].join('\n');
    assert.deepEqual(parseRemoteBranchOutput(output), ['task/foo']);
  });

  it('handles empty output', () => {
    assert.deepEqual(parseRemoteBranchOutput(''), []);
    assert.deepEqual(parseRemoteBranchOutput('\n'), []);
  });
});

describe('branch sibling detection in applyChallengePairGates', () => {
  it('blocks a primary when challenger sibling branch exists on remote', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({ number: 101, headRefName: 'task/foo' })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      cleanup();
    }
  });

  it('blocks a challenger when primary sibling branch exists on remote', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({ number: 102, headRefName: 'task/foo-challenger' })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      cleanup();
    }
  });

  it('allows a task PR when no sibling branch exists', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/solo',
        createdAt: '2020-01-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/solo'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.blocked.length, 0);
    } finally {
      cleanup();
    }
  });

  it('does not let branch detection re-block a resolved winner', async () => {
    const { repoDir, cleanup } = setupRepoDir({ challenge: { autoMergeWinner: true } });
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/foo',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          winner: 'primary',
          timestamp: '2026-04-28T12:00:00Z',
        }),
      );

      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.eligible[0].pr.number, 101);
    } finally {
      cleanup();
    }
  });

  it('does not re-block a resolved winner when workflow state stores PR numbers as strings', async () => {
    const { repoDir, cleanup } = setupRepoDir({ challenge: { autoMergeWinner: true } });
    try {
      const items = [makeWorkItem({
        number: 579,
        headRefName: 'task/foo',
      })];

      writeWorkflowState(repoDir, {
        HOK_1623: { pr: '579', challengePairId: 'HOK-1623', challengeRole: 'primary' },
        HOK_1623_c: { pr: '578', challengePairId: 'HOK-1623', challengeRole: 'challenger' },
      });
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'HOK-1623',
          primaryPrUrl: 'https://github.com/org/repo/pull/579',
          challengerPrUrl: 'https://github.com/org/repo/pull/578',
          winner: 'primary',
          timestamp: '2026-05-09T15:31:00Z',
        }),
      );

      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.eligible[0].pr.number, 579);
      assert.equal(result.blocked.length, 0);
    } finally {
      cleanup();
    }
  });

  it('allows the surviving side through when a terminal forfeit record exists', async () => {
    const { repoDir, cleanup } = setupRepoDir({ challenge: { autoMergeWinner: true } });
    try {
      const items = [makeWorkItem({
        number: 102,
        headRefName: 'task/foo-challenger',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          winner: 'challenger',
          timestamp: '2026-07-06T12:00:00Z',
          comparisonOutcome: 'forfeit',
          terminalReason: 'primary_eval_hard_failed',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.eligible.length, 1);
      assert.equal(result.eligible[0].pr.number, 102);
      assert.equal(result.blocked.length, 0);
    } finally {
      cleanup();
    }
  });

  it('holds both sides for manual recovery after a double-forfeit terminal record', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({
          number: 101,
          headRefName: 'task/foo',
          challengePairId: 'pair-1',
          challenge: true,
        }),
        makeWorkItem({
          number: 102,
          headRefName: 'task/foo-challenger',
          challengePairId: 'pair-1',
          challenge: true,
        }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          winner: 'primary',
          timestamp: '2026-07-06T12:00:00Z',
          comparisonOutcome: 'double-forfeit',
          terminalReason: 'both_eval_hard_failed',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.eligible.length, 0);
      assert.deepEqual(
        result.blocked.map((item) => [item.number, item.reason]).sort((a, b) => a[0] - b[0]),
        [
          [101, 'challenge:pair-unresolved:double-forfeit-comparison'],
          [102, 'challenge:pair-unresolved:double-forfeit-comparison'],
        ],
      );
      assert.deepEqual(result.losers, []);
    } finally {
      cleanup();
    }
  });

  it('holds both sides when the latest comparison is invalid', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({
          number: 101,
          headRefName: 'task/foo',
          challengePairId: 'pair-1',
          challenge: true,
        }),
        makeWorkItem({
          number: 102,
          headRefName: 'task/foo-challenger',
          challengePairId: 'pair-1',
          challenge: true,
        }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          timestamp: '2026-07-29T12:00:00Z',
          comparisonOutcome: 'invalid',
          terminalReason: 'provenance_validation_failed',
          rationale: 'Planner provenance mismatch.',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.eligible.length, 0);
      assert.deepEqual(
        result.blocked.map((item) => [item.number, item.reason]).sort((a, b) => a[0] - b[0]),
        [
          [101, 'challenge:pair-unresolved:invalid-comparison'],
          [102, 'challenge:pair-unresolved:invalid-comparison'],
        ],
      );
      assert.deepEqual(result.losers, []);
    } finally {
      cleanup();
    }
  });

  it('holds both sides when the latest comparison is inconclusive', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({
          number: 101,
          headRefName: 'task/foo',
          challengePairId: 'pair-1',
          challenge: true,
        }),
        makeWorkItem({
          number: 102,
          headRefName: 'task/foo-challenger',
          challengePairId: 'pair-1',
          challenge: true,
        }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          timestamp: '2026-07-29T12:00:00Z',
          comparisonOutcome: 'inconclusive',
          terminalReason: 'provenance_validation_failed',
          rationale: 'Same intent executed differently.',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.eligible.length, 0);
      assert.deepEqual(
        result.blocked.map((item) => [item.number, item.reason]).sort((a, b) => a[0] - b[0]),
        [
          [101, 'challenge:pair-unresolved:inconclusive-comparison'],
          [102, 'challenge:pair-unresolved:inconclusive-comparison'],
        ],
      );
      assert.deepEqual(result.losers, []);
    } finally {
      cleanup();
    }
  });

  it('does not mark a PR as a loser when comparison evidence has no concrete winner PR', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/foo',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          winner: 'challenger',
          timestamp: '2026-07-30T12:00:00Z',
          comparisonOutcome: 'forfeit',
          terminalReason: 'primary_eval_hard_failed',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/foo'],
        coolOffSeconds: 0,
      });

      assert.equal(result.eligible.length, 0);
      assert.deepEqual(result.blocked.map((item) => [item.number, item.reason]), [
        [101, 'challenge:pair-unresolved:missing-winner:pair-1'],
      ]);
      assert.deepEqual(result.losers, []);
    } finally {
      cleanup();
    }
  });
});

describe('cool-off window in applyChallengePairGates', () => {
  it('blocks a fresh task PR within the cool-off window', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:05:00Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/fresh',
        createdAt: '2026-04-01T00:03:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:cool-off');
    } finally {
      cleanup();
    }
  });

  it('allows a task PR after the cool-off window expires', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:10:00Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/old-enough',
        createdAt: '2026-04-01T00:03:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.blocked.length, 0);
    } finally {
      cleanup();
    }
  });

  it('skips cool-off when coolOffSeconds is 0', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:00:01Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/fresh',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 0,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });

  it('skips cool-off for non-task branches', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:00:01Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'feature/fresh',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });

  it('skips cool-off when createdAt is invalid', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/bad-date',
        createdAt: 'not-a-date',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => Date.now(),
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });

  it('uses config default when coolOffSeconds not passed in options', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { gate: { coolOffSeconds: 60 } },
    });
    try {
      const now = Date.parse('2026-04-01T00:00:30Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/config-test',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked[0].reason, 'challenge:cool-off');
    } finally {
      cleanup();
    }
  });

  it('branch-pair detection takes precedence over cool-off', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:01:00Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/foo',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      cleanup();
    }
  });
});

describe('unresolvable pair states in applyChallengePairGates', () => {
  it('blocks an orphaned challenge pair with an explicit orphan reason', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/orphaned',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/orphaned',
          updated: '2026-01-01T00:00:00Z',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/orphaned'],
        coolOffSeconds: 0,
        nowMs: () => Date.parse('2026-07-17T00:00:00Z'),
      });

      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:orphan-sibling');
    } finally {
      cleanup();
    }
  });

  it('blocks a pair when the sibling exhausted eval hard-failure retries', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { eval: { hardFailureRetryMaxAttempts: 2 } },
    });
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:sibling-eval-hard-failed');
    } finally {
      cleanup();
    }
  });

  it('keeps hard-failure retries independent from soft eval relaunch retries', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { eval: { retryMaxAttempts: 99 } },
    });
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:sibling-eval-hard-failed');
    } finally {
      cleanup();
    }
  });

  it('uses hard-failure config before classifying retries as exhausted', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { eval: { hardFailureRetryMaxAttempts: 3 } },
    });
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const pending = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });
      assert.equal(pending.blocked[0].reason, 'challenge:pair-unresolved:no-comparison');

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalFailed: true,
          evalHardFailureRetryCount: 3,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const exhausted = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });
      assert.equal(exhausted.blocked[0].reason, 'challenge:pair-unresolvable:sibling-eval-hard-failed');
    } finally {
      cleanup();
    }
  });

  it('lets hard-failure env override repo config', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { eval: { hardFailureRetryMaxAttempts: 5 } },
    });
    const previous = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    try {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = '2';
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:sibling-eval-hard-failed');
    } finally {
      if (previous === undefined) {
        delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
      } else {
        process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previous;
      }
      cleanup();
    }
  });

  // Regression: a terminal launch failure (unknown model ID, prompt larger than
  // the context window) means the arm never produces a PR, so no eval ever runs
  // and the eval-based hard-failure signals stay silent. Before this, such a
  // pair sat at `pair-unresolved:no-comparison` indefinitely and its sibling's
  // green PR could never leave the merge lane.
  it('treats a terminally aborted challenger as unresolvable, not merely unresolved', async () => {
    const { repoDir, cleanup } = setupRepoDir({});
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          // No PR: the launch died before producing one.
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          challengeAborted: 'terminal_launch_failure:invalid-model-id',
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:sibling-challenge-aborted');
    } finally {
      cleanup();
    }
  });

  // Regression: post-review cleanup deletes a completed task's local branch and
  // worktree but leaves the remote ref. Treating that leftover as a live sibling
  // kept the survivor's PR at `pair-unresolved:no-comparison` forever instead of
  // reaching a terminal state. Observed on HOK-2767 / PR #1130 on 2026-08-17.
  it('treats a cleaned-up sibling as settled, not live, despite the stale remote ref', async () => {
    const { repoDir, cleanup } = setupRepoDir({});
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary-challenger',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      // Only the challenger remains in workflow state: the primary completed and
      // was cleaned up. Its remote ref is still present.
      writeWorkflowState(repoDir, {
        HOK_1_c: {
          pr: 101,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
        nowMs: () => Date.parse('2026-07-01T01:00:00Z'),
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:orphan-sibling');
    } finally {
      cleanup();
    }
  });

  // The counterpart: a sibling that really is still working must keep blocking.
  it('treats a sibling tracked without a PR as live', async () => {
    const { repoDir, cleanup } = setupRepoDir({});
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary-challenger',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1_c: {
          pr: 101,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          updated: '2026-07-01T00:00:00Z',
        },
        // Sibling is in flight: tracked, no PR yet.
        HOK_1: {
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
        nowMs: () => Date.parse('2026-07-01T01:00:00Z'),
      });

      // Not orphan-sibling: the in-flight primary is still a live arm.
      assert.notEqual(result.blocked[0].reason, 'challenge:pair-unresolvable:orphan-sibling');
    } finally {
      cleanup();
    }
  });

  it('blocks a pair when both sides exhausted eval hard-failure retries', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { eval: { hardFailureRetryMaxAttempts: 2 } },
    });
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolvable:both-eval-hard-failed');
    } finally {
      cleanup();
    }
  });

  it('reports comparison-in-progress when the comparison job is still running', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          updated: '2026-07-01T00:00:00Z',
        },
      }, {
        'comparison-pair-1-101-102': {
          id: 'comparison-pair-1-101-102',
          kind: 'comparison',
          pairId: 'pair-1',
          prNumbers: [101, 102],
          pid: 123,
          startedAt: '2026-07-01T00:00:00Z',
          timeoutSeconds: 240,
          logPath: '/tmp/comparison.log',
          resultPath: '/tmp/comparison.result.json',
          status: 'running',
          exitCode: null,
          finishedAt: null,
          reason: null,
          excerpt: null,
          settled: false,
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:comparison-in-progress');
    } finally {
      cleanup();
    }
  });

  it('keeps the legacy no-comparison reason when the pair is still waiting to launch', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
        HOK_1_c: {
          pr: 102,
          branch: 'task/pair-primary-challenger',
          challengePairId: 'pair-1',
          challengeRole: 'challenger',
          evalCompleted: true,
          updated: '2026-07-01T00:00:00Z',
        },
      });

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
        coolOffSeconds: 0,
      });

      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:no-comparison');
    } finally {
      cleanup();
    }
  });
});

describe('git ls-remote failure fallback', () => {
  it('uses empty branch list when listRemoteBranches fails', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/solo',
        createdAt: '2020-01-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });
});

describe('HOK-2602: Regression tests for invalid comparison auto-close', () => {
  it('never closes on double-forfeit record', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({ number: 101, challengePairId: 'pair-1', challenge: true }),
        makeWorkItem({ number: 102, challengePairId: 'pair-1', challenge: true }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });

      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          comparisonOutcome: 'double-forfeit',
          timestamp: '2026-07-30T12:00:00Z',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/test-pr'],
        coolOffSeconds: 0,
      });

      assert.deepEqual(result.losers, []);
      assert.equal(result.loserCleanupCandidates.length, 0);
      // Both should be blocked with unresolved state, not marked as losers
      assert.deepEqual(
        result.blocked.map((b) => b.reason).filter((r) => r.includes('loser')),
        [],
      );
    } finally {
      cleanup();
    }
  });

  it('never closes on invalid comparison outcome', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({ number: 101, challengePairId: 'pair-1', challenge: true }),
        makeWorkItem({ number: 102, challengePairId: 'pair-1', challenge: true }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });

      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          comparisonOutcome: 'invalid',
          timestamp: '2026-07-30T12:00:00Z',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/test-pr'],
        coolOffSeconds: 0,
      });

      assert.deepEqual(result.losers, []);
      assert.equal(result.loserCleanupCandidates.length, 0);
    } finally {
      cleanup();
    }
  });

  it('never closes on inconclusive comparison outcome', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({ number: 101, challengePairId: 'pair-1', challenge: true }),
        makeWorkItem({ number: 102, challengePairId: 'pair-1', challenge: true }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });

      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          comparisonOutcome: 'inconclusive',
          timestamp: '2026-07-30T12:00:00Z',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/test-pr'],
        coolOffSeconds: 0,
      });

      assert.deepEqual(result.losers, []);
      assert.equal(result.loserCleanupCandidates.length, 0);
    } finally {
      cleanup();
    }
  });

  it('only closes identified loser when comparison is valid and decisive', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [
        makeWorkItem({ number: 101, challengePairId: 'pair-1', challenge: true }),
        makeWorkItem({ number: 102, challengePairId: 'pair-1', challenge: true }),
      ];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });

      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          winner: 'primary',
          comparisonOutcome: 'compared',
          timestamp: '2026-07-30T12:00:00Z',
        }),
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: ['task/test-pr'],
        coolOffSeconds: 0,
      });

      // Only the loser (challenger) should be marked for cleanup
      assert.deepEqual(result.losers, [102]);
      assert.equal(result.loserCleanupCandidates.length, 1);
      assert.equal(result.loserCleanupCandidates[0].loserPr, 102);
      assert.equal(result.loserCleanupCandidates[0].winnerPr, 101);
      assert.equal(result.loserCleanupCandidates[0].pairId, 'pair-1');
    } finally {
      cleanup();
    }
  });

  it('never closes a lone primary PR merely because challenge metadata exists', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/pair-primary',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: {
          pr: 101,
          branch: 'task/pair-primary',
          challengePairId: 'pair-1',
          challengeRole: 'primary',
        },
      });

      // No challenge comparison record at all
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        '', // Empty
      );

      const result = await applyChallengePairGates(items, [], repoDir, {
        remoteBranches: [],
        coolOffSeconds: 0,
      });

      assert.deepEqual(result.losers, []);
      assert.equal(result.loserCleanupCandidates.length, 0);
      // Should be blocked waiting for comparison, not marked as loser
      assert(result.blocked.some((b) => b.number === 101));
    } finally {
      cleanup();
    }
  });
});
