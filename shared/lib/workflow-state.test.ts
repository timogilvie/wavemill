import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPrecompiledValidator, PRECOMPILED_SCHEMAS, schemaSourceText } from './schema-validators.ts';
import {
  mutateWorkflowState,
  readWorkflowState,
  validateTaskRecord,
  validateWorkflowState,
  workflowTaskEntries,
  type WorkflowState,
  type WorkflowStateIssue,
} from './workflow-state.ts';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ACTIVE_LIFECYCLE = { schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'allocated' };

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-state-'));
  statePath = join(dir, 'workflow-state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function collect(): { issues: WorkflowStateIssue[][]; onInvalid: (path: string, found: WorkflowStateIssue[]) => void } {
  const issues: WorkflowStateIssue[][] = [];
  return { issues, onInvalid: (_path, found) => issues.push(found) };
}

describe('validator', () => {
  it('uses the committed precompiled artifact for the current schema', () => {
    const spec = PRECOMPILED_SCHEMAS.find((entry) => entry.name === 'workflow-state');
    assert.ok(spec, 'workflow-state must be a precompiled schema (hot read path)');
    assert.ok(loadPrecompiledValidator(spec.name, schemaSourceText(spec, repoRoot), spec.ajvOptions, spec.ajvModule));
  });

  it('accepts a save_task_state-shaped row and rejects wrongly typed writer fields', () => {
    assert.deepEqual(
      validateTaskRecord('HOK-1', { slug: 's', branch: 'task/s', worktree: '/w', pr: '', status: 'active', challenge: true, lifecycle: ACTIVE_LIFECYCLE }),
      { valid: true, issues: [] },
    );
    const result = validateTaskRecord('HOK-1', { challenge: 'true', evalCompleted: 1, challengeArms: {} });
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues.map((issue) => issue.path).sort(), [
      '/tasks/HOK-1/challenge',
      '/tasks/HOK-1/challengeArms',
      '/tasks/HOK-1/evalCompleted',
    ]);
  });

  it('validates .lifecycle against task-lifecycle-state.schema.json', () => {
    const result = validateTaskRecord('HOK-1', { lifecycle: { schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'reaped' } });
    assert.equal(result.valid, false);
    assert.ok(result.issues.every((issue) => issue.path.startsWith('/tasks/HOK-1/lifecycle')));
  });

  it('accepts null attempt / prReconciliation in the lifecycle (wavemill_persist_attempt_reconciliation writes them)', () => {
    assert.equal(validateTaskRecord('HOK-1', { attempt: null, lifecycle: { ...ACTIVE_LIFECYCLE, attempt: null, prReconciliation: null } }).valid, true);
  });

  it('stays permissive about fields it does not name (additionalProperties)', () => {
    // allow-task-literal: an undeclared field is the point; the builder rejects it
    assert.equal(validateWorkflowState({ migrationReservations: {}, tasks: { 'HOK-1': { someFutureField: 1 } } }).valid, true);
  });

  it('accepts the legacy jobs array', () => {
    assert.equal(validateWorkflowState({ jobs: [{ id: 'j1' }] }).valid, true);
  });
});

describe('readWorkflowState', () => {
  it('returns null for a missing, malformed, or non-object file without throwing', () => {
    assert.equal(readWorkflowState(statePath), null);
    writeFileSync(statePath, '{"tasks": ');
    assert.equal(readWorkflowState(statePath), null);
    writeFileSync(statePath, '[]');
    assert.equal(readWorkflowState(statePath), null);
  });

  it('returns a valid state without reporting', () => {
    writeFileSync(statePath, JSON.stringify(buildWorkflowState(
      { 'HOK-1': { slug: 'a', pr: '7', lifecycle: ACTIVE_LIFECYCLE } },
      { bare: true, topLevel: { session: 's' } },
    )));
    const { issues, onInvalid } = collect();
    const state = readWorkflowState(statePath, { onInvalid });
    assert.equal(state?.tasks?.['HOK-1']?.pr, '7');
    assert.deepEqual(issues, []);
  });

  it('reports schema violations but still returns the parsed value', () => {
    // allow-task-literal: deliberately schema-violating row (challenge must be boolean)
    writeFileSync(statePath, JSON.stringify({ tasks: { 'HOK-1': { slug: 'a', challenge: 'yes' } } }));
    const { issues, onInvalid } = collect();
    const state = readWorkflowState(statePath, { onInvalid });
    assert.equal(state?.tasks?.['HOK-1']?.slug, 'a');
    assert.deepEqual(issues, [[{ path: '/tasks/HOK-1/challenge', message: 'must be boolean' }]]);
  });

  it('reports a given file to stderr once per process by default', () => {
    // allow-task-literal: deliberately schema-violating row (challenge must be boolean)
    writeFileSync(statePath, JSON.stringify({ tasks: { 'HOK-1': { challenge: 'yes' } } }));
    const scriptPath = join(dir, 'read-twice.ts');
    writeFileSync(scriptPath, [
      `import { readWorkflowState } from ${JSON.stringify(join(repoRoot, 'shared/lib/workflow-state.ts'))};`,
      `readWorkflowState(${JSON.stringify(statePath)});`,
      `readWorkflowState(${JSON.stringify(statePath)});`,
    ].join('\n'));
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.match(/workflow-state: schema violations/g)?.length, 1);
    assert.match(result.stderr, /\/tasks\/HOK-1\/challenge must be boolean/);
  });
});

