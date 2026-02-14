/**
 * Unit tests for eval-persistence — append, read, and query functions.
 *
 * Uses temp directories for file I/O and cleans up after each test.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord } from './eval-schema.ts';
import { appendEvalRecord, readEvalRecords } from './eval-persistence.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

function makeRecord(overrides?: Partial<EvalRecord>): EvalRecord {
  return {
    id: '550e8400-e29b-41d4-a716-446655440001',
    schemaVersion: '1.0.0',
    originalPrompt: 'Add a logout button',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6-20250514',
    score: 1.0,
    scoreBand: 'Full Success',
    timeSeconds: 245,
    timestamp: '2026-02-14T10:30:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Task completed autonomously.',
    issueId: 'HOK-500',
    prUrl: 'https://github.com/org/repo/pull/42',
    ...overrides,
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-persist-test-'));
}

function cleanUp(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────
// Append Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Append Tests ---\n');

test('append creates directory and file if they do not exist', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'nested', 'evals');
  try {
    appendEvalRecord(makeRecord(), { dir: evalsDir });
    const content = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8');
    assert.ok(content.length > 0);
  } finally {
    cleanUp(tmp);
  }
});

test('append writes a valid JSONL line', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    const record = makeRecord();
    appendEvalRecord(record, { dir: evalsDir });
    const content = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, record.id);
    assert.equal(parsed.score, record.score);
    assert.equal(parsed.modelId, record.modelId);
  } finally {
    cleanUp(tmp);
  }
});

test('multiple appends produce multiple lines', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'id-1', score: 0.5 }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'id-2', score: 0.8 }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'id-3', score: 1.0 }), { dir: evalsDir });

    const content = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3);

    const ids = lines.map((l) => JSON.parse(l).id);
    assert.deepEqual(ids, ['id-1', 'id-2', 'id-3']);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Read Tests — No Filters
// ────────────────────────────────────────────────────────────────

console.log('\n--- Read Tests ---\n');

test('read with no filters returns all records', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'r1');
    assert.equal(records[1].id, 'r2');
  } finally {
    cleanUp(tmp);
  }
});

test('read on missing file returns empty array', () => {
  const tmp = makeTempDir();
  try {
    const records = readEvalRecords({ dir: join(tmp, 'nonexistent') });
    assert.deepEqual(records, []);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Read Tests — Filters
// ────────────────────────────────────────────────────────────────

console.log('\n--- Filter Tests ---\n');

test('filter by model returns only matching records', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', modelId: 'claude-opus-4-6' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', modelId: 'claude-sonnet-4-5' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', modelId: 'claude-opus-4-6' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir, model: 'claude-opus-4-6' });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'r1');
    assert.equal(records[1].id, 'r3');
  } finally {
    cleanUp(tmp);
  }
});

test('filter by date range returns only records in range', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', timestamp: '2026-01-15T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', timestamp: '2026-03-05T00:00:00Z' }), { dir: evalsDir });

    const records = readEvalRecords({
      dir: evalsDir,
      after: new Date('2026-02-01'),
      before: new Date('2026-02-28'),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'r2');
  } finally {
    cleanUp(tmp);
  }
});

test('filter by minScore returns only records >= threshold', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', score: 0.3, scoreBand: 'Partial' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', score: 0.8, scoreBand: 'Minor Feedback' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', score: 1.0, scoreBand: 'Full Success' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir, minScore: 0.8 });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'r2');
    assert.equal(records[1].id, 'r3');
  } finally {
    cleanUp(tmp);
  }
});

test('filter by maxScore returns only records <= threshold', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', score: 0.3, scoreBand: 'Partial' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', score: 0.8, scoreBand: 'Minor Feedback' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', score: 1.0, scoreBand: 'Full Success' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir, maxScore: 0.5 });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'r1');
  } finally {
    cleanUp(tmp);
  }
});

test('combined filters work together', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', modelId: 'claude-opus-4-6', score: 0.9, scoreBand: 'Minor Feedback', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', modelId: 'claude-opus-4-6', score: 0.3, scoreBand: 'Partial', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', modelId: 'claude-sonnet-4-5', score: 0.9, scoreBand: 'Minor Feedback', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r4', modelId: 'claude-opus-4-6', score: 0.9, scoreBand: 'Minor Feedback', timestamp: '2026-01-05T00:00:00Z' }), { dir: evalsDir });

    const records = readEvalRecords({
      dir: evalsDir,
      model: 'claude-opus-4-6',
      minScore: 0.8,
      after: new Date('2026-02-01'),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'r1');
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Malformed Line Handling
// ────────────────────────────────────────────────────────────────

console.log('\n--- Malformed Line Tests ---\n');

test('malformed lines are skipped gracefully', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  try {
    const validRecord = makeRecord({ id: 'valid-1' });
    const content = [
      JSON.stringify(validRecord),
      'this is not valid json',
      '{"incomplete": true',
      JSON.stringify(makeRecord({ id: 'valid-2' })),
    ].join('\n') + '\n';

    writeFileSync(join(evalsDir, 'evals.jsonl'), content, 'utf-8');

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'valid-1');
    assert.equal(records[1].id, 'valid-2');
  } finally {
    cleanUp(tmp);
  }
});

test('empty file returns empty array', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  try {
    writeFileSync(join(evalsDir, 'evals.jsonl'), '', 'utf-8');
    const records = readEvalRecords({ dir: evalsDir });
    assert.deepEqual(records, []);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
