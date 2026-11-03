import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { escalateOperatorAttention } from './operator-escalation.ts';
import { createStateDirRetry } from './bounded-retry.ts';

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'wm-escalation-'));
}

function markerBasis(stateDir: string): string | undefined {
  const marker = JSON.parse(readFileSync(join(stateDir, '.needs-attention'), 'utf8'));
  return marker.detail?.escalationBasis;
}

const silent = () => {};

// protects: the TS escalation twin pages on a first occurrence by mislabelling
// the basis (HOK-3360). Mirrors tests/operator-escalation.test.sh.

test('exhausted basis: refused when the bucket is not terminalized', () => {
  const dir = freshStateDir();
  try {
    const wrote = escalateOperatorAttention({
      stateDir: dir, headSha: 'abc', message: 'boom',
      basis: { kind: 'exhausted', bucket: 'stage-failure-ready' }, warn: silent,
    });
    assert.equal(wrote, false);
    assert.equal(existsSync(join(dir, '.needs-attention')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exhausted basis: accepted once the bucket is terminalized', () => {
  const dir = freshStateDir();
  try {
    createStateDirRetry('stage-failure-ready', { maxAttempts: 3 }).markExhausted(dir, 'spent');
    const wrote = escalateOperatorAttention({
      stateDir: dir, headSha: 'abc', message: 'Ready budget spent',
      basis: { kind: 'exhausted', bucket: 'stage-failure-ready' }, warn: silent,
    });
    assert.equal(wrote, true);
    assert.equal(markerBasis(dir), 'exhausted:stage-failure-ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy-terminal basis: accepted for terminal, refused otherwise', () => {
  const dir = freshStateDir();
  try {
    assert.equal(escalateOperatorAttention({
      stateDir: dir, headSha: 'abc', message: 'terminal',
      basis: { kind: 'policy-terminal', decisionClass: 'terminal' }, warn: silent,
    }), true);
    assert.equal(markerBasis(dir), 'policy-terminal:terminal');
    rmSync(join(dir, '.needs-attention'), { force: true });

    assert.equal(escalateOperatorAttention({
      stateDir: dir, headSha: 'abc', message: 'should not page',
      basis: { kind: 'policy-terminal', decisionClass: 'retryable' }, warn: silent,
    }), false);
    assert.equal(existsSync(join(dir, '.needs-attention')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator-decision basis: known accepted, unknown refused', () => {
  const dir = freshStateDir();
  try {
    assert.equal(escalateOperatorAttention({
      stateDir: dir, headSha: 'abc', message: 'merged early',
      basis: { kind: 'operator-decision', code: 'merged-before-ready' }, warn: silent,
    }), true);
    assert.equal(markerBasis(dir), 'operator-decision:merged-before-ready');
    rmSync(join(dir, '.needs-attention'), { force: true });

    assert.equal(escalateOperatorAttention({
      stateDir: dir, headSha: 'abc', message: 'should not page',
      basis: { kind: 'operator-decision', code: 'not-a-real-code' }, warn: silent,
    }), false);
    assert.equal(existsSync(join(dir, '.needs-attention')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the marker carries the first line of the message as its reason', () => {
  const dir = freshStateDir();
  try {
    escalateOperatorAttention({
      stateDir: dir, headSha: 'head1', message: 'first line\nsecond line',
      basis: { kind: 'operator-decision', code: 'merge-residue' }, warn: silent,
    });
    const marker = JSON.parse(readFileSync(join(dir, '.needs-attention'), 'utf8'));
    assert.equal(marker.reason, 'first line');
    assert.equal(marker.kind, 'ready-attention');
    assert.equal(marker.headSha, 'head1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
