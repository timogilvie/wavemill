import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupTerminalInbox,
  defaultCleanupDeps,
  decideTerminalTask,
  type CleanupDeps,
  type TerminalInboxDecision,
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

test('default cleanup shell defines logging functions for the terminal reconciler', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-terminal-logging-'));
  try {
    const libDir = join(root, 'shared', 'lib');
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, 'wavemill-common.sh'), 'cleanup_completed_task() { log debug "starting"; log_warn "done"; }\n');
    writeFileSync(join(libDir, 'terminal-reconciler.sh'), '');
    assert.doesNotThrow(() => defaultCleanupDeps.cleanup(
      { issue: 'HOK-3005', slug: 'demo' } as TerminalInboxDecision,
      { repoDir: root, stateFile: join(root, 'state.json'), baseBranch: 'auto/integration', session: 'test', abandon: false, wavemillLibDir: libDir },
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merged task with unique local patch is refused', () => {
  const decision = decideTerminalTask(state({}), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 101: mergedPr('101') }, cherry: '- abc\n+ def\n' }));
  assert.equal(decision.status, 'refused');
  assert.equal(decision.refusalReason, 'unique_local_patch');
});

test('inbox trusts canonical delivered-content proof over differing patch IDs', () => {
  const decision = decideTerminalTask(state({}), 'HOK-3005', process.cwd(), 'auto/integration', deps({
    prs: { 101: mergedPr('101') },
    cherry: '+ local-commit\n',
    classify: () => ({
      classification: 'safe_content_equivalent_pr', verificationReason: '',
      worktreeIdentity: 'valid', verifiedTopLevel: '/tmp/demo',
      cleanupAuthority: 'unchanged merge tree', patchEquivalenceScope: 'whole_branch',
    }),
  }));
  assert.equal(decision.status, 'would-reap');
  assert.equal(decision.git.classifierVerdict, 'safe_content_equivalent_pr');
  assert.equal(decision.git.patchEquivalent, false);
});

test('inbox uses canonical orphan classification without checking parent repository dirt', () => {
  let statusCalled = false;
  const decision = decideTerminalTask(state({ worktree: '/tmp/orphan-task' }), 'HOK-3005', process.cwd(), 'auto/integration', deps({
    prs: { 101: mergedPr('101') },
    git: (args) => {
      if (args.includes('status')) statusCalled = true;
      if (args[0] === 'show-ref') return '';
      if (args[0] === 'rev-parse') return 'local-head';
      if (args[0] === 'rev-list') return '1';
      if (args[0] === 'cherry') return '+ local-commit';
      return '';
    },
    classify: () => ({
      classification: 'safe_terminal_pr_head', verificationReason: '',
      worktreeIdentity: 'toplevel_mismatch:/tmp', verifiedTopLevel: '',
      cleanupAuthority: 'merged PR head', patchEquivalenceScope: '',
    }),
  }));
  assert.equal(decision.status, 'would-reap');
  assert.equal(statusCalled, false);
});

test('canonical classifier refuses genuinely unique content', () => {
  const decision = decideTerminalTask(state({}), 'HOK-3005', process.cwd(), 'auto/integration', deps({
    prs: { 101: mergedPr('101') },
    classify: () => ({
      classification: 'retain_unpublished', verificationReason: 'unique_local_patch',
      worktreeIdentity: 'valid', verifiedTopLevel: '/tmp/demo',
      cleanupAuthority: '', patchEquivalenceScope: 'whole_branch',
    }),
  }));
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

function prLessGit(options: { published?: boolean; dirty?: boolean } = {}): CleanupDeps['git'] {
  return (args) => {
    const key = args.join(' ');
    if (key.includes('status --porcelain')) return options.dirty ? ' M src/file.ts\n' : '';
    if (key.startsWith('show-ref --verify')) return '';
    if (key.startsWith('rev-parse --verify task/')) return 'local-head\n';
    if (key.startsWith('rev-parse --verify refs/remotes/origin/task/')) {
      if (options.published) return 'local-head\n';
      throw new Error('remote branch missing');
    }
    if (key.startsWith('rev-list --count')) return '1\n';
    if (key.startsWith('cherry ')) return '+ abc\n';
    return '';
  };
}

test('PR-less aborted arm with unpublished head requires abandon and archives first (HOK-3089)', () => {
  const sibling = { slug: 'winner', branch: 'task/winner', worktree: '/tmp/winner', pr: '102', status: 'merged' };
  const task = { pr: '', status: 'aborted', phase: 'aborted', challenge: true, challengeRole: 'primary', challengePairId: 'HOK-3005', lifecycle: { workflowOutcome: 'aborted', launchContract: { baseBranch: 'auto/integration' } } };
  const withoutAbandon = decideTerminalTask(state(task, sibling), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 102: mergedPr('102') }, git: prLessGit() }), false);
  assert.equal(withoutAbandon.status, 'refused');
  assert.equal(withoutAbandon.refusalReason, 'aborted_pr_less_requires_abandon');

  const withAbandon = decideTerminalTask(state(task, sibling), 'HOK-3005', process.cwd(), 'auto/integration', deps({ prs: { 102: mergedPr('102') }, git: prLessGit() }), true);
  assert.equal(withAbandon.status, 'would-abandon-aborted');
  assert.equal(withAbandon.intendedActions[0], 'archive-unpublished-head');
  assert.equal(withAbandon.siblingPrState, 'MERGED');
});

