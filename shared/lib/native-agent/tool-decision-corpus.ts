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

/**
 * Predicate: does this row come from a scripted test provider?
 *
 * Test suites register `scripted:` model APIs to drive planning/coding
 * without a real network call. Those rows must never land in the real
 * repo corpus, only in an explicit test corpus dir. The capture guard
 * ({@link ../tool-decision-capture.ts}) and the fixture purge tool
 * (`tools/purge-tool-decision-fixtures.ts`) share this definition.
 */
export function isScriptedToolDecisionRow(row: {
  model?: unknown;
  provider?: unknown;
}): boolean {
  const model = row?.model;
  if (typeof model === 'string' && model.startsWith('scripted:')) return true;
  if (row?.provider === 'scripted') return true;
  return false;
}

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

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

export interface PurgeToolDecisionRowsOptions {
  /** Skip any writes; only report what would change. */
  dryRun?: boolean;
  /** Custom suffix for the backup file (default `.bak`). */
  backupSuffix?: string;
}

export interface PurgeToolDecisionRowsResult {
  path: string;
  total: number;
  removed: number;
  kept: number;
  backupPath?: string;
}

/**
 * Rewrite a tool-decision corpus, keeping only rows that DO NOT match
 * `predicate`. This is the only sanctioned rewrite of the append-only
 * corpus and takes the same file lock live writers use, so a concurrent
 * {@link appendToolDecisions} waits instead of racing.
 *
 * Lines that fail to parse as JSON are kept verbatim. If any rows are
 * removed and `dryRun` is false, the original bytes are first copied to
 * `<path><backupSuffix>` (defaulting to `.bak`); if a backup already
 * exists, a timestamped variant is used to avoid clobbering older
 * backups. The new file is written to a temp path, fsync'd, and
 * renamed over the original.
 */
export function purgeToolDecisionRows(
  path: string,
  predicate: (row: unknown) => boolean,
  opts: PurgeToolDecisionRowsOptions = {},
): PurgeToolDecisionRowsResult {
  const backupSuffix = opts.backupSuffix ?? '.bak';
  const result: PurgeToolDecisionRowsResult = {
    path,
    total: 0,
    removed: 0,
    kept: 0,
  };
  if (!existsSync(path)) return result;

  const release = acquireCorpusLock(path);
  try {
    const original = readFileSync(path);
    const raw = original.toString('utf-8');
    const lines = raw.split('\n');
    const keptLines: string[] = [];
    // Preserve trailing newline behavior of the source file (JSONL usually
    // ends with '\n' so split leaves a trailing empty element).
    const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === lines.length - 1 && line === '') continue; // handled by trailingEmpty
      if (line.trim() === '') {
        keptLines.push(line);
        continue;
      }
      result.total += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Corrupt/unparseable line — keep verbatim so nothing we don't
        // understand gets dropped.
        keptLines.push(line);
        result.kept += 1;
        continue;
      }
      if (predicate(parsed)) {
        result.removed += 1;
      } else {
        keptLines.push(line);
        result.kept += 1;
      }
    }

    if (result.removed === 0) return result;
    if (opts.dryRun) return result;

    let backupPath = `${path}${backupSuffix}`;
    if (existsSync(backupPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${path}${backupSuffix}.${stamp}`;
    }
    writeFileSync(backupPath, original);

    const content = keptLines.join('\n') + (trailingEmpty ? '\n' : '');
    const tmpPath = `${path}.tmp.${process.pid}`;
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, content, undefined, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Atomic rename over the original.
    renameSync(tmpPath, path);
    result.backupPath = backupPath;
    return result;
  } finally {
    release();
  }
}
