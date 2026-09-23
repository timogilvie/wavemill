/**
 * Tool-decision offline labeler (HOK-2076).
 *
 * Consumes a raw {@link ToolDecisionRow} corpus + per-trace outcome context
 * and emits a *separate* labelled JSONL projection so raw rows are never
 * rewritten. Rerunnable and versioned: rerunning with the same inputs
 * produces the same labels.
 *
 * Labels are intentionally conservative:
 *   - `exact_reversion`: agent mutation reverted by a later commit on the
 *      same trace (any actor).
 *   - `human_vs_agent_undo`: attributable dominant undoer of the mutation.
 *   - `survival_ratio`: only computed when the terminal task succeeded and
 *      the survival substrate is present; otherwise `null` (ineligible).
 *   - `test_failure_delta`: coding-stage delta between the prior test signal
 *      and the current one, when both are present.
 *   - `tool_status_local`: universal local signal — always present.
 *
 * Reuses the frozen Arbiter survival contract for the ratio semantics
 * (`docs/arbiter/survival-label-contract.md`).
 */

import type {
  ReportOutcome,
  UndoneBy,
} from '../arbiter-survival-label.ts';
import { SUBSTANTIAL_REWRITE_THRESHOLD } from '../arbiter-survival-label.ts';
import type { ToolDecisionRow } from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Bump when any label semantics or the derivation rules change. */
export const TOOL_DECISION_LABEL_VERSION = '1';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Outcome/context supplied per trace by the caller. `traceId` matches
 * {@link ToolDecisionRow.traceId}.
 */
