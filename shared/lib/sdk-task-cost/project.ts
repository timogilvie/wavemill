/**
 * Projection from SDK `TaskCostSummaryV1` to Wavemill's legacy
 * `WorkflowCostResult` / `WorkflowCostAttribution` shape (HOK-3075).
 *
 * This is the read-side half of the bridge: it lets an SDK-backed record flow
 * through `attachWorkflowCostMetadata` and every existing workflow-cost
 * reader unchanged. It is pure and is NOT wired into any eval entrypoint yet —
 * the HOK-3076 cutover decides when (and whether) it replaces the legacy
 * engine's outcome. Shadow compare uses it to diff like-for-like.
 *
 * Mapping notes (semantics HOK-3076 must review before cutover):
 * - `totalCostUsd` is the summary's `total_cost_usd`; when that is `null` (an
 *   unresolved event) the legacy numeric view's lower bound
 *   `actual + estimated` is used, matching the legacy convention that an
 *   unpriced model contributes `0` to the number while attribution carries the
 *   truth. Bridge-emitted events never carry both figures, so the sum is exact
 *   for them.
 * - Codex `outputTokens` re-folds reasoning tokens, matching the legacy
 *   `models` view (`codex/1`).
 * - `pricedSessions` / `unpricedSessions` count model segments: the SDK
 *   summary does not retain per-session pricing.
 *
 * @module sdk-task-cost/project
 */

import type {
  ModelPricing,
  ModelTokenUsage,
  PricingTable,
  WorkflowCostAttribution,
  WorkflowCostAttributionModel,
  WorkflowCostAttributionReason,
  WorkflowCostPricingSource,
  WorkflowCostResult,
} from '../workflow-cost.ts';
import type { TaskCostModelSegment, TaskCostSummaryV1 } from './contract.ts';

const ATTRIBUTION_SOURCE: Record<string, WorkflowCostAttribution['source']> = {
  native: 'native',
  'claude-code': 'claude',
  codex: 'codex',
};

const AGENT_TYPE_HARNESS: Record<string, TaskCostSummaryV1['harness']> = {
  native: 'native',
  claude: 'claude-code',
  'claude-deepseek': 'claude-code',
  codex: 'codex',
};

/** Reasons the legacy engine reports for an unavailable record, in its priority order. */
const UNAVAILABLE_REASONS: readonly WorkflowCostAttributionReason[] = [
  'invalid_token_usage',
  'missing_token_usage',
  'unpriced_model',
  'no_priced_sessions',
];

export interface ProjectTaskCostOptions {
  /** Pricing table used to rebuild the `pricingUsed` snapshot. */
  pricingTable?: PricingTable;
  /** Canonical registry key lookup for pricing-table hits. */
  registryLookup?: (modelId: string) => string;
}

/**
 * Pick the summary the legacy engine would have costed: native first (it is
 * preferred whenever it has usable data), else the harness matching the
 * workflow's agent type, else the first summary.
 */
export function selectPrimaryTaskCostSummary(
  summaries: readonly TaskCostSummaryV1[] | null | undefined,
  agentType?: string | null,
): TaskCostSummaryV1 | null {
  if (!summaries || summaries.length === 0) return null;
  const native = summaries.find((summary) => summary.harness === 'native');
  if (native) return native;
  const preferred = agentType ? AGENT_TYPE_HARNESS[agentType] : undefined;
  return summaries.find((summary) => summary.harness === preferred) ?? summaries[0];
}

function segmentCost(segment: TaskCostModelSegment): number | null {
  if (segment.actual_cost_usd === null && segment.estimated_cost_usd === null) return null;
  return (segment.actual_cost_usd ?? 0) + (segment.estimated_cost_usd ?? 0);
}

function segmentPricingSource(segment: TaskCostModelSegment): WorkflowCostPricingSource | undefined {
  if (segment.actual_cost_usd !== null && segment.estimated_cost_usd !== null) return 'mixed';
  if (segment.actual_cost_usd !== null) return 'openrouter_api';
  if (segment.estimated_cost_usd !== null) return 'local_estimate';
  return undefined;
}

function mergePricingSource(
  current: WorkflowCostPricingSource | undefined,
  next: WorkflowCostPricingSource | undefined,
): WorkflowCostPricingSource | undefined {
  if (next === undefined) return current;
  return current === undefined || current === next ? next : 'mixed';
}

