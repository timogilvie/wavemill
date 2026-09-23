/**
 * Tool-choice data-quality gate (HOK-2080).
 *
 * Runs the coverage / menu-integrity / outcome-join / propensity-provenance
 * checks the issue requires *before* any signal estimation. Estimators must
 * inspect the returned `QualityGateReport` and skip strata whose per-check
 * gate is false. The gate itself never estimates — it emits data.
 *
 * The thresholds live here in one place, with documented rationale, so
 * later re-runs of the analysis remain reproducible: if a threshold moves,
 * the diff is auditable and the report metadata records the new value.
 */

import type {
  PropensityProvenance,
  ToolDecisionRow,
} from './tool-decision-schema.ts';
import { reportToolDecisionCorpusString } from './tool-decision-report.ts';
import type { ToolDecisionCorpusReport } from './tool-decision-report.ts';
import type { TraceCovariates } from './tool-choice-outcome-join.ts';

// ---------------------------------------------------------------------------
// Thresholds (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Thresholds are conservative floors; below them the estimator refuses.
 * Rationale is documented inline for each threshold so the doc's decision
 * section can quote it without duplication.
 */
export interface QualityGateThresholds {
  /** Minimum joined-outcome traces required per contrast cell. */
  minJoinedTracesPerCell: number;
  /** Minimum fraction of coding-stage rows that must carry a menu snapshot. */
  minMenuPresenceFraction: number;
  /** Minimum count of rows eligible for causal off-policy (exact provenance). */
  minExactPropensityRows: number;
  /** Minimum total decisions overall to attempt any estimate. */
  minTotalDecisions: number;
  /** Minimum distinct traces overall to attempt any estimate. */
  minDistinctTraces: number;
}

export const QUALITY_GATE_THRESHOLDS: QualityGateThresholds = {
  // 30 traces per cell is a conventional small-sample floor for stratified
  // logistic contrasts with a couple of controls; below this the CIs from
  // the cluster bootstrap will span the effect line for any realistic lift.
  minJoinedTracesPerCell: 30,
  // 80% menu-presence is where the menu-conditioned analyses stop being
  // dominated by the missing-menu subgroup (menu-blind backfill sessions).
  minMenuPresenceFraction: 0.8,
  // Off-policy estimators require at least one exact-propensity row before
  // running; the schema contract already forbids surrogate-based DR.
  minExactPropensityRows: 1,
  // Global floors: below these numbers nothing meaningful can be said.
  minTotalDecisions: 100,
  minDistinctTraces: 20,
};

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type ProvenanceHistogram = Record<PropensityProvenance, number>;

export interface CoverageCounts {
  totalDecisions: number;
  distinctTraces: number;
  distinctSessions: number;
  perPhase: Record<string, number>;
  perModel: Record<string, number>;
  perProvider: Record<string, number>;
  perIssue: Record<string, number>;
  perKind: Record<string, number>;
  /** Rows with a terminal tool-result status (success or error). */
  rowsWithTerminalResult: number;
  /** Rows whose result status is `skipped` (tool_result event not observed). */
  rowsWithSkippedResult: number;
}

export interface MenuIntegrity {
  rowsWithMenu: number;
  rowsWithoutMenuNonTerminal: number;
  menuPresenceFraction: number;
  distinctMenuDigests: number;
  perTurnDigestConsistent: boolean;
}

export interface OutcomeJoinReport {
  joined: number;
  unjoinable: number;
  pending: number;
  reasons: Record<string, number>;
  joinedTraceIds: string[];
}

export interface QualityGateChecks {
  totalDecisionsPass: boolean;
  distinctTracesPass: boolean;
  menuPresencePass: boolean;
  offPolicyEligible: boolean;
  outcomeJoinsAdequate: boolean;
}

