import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMergeConflicts,
  readyStageDeps,
} from '../shared/lib/ready-stage.ts';

describe('ready-stage transient mergeability', () => {
  it('returns UNKNOWN after one observation for the shared Ready retry bucket', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () =>
      JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
    );
    const sleepMock = mock.method(readyStageDeps, 'sleep', async () => undefined);

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.attempts, 1);
      assert.equal(execMock.mock.callCount(), 1);
      assert.equal(sleepMock.mock.callCount(), 0);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('returns ERROR for non-transient GitHub merge states without retrying', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () =>
      JSON.stringify({ mergeable: 'BLOCKED', mergeStateStatus: 'ERROR' })
    );
    const sleepMock = mock.method(readyStageDeps, 'sleep', async () => undefined);

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'ERROR');
      assert.equal(result.attempts, 1);
      assert.match(result.message, /Unexpected mergeability state/);
      assert.equal(execMock.mock.callCount(), 1);
      assert.equal(sleepMock.mock.callCount(), 0);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('returns a transient GitHub exception after one observation', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () => {
      throw new Error('HTTP 504 from GitHub GraphQL');
    });
    const sleepCalls: number[] = [];
    const sleepMock = mock.method(readyStageDeps, 'sleep', async (ms: number) => {
      sleepCalls.push(ms);
    });

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'ERROR');
      assert.equal(result.attempts, 1);
      assert.match(result.error ?? '', /HTTP 504/);
      assert.equal(execMock.mock.callCount(), 1);
      assert.deepEqual(sleepCalls, []);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('returns the first UNKNOWN observation for monitor-owned retry', async () => {
    const responses = [
      JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    ];
    const execMock = mock.method(
      readyStageDeps,
      'execShellCommand',
      () => responses.shift() ?? JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
    );
    const sleepCalls: number[] = [];
    const sleepMock = mock.method(readyStageDeps, 'sleep', async (ms: number) => {
      sleepCalls.push(ms);
    });

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.attempts, 1);
      assert.equal(result.mergeStateStatus, 'UNKNOWN');
      assert.equal(execMock.mock.callCount(), 1);
      assert.deepEqual(sleepCalls, []);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('still returns CONFLICTED immediately for real merge conflicts', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () =>
      JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
    );
    const sleepMock = mock.method(readyStageDeps, 'sleep', async () => undefined);

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'CONFLICTED');
      assert.equal(result.attempts, 1);
      assert.equal(execMock.mock.callCount(), 1);
      assert.equal(sleepMock.mock.callCount(), 0);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });
});
