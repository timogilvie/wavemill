/**
 * HOK-3222 Phase 1: the TS seam of the task-record write guard.
 *
 * `mutateJsonState` / `mutateJsonStateSync` validate the task records a write
 * to `workflow-state.json` adds or changes and shadow-log violations to
 * `<state dir>/state-schema-violations.jsonl` without refusing the write.
 * The shell seam (`state_mutate`) is covered by
 * `tests/state-mutate-task-record-validation.test.sh`.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mutateJsonState, mutateJsonStateSync } from './state-mutex.ts';
import {
  stateSchemaViolationsPath,
  taskRecordWriteValidationEnabled,
  violationSignature,
  type StateSchemaViolationRecord,
} from './task-record-write-guard.ts';
import { mutateWorkflowState, type WorkflowState, type WorkflowStateIssue } from './workflow-state.ts';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';

let repoDir: string;
let statePath: string;
const savedFlag = process.env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW;

function seed(): void {
  writeFileSync(statePath, JSON.stringify(buildWorkflowState({ 'HOK-1': { slug: 'one' }, 'HOK-2': { slug: 'two' } })));
}

function logged(): StateSchemaViolationRecord[] {
  const log = stateSchemaViolationsPath(statePath);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function readState(): WorkflowState {
  return JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowState;
}

/** Silence the default stderr line while still observing the call. */
function collect(): { calls: WorkflowStateIssue[][]; onInvalid: (path: string, issues: WorkflowStateIssue[]) => void } {
  const calls: WorkflowStateIssue[][] = [];
  return { calls, onInvalid: (_path, issues) => calls.push(issues) };
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'task-record-write-guard-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  delete process.env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW;
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW;
  else process.env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW = savedFlag;
});

describe('mutateJsonState write guard (shadow)', () => {
  // protects: a TS writer that bypasses mutateWorkflowState writes a malformed row unseen.
  it('logs a malformed write made through mutateJsonState directly and still applies it', async () => {
    seed();
    const { calls, onInvalid } = collect();
    await mutateJsonState<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-1'].evalFailed = 'no';
      return state;
    }, { onInvalid });

    const lines = logged();
    assert.equal(lines.length, 1);
    assert.deepEqual(
      { writer: lines[0].writer, issue: lines[0].issue, path: lines[0].path, mode: lines[0].mode, statePath: lines[0].statePath },
      { writer: 'ts', issue: 'HOK-1', path: '/tasks/HOK-1/evalFailed', mode: 'shadow', statePath },
    );
    assert.equal(lines[0].signature, '/tasks/*/evalFailed must be boolean');
    assert.equal(calls.length, 1, 'onInvalid replaces the stderr line');
    assert.equal(readState().tasks?.['HOK-1']?.evalFailed as unknown, 'no', 'shadow mode applies the write');
  });

  // protects: mutateWorkflowState losing validation after the diff moved down a layer.
  it('validates mutateWorkflowState writes, including newly added rows', async () => {
    seed();
    const { onInvalid } = collect();
    await mutateWorkflowState(statePath, (state) => {
      state.tasks!['HOK-3'] = { challengerLaunched: 'yes' as never };
      return state;
    }, { onInvalid });
    assert.deepEqual(logged().map((line) => line.path), ['/tasks/HOK-3/challengerLaunched']);
  });

  // protects: mutateJsonStateSync (no current workflow-state caller) silently skipping validation.
  it('validates mutateJsonStateSync writes the same way', () => {
    seed();
    const { onInvalid } = collect();
    mutateJsonStateSync<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-2'].evalFailed = 'nope';
      return state;
    }, { onInvalid });
    assert.deepEqual(logged().map((line) => line.issue), ['HOK-2']);
  });

  // protects: an abort/supersede write blocked or charged for a bad field it did not introduce.
  it('charges only violations the write introduced', async () => {
    seed();
    process.env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW = '0';
    await mutateJsonState<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-1'].evalFailed = 'legacy';
      state.tasks['HOK-2'].evalFailed = 'legacy';
      return state;
    });
    assert.equal(logged().length, 0, 'the kill switch skips validation');
    delete process.env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW;

    const { calls, onInvalid } = collect();
    await mutateJsonState<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-1'].status = 'aborted';
      state.tasks['HOK-2'].slug = 'renamed';
      return state;
    }, { onInvalid });
    assert.equal(logged().length, 0, 'rows that already carried the bad field are not re-charged');
    assert.equal(calls.length, 0);

    await mutateJsonState<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-1'].challengerLaunched = 'yes';
      return state;
    }, { onInvalid });
    assert.deepEqual(logged().map((line) => line.path), ['/tasks/HOK-1/challengerLaunched']);
  });

  // protects: false positives on valid writes and on deletions.
  it('logs nothing for clean writes or row deletions', async () => {
    seed();
    const { calls, onInvalid } = collect();
    await mutateJsonState<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-1'].evalFailed = true;
      delete state.tasks['HOK-2'];
      return state;
    }, { onInvalid });
    assert.equal(logged().length, 0);
    assert.equal(calls.length, 0);
  });

  // protects: the guard leaking onto other JSON state files with different shapes.
  it('does not validate files other than workflow-state.json', async () => {
    const other = join(repoDir, '.wavemill', 'hokusai-queue.json');
    writeFileSync(other, JSON.stringify({ tasks: { x: { evalFailed: true } } }));
    await mutateJsonState<Record<string, any>>(other, (state) => {
      state.tasks.x.evalFailed = 'not a bool here';
      return state;
    });
    assert.equal(existsSync(join(repoDir, '.wavemill', 'state-schema-violations.jsonl')), false);
  });

  // protects: a throwing onInvalid callback turning a shadow report into a failed write.
  it('never fails the write when the onInvalid callback throws', async () => {
    seed();
    await mutateJsonState<Record<string, any>>(statePath, (state) => {
      state.tasks['HOK-1'].evalFailed = 'no';
      return state;
    }, { onInvalid: () => { throw new Error('boom'); } });
    assert.equal(readState().tasks?.['HOK-1']?.evalFailed as unknown, 'no');
    assert.equal(logged().length, 1);
  });
});

describe('task-record-write-guard helpers', () => {
  // protects: the observer seeing one finding per task instead of one per defect.
  it('violationSignature strips the task key (including JSON-pointer escapes)', () => {
    assert.equal(
      violationSignature({ issue: 'a/b~c', path: '/tasks/a~1b~0c/lifecycle/workflowOutcome', message: 'must be equal to one of the allowed values' }),
      '/tasks/*/lifecycle/workflowOutcome must be equal to one of the allowed values',
    );
    assert.equal(violationSignature({ issue: 'HOK-1', path: '/tasks/HOK-1', message: 'must be object' }), '/tasks/* must be object');
  });

  // protects: the kill switch being read with the wrong polarity.
  it('taskRecordWriteValidationEnabled is on unless the flag is exactly 0', () => {
    assert.equal(taskRecordWriteValidationEnabled({}), true);
    assert.equal(taskRecordWriteValidationEnabled({ WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW: '1' }), true);
    assert.equal(taskRecordWriteValidationEnabled({ WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW: '0' }), false);
  });
});
