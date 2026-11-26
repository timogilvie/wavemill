import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { acquireStateLockSync, releaseStateLock } from './state-lock.ts';
import { processHost } from './process-identity.ts';

// HOK-3516 incident replay (HOK-3231): an ownerless directory at a lock path
// wedged the mill for ~88 hours because the module's own two-step removal
// raced a concurrent waiter. See the fixture README for the evidence.
const repoRoot = join(import.meta.dirname, '..', '..');
const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'incident-replay', 'real', 'hok3516-ownerless-lock');
const incident = JSON.parse(readFileSync(join(fixtureDir, 'incident.json'), 'utf8')) as { lockPath: string; strandedAt: string; expected: { ownerlessDirectoryAtLockPath: string } };

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'state-lock-hok3516-')); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const isOwnerless = (lockPath: string) => existsSync(lockPath) && !existsSync(join(lockPath, 'owner.json'));

describe('HOK-3516 replay: lock removal never strands an ownerless directory', () => {
  it('replays the recorded incident oracle', () => {
    assert.equal(incident.lockPath, '.wavemill/workflow-state.json.lock');
    assert.equal(incident.expected.ownerlessDirectoryAtLockPath, 'never');
  });

  it('removes a foreign .reclaim entry together with the released lock', () => {
    const state = join(temp(), 'workflow-state.json');
    const handle = acquireStateLockSync(state, { timeoutMs: 0, purpose: 'hok3516-foreign-reclaim' });
    mkdirSync(join(handle.lockPath, '.reclaim'));
    releaseStateLock(handle);
    assert.equal(existsSync(handle.lockPath), false);
  });

  it('release racing a .reclaim-spamming waiter leaves the lock path absent or owned', () => {
    const state = join(temp(), 'workflow-state.json');
    const lockPath = `${state}.lock`;
    const adversary = spawn(
      process.execPath,
      ['-e', "const fs=require('fs');for(;;){try{fs.mkdirSync(process.argv[1])}catch{}}", join(lockPath, '.reclaim')],
      { stdio: 'ignore' },
    );
    try {
      for (let i = 0; i < 200; i += 1) {
        releaseStateLock(acquireStateLockSync(state, { timeoutMs: 2_000, purpose: 'hok3516-release-race' }));
        assert.equal(isOwnerless(lockPath), false, `iteration ${i} stranded an ownerless directory at the lock path`);
      }
    } finally { adversary.kill('SIGKILL'); }
  });

  it('concurrent waiters reclaim a dead owner with a winner and no ownerless directory', async () => {
    const state = join(temp(), 'workflow-state.json');
    const lockPath = `${state}.lock`;
    const worker = join(repoRoot, 'tests', 'fixtures', 'state-lock-reclaim-worker.ts');
    for (let round = 0; round < 2; round += 1) {
      mkdirSync(lockPath, { recursive: true });
      const deadOwner = { pid: 99999999, processStartTime: 'gone', host: processHost(), acquiredAt: incident.strandedAt, purpose: 'hok3516-dead-owner' };
      writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify(deadOwner)}\n`);
      const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', worker, state], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => { out += String(chunk); });
        child.on('error', reject);
        child.on('close', () => resolve(out.trim()));
      })));
      assert.ok(results.includes('won'), `round ${round}: no waiter reclaimed the dead owner's lock (${results.join(',') || 'no output'})`);
      assert.equal(isOwnerless(lockPath), false, `round ${round} stranded an ownerless directory at the lock path`);
    }
  });
});
