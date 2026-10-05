import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStateDirRetry } from './bounded-retry.ts';

function mkdir(): string {
  return mkdtempSync(join(tmpdir(), 'bounded-retry-test-'));
}

test('gate → increment → exhausted transitions', () => {
  const dir = mkdir();
  try {
    const retry = createStateDirRetry('observer-update-branch', { maxAttempts: 2, backoff: { baseSeconds: 0, capSeconds: 0 } });
    const head = 'aaaaaaa';
    assert.equal(retry.gate(dir, head), 'proceed');
    retry.increment(dir, head);
    assert.equal(retry.count(dir), 1);
    assert.equal(retry.gate(dir, head), 'proceed');
    retry.increment(dir, head);
    assert.equal(retry.gate(dir, head), 'exhausted');
    assert.equal(retry.isExhausted(dir), false, 'exhausted gate does not auto-terminalize');
    retry.markExhausted(dir, 'test-reason');
    assert.equal(retry.isExhausted(dir), true);
    assert.equal(retry.exhaustionReason(dir).trim(), 'test-reason');
    assert.equal(retry.gate(dir, head), 'exhausted-quiet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new key resets the bucket', () => {
  const dir = mkdir();
  try {
    const retry = createStateDirRetry('observer-ready-budget-reset', { maxAttempts: 1, backoff: { baseSeconds: 0, capSeconds: 0 } });
    retry.increment(dir, 'aaaaaaa');
    assert.equal(retry.gate(dir, 'aaaaaaa'), 'exhausted');
    assert.equal(retry.gate(dir, 'bbbbbbb'), 'proceed');
    assert.equal(retry.count(dir), 0, 'counter resets on new head');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear for failed-ready-recheck legacy prefix removes .failed-ready-recheck-* files', () => {
  const dir = mkdir();
  try {
    writeFileSync(join(dir, '.failed-ready-recheck-count'), '3');
    writeFileSync(join(dir, '.failed-ready-recheck-head'), 'aaaaaaa\n');
    writeFileSync(join(dir, '.failed-ready-recheck-exhausted'), 'reason');
    writeFileSync(join(dir, '.failed-ready-recheck-reason.json'), '{}');
    writeFileSync(join(dir, '.unrelated'), 'keep');
    const retry = createStateDirRetry('failed-ready-recheck', { maxAttempts: 1 });
    retry.clear(dir);
    const remaining = readdirSync(dir);
    assert.ok(!remaining.some((n) => n.startsWith('.failed-ready-recheck-')), 'all failed-ready-recheck files removed');
    assert.ok(remaining.includes('.unrelated'), 'unrelated files preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readKey returns stored head and base from the two-line key', () => {
  const dir = mkdir();
  try {
    const retry = createStateDirRetry('observer-update-branch', { maxAttempts: 2 });
    retry.increment(dir, 'aaaaaaa', 'bbbbbbb');
    const key = retry.readKey(dir);
    assert.equal(key.head, 'aaaaaaa');
    assert.equal(key.base, 'bbbbbbb');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markExhausted creates the sentinel file for the bucket', () => {
  const dir = mkdir();
  try {
    const retry = createStateDirRetry('observer-forfeit-arm', { maxAttempts: 1 });
    retry.markExhausted(dir, 'already-forfeited');
    assert.ok(existsSync(join(dir, '.retry-observer-forfeit-arm-exhausted')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bucket name must be kebab-case', () => {
  assert.throws(() => createStateDirRetry('BadBucket', { maxAttempts: 1 }), /kebab-case/);
  assert.throws(() => createStateDirRetry('', { maxAttempts: 1 }), /kebab-case/);
});
