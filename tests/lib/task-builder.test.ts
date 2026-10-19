import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateWorkflowState, WORKFLOW_STATE_SCHEMA_PATH, type TaskRecord } from '../../shared/lib/workflow-state.ts';
import {
  buildTask,
  buildWorkflowState,
  DEFAULT_TASK,
  TASK_RECORD_SCHEMA_PROPERTIES,
  TaskFixtureError,
} from './task-builder.ts';
import { buildFixtureTasks, parseFieldArg } from './bin/build-fixture-task.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const VALID_LIFECYCLE = {
  schemaVersion: 1,
  workflowOutcome: 'active',
  resourceDisposition: 'retained',
};

describe('buildTask', () => {
  it('returns the default save_task_state row, which validates', () => {
    const task = buildTask();
    assert.deepEqual(task, DEFAULT_TASK);
    assert.equal(validateWorkflowState({ tasks: { 'HOK-1': task } }).valid, true);
  });

  it('applies known-key overrides over the defaults', () => {
    const task = buildTask({ pr: '9999', slug: 'feat', phase: 'ready', challenge: true });
    assert.deepEqual(task, { ...DEFAULT_TASK, pr: '9999', slug: 'feat', phase: 'ready', challenge: true });
  });

  it('drops keys overridden with undefined', () => {
    const task = buildTask({ pr: undefined, worktree: '/tmp/wt' });
    assert.equal('pr' in task, false);
    assert.equal(task.worktree, '/tmp/wt');
  });

  it('bare rows carry only the overrides', () => {
    assert.deepEqual(buildTask({ phase: 'coding' }, { bare: true }), { phase: 'coding' });
    assert.deepEqual(buildTask({}, { bare: true }), {});
  });

  it('leaves schema fields without a default absent', () => {
    const task = buildTask();
    for (const key of ['lifecycle', 'challengeRole', 'evalCompleted', 'agent']) {
      assert.equal(key in task, false, key);
    }
  });

  it('rejects an unknown override key and points at the schema', () => {
    assert.throws(
      () => buildTask({ title: 'Fix CI' } as unknown as TaskRecord),
      (error: Error) => error instanceof TaskFixtureError
        && /unknown task field "title"/.test(error.message)
        && error.message.includes(WORKFLOW_STATE_SCHEMA_PATH),
    );
  });

  it('names the real field for the reader-only names HOK-3212 removed', () => {
    for (const key of ['prNumber', 'headSha', 'prHeadSha', 'pullRequest']) {
      assert.throws(
        () => buildTask({ [key]: 1 } as unknown as TaskRecord),
        (error: Error) => error.message.includes(`"${key}"`) && error.message.includes('the PR is `pr`'),
        key,
      );
    }
  });

  it('rejects a known key with the wrong type', () => {
    assert.throws(
      () => buildTask({ pr: true as unknown as string }),
      (error: Error) => error instanceof TaskFixtureError && /\/pr must be string,number/.test(error.message),
    );
    assert.throws(
      () => buildTask({ executionOwner: 'monitor' as never }),
      /\/executionOwner must be equal to one of the allowed values/,
    );
  });

  it('validates a nested lifecycle through the referenced schema', () => {
    assert.deepEqual(buildTask({ lifecycle: VALID_LIFECYCLE as TaskRecord['lifecycle'] }).lifecycle, VALID_LIFECYCLE);
    assert.throws(
      () => buildTask({ lifecycle: { ...VALID_LIFECYCLE, schemaVersion: 'one' } as unknown as TaskRecord['lifecycle'] }),
      /\/lifecycle\/schemaVersion/,
    );
  });

  it('never mutates the shared defaults', () => {
    buildTask({ slug: 'changed' });
    assert.equal(DEFAULT_TASK.slug, '');
    assert.equal(Object.isFrozen(DEFAULT_TASK), true);
  });
});

