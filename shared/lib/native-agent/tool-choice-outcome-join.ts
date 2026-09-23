/**
 * Tool-choice outcome join (HOK-2080).
 *
 * Joins tool-decision rows to the wavemill EvalRecord corpus and produces
 * per-trace `TraceOutcomeContext` records for the labeler. This module is
 * pure: it never reads files itself — the caller supplies rows and eval
 * records. It is deterministic and additive: the input rows are never
 * mutated; when outcomes are attached, we emit a new `ToolDecisionRow[]`.
 *
 * Join key: the wavemill session-id embeds an issue slug (`…-coding-HOK-1234`,
 * with an optional `_c` suffix on the challenger arm). We parse the slug and
 * join it to `EvalRecord.issueId`, then disambiguate by `challengeSide` for
 * challenger arms. Review-phase sessions carry a branch, not an issue, so
 * they are flagged rather than silently joined.
 */

import type { EvalRecord, InterventionRecord } from '../eval-schema.ts';
import type { TraceOutcomeContext } from './tool-decision-labeler.ts';
import type { OutcomeJoin, ToolDecisionRow } from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Session-id parsing
// ---------------------------------------------------------------------------

export interface SessionIdParse {
  issue?: string;
  phase?: string;
  challengerArm: boolean;
}

const ISSUE_RE = /-(HOK-\d+)(?:_c)?$/i;
const PHASE_RE = /-(planning|coding|review)-/i;

export function parseIssueFromSessionId(sessionId: string): SessionIdParse {
  const phaseMatch = PHASE_RE.exec(sessionId);
  const phase = phaseMatch ? phaseMatch[1].toLowerCase() : undefined;
  const issueMatch = ISSUE_RE.exec(sessionId);
  const challengerArm = /_c$/i.test(sessionId);
  const result: SessionIdParse = { challengerArm };
  if (issueMatch) result.issue = issueMatch[1].toUpperCase();
  if (phase) result.phase = phase;
  return result;
}

// ---------------------------------------------------------------------------
// Per-trace covariates
// ---------------------------------------------------------------------------

/**
 * Parallel per-trace record of controls the estimator can use. Kept small,
 * strictly derived from the joined EvalRecord, and never carries free-form
 * text — this is what the analysis will condition on.
 */
