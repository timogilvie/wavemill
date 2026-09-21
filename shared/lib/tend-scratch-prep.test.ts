import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  clearScratchPrepMarkerBestEffort,
  createProcessGroupPrepRunner,
  isOwnerAlive,
  listScratchPrepMarkers,
  readScratchPrepMarker,
  SAFE_PREP_PHASES,
  scratchPrepMarkerPath,
  writeScratchPrepMarker,
  writeScratchPrepMarkerBestEffort,
  WorktreePrepTimeoutError,
} from './tend-scratch-prep.ts';

function makeRepoDir(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-scratch-prep-'));
  mkdirSync(join(repoDir, '.wavemill', 'merge-lane'), { recursive: true });
  return { repoDir, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) };
}

function waitForPidGone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const step = (): void => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(step, 25);
    };
    step();
  });
}

describe('scratch-prep marker persistence', () => {
  it('creates the marker under merge-lane state dir and re-reads it', async () => {
    const { repoDir, cleanup } = makeRepoDir();
    try {
      const marker = await writeScratchPrepMarker(repoDir, {
        prNumber: 42,
        headBranch: 'task/marker-test',
        phase: 'reap',
        headSha: 'deadbeef',
        featureDir: join(repoDir, 'features', 'marker-test'),
        worktreePath: '/tmp/wavemill-tend/42',
      });
      assert.equal(marker.phase, 'reap');
      assert.equal(marker.prNumber, 42);
      assert.equal(marker.pid, process.pid);
      assert.equal(marker.headSha, 'deadbeef');

      const markerPath = scratchPrepMarkerPath(42, repoDir);
      assert.ok(existsSync(markerPath));
      const raw = JSON.parse(readFileSync(markerPath, 'utf-8')) as { phase: string; version: number };
      assert.equal(raw.phase, 'reap');
      assert.equal(raw.version, 1);

      const read = readScratchPrepMarker(repoDir, 42);
      assert.equal(read?.phase, 'reap');
      assert.equal(read?.prNumber, 42);
    } finally {
      cleanup();
    }
  });

  it('advances phase in place and updates phaseStartedAt only on phase change', async () => {
    const { repoDir, cleanup } = makeRepoDir();
    try {
      const first = await writeScratchPrepMarker(repoDir, {
        prNumber: 7,
        headBranch: 'task/phase-advance',
        phase: 'reap',
      });
      // Same-phase repeat: phaseStartedAt stays the same, updatedAt advances.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await writeScratchPrepMarker(repoDir, {
        prNumber: 7,
        headBranch: 'task/phase-advance',
        phase: 'reap',
      });
      assert.equal(second.phaseStartedAt, first.phaseStartedAt);
      assert.ok(second.updatedAt >= first.updatedAt);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const third = await writeScratchPrepMarker(repoDir, {
        prNumber: 7,
        headBranch: 'task/phase-advance',
        phase: 'fetch',
      });
      assert.equal(third.phase, 'fetch');
      assert.notEqual(third.phaseStartedAt, first.phaseStartedAt);
    } finally {
      cleanup();
    }
  });

  it('best-effort write swallows errors; strict write rethrows', async () => {
    const { repoDir, cleanup } = makeRepoDir();
    // Point the marker at a path whose parent directory cannot be created.
    const bogusRepo = '/proc/should-not-be-writable-by-this-test-that-only-runs-locally';
    try {
      const best = await writeScratchPrepMarkerBestEffort(bogusRepo, {
        prNumber: 99,
        headBranch: 'task/perm-test',
        phase: 'reap',
      });
      // Either it silently returned null on failure, or the environment allowed
      // the write. Both are acceptable — the important property is that no
      // exception escaped.
      assert.ok(best === null || best.phase === 'reap');

      // Non-best-effort path: normal repoDir succeeds.
      const marker = await writeScratchPrepMarker(repoDir, {
        prNumber: 100,
        headBranch: 'task/strict',
        phase: 'push',
        prePushSha: 'aaa',
        rebasedHeadSha: 'bbb',
      });
      assert.equal(marker.phase, 'push');
    } finally {
      cleanup();
    }
  });

  it('clears the marker best-effort; missing marker is a no-op', async () => {
    const { repoDir, cleanup } = makeRepoDir();
    try {
      await writeScratchPrepMarker(repoDir, {
        prNumber: 8,
        headBranch: 'task/clear-me',
        phase: 'ready',
      });
      const markerPath = scratchPrepMarkerPath(8, repoDir);
      assert.ok(existsSync(markerPath));
      clearScratchPrepMarkerBestEffort(repoDir, 8);
      assert.ok(!existsSync(markerPath));
      // Second clear on an already-gone marker is silent.
      clearScratchPrepMarkerBestEffort(repoDir, 8);
    } finally {
      cleanup();
    }
  });

  it('listScratchPrepMarkers finds only markers under the merge-lane dir', async () => {
    const { repoDir, cleanup } = makeRepoDir();
    try {
      await writeScratchPrepMarker(repoDir, { prNumber: 111, headBranch: 'task/a', phase: 'add' });
      await writeScratchPrepMarker(repoDir, { prNumber: 222, headBranch: 'task/b', phase: 'push' });
      // Non-numeric directory entry should be ignored.
      mkdirSync(join(repoDir, '.wavemill', 'merge-lane', 'not-a-pr'), { recursive: true });
      writeFileSync(join(repoDir, '.wavemill', 'merge-lane', 'not-a-pr', 'scratch-prep.json'), '{}');

      const found = listScratchPrepMarkers(repoDir);
      const numbers = found.map((m) => m.prNumber).sort();
      assert.deepEqual(numbers, [111, 222]);
    } finally {
      cleanup();
    }
  });

  it('SAFE_PREP_PHASES contains exactly the safe (no-remote-mutation) phases', () => {
    assert.ok(SAFE_PREP_PHASES.has('reap'));
    assert.ok(SAFE_PREP_PHASES.has('fetch'));
    assert.ok(SAFE_PREP_PHASES.has('add'));
    assert.ok(SAFE_PREP_PHASES.has('ready'));
    assert.ok(!SAFE_PREP_PHASES.has('push'));
    assert.ok(!SAFE_PREP_PHASES.has('pushed'));
    assert.ok(!SAFE_PREP_PHASES.has('merge'));
  });
});