test('PR-less aborted arm whose head is published reaps without abandon (HOK-3089)', () => {
  const task = { pr: '', status: 'aborted', phase: 'aborted', lifecycle: { workflowOutcome: 'aborted' } };
  const decision = decideTerminalTask(state(task), 'HOK-3005', process.cwd(), 'auto/integration', deps({ git: prLessGit({ published: true }) }), false);
  assert.equal(decision.status, 'would-reap');
  assert.ok(!decision.intendedActions.includes('archive-unpublished-head'));
});

test('PR-less aborted arm with a dirty worktree is refused even with abandon (HOK-3089)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-pr-less-dirty-'));
  try {
    const task = { pr: '', worktree: root, status: 'aborted', phase: 'aborted', lifecycle: { workflowOutcome: 'aborted' } };
    const decision = decideTerminalTask(state(task), 'HOK-3005', process.cwd(), 'auto/integration', deps({ git: prLessGit({ dirty: true }) }), true);
    assert.equal(decision.status, 'refused');
    assert.equal(decision.refusalReason, 'dirty_worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute dispatches an abandoned PR-less arm with abandon authority (HOK-3089)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-pr-less-execute-'));
  try {
    const stateFile = join(root, '.wavemill', 'workflow-state.json');
    mkdirSync(join(root, '.wavemill'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state({ pr: '', status: 'aborted', phase: 'aborted', lifecycle: { workflowOutcome: 'aborted' } })));
    const abandonFlags: boolean[] = [];
    const decisions = await cleanupTerminalInbox({
      repoDir: root,
      issue: 'HOK-3005',
      execute: true,
      abandon: true,
      deps: deps({ git: prLessGit(), cleanup: (_decision, context) => { abandonFlags.push(context.abandon); } }),
    });
    assert.equal(decisions[0].status, 'executed');
    assert.deepEqual(abandonFlags, [true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive-and-reap sends a delivered dirty arm to shell without an early tombstone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-archive-reap-'));
  try {
    const stateFile = join(root, '.wavemill', 'workflow-state.json');
    mkdirSync(join(root, '.wavemill'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state({})));
    let invoked = false;
    const decisions = await cleanupTerminalInbox({
      repoDir: root, issue: 'HOK-3005', execute: true, abandon: true, archiveAndReap: true,
      deps: deps({
        prs: { 101: mergedPr('101') },
        classify: () => ({ classification: 'retain_dirty', verificationReason: 'uncommitted_changes',
          worktreeIdentity: 'valid', verifiedTopLevel: '/tmp/demo', cleanupAuthority: '', patchEquivalenceScope: '' }),
        cleanup: () => { invoked = true; },
      }),
    });
    assert.equal(decisions[0].status, 'executed');
    assert.equal(invoked, true);
    const written = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(written.terminalTaskTombstones, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('cleanup accepts a digit-bearing team key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-terminal-inbox-'));
  try {
    const stateFile = join(root, 'workflow-state.json');
    writeFileSync(stateFile, JSON.stringify({ tasks: { 'AB2-1': state({}).tasks!['HOK-3005'] } }));
    const decisions = await cleanupTerminalInbox({
      repoDir: root,
      stateFile,
      issue: 'AB2-1',
      deps: deps({ prs: { 101: mergedPr('101') } }),
    });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].issue, 'AB2-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
