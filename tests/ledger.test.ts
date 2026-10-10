import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Ledger, ParentHasOpenChildrenError, TaskSettledError, UniqueConstraintError } from '../shared/lib/ledger.ts';
let dir: string;
let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wavemill-ledger-')); dbPath = join(dir, 'ledger.sqlite'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function worker(mode: string, parentId: string, key: string): Promise<{ ok: boolean; isNew?: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/ledger-worker.ts', dbPath, mode, parentId, key], { cwd: process.cwd() });
    let output = ''; let stderr = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => stderr += b);
    child.on('close', code => { if (mode === 'crash') { assert.notEqual(code, 0); resolve({ ok: true }); } else { try { resolve(JSON.parse(output.trim())); } catch { reject(new Error(`${output}\n${stderr}`)); } } });
  });
}
test('schema, path and core transitions', () => {
  const ledger = Ledger.open({ dbPath });
  assert.equal(Ledger.open({ dbPath }), ledger);
  const root = ledger.transaction(tx => tx.insertTask({ kind: 'issue', slug: 'HOK-3180' }));
  const step = ledger.transaction(tx => tx.insertTask({ parentId: root.id, kind: 'step', slug: 'work', inputsHash: 'v1' }));
  assert.throws(() => ledger.transaction(tx => tx.insertTask({ parentId: root.id, kind: 'step', slug: 'work', inputsHash: 'v1' })), UniqueConstraintError);
  assert.throws(() => ledger.transaction(tx => tx.settleTask(root.id, 'done')), ParentHasOpenChildrenError);
  ledger.transaction(tx => { tx.transitionState(step.id, 'running'); tx.incrementAttempt(step.id); tx.setWaitingOn(step.id, 'head', { oid: 'abc' }); tx.recordEvidence(step.id, 'operator', 'started'); });
  assert.equal(ledger.listWaitingOn(step.id).length, 1);
  assert.equal(ledger.listEvidence(step.id).length, 1);
  ledger.transaction(tx => { tx.recordOperatorEvent({ taskId: step.id, kind: 'abort' }); tx.recordOperatorEvent({ taskId: step.id, kind: 'retry' }); });
  assert.deepEqual(ledger.listOperatorEvents(step.id).map(x => x.seq), [1,2]);
  ledger.transaction(tx => { tx.settleTask(step.id, 'done'); tx.settleTask(root.id, 'done'); });
  assert.throws(() => ledger.transaction(tx => tx.transitionState(step.id, 'running')), TaskSettledError);
  ledger.close();
});
test('background children and side effect idempotency', () => {
  const ledger = Ledger.open({ dbPath });
  const root = ledger.transaction(tx => tx.insertTask({ kind: 'issue', slug: 'HOK-1' }));
  ledger.transaction(tx => tx.insertTask({ parentId: root.id, kind: 'step', slug: 'background', background: true }));
  const first = ledger.transaction(tx => tx.recordSideEffect({ stepId: root.id, kind: 'git-push', idempotencyKey: 'same' }));
  ledger.transaction(tx => tx.applySideEffect(first.row.id, { oid: 'abc' }));
  const second = ledger.transaction(tx => tx.recordSideEffect({ stepId: root.id, kind: 'git-push', idempotencyKey: 'same' }));
  assert.equal(second.isNew, false);
  assert.equal(second.row.applied_at !== null, true);
  ledger.transaction(tx => tx.settleTask(root.id, 'done'));
  ledger.close();
});
test('parallel writers deduplicate effects and task identity', async () => {
  const ledger = Ledger.open({ dbPath });
  const root = ledger.transaction(tx => tx.insertTask({ kind: 'issue', slug: 'HOK-2' }));
  ledger.close();
  const effects = await Promise.all(Array.from({ length: 8 }, () => worker('effect', root.id, 'same-key')));
  assert.equal(effects.filter(x => x.isNew).length, 1);
  assert.equal(effects.filter(x => x.ok && !x.isNew).length, 7);
  const inserts = await Promise.all(Array.from({ length: 8 }, () => worker('insert', root.id, 'same-input')));
  assert.equal(inserts.filter(x => x.ok).length, 1);
  assert.equal(inserts.filter(x => x.code === 'unique_constraint').length, 7);
});
test('killed writer rolls back transaction', async () => {
  const ledger = Ledger.open({ dbPath });
  const root = ledger.transaction(tx => tx.insertTask({ kind: 'issue', slug: 'HOK-3' }));
  ledger.close();
  await worker('crash', root.id, 'kill');
  const reopened = Ledger.open({ dbPath });
  assert.equal(reopened.listChildren(root.id).length, 0);
  reopened.close();
});
