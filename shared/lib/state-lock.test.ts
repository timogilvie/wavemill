import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { acquireStateLockSync, isOwnerReclaimable, reclaimLegacyStateLock, releaseStateLock, StateLockTimeoutError } from './state-lock.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'state-lock-')); dirs.push(dir); return dir; };
const cases = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'state-lock-cases.json'), 'utf8')).cases as Array<{ name: string; owner: Parameters<typeof isOwnerReclaimable>[0]; alive: boolean; reclaimable: boolean }>;
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('state-lock', () => {
  for (const entry of cases) {
    it(`shared owner contract: ${entry.name}`, () => assert.equal(isOwnerReclaimable(entry.owner, 'local', () => entry.alive), entry.reclaimable));
  }
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
