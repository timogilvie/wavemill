#!/usr/bin/env -S npx tsx --test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTerminalTask,
  type CleanupDeps,
  type WorkflowState,
} from './terminal-inbox-cleanup.ts';

function deps(overrides: Partial<CleanupDeps> & { prs?: Record<string, string>; cherry?: string } = {}): CleanupDeps {
  const prs = overrides.prs ?? {};
  return {
    now: overrides.now ?? (() => '2026-09-14T12:00:00.000Z'),
    classify: overrides.classify,
    gh: overrides.gh ?? ((args) => {
      const pr = args[2];
      const value = prs[pr];
      if (!value) throw new Error(`missing pr ${pr}`);
      return value;
    }),
    git: overrides.git ?? ((args) => {
      const key = args.join(' ');
      if (key.includes('status --porcelain')) return '';
      if (key.startsWith('show-ref --verify')) return '';
      if (key.startsWith('rev-parse --verify task/')) return 'local-head\n';
      if (key.startsWith('rev-parse --verify refs/remotes/origin/task/')) return 'local-head\n';
      if (key.startsWith('rev-list --count')) return '1\n';
      if (key.startsWith('cherry ')) return overrides.cherry ?? '- abc\n';
      if (key.startsWith('merge-base --is-ancestor')) return '';
      return '';
    }),
    cleanup: overrides.cleanup ?? (() => {}),
  };
}

function state(task: Record<string, unknown>, sibling?: Record<string, unknown>): WorkflowState {
  return {
    session: 'cleanup-test',
    tasks: {
      'HOK-TEST_c': {
        slug: 'test-task',
        branch: 'task/test-task',
        worktree: '/tmp/test-task',
        status: 'aborted',
        phase: 'aborted',
        challenge: true,
        challengeRole: 'challenger',
        challengePairId: 'HOK-TEST',
        lifecycle: {
          workflowOutcome: 'aborted',
          resourceDisposition: 'retained',
          launchContract: { baseBranch: 'auto/integration', runEpoch: 'epoch-1' },
        },
        ...task,
      },
      ...(sibling ? { 'HOK-TEST': sibling } : {}),
    },
  };
}

test('PR-less aborted task with abandon flag produces would-abandon-aborted status', () => {
  const decision = decideTerminalTask(
    state(
      { pr: '' }, // No PR
      { pr: '101', status: 'merged', phase: 'done' } // Sibling merged
    ),
    'HOK-TEST_c',
    process.cwd(),
    'auto/integration',
    deps({
      gh: () => { throw new Error('PR not found'); }, // gh fails for PR-less task
    }),
    true // allowAbandon = true
  );
  
  assert.equal(decision.status, 'would-abandon-aborted');
  assert.equal(decision.refusalReason, '');
  assert.ok(decision.intendedActions.includes('archive-unpublished-head'));
});

test('PR-less aborted task without abandon flag produces aborted_pr_less_requires_abandon refusal', () => {
  const decision = decideTerminalTask(
    state(
      { pr: '' }, // No PR
      { pr: '101', status: 'merged', phase: 'done' } // Sibling merged
    ),
    'HOK-TEST_c',
    process.cwd(),
    'auto/integration',
    deps({
      gh: () => { throw new Error('PR not found'); }, // gh fails for PR-less task
    }),
    false // allowAbandon = false
  );
  
  assert.equal(decision.status, 'refused');
  assert.equal(decision.refusalReason, 'aborted_pr_less_requires_abandon');
});

test('PR-less aborted task with dirty worktree produces dirty_worktree refusal', () => {
  const decision = decideTerminalTask(
    state(
      { pr: '' }, // No PR
      { pr: '101', status: 'merged', phase: 'done' } // Sibling merged
    ),
    'HOK-TEST_c',
    process.cwd(),
    'auto/integration',
    deps({
      gh: () => { throw new Error('PR not found'); }, // gh fails for PR-less task
      git: (args) => {
        if (args.includes('status --porcelain')) return ' M dirty-file.txt\n';
        if (args[0] === 'show-ref') return '';
        if (args[0] === 'rev-parse') return 'local-head';
        if (args[0] === 'rev-list') return '1';
        return '';
      },
    }),
    true // allowAbandon = true
  );
  
  assert.equal(decision.status, 'refused');
  assert.equal(decision.refusalReason, 'dirty_worktree');
});