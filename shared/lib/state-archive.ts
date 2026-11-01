/**
 * State archive (HOK-3190).
 *
 * The hot `workflow-state.json` must stay small enough that each `jq` read is
 * cheap and each `state_mutate` lock window is short. `terminalTaskHistory`
 * and `terminalTaskTombstones` accumulate forever otherwise — a long session
 * reached 15 MB of pretty-printed JSON (6.3 MB history + 5.2 MB tombstones)
 * before this landed.
 *
 * This module archives the overflow into append-only JSONL files under
 * `.wavemill/state-archive/`:
 *   - `history.jsonl`     — one `terminalTaskHistory.tasks[*]` record per line
 *   - `pairs.jsonl`       — one `terminalTaskHistory.challengePairs[*][*]` entry
 *   - `tombstones.jsonl`  — one `terminalTaskTombstones[*]` entry per line
 *   - `.index.json`       — small fingerprint cache so repeated migrations are idempotent
 *
 * Policy: keep at most `keep` most-recent records in hot state, drop any older
 * than `maxAgeDays`. Everything evicted is appended to the archive first;
 * records already there (same fingerprint) are not re-appended.
 *
 * The archive is the source of truth for history/tombstones. Callers that
 * need to look up a tombstone for a task not in hot state should fall back
 * through `readArchiveTombstones()` / `readArchiveHistory()`.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_KEEP = 50;
export const DEFAULT_MAX_AGE_DAYS = 14;
export const DEFAULT_BYTE_CAP = 500_000;

/**
 * Fields kept in hot state for compact terminal task records (HOK-3203).
 * All other fields (especially the large `task` snapshot) are preserved only
 * in the archive.
 */
export const COMPACT_HOT_FIELDS = [
  'schemaVersion',
  'issue',
  'slug',
  'branch',
  'worktree',
  'prNumber',
  'workflowOutcome',
  'resourceDisposition',
  'challengePairId',
  'challengeRole',
  'runEpoch',
  'attempt',
  // HOK-3373: the settled run's identity survives hot-state compaction.
  'runId',
  'linearSyncedState',
  'actor',
  'command',
  'createdAt',
  'decisionStatus',
  'decisionReason',
] as const;

export interface ArchiveOptions {
  stateDir: string;
  keep?: number;
  maxAgeDays?: number;
  compactKept?: boolean;
}

export interface MigrationResult {
  archivedHistory: number;
  archivedTombstones: number;
  archivedPairs: number;
  skippedAlreadyArchived: number;
  hotHistoryAfter: number;
  hotTombstonesAfter: number;
  before: { bytes: number; history: number; tombstones: number; pairs: number };
  after: { bytes: number; history: number; tombstones: number; pairs: number };
}

type JsonValue = unknown;

/**
 * Compact a terminal task record for hot state (HOK-3203).
 * Returns a shallow copy with only allowlisted fields plus `archived: true`
 * and any preserved `postReapEval` extension slot.
 */
export function compactHotRecord(record: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = { archived: true };
  for (const field of COMPACT_HOT_FIELDS) {
    if (field in record) {
      compact[field] = record[field];
    }
  }
  // Preserve postReapEval extension slot if present
  if ('postReapEval' in record) {
    compact.postReapEval = record.postReapEval;
  }
  return compact;
}

interface StateShape {
  terminalTaskHistory?: {
    // allow-task-record-shape: terminalTaskHistory tombstones, not live .tasks records
    tasks?: Record<string, JsonValue>;
    challengePairs?: Record<string, Record<string, JsonValue>>;
  };
  terminalTaskTombstones?: Record<string, JsonValue>;
  [key: string]: JsonValue;
}

export function archiveDir(stateDir: string): string {
  return join(stateDir, '.wavemill', 'state-archive');
}

interface ArchivePaths {
  dir: string;
  history: string;
  pairs: string;
  tombstones: string;
  index: string;
}

export function archivePaths(stateDir: string): ArchivePaths {
  const dir = archiveDir(stateDir);
  return {
    dir,
    history: join(dir, 'history.jsonl'),
    pairs: join(dir, 'pairs.jsonl'),
    tombstones: join(dir, 'tombstones.jsonl'),
    index: join(dir, '.index.json'),
  };
}

interface IndexFile {
  history: Record<string, true>;
  pairs: Record<string, true>;
  tombstones: Record<string, true>;
}

function emptyIndex(): IndexFile {
  return { history: {}, pairs: {}, tombstones: {} };
}

