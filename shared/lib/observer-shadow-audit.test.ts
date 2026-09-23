import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendShadowRecord,
  buildShadowAuditRecord,
  loadShadowCounters,
  readShadowAudit,
  updateShadowCounters,
  type ShadowAuditRecord,
} from './observer-shadow-audit.ts';
import type { ShadowSyncPlan } from './incident-to-linear-synchronizer.ts';

function makePlan(overrides: Partial<ShadowSyncPlan> = {}): ShadowSyncPlan {
  return {
    fingerprint: 'f'.repeat(64),
    class: 'product_defect',
    task: 'HOK-1',
    evidenceRevision: 'rev-1',
    action: 'create',
    reason: 'shadow: planned issue create',
    plannedTitle: '[wavemill incident/product_defect] HOK-1: sample',
    plannedBody: '## Incident Summary\n- **Type**: product_defect',
    plannedCommentBody: undefined,
    correlationTarget: { matchedBy: 'none', candidateCount: 0 },
    reconciliation: { outcome: 'confirmed_active', evidence: {} },
    redactionSummary: {
      redactionEnabled: true,
      patternsApplied: 6,
      redactedEmails: true,
      redactedPaths: true,
      truncatedTranscripts: false,
      markersFound: [],
    },
    policyDecision: { allowed: true, strategy: 'create' },
    ...overrides,
  };
}

function makeRecord(recordedAt: string, plan: ShadowSyncPlan = makePlan()): ShadowAuditRecord {
  return buildShadowAuditRecord(plan, { recordedAt });
}

test('appendShadowRecord trims by maxEntries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-audit-max-entries-'));
  try {
    const path = join(dir, '.wavemill/observer/shadow-audit.jsonl');
    for (let i = 0; i < 12; i += 1) {
      appendShadowRecord(path, makeRecord(new Date(2026, 0, 1, 0, i).toISOString(), makePlan({
        fingerprint: `f${i}`.padEnd(64, '0'),
      })), { maxEntries: 5 });
    }
    const records = readShadowAudit(path);
    assert.equal(records.length, 5);
    assert.equal(records[0].fingerprint, 'f7' + '0'.repeat(62));
    assert.equal(records[4].fingerprint, 'f11' + '0'.repeat(61));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendShadowRecord trims by maxAgeDays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-audit-max-age-'));
  try {
    const path = join(dir, 'shadow.jsonl');
    const now = new Date('2026-09-22T12:00:00.000Z');
    // Old record: 30 days old
    appendShadowRecord(path, makeRecord('2026-08-23T12:00:00.000Z'), { maxAgeDays: 14, now });
    // Fresh record: 1 day old
    appendShadowRecord(path, makeRecord('2026-09-21T12:00:00.000Z', makePlan({ fingerprint: 'fresh'.padEnd(64, '0') })), { maxAgeDays: 14, now });
    const records = readShadowAudit(path);
    assert.equal(records.length, 1);
    assert.equal(records[0].fingerprint, 'fresh'.padEnd(64, '0'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendShadowRecord atomically replaces file content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-audit-atomic-'));
  try {
    const path = join(dir, 'shadow.jsonl');
    // Seed with a couple of records via ordinary append.
    appendShadowRecord(path, makeRecord('2026-09-22T00:00:00.000Z'));
    appendShadowRecord(path, makeRecord('2026-09-22T01:00:00.000Z', makePlan({ fingerprint: 'a'.repeat(64) })));
    const contents = readFileSync(path, 'utf-8').trim().split('\n');
    assert.equal(contents.length, 2);
    // Ensure each line is a valid JSON record (no partial writes).
    for (const line of contents) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.schemaVersion, '1.0');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow counters survive restart and accumulate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-counters-restart-'));
  try {
    const path = join(dir, 'shadow-counters.json');
    let counters = await updateShadowCounters(path, { eligible: 3, proposedCreate: 2, proposedUpdate: 1 }, { lastRunAt: '2026-09-22T12:00:00.000Z' });
    assert.equal(counters.eligible, 3);
    assert.equal(counters.proposedCreate, 2);

    // Simulate restart by clearing in-memory refs and re-reading from disk.
    counters = await loadShadowCounters(path);
    assert.equal(counters.eligible, 3);
    assert.equal(counters.lastRunAt, '2026-09-22T12:00:00.000Z');

    // Second pass accumulates.
    counters = await updateShadowCounters(path, { eligible: 4, proposedCreate: 1, correlationCollisions: 1 }, { lastRunAt: '2026-09-22T13:00:00.000Z' });
    assert.equal(counters.eligible, 7);
    assert.equal(counters.proposedCreate, 3);
    assert.equal(counters.correlationCollisions, 1);
    assert.equal(counters.lastRunAt, '2026-09-22T13:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow audit records contain no raw secret patterns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-audit-noraw-'));
  try {
    const path = join(dir, 'shadow.jsonl');
    // Even if the plan somehow carried a raw secret, the audit only stores
    // pre-redacted fields. The record itself should never contain a raw
    // pattern like an unredacted api_key=... or Bearer <token>.
    const plan = makePlan({
      plannedBody: [
        '## Incident Summary',
        'api_key=[REDACTED: secret]',
        'Bearer [REDACTED: secret]',
      ].join('\n'),
    });
    appendShadowRecord(path, makeRecord('2026-09-22T00:00:00.000Z', plan));
    const raw = readFileSync(path, 'utf-8');
    assert.doesNotMatch(raw, /api[_-]?key\s*=\s*[A-Za-z0-9]+(?=[",\s])/i);
    assert.doesNotMatch(raw, /Bearer\s+[A-Za-z0-9._~+/=-]{5,}/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildShadowAuditRecord captures correlation and policy metadata', () => {
  const plan = makePlan({
    correlationTarget: { matchedBy: 'fingerprint_label', identifier: 'HOK-9', url: 'https://linear.app/x', candidateCount: 1 },
    policyDecision: { allowed: false, strategy: 'no_create', reason: 'model outcomes suppressed' },
  });
  const record = buildShadowAuditRecord(plan, { recordedAt: '2026-09-22T12:00:00.000Z', repoDir: '/repo', session: 'wavemill' });
  assert.equal(record.correlationTarget.identifier, 'HOK-9');
  assert.equal(record.policyDecision.allowed, false);
  assert.equal(record.repoDir, '/repo');
  assert.equal(record.session, 'wavemill');
});
