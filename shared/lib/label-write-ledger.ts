/**
 * HOK-3182 — mill label-write ledger.
 *
 * The mill, tend and a human operator usually push PR label changes under the
 * same GitHub login, so the PR timeline actor cannot tell them apart. Every
 * label write performed from a mill process (anything launched with
 * `WAVEMILL_SESSION` set: monitor, tend, backstage services, agents) appends
 * one line here; a timeline label event with no matching mill write is a
 * human edit.
 *
 * Append-only and lock-free like the other JSONL logs. Recording is
 * best-effort: a failed append never fails the label write.
 *
 * @module label-write-ledger
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const LABEL_WRITE_LEDGER_FILENAME = 'label-writes.jsonl';

/** A mill write matches a timeline event when both fall within this window. */
export const LABEL_WRITE_MATCH_WINDOW_MS = 120_000;

export type LabelWriteAction = 'labeled' | 'unlabeled';

export interface LabelWriteEntry {
  at: string;
  prNumber: number;
  label: string;
  action: LabelWriteAction;
  writer: 'mill';
  session?: string;
}

export function labelWriteLedgerPath(repoDir: string): string {
  return join(resolve(repoDir), '.wavemill', LABEL_WRITE_LEDGER_FILENAME);
}

/**
 * Resolve the main checkout that owns the ledger. Worktrees share the main
 * repo's `.wavemill/`, so a write from inside a task worktree lands in the
 * same file the reliability report reads.
 */
function resolveLedgerRepoDir(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const explicit = env.WAVEMILL_MILLED_REPO_DIR || env.REPO_DIR;
  if (explicit) return explicit;
  try {
    const commonDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!commonDir) return null;
    return dirname(isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir));
  } catch {
    return null;
  }
}

export interface RecordLabelWriteOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  /** Override the ledger's repo dir (tests). */
  repoDir?: string;
}

/**
 * Record a label write when running inside a mill process. Outside the mill
 * (no `WAVEMILL_SESSION`) nothing is written: an operator's label write must
 * stay unmatched so the report counts it as a touch.
 */
export function recordMillLabelWrite(
  prNumber: number | string,
  labels: string[],
  action: LabelWriteAction,
  options: RecordLabelWriteOptions = {},
): void {
  const env = options.env ?? process.env;
  const session = env.WAVEMILL_SESSION;
  if (!session) return;
  // A unit test running inside a mill pane inherits WAVEMILL_SESSION; its
  // mocked label writes must not land in the real repo's ledger.
  if (!options.repoDir && env.NODE_TEST_CONTEXT) return;
  const pr = Number(prNumber);
  if (!Number.isFinite(pr) || labels.length === 0) return;
  try {
    const repoDir = options.repoDir ?? resolveLedgerRepoDir(env, options.cwd ?? process.cwd());
    if (!repoDir) return;
    const path = labelWriteLedgerPath(repoDir);
    mkdirSync(dirname(path), { recursive: true });
    const at = (options.now ?? new Date()).toISOString();
    const lines = labels.map((label) => JSON.stringify({ at, prNumber: pr, label, action, writer: 'mill', session } satisfies LabelWriteEntry));
    appendFileSync(path, `${lines.join('\n')}\n`);
  } catch {
    // Best-effort audit trail; never fail the label write.
  }
}

/** Read every recorded mill label write; malformed lines are skipped. */
export function readMillLabelWrites(repoDir: string): LabelWriteEntry[] {
  const path = labelWriteLedgerPath(repoDir);
  if (!existsSync(path)) return [];
  const entries: LabelWriteEntry[] = [];
  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { return []; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LabelWriteEntry;
      if (e && typeof e.at === 'string' && typeof e.label === 'string' && Number.isFinite(Number(e.prNumber))) {
        entries.push({ ...e, prNumber: Number(e.prNumber) });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

export interface LabelWriteIndex {
  /** Earliest recorded write; label events before it cannot be attributed. */
  startMs: number | null;
  byPr: Map<number, LabelWriteEntry[]>;
}

export function indexMillLabelWrites(entries: LabelWriteEntry[]): LabelWriteIndex {
  const byPr = new Map<number, LabelWriteEntry[]>();
  let startMs: number | null = null;
  for (const e of entries) {
    const ms = Date.parse(e.at);
    if (!Number.isFinite(ms)) continue;
    if (startMs === null || ms < startMs) startMs = ms;
    const list = byPr.get(e.prNumber) ?? [];
    list.push(e);
    byPr.set(e.prNumber, list);
  }
  return { startMs, byPr };
}

/** True when a recorded mill write explains this timeline label event. */
export function matchesMillLabelWrite(
  index: LabelWriteIndex,
  event: { prNumber: number; label: string; action: LabelWriteAction; at: string },
): boolean {
  const ms = Date.parse(event.at);
  if (!Number.isFinite(ms)) return false;
  return (index.byPr.get(event.prNumber) ?? []).some((w) =>
    w.label === event.label
    && w.action === event.action
    && Math.abs(Date.parse(w.at) - ms) <= LABEL_WRITE_MATCH_WINDOW_MS);
}
