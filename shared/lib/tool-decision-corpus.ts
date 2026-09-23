/**
 * Tool-decision corpus storage (HOK-2076).
 *
 * Append-only JSONL storage for projected decision rows, with
 * read-back and session-scoped paths under `.wavemill/`.
 *
 * @module tool-decision-corpus
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import type { ToolDecisionRow, LabeledDecisionRow, OutcomeLabel } from './tool-decision-schema.ts';

const CORPUS_DIR = '.wavemill/tool-decisions';
const LABELS_DIR = '.wavemill/tool-decision-labels';

export function corpusPath(repoDir: string, sessionId: string): string {
  return join(repoDir, CORPUS_DIR, `${sessionId}.jsonl`);
}

export function labelsPath(repoDir: string, sessionId: string): string {
  return join(repoDir, LABELS_DIR, `${sessionId}.jsonl`);
}

export function appendDecisionRow(repoDir: string, sessionId: string, row: ToolDecisionRow): void {
  appendJsonlRecord(corpusPath(repoDir, sessionId), row);
}

export function appendDecisionRows(repoDir: string, sessionId: string, rows: ToolDecisionRow[]): void {
  if (rows.length === 0) return;
  const path = corpusPath(repoDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = rows.map((r) => JSON.stringify(r)).join('\n');
  const content = `${existing}${lines}\n`;
  const tmpPath = join(dirname(path), `.jsonl-tmp-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

export function readDecisionRows(repoDir: string, sessionId: string): ToolDecisionRow[] {
  const path = corpusPath(repoDir, sessionId);
  if (!existsSync(path)) return [];
  return readJsonlFile<ToolDecisionRow>(path);
}

export function appendOutcomeLabel(
  repoDir: string,
  sessionId: string,
  label: LabeledDecisionRow,
): void {
  appendJsonlRecord(labelsPath(repoDir, sessionId), label);
}

export function readOutcomeLabels(repoDir: string, sessionId: string): LabeledDecisionRow[] {
  const path = labelsPath(repoDir, sessionId);
  if (!existsSync(path)) return [];
  return readJsonlFile<LabeledDecisionRow>(path);
}

/**
 * List all session IDs that have decision corpus files.
 */
export function listCorpusSessions(repoDir: string): string[] {
  const dir = join(repoDir, CORPUS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.jsonl'))
    .map((f: string) => f.replace(/\.jsonl$/, ''));
}