describe('isOwnerAlive', () => {
  it('returns true for our own pid, false for a plainly dead one', () => {
    assert.equal(isOwnerAlive(process.pid), true);
    // A pid of 0 is not a valid target; treated as dead per our contract.
    assert.equal(isOwnerAlive(0), false);
    assert.equal(isOwnerAlive(-1), false);
  });

  it('treats a synthetic ESRCH from the signaller as dead', () => {
    const signaller = (): boolean => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    assert.equal(isOwnerAlive(999_999, signaller), false);
  });

  it('treats EPERM as alive (fail-safe: never touch a marker owned by a live process)', () => {
    const signaller = (): boolean => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    assert.equal(isOwnerAlive(2, signaller), true);
  });
});

describe('createProcessGroupPrepRunner', () => {
  it('propagates stdout from a fast successful command', async () => {
    const runner = createProcessGroupPrepRunner({ deadlineMs: 5_000 });
    const out = await runner.run("echo 'hello-prep'", { cwd: process.cwd(), phase: 'fetch' });
    assert.match(out, /hello-prep/);
    assert.ok(runner.remainingDeadlineMs() > 0);
  });

  it('rejects with WorktreePrepTimeoutError when the shared deadline expires', { timeout: 10_000 }, async () => {
    const runner = createProcessGroupPrepRunner({ deadlineMs: 250, killGraceMs: 200 });
    let onSpawnPid: number | null = null;
    let error: unknown;
    try {
      // sleep 2 (not 30) is still an order-of-magnitude longer than the 250ms
      // deadline so the runner's SIGTERM/SIGKILL path is exercised, but caps
      // the worst-case wall clock if a CI environment somehow lets the
      // pgid-directed kill escape (the natural sleep expiry then bounds it).
      // The runner also unrefs the child + stdio at spawn, so a stray pipe
      // held open by a descendant cannot keep the file worker's event loop
      // alive after this promise settles.
      await runner.run('sleep 2', {
        cwd: process.cwd(),
        phase: 'add',
        onSpawn: ({ pid }) => { onSpawnPid = pid; },
      });
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof WorktreePrepTimeoutError, `expected timeout, got ${error}`);
    assert.equal((error as WorktreePrepTimeoutError).phase, 'add');
    assert.ok((error as WorktreePrepTimeoutError).elapsedMs >= 250);
    // The child pid should be gone after the runner escalates to SIGKILL.
    assert.ok(onSpawnPid !== null, 'onSpawn should have been called');
    const gone = await waitForPidGone(onSpawnPid as unknown as number, 6_000);
    assert.ok(gone, `pid ${onSpawnPid} still alive after timeout`);
  });

  it('kills descendant processes via the process group (SIGKILL after grace)', { timeout: 10_000 }, async () => {
    // Start a bash script that spawns a long-lived child in the same group.
    // The runner's kill(-pgid, SIGTERM/SIGKILL) must terminate BOTH.
    const runner = createProcessGroupPrepRunner({ deadlineMs: 300, killGraceMs: 300 });
    let leaderPid = -1;
    let error: unknown;
    try {
      // sleep 2 (not 30) still comfortably outlives the 300ms deadline + 300ms
      // grace so the process-group teardown is what actually kills both
      // children — but caps the worst-case wall clock so a CI environment
      // that quietly refuses group signals (blocking the pipe write end open)
      // does not hang the whole node --test worker. The runner also unrefs the
      // child + stdio at spawn, so any stray descendant that outlives the
      // pgid kill cannot keep the file worker alive after this promise
      // settles.
      await runner.run(
        // The grandchild sleeps in the same process group as the shell child.
        'sleep 2 & printf "child=%d\n" "$!" >&2; sleep 2',
        {
          cwd: process.cwd(),
          phase: 'add',
          onSpawn: ({ pid }) => { leaderPid = pid; },
        },
      );
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof WorktreePrepTimeoutError);
    assert.ok(leaderPid > 0);
    // Extract the grandchild pid from stderr captured in the error output.
    const match = (error as WorktreePrepTimeoutError).output.match(/child=(\d+)/);
    if (match) {
      const grandchildPid = Number(match[1]);
      const gone = await waitForPidGone(grandchildPid, 6_000);
      assert.ok(gone, `grandchild ${grandchildPid} survived process-group kill`);
    }
    // Also assert the leader itself is gone.
    const leaderGone = await waitForPidGone(leaderPid, 6_000);
    assert.ok(leaderGone, `leader pid ${leaderPid} still alive after group kill`);
  });

  it('fires the heartbeat callback while a long command runs', async () => {
    const beats: number[] = [];
    const runner = createProcessGroupPrepRunner({
      deadlineMs: 3_000,
      heartbeatIntervalMs: 50,
      onHeartbeat: ({ phase }) => {
        assert.equal(phase, 'fetch');
        beats.push(Date.now());
      },
    });
    await runner.run('sleep 0.25', { cwd: process.cwd(), phase: 'fetch' });
    assert.ok(beats.length >= 1, `expected at least 1 heartbeat, got ${beats.length}`);
  });

  it('rejects immediately when the deadline is already exhausted', async () => {
    let clock = 0;
    const runner = createProcessGroupPrepRunner({ deadlineMs: 100, now: () => clock });
    clock = 200; // already past deadline
    await assert.rejects(
      runner.run("echo 'never runs'", { cwd: process.cwd(), phase: 'fetch' }),
      WorktreePrepTimeoutError,
    );
  });

  it('surfaces exit-code failures as regular errors, not timeouts', async () => {
    const runner = createProcessGroupPrepRunner({ deadlineMs: 5_000 });
    let error: unknown;
    try {
      await runner.run('exit 7', { cwd: process.cwd(), phase: 'fetch' });
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof WorktreePrepTimeoutError));
    assert.match(String((error as Error).message), /exit 7/);
  });

  it('supports an injected spawn function for tests that never touch the real shell', async () => {
    let spawned = 0;
    const runner = createProcessGroupPrepRunner({
      deadlineMs: 2_000,
      spawn: ((..._args: Parameters<typeof spawn>) => {
        spawned += 1;
        return spawn('/bin/sh', ['-c', 'echo injected']);
      }) as unknown as typeof spawn,
    });
    const out = await runner.run('anything', { cwd: process.cwd(), phase: 'fetch' });
    assert.equal(spawned, 1);
    assert.match(out, /injected/);
  });
});
