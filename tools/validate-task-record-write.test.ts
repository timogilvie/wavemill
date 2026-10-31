/**
 * HOK-3222: exit-status contract of the `state_mutate` bridge. 0 = clean,
 * 2 = violations found and logged, anything else = the check could not run.
 * Phase 2 refuses the write on 2 only, so the statuses must stay distinct.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, it } from 'node:test';
import { buildWorkflowState } from '../tests/lib/task-builder.ts';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'validate-task-record-write.ts');
let dir: string;
let statePath: string;
let candidate: string;

function run(...args: string[]): { status: number | null; stderr: string } {
  const env = { ...process.env };
  delete env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { encoding: 'utf-8', env });
  return { status: result.status, stderr: result.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'validate-task-record-write-'));
  mkdirSync(join(dir, '.wavemill'));
  statePath = join(dir, '.wavemill', 'workflow-state.json');
  candidate = `${statePath}.tmp.test`;
  writeFileSync(statePath, JSON.stringify(buildWorkflowState({ 'HOK-1': { slug: 'one' } })));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// protects: state_mutate unable to tell a clean write from a violating one.
it('exits 0 for a clean candidate and 2 for a violating one', () => {
  const clean = buildWorkflowState({ 'HOK-1': { slug: 'one', evalFailed: true } });
  writeFileSync(candidate, JSON.stringify(clean));
  assert.equal(run('--before', statePath, '--after', candidate, '--state-path', statePath).status, 0);
  assert.equal(existsSync(join(dir, '.wavemill', 'state-schema-violations.jsonl')), false);

  const bad = JSON.parse(JSON.stringify(clean));
  bad.tasks['HOK-1'].evalFailed = 'no';
  writeFileSync(candidate, JSON.stringify(bad));
  const result = run('--before', statePath, '--after', candidate, '--state-path', statePath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\/tasks\/HOK-1\/evalFailed must be boolean/);
  assert.equal(existsSync(join(dir, '.wavemill', 'state-schema-violations.jsonl')), true);
});

// protects: an unreadable candidate being mistaken for "violations found" (or for clean).
it('exits with a status other than 0 and 2 when an input is unreadable', () => {
  writeFileSync(candidate, '{ torn');
  const status = run('--before', statePath, '--after', candidate, '--state-path', statePath).status;
  assert.notEqual(status, 0);
  assert.notEqual(status, 2);
});