function loadIndex(path: string): IndexFile {
  if (!existsSync(path)) return emptyIndex();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const idx = emptyIndex();
    if (raw && typeof raw === 'object') {
      for (const key of ['history', 'pairs', 'tombstones'] as const) {
        const sub = (raw as Record<string, unknown>)[key];
        if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
          idx[key] = Object.fromEntries(
            Object.keys(sub as Record<string, unknown>).map((k) => [k, true as const]),
          );
        }
      }
    }
    return idx;
  } catch {
    return emptyIndex();
  }
}

function saveIndex(path: string, idx: IndexFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(idx)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** Stable fingerprint for a terminal history / tombstone record. */
function historyFingerprint(record: Record<string, unknown>, fallback: string): string {
  const issue = String(record.issue ?? fallback ?? '');
  const pr = String(record.prNumber ?? record.pr ?? '');
  const branch = String(record.branch ?? '');
  const runEpoch = String(record.runEpoch ?? '');
  const attempt = String(record.attempt ?? '');
  const createdAt = String(record.createdAt ?? '');
  return [issue, pr, branch, runEpoch, attempt, createdAt].join('|');
}

function pairFingerprint(pairId: string, role: string, record: Record<string, unknown>): string {
  return `${pairId}|${role}|${historyFingerprint(record, '')}`;
}

/** Parse ISO date-ish fields on a record. Returns epoch seconds, or 0. */
function recordAgeEpoch(record: Record<string, unknown>): number {
  const candidates = ['createdAt', 'archivedAt', 'updatedAt', 'reapedAt'];
  for (const key of candidates) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
  }
  return 0;
}

interface Candidate {
  key: string;
  fingerprint: string;
  epoch: number;
  record: Record<string, unknown>;
}

function keepIndices(cands: Candidate[], keep: number, maxAgeDays: number): Set<string> {
  const now = Math.floor(Date.now() / 1000);
  const minEpoch = maxAgeDays > 0 ? now - maxAgeDays * 86_400 : 0;
  // Sort newest-first by epoch; tie-break stable by original key order.
  const sorted = [...cands]
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => (b.c.epoch - a.c.epoch) || (a.idx - b.idx));
  const kept = new Set<string>();
  for (const { c } of sorted) {
    if (kept.size >= keep) break;
    if (minEpoch > 0 && c.epoch > 0 && c.epoch < minEpoch) continue;
    kept.add(c.key);
  }
  return kept;
}

/**
 * Archive overflow from hot state. The input state object is mutated in place
 * and returned so callers can write it back under the same lock.
 */
