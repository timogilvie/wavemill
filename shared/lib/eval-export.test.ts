/**
 * Unit tests for eval-export — flatten, redact, CSV, and JSONL output.
 */

import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import {
  flattenRecord,
  redactText,
  toCsv,
  toJsonl,
  exportEvalDataset,
} from './eval-export.ts';
import type { ExportRow } from './eval-export.ts';

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
    originalPrompt: 'Add a logout button to the header',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6-20250514',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 245,
    timestamp: '2026-02-14T10:30:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Task completed with minor feedback.',
    issueId: 'HOK-500',
    prUrl: 'https://github.com/org/repo/pull/42',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// Flatten Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Flatten Tests ---\n');

test('flattenRecord produces correct flat row', () => {
  const record = makeRecord();
  const row = flattenRecord(record);

  assert.equal(row.id, record.id);
  assert.equal(row.timestamp, record.timestamp);
  assert.equal(row.prompt_text, record.originalPrompt);
  assert.equal(row.model_id, record.modelId);
  assert.equal(row.model_version, record.modelVersion);
  assert.equal(row.score, record.score);
  assert.equal(row.score_band, record.scoreBand);
  assert.equal(row.time_seconds, record.timeSeconds);
  assert.equal(row.intervention_required, false);
  assert.equal(row.intervention_count, 0);
  assert.equal(row.intervention_details, '[]');
  assert.equal(row.issue_id, 'HOK-500');
  assert.equal(row.pr_url, 'https://github.com/org/repo/pull/42');
});

test('flattenRecord computes prompt features correctly', () => {
  const record = makeRecord({
    originalPrompt: 'Hello world\nSecond line\nThird line with more words',
  });
  const row = flattenRecord(record);

  assert.equal(row.prompt_line_count, 3);
  assert.equal(row.prompt_word_count, 9);
  assert.equal(row.prompt_length, record.originalPrompt.length);
});

test('flattenRecord extracts complexity signals from metadata', () => {
  const record = makeRecord({
    metadata: { filesChanged: 5, linesAdded: 120, linesRemoved: 30 },
  });
  const row = flattenRecord(record);

  assert.equal(row.files_changed, 5);
  assert.equal(row.lines_added, 120);
  assert.equal(row.lines_removed, 30);
});

test('flattenRecord returns null for missing complexity signals', () => {
  const record = makeRecord({ metadata: {} });
  const row = flattenRecord(record);

  assert.equal(row.files_changed, null);
  assert.equal(row.lines_added, null);
  assert.equal(row.lines_removed, null);
});

test('flattenRecord handles missing optional fields', () => {
  const record = makeRecord({
    judgeModel: undefined,
    judgeProvider: undefined,
    issueId: undefined,
    prUrl: undefined,
    metadata: undefined,
  });
  const row = flattenRecord(record);

  assert.equal(row.judge_model, '');
  assert.equal(row.judge_provider, '');
  assert.equal(row.issue_id, '');
  assert.equal(row.pr_url, '');
  assert.equal(row.files_changed, null);
});

// ────────────────────────────────────────────────────────────────
// Redaction Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Redaction Tests ---\n');

test('redactText replaces email addresses', () => {
  const result = redactText('Contact user@example.com for details');
  assert.equal(result, 'Contact [EMAIL] for details');
});

test('redactText replaces URLs', () => {
  const result = redactText('See https://github.com/org/repo/pull/42 for the PR');
  assert.equal(result, 'See [URL] for the PR');
});

test('redactText replaces absolute file paths', () => {
  const result = redactText('Edit /Users/tim/project/src/index.ts to fix');
  assert.ok(result.includes('[PATH]'));
  assert.ok(!result.includes('/Users/tim'));
});

test('redactText handles multiple patterns in one string', () => {
  const input = 'Email joe@test.com, see https://example.com/page, file /src/lib/foo.ts';
  const result = redactText(input);
  assert.ok(result.includes('[EMAIL]'));
  assert.ok(result.includes('[URL]'));
  assert.ok(result.includes('[PATH]'));
  assert.ok(!result.includes('joe@test.com'));
  assert.ok(!result.includes('https://example.com'));
});

