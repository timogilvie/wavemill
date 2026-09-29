import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  linearWriteTargetOrSkip,
  partitionLinearWriteTargets,
  readTaskIdentityMeta,
  resolveLinearWriteTarget,
  setTaskIssuesState,
} from './linear-write-gate.ts';

function withStateFile(tasks: Record<string, unknown>, fn: (stateFile: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'linear-write-gate-'));
  const stateFile = join(dir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({ tasks }));
  return Promise.resolve(fn(stateFile)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const silent = { log() {}, error() {} };

describe('resolveLinearWriteTarget', () => {
  it('writes for a primary task', () => {
    assert.deepEqual(resolveLinearWriteTarget('HOK-1', { meta: null }), {
      action: 'write',
      taskId: 'HOK-1',
      linearId: 'HOK-1',
    });
  });

  it('skips a challenger whose linearIssueId names the primary and has no challengeRole', () => {
    const decision = resolveLinearWriteTarget('HOK-1_c', { meta: { linearIssueId: 'HOK-1' } });
    assert.equal(decision.action, 'skip');
  });

  it('skips a primary-shaped ID whose metadata records challengeRole=challenger', () => {
    assert.equal(resolveLinearWriteTarget('HOK-1', { meta: { challengeRole: 'challenger' } }).action, 'skip');
  });

  it('rejects invalid and conflicting IDs', () => {
    const invalid = resolveLinearWriteTarget('hok-1', { meta: null });
    assert.equal(invalid.action, 'reject');
    assert.equal(invalid.action === 'reject' && invalid.error, 'invalid_task_id');
    const mismatch = resolveLinearWriteTarget('HOK-1', { meta: { linearIssueId: 'HOK-2' } });
    assert.equal(mismatch.action === 'reject' && mismatch.error, 'linear_id_mismatch');
  });

  it('reads metadata from the state file when none is supplied', async () => {
    await withStateFile({ 'HOK-1': { challengeRole: 'challenger' } }, (stateFile) => {
      assert.deepEqual(readTaskIdentityMeta('HOK-1', stateFile), { challengeRole: 'challenger' });
      assert.equal(resolveLinearWriteTarget('HOK-1', { stateFile }).action, 'skip');
      assert.equal(resolveLinearWriteTarget('HOK-2', { stateFile }).action, 'write');
    });
  });
});

describe('linearWriteTargetOrSkip', () => {
  it('returns null for a challenger and throws for an invalid ID', () => {
    assert.equal(linearWriteTargetOrSkip('HOK-1_c', { meta: null, log: silent }), null);
    assert.equal(linearWriteTargetOrSkip('HOK-1', { meta: null, log: silent }), 'HOK-1');
    assert.throws(() => linearWriteTargetOrSkip('not an id', { meta: null, log: silent }), /Refusing Linear write/);
  });
});

describe('partitionLinearWriteTargets', () => {
  it('dedupes writers and separates challengers from rejects', async () => {
    await withStateFile({}, (stateFile) => {
      const result = partitionLinearWriteTargets(['HOK-1', 'HOK-1_c', 'HOK-1', 'bad', 'HOK-2'], { stateFile });
      assert.deepEqual(result.linearIds, ['HOK-1', 'HOK-2']);
      assert.deepEqual(result.skipped.map((d) => d.taskId), ['HOK-1_c']);
      assert.deepEqual(result.rejected.map((d) => d.taskId), ['bad']);
    });
  });
});

describe('setTaskIssuesState', () => {
  it('never sends a challenger to Linear and reports rejects as non-retryable failures', async () => {
    await withStateFile({ 'HOK-7_c': { linearIssueId: 'HOK-7' } }, async (stateFile) => {
      const calls: string[][] = [];
      const result = await setTaskIssuesState(['HOK-7_c', 'HOK-8', 'nope'], 'Done', {
        stateFile,
        log: silent,
        setIssuesStateImpl: async (ids) => {
          calls.push(ids);
          return { updated: ids, failed: [] };
        },
      });
      assert.deepEqual(calls, [['HOK-8']]);
      assert.deepEqual(result.updated, ['HOK-8']);
      assert.deepEqual(result.skipped, ['HOK-7_c']);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0]?.issueId, 'nope');
      assert.equal(result.failed[0]?.isRetryable, false);
    });
  });

  it('makes no Linear call when every task is a challenger', async () => {
    await withStateFile({}, async (stateFile) => {
      let called = false;
      const result = await setTaskIssuesState(['HOK-9_c'], 'In Progress', {
        stateFile,
        log: silent,
        setIssuesStateImpl: async () => {
          called = true;
          return { updated: [], failed: [] };
        },
      });
      assert.equal(called, false);
      assert.deepEqual(result, { updated: [], failed: [], skipped: ['HOK-9_c'] });
    });
  });
});
