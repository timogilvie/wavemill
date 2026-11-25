import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSdkRunId, mintStageAttemptId, projectTaskAttemptRef, taskSdkRunId } from './attempt-identity.ts';
import { validateTaskAttemptRef } from './sdk-task-cost/contract.ts';

test('SDK identities are minted UUIDv7s and project only known runs', () => {
  const run = mintSdkRunId();
  const stage = mintStageAttemptId();
  for (const id of [run, stage]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(run, stage);
  assert.equal(projectTaskAttemptRef({ taskId: 'HOK-1' }), null);
  assert.equal(taskSdkRunId({}), null);
  const ref = projectTaskAttemptRef({ taskId: 'HOK-1', sdkRunId: run, stageAttemptId: stage });
  validateTaskAttemptRef(ref);
  assert.deepEqual(ref, { task_id: 'HOK-1', run_id: run, stage_attempt_id: stage });
});

test('shell and TypeScript project identical SDK references', async () => {
  const { execFileSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const shell = resolve('shared/lib/attempt-identity.sh');
  const run = mintSdkRunId();
  const stage = mintStageAttemptId();
  const output = execFileSync('bash', ['-c', 'source "$1"; attempt_identity_project_attempt_ref "$2" "$3" "$4"', 'test', shell, 'HOK-1', run, stage], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), projectTaskAttemptRef({ taskId: 'HOK-1', sdkRunId: run, stageAttemptId: stage }));
  const shellId = execFileSync('bash', ['-c', 'source "$1"; attempt_identity_mint_sdk_run_id', 'test', shell], { encoding: 'utf8' }).trim();
  assert.match(shellId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
