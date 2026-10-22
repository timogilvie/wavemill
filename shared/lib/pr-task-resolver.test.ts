import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';
import {
  resolvePrTask,
  resolveTaskLocation,
  resolveBranchTask,
  type ResolveLogger,
} from './pr-task-resolver.ts';

function captureLogger(): { warnings: Array<{ msg: string; meta?: unknown }>; logger: ResolveLogger } {
  const warnings: Array<{ msg: string; meta?: unknown }> = [];
  return {
    warnings,
    logger: {
      warn: (msg, meta) => warnings.push({ msg, meta }),
    },
  };
}

describe('resolvePrTask', () => {
  it('reports state-unavailable when state is null', () => {
    const { warnings, logger } = captureLogger();
    const result = resolvePrTask(123, null, { site: 'test.site', logger });
    assert.equal(result.location, null);
    assert.equal(result.miss?.reason, 'state-unavailable');
    assert.deepEqual(result.miss?.key, { kind: 'pr', prNumber: 123 });
    assert.equal(result.miss?.site, 'test.site');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].msg, /site=test\.site/);
    assert.match(warnings[0].msg, /key=pr:123/);
    assert.match(warnings[0].msg, /reason=state-unavailable/);
  });

  it('reports state-unavailable when state has no tasks', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({});
    const result = resolvePrTask(123, state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'state-unavailable');
    assert.equal(warnings.length, 1);
  });

  it('reports no-task-matched when no task has that PR', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const state = buildWorkflowState({
      'HOK-1': { pr: '42', slug: 'some-feature', worktree, phase: 'planning' },
    });
    const result = resolvePrTask(999, state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });

  it('reports no-worktree-or-slug when matching task has blank slug', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const state = buildWorkflowState({
      'HOK-1': { pr: '42', slug: '', worktree, phase: 'planning' },
    });
    const result = resolvePrTask(42, state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'no-worktree-or-slug');
    assert.match(result.miss?.detail ?? '', /taskId=HOK-1/);
    assert.equal(warnings.length, 1);
  });

  it('reports no-worktree-or-slug when matching task has blank worktree', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': { pr: '42', slug: 'some', worktree: '', phase: 'planning' },
    });
    const result = resolvePrTask(42, state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'no-worktree-or-slug');
    assert.equal(warnings.length, 1);
  });

  it('returns a location pointing at features/<slug> when it exists', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'some-feature';
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-1': { pr: '42', slug, worktree, phase: 'ready' },
    });
    const result = resolvePrTask(42, state, { site: 'test.site', logger });
    assert.equal(result.miss, null);
    assert.ok(result.location);
    assert.equal(result.location.taskId, 'HOK-1');
    assert.equal(result.location.slug, slug);
    assert.equal(result.location.worktree, worktree);
    assert.equal(result.location.featureDir, join(worktree, 'features', slug));
    assert.equal(result.location.stateDir, result.location.featureDir);
    assert.equal(result.location.prNumber, 42);
    assert.equal(warnings.length, 0);
  });

  it('returns a location pointing at bugs/<slug> when features/<slug> does not exist', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'some-bug';
    mkdirSync(join(worktree, 'bugs', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-2': { pr: '7', slug, worktree, phase: 'ready' },
    });
    const result = resolvePrTask(7, state, { site: 'test.site', logger });
    assert.ok(result.location);
    assert.equal(result.location.featureDir, join(worktree, 'bugs', slug));
    assert.equal(warnings.length, 0);
  });

  it('falls back to features/<slug> when neither exists on disk', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'unmaterialized';
    const state = buildWorkflowState({
      'HOK-3': { pr: '7', slug, worktree, phase: 'planning' },
    });
    const result = resolvePrTask(7, state, { site: 'test.site', logger });
    assert.ok(result.location);
    assert.equal(result.location.featureDir, join(worktree, 'features', slug));
    assert.equal(warnings.length, 0);
  });

  it('fallbackTaskKey matches a row whose PR number does not match', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'some-feature';
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-1': { pr: '', slug, worktree, phase: 'ready' },
    });
    const result = resolvePrTask(42, state, {
      site: 'test.site',
      logger,
      fallbackTaskKey: 'HOK-1',
    });
    assert.ok(result.location);
    assert.equal(result.location.taskId, 'HOK-1');
    assert.equal(warnings.length, 0);
  });

  it('fallbackTaskKey does not match when the id is unknown', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': { pr: '', slug: 's', worktree: '/tmp/w', phase: 'planning' },
    });
    const result = resolvePrTask(42, state, {
      site: 'test.site',
      logger,
      fallbackTaskKey: 'HOK-9999',
    });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });

  it('a zero PR number without fallbackTaskKey never matches', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': { pr: '', slug: 's', worktree: '/tmp/w', phase: 'planning' },
    });
    const result = resolvePrTask(0, state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });

  it('fallbackBranch matches a row whose PR number does not match', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'branch-fallback';
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-1': { pr: '', slug, worktree, phase: 'ready', branch: 'task/branch-fallback' },
    });
    const result = resolvePrTask(42, state, {
      site: 'test.site',
      logger,
      fallbackBranch: 'task/branch-fallback',
    });
    assert.ok(result.location);
    assert.equal(result.location.taskId, 'HOK-1');
    assert.equal(warnings.length, 0);
  });

  it('misses on both PR and fallbackBranch emit a single structured miss log', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': { pr: '7', slug: 's', worktree: '/tmp/w', phase: 'planning', branch: 'task/other' },
    });
    const result = resolvePrTask(999, state, {
      site: 'test.site',
      logger,
      fallbackBranch: 'task/missing',
    });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });

  it('matchLifecycleDeliveryPr matches a row with task.lifecycle.deliveryEvidence.prNumber', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'lifecycle-pr';
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-1': {
        pr: '',
        slug,
        worktree,
        phase: 'ready',
        lifecycle: {
          schemaVersion: 1,
          workflowOutcome: 'active',
          resourceDisposition: 'allocated',
          deliveryEvidence: { prNumber: '42' },
        },
      },
    });
    const result = resolvePrTask(42, state, {
      site: 'test.site',
      logger,
      matchLifecycleDeliveryPr: true,
    });
    assert.ok(result.location);
    assert.equal(result.location.taskId, 'HOK-1');
    assert.equal(warnings.length, 0);
  });

  it('matchLifecycleDeliveryPr disabled does not match lifecycle PR', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': {
        pr: '',
        slug: 's',
        worktree: '/tmp/w',
        phase: 'ready',
        lifecycle: {
          schemaVersion: 1,
          workflowOutcome: 'active',
          resourceDisposition: 'allocated',
          deliveryEvidence: { prNumber: '42' },
        },
      },
    });
    const result = resolvePrTask(42, state, {
      site: 'test.site',
      logger,
      matchLifecycleDeliveryPr: false,
    });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });

  it('matchLifecycleDeliveryPr defaults to false (backwards compatible)', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': {
        pr: '',
        slug: 's',
        worktree: '/tmp/w',
        phase: 'ready',
        lifecycle: {
          schemaVersion: 1,
          workflowOutcome: 'active',
          resourceDisposition: 'allocated',
          deliveryEvidence: { prNumber: '42' },
        },
      },
    });
    const result = resolvePrTask(42, state, {
      site: 'test.site',
      logger,
      // matchLifecycleDeliveryPr not set, should default to false
    });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });
});

