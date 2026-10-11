import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import {
  DUPLICATE_ATTEMPT_EVENT,
  SHADOW_SIDE_EFFECT_ROOT_SLUG,
  gitPushKey,
  linearTransitionKey,
  normalizePushRef,
  prLabelKey,
  prLabelKeyPrefix,
  prMergeKey,
  resolveSideEffectOwner,
  setSideEffectLedgerForTesting,
  shadowRecordSideEffect,
  synthesizeTriggerEventId,
} from './side-effect-ledger.ts';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-side-effect-ledger-'));
  ledger = Ledger.open({ dbPath: join(dir, 'ledger.sqlite') });
});

afterEach(() => {
  setSideEffectLedgerForTesting(null);
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

test('key builders produce the canonical design §4b tuples', () => {
  assert.equal(gitPushKey('origin', 'task/x', 'abc'), 'origin|refs/heads/task/x|abc');
  assert.equal(gitPushKey('origin', 'refs/heads/task/x', 'abc'), 'origin|refs/heads/task/x|abc');
  assert.equal(normalizePushRef('refs/archive/x'), 'refs/archive/x');
  assert.equal(prLabelKey(42, 'wm:ready', 'labeled', 'h1'), '42|wm:ready|labeled|h1');
  assert.equal(prLabelKey('42', 'wm:ready', 'unlabeled', undefined), '42|wm:ready|unlabeled|unknown');
  assert.ok(prLabelKey(42, 'wm:ready', 'labeled', 'h1').startsWith(prLabelKeyPrefix(42, 'wm:ready', 'labeled')));
  assert.equal(prMergeKey(42, 'h1'), '42|h1');
  assert.equal(linearTransitionKey('HOK-1', 'In Review', 'Done', 'evt-1'), 'HOK-1|In Review|Done|evt-1');
  assert.equal(linearTransitionKey('HOK-1', undefined, 'Done', 'evt-1'), 'HOK-1|unknown|Done|evt-1');
});

test('synthesized trigger ids collapse within a second and differ across hints', () => {
  const at = new Date('2026-10-11T12:00:00.250Z');
  const sameSecond = new Date('2026-10-11T12:00:00.900Z');
  assert.equal(synthesizeTriggerEventId('tool', 'Done', at), synthesizeTriggerEventId('tool', 'Done', sameSecond));
  assert.notEqual(synthesizeTriggerEventId('tool', 'Done', at), synthesizeTriggerEventId('other', 'Done', at));
  assert.equal(synthesizeTriggerEventId(undefined, 'Done', at), 'direct:unknown:Done:2026-10-11T12:00:00');
});

test('owner resolution: explicit step, then issue key / WAVEMILL_ISSUE, then the fallback root', () => {
  assert.equal(resolveSideEffectOwner(ledger, { stepId: 'step-1' }), 'step-1');
  const issueOwner = resolveSideEffectOwner(ledger, { issueKey: 'HOK-1' }, {});
  assert.equal(ledger.getTask(issueOwner)?.slug, 'HOK-1');
  const envOwner = resolveSideEffectOwner(ledger, {}, { WAVEMILL_ISSUE: 'HOK-2' });
  assert.equal(ledger.getTask(envOwner)?.slug, 'HOK-2');
  const fallback = resolveSideEffectOwner(ledger, {}, {});
  assert.equal(ledger.getTask(fallback)?.slug, SHADOW_SIDE_EFFECT_ROOT_SLUG);
  assert.equal(resolveSideEffectOwner(ledger, {}, {}), fallback, 'fallback root is a singleton');
});

test('first request records an applied row; a repeat bumps attempt and leaves evidence', () => {
  setSideEffectLedgerForTesting(ledger);
  const key = gitPushKey('origin', 'task/x', 'abc');
  const first = shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key, result: { outcome: 'pushed' }, issueKey: 'HOK-1' });
  assert.equal(first?.isNew, true);
  assert.equal(first?.duplicate, false);
  assert.ok(first?.row.applied_at);
  assert.equal(first?.row.attempt, 0);

  const second = shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key, result: { outcome: 'pushed' }, issueKey: 'HOK-1' });
  assert.equal(second?.isNew, false);
  assert.equal(second?.duplicate, true);
  assert.equal(second?.row.attempt, 1);
  assert.equal(second?.row.id, first?.row.id);

  const evidence = ledger.listEvidenceByEvent(DUPLICATE_ATTEMPT_EVENT);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].step_id, first?.row.step_id);
  assert.equal(evidence[0].detail, `git-push|${key}`);
});

test('an observation of an already-applied effect is never a duplicate', () => {
  setSideEffectLedgerForTesting(ledger);
  const key = prMergeKey(42, 'h1');
  shadowRecordSideEffect({ kind: 'pr-merge', idempotencyKey: key, result: { outcome: 'merged' } });
  const observed = shadowRecordSideEffect({ kind: 'pr-merge', idempotencyKey: key, result: { outcome: 'already-merged' }, observation: true });
  assert.equal(observed?.duplicate, false);
  assert.equal(observed?.row.attempt, 0);
  assert.deepEqual(JSON.parse(observed?.row.result ?? 'null'), { outcome: 'merged' }, 'the original outcome is kept');
  assert.equal(ledger.listEvidenceByEvent(DUPLICATE_ATTEMPT_EVENT).length, 0);
});

test('a first-seen observation still records an applied row', () => {
  setSideEffectLedgerForTesting(ledger);
  const outcome = shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: gitPushKey('origin', 'b', 'o'), result: { outcome: 'reused' }, observation: true });
  assert.equal(outcome?.isNew, true);
  assert.ok(outcome?.row.applied_at);
});

test('outside a mill session, under a unit test, or with the kill switch, nothing is written', () => {
  const input = { kind: 'git-push' as const, idempotencyKey: 'k', repoDir: dir };
  assert.equal(shadowRecordSideEffect({ ...input, env: {} }), null, 'no WAVEMILL_SESSION');
  assert.equal(shadowRecordSideEffect({ ...input, env: { WAVEMILL_SESSION: 's', NODE_TEST_CONTEXT: 'child' } }), null, 'unit test inside a mill pane');
  setSideEffectLedgerForTesting(ledger);
  assert.equal(shadowRecordSideEffect({ ...input, env: { WAVEMILL_LEDGER_SHADOW_DISABLED: '1' } }), null, 'kill switch wins over the test ledger');
  assert.equal(ledger.findSideEffect('git-push', 'k'), null);
});

test('a mill session writes to the repo ledger', () => {
  const repoDir = join(dir, 'repo');
  const outcome = shadowRecordSideEffect({ kind: 'pr-label', idempotencyKey: 'k', repoDir, env: { WAVEMILL_SESSION: 's' } });
  assert.equal(outcome?.isNew, true);
  const repoLedger = Ledger.open({ repoDir });
  try {
    assert.ok(repoLedger.findSideEffect('pr-label', 'k'));
  } finally {
    repoLedger.close();
  }
});

test('ledger failures are swallowed', () => {
  setSideEffectLedgerForTesting(ledger);
  ledger.close();
  assert.equal(shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: 'k' }), null);
  ledger = Ledger.open({ dbPath: join(dir, 'ledger.sqlite') });
});
