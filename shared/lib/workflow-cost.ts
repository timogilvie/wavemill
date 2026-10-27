/**
 * The persisted workflow-cost record shape (HOK-3077).
 *
 * Eval records carry `workflowCost`, `workflowTokenUsage`,
 * `workflowCostAttribution` and `workflowCostStatus` in this shape, and a
 * dozen readers (aggregator, exports, reports) depend on it, so it stays here
 * unchanged. This module computes nothing: the one cost engine is the
 * Hokusai SDK reducer behind `sdk-task-cost/` (whose projection produces a
 * `WorkflowCostResult`), and per-call pricing is `pricing/model-pricing.ts`.
 * `tools/check-cost-ownership.ts` keeps a second engine from coming back.
 *
 * @module workflow-cost
 */

import type { ModelPricing, ModelTokenUsage } from './pricing/model-pricing.ts';

export type WorkflowCostAttributionCoverage = 'complete' | 'partial' | 'unavailable' | 'known_zero';
export type WorkflowCostAttributionReason =
  | 'missing_token_usage'
  | 'invalid_token_usage'
  | 'unpriced_model'
  | 'mixed_coverage'
  | 'provider_reported_cost'
  | 'no_pricing_data'
  | 'no_priced_sessions';

export type WorkflowCostPricingSource = 'openrouter_api' | 'local_estimate' | 'mixed';

export interface WorkflowCostAttributionModel {
  provider: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  providerReportedCostUsd?: number;
  pricingSource?: WorkflowCostPricingSource;
  priced: boolean;
  reason?: WorkflowCostAttributionReason;
}

export interface WorkflowCostAttribution {
  source: 'native' | 'codex' | 'claude';
  coverage: WorkflowCostAttributionCoverage;
  reason?: WorkflowCostAttributionReason;
  sessions: number;
  turns: number;
  pricedSessions: number;
  unpricedSessions: number;
  models: WorkflowCostAttributionModel[];
}

/** Result from scanning workflow sessions. */
export interface WorkflowCostResult {
  /** Total estimated cost in USD across all models and sessions. */
  totalCostUsd: number;
  /** Per-model token usage breakdown. */
  models: Record<string, ModelTokenUsage>;
  /** Number of session files scanned. */
  sessionCount: number;
  /** Number of assistant turns counted. */
  turnCount: number;
  /** Status indicator for successful computation */
  status: 'success';
  /** Snapshot of pricing table used for cost calculation (HOK-858) */
  pricingUsed: Record<string, ModelPricing>;
  /** Optional additive attribution metadata for native workflow cost coverage. */
  attribution?: WorkflowCostAttribution;
}

/** Failure result with diagnostic information (HOK-883). */
export interface WorkflowCostFailure {
  /** Status code indicating why cost computation failed */
  status: 'no_sessions' | 'no_branch' | 'adapter_error' | 'missing_worktree' | 'skipped';
  /** Human-readable reason for failure */
  reason: string;
  /** Diagnostic details to help debug the issue */
  diagnostics: {
    worktreePath?: string;
    branchName?: string;
    agentType?: string;
    sessionFilesFound?: number;
    totalAssistantTurns?: number;
    branchMismatches?: number;
    matchingTurns?: number;
  };
}

/** Result of workflow cost computation - either success or failure with diagnostics */
export type WorkflowCostOutcome = WorkflowCostResult | WorkflowCostFailure;

/**
 * The dollar figure an eval record may report for an outcome (HOK-3076), or
 * `undefined` when there is none: a failure, or a success that priced
 * nothing (unpriced models, missing usage) and is not an explicit known
 * zero. Such a record keeps its attribution, but never presents `$0.00` as
 * a cost or contributes it to an aggregate.
 */
export function reportableWorkflowCostUsd(outcome: WorkflowCostOutcome | null | undefined): number | undefined {
  if (outcome?.status !== 'success') return undefined;
  const attribution = outcome.attribution;
  if (attribution && attribution.pricedSessions === 0 && attribution.coverage !== 'known_zero') return undefined;
  return outcome.totalCostUsd;
}
