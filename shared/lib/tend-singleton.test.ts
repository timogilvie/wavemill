import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { acquireObserverLock, acquireTendLock, computeLockKey, getLockPath, getServiceLockPath } from './tend-singleton.ts';
import { processHost, processStartTime } from './process-identity.ts';

function writeOwnerLock(lockPath: string, pid: number, start = processStartTime(pid)): void {
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid, processStartTime: start, host: processHost(), acquiredAt: new Date().toISOString(), purpose: 'test' }));
}

const tempDirs: string[] = [];

function createRepoDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tend-singleton-'));
  tempDirs.push(dir);
  return dir;
}

function captureLogs(): { logs: string[]; logger: (message: string) => void } {
  const logs: string[] = [];
  return {
    logs,
    logger: (message: string) => {
      logs.push(message);
    },
  };
}

afterEach(() => {
  delete process.env.WAVEMILL_TEND_SINGLETON_DISABLE;
  delete process.env.WAVEMILL_OBSERVER_SINGLETON_DISABLE;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('tend-singleton', () => {
  it('first acquisition returns started and writes the current pid', () => {
    const repoDir = createRepoDir();
    const { logs, logger } = captureLogs();

    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    assert.equal(result.outcome, 'started');
    assert.equal(JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf-8')).pid, process.pid);
    assert.match(logs[0], /\[tend-singleton\] started /);

    result.release();
  });

  it('duplicate acquisition skips when the recorded holder pid is alive', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeOwnerLock(lockPath, process.pid);

    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.holderPid, process.pid);
  });

  it('recovers a stale lock when the holder pid is gone', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeOwnerLock(lockPath, 2147483647, 'old-process');

    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    assert.equal(result.outcome, 'recovered-stale');
    assert.equal(result.holderPid, 2147483647);
    assert.equal(JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf-8')).pid, process.pid);

    result.release();
  });

  it('release removes the owned lock file', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    result.release();

    assert.equal(existsSync(lockPath), false);
  });

  it('release leaves the file in place if ownership changed', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    rmSync(lockPath, { recursive: true, force: true });
    writeOwnerLock(lockPath, 999999, 'replacement');
    result.release();

    assert.equal(JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf-8')).pid, 999999);
  });

  it('concurrent acquisition yields one started and one skipped result', async () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => acquireTendLock({ repoDir, session: 'session-a', logger })),
      Promise.resolve().then(() => acquireTendLock({ repoDir, session: 'session-a', logger })),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, ['skipped', 'started']);

    first.release();
    second.release();
  });

  it('throws on an invalid session name', () => {
    const repoDir = createRepoDir();
    assert.throws(
      () => acquireTendLock({ repoDir, session: '../etc/passwd', logger: () => {} }),
      /invalid session/
    );
  });

  it('uses the default session suffix when none is provided', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const result = acquireTendLock({ repoDir, logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir));

    assert.equal(result.outcome, 'started');
    assert.equal(existsSync(lockPath), true);

    result.release();
  });

  it('disables singleton behavior when the escape hatch env var is set', () => {
    process.env.WAVEMILL_TEND_SINGLETON_DISABLE = '1';
    const repoDir = createRepoDir();

    const result = acquireTendLock({ repoDir, session: 'session-a', logger: () => {} });
    assert.equal(result.outcome, 'started');
    assert.equal(result.release(), undefined);
  });

  it('uses separate lock files for tend and observer in the same repo/session', () => {
    const repoDir = createRepoDir();
    const lockKey = computeLockKey(repoDir, 'session-a');

    assert.equal(getLockPath(repoDir, lockKey), getServiceLockPath(repoDir, 'tend', lockKey));
    assert.notEqual(getServiceLockPath(repoDir, 'tend', lockKey), getServiceLockPath(repoDir, 'observer', lockKey));
  });

  it('observer duplicate acquisition skips when the recorded holder pid is alive', () => {
    const repoDir = createRepoDir();
    const { logs, logger } = captureLogs();
    const lockPath = getServiceLockPath(repoDir, 'observer', computeLockKey(repoDir, 'session-a'));

    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeOwnerLock(lockPath, process.pid);

    const result = acquireObserverLock({ repoDir, session: 'session-a', logger });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.holderPid, process.pid);
    assert.match(logs[0], /\[observer-singleton\] skipped /);
  });

  it('disables observer singleton behavior when the observer escape hatch is set', () => {
    process.env.WAVEMILL_OBSERVER_SINGLETON_DISABLE = '1';
    const repoDir = createRepoDir();

    const result = acquireObserverLock({ repoDir, session: 'session-a', logger: () => {} });
    assert.equal(result.outcome, 'started');
    assert.equal(result.release(), undefined);
  });
});
