/**
 * Append-only JSONL storage for `cell-0.1.0` derived labels (HOK-3361).
 *
 * The stream is append-only: a re-run appends new rows; it never rewrites or
 * deletes history. The latest row for the versioned natural key
 * (repo, original_pr_url, corrective_pr_url) wins at query time, ordered by
 * `envelope.computed_at` with later file position breaking exact ties.
 *
 * Stored independently of the authoritative `cr-0.1.0` rework stream — this is
 * interpretation, not fact (see cell-label-contract.ts).
 */

import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonlFile } from './jsonl-utils.ts';
import {
  cellNaturalKey,
  validateCellLabelRow,
  type CellLabelKey,
  type CellLabelRowV0,
} from './cell-label-contract.ts';

export interface CellLabelStoreLoadResult {
  /** Well-formed rows in file order (history preserved). */
  rows: CellLabelRowV0[];
  /** Rows that failed validation, with the first problem each. */
  invalid: Array<{ line: number; problem: string }>;
}

/**
 * Read the raw append-only stream. Malformed JSON lines are skipped (the
 * shared JSONL convention); structurally invalid rows are reported, not
 * dropped silently.
 */
export function loadCellLabelRows(path: string): CellLabelStoreLoadResult {
  if (!existsSync(path)) {
    return { rows: [], invalid: [] };
  }
  const parsed = readJsonlFile<unknown>(path);
  const rows: CellLabelRowV0[] = [];
  const invalid: Array<{ line: number; problem: string }> = [];
  for (let index = 0; index < parsed.length; index++) {
    const problems = validateCellLabelRow(parsed[index]);
    if (problems.length > 0) {
      invalid.push({ line: index + 1, problem: problems[0] as string });
      continue;
    }
    rows.push(parsed[index] as CellLabelRowV0);
  }
  return { rows, invalid };
}

/**
 * Deduplicate to the latest row per natural key. `computed_at` wins; an exact
 * tie resolves to the later row in the stream (append order is meaningful).
 */
export function dedupeCellLabelRows(rows: CellLabelRowV0[]): Map<string, CellLabelRowV0> {
  const latest = new Map<string, CellLabelRowV0>();
  for (const row of rows) {
    const key = cellNaturalKey(row);
    const existing = latest.get(key);
    if (!existing || (row.envelope.computed_at >= existing.envelope.computed_at)) {
      latest.set(key, row);
    }
  }
  return latest;
}

/**
 * Load the deduplicated latest label per natural key.
 */
export function loadLatestCellLabels(
  path: string,
): { labels: Map<string, CellLabelRowV0>; invalid: Array<{ line: number; problem: string }> } {
  const { rows, invalid } = loadCellLabelRows(path);
  return { labels: dedupeCellLabelRows(rows), invalid };
}

/** Look up a label by its typed natural key. */
export function getCellLabel(
  labels: Map<string, CellLabelRowV0>,
  key: CellLabelKey,
): CellLabelRowV0 | undefined {
  return labels.get(cellNaturalKey(key));
}

/**
 * Append one validated row to the append-only stream. Crash-atomic per line
 * (single append write of the full serialized line); the stream is lock-free
 * per the repo's append-only JSONL convention.
 */
export function appendCellLabelRow(path: string, row: CellLabelRowV0): void {
  appendValidated(path, [row]);
}

/** Append many rows; validation failures abort before anything is written. */
export function appendCellLabelRows(path: string, rows: CellLabelRowV0[]): void {
  appendValidated(path, rows);
}

function appendValidated(path: string, rows: CellLabelRowV0[]): void {
  for (const row of rows) {
    const problems = validateCellLabelRow(row);
    if (problems.length > 0) {
      throw new Error(`refusing to append invalid cell label row: ${problems.join('; ')}`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    for (const row of rows) {
      writeSync(fd, `${JSON.stringify(row)}\n`);
    }
  } finally {
    closeSync(fd);
  }
}