/**
 * Tool-choice decision gate (HOK-2080).
 *
 * Turns the data-quality report + analysis result into an explicit
 * go / no-go / inconclusive decision plus a computed minimum-additional-capture
 * hint and a stated kill condition. This is the *machine-checkable* part of
 * the HOK-2080 acceptance requirement — the report doc quotes what this
 * function returns, and a later re-run recomputes the same decision from
 * refreshed data.
 *
 * The rule set is intentionally simple and constants-only so the reasoning
 * is auditable:
 *   - go: quality gate passes AND ≥1 pre-registered contrast is significant
 *         in the base run AND the sensitivity sweep does not overturn it AND
 *         off-policy is at least eligible for calibration;
 *   - no-go: quality gate passes but no contrast survives sensitivity;
 *   - inconclusive: everything else — with a *computed* recommendation for
 *         what additional capture would be needed to reach a decision.
 *
 * Kill condition: if the recommended additional capture is collected and the
 * decision remains no-go/inconclusive on the next run, HOK-2081 is not built.
 */

import type { AnalysisResult } from './tool-choice-signal-stats.ts';
import type { QualityGateReport, QualityGateThresholds } from './tool-choice-quality-gate.ts';

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

export type DecisionValue = 'go' | 'no-go' | 'inconclusive';

export interface MinimumAdditionalCapture {
  /** Additional joined-outcome traces needed to reach the observational floor. */
  additionalJoinedTraces: number;
  /** Additional coding-stage rows needed to hit menu-presence threshold. */
  additionalMenuBearingRows: number;
  /**
   * Rows needed with `exact` propensity (from logprob-capable providers) to
   * unblock the off-policy path — 1 unblocks the estimator; more is better.
   */
  additionalExactPropensityRows: number;
  /** Guidance the operator can act on, in a bounded human-readable list. */
  guidance: string[];
}

