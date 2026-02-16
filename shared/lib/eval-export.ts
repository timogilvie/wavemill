/**
 * Eval dataset export — flatten, redact, and serialize eval records
 * for ML training pipelines (router model training).
 *
 * Supports CSV and JSONL output formats with optional anonymization.
 *
 * @module eval-export
 */

import type { EvalRecord } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Export Row Schema
// ────────────────────────────────────────────────────────────────

/** A single flat row suitable for ML training. */
export interface ExportRow {
  id: string;
  timestamp: string;

  // Prompt features
  prompt_text: string;
  prompt_length: number;
  prompt_word_count: number;
  prompt_line_count: number;

  // Model
  model_id: string;
  model_version: string;

  // Outcome (target variable)
  score: number;
  score_band: string;

  // Timing
  time_seconds: number;

  // Intervention signals
  intervention_required: boolean;
  intervention_count: number;
  intervention_details: string;

  // Judge metadata
  judge_model: string;
  judge_provider: string;
  rationale: string;

  // Task context
  issue_id: string;
  pr_url: string;

  // Complexity signals (from metadata when available)
  files_changed: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}

/** Column order for CSV output. */
const COLUMNS: (keyof ExportRow)[] = [
  'id',
  'timestamp',
  'prompt_text',
  'prompt_length',
  'prompt_word_count',
  'prompt_line_count',
  'model_id',
  'model_version',
  'score',
  'score_band',
  'time_seconds',
  'intervention_required',
  'intervention_count',
  'intervention_details',
  'judge_model',
  'judge_provider',
  'rationale',
  'issue_id',
  'pr_url',
  'files_changed',
  'lines_added',
  'lines_removed',
];

// ────────────────────────────────────────────────────────────────
// Redaction
// ────────────────────────────────────────────────────────────────

/** Replace sensitive patterns in text with placeholders. */
export function redactText(text: string): string {
  let result = text;

  // Email addresses
  result = result.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[EMAIL]',
  );

  // URLs (http/https)
  result = result.replace(
    /https?:\/\/[^\s"'<>)}\]]+/g,
    '[URL]',
  );

  // Absolute file paths
  result = result.replace(
    /(?:\/[a-zA-Z0-9._-]+){2,}/g,
    '[PATH]',
  );

  return result;
}

// ────────────────────────────────────────────────────────────────
// Flatten
// ────────────────────────────────────────────────────────────────

export interface FlattenOptions {
  redact?: boolean;
}

/** Flatten an EvalRecord into a flat ExportRow for ML consumption. */
export function flattenRecord(
  record: EvalRecord,
  options?: FlattenOptions,
): ExportRow {
  const redact = options?.redact ?? false;

  const promptText = redact
    ? redactText(record.originalPrompt)
    : record.originalPrompt;

  const rationaleText = redact
    ? redactText(record.rationale)
    : record.rationale;

  // Extract complexity signals from metadata
  const meta = record.metadata ?? {};
  const filesChanged = typeof meta.filesChanged === 'number' ? meta.filesChanged : null;
  const linesAdded = typeof meta.linesAdded === 'number' ? meta.linesAdded : null;
  const linesRemoved = typeof meta.linesRemoved === 'number' ? meta.linesRemoved : null;

  return {
    id: record.id,
    timestamp: record.timestamp,

    prompt_text: promptText,
    prompt_length: record.originalPrompt.length,
    prompt_word_count: record.originalPrompt.split(/\s+/).filter(Boolean).length,
    prompt_line_count: record.originalPrompt.split('\n').length,

    model_id: record.modelId,
    model_version: record.modelVersion,

    score: record.score,
    score_band: record.scoreBand,

    time_seconds: record.timeSeconds,

    intervention_required: record.interventionRequired,
    intervention_count: record.interventionCount,
    intervention_details: JSON.stringify(record.interventionDetails),

    judge_model: record.judgeModel ?? '',
    judge_provider: record.judgeProvider ?? '',
    rationale: rationaleText,

    issue_id: record.issueId ?? '',
    pr_url: record.prUrl ?? '',

    files_changed: filesChanged,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}

// ────────────────────────────────────────────────────────────────
// CSV Writer
// ────────────────────────────────────────────────────────────────

/** Escape a field value for CSV (RFC 4180). */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/** Serialize rows as CSV with header. */
export function toCsv(rows: ExportRow[]): string {
  const header = COLUMNS.join(',');
  const dataLines = rows.map((row) =>
    COLUMNS.map((col) => escapeCsvField(row[col])).join(','),
  );
  return [header, ...dataLines].join('\n') + '\n';
}

// ────────────────────────────────────────────────────────────────
// JSONL Writer
// ────────────────────────────────────────────────────────────────

/** Serialize rows as JSONL (one JSON object per line). */
export function toJsonl(rows: ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// ────────────────────────────────────────────────────────────────
// Main Export Function
// ────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'jsonl';

export interface ExportOptions {
  format: ExportFormat;
  records: EvalRecord[];
  redact?: boolean;
}

/**
 * Export eval records as a training-ready dataset.
 *
 * @returns Serialized string in the requested format
 */
export function exportEvalDataset(options: ExportOptions): string {
  const rows = options.records.map((r) =>
    flattenRecord(r, { redact: options.redact }),
  );

  switch (options.format) {
    case 'csv':
      return toCsv(rows);
    case 'jsonl':
      return toJsonl(rows);
    default:
      throw new Error(`Unsupported format: ${options.format}`);
  }
}