describe('workflowTaskEntries', () => {
  it('yields object rows only and tolerates a missing or malformed task map', () => {
    assert.deepEqual(workflowTaskEntries(null), []);
    assert.deepEqual(workflowTaskEntries({ tasks: [] as unknown as WorkflowState['tasks'] }), []);
    // allow-task-literal: non-object rows (null, string) are the point; the builder only makes objects
    const entries = workflowTaskEntries({ tasks: { a: { slug: 'a' }, b: null as never, c: 'x' as never } });
    assert.deepEqual(entries, [['a', { slug: 'a' }]]);
  });
});

describe('mutateWorkflowState', () => {
  it('writes the transform result and validates only the rows it changed', async () => {
    writeFileSync(statePath, JSON.stringify({
      // allow-task-literal: `untouched` is a deliberately schema-violating legacy row
      tasks: {
        untouched: { challenge: 'legacy-bad' },
        target: { slug: 't', status: 'active' },
      },
    }));
    const { issues, onInvalid } = collect();
    await mutateWorkflowState(statePath, (state) => {
      state.tasks!.target.status = 'aborted';
      return state;
    }, { onInvalid });
    assert.deepEqual(issues, [], 'a pre-existing bad row the write did not touch is not reported');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf-8')).tasks.target.status, 'aborted');
  });

  it('reports (never rejects) a write that produces an invalid row', async () => {
    writeFileSync(statePath, JSON.stringify(buildWorkflowState({ target: { slug: 't' } }, { bare: true })));
    const { issues, onInvalid } = collect();
    await mutateWorkflowState(statePath, (state) => {
      (state.tasks!.target as Record<string, unknown>).evalFailed = 'no';
      state.tasks!.added = { challengerLaunched: 'yes' as never };
      return state;
    }, { onInvalid });
    assert.deepEqual(issues.flat().map((issue) => issue.path).sort(), ['/tasks/added/challengerLaunched', '/tasks/target/evalFailed']);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf-8')).tasks.target.evalFailed, 'no');
  });
});

/**
 * The shell writers are the source of truth the schema is derived from; run
 * the real ones against a scratch state file and validate what they wrote.
 */
describe('shell writers conform to the schema', () => {
  function runShell(script: string): void {
    execFileSync('bash', ['-c', `set -euo pipefail\nsource ${JSON.stringify(join(repoRoot, 'shared/lib/wavemill-common.sh'))}\n${script}`], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        STATE_FILE: statePath,
        REPO_DIR: dir,
        SESSION: 'workflow-state-test',
        BASE_BRANCH: 'main',
        WAVEMILL_RUN_EPOCH: 'epoch-1',
      },
    });
  }

  it('save_task_state, ownership, and attempt-reconciliation writers produce valid rows', () => {
    writeFileSync(statePath, '{"tasks":{}}\n');
    runShell([
      `save_task_state HOK-1 one task/one ${dir}/wt 12 '' claude HOK-1 true HOK-1 primary m1 p1 c1 r1 deep deep full coding coding @1`,
      `save_task_state HOK-1_c one-c task/one-c ${dir}/wt-c '' active codex HOK-1 true HOK-1 challenger m2`,
      'set_task_queue_owned HOK-1 digest-1 1700000000',
      'set_task_task_owned HOK-1_c rehydrating',
      `wavemill_persist_attempt_reconciliation HOK-1 '{"schemaVersion":1,"attemptId":"a1"}' null`,
    ].join('\n'));
    const { issues, onInvalid } = collect();
    const state = readWorkflowState(statePath, { onInvalid });
    assert.deepEqual(issues, []);
    assert.equal(state?.tasks?.['HOK-1']?.challenge, true);
    assert.equal(state?.tasks?.['HOK-1']?.executionOwner, 'queue');
    assert.equal(state?.tasks?.['HOK-1_c']?.paneState, 'rehydrating');
  });
});
