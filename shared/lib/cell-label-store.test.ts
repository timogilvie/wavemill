/**
 * Append-only/dedup semantics of the cell-0.1.0 stream (HOK-3361).
 * protects: a re-run must append history, never rewrite it, and latest
 * computed_at per natural key must win at query time.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appendCellLabelRow,
  appendCellLabelRows,
  dedupeCellLabelRows,
  getCellLabel,
  loadCellLabelRows,
  loadLatestCellLabels,
} from './cell-label-store.ts';
import { buildTestRow } from '../../tests/lib/cell-label-fixtures.ts';

function tempStream(): string {
  return join(mkdtempSync(join(tmpdir(), 'cell-label-store-')), 'cell-labels.jsonl');
}

describe('cell label store', () => {
  it('protects: appends are append-only and re-runs preserve history', () => {
    const path = tempStream();
    appendCellLabelRow(path, buildTestRow({ computedAt: '2026-02-01T00:00:00Z' }));
    appendCellLabelRow(path, buildTestRow({ computedAt: '2026-03-01T00:00:00Z' }));
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    const { rows, invalid } = loadCellLabelRows(path);
    assert.equal(rows.length, 2);
    assert.deepEqual(invalid, []);
    assert.equal(rows[0]?.envelope.computed_at, '2026-02-01T00:00:00Z');
    assert.equal(rows[1]?.envelope.computed_at, '2026-03-01T00:00:00Z');
  });

  it('protects: latest computed_at per natural key wins at query time', () => {
    const path = tempStream();
    appendCellLabelRows(path, [
      buildTestRow({ computedAt: '2026-02-01T00:00:00Z', correctiveUrl: 'https://github.com/owner/repo/pull/21' }),
      buildTestRow({ computedAt: '2026-04-01T00:00:00Z', correctiveUrl: 'https://github.com/owner/repo/pull/21' }),
      buildTestRow({ computedAt: '2026-03-01T00:00:00Z', correctiveUrl: 'https://github.com/owner/repo/pull/22' }),
    ]);
    const { labels } = loadLatestCellLabels(path);
    assert.equal(labels.size, 2);
    const latest = getCellLabel(labels, {
      repo: 'owner/repo',
      original_pr_url: 'https://github.com/owner/repo/pull/10',
      corrective_pr_url: 'https://github.com/owner/repo/pull/21',
    });
    assert.equal(latest?.envelope.computed_at, '2026-04-01T00:00:00Z');
  });

  it('protects: an exact computed_at tie resolves to the later stream position', () => {
    const rows = [
      buildTestRow({ computedAt: '2026-02-01T00:00:00Z' }),
      buildTestRow({ computedAt: '2026-02-01T00:00:00Z' }),
    ];
    const deduped = dedupeCellLabelRows(rows);
    assert.equal(deduped.size, 1);
    assert.equal([...deduped.values()][0], rows[1]);
  });

  it('protects: invalid rows are never appended and structurally broken stream rows are reported', () => {
    const path = tempStream();
    assert.throws(() => appendCellLabelRow(path, { bogus: true } as never), /refusing to append invalid/);
    const { invalid } = loadCellLabelRows(path);
    assert.equal(invalid.length, 0);
    const missing = loadCellLabelRows(join(tempStream(), 'missing.jsonl'));
    assert.deepEqual(missing.rows, []);
  });
});