/**
 * One head-move record (HOK-3370).
 *
 * Every head change on a task branch is appended as one `head-move/v1` row by
 * the publication seam (`publishStageHead` in `branch-publication.ts`) or by
 * the movers that keep their own push (tend's rebase). The record answers,
 * after the fact, "who moved this branch, at which stage, and when was it
 * published" — the question the HOK-3361 incident needed four operator
 * touches to answer by hand.
 *
 * Modeled on `.session-ownership.jsonl` (HOK-3328): an append-only JSONL file
 * in the task's state dir, written at publish time and archived with the
 * state dir so post-reap consumers (the challenge comparison, the Hokusai
 * contribution export) can read it. Append-only JSONL stays lock-free per the
 * state-mutation rules in CLAUDE.md.
 *
 * It is a *record*, not a marker: nothing reads it as a gate, it has no
 * condition (`--expires-on`) and it never expires.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Schema identifier stamped on every row. */
export const HEAD_MOVE_SCHEMA = 'head-move/v1';

/** File name inside the task state dir. */
export const HEAD_MOVES_FILE = '.head-moves.jsonl';

/** Which workflow stage the branch head moved for. */
export type HeadMoveStage = 'planning' | 'coding' | 'review' | 'ready' | 'tend';

/** Who performed the publication (never "who authored the commits"). */
export type HeadMoveActor = 'agent' | 'mill' | 'tend';

/**
 * Why the head moved. `coding` and `review-fix` are code-changing moves that
 * stale review evidence; `base-merge` and `rebase` keep the change identity
 * (see `change-identity.ts`).
 */
export type HeadMoveKind =
  | 'coding'
  | 'review-fix'
  | 'remediation'
  | 'conflict'
  | 'base-merge'
  | 'rebase';

export interface HeadMoveRow {
  schema: typeof HEAD_MOVE_SCHEMA;
  /** Linear issue id of the task (challenger arms carry their own `_c` id). */
  issue: string;
  /**
   * Previous published head, or null when unknown (first publication, or the
   * agent pushed outside the seam and the prior remote value was not
   * observed).
   */
  from: string | null;
  /** The published head SHA. */
  to: string;
  stage: HeadMoveStage;
  actor: HeadMoveActor;
  kind: HeadMoveKind;
  /**
   * Commits in `from..to` when both ends were locally reachable at record
   * time; absent otherwise. Authorship summaries treat an absent count as
   * "at least one".
   */
  commits?: number;
  /** ISO timestamp of the publication (push, or observation of a prior push). */
  publishedAt: string;
  /** ISO timestamp this row was appended. */
  recordedAt: string;
}

export interface AppendHeadMoveInput {
  issue: string;
  from: string | null;
  to: string;
  stage: HeadMoveStage;
  actor: HeadMoveActor;
  kind: HeadMoveKind;
  commits?: number;
  publishedAt?: string;
}

/**
 * Append one head-move row to `<stateDir>/.head-moves.jsonl`.
 *
 * Creates the state dir if needed. A failed append throws: the seam treats
 * an unrecorded publication as a real error, so a head move is never
 * silently unrecorded. Callers that want best-effort wrap it themselves.
 */
export function appendHeadMove(stateDir: string, input: AppendHeadMoveInput): HeadMoveRow {
  const now = new Date().toISOString();
  const row: HeadMoveRow = {
    schema: HEAD_MOVE_SCHEMA,
    issue: input.issue,
    from: input.from,
    to: input.to,
    stage: input.stage,
    actor: input.actor,
    kind: input.kind,
    ...(typeof input.commits === 'number' && Number.isFinite(input.commits)
      ? { commits: input.commits }
      : {}),
    publishedAt: input.publishedAt ?? now,
    recordedAt: now,
  };
  const file = join(stateDir, HEAD_MOVES_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf-8');
  return row;
}

/**
 * Read all head-move rows from a state dir (live or archived).
 *
 * Tolerates an absent file (returns []) and skips unparseable or
 * wrong-schema lines rather than throwing: the record is diagnostic data and
 * a torn trailing line must never break a consumer.
 */
export function readHeadMoves(stateDir: string): HeadMoveRow[] {
  const file = join(stateDir, HEAD_MOVES_FILE);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const rows: HeadMoveRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<HeadMoveRow>;
      if (parsed && parsed.schema === HEAD_MOVE_SCHEMA && typeof parsed.to === 'string') {
        rows.push(parsed as HeadMoveRow);
      }
    } catch {
      // torn or foreign line — skip
    }
  }
  return rows;
}

/** The last recorded published head, or null when no rows exist. */
export function lastRecordedHead(stateDir: string): string | null {
  const rows = readHeadMoves(stateDir);
  return rows.length > 0 ? rows[rows.length - 1].to : null;
}

/** Per-stage authorship summary used by the challenge comparison (HOK-3370 §3). */
export interface HeadMoveStageSummary {
  stage: HeadMoveStage;
  kinds: HeadMoveKind[];
  /** Total recorded commits for the stage (absent counts treated as 1). */
  commits: number;
  /** Published head SHAs, in record order. */
  shas: string[];
}

/**
 * Summarise head moves by stage, preserving first-seen stage order. The
 * comparison record carries this so a reviewer or remediation commit on one
 * arm is visible data, not an invisible confound.
 */
export function summarizeHeadMovesByStage(rows: HeadMoveRow[]): HeadMoveStageSummary[] {
  const byStage = new Map<HeadMoveStage, HeadMoveStageSummary>();
  for (const row of rows) {
    let summary = byStage.get(row.stage);
    if (!summary) {
      summary = { stage: row.stage, kinds: [], commits: 0, shas: [] };
      byStage.set(row.stage, summary);
    }
    if (!summary.kinds.includes(row.kind)) summary.kinds.push(row.kind);
    summary.commits += typeof row.commits === 'number' ? row.commits : 1;
    summary.shas.push(row.to);
  }
  return [...byStage.values()];
}
