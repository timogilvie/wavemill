import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import type { LabelWriteEntry } from './label-write-ledger.ts';
import {
  appendDuplicateLog,
  detectDuplicates,
  formatFinding,
  SIDE_EFFECT_DUPLICATE_LOG_FILENAME,
} from './side-effect-duplicate-detector.ts';
import { gitPushKey, prLabelKey, setSideEffectLedgerForTesting, shadowRecordSideEffect } from './side-effect-ledger.ts';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-side-effect-detector-'));
  ledger = Ledger.open({ dbPath: join(dir, 'ledger.sqlite') });
  setSideEffectLedgerForTesting(ledger);
});

afterEach(() => {
  setSideEffectLedgerForTesting(null);
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function labelWrite(overrides: Partial<LabelWriteEntry> = {}): LabelWriteEntry {
  return { at: new Date(Date.now() - 5 * 60_000).toISOString(), prNumber: 42, label: 'wm:ready', action: 'labeled', writer: 'mill', ...overrides };
}

test('empty ledger reports nothing', () => {
  const result = detectDuplicates(ledger, { labelWrites: [] });
  assert.deepEqual(result.findings, []);
  assert.equal(result.duplicateKeysAllTime, 0);
  assert.equal(result.scanned.duplicateEvents, 0);
});

test('a key requested twice is one duplicate finding', () => {
  const key = gitPushKey('origin', 'task/x', 'abc');
  shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key, result: { outcome: 'pushed' } });
  shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key, result: { outcome: 'pushed' } });
  shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key, result: { outcome: 'pushed' } });

  const result = detectDuplicates(ledger, { labelWrites: [] });
  assert.equal(result.duplicates, 1, 'repeats of one key collapse into one finding');
  const finding = result.findings[0];
  assert.equal(finding.category, 'duplicate');
  assert.equal(finding.category === 'duplicate' && finding.attempt, 2);
  assert.equal(finding.category === 'duplicate' && finding.applied, true);
  assert.equal(result.duplicateKeysAllTime, 1);
  assert.match(formatFinding(finding), /^\[side-effect-duplicate\] duplicate kind=git-push key=origin\|refs\/heads\/task\/x\|abc attempt=2/);
});

test('duplicates outside the window are not re-reported but stay in the all-time count', () => {
  const key = gitPushKey('origin', 'task/x', 'abc');
  shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key });
  shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key });
  const later = new Date(Date.now() + 60 * 60_000);
  const result = detectDuplicates(ledger, { labelWrites: [], now: later, sinceMs: 30 * 60_000 });
  assert.equal(result.duplicates, 0);
  assert.equal(result.duplicateKeysAllTime, 1);
});

test('a mill label write with no pr-label row is a missing-row finding', () => {
  const result = detectDuplicates(ledger, { labelWrites: [labelWrite()] });
  assert.equal(result.missingRows, 1);
  assert.deepEqual(
    { ...result.findings[0], observedAt: undefined },
    { category: 'missing-row', kind: 'pr-label', prNumber: 42, label: 'wm:ready', action: 'labeled', observedAt: undefined },
  );
});

test('a label write matched by its shadow row reports nothing', () => {
  const write = labelWrite({ at: new Date().toISOString() });
  shadowRecordSideEffect({ kind: 'pr-label', idempotencyKey: prLabelKey(42, 'wm:ready', 'labeled', 'h1') });
  const result = detectDuplicates(ledger, { labelWrites: [write], now: new Date(Date.now() + 5 * 60_000) });
  assert.equal(result.missingRows, 0);
});

test('a repeated label write at the same head matches the original row', () => {
  shadowRecordSideEffect({ kind: 'pr-label', idempotencyKey: prLabelKey(42, 'wm:ready', 'labeled', 'h1') });
  shadowRecordSideEffect({ kind: 'pr-label', idempotencyKey: prLabelKey(42, 'wm:ready', 'labeled', 'h1') });
  const later = new Date(Date.now() + 20 * 60_000);
  const result = detectDuplicates(ledger, { labelWrites: [labelWrite({ at: new Date(Date.now() + 10 * 60_000).toISOString() })], now: later });
  assert.equal(result.missingRows, 0);
  assert.equal(result.duplicates, 1);
});

test('label writes still inside the match window or outside the scan window are skipped', () => {
  const fresh = labelWrite({ at: new Date().toISOString() });
  const stale = labelWrite({ at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
  const result = detectDuplicates(ledger, { labelWrites: [fresh, stale] });
  assert.equal(result.missingRows, 0);
  assert.equal(result.scanned.labelWrites, 1);
});

test('appendDuplicateLog appends one JSONL record per run', () => {
  const result = detectDuplicates(ledger, { labelWrites: [] });
  appendDuplicateLog(dir, result);
  appendDuplicateLog(dir, result);
  const lines = readFileSync(join(dir, '.wavemill', SIDE_EFFECT_DUPLICATE_LOG_FILENAME), 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).duplicates, 0);
});