describe('buildWorkflowState', () => {
  it('builds every row and validates the whole state', () => {
    const state = buildWorkflowState({ 'HOK-1': {}, 'HOK-2': { phase: 'ready' } });
    assert.deepEqual(state, { tasks: { 'HOK-1': { ...DEFAULT_TASK }, 'HOK-2': { ...DEFAULT_TASK, phase: 'ready' } } });
    assert.equal(validateWorkflowState(state).valid, true);
  });

  it('defaults to an empty task map', () => {
    assert.deepEqual(buildWorkflowState(), { tasks: {} });
  });

  it('passes bare through to every row and keeps top-level keys', () => {
    const state = buildWorkflowState(
      { 'HOK-1': { slug: 'a' } },
      { bare: true, topLevel: { session: 'wm-test', jobs: {} } },
    );
    assert.deepEqual(state, { session: 'wm-test', jobs: {}, tasks: { 'HOK-1': { slug: 'a' } } });
  });

  it('names the task id when a row is rejected', () => {
    assert.throws(
      () => buildWorkflowState({ 'HOK-7': { prNumber: 7 } as unknown as TaskRecord }),
      (error: Error) => error instanceof TaskFixtureError
        && error.message.startsWith('buildWorkflowState: task HOK-7: unknown task field "prNumber"'),
    );
  });

  it('rejects a top-level key with the wrong type', () => {
    assert.throws(() => buildWorkflowState({}, { topLevel: { session: 7 as unknown as string } }), /\/session must be string/);
  });
});

describe('known keys', () => {
  it('are exactly the schema TaskRecord properties', () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, WORKFLOW_STATE_SCHEMA_PATH), 'utf-8'));
    assert.deepEqual(Object.keys(TASK_RECORD_SCHEMA_PROPERTIES).sort(), Object.keys(schema.$defs.TaskRecord.properties).sort());
  });
});

describe('build-fixture-task (shell bridge)', () => {
  it('types field=value by the schema', () => {
    assert.deepEqual(parseFieldArg('pr=9999'), ['pr', '9999']);
    assert.deepEqual(parseFieldArg('slug=a=b'), ['slug', 'a=b']);
    assert.deepEqual(parseFieldArg('challenge=true'), ['challenge', true]);
    assert.deepEqual(parseFieldArg('queueHandoffAt=12'), ['queueHandoffAt', 12]);
    assert.deepEqual(parseFieldArg('challengeArms=[]'), ['challengeArms', []]);
    assert.deepEqual(parseFieldArg('attempt=null'), ['attempt', null]);
    assert.deepEqual(parseFieldArg('comparisonState=null'), ['comparisonState', 'null'], 'string-admitting field stays a string');
  });

  it('parses field:=json verbatim', () => {
    assert.deepEqual(parseFieldArg('pr:=1230'), ['pr', 1230]);
    assert.deepEqual(parseFieldArg('comparisonState:=null'), ['comparisonState', null]);
  });

  it('rejects malformed arguments as usage errors', () => {
    assert.throws(() => parseFieldArg('slug'), /expected field=value/);
    assert.throws(() => parseFieldArg('=x'), /expected field=value/);
    assert.throws(() => parseFieldArg(':=1'), /expected field:=json/);
    assert.throws(() => parseFieldArg('challenge=yes'), /needs a JSON value/);
  });

  it('builds several tasks separated by --, honouring --bare', () => {
    assert.deepEqual(buildFixtureTasks(['HOK-1', 'pr=1', '--', 'HOK-2', 'phase=ready']), {
      'HOK-1': { ...DEFAULT_TASK, pr: '1' },
      'HOK-2': { ...DEFAULT_TASK, phase: 'ready' },
    });
    assert.deepEqual(buildFixtureTasks(['--bare', 'HOK-1', 'phase=coding', '--', 'HOK-2']), {
      'HOK-1': { phase: 'coding' },
      'HOK-2': {},
    });
  });

  it('rejects duplicate ids and fields, a trailing --, and an empty argv', () => {
    assert.throws(() => buildFixtureTasks(['HOK-1', '--', 'HOK-1']), /given twice/);
    assert.throws(() => buildFixtureTasks(['HOK-1', 'pr=1', 'pr=2']), /field "pr" given twice/);
    assert.throws(() => buildFixtureTasks(['HOK-1', '--']), /after --/);
    assert.throws(() => buildFixtureTasks([]), /at least one task id/);
    assert.throws(() => buildFixtureTasks(['pr=1']), /expected a task id/);
  });

  it('prefixes builder rejections with the task id', () => {
    assert.throws(
      () => buildFixtureTasks(['HOK-3', 'headSha=abc']),
      (error: Error) => error instanceof TaskFixtureError && error.message.startsWith('task HOK-3: buildTask: unknown task field "headSha"'),
    );
  });
});
