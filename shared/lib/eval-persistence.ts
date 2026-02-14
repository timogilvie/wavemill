/**
 * Eval result persistence — append and query eval records in JSONL format.
 *
 * Records are stored as newline-delimited JSON (one JSON object per line)
 * in a configurable directory (default: `.wavemill/evals/`).
 *
 * @module eval-persistence
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EvalRecord } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const EVALS_FILENAME = 'evals.jsonl';

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

/** Options for specifying the eval storage directory. */
export interface PersistenceOptions {
  /** Override directory for eval storage. Resolved relative to cwd. */
  dir?: string;
}

/** Options for querying stored eval records. */
export interface QueryOptions extends PersistenceOptions {
  /** Filter by model identifier (exact match) */
  model?: string;
  /** Include only records after this date (inclusive) */
  after?: Date;
  /** Include only records before this date (inclusive) */
  before?: Date;
  /** Include only records with score >= this value */
  minScore?: number;
  /** Include only records with score <= this value */
  maxScore?: number;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Resolve the evals directory, reading from `.wavemill-config.json` if
 * no explicit `dir` is provided.
 *
 * Returns `{ dir, fromConfig }` — `fromConfig` is true when the path
 * came from `.wavemill-config.json` (needs path-traversal validation).
 */
function resolveEvalsDir(dir?: string): { dir: string; fromConfig: boolean } {
  if (dir) return { dir: resolve(dir), fromConfig: false };

  // Try reading evalsDir from .wavemill-config.json
  const configPath = resolve('.wavemill-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.eval?.evalsDir) {
        return { dir: resolve(config.eval.evalsDir), fromConfig: true };
      }
    } catch {
      // Malformed config — fall through to default
    }
  }

  return { dir: resolve(DEFAULT_EVALS_DIR), fromConfig: false };
}

/** Resolve the full path to the evals JSONL file. */
function resolveEvalsFile(dir?: string): string {
  return join(resolveEvalsDir(dir).dir, EVALS_FILENAME);
}

/**
 * Validate that the resolved directory doesn't escape the project root.
 * Throws if path traversal is detected.
 */
function assertSafePath(evalsDir: string): void {
  const projectRoot = resolve('.');
  const resolved = resolve(evalsDir);
  if (!resolved.startsWith(projectRoot)) {
    throw new Error(
      `Evals directory must be within the project root.\n` +
      `  Project root: ${projectRoot}\n` +
      `  Resolved dir: ${resolved}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Append an eval record to the JSONL file.
 *
 * Creates the output directory and file if they don't exist.
 * Uses atomic write (temp file + rename) to prevent corruption.
 *
 * @param record - The eval record to persist
 * @param options - Optional directory override
 */
export function appendEvalRecord(
  record: EvalRecord,
  options?: PersistenceOptions,
): void {
  const { dir: evalsDir, fromConfig } = resolveEvalsDir(options?.dir);
  if (fromConfig) assertSafePath(evalsDir);

  // Ensure directory exists
  mkdirSync(evalsDir, { recursive: true });

  const filePath = join(evalsDir, EVALS_FILENAME);
  const line = JSON.stringify(record) + '\n';

  // Atomic append: write to temp file then append to target.
  // For append operations, we read existing content, add our line, and
  // write the combined result atomically via temp file + rename.
  const tmpPath = join(evalsDir, `.evals-${randomUUID()}.tmp`);

  let existing = '';
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8');
  }

  writeFileSync(tmpPath, existing + line, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Read and optionally filter eval records from the JSONL file.
 *
 * Returns an empty array if the file doesn't exist.
 * Malformed lines are silently skipped.
 *
 * @param options - Query filters and directory override
 * @returns Array of matching eval records
 */
export function readEvalRecords(options?: QueryOptions): EvalRecord[] {
  const filePath = resolveEvalsFile(options?.dir);

  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  const records: EvalRecord[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as EvalRecord;
      if (matchesFilters(record, options)) {
        records.push(record);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

/**
 * Check whether a record matches all provided query filters.
 */
function matchesFilters(
  record: EvalRecord,
  options?: QueryOptions,
): boolean {
  if (!options) return true;

  if (options.model && record.modelId !== options.model) {
    return false;
  }

  if (options.after) {
    const recordDate = new Date(record.timestamp);
    if (recordDate < options.after) return false;
  }

  if (options.before) {
    const recordDate = new Date(record.timestamp);
    if (recordDate > options.before) return false;
  }

  if (options.minScore !== undefined && record.score < options.minScore) {
    return false;
  }

  if (options.maxScore !== undefined && record.score > options.maxScore) {
    return false;
  }

  return true;
}