function attributionReason(summary: TaskCostSummaryV1): WorkflowCostAttributionReason | undefined {
  switch (summary.coverage) {
    case 'partial':
      // Name the gap when the SDK recorded one (an unpriced model, missing
      // usage), matching the legacy partial reason; else a mixed record.
      return UNAVAILABLE_REASONS.find((reason) => reason !== 'no_priced_sessions' && summary.diagnostics.includes(reason))
        ?? 'mixed_coverage';
    case 'known_zero':
      return undefined;
    case 'unavailable':
      return UNAVAILABLE_REASONS.find((reason) => summary.diagnostics.includes(reason)) ?? 'no_priced_sessions';
    case 'complete':
      return summary.diagnostics.includes('provider_reported_cost') ? 'provider_reported_cost' : undefined;
  }
}

/** Project one SDK summary into a legacy `WorkflowCostResult` with attribution. */
export function projectTaskCostSummaryToWorkflowCost(
  summary: TaskCostSummaryV1,
  options: ProjectTaskCostOptions = {},
): WorkflowCostResult {
  const foldReasoning = summary.harness === 'codex';
  const models: Record<string, ModelTokenUsage> = {};
  const attributionModels = new Map<string, WorkflowCostAttributionModel>();
  const pricingUsed: Record<string, ModelPricing> = {};
  let pricedSegments = 0;
  let unpricedSegments = 0;

  for (const segment of summary.model_segments) {
    const usage = segment.usage;
    const outputTokens = (usage.output_tokens ?? 0) + (foldReasoning ? usage.reasoning_tokens ?? 0 : 0);
    const cost = segmentCost(segment);
    const legacy = models[segment.model] ??= {
      inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0,
    };
    legacy.inputTokens += usage.input_tokens ?? 0;
    legacy.cacheCreationTokens += usage.cache_write_tokens ?? 0;
    legacy.cacheReadTokens += usage.cache_read_tokens ?? 0;
    legacy.outputTokens += outputTokens;
    legacy.costUsd += cost ?? 0;

    let model = attributionModels.get(segment.model);
    if (!model) {
      model = { provider: ATTRIBUTION_SOURCE[summary.harness] ?? summary.harness, modelId: segment.model, priced: false };
      attributionModels.set(segment.model, model);
    }
    model.inputTokens = (model.inputTokens ?? 0) + (usage.input_tokens ?? 0);
    model.outputTokens = (model.outputTokens ?? 0) + outputTokens;
    model.cacheReadTokens = (model.cacheReadTokens ?? 0) + (usage.cache_read_tokens ?? 0);
    model.cacheCreationTokens = (model.cacheCreationTokens ?? 0) + (usage.cache_write_tokens ?? 0);
    model.totalTokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;

    if (cost === null) {
      unpricedSegments++;
      if (!model.priced) model.reason = 'unpriced_model';
      continue;
    }
    pricedSegments++;
    model.priced = true;
    delete model.reason;
    model.costUsd = (model.costUsd ?? 0) + cost;
    if (segment.actual_cost_usd !== null) {
      model.providerReportedCostUsd = (model.providerReportedCostUsd ?? 0) + segment.actual_cost_usd;
    }
    model.pricingSource = mergePricingSource(model.pricingSource, segmentPricingSource(segment));
    if (segment.estimated_cost_usd !== null && options.pricingTable) {
      const pricing = options.pricingTable[options.registryLookup?.(segment.model) ?? segment.model]
        ?? options.pricingTable[segment.model];
      if (pricing) pricingUsed[segment.model] = pricing;
    }
  }

  const reason = attributionReason(summary);
  return {
    totalCostUsd: summary.total_cost_usd
      ?? (summary.actual_cost_usd ?? 0) + (summary.estimated_cost_usd ?? 0),
    models,
    sessionCount: summary.session_ids.length,
    turnCount: summary.turn_count,
    status: 'success',
    pricingUsed,
    attribution: {
      source: ATTRIBUTION_SOURCE[summary.harness] ?? 'claude',
      coverage: summary.coverage,
      ...(reason ? { reason } : {}),
      sessions: summary.session_ids.length,
      turns: summary.turn_count,
      pricedSessions: pricedSegments,
      unpricedSessions: unpricedSegments,
      models: [...attributionModels.values()],
    },
  };
}