export interface Decision {
  decision: DecisionValue;
  reasons: string[];
  killCondition: string;
  minimumAdditionalCapture?: MinimumAdditionalCapture;
  /** Present when the operator supplied a --decision-override; both are recorded. */
  computed?: DecisionValue;
  operatorOverride?: {
    decision: DecisionValue;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface DecideInput {
  quality: QualityGateReport;
  analysis: AnalysisResult;
  operatorOverride?: { decision: DecisionValue; reason: string };
}

function computeMinimumCapture(quality: QualityGateReport): MinimumAdditionalCapture {
  const thresholds: QualityGateThresholds = quality.thresholds;
  const additionalJoinedTraces = Math.max(
    0,
    thresholds.minJoinedTracesPerCell - quality.outcome.joinedTraceIds.length,
  );
  const totalRows = quality.coverage.totalDecisions;
  const currentMenu = quality.menu.rowsWithMenu;
  const targetMenu = Math.ceil(thresholds.minMenuPresenceFraction * Math.max(totalRows, 1));
  const additionalMenuBearingRows = Math.max(0, targetMenu - currentMenu);
  const additionalExactPropensityRows = Math.max(
    0,
    thresholds.minExactPropensityRows - quality.propensity.exact,
  );
  const guidance: string[] = [];
  if (additionalJoinedTraces > 0) {
    guidance.push(
      `Capture ~${additionalJoinedTraces} more coding traces whose sessionId embeds a HOK issue and whose eval record joins.`,
    );
  }
  if (additionalMenuBearingRows > 0) {
    guidance.push(
      `Re-run analysis after post-HOK-3054 capture accumulates so ≥${(thresholds.minMenuPresenceFraction * 100).toFixed(0)}% of rows carry a tool_menu event.`,
    );
  }
  if (additionalExactPropensityRows > 0) {
    guidance.push(
      'Enable provider logprob capture (or a provider-reported top-tool probability) on at least a controlled coding-stage subset before any off-policy estimation.',
    );
  }
  if (quality.coverage.rowsWithTerminalResult === 0 && quality.coverage.rowsWithSkippedResult > 0) {
    guidance.push(
      'Ensure `tool_result` events are captured in the session-events stream — the projected corpus currently has no terminal result statuses, so the Tier-0 local success signal is unobservable.',
    );
  }
  return {
    additionalJoinedTraces,
    additionalMenuBearingRows,
    additionalExactPropensityRows,
    guidance,
  };
}

function significantContrastCount(analysis: AnalysisResult): number {
  return analysis.stratified.contrasts.filter((c) => !c.gated && c.significant).length;
}

function sensitivitySurvives(analysis: AnalysisResult): boolean {
  const sens = analysis.sensitivity;
  if (!sens) return false;
  // Require: no LOO run kills all significant contrasts (i.e. sig > 0 in every LOO).
  const perModelOk = sens.perModel.length === 0 || sens.perModel.every((r) => r.sig > 0);
  const perIssueOk = sens.perIssue.length === 0 || sens.perIssue.every((r) => r.sig > 0);
  return perModelOk && perIssueOk;
}

export const KILL_CONDITION =
  'If, after collecting the minimum additional capture below, the pre-registered contrasts remain null OR propensity quality still bars off-policy validation, HOK-2081 will not be built. The corpus is retained for diagnostics only.';

export function decideToolChoice(input: DecideInput): Decision {
  const { quality, analysis } = input;
  const reasons: string[] = [];
  let computed: DecisionValue;

  if (!quality.observationalGatePass) {
    reasons.push('quality gate did not pass (see notes)');
    for (const n of quality.notes) reasons.push(n);
    computed = 'inconclusive';
  } else {
    const sig = significantContrastCount(analysis);
    if (sig === 0) {
      reasons.push('no observed contrast excludes zero at 95% (base run)');
      computed = 'no-go';
    } else if (!sensitivitySurvives(analysis)) {
      reasons.push('at least one leave-one-out sweep eliminates every significant contrast');
      computed = 'inconclusive';
    } else if (!quality.checks.offPolicyEligible) {
      reasons.push(
        'observational signal survives sensitivity but no exact-propensity rows exist — declaring a positive signal without any causal-quality evidence is not permitted',
      );
      computed = 'inconclusive';
    } else {
      reasons.push('signal replicates across sensitivity sweeps with off-policy calibration eligible');
      computed = 'go';
    }
  }

  const minCapture =
    computed === 'go'
      ? undefined
      : computeMinimumCapture(quality);

  const decision: Decision = {
    decision: computed,
    reasons,
    killCondition: KILL_CONDITION,
    computed,
  };
  if (minCapture) decision.minimumAdditionalCapture = minCapture;

  if (input.operatorOverride) {
    decision.operatorOverride = input.operatorOverride;
    decision.decision = input.operatorOverride.decision;
    reasons.push(`operator override applied: ${input.operatorOverride.reason}`);
  }

  return decision;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export function formatDecision(decision: Decision): string {
  const lines: string[] = [];
  const label =
    decision.decision === 'go'
      ? 'Go'
      : decision.decision === 'no-go'
      ? 'No-go'
      : 'Inconclusive';
  lines.push(`Decision: ${label}`);
  if (decision.computed && decision.computed !== decision.decision) {
    lines.push(`  (computed: ${decision.computed}, overridden by operator)`);
  }
  for (const r of decision.reasons) lines.push(`  - ${r}`);
  if (decision.minimumAdditionalCapture) {
    lines.push('  Minimum additional capture:');
    lines.push(
      `    joined traces needed: ${decision.minimumAdditionalCapture.additionalJoinedTraces}`,
    );
    lines.push(
      `    menu-bearing rows needed: ${decision.minimumAdditionalCapture.additionalMenuBearingRows}`,
    );
    lines.push(
      `    exact-propensity rows needed: ${decision.minimumAdditionalCapture.additionalExactPropensityRows}`,
    );
    for (const g of decision.minimumAdditionalCapture.guidance) {
      lines.push(`    - ${g}`);
    }
  }
  lines.push('  Kill condition:');
  lines.push(`    ${decision.killCondition}`);
  return lines.join('\n');
}
