/**
 * Eval summary printer — format and print evaluation summaries.
 *
 * Provides functions to format and print eval results to console.
 * Separates presentation logic from orchestration.
 *
 * @module eval-summary-printer
 */

import type { EvalRecord, WorkflowCostAttribution } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Formatting Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Format score and band for display.
 *
 * @param score - Numeric score (0-1)
 * @param scoreBand - Score band (e.g., "excellent", "good", "fair")
 * @returns Formatted string like "excellent (0.95)"
 */
export function formatScoreDisplay(score: number, scoreBand: string): string {
  const scoreDisplay = score.toFixed(2);
  return `${scoreBand} (${scoreDisplay})`;
}

/**
 * True when a workflow cost is a local token-equivalent estimate rather than
 * a provider charge (HOK-3076). CLI harnesses (Claude Code, Codex) run on
 * subscriptions with no per-call charge, so their dollars are always an
 * estimate; a native cost is exact only when every priced model's cost was
 * provider-reported. Without attribution the provenance is unknown and the
 * figure is shown as-is.
 */
export function isEstimatedWorkflowCost(attribution?: WorkflowCostAttribution | null): boolean {
  if (!attribution) return false;
  if (attribution.source !== 'native') return true;
  return attribution.models.some((model) => model.priced && model.pricingSource !== 'openrouter_api');
}

/**
 * Format a workflow cost amount: `$0.1234`, `~$0.1234 (estimate)` for an
 * estimated cost, or `unavailable` when no dollar figure exists.
 */
export function formatWorkflowCostAmount(
  workflowCost: number | undefined,
  attribution?: WorkflowCostAttribution | null,
): string {
  if (workflowCost === undefined) {
    return 'unavailable';
  }
  const amount = `$${workflowCost.toFixed(4)}`;
  return isEstimatedWorkflowCost(attribution) ? `~${amount} (estimate)` : amount;
}

/**
 * Format workflow cost for display.
 *
 * @param workflowCost - Cost in USD
 * @param attribution - Cost attribution; labels estimates and marks a priced-nothing record unavailable
 * @returns Formatted string like ", workflow cost: $0.1234", or empty string if there is no cost evidence
 */
export function formatCostDisplay(workflowCost?: number, attribution?: WorkflowCostAttribution | null): string {
  if (workflowCost === undefined && !attribution) {
    return '';
  }
  return `, workflow cost: ${formatWorkflowCostAmount(workflowCost, attribution)}`;
}

/**
 * Format intervention count for display.
 *
 * @param totalInterventions - Number of interventions
 * @returns Formatted string like "5 intervention(s) detected" or "no interventions"
 */
export function formatInterventionDisplay(totalInterventions: number): string {
  if (totalInterventions === 0) {
    return 'no interventions detected';
  }
  return `${totalInterventions} intervention(s) detected`;
}

/**
 * Format difficulty info for display.
 *
 * @param difficultyBand - Difficulty band (e.g., "medium")
 * @param locTouched - Lines of code touched
 * @param filesTouched - Number of files touched
 * @param stratum - Stratum identifier
 * @param diffUncertain - Whether diff is uncertain/incomplete
 * @returns Formatted string like "difficulty medium (150 LOC, 5 files, stratum: stratum-2)"
 */
export function formatDifficultyDisplay(
  difficultyBand: string,
  locTouched: number,
  filesTouched: number,
  stratum: string,
  diffUncertain: boolean
): string {
  const uncertainSuffix = diffUncertain ? ' ⚠ UNCERTAIN — diff may be incomplete' : '';
  return (
    `difficulty ${difficultyBand} ` +
    `(${locTouched} LOC, ${filesTouched} files, stratum: ${stratum})${uncertainSuffix}`
  );
}

/**
 * Format task context info for display.
 *
 * @param taskType - Task type (e.g., "feature", "bug")
 * @param changeKind - Change kind (e.g., "new-feature", "refactor")
 * @param complexity - Complexity level (e.g., "medium")
 * @returns Formatted string like "task context feature / new-feature / complexity medium"
 */
export function formatTaskContextDisplay(
  taskType: string,
  changeKind: string,
  complexity: string
): string {
  return `task context ${taskType} / ${changeKind} / complexity ${complexity}`;
}

/**
 * Format repo context info for display.
 *
 * @param primaryLanguage - Primary language (e.g., "TypeScript")
 * @param repoVisibility - Repo visibility (e.g., "private")
 * @param fileCount - Number of files in repo
 * @returns Formatted string like "repo context TypeScript / private / 100 files"
 */
export function formatRepoContextDisplay(
  primaryLanguage: string,
  repoVisibility: string,
  fileCount: number
): string {
  return `repo context ${primaryLanguage} / ${repoVisibility} / ${fileCount} files`;
}

/**
 * Format workflow cost outcome for display.
 *
 * @param totalCostUsd - Total cost in USD, or undefined when unavailable
 * @param turnCount - Number of turns
 * @param sessionCount - Number of sessions
 * @param attribution - Cost attribution, for the estimate label
 * @returns Formatted string like "workflow cost $0.1234 (10 turns across 2 session(s))"
 */
export function formatWorkflowCostOutcome(
  totalCostUsd: number | undefined,
  turnCount: number,
  sessionCount: number,
  attribution?: WorkflowCostAttribution | null,
): string {
  return (
    `workflow cost ${formatWorkflowCostAmount(totalCostUsd, attribution)} ` +
    `(${turnCount} turns across ${sessionCount} session(s))`
  );
}

function shortRoute(route?: { coder: string; codeDepth: string; reviewer: string; reviewMode: string }): string {
  if (!route) {
    return '';
  }
  return `${route.coder}/${route.codeDepth}/${route.reviewer}/${route.reviewMode}`;
}

export function formatRouteProvenanceDisplay(record: EvalRecord): string {
  const provenance = record.routeProvenance;
  if (!provenance?.decisionSource || !provenance.activeRoute) {
    return '';
  }

  return `, route: ${provenance.decisionSource} ${shortRoute(provenance.activeRoute)} changed=${provenance.routeChanged === true ? 'true' : 'false'}`;
}

// ────────────────────────────────────────────────────────────────
// Main Printer
// ────────────────────────────────────────────────────────────────

/**
 * Print eval summary to console.
 *
 * Prints a one-line summary with score, band, and optional workflow cost.
 * Example: "Post-completion eval: excellent (0.95), workflow cost: $0.1234 — saved to eval store"
 *
 * @param record - Complete eval record
 * @param prefix - Optional prefix for the message (default: "Post-completion eval")
 */
export function printEvalSummary(record: EvalRecord, prefix = 'Post-completion eval'): void {
  const scoreDisplay = formatScoreDisplay(record.score as number, record.scoreBand);
  const costSuffix = formatCostDisplay(record.workflowCost, record.workflowCostAttribution);
  const routeSuffix = formatRouteProvenanceDisplay(record);
  console.log(`${prefix}: ${scoreDisplay}${costSuffix}${routeSuffix} — saved to eval store`);
}