export interface QualityGateReport {
  thresholds: QualityGateThresholds;
  coverage: CoverageCounts;
  menu: MenuIntegrity;
  outcome: OutcomeJoinReport;
  propensity: ProvenanceHistogram;
  hygiene: ToolDecisionCorpusReport;
  checks: QualityGateChecks;
  /** Rolled-up: true when the estimator may attempt observational contrasts. */
  observationalGatePass: boolean;
  /** Rolled-up: true when off-policy (IPS/DR) may be attempted. */
  offPolicyGatePass: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

export interface QualityGateInput {
  rows: ToolDecisionRow[];
  covariates?: TraceCovariates[];
  /** Optional raw corpus content for hygiene report (else built from rows). */
  corpusContent?: string;
  /** Optional label to identify the corpus in the hygiene report. */
  corpusPath?: string;
  thresholds?: Partial<QualityGateThresholds>;
}

function serializeRowsAsJsonl(rows: ToolDecisionRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function computeCoverage(rows: ToolDecisionRow[]): CoverageCounts {
  const sessions = new Set<string>();
  const traces = new Set<string>();
  const perPhase: Record<string, number> = {};
  const perModel: Record<string, number> = {};
  const perProvider: Record<string, number> = {};
  const perIssue: Record<string, number> = {};
  const perKind: Record<string, number> = {};
  let rowsWithTerminalResult = 0;
  let rowsWithSkippedResult = 0;
  for (const row of rows) {
    sessions.add(row.sessionId);
    traces.add(row.traceId);
    bump(perPhase, row.phase);
    bump(perModel, row.model);
    bump(perProvider, row.provider);
    bump(perKind, row.kind);
    if (row.outcome?.issue) bump(perIssue, row.outcome.issue);
    const status = row.result?.status;
    if (status === 'success' || status === 'error') rowsWithTerminalResult += 1;
    else if (status === 'skipped') rowsWithSkippedResult += 1;
  }
  return {
    totalDecisions: rows.length,
    distinctTraces: traces.size,
    distinctSessions: sessions.size,
    perPhase,
    perModel,
    perProvider,
    perIssue,
    perKind,
    rowsWithTerminalResult,
    rowsWithSkippedResult,
  };
}

function computeMenuIntegrity(rows: ToolDecisionRow[]): MenuIntegrity {
  let rowsWithMenu = 0;
  let rowsWithoutMenuNonTerminal = 0;
  const digests = new Set<string>();
  // Per-turn menu-digest consistency: within (sessionId, turnIndex), all
  // observed digests must agree.
  const digestsByTurn = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.sessionId}:${row.turnIndex}`;
    const bucket = digestsByTurn.get(key) ?? new Set<string>();
    const hasMenu = !!row.toolMenu && row.toolMenu.toolNames.length > 0;
    if (hasMenu) {
      rowsWithMenu += 1;
      digests.add(row.toolMenu!.digest);
      bucket.add(row.toolMenu!.digest);
    } else if (!row.state.terminalSynthesis) {
      rowsWithoutMenuNonTerminal += 1;
    }
    digestsByTurn.set(key, bucket);
  }
  const total = rows.length;
  const menuPresenceFraction = total === 0 ? 0 : rowsWithMenu / total;
  let perTurnDigestConsistent = true;
  for (const set of digestsByTurn.values()) {
    if (set.size > 1) {
      perTurnDigestConsistent = false;
      break;
    }
  }
  return {
    rowsWithMenu,
    rowsWithoutMenuNonTerminal,
    menuPresenceFraction,
    distinctMenuDigests: digests.size,
    perTurnDigestConsistent,
  };
}

function computeOutcomeJoin(rows: ToolDecisionRow[]): OutcomeJoinReport {
  let joined = 0;
  let unjoinable = 0;
  let pending = 0;
  const reasons: Record<string, number> = {};
  const joinedTraces = new Set<string>();
  for (const row of rows) {
    const oc = row.outcome;
    if (!oc) {
      pending += 1;
      continue;
    }
    if (oc.status === 'joined') {
      joined += 1;
      joinedTraces.add(row.traceId);
    } else if (oc.status === 'unjoinable') {
      unjoinable += 1;
      bump(reasons, oc.unjoinableReason ?? 'unspecified');
    } else {
      pending += 1;
    }
  }
  return {
    joined,
    unjoinable,
    pending,
    reasons,
    joinedTraceIds: [...joinedTraces],
  };
}

function computeProvenance(rows: ToolDecisionRow[]): ProvenanceHistogram {
  const hist: ProvenanceHistogram = {
    exact: 0,
    provider_reported: 0,
    surrogate: 0,
    unavailable: 0,
  };
  for (const row of rows) hist[row.propensity.provenance] += 1;
  return hist;
}

export function computeQualityGate(input: QualityGateInput): QualityGateReport {
  const thresholds = { ...QUALITY_GATE_THRESHOLDS, ...(input.thresholds ?? {}) };
  const rows = input.rows;
  const coverage = computeCoverage(rows);
  const menu = computeMenuIntegrity(rows);
  const outcome = computeOutcomeJoin(rows);
  const propensity = computeProvenance(rows);
  const hygiene = reportToolDecisionCorpusString(
    input.corpusContent ?? serializeRowsAsJsonl(rows),
    input.corpusPath ?? 'in-memory',
  );

  const totalDecisionsPass = coverage.totalDecisions >= thresholds.minTotalDecisions;
  const distinctTracesPass = coverage.distinctTraces >= thresholds.minDistinctTraces;
  const menuPresencePass = menu.menuPresenceFraction >= thresholds.minMenuPresenceFraction;
  const offPolicyEligible = propensity.exact >= thresholds.minExactPropensityRows;
  const outcomeJoinsAdequate = outcome.joinedTraceIds.length >= thresholds.minJoinedTracesPerCell;

  const checks: QualityGateChecks = {
    totalDecisionsPass,
    distinctTracesPass,
    menuPresencePass,
    offPolicyEligible,
    outcomeJoinsAdequate,
  };

  const notes: string[] = [];
  if (!totalDecisionsPass) notes.push(`totalDecisions ${coverage.totalDecisions} < ${thresholds.minTotalDecisions}`);
  if (!distinctTracesPass) notes.push(`distinctTraces ${coverage.distinctTraces} < ${thresholds.minDistinctTraces}`);
  if (!menuPresencePass)
    notes.push(
      `menuPresenceFraction ${menu.menuPresenceFraction.toFixed(2)} < ${thresholds.minMenuPresenceFraction}`,
    );
  if (!offPolicyEligible)
    notes.push(
      `exactPropensity ${propensity.exact} < ${thresholds.minExactPropensityRows} (off-policy refused)`,
    );
  if (!outcomeJoinsAdequate)
    notes.push(
      `joinedTraces ${outcome.joinedTraceIds.length} < ${thresholds.minJoinedTracesPerCell}`,
    );

  const observationalGatePass = totalDecisionsPass && distinctTracesPass && outcomeJoinsAdequate;
  const offPolicyGatePass = observationalGatePass && offPolicyEligible;

  return {
    thresholds,
    coverage,
    menu,
    outcome,
    propensity,
    hygiene,
    checks,
    observationalGatePass,
    offPolicyGatePass,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Formatter (human-readable summary — matches the doc's DQ appendix)
// ---------------------------------------------------------------------------

export function formatQualityGateReport(report: QualityGateReport): string {
  const lines: string[] = [];
  lines.push('Data-quality gate');
  lines.push('  Coverage:');
  lines.push(`    totalDecisions   : ${report.coverage.totalDecisions}`);
  lines.push(`    distinctTraces   : ${report.coverage.distinctTraces}`);
  lines.push(`    distinctSessions : ${report.coverage.distinctSessions}`);
  lines.push(`    perPhase         : ${JSON.stringify(report.coverage.perPhase)}`);
  lines.push(`    perModel         : ${JSON.stringify(report.coverage.perModel)}`);
  lines.push(`    rowsWithTerminalResult : ${report.coverage.rowsWithTerminalResult}`);
  lines.push(`    rowsWithSkippedResult  : ${report.coverage.rowsWithSkippedResult}`);
  lines.push('  Menu integrity:');
  lines.push(`    rowsWithMenu     : ${report.menu.rowsWithMenu}`);
  lines.push(`    presenceFraction : ${report.menu.menuPresenceFraction.toFixed(3)}`);
  lines.push(`    turnConsistent   : ${report.menu.perTurnDigestConsistent}`);
  lines.push('  Outcome joins:');
  lines.push(`    joined           : ${report.outcome.joined}`);
  lines.push(`    unjoinable       : ${report.outcome.unjoinable} (${JSON.stringify(report.outcome.reasons)})`);
  lines.push(`    pending          : ${report.outcome.pending}`);
  lines.push('  Propensity provenance:');
  lines.push(`    ${JSON.stringify(report.propensity)}`);
  lines.push('  Checks:');
  lines.push(`    ${JSON.stringify(report.checks)}`);
  lines.push(`  observationalGatePass : ${report.observationalGatePass}`);
  lines.push(`  offPolicyGatePass     : ${report.offPolicyGatePass}`);
  if (report.notes.length > 0) {
    lines.push('  Notes:');
    for (const n of report.notes) lines.push(`    - ${n}`);
  }
  return lines.join('\n');
}