describe('resolveTaskLocation', () => {
  it('reports state-unavailable when state is null', () => {
    const { warnings, logger } = captureLogger();
    const result = resolveTaskLocation('HOK-1', null, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'state-unavailable');
    assert.deepEqual(result.miss?.key, { kind: 'task', taskId: 'HOK-1' });
    assert.equal(warnings.length, 1);
  });

  it('returns a location when the task id exists', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'resolve-task';
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-1': { pr: '99', slug, worktree, phase: 'ready' },
    });
    const result = resolveTaskLocation('HOK-1', state, { site: 'test.site', logger });
    assert.equal(result.miss, null);
    assert.ok(result.location);
    assert.equal(result.location.taskId, 'HOK-1');
    assert.equal(result.location.prNumber, 99);
    assert.equal(warnings.length, 0);
  });

  it('reports no-task-matched when id is unknown', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': { pr: '99', slug: 's', worktree: '/tmp/w', phase: 'planning' },
    });
    const result = resolveTaskLocation('HOK-9999', state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });
});

describe('resolveBranchTask', () => {
  it('reports state-unavailable when state is null', () => {
    const { warnings, logger } = captureLogger();
    const result = resolveBranchTask('task/foo', null, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'state-unavailable');
    assert.deepEqual(result.miss?.key, { kind: 'branch', branch: 'task/foo' });
    assert.equal(warnings.length, 1);
  });

  it('returns a location when the branch matches', () => {
    const { warnings, logger } = captureLogger();
    const worktree = mkdtempSync(join(tmpdir(), 'pr-task-resolver-'));
    const slug = 'branch-match';
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    const state = buildWorkflowState({
      'HOK-1': { pr: '12', slug, worktree, phase: 'ready', branch: 'task/branch-match' },
    });
    const result = resolveBranchTask('task/branch-match', state, { site: 'test.site', logger });
    assert.equal(result.miss, null);
    assert.ok(result.location);
    assert.equal(result.location.taskId, 'HOK-1');
    assert.equal(warnings.length, 0);
  });

  it('reports no-task-matched when no row has that branch', () => {
    const { warnings, logger } = captureLogger();
    const state = buildWorkflowState({
      'HOK-1': { pr: '12', slug: 's', worktree: '/tmp/w', phase: 'planning', branch: 'task/other' },
    });
    const result = resolveBranchTask('task/missing', state, { site: 'test.site', logger });
    assert.equal(result.miss?.reason, 'no-task-matched');
    assert.equal(warnings.length, 1);
  });
});
