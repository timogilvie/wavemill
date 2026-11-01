/**
 * HOK-3373: the readers of a settled attempt.
 *
 * - `task-worktree-resolver.ts`: only a registered worktree permits
 *   `git -C`; everything else is unknown (the HOK-2595 fall-through).
 * - `linear-state-renderer.ts`: Linear is a render of the settled run.
 * - `selectLaunchSet`: an in-flight task with an unknown touch set holds
 *   candidates instead of touching nothing.
 * - `decideTerminalTask`: the positive-evidence reap for absent resources.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { linearSyncPending, renderLinearState } from './linear-state-renderer.ts';
import { selectLaunchSet } from './plan-queue-utils.ts';
import { resolveTaskWorktree, taskWorktreePathStatus } from './task-worktree-resolver.ts';
import { decideTerminalTask, otherRowOwningResources, type CleanupDeps } from './terminal-inbox-cleanup.ts';
import { parseInFlightJson } from './in-flight-touch-sets.ts';
import { buildTask, buildWorkflowState } from '../../tests/lib/task-builder.ts';

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'settled-readers-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', join(root, 'wt-live'), '-b', 'task/live');
  mkdirSync(join(root, 'wt-plain', 'features', 'x'), { recursive: true });
  writeFileSync(join(root, 'wt-plain', 'features', 'x', '.ready-bypass-warned'), '');
  const other = join(root, 'other');
  mkdirSync(other);
  git(other, 'init', '-q');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('task-worktree-resolver', () => {
  // protects: a dead task's recreated directory resolving to the main checkout's files (HOK-2595).
  it('resolves only a registered worktree of the repo', () => {
    assert.equal(taskWorktreePathStatus(repo, join(root, 'wt-live')).status, 'registered');
    assert.equal(taskWorktreePathStatus(repo, join(root, 'wt-gone')).status, 'missing');
    const plain = taskWorktreePathStatus(repo, join(root, 'wt-plain'));
    assert.deepEqual(plain, { status: 'invalid', detail: 'no_git_entry' });
    assert.equal(taskWorktreePathStatus(repo, repo).status, 'protected');
    assert.equal(taskWorktreePathStatus(repo, join(root, 'other')).status, 'invalid');
    assert.equal(taskWorktreePathStatus(repo, '').status, 'none');
  });

  // protects: the plain-directory check spawning git (and so falling through) anyway.
  it('never runs git for a path with no .git entry', () => {
    let calls = 0;
    const probe = () => { calls += 1; return repo; };
    assert.equal(taskWorktreePathStatus(repo, join(root, 'wt-plain'), probe).status, 'invalid');
    assert.equal(calls, 0);
  });

  // protects: the resolver reading a path from somewhere other than the row.
  it('resolves from the task row and carries its run id', () => {
    const state = buildWorkflowState({ 'HOK-1': { worktree: join(root, 'wt-live'), runId: 'HOK-1:e:1' }, 'HOK-2': { worktree: join(root, 'wt-gone') } });
    assert.deepEqual(
      { ...resolveTaskWorktree(repo, 'HOK-1', { state }) },
      { issue: 'HOK-1', path: join(root, 'wt-live'), status: 'registered', runId: 'HOK-1:e:1' },
    );
    assert.equal(resolveTaskWorktree(repo, 'HOK-2', { state }).status, 'missing');
    assert.equal(resolveTaskWorktree(repo, 'HOK-9', { state }).status, 'none');
  });
});

describe('linear-state-renderer', () => {
  const lifecycle = (workflowOutcome: string) => ({ schemaVersion: 1 as const, workflowOutcome: workflowOutcome as 'merged', resourceDisposition: 'reaping' as const });

  // protects: delivered work rendering anything but Done (the exit-trap Backlog flips).
  it('renders a delivered run Done and leaves the rest to the reconciler', () => {
    assert.equal(renderLinearState('HOK-1', { lifecycle: lifecycle('merged') }), 'Done');
    assert.equal(renderLinearState('HOK-1', { lifecycle: lifecycle('closed'), status: 'completed-external' }), 'Done');
    assert.equal(renderLinearState('HOK-1', { lifecycle: lifecycle('aborted') }), null);
    assert.equal(renderLinearState('HOK-1', { lifecycle: lifecycle('active') }), null);
    assert.equal(renderLinearState('HOK-1_c', { lifecycle: lifecycle('merged') }), null, 'challengers never write Linear');
    assert.equal(renderLinearState('HOK-1', { lifecycle: lifecycle('merged'), challengeRole: 'challenger' }), null);
  });

  // protects: a crash between settlement and the Linear write never converging.
  it('reports a pending sync until the rendered state is recorded', () => {
    assert.equal(linearSyncPending('HOK-1', { lifecycle: lifecycle('merged') }), true);
    assert.equal(linearSyncPending('HOK-1', { lifecycle: lifecycle('merged'), linearSyncedState: 'Done' }), false);
    assert.equal(linearSyncPending('HOK-1', { lifecycle: lifecycle('aborted') }), false);
  });
});

describe('picker: unknown in-flight touch set', () => {
  const plan = { availableNow: ['HOK-10', 'HOK-11'], queuedAfterDependencies: [], avoidRunningTogether: [], needsTriage: [] };
  const tasks = [{ id: 'HOK-10', score: 10 }, { id: 'HOK-11', score: 5 }];

  // protects: an active task with a missing worktree being treated as touching nothing.
  it('holds every candidate against an in-flight task whose touch set is unknown', () => {
    const inFlight = parseInFlightJson(JSON.stringify([{ id: 'HOK-1', prNumber: 7, files: [], touchSet: 'unknown' }]), 'test');
    const set = selectLaunchSet(plan, tasks, { freeSlots: 2, inFlight });
    assert.deepEqual(set.launchNext, []);
    assert.deepEqual(set.held.map((h) => [h.id, h.reason]), [['HOK-10', 'conflicts_with_in_flight'], ['HOK-11', 'conflicts_with_in_flight']]);
    assert.deepEqual(set.held[0]!.detail, { kind: 'conflicts_with_in_flight', taskId: 'HOK-1', prNumber: 7, files: [], touchSetUnknown: true });
  });

  // protects: a known-empty touch set holding the picker (the settled exclusion's other half).
  it('launches when the in-flight touch set is known', () => {
    const set = selectLaunchSet(plan, tasks, { freeSlots: 2, inFlight: [{ id: 'HOK-1', files: [] }] });
    assert.deepEqual(set.launchNext, ['HOK-10', 'HOK-11']);
  });
});

describe('positive-evidence reap for absent resources', () => {
  const merged = (overrides: Record<string, unknown> = {}) => buildTask({
    slug: 'demo', branch: 'task/demo', worktree: '/tmp/gone-demo', pr: '101', status: 'merged', phase: 'done',
    lifecycle: { schemaVersion: 1, workflowOutcome: 'merged', resourceDisposition: 'reaping', launchContract: { baseBranch: 'main', remoteBranchDeletionPolicy: { allowed: true } } },
    ...overrides,
  });
  const deps = (classification: string): CleanupDeps => ({
    now: () => '2026-11-01T00:00:00.000Z',
    gh: () => JSON.stringify({ number: 101, state: 'MERGED', mergedAt: '2026-10-13T00:00:00Z', headRefOid: 'h', headRefName: 'task/demo', baseRefName: 'main', mergeCommit: { oid: 'm' } }),
    git: () => '',
    classify: () => ({ classification, verificationReason: '', worktreeIdentity: '', verifiedTopLevel: '', cleanupAuthority: 'resources absent', patchEquivalenceScope: '' }),
    cleanup: () => undefined,
  } as any as CleanupDeps);

  // protects: a delivered row whose worktree and branch are gone never leaving state (HOK-2595 safe_noop).
  it('reaps a delivered row whose local resources are gone', () => {
    const decision = decideTerminalTask(buildWorkflowState({ 'HOK-1': merged() }), 'HOK-1', repo, 'main', deps('safe_resources_absent'));
    assert.equal(decision.status, 'would-reap');
    assert.deepEqual(decision.intendedActions, ['archive-artifacts', 'release-pane', 'write-tombstone', 'remove-active-task-row']);
  });

  // protects: reaping a row whose PR or worktree another live row still owns.
  it('refuses when ownership is not proven', () => {
    const state = buildWorkflowState({ 'HOK-1': merged(), 'HOK-2': buildTask({ pr: '101', worktree: '/tmp/elsewhere' }) });
    assert.equal(otherRowOwningResources(state, 'HOK-1', '101', '/tmp/gone-demo'), 'HOK-2');
    const decision = decideTerminalTask(state, 'HOK-1', repo, 'main', deps('safe_resources_absent'));
    assert.equal(decision.status, 'refused');
    assert.equal(decision.refusalReason, 'resources_owned_by:HOK-2');
  });

  // protects: safe_noop (protected / non-task branch) being reaped as if resources were proven absent.
  it('keeps safe_noop out of the reap list', () => {
    const decision = decideTerminalTask(buildWorkflowState({ 'HOK-1': merged({ branch: 'main' }) }), 'HOK-1', repo, 'main', deps('safe_noop'));
    assert.equal(decision.status, 'refused');
  });
});
