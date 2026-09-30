import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { classifyArmFault, isModelQualitySignal, parseAbortFailureKind } from '../shared/lib/arm-failure-taxonomy.ts';
import { abortTaskInState } from './abort-task.ts';

function stateWith(task: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'abort-task-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ tasks: { 'HOK-9999_c': task } }));
  return file;
}

function readTask(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')).tasks['HOK-9999_c'];
}

test('abort-task writes the challengeAborted cleanup marker', async () => {
  const file = stateWith({ slug: 'demo', status: 'active', phase: 'coding', challengeAborted: '' });

  await abortTaskInState(file, 'HOK-9999_c', 'dead arm');

  const task = readTask(file);
  assert.equal(task.phase, 'aborted');
  assert.equal(task.status, 'aborted');
  // The mill's arm cleanup gate reads challengeAborted. An empty value here
  // means the window, worktree and branch are never reaped.
  assert.ok(task.challengeAborted, 'challengeAborted must be non-empty for cleanup to fire');
  assert.equal(task.challengeAbortedDetail, 'dead arm');
});

test('operator aborts are not attributed as model or provider quality signals', async () => {
  const file = stateWith({ slug: 'demo', status: 'active', phase: 'coding', challengeAborted: '' });

  await abortTaskInState(file, 'HOK-9999_c', 'operator requested stop');

  const marker = readTask(file).challengeAborted as string;
  const failureKind = parseAbortFailureKind(marker);
  assert.equal(failureKind, null, 'operator marker must not parse as a terminal failure kind');

  const faultClass = classifyArmFault({ failureKind, detail: 'operator requested stop' });
  assert.equal(faultClass, 'unknown-fault');
  assert.equal(isModelQualitySignal(faultClass), false, 'an operator abort must not count against a model');
});

test('abort-task accepts a digit-bearing team key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abort-task-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ tasks: { 'AB2-1_c': { phase: 'coding', status: 'active' } } }));
  await abortTaskInState(file, 'AB2-1_c', 'operator requested stop');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tasks['AB2-1_c'].phase, 'aborted');
});