export interface TraceCovariates {
  traceId: string;
  issue?: string;
  model?: string;
  agentType?: string;
  challengeSide?: 'primary' | 'challenger';
  challengeStage?: string;
  difficultyBand?: string;
  interventionCount?: number;
  terminalStatus?: string;
  terminalSuccess?: boolean;
  merged?: boolean;
  scoreBand?: string;
  score?: number;
  ambiguousJoin?: boolean;
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export interface OutcomeJoinInput {
  rows: ToolDecisionRow[];
  evalRecords: EvalRecord[];
}

export interface OutcomeJoinOutput {
  /** Rows with `outcome` populated (joined | unjoinable | pending). */
  rows: ToolDecisionRow[];
  /** Per-trace outcome contexts consumable by the labeler. */
  contexts: TraceOutcomeContext[];
  /** Per-trace covariate records for the estimator. */
  covariates: TraceCovariates[];
  /** Counts to feed into the quality-gate report. */
  stats: {
    joined: number;
    unjoinable: number;
    pending: number;
    reviewSessionsFlagged: number;
    ambiguousMatches: number;
    tracesJoined: number;
    tracesUnjoinable: number;
  };
}

const DIFFICULTY_KEY: readonly string[] = ['trivial', 'easy', 'medium', 'hard', 'very_hard'];

function difficultyOf(record: EvalRecord): string | undefined {
  // Some records carry taskDescriptor / outcomes with difficultyBand hints;
  // we accept only the flat shape used in the taskDescriptor block if it's
  // present, avoiding over-reach into eval implementation details.
  const desc = (record as unknown as {
    taskDescriptor?: { difficultyBand?: string };
  }).taskDescriptor;
  const band = desc?.difficultyBand;
  if (typeof band === 'string' && DIFFICULTY_KEY.includes(band)) return band;
  return undefined;
}

function interventionsOf(record: EvalRecord): number | undefined {
  if (typeof record.interventionCount === 'number') return record.interventionCount;
  const arr: InterventionRecord[] | undefined = record.interventions;
  if (Array.isArray(arr)) return arr.length;
  return undefined;
}

function terminalStatusOf(record: EvalRecord): string | undefined {
  const outcomes = (record as unknown as { outcomes?: { success?: boolean } }).outcomes;
  if (outcomes && typeof outcomes.success === 'boolean') {
    return outcomes.success ? 'success' : 'failure';
  }
  if (typeof record.score === 'number') {
    return record.score >= 0.5 ? 'success' : 'failure';
  }
  return undefined;
}

function mergedOf(record: EvalRecord): boolean | undefined {
  const outcomes = (record as unknown as { outcomes?: { delivery?: { merged?: boolean } } }).outcomes;
  if (outcomes?.delivery && typeof outcomes.delivery.merged === 'boolean') {
    return outcomes.delivery.merged;
  }
  return undefined;
}

function scoreOf(record: EvalRecord): number | undefined {
  return typeof record.score === 'number' ? record.score : undefined;
}

/**
 * Select the best match for a (issue, side) pair. Preference order:
 *   1. explicit side match (primary/challenger),
 *   2. newest timestamp,
 *   3. first record.
 * Ambiguity (>1 records with equal precedence) is flagged.
 */
function pickMatch(
  candidates: EvalRecord[],
  challengerArm: boolean,
): { record?: EvalRecord; ambiguous: boolean } {
  if (candidates.length === 0) return { ambiguous: false };
  const sideDesired: 'primary' | 'challenger' = challengerArm ? 'challenger' : 'primary';
  const withSide = candidates.filter((r) => r.challengeSide === sideDesired);
  const candidatesToRank = withSide.length > 0 ? withSide : candidates;
  const sorted = [...candidatesToRank].sort((a, b) => {
    const aT = Date.parse(a.timestamp || '') || 0;
    const bT = Date.parse(b.timestamp || '') || 0;
    return bT - aT;
  });
  const ambiguous =
    sorted.length > 1 &&
    Date.parse(sorted[0].timestamp || '') === Date.parse(sorted[1].timestamp || '');
  return { record: sorted[0], ambiguous };
}

function buildOutcome(
  parse: SessionIdParse,
  record: EvalRecord | undefined,
  reason: string | undefined,
): OutcomeJoin {
  if (record) {
    const join: OutcomeJoin = { status: 'joined' };
    if (parse.issue) join.issue = parse.issue;
    const interventions = interventionsOf(record);
    if (typeof interventions === 'number') join.interventionCount = interventions;
    const terminal = terminalStatusOf(record);
    if (terminal) join.terminalStatus = terminal;
    return join;
  }
  const join: OutcomeJoin = { status: 'unjoinable' };
  if (parse.issue) join.issue = parse.issue;
  if (reason) join.unjoinableReason = reason;
  return join;
}

export function buildOutcomeJoin(input: OutcomeJoinInput): OutcomeJoinOutput {
  // Index eval records by issue id (upper-cased).
  const byIssue = new Map<string, EvalRecord[]>();
  for (const r of input.evalRecords) {
    if (typeof r.issueId !== 'string') continue;
    const key = r.issueId.toUpperCase();
    const bucket = byIssue.get(key) ?? [];
    bucket.push(r);
    byIssue.set(key, bucket);
  }

  // Group rows by traceId to make the join per-trace.
  const rowsByTrace = new Map<string, ToolDecisionRow[]>();
  const parseByTrace = new Map<string, SessionIdParse>();
  for (const row of input.rows) {
    const bucket = rowsByTrace.get(row.traceId) ?? [];
    bucket.push(row);
    rowsByTrace.set(row.traceId, bucket);
    if (!parseByTrace.has(row.traceId)) {
      parseByTrace.set(row.traceId, parseIssueFromSessionId(row.sessionId));
    }
  }

  const outputRows: ToolDecisionRow[] = [];
  const contexts: TraceOutcomeContext[] = [];
  const covariates: TraceCovariates[] = [];
  let joined = 0;
  let unjoinable = 0;
  let pending = 0;
  let reviewFlagged = 0;
  let ambiguousMatches = 0;
  let tracesJoined = 0;
  let tracesUnjoinable = 0;

  for (const [traceId, rows] of rowsByTrace) {
    const parse = parseByTrace.get(traceId) ?? { challengerArm: false };
    let matched: EvalRecord | undefined;
    let unjoinableReason: string | undefined;

    if (!parse.issue) {
      unjoinableReason =
        parse.phase === 'review'
          ? 'review_session_no_issue_slug'
          : 'session_id_missing_issue_slug';
      if (parse.phase === 'review') reviewFlagged += 1;
    } else {
      const cands = byIssue.get(parse.issue) ?? [];
      const pick = pickMatch(cands, parse.challengerArm);
      if (pick.ambiguous) ambiguousMatches += 1;
      matched = pick.record;
      if (!matched) unjoinableReason = 'no_eval_record_for_issue';
    }

    if (matched) tracesJoined += 1;
    else tracesUnjoinable += 1;

    for (const row of rows) {
      const outcome = buildOutcome(parse, matched, unjoinableReason);
      outputRows.push({ ...row, outcome });
      if (outcome.status === 'joined') joined += 1;
      else if (outcome.status === 'unjoinable') unjoinable += 1;
      else pending += 1;
    }

    const ctx: TraceOutcomeContext = { traceId };
    const cov: TraceCovariates = { traceId };
    if (parse.issue) {
      cov.issue = parse.issue;
    }
    cov.challengeSide = parse.challengerArm ? 'challenger' : 'primary';
    if (matched) {
      const terminal = terminalStatusOf(matched);
      if (terminal === 'success') ctx.terminalSuccess = true;
      else if (terminal === 'failure') ctx.terminalSuccess = false;
      const merged = mergedOf(matched);
      if (merged !== undefined) ctx.merged = merged;

      cov.model = matched.modelId;
      if (matched.agentType) cov.agentType = matched.agentType;
      const cs = matched.challengeSide;
      if (cs) cov.challengeSide = cs;
      if (matched.challengeStage) cov.challengeStage = matched.challengeStage;
      const diff = difficultyOf(matched);
      if (diff) cov.difficultyBand = diff;
      const interventions = interventionsOf(matched);
      if (typeof interventions === 'number') cov.interventionCount = interventions;
      if (terminal) cov.terminalStatus = terminal;
      if (terminal === 'success') cov.terminalSuccess = true;
      else if (terminal === 'failure') cov.terminalSuccess = false;
      if (merged !== undefined) cov.merged = merged;
      if (matched.scoreBand) cov.scoreBand = matched.scoreBand;
      const s = scoreOf(matched);
      if (typeof s === 'number') cov.score = s;
    }
    if (input.evalRecords.length > 0 && parse.issue) {
      const bucket = byIssue.get(parse.issue) ?? [];
      if (bucket.length > 1) cov.ambiguousJoin = true;
    }
    contexts.push(ctx);
    covariates.push(cov);
  }

  return {
    rows: outputRows,
    contexts,
    covariates,
    stats: {
      joined,
      unjoinable,
      pending,
      reviewSessionsFlagged: reviewFlagged,
      ambiguousMatches,
      tracesJoined,
      tracesUnjoinable,
    },
  };
}

/**
 * Convenience: attach outcomes without recomputing covariates/contexts.
 * Never mutates inputs.
 */
export function attachOutcomes(
  rows: ToolDecisionRow[],
  outcomeByTrace: Map<string, OutcomeJoin>,
): ToolDecisionRow[] {
  return rows.map((row) => {
    const outcome = outcomeByTrace.get(row.traceId);
    return outcome ? { ...row, outcome } : row;
  });
}
