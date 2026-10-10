/**
 * HOK-3182 — mill label-write ledger. All IO under mkdtemp (HOK-3157).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  indexMillLabelWrites,
  labelWriteLedgerPath,
  matchesMillLabelWrite,
  readMillLabelWrites,
  recordMillLabelWrite,
} from './label-write-ledger.ts';

let tmp: string | undefined;
function tempRepo(): string {
  tmp = mkdtempSync(join(tmpdir(), 'label-ledger-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('recordMillLabelWrite', () => {
  it('records one line per label when running inside a mill session', () => {
    const repo = tempRepo();
    const now = new Date('2026-10-10T12:00:00Z');
    recordMillLabelWrite(42, ['wm:ready', 'wm:merging'], 'labeled', { repoDir: repo, env: { WAVEMILL_SESSION: 'wavemill' }, now });
    recordMillLabelWrite('42', ['wm:ready'], 'unlabeled', { repoDir: repo, env: { WAVEMILL_SESSION: 'wavemill' }, now });

    const entries = readMillLabelWrites(repo);
    assert.deepEqual(entries.map((e) => [e.prNumber, e.label, e.action, e.writer, e.session]), [
      [42, 'wm:ready', 'labeled', 'mill', 'wavemill'],
      [42, 'wm:merging', 'labeled', 'mill', 'wavemill'],
      [42, 'wm:ready', 'unlabeled', 'mill', 'wavemill'],
    ]);
  });

  it('records nothing outside a mill session (operator writes must stay unmatched)', () => {
    const repo = tempRepo();
    recordMillLabelWrite(42, ['wm:ready'], 'labeled', { repoDir: repo, env: {} });
    assert.equal(existsSync(labelWriteLedgerPath(repo)), false);
  });

  it('records nothing from a node:test child that did not pin a repo dir', () => {
    const repo = tempRepo();
    recordMillLabelWrite(42, ['wm:ready'], 'labeled', {
      env: { WAVEMILL_SESSION: 'wavemill', NODE_TEST_CONTEXT: 'child-v8', REPO_DIR: repo },
    });
    assert.equal(existsSync(labelWriteLedgerPath(repo)), false);
  });
});

describe('matchesMillLabelWrite', () => {
  it('matches same PR + label + action within two minutes only', () => {
    const index = indexMillLabelWrites([
      { at: '2026-10-10T12:00:00Z', prNumber: 42, label: 'wm:ready', action: 'labeled', writer: 'mill' },
      { at: '2026-10-10T11:00:00Z', prNumber: 7, label: 'wm:blocked', action: 'labeled', writer: 'mill' },
    ]);
    assert.equal(index.startMs, Date.parse('2026-10-10T11:00:00Z'));
    const event = { prNumber: 42, label: 'wm:ready', action: 'labeled' as const, at: '2026-10-10T12:01:30Z' };
    assert.equal(matchesMillLabelWrite(index, event), true);
    assert.equal(matchesMillLabelWrite(index, { ...event, at: '2026-10-10T12:03:00Z' }), false);
    assert.equal(matchesMillLabelWrite(index, { ...event, action: 'unlabeled' }), false);
    assert.equal(matchesMillLabelWrite(index, { ...event, label: 'wm:merging' }), false);
    assert.equal(matchesMillLabelWrite(index, { ...event, prNumber: 43 }), false);
  });

  it('reads a missing ledger as empty and skips malformed lines', () => {
    const repo = tempRepo();
    assert.deepEqual(readMillLabelWrites(repo), []);
    recordMillLabelWrite(1, ['wm:ready'], 'labeled', { repoDir: repo, env: { WAVEMILL_SESSION: 's' } });
    writeFileSync(labelWriteLedgerPath(repo), 'garbage\n', { flag: 'a' });
    assert.equal(readMillLabelWrites(repo).length, 1);
  });
});