export function archiveFromHotState(
  state: StateShape,
  options: ArchiveOptions,
): MigrationResult {
  const keep = options.keep ?? DEFAULT_KEEP;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const paths = archivePaths(options.stateDir);
  mkdirSync(paths.dir, { recursive: true });
  const index = loadIndex(paths.index);

  const beforeBytes = Buffer.byteLength(JSON.stringify(state));
  const historyMap = (state.terminalTaskHistory?.tasks ?? {}) as Record<string, Record<string, unknown>>;
  const pairsMap = (state.terminalTaskHistory?.challengePairs ?? {}) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const tombMap = (state.terminalTaskTombstones ?? {}) as Record<string, Record<string, unknown>>;
  const beforeCounts = {
    history: Object.keys(historyMap).length,
    tombstones: Object.keys(tombMap).length,
    pairs: Object.values(pairsMap).reduce((n, m) => n + Object.keys(m ?? {}).length, 0),
  };

  // --- history ---
  const historyCands: Candidate[] = Object.entries(historyMap).map(([key, record]) => ({
    key,
    fingerprint: historyFingerprint(record, key),
    epoch: recordAgeEpoch(record),
    record,
  }));
  const historyKeep = keepIndices(historyCands, keep, maxAgeDays);
  let archivedHistory = 0;
  let skippedHistory = 0;
  const historyAppend: string[] = [];
  for (const c of historyCands) {
    if (historyKeep.has(c.key)) continue;
    if (index.history[c.fingerprint]) {
      skippedHistory++;
    } else {
      historyAppend.push(`${JSON.stringify({ __key: c.key, ...c.record })}\n`);
      index.history[c.fingerprint] = true;
      archivedHistory++;
    }
    delete historyMap[c.key];
  }
  if (historyAppend.length > 0) {
    appendFileSync(paths.history, historyAppend.join(''), 'utf-8');
  }

  // --- tombstones ---
  const tombCands: Candidate[] = Object.entries(tombMap).map(([key, record]) => ({
    key,
    fingerprint: historyFingerprint(record, key),
    epoch: recordAgeEpoch(record),
    record,
  }));
  const tombKeep = keepIndices(tombCands, keep, maxAgeDays);
  let archivedTombstones = 0;
  let skippedTombstones = 0;
  const tombAppend: string[] = [];
  for (const c of tombCands) {
    if (tombKeep.has(c.key)) continue;
    if (index.tombstones[c.fingerprint]) {
      skippedTombstones++;
    } else {
      tombAppend.push(`${JSON.stringify({ __key: c.key, ...c.record })}\n`);
      index.tombstones[c.fingerprint] = true;
      archivedTombstones++;
    }
    delete tombMap[c.key];
  }
  if (tombAppend.length > 0) {
    appendFileSync(paths.tombstones, tombAppend.join(''), 'utf-8');
  }

  // --- challenge pairs (keyed by pairId) ---
  let archivedPairs = 0;
  let skippedPairs = 0;
  const pairAppend: string[] = [];
  for (const [pairId, roleMap] of Object.entries(pairsMap)) {
    const roles = Object.entries(roleMap ?? {});
    // We keep both arms whenever either arm is kept in the hot history map;
    // otherwise archive the whole pair.
    const anyKept = roles.some(([_role, record]) => {
      const fp = historyFingerprint(record as Record<string, unknown>, '');
      return (
        Object.values(historyMap).some(
          (h) => historyFingerprint(h as Record<string, unknown>, '') === fp,
        )
      );
    });
    if (anyKept) continue;
    for (const [role, record] of roles) {
      const fp = pairFingerprint(pairId, role, record as Record<string, unknown>);
      if (index.pairs[fp]) {
        skippedPairs++;
      } else {
        pairAppend.push(
          `${JSON.stringify({ __pair: pairId, __role: role, ...(record as object) })}\n`,
        );
        index.pairs[fp] = true;
        archivedPairs++;
      }
    }
    delete pairsMap[pairId];
  }
  if (pairAppend.length > 0) {
    appendFileSync(paths.pairs, pairAppend.join(''), 'utf-8');
  }

  // --- compact kept records if requested (HOK-3203) ---
  if (options.compactKept) {
    for (const key of Object.keys(historyMap)) {
      historyMap[key] = compactHotRecord(historyMap[key] as Record<string, unknown>);
    }
    for (const key of Object.keys(tombMap)) {
      tombMap[key] = compactHotRecord(tombMap[key] as Record<string, unknown>);
    }
    for (const pairId of Object.keys(pairsMap)) {
      const roleMap = pairsMap[pairId];
      if (roleMap) {
        for (const role of Object.keys(roleMap)) {
          roleMap[role] = compactHotRecord(roleMap[role] as Record<string, unknown>);
        }
      }
    }
  }

  // --- rewrite hot state branches with the pruned maps ---
  state.terminalTaskHistory = {
    ...(state.terminalTaskHistory ?? {}),
    tasks: historyMap,
    challengePairs: pairsMap,
  };
  state.terminalTaskTombstones = tombMap;

  saveIndex(paths.index, index);

  const afterCounts = {
    history: Object.keys(historyMap).length,
    tombstones: Object.keys(tombMap).length,
    pairs: Object.values(pairsMap).reduce((n, m) => n + Object.keys(m ?? {}).length, 0),
  };
  const afterBytes = Buffer.byteLength(JSON.stringify(state));
  return {
    archivedHistory,
    archivedTombstones,
    archivedPairs,
    skippedAlreadyArchived: skippedHistory + skippedTombstones + skippedPairs,
    hotHistoryAfter: Object.keys(historyMap).length,
    hotTombstonesAfter: Object.keys(tombMap).length,
    before: { bytes: beforeBytes, ...beforeCounts },
    after: { bytes: afterBytes, ...afterCounts },
  };
}

/** Read archived history, newest-first. */
export function readArchiveHistory(stateDir: string): Array<Record<string, unknown>> {
  return readJsonl(archivePaths(stateDir).history);
}

/** Read archived tombstones, newest-first. */
export function readArchiveTombstones(stateDir: string): Array<Record<string, unknown>> {
  return readJsonl(archivePaths(stateDir).tombstones);
}

/** Read archived challenge-pair arms. */
export function readArchivePairs(stateDir: string): Array<Record<string, unknown>> {
  return readJsonl(archivePaths(stateDir).pairs);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n');
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        out.push(row as Record<string, unknown>);
      }
    } catch {
      // ignore malformed lines (hand-edited archive)
    }
  }
  return out;
}

/**
 * Look up an archived tombstone by issue (returns the newest match).
 */
export function findArchivedTombstoneByIssue(
  stateDir: string,
  issue: string,
): Record<string, unknown> | null {
  if (!issue) return null;
  const all = readArchiveTombstones(stateDir);
  let best: Record<string, unknown> | null = null;
  let bestEpoch = -1;
  for (const row of all) {
    if (row.issue !== issue) continue;
    const e = recordAgeEpoch(row);
    if (e >= bestEpoch) {
      best = row;
      bestEpoch = e;
    }
  }
  return best;
}