export interface TraceOutcomeContext {
  traceId: string;
  /** Terminal task success (used to gate survival ratios). */
  terminalSuccess?: boolean;
  /** Whether the merge landed (unmerged → survival ineligible). */
  merged?: boolean;
  /** Elapsed horizon in days since merge, if known. */
  elapsedDaysSinceMerge?: number;
  /**
   * Optional per-decision reversion telemetry keyed by decisionId. When absent,
   * the labeler defers to universal signals (tool status).
   */
  reversions?: Record<string, {
    reverted: boolean;
    survivalRatio?: number | null;
    undoneBy?: UndoneBy;
  }>;
  /**
   * Optional per-decision test signal keyed by decisionId. Missing entries
   * force test_failure_delta to `unavailable`.
   */
  testSignals?: Record<string, {
    failedBefore?: number;
    failedAfter?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface ToolDecisionLabelRow {
  labelVersion: string;
  decisionId: string;
  traceId: string;
  sessionId: string;
  phase: string;
  turnIndex: number;
  stepIndex: number;

  /** Universal local signal — result status from the row. */
  toolStatusLocal: 'success' | 'error' | 'skipped' | 'n/a';

  /** True when a later commit reverted the mutation this decision produced. */
  exactReversion: boolean;

  /**
   * Attributable dominant undoer. `null` when there is no undo, when
   * evidence is ambiguous, or when the decision is not a mutation.
   */
  humanVsAgentUndo: UndoneBy;

  /**
   * Fraction of the labelled ranges surviving at the horizon. `null` when
   * ineligible (unsuccessful task, unmerged PR, insufficient substrate).
   */
  survivalRatio: number | null;

  /** Derived Arbiter-style outcome, mirrors survival contract. */
  reportOutcome: ReportOutcome;

  /**
   * Δ(failed_after − failed_before) at the coding stage.
   * `null` when either signal is unavailable.
   */
  testFailureDelta: number | null;
  testFailureDeltaSource: 'measured' | 'unavailable';

  /** Reason for ineligibility / unavailability (bounded set). */
  ineligibilityReason?:
    | 'terminal_not_success'
    | 'unmerged_pr'
    | 'missing_horizon'
    | 'not_a_mutation'
    | 'insufficient_history';
}

// ---------------------------------------------------------------------------
// Labeler
// ---------------------------------------------------------------------------

export interface LabelInput {
  rows: ToolDecisionRow[];
  contexts: TraceOutcomeContext[];
}

export interface LabelResult {
  labels: ToolDecisionLabelRow[];
  /** Rows for which the labeler could not compute anything (bounded reasons). */
  skipped: Array<{ decisionId: string; reason: string }>;
}

export function labelToolDecisions(input: LabelInput): LabelResult {
  const contextByTrace = new Map<string, TraceOutcomeContext>();
  for (const c of input.contexts) contextByTrace.set(c.traceId, c);

  const labels: ToolDecisionLabelRow[] = [];
  const skipped: LabelResult['skipped'] = [];

  for (const row of input.rows) {
    const ctx = contextByTrace.get(row.traceId);
    const toolStatusLocal = (row.result?.status ?? 'n/a') as ToolDecisionLabelRow['toolStatusLocal'];

    if (!ctx) {
      labels.push(makeMinimalLabel(row, toolStatusLocal, 'insufficient_history'));
      continue;
    }

    const reversion = ctx.reversions?.[row.decisionId];
    const exactReversion = reversion?.reverted === true;
    const undoneBy = reversion?.undoneBy ?? null;

    let survivalRatio: number | null = null;
    let ineligibilityReason: ToolDecisionLabelRow['ineligibilityReason'];
    if (ctx.merged === false) {
      ineligibilityReason = 'unmerged_pr';
    } else if (ctx.terminalSuccess !== true) {
      ineligibilityReason = 'terminal_not_success';
    } else if (ctx.elapsedDaysSinceMerge === undefined) {
      ineligibilityReason = 'missing_horizon';
    } else if (reversion && typeof reversion.survivalRatio === 'number') {
      survivalRatio = reversion.survivalRatio;
    } else if (row.kind === 'respond' || row.kind === 'think') {
      ineligibilityReason = 'not_a_mutation';
    } else {
      ineligibilityReason = 'insufficient_history';
    }

    const reportOutcome = deriveReportOutcome({
      exactReversion,
      survivalRatio,
      ineligibilityReason,
    });

    const testSignal = ctx.testSignals?.[row.decisionId];
    let testFailureDelta: number | null = null;
    let testFailureDeltaSource: ToolDecisionLabelRow['testFailureDeltaSource'] = 'unavailable';
    if (
      testSignal &&
      typeof testSignal.failedBefore === 'number' &&
      typeof testSignal.failedAfter === 'number'
    ) {
      testFailureDelta = testSignal.failedAfter - testSignal.failedBefore;
      testFailureDeltaSource = 'measured';
    }

    labels.push({
      labelVersion: TOOL_DECISION_LABEL_VERSION,
      decisionId: row.decisionId,
      traceId: row.traceId,
      sessionId: row.sessionId,
      phase: row.phase,
      turnIndex: row.turnIndex,
      stepIndex: row.stepIndex,
      toolStatusLocal,
      exactReversion,
      humanVsAgentUndo: undoneBy,
      survivalRatio,
      reportOutcome,
      testFailureDelta,
      testFailureDeltaSource,
      ...(ineligibilityReason ? { ineligibilityReason } : {}),
    });
  }

  return { labels, skipped };
}

function makeMinimalLabel(
  row: ToolDecisionRow,
  toolStatusLocal: ToolDecisionLabelRow['toolStatusLocal'],
  reason: ToolDecisionLabelRow['ineligibilityReason'],
): ToolDecisionLabelRow {
  return {
    labelVersion: TOOL_DECISION_LABEL_VERSION,
    decisionId: row.decisionId,
    traceId: row.traceId,
    sessionId: row.sessionId,
    phase: row.phase,
    turnIndex: row.turnIndex,
    stepIndex: row.stepIndex,
    toolStatusLocal,
    exactReversion: false,
    humanVsAgentUndo: null,
    survivalRatio: null,
    reportOutcome: null,
    testFailureDelta: null,
    testFailureDeltaSource: 'unavailable',
    ...(reason ? { ineligibilityReason: reason } : {}),
  };
}

function deriveReportOutcome(opts: {
  exactReversion: boolean;
  survivalRatio: number | null;
  ineligibilityReason?: ToolDecisionLabelRow['ineligibilityReason'];
}): ReportOutcome {
  if (opts.exactReversion) return 'reverted';
  if (opts.ineligibilityReason) return null;
  if (opts.survivalRatio === null) return null;
  if (opts.survivalRatio < SUBSTANTIAL_REWRITE_THRESHOLD) return 'substantially_rewritten';
  return 'survived';
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

export function serializeLabelsAsJsonl(labels: ToolDecisionLabelRow[]): string {
  return labels.map((l) => JSON.stringify(l)).join('\n') + (labels.length ? '\n' : '');
}
