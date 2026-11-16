/**
 * The persisted workflow-cost record shape (HOK-3077).
 *
 * Eval records carry `workflowCost`, `workflowTokenUsage`,
 * `workflowCostAttribution` and `workflowCostStatus` in this shape, and a
 * dozen readers (aggregator, exports, reports) depend on it, so it stays here
 * unchanged. This module computes no cost: the one cost engine is
 * `@hokusai/costs`, measured over the task's owned sessions by
 * `sdk-task-cost/meter.ts` (whose projection produces a `WorkflowCostResult`).
 * Wavemill supplies only rates (`pricing/model-pricing.ts`) and ownership
 * (`session-ownership.ts`).
 * `tools/check-cost-ownership.ts` keeps a second engine from coming back.
 *
 * @module workflow-cost
 */

import type { ModelPricing, ModelTokenUsage } from './pricing/model-pricing.ts';
import type { OpenRouterGenerationCost } from './pricing/openrouter-exact-pricing.ts';

/** Factual turn evidence, independent of whether the stage ultimately passed. */
export interface NativeProviderExecution {
  sessionRef: string;
  /** All recorded owners: legacy reused sessions cannot be split by guesswork. */
  ownershipAttemptIds: string[];
  responseId: string | null;
  transport: string;
  requestedModel: string | null;
  responseModel: string | null;
  /** Observed OpenRouter metadata, never inferred from a requested model/pin. */
  generation: OpenRouterGenerationCost | null;
}

/** Re-enrichment may fill gaps, but a failed lookup cannot erase observations. */
export function mergeNativeProviderExecutions(
  previous: readonly NativeProviderExecution[] = [],
  incoming: readonly NativeProviderExecution[] = [],
): NativeProviderExecution[] {
  const entries = new Map<string, NativeProviderExecution>();
  for (const next of [...previous, ...incoming]) {
    // Without a response id two turns cannot safely be identified as the same.
    const key = next.responseId === null ? `anonymous:${entries.size}`
      : JSON.stringify([next.sessionRef, next.transport, next.responseId]);
    const old = entries.get(key);
    entries.set(key, old ? {
      ...next,
      requestedModel: next.requestedModel ?? old.requestedModel,
      responseModel: next.responseModel ?? old.responseModel,
      ownershipAttemptIds: [...new Set([...old.ownershipAttemptIds, ...next.ownershipAttemptIds])],
      generation: next.generation ? {
        ...old.generation, ...next.generation,
        totalCostUsd: next.generation.totalCostUsd ?? old.generation?.totalCostUsd ?? null,
      } : old.generation,
    } : next);
  }
  return [...entries.values()];
}

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
  /** The one harness that contributed, or `multi` when several did (HOK-3328). */
  source: 'native' | 'codex' | 'claude' | 'multi';
  coverage: WorkflowCostAttributionCoverage;
  reason?: WorkflowCostAttributionReason;
  sessions: number;
  turns: number;
  pricedSessions: number;
  unpricedSessions: number;
  models: WorkflowCostAttributionModel[];
}

/**
 * `@hokusai/costs` per-harness totals (`claude-code`, `codex`, `native`); a
 * `null` value is a harness whose cost is unresolved (HOK-3328).
 */
export type WorkflowCostByHarness = Record<string, number | null>;

/** Result from scanning workflow sessions. */
export interface WorkflowCostResult {
  nativeProviderExecutions?: NativeProviderExecution[];
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
  /** Per-harness slices of `totalCostUsd`, from the SDK report (HOK-3328). */
  byHarness?: WorkflowCostByHarness;
  /** SDK totals per session-ownership kind (planning, coding, helper:*, …). */
  byKind?: Record<string, number | null>;
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
