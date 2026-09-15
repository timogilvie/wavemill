import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupTerminalInbox,
  decideTerminalTask,
  type CleanupDeps,
  type WorkflowState,
} from '../shared/lib/terminal-inbox-cleanup.ts';

function mergedPr(number: string, head = 'pr-head', base = 'auto/integration') {
  return JSON.stringify({ number: Number(number), state: 'MERGED', mergedAt: '2026-09-01T12:00:00Z', headRefOid: head, headRefName: 'task/demo', baseRefName: base, mergeCommit: { oid: 'merge-sha' } });
}

function closedPr(number: string, head = 'local-head') {
  return JSON.stringify({ number: Number(number), state: 'CLOSED', mergedAt: null, headRefOid: head, headRefName: 'task/demo', baseRefName: 'auto/integration', mergeCommit: null });
}

function deps(overrides: Partial<CleanupDeps> & { prs?: Record<string, string>; cherry?: string; cleanupCalls?: string[] } = {}): CleanupDeps {
  const prs = overrides.prs ?? {};
  return {
    now: overrides.now ?? (() => '2026-09-14T12:00:00.000Z'),
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
    cleanup: overrides.cleanup ?? ((decision) => {
      overrides.cleanupCalls?.push(decision.issue);
    }),
  };
}

function state(task: Record<string, unknown>, sibling?: Record<string, unknown>): WorkflowState {
  return {
    session: 'cleanup-test',
    tasks: {
      'HOK-3005': {
        slug: 'demo',
        branch: 'task/demo',
        worktree: '/tmp/demo',
        pr: '101',
        status: 'merged',
        phase: 'done',
        lifecycle: {
          workflowOutcome: 'merged',
          resourceDisposition: 'retained',
          launchContract: { baseBranch: 'auto/integration', runEpoch: 'epoch-1' },
        },
        ...task,
      },
      ...(sibling ? { 'HOK-3005_c': sibling } : {}),
    },
  };
}

test('merged rebased patch-equivalent task is eligible to reap', () => {
  const decision = decideTerminalTask(state({}), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 101: mergedPr('101') }, cherry: '- abc\n- def\n' }));
  assert.equal(decision.status, 'would-reap');
  assert.equal(decision.git.patchEquivalent, true);
});

test('merged task with unique local patch is refused', () => {
  const decision = decideTerminalTask(state({}), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 101: mergedPr('101') }, cherry: '- abc\n+ def\n' }));
  assert.equal(decision.status, 'refused');
  assert.equal(decision.refusalReason, 'unique_local_patch');
});

test('closed loser requires explicit abandon and merged sibling', () => {
  const sibling = { slug: 'winner', branch: 'task/winner', worktree: '/tmp/winner', pr: '102', status: 'merged' };
  const task = { status: 'closed', phase: 'closed', challenge: true, challengeRole: 'primary', challengePairId: 'HOK-3005' };
  const withoutAbandon = decideTerminalTask(state(task, sibling), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 101: closedPr('101'), 102: mergedPr('102') } }), false);
  assert.equal(withoutAbandon.status, 'refused');
  assert.equal(withoutAbandon.refusalReason, 'closed_loser_requires_abandon');

  const withAbandon = decideTerminalTask(state(task, sibling), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 101: closedPr('101'), 102: mergedPr('102') } }), true);
  assert.equal(withAbandon.status, 'would-abandon-loser');
  assert.ok(withAbandon.intendedActions.includes('retain-remote-branch'));
});

test('bulk execute skips open and active tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-terminal-inbox-'));
  try {
    const stateFile = join(root, '.wavemill', 'workflow-state.json');
    mkdirSync(join(root, '.wavemill'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      tasks: {
        'HOK-3005': state({}).tasks!['HOK-3005'],
        'HOK-3006': { slug: 'active', branch: 'task/active', worktree: '/tmp/active', pr: '103', status: 'active', phase: 'coding' },
      },
    }));
    const cleanupCalls: string[] = [];
    const decisions = await cleanupTerminalInbox({
      repoDir: root,
      stateFile,
      inbox: true,
      execute: true,
      deps: deps({ prs: { 101: mergedPr('101'), 103: JSON.stringify({ number: 103, state: 'OPEN', mergedAt: null, headRefOid: 'x', baseRefName: 'auto/integration', mergeCommit: null }) }, cleanupCalls }),
    });
    assert.deepEqual(cleanupCalls, ['HOK-3005']);
    assert.equal(decisions.length, 1);
    const written = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.ok(written.terminalTaskTombstones);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
