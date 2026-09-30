/**
 * Tool-decision corpus writer (HOK-2076).
 *
 * Append-only JSONL under `.wavemill/tool-decisions/` with per-file locks
 * and dedupe by decisionId. Callers may safely re-run the projector against
 * the same source stream — duplicate rows collapse without rewriting the
 * corpus.
 *
 * The corpus is a projection: it never mutates existing lines and never
 * carries anything the source stream does not already have permission to
 * store. Redaction/hash/artifact-ref conventions live in the projector
 * (which reads only sanitized fields from the source stream).
 */

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  parseToolDecisionJsonl,
  validateToolDecisionRow,
  type ToolDecisionRow,
} from './tool-decision-schema.ts';

const DEFAULT_CORPUS_DIR = '.wavemill/tool-decisions';
const LOCK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function resolveToolDecisionCorpusDir(repoDir?: string, explicitDir?: string): string {
  if (explicitDir) return resolve(explicitDir);
  return resolve(repoDir || process.cwd(), DEFAULT_CORPUS_DIR);
}

export function resolveToolDecisionCorpusPath(opts: {
  repoDir?: string;
  explicitDir?: string;
  /** File namespace. Defaults to "corpus". */
  namespace?: string;
}): string {
  const dir = resolveToolDecisionCorpusDir(opts.repoDir, opts.explicitDir);
  const namespace = opts.namespace ?? 'corpus';
  return resolve(dir, `${namespace}.jsonl`);
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function acquireCorpusLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const start = Date.now();
  mkdirSync(dirname(lockPath), { recursive: true });
  while (true) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      throw new Error(`tool-decision-corpus: lock timeout for ${lockPath}`);
    }
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort
    }
  };
}

// ---------------------------------------------------------------------------
// Existing-id index (dedup)
// ---------------------------------------------------------------------------

function readExistingDecisionIds(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const raw = readFileSync(path, 'utf-8');
  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { decisionId?: string };
      if (typeof parsed.decisionId === 'string') ids.add(parsed.decisionId);
    } catch {
      // corrupt line — leave it; reporter will flag it.
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface AppendResult {
  path: string;
  appended: number;
  skippedDuplicates: number;
  rejected: Array<{ decisionId?: string; reason: string }>;
}

/**
 * Append rows to a tool-decision corpus file, idempotently by decisionId.
 *
 * Rows that fail validation are collected in `rejected` and NOT written.
 * The write path is fsync'd. Callers may safely re-run with the same input.
 */
export function appendToolDecisions(
  rows: ToolDecisionRow[],
  path: string,
): AppendResult {
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireCorpusLock(path);
  try {
    const existing = readExistingDecisionIds(path);
    const pending: string[] = [];
    let appended = 0;
    let skipped = 0;
    const rejected: AppendResult['rejected'] = [];
    for (const row of rows) {
      const check = validateToolDecisionRow(row);
      if (!check.ok) {
        rejected.push({
          ...(typeof (row as { decisionId?: unknown }).decisionId === 'string'
            ? { decisionId: (row as { decisionId: string }).decisionId }
            : {}),
          reason: check.reason,
        });
        continue;
      }
      if (existing.has(row.decisionId)) {
        skipped += 1;
        continue;
      }
      pending.push(JSON.stringify(row));
      existing.add(row.decisionId);
      appended += 1;
    }
    if (pending.length > 0) {
      const content = pending.join('\n') + '\n';
      // 'a' both creates the file if absent and appends when present.
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, content, undefined, 'utf-8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return { path, appended, skippedDuplicates: skipped, rejected };
  } finally {
    release();
  }
}

/**
 * Read all rows currently in a corpus file.
 * Convenience wrapper over {@link parseToolDecisionJsonl}.
 */
export function readToolDecisionCorpus(path: string): ToolDecisionRow[] {
  if (!existsSync(path)) return [];
  return parseToolDecisionJsonl(readFileSync(path, 'utf-8'));
}

/**
 * Append a raw serialized JSONL line to a corpus file (used by legacy
 * paths that stored the row externally). Kept behind the lock too.
 */
export function appendRawToolDecisionLine(line: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireCorpusLock(path);
  try {
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    release();
  }
}

/**
 * Check if a tool decision row is from a scripted model.
 * Used by both the capture guard and the purge tool.
 */
export function isScriptedToolDecisionRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const obj = row as Record<string, unknown>;
  return (typeof obj.model === 'string' && obj.model.startsWith('scripted:')) 
    || obj.provider === 'scripted';
}

/**
 * Purge tool decision rows matching a predicate from the corpus.
 * 
 * Takes the corpus lock to prevent races with concurrent writers.
 * Preserves corrupt/unparseable lines verbatim.
 * 
 * @param path Path to the corpus file
 * @param predicate Function that returns true for rows to remove
 * @param opts Options including dryRun and backupSuffix
 * @returns Summary of the operation
 */
export function purgeToolDecisionRows(
  path: string, 
  predicate: (row: unknown) => boolean,
  opts: { dryRun?: boolean; backupSuffix?: string } = {}
): { path: string; total: number; removed: number; kept: number; backupPath?: string } {
  if (!existsSync(path)) {
    return { path, total: 0, removed: 0, kept: 0 };
  }
  
  const release = acquireCorpusLock(path);
  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter(line => line.trim() !== '');
    
    const keptLines: string[] = [];
    let removed = 0;
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (predicate(parsed)) {
          removed += 1;
          continue;
        }
      } catch {
        // Keep corrupt/unparseable lines verbatim
      }
      keptLines.push(line);
    }
    
    const kept = lines.length - removed;
    
    // Write backup if we're removing anything and not in dry-run mode
    let backupPath: string | undefined;
    if (removed > 0 && !opts.dryRun) {
      const backupBase = `${path}.bak`;
      backupPath = backupBase;
      
      // If backup already exists, use a timestamped name
      if (existsSync(backupPath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${backupBase}-${timestamp}`;
      }
      
      // Copy original file to backup
      copyFileSync(path, backupPath);
    }
    
    // Write new file if we're removing anything and not in dry-run mode
    if (removed > 0 && !opts.dryRun) {
      const tmpPath = `${path}.tmp.${process.pid}`;
      try {
        if (keptLines.length > 0) {
          writeFileSync(tmpPath, keptLines.join('\n') + '\n');
          fsyncSync(openSync(tmpPath, 'r')); // Ensure data is written
          renameSync(tmpPath, path);
        } else {
          rmSync(path, { force: true });
        }
      } catch (err) {
        // Clean up temp file if write failed
        rmSync(tmpPath, { force: true });
        throw err;
      }
    }
    
    return { path, total: lines.length, removed, kept, backupPath };
  } finally {
    release();
  }
}
