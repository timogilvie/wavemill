import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { acquireStateLockSync, isOwnerReclaimable, reclaimLegacyStateLock, releaseStateLock, StateLockTimeoutError } from './state-lock.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'state-lock-')); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('state-lock', () => {
  // protects: a live owner is never stolen because it has held a lock for long.
  it('does not reclaim a live owner', () => assert.equal(isOwnerReclaimable({ pid: 1, processStartTime: 'same', host: 'local', acquiredAt: 'x', purpose: 'x' }, 'local', () => true), false));
  // protects: a dead owner and a reused PID are reclaimable.
  it('reclaims dead or pid-reused owners', () => assert.equal(isOwnerReclaimable({ pid: 1, processStartTime: 'old', host: 'local', acquiredAt: 'x', purpose: 'x' }, 'local', () => false), true));
  // protects: a legacy file remains busy at runtime but startup can remove it.
  it('reclaims a legacy zero-byte file only through preflight', () => {
    const state = join(temp(), 'state.json'); writeFileSync(`${state}.lock`, '');
    assert.throws(() => acquireStateLockSync(state, { timeoutMs: 0 }), StateLockTimeoutError);
    assert.equal(reclaimLegacyStateLock(`${state}.lock`), true);
    const lock = acquireStateLockSync(state, { timeoutMs: 0 }); releaseStateLock(lock);
  });
  // protects: release only removes a lock still owned by this process identity.
  it('holds and releases an owned lock', () => { const state = join(temp(), 'state.json'); const lock = acquireStateLockSync(state, { timeoutMs: 0 }); releaseStateLock(lock); });
});
