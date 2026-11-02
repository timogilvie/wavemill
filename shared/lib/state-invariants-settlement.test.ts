/**
 * HOK-3373: invariants I9 (refused control writes) and I10 (settled
 * non-convergence) in the HOK-3229 evaluator.
 *
 * The rejection log is produced by the real seam (`mutateWorkflowState`), so
 * I9 is driven end to end: a refused control write fires, a late evidence
 * write against the same settled run never does.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createEmptyCache,
  evaluateInvariants,
  type EvaluateInvariantsInputs,
  type InvariantViolation,
  type StateInvariantsCache,
} from './state-invariants.ts';
import { mutatorRejectionsPath, type MutatorRejectionRecord } from './task-settlement.ts';
import { mutateWorkflowState, type WorkflowState } from './workflow-state.ts';
import { buildTask, buildWorkflowState } from '../../tests/lib/task-builder.ts';

const NOW_MS = Date.parse('2026-11-01T12:00:00.000Z');

let repoDir: string;
let statePath: string;

function inputs(state: WorkflowState, extra: Partial<EvaluateInvariantsInputs> = {}): EvaluateInvariantsInputs {
  return {
    state,
    taskProgress: new Map(),
    prs: [],
    taskViews: new Map(),
    liveStates: new Map(),
    conditionSidecars: [],
    retrySentinels: [],
    waitingOnByTaskId: new Map(),
    cache: createEmptyCache(),
    stateInspection: {
      worktreeHeadsByTaskId: new Map(),
      operatorEventSeqByTaskId: new Map(),
      prHeadByNumber: new Map(),
      prNumberByTaskId: new Map(),
      nowMs: NOW_MS,
    },
    tendHeartbeat: null,
    ...extra,
  };
}

const ours = (violations: InvariantViolation[]) =>
  violations.filter((v) => v.invariantId === 'I9-rejected-control-write' || v.invariantId === 'I10-settled-non-convergence');

function mergedTask(overrides: Record<string, unknown> = {}) {
  return buildTask({
    slug: 'one', status: 'merged', phase: 'done', pr: '12', runId: 'HOK-1:e:1', linearSyncedState: 'Done',
    lifecycle: { schemaVersion: 1, workflowOutcome: 'merged', resourceDisposition: 'reaped' },
    ...overrides,
  });
}

function rejectionLog(): MutatorRejectionRecord[] {
  const path = mutatorRejectionsPath(statePath);
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'state-inv-settlement-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  statePath = join(repoDir, '.wavemill', 'workflow-state.json');
});

afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

describe('I9 rejected control writes', () => {
  // protects: refused control writes going unseen (a writer silently fighting the gate).
  it('fires on a seeded refused control write, and never on late evidence', async () => {
    writeFileSync(statePath, JSON.stringify(buildWorkflowState({ 'HOK-1': mergedTask() })));
    // Late evidence for the settled run: accepted, never logged.
    await mutateWorkflowState(statePath, (state) => {
      state.tasks!['HOK-1']!.evalCompleted = true;
      state.tasks!['HOK-1']!.coderModel = 'gpt-5.6';
      return state;
    });
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowState;
    assert.deepEqual(ours(evaluateInvariants(inputs(state, { mutatorRejections: rejectionLog() })).violations), [], 'evidence never alerts');

    // A late control write against the settled run: refused and alerted.
    await mutateWorkflowState(statePath, (current) => {
      current.tasks!['HOK-1']!.phase = 'coding';
      return current;
    });
    const fired = ours(evaluateInvariants(inputs(state, { mutatorRejections: rejectionLog() })).violations);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.invariantId, 'I9-rejected-control-write');
    assert.equal(fired[0]!.signature, 'I9:HOK-1|settled-attempt');
    assert.equal(fired[0]!.evidence.count, 1);
    assert.deepEqual((fired[0]!.evidence.examples as Array<{ field: string }>).map((e) => e.field), ['phase']);
  });
});

describe('I10 settled non-convergence', () => {
  const tick = (state: WorkflowState, cache: StateInvariantsCache) => evaluateInvariants(inputs(state, { cache, config: { settledGraceTicks: 3 } }));

  // protects: a delivered run stuck holding a slot (or owing Linear Done) with nobody told.
  it('fires once a settled run stays unconverged past the grace', () => {
    const state = buildWorkflowState({
      'HOK-1': mergedTask({ linearSyncedState: undefined, lifecycle: { schemaVersion: 1, workflowOutcome: 'merged', resourceDisposition: 'reaping' } }),
      'HOK-2': mergedTask(),
    });
    let cache = createEmptyCache();
    for (let i = 1; i <= 2; i += 1) {
      const result = tick(state, cache);
      assert.deepEqual(ours(result.violations), [], `tick ${i} is inside the grace`);
      cache = result.nextCache;
    }
    const fired = ours(tick(state, cache).violations);
    assert.deepEqual(fired.map((v) => v.signature).sort(), ['I10:HOK-1|linear-unsynced', 'I10:HOK-1|occupies-slot']);
  });

  // protects: delivered work silently reappearing as an active row (a resurrection path).
  it('fires when a delivered key reappears as an open row', () => {
    const state = buildWorkflowState({ 'HOK-3': buildTask({ status: 'active', phase: 'planning' }) }, {
      // allow-task-literal: terminalTaskHistory tombstones, not .tasks rows
      topLevel: { terminalTaskHistory: { tasks: { 'HOK-3': { issue: 'HOK-3', workflowOutcome: 'merged' } } } },
    });
    let cache = createEmptyCache();
    let fired: InvariantViolation[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = tick(state, cache);
      fired = ours(result.violations);
      cache = result.nextCache;
    }
    assert.deepEqual(fired.map((v) => v.signature), ['I10:HOK-3|reappeared-active']);
  });

  // protects: a converged run (or a deliberately retained one) alerting forever.
  it('stays quiet for converged and retained runs, and resets when convergence lands', () => {
    const retained = mergedTask({ lifecycle: { schemaVersion: 1, workflowOutcome: 'merged', resourceDisposition: 'retained', retention: { reason: 'operator keep' } } });
    const state = buildWorkflowState({ 'HOK-1': mergedTask(), 'HOK-2': retained });
    let cache = createEmptyCache();
    for (let i = 0; i < 4; i += 1) {
      const result = tick(state, cache);
      assert.deepEqual(ours(result.violations), []);
      cache = result.nextCache;
    }
    const pending = buildWorkflowState({ 'HOK-1': mergedTask({ linearSyncedState: undefined }) });
    cache = tick(pending, cache).nextCache;
    cache = tick(state, cache).nextCache;
    assert.deepEqual(cache.settled, {}, 'a converged run drops its streak');
  });
});
