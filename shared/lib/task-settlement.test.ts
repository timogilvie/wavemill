/**
 * HOK-3373: the settlement gate at the one task-record seam.
 *
 * Every write to `workflow-state.json` (TS `mutateJsonState` /
 * `mutateWorkflowState`; shell `state_mutate`, covered by
 * `tests/settlement-gate-shell.test.sh`) passes `applySettlementGate`:
 * control writes against a settled or non-current run are reverted and
 * logged to `mutator-rejections.jsonl`; evidence and cleanup writes always
 * land.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mintRunId, isSameRunId, runIdIssue } from './attempt-identity.ts';
import { mutateJsonStateSync } from './state-mutex.ts';
import {
  applySettlementGate,
  classifyTaskField,
  isNewRunReplacement,
  mutatorRejectionsPath,
  parseExpectedRunIds,
  settledOutcome,
  TASK_CLEANUP_FIELDS,
  TASK_CONTROL_FIELDS,
  TASK_EVIDENCE_FIELDS,
  type MutatorRejectionRecord,
} from './task-settlement.ts';
import { mutateWorkflowState, taskRecordSnapshot, type WorkflowState } from './workflow-state.ts';
import { buildTask, buildWorkflowState } from '../../tests/lib/task-builder.ts';

const SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/workflow-task.schema.json', import.meta.url), 'utf-8'), // allow-source-text-assertion: reads the schema (data), not source text
) as { $defs: { TaskRecord: { properties: Record<string, unknown> } } };

let repoDir: string;
let statePath: string;
const savedShadow = process.env.WAVEMILL_SETTLEMENT_GATE_SHADOW;

const RUN_A = 'HOK-1:e1:1700000000';
const RUN_B = 'HOK-1:e2:1700000600';

function merged(overrides: Record<string, unknown> = {}) {
  return buildTask({
    slug: 'one', branch: 'task/one', worktree: '/wt/one', pr: '12', status: 'merged', phase: 'done', runId: RUN_A,
    lifecycle: { schemaVersion: 1, workflowOutcome: 'merged', resourceDisposition: 'reaping' },
    ...overrides,
  });
}

function active(overrides: Record<string, unknown> = {}) {
  return buildTask({
    slug: 'one', branch: 'task/one', worktree: '/wt/one', pr: '', status: 'active', phase: 'coding', runId: RUN_B,
    lifecycle: { schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'allocated' },
    ...overrides,
  });
}

function seed(tasks: WorkflowState['tasks']): void {
  writeFileSync(statePath, JSON.stringify(buildWorkflowState(tasks ?? {})));
}

function readState(): WorkflowState {
  return JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowState;
}

function rejections(): MutatorRejectionRecord[] {
  const path = mutatorRejectionsPath(statePath);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'task-settlement-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  delete process.env.WAVEMILL_SETTLEMENT_GATE_SHADOW;
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  if (savedShadow === undefined) delete process.env.WAVEMILL_SETTLEMENT_GATE_SHADOW;
  else process.env.WAVEMILL_SETTLEMENT_GATE_SHADOW = savedShadow;
});

describe('attempt identity', () => {
  // protects: two launches of one issue sharing an id, so an old completion passes as current.
  it('mints deterministic, per-launch run ids', () => {
    const at = new Date('2023-11-14T22:13:20.900Z');
    assert.equal(mintRunId({ issue: 'HOK-1', runEpoch: 'e1', launchedAt: at }), 'HOK-1:e1:1700000000');
    assert.notEqual(
      mintRunId({ issue: 'HOK-1', runEpoch: 'e1', launchedAt: at }),
      mintRunId({ issue: 'HOK-1', runEpoch: 'e1', launchedAt: new Date(at.getTime() + 1000) }),
    );
    assert.equal(runIdIssue('HOK-1_c:e1:1700000000'), 'HOK-1_c');
  });

  // protects: two legacy rows with no id being treated as "the same run".
  it('never matches a missing id', () => {
    assert.equal(isSameRunId(RUN_A, RUN_A), true);
    assert.equal(isSameRunId(null, null), false);
    assert.equal(isSameRunId(undefined, RUN_A), false);
    assert.equal(isSameRunId(RUN_A, RUN_B), false);
  });
});

describe('field classification', () => {
  // protects: a new schema field shipping with no settlement rule at all.
  it('classifies every schema field exactly once', () => {
    for (const field of Object.keys(SCHEMA.$defs.TaskRecord.properties)) {
      const homes = [TASK_CONTROL_FIELDS, TASK_CLEANUP_FIELDS, TASK_EVIDENCE_FIELDS].filter((set) => set.has(field));
      assert.equal(homes.length, 1, `${field} must be in exactly one of control / cleanup / evidence`);
    }
  });

  // protects: the outcome being treated as cleanup because it lives under lifecycle.
  it('treats lifecycle.workflowOutcome as control and the rest of lifecycle as cleanup', () => {
    assert.equal(classifyTaskField('lifecycle.workflowOutcome'), 'control');
    assert.equal(classifyTaskField('lifecycle.resourceDisposition'), 'cleanup');
    assert.equal(classifyTaskField('executedModelSomethingNew'), 'evidence');
  });
});

describe('applySettlementGate', () => {
  const gate = (before: Record<string, unknown>, after: Record<string, unknown>, expected?: Record<string, string>) => {
    const next = { tasks: { 'HOK-1': structuredClone(after) } };
    const found = applySettlementGate(taskRecordSnapshot({ tasks: { 'HOK-1': before } }), next, { expectedRunIds: expected });
    return { found, row: next.tasks['HOK-1'] as Record<string, unknown> };
  };

  // protects: settled × control — a late phase change reopening delivered work (HOK-2595).
  it('reverts control writes against a settled run', () => {
    const { found, row } = gate(merged(), { ...merged(), phase: 'planning', status: 'active', pr: '99', lifecycle: { ...merged().lifecycle, workflowOutcome: 'active' } });
    assert.deepEqual(found.map((r) => r.field).sort(), ['lifecycle.workflowOutcome', 'phase', 'pr', 'status']);
    assert.ok(found.every((r) => r.reason === 'settled-attempt' && r.settledOutcome === 'merged'));
    assert.equal(row.phase, 'done');
    assert.equal(row.status, 'merged');
    assert.equal(row.pr, '12');
    assert.equal((row.lifecycle as Record<string, unknown>).workflowOutcome, 'merged');
  });

  // protects: settled × evidence — late cost / executed model / comparison results being dropped.
  it('accepts evidence and cleanup writes against a settled run', () => {
    const after = {
      ...merged(),
      evalCompleted: true,
      comparisonState: 'recompute',
      coderModel: 'claude-sonnet-5-5',
      lifecycle: { ...merged().lifecycle, resourceDisposition: 'reaped' },
      paneState: 'released',
    };
    const { found, row } = gate(merged(), after);
    assert.deepEqual(found, []);
    assert.equal(row.evalCompleted, true);
    assert.equal(row.comparisonState, 'recompute');
    assert.equal((row.lifecycle as Record<string, unknown>).resourceDisposition, 'reaped');
  });

  // protects: legacy terminal mirrors flapping between terminal values being charged as reopen.
  it('lets status/phase move between terminal values, backfill a missing PR, and clear relaunch markers', () => {
    const before = merged({ pr: '', launchFailure: { reason: 'x' } });
    const after = { ...before, phase: 'closed', status: 'completed', pr: '12' } as Record<string, unknown>;
    delete after.launchFailure;
    const { found } = gate(before, after);
    assert.deepEqual(found, []);
  });

  // protects: an abort arriving after the merge relabelling delivered work as aborted.
  it('refuses abort markers on a merged run but accepts them on an aborted one', () => {
    assert.equal(gate(merged(), { ...merged(), challengeAborted: 'operator_abort' }).found.length, 1);
    const aborted = merged({ status: 'aborted', phase: 'aborted', lifecycle: { schemaVersion: 1, workflowOutcome: 'aborted', resourceDisposition: 'reaping' } });
    assert.equal(gate(aborted, { ...aborted, challengeAborted: 'operator_abort' }).found.length, 0);
  });

  // protects: active × stale runId × control — an old run's completion landing on the relaunch.
  it('reverts control writes from a non-current run, even on an active row', () => {
    const { found, row } = gate(active(), { ...active(), phase: 'ready', pr: '12', evalCompleted: true }, { 'HOK-1': RUN_A });
    assert.deepEqual(found.map((r) => [r.field, r.reason]).sort(), [['phase', 'stale-run-id'], ['pr', 'stale-run-id']]);
    assert.equal(row.phase, 'coding');
    assert.equal(row.pr, '');
    assert.equal(row.evalCompleted, true, 'evidence from the old run is kept');
  });

  // protects: active × current runId × control — the gate wedging normal progress.
  it('accepts control writes from the current run', () => {
    const { found, row } = gate(active(), { ...active(), phase: 'review' }, { 'HOK-1': RUN_B });
    assert.deepEqual(found, []);
    assert.equal(row.phase, 'review');
  });

  // protects: legacy rows (no runId) being refused because a caller named a run.
  it('grandfathers legacy rows with no run id', () => {
    const legacy = active({ runId: undefined });
    delete (legacy as Record<string, unknown>).runId;
    assert.deepEqual(gate(legacy, { ...legacy, phase: 'review' }, { 'HOK-1': RUN_A }).found, []);
  });

  // protects: a relaunch being refused because it "changes" every field of the settled row.
  it('lets a launch replace a settled row with a fresh run', () => {
    const fresh = active();
    assert.equal(isNewRunReplacement(merged(), fresh), true);
    assert.deepEqual(gate(merged(), fresh).found, []);
    assert.equal(isNewRunReplacement(active(), merged({ runId: RUN_B })), false);
  });

  // protects: deletion (reap) of a settled row being blocked.
  it('never gates row deletion or creation', () => {
    const next = { tasks: { 'HOK-2': active() } };
    assert.deepEqual(applySettlementGate(taskRecordSnapshot({ tasks: { 'HOK-1': merged() } }), next), []);
  });

  // protects: error being treated as settled, which would block recovery relaunches.
  it('does not treat error as settled', () => {
    assert.equal(settledOutcome({ lifecycle: { workflowOutcome: 'error' } }), null);
    assert.equal(settledOutcome({ lifecycle: { workflowOutcome: 'closed' } }), 'closed');
  });
});

describe('the TS write seam', () => {
  // protects: a TS writer bypassing the gate by calling mutateWorkflowState directly.
  it('reverts the refused fields, lands the rest, and logs once per signature', async () => {
    seed({ 'HOK-1': merged() });
    for (let i = 0; i < 2; i += 1) {
      await mutateWorkflowState(statePath, (state) => {
        const task = state.tasks!['HOK-1']!;
        task.phase = 'planning';
        task.evalCompleted = true;
        return state;
      });
    }
    const row = readState().tasks!['HOK-1']!;
    assert.equal(row.phase, 'done');
    assert.equal(row.evalCompleted, true);
    const logged = rejections();
    assert.equal(logged.length, 1, 'a repeated refused write is logged once');
    assert.equal(logged[0]!.field, 'phase');
    assert.equal(logged[0]!.writer, 'ts');
    assert.equal(logged[0]!.mode, 'enforce');
  });

  // protects: the stale-run rule being unreachable from TS callers.
  it('honours expectedRunIds on mutateJsonStateSync', () => {
    seed({ 'HOK-1': active() });
    mutateJsonStateSync<WorkflowState>(statePath, (state) => {
      state.tasks!['HOK-1']!.status = 'merged';
      return state;
    }, { expectedRunIds: { 'HOK-1': RUN_A } });
    assert.equal(readState().tasks!['HOK-1']!.status, 'active');
    assert.equal(rejections()[0]!.reason, 'stale-run-id');
  });

  // protects: the kill switch silently disabling the rejection log too.
  it('shadow mode logs but applies', async () => {
    process.env.WAVEMILL_SETTLEMENT_GATE_SHADOW = '1';
    seed({ 'HOK-1': merged() });
    await mutateWorkflowState(statePath, (state) => {
      state.tasks!['HOK-1']!.phase = 'planning';
      return state;
    });
    assert.equal(readState().tasks!['HOK-1']!.phase, 'planning');
    assert.equal(rejections()[0]!.mode, 'shadow');
  });
});

describe('parseExpectedRunIds', () => {
  // protects: the shell bridge's --expected-run-id being misparsed into a wrong run.
  it('parses issue=runId lists', () => {
    assert.deepEqual(parseExpectedRunIds(`HOK-1=${RUN_A},HOK-1_c=HOK-1_c:e1:1`), { 'HOK-1': RUN_A, 'HOK-1_c': 'HOK-1_c:e1:1' });
    assert.equal(parseExpectedRunIds(''), undefined);
    assert.equal(parseExpectedRunIds('garbage'), undefined);
  });
});
