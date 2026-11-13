import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { acquireStateLock, acquireStateLockSync, isOwnerReclaimable, reclaimLegacyStateLock, releaseStateLock, StateLockTimeoutError } from './state-lock.ts';
import { processAlive, processStartTime } from './process-identity.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'state-lock-')); dirs.push(dir); return dir; };
const cases = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'state-lock-cases.json'), 'utf8')).cases as Array<{ name: string; owner: Parameters<typeof isOwnerReclaimable>[0]; alive: boolean; reclaimable: boolean }>;
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('state-lock', () => {
  for (const entry of cases) {
    it(`shared owner contract: ${entry.name}`, () => assert.equal(isOwnerReclaimable(entry.owner, 'local', () => entry.alive), entry.reclaimable));
  }
  it('keeps a live owner busy when ps is unavailable', () => {
    const start = processStartTime(process.pid);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent-state-lock-test-bin';
      assert.equal(processAlive(process.pid, start), true);
      assert.equal(processAlive(99999999, start), false);
    } finally { process.env.PATH = oldPath; }
  });
  // protects: a legacy file remains busy at runtime but startup can remove it.
  it('reclaims a legacy zero-byte file only through preflight', () => {
    const state = join(temp(), 'state.json'); writeFileSync(`${state}.lock`, '');
    assert.throws(() => acquireStateLockSync(state, { timeoutMs: 0 }), StateLockTimeoutError);
    assert.equal(reclaimLegacyStateLock(`${state}.lock`), true);
    const lock = acquireStateLockSync(state, { timeoutMs: 0 }); releaseStateLock(lock);
  });
  // protects: release only removes a lock still owned by this process identity.
  it('holds and releases an owned lock', () => { const state = join(temp(), 'state.json'); const lock = acquireStateLockSync(state, { timeoutMs: 0 }); releaseStateLock(lock); });
  it('gives concurrent claimants exactly one current owner', async () => {
    const state = join(temp(), 'state.json');
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireStateLock(state, { timeoutMs: 25, purpose: 'concurrent-claim' })));
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
    assert.equal(winners.length, 1);
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    releaseStateLock(winner.value);
  });
  it('does not reclaim an old lock while its stamped owner remains live', () => {
    const state = join(temp(), 'state.json');
    const owner = acquireStateLockSync(state, { timeoutMs: 0, purpose: 'slow-owner' });
    const ownerPath = join(owner.lockPath, 'owner.json');
    const old = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, string>;
    old.acquiredAt = '2000-01-01T00:00:00.000Z';
    writeFileSync(ownerPath, `${JSON.stringify(old)}\n`);
    assert.throws(() => acquireStateLockSync(state, { timeoutMs: 20, purpose: 'replacement' }), StateLockTimeoutError);
    releaseStateLock(owner);
  });
});