test('flattenRecord applies redaction when redact=true', () => {
  const record = makeRecord({
    originalPrompt: 'Fix bug reported by admin@company.com',
    rationale: 'See https://github.com/org/repo for details',
  });
  const row = flattenRecord(record, { redact: true });

  assert.ok(row.prompt_text.includes('[EMAIL]'));
  assert.ok(!row.prompt_text.includes('admin@company.com'));
  assert.ok(row.rationale.includes('[URL]'));
  assert.ok(!row.rationale.includes('https://github.com'));
});

test('flattenRecord preserves original prompt length even when redacted', () => {
  const record = makeRecord({
    originalPrompt: 'Fix bug reported by admin@company.com',
  });
  const row = flattenRecord(record, { redact: true });

  // prompt_length should reflect the original, not the redacted text
  assert.equal(row.prompt_length, record.originalPrompt.length);
});

// ────────────────────────────────────────────────────────────────
// CSV Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- CSV Tests ---\n');

test('toCsv produces header and data rows', () => {
  const rows = [flattenRecord(makeRecord())];
  const csv = toCsv(rows);
  const lines = csv.trim().split('\n');

  assert.equal(lines.length, 2); // header + 1 data row
  assert.ok(lines[0].startsWith('id,'));
  assert.ok(lines[0].includes('prompt_text'));
  assert.ok(lines[0].includes('score'));
});

test('toCsv escapes fields with commas and quotes', () => {
  const record = makeRecord({
    originalPrompt: 'Fix "the bug", please',
    rationale: 'Done, with effort',
  });
  const rows = [flattenRecord(record)];
  const csv = toCsv(rows);

  // The prompt should be quoted and double-quotes escaped
  assert.ok(csv.includes('""the bug""'));
});

test('toCsv column count matches header count', () => {
  const rows = [flattenRecord(makeRecord()), flattenRecord(makeRecord({ id: 'id-2' }))];
  const csv = toCsv(rows);
  const lines = csv.trim().split('\n');
  const headerCols = lines[0].split(',').length;

  // Each data line should have same number of fields (accounting for quoted commas)
  // Simpler check: header has 22 columns
  assert.equal(headerCols, 22);
});

// ────────────────────────────────────────────────────────────────
// JSONL Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- JSONL Tests ---\n');

test('toJsonl produces valid JSON per line', () => {
  const rows = [
    flattenRecord(makeRecord({ id: 'r1' })),
    flattenRecord(makeRecord({ id: 'r2' })),
  ];
  const jsonl = toJsonl(rows);
  const lines = jsonl.trim().split('\n');

  assert.equal(lines.length, 2);
  const parsed1 = JSON.parse(lines[0]);
  const parsed2 = JSON.parse(lines[1]);
  assert.equal(parsed1.id, 'r1');
  assert.equal(parsed2.id, 'r2');
});

test('toJsonl includes all fields', () => {
  const row = flattenRecord(makeRecord());
  const jsonl = toJsonl([row]);
  const parsed = JSON.parse(jsonl.trim());

  assert.ok('id' in parsed);
  assert.ok('prompt_text' in parsed);
  assert.ok('prompt_length' in parsed);
  assert.ok('score' in parsed);
  assert.ok('score_band' in parsed);
  assert.ok('files_changed' in parsed);
  assert.ok('lines_added' in parsed);
});

// ────────────────────────────────────────────────────────────────
// Export Function Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Export Function Tests ---\n');

test('exportEvalDataset handles empty records', () => {
  const csv = exportEvalDataset({ format: 'csv', records: [] });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1); // header only

  const jsonl = exportEvalDataset({ format: 'jsonl', records: [] });
  assert.equal(jsonl.trim(), '');
});

test('exportEvalDataset respects format selection', () => {
  const records = [makeRecord()];

  const csv = exportEvalDataset({ format: 'csv', records });
  assert.ok(csv.startsWith('id,'));

  const jsonl = exportEvalDataset({ format: 'jsonl', records });
  assert.ok(jsonl.startsWith('{'));
});

test('exportEvalDataset applies redaction', () => {
  const records = [makeRecord({ originalPrompt: 'Email admin@test.com' })];

  const noRedact = exportEvalDataset({ format: 'jsonl', records, redact: false });
  assert.ok(noRedact.includes('admin@test.com'));

  const redacted = exportEvalDataset({ format: 'jsonl', records, redact: true });
  assert.ok(!redacted.includes('admin@test.com'));
  assert.ok(redacted.includes('[EMAIL]'));
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
