/**
 * Authoritative workflow-cost selection (HOK-3076): decide whether the eval
 * record's `workflowCost*` fields come from the SDK projection or the legacy
 * engine.
 *
 * The SDK projection is used only when a valid SDK summary exists for the
 * run. Absence (no summary, or a bridge failure the runner swallowed) keeps
 * the legacy outcome — usually a `no_sessions` / `skipped` / `adapter_error`
 * failure that already says "no cost", never a zero. Partial, unavailable and
 * known-zero summaries keep their coverage through the projection, so none of
 * them can become a complete cost.
 *
 * @module sdk-task-cost/resolve
 */

import { getEffectiveRegistry, resolveModelRegistryKey } from '../model-registry.ts';
import type { PricingTable, WorkflowCostOutcome } from '../workflow-cost.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { resolveCostMeteringEngine, type CostMeteringEngine } from './feature-switch.ts';
import { projectTaskCostSummaryToWorkflowCost, selectPrimaryTaskCostSummary } from './project.ts';

const USD_TOLERANCE = 1e-9;

export type WorkflowCostSelectionReason =
  /** SDK engine, valid summary: the projection is authoritative. */
  | 'sdk_summary'
  /** `WAVEMILL_COST_METERING_LEGACY` rollback is set. */
  | 'rollback'
  /** SDK engine, but no summary (no sessions, or collection failed). */
  | 'no_sdk_summary'
  /** Legacy carries OpenRouter exact generation costs the bridge cannot fetch. */
  | 'legacy_exact_pricing';

export interface ResolveWorkflowCostInput {
  legacyOutcome: WorkflowCostOutcome | null;
  summaries: readonly TaskCostSummaryV1[] | null | undefined;
  agentType?: string | null;
  /** Pricing table both engines used; rebuilds the projection's `pricingUsed`. */
  pricingTable?: PricingTable;
  repoDir?: string;
  /** Defaults to {@link resolveCostMeteringEngine} on `process.env`. */
  engine?: CostMeteringEngine;
}

export interface ResolvedWorkflowCost {
  outcome: WorkflowCostOutcome | null;
  engine: CostMeteringEngine;
  reason: WorkflowCostSelectionReason;
}

function providerReportedUsd(outcome: WorkflowCostOutcome | null): number {
  if (outcome?.status !== 'success' || !outcome.attribution) return 0;
  return outcome.attribution.models.reduce((sum, model) => sum + (model.providerReportedCostUsd ?? 0), 0);
}

export function resolveAuthoritativeWorkflowCost(input: ResolveWorkflowCostInput): ResolvedWorkflowCost {
  const engine = input.engine ?? resolveCostMeteringEngine();
  if (engine === 'legacy') {
    return { outcome: input.legacyOutcome, engine: 'legacy', reason: 'rollback' };
  }
  const primary = selectPrimaryTaskCostSummary(input.summaries, input.agentType);
  if (!primary) {
    return { outcome: input.legacyOutcome, engine: 'legacy', reason: 'no_sdk_summary' };
  }
  // The exact-pricing path (eval orchestrator, OPENROUTER_API_KEY) replaces
  // native estimates with fetched generation charges; the bridge only sees
  // charges the transcript recorded. Keep the more exact legacy figure.
  if (
    primary.harness === 'native'
    && providerReportedUsd(input.legacyOutcome) > (primary.actual_cost_usd ?? 0) + USD_TOLERANCE
  ) {
    return { outcome: input.legacyOutcome, engine: 'legacy', reason: 'legacy_exact_pricing' };
  }
  const registry = getEffectiveRegistry(input.repoDir);
  return {
    outcome: projectTaskCostSummaryToWorkflowCost(primary, {
      pricingTable: input.pricingTable,
      registryLookup: (modelId) => resolveModelRegistryKey(registry, modelId),
    }),
    engine: 'sdk',
    reason: 'sdk_summary',
  };
}
