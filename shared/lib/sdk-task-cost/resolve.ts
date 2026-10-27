/**
 * Workflow-cost outcome from SDK summaries (HOK-3076, HOK-3077): turn the
 * collected `TaskCostSummaryV1[]` into the `WorkflowCostOutcome` an eval
 * record persists.
 *
 * The SDK is the only engine. A valid summary is projected; partial,
 * unavailable and known-zero summaries keep their coverage through the
 * projection, so none of them can become a complete cost. Absence is never a
 * zero: no summary is a `no_sessions` failure, and a collection that threw is
 * an `adapter_error` failure — both carry diagnostics and no dollar figure.
 *
 * Pure: no IO, no SDK runtime import (`project.ts` only imports SDK types),
 * so eval entrypoints can load it under a stale `@hokusai/core`.
 *
 * @module sdk-task-cost/resolve
 */

import { getEffectiveRegistry, resolveModelRegistryKey } from '../model-registry.ts';
import type { PricingTable } from '../pricing/model-pricing.ts';
import type { WorkflowCostFailure, WorkflowCostOutcome } from '../workflow-cost.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { projectTaskCostSummaryToWorkflowCost, selectPrimaryTaskCostSummary } from './project.ts';

export type WorkflowCostSelectionReason =
  /** A valid summary exists: the projection is the outcome. */
  | 'sdk_summary'
  /** Collection ran but no session produced a cost event. */
  | 'no_sdk_summary'
  /** Collection threw (stale SDK, contract violation, unreadable session). */
  | 'collection_failed';

export interface ResolveWorkflowCostInput {
  summaries: readonly TaskCostSummaryV1[] | null | undefined;
  /** Message of the error the collector threw, when it threw. */
  collectionError?: string | null;
  agentType?: string | null;
  /** Pricing table the summaries were priced with; rebuilds `pricingUsed`. */
  pricingTable?: PricingTable;
  repoDir?: string;
  /** Join inputs, echoed into a failure outcome's diagnostics. */
  diagnostics?: WorkflowCostFailure['diagnostics'];
}

export interface ResolvedWorkflowCost {
  outcome: WorkflowCostOutcome;
  reason: WorkflowCostSelectionReason;
}

export function resolveWorkflowCost(input: ResolveWorkflowCostInput): ResolvedWorkflowCost {
  const diagnostics: WorkflowCostFailure['diagnostics'] = {
    ...input.diagnostics,
    ...(input.agentType ? { agentType: input.agentType } : {}),
  };
  if (input.collectionError) {
    return {
      outcome: {
        status: 'adapter_error',
        reason: `SDK task-cost collection failed: ${input.collectionError}`,
        diagnostics,
      },
      reason: 'collection_failed',
    };
  }
  const primary = selectPrimaryTaskCostSummary(input.summaries, input.agentType);
  if (!primary) {
    return {
      outcome: {
        status: 'no_sessions',
        reason: 'No session on this branch produced a task-cost event',
        diagnostics: { ...diagnostics, sessionFilesFound: 0, matchingTurns: 0 },
      },
      reason: 'no_sdk_summary',
    };
  }
  const registry = getEffectiveRegistry(input.repoDir);
  return {
    outcome: projectTaskCostSummaryToWorkflowCost(primary, {
      pricingTable: input.pricingTable,
      registryLookup: (modelId) => resolveModelRegistryKey(registry, modelId),
    }),
    reason: 'sdk_summary',
  };
}