/** For tests: wipe the archive directory. */
export function resetArchive(stateDir: string): void {
  const paths = archivePaths(stateDir);
  if (!existsSync(paths.dir)) return;
  for (const entry of readdirSync(paths.dir)) {
    const target = join(paths.dir, entry);
    try {
      const info = statSync(target);
      if (info.isFile()) unlinkSync(target);
    } catch {
      // ignore
    }
  }
}

/** Rewrite the hot state file atomically after archive. */
export function writeHotStateCompact(statePath: string, state: StateShape): void {
  const tmp = `${statePath}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf-8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, statePath);
}

/**
 * Append a single tombstone to the archive (HOK-3203).
 * Used by per-write callers to archive without running the full migration.
 */
export function appendTombstoneToArchive(
  stateDir: string,
  tombstone: Record<string, unknown>,
): void {
  const paths = archivePaths(stateDir);
  mkdirSync(paths.dir, { recursive: true });
  const index = loadIndex(paths.index);
  const fp = historyFingerprint(tombstone, String(tombstone.issue ?? ''));
  if (!index.tombstones[fp]) {
    appendFileSync(paths.tombstones, `${JSON.stringify(tombstone)}\n`, 'utf-8');
    index.tombstones[fp] = true;
    saveIndex(paths.index, index);
  }
}

/**
 * Append a single history record to the archive (HOK-3203).
 */
export function appendHistoryRecordToArchive(
  stateDir: string,
  record: Record<string, unknown>,
): void {
  const paths = archivePaths(stateDir);
  mkdirSync(paths.dir, { recursive: true });
  const index = loadIndex(paths.index);
  const fp = historyFingerprint(record, String(record.issue ?? ''));
  if (!index.history[fp]) {
    appendFileSync(paths.history, `${JSON.stringify(record)}\n`, 'utf-8');
    index.history[fp] = true;
    saveIndex(paths.index, index);
  }
}

/**
 * Append a challenge pair arm to the archive (HOK-3203).
 */
export function appendPairToArchive(
  stateDir: string,
  pairId: string,
  role: string,
  record: Record<string, unknown>,
): void {
  const paths = archivePaths(stateDir);
  mkdirSync(paths.dir, { recursive: true });
  const index = loadIndex(paths.index);
  const fp = pairFingerprint(pairId, role, record);
  if (!index.pairs[fp]) {
    appendFileSync(
      paths.pairs,
      `${JSON.stringify({ __pair: pairId, __role: role, ...record })}\n`,
      'utf-8',
    );
    index.pairs[fp] = true;
    saveIndex(paths.index, index);
  }
}

export interface ByteCapResult {
  bytesBefore: number;
  bytesAfter: number;
  iterations: number;
  hitFloor: boolean;
  warning?: string;
}

/**
 * Enforce hot state byte cap by iteratively compacting and trimming (HOK-3203).
 * If the hot state file exceeds byteCap, repeatedly re-run archiveFromHotState
 * with halved keep counts down to keepFloor.
 */
export function enforceHotStateByteCap(options: {
  stateFile: string;
  byteCap: number;
  keepFloor?: number;
}): ByteCapResult {
  const keepFloor = options.keepFloor ?? 10;
  const stateDir = dirname(dirname(options.stateFile));

  const beforeStat = statSync(options.stateFile);
  const bytesBefore = beforeStat.size;

  if (bytesBefore <= options.byteCap) {
    return { bytesBefore, bytesAfter: bytesBefore, iterations: 0, hitFloor: false };
  }

  let iterations = 0;
  let keep = DEFAULT_KEEP;
  let state = JSON.parse(readFileSync(options.stateFile, 'utf-8')) as StateShape;

  while (true) {
    iterations++;
    const result = archiveFromHotState(state, {
      stateDir,
      keep,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      compactKept: true,
    });

    writeHotStateCompact(options.stateFile, state);
    const afterStat = statSync(options.stateFile);

    if (afterStat.size <= options.byteCap || keep <= keepFloor) {
      const hitFloor = keep <= keepFloor && afterStat.size > options.byteCap;
      const warning = hitFloor
        ? `[hot-state-cap] still ${Math.ceil(afterStat.size / 1024)} KB after trim to floor (${keepFloor})`
        : undefined;
      return {
        bytesBefore,
        bytesAfter: afterStat.size,
        iterations,
        hitFloor,
        warning,
      };
    }

    keep = Math.ceil(keep / 2);
    if (keep < keepFloor) keep = keepFloor;
    state = JSON.parse(readFileSync(options.stateFile, 'utf-8')) as StateShape;
  }
}
