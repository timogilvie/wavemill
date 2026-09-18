/**
 * Tests for tend-prep-state.ts
 *
 * Marker lifecycle, reconciliation, and recovery scenarios.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readInflightMarker,
  writeInflightMarker,
  advanceInflightPhase,
  recordActivePgid,
  recordPrePushShas,
  clearInflightMarker,
  markRecoveryUncertain,
  reconcileTendInflightState,
  checkRecoveryBlocker,
  type TendInflightRecord,
  type ReconcileOutcome,
} from './tend-prep-state.ts';
import { mergeLaneStateDir } from './merge-queue.ts';

// T5: marker lifecycle
test('tend-prep-state: marker write→advance→clear lifecycle', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const markerDir = join(tmpDir, '.wavemill', 'merge-lane');
    const markerPath = join(markerDir, 'tend-inflight.json');

    // Write marker
    const record: TendInflightRecord = {
      version: 1,
      prNumber: 123,
      headBranch: 'main',
      headSha: 'abc123',
      phase: 'claimed',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    };

    await writeInflightMarker(tmpDir, record);
    assert.ok(existsSync(markerPath), 'Marker should exist after write');

    let read = readInflightMarker(tmpDir);
    assert.equal(read?.phase, 'claimed', 'Initial phase should be claimed');

    // Advance phase
    await advanceInflightPhase(tmpDir, 'worktree-add');
    read = readInflightMarker(tmpDir);
    assert.equal(read?.phase, 'worktree-add', 'Phase should be advanced');
    assert.ok(read?.updatedAt! > record.updatedAt, 'updatedAt should move');

    // Clear marker
    await clearInflightMarker(tmpDir);
    const cleared = readInflightMarker(tmpDir);
    assert.strictEqual(cleared, null, 'Marker should be cleared');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T6: reconcile with no marker → `none`
test('tend-prep-state: reconcile with no marker returns none', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const deps = {
      readPrHeadSha: async () => null,
      readPrMergeState: async () => null,
      restoreWmReady: () => {},
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, 123, deps);
    assert.equal(outcome, 'none', 'Should return none when no marker exists');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T7: pre-mutation marker, dead pid → safe release
test('tend-prep-state: pre-mutation marker with dead pid releases to retryable', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 456;
    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: 'def456',
      phase: 'worktree-add',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99999, // Non-existent PID
    };

    await writeInflightMarker(tmpDir, record);

    let restoreReadyCalled = false;
    const deps = {
      readPrHeadSha: async () => 'def456',
      readPrMergeState: async () => 'OPEN' as const,
      restoreWmReady: () => { restoreReadyCalled = true; },
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'released-retryable', 'Should release to retryable');
    assert.ok(restoreReadyCalled, 'Should call restoreWmReady');

    const cleared = readInflightMarker(tmpDir);
    assert.strictEqual(cleared, null, 'Marker should be cleared');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T9: `push` marker, remote head == prePushSha → safe release (push never landed)
test('tend-prep-state: push phase marker with unmodified remote head is retryable', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 789;
    const baseSha = 'base000';
    const newSha = 'new111';

    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: baseSha,
      phase: 'push',
      prePushSha: baseSha,
      intendedHeadSha: newSha,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99998,
    };

    await writeInflightMarker(tmpDir, record);

    let restoreReadyCalled = false;
    const deps = {
      readPrHeadSha: async () => baseSha, // Still at base
      readPrMergeState: async () => 'OPEN' as const,
      restoreWmReady: () => { restoreReadyCalled = true; },
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'released-retryable', 'Should release to retryable');
    assert.ok(restoreReadyCalled, 'Should restore wm:ready');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T10: `push` marker, remote head == intendedHeadSha → safe release
test('tend-prep-state: push phase marker with modified remote head is retryable', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 1001;
    const baseSha = 'base222';
    const newSha = 'new333';

    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: baseSha,
      phase: 'push',
      prePushSha: baseSha,
      intendedHeadSha: newSha,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99997,
    };

    await writeInflightMarker(tmpDir, record);

    let restoreReadyCalled = false;
    const deps = {
      readPrHeadSha: async () => newSha, // Push succeeded
      readPrMergeState: async () => 'OPEN' as const,
      restoreWmReady: () => { restoreReadyCalled = true; },
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'released-retryable', 'Should release to retryable');
    assert.ok(restoreReadyCalled, 'Should restore wm:ready');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T11: `push` marker, remote head unknown/other → recovery-uncertain
test('tend-prep-state: push phase marker with mismatched remote head fails closed', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 1002;
    const baseSha = 'base444';
    const newSha = 'new555';
    const otherSha = 'other666';

    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: baseSha,
      phase: 'push',
      prePushSha: baseSha,
      intendedHeadSha: newSha,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99996,
    };

    await writeInflightMarker(tmpDir, record);

    const deps = {
      readPrHeadSha: async () => otherSha, // Unexpected SHA
      readPrMergeState: async () => 'OPEN' as const,
      restoreWmReady: () => {},
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'recovery-uncertain', 'Should fail closed');

    const marker = readInflightMarker(tmpDir);
    assert.equal(marker?.recovery, 'uncertain', 'Should mark as uncertain');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T12: `merging` marker, PR merged → completed-merged
test('tend-prep-state: merging phase marker with merged PR completes', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 1003;
    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: 'abc777',
      phase: 'merging',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99995,
    };

    await writeInflightMarker(tmpDir, record);

    const deps = {
      readPrHeadSha: async () => 'abc777',
      readPrMergeState: async () => 'MERGED' as const,
      restoreWmReady: () => {},
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'completed-merged', 'Should complete as merged');

    const cleared = readInflightMarker(tmpDir);
    assert.strictEqual(cleared, null, 'Marker should be cleared');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T13: marker pid alive (different process) → held-live-process (no side effects)
test('tend-prep-state: live different process holding marker is not reconciled', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 1004;
    // Use a process ID that definitely doesn't match this process and is likely alive
    // (e.g., init, shell, etc. on Unix systems - we'll use a high PID we know won't match)
    const differentPid = 1; // init process is always alive

    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: 'abc888',
      phase: 'worktree-add',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: differentPid, // Different process
    };

    await writeInflightMarker(tmpDir, record);

    let restoreReadyCalled = false;
    const deps = {
      readPrHeadSha: async () => null,
      readPrMergeState: async () => null,
      restoreWmReady: () => { restoreReadyCalled = true; },
      restoreWmBlocked: () => {},
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'held-live-process', 'Should return held-live-process');
    assert.ok(!restoreReadyCalled, 'Should not call restoreWmReady');

    const marker = readInflightMarker(tmpDir);
    assert.ok(marker, 'Marker should still exist');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// RecordPrePushShas
test('tend-prep-state: recordPrePushShas stores SHA values', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const record: TendInflightRecord = {
      version: 1,
      prNumber: 2000,
      headBranch: 'main',
      headSha: 'initial',
      phase: 'claimed',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    };

    await writeInflightMarker(tmpDir, record);
    await recordPrePushShas(tmpDir, 'prePush123', 'intended456');

    const updated = readInflightMarker(tmpDir);
    assert.equal(updated?.prePushSha, 'prePush123', 'prePushSha should be stored');
    assert.equal(updated?.intendedHeadSha, 'intended456', 'intendedHeadSha should be stored');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// checkRecoveryBlocker
test('tend-prep-state: checkRecoveryBlocker detects uncertain recovery', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const record: TendInflightRecord = {
      version: 1,
      prNumber: 2001,
      headBranch: 'main',
      headSha: 'xyz',
      phase: 'push',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99999,
      recovery: 'uncertain',
      recoveryReason: 'Test reason',
    };

    await writeInflightMarker(tmpDir, record);

    const check = checkRecoveryBlocker(tmpDir);
    assert.equal(check.blocked, true, 'Should be blocked');
    assert.match(check.reason!, /Test reason/, 'Should include reason');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// markRecoveryUncertain
test('tend-prep-state: markRecoveryUncertain flags uncertain state', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const record: TendInflightRecord = {
      version: 1,
      prNumber: 2002,
      headBranch: 'main',
      headSha: 'abc999',
      phase: 'push',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99994,
    };

    await writeInflightMarker(tmpDir, record);
    await markRecoveryUncertain(tmpDir, 'API unavailable');

    const marked = readInflightMarker(tmpDir);
    assert.equal(marked?.recovery, 'uncertain', 'Should mark as uncertain');
    assert.equal(marked?.recoveryReason, 'API unavailable', 'Should store reason');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T8: Pre-mutation marker, retry budget exhausted → wm:blocked
test('tend-prep-state: pre-mutation marker with exhausted retry budget blocks PR', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 2500;
    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: 'exhausted123',
      phase: 'worktree-add',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99950, // Non-existent PID
    };

    await writeInflightMarker(tmpDir, record);

    // Create the exhausted marker to simulate that retries are exhausted
    const stateDir = mergeLaneStateDir(prNumber, tmpDir);
    const exhaustedPath = join(stateDir, '.retry-tend-prep-recovery-exhausted');
    writeFileSync(exhaustedPath, 'Test exhaustion reason');

    let blockedCalled = false;
    let blockReason = '';
    const deps = {
      readPrHeadSha: async () => 'exhausted123',
      readPrMergeState: async () => 'OPEN' as const,
      restoreWmReady: () => {},
      restoreWmBlocked: (pn: number, reason: string) => {
        blockedCalled = true;
        blockReason = reason;
      },
      restoreWmMerging: () => {},
      addPrComment: async () => {},
    };

    const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
    assert.equal(outcome, 'released-blocked', 'Should release as blocked when retries exhausted');
    assert.ok(blockedCalled, 'Should call restoreWmBlocked');
    assert.match(blockReason, /retry budget exhausted/, 'Should include budget exhaustion reason');

    const cleared = readInflightMarker(tmpDir);
    assert.strictEqual(cleared, null, 'Marker should be cleared');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

// T14: Process group termination during reconciliation
test('tend-prep-state: reconciliation terminates leaked process group (activePgid)', async () => {
  const tmpDir = mkdtempSync('/tmp/tend-prep-state-test-');
  try {
    const prNumber = 3001;
    const leakedPgid = 99888; // Fake process group ID

    const record: TendInflightRecord = {
      version: 1,
      prNumber,
      headBranch: 'main',
      headSha: 'pgid000',
      phase: 'worktree-add',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99887, // Dead process
      activePgid: leakedPgid, // Leaked process group
    };

    await writeInflightMarker(tmpDir, record);

    // Track calls to process.kill
    const killCalls: Array<[number, string]> = [];
    const originalKill = process.kill;
    process.kill = ((pgid: number, signal?: string) => {
      killCalls.push([pgid, signal || '']);
      // Don't actually kill anything; just track the call
      return true;
    }) as any;

    try {
      const deps = {
        readPrHeadSha: async () => 'pgid000',
        readPrMergeState: async () => 'OPEN' as const,
        restoreWmReady: () => {},
        restoreWmBlocked: () => {},
        restoreWmMerging: () => {},
        addPrComment: async () => {},
      };

      const outcome = await reconcileTendInflightState(tmpDir, prNumber, deps);
      assert.equal(outcome, 'released-retryable', 'Should release to retryable');

      // Verify process.kill was called for the leaked pgid with SIGTERM
      const sigTermCall = killCalls.find(([pgid, signal]) => pgid === -leakedPgid && signal === 'SIGTERM');
      assert.ok(sigTermCall, 'Should call process.kill with -pgid and SIGTERM for leaked process group');
    } finally {
      process.kill = originalKill;
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});
