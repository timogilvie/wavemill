/**
 * Projection from the `@hokusai/costs` task report to Wavemill's persisted
 * `WorkflowCostResult` / `WorkflowCostAttribution` shape (HOK-3328).
 *
 * The report is the cost: `totalCostUsd` is its cross-harness `totalUsd`,
 * `byHarness` its per-harness slices, and each model's cost is its `byModel`
 * breakdown. Nothing here picks a harness, prices a token, or resolves a cost
 * — the per-model rows are a view of the SDK's model segments (tokens) and
 * per-model totals (cost) so the dozen `workflowTokenUsage` / attribution
 * readers keep working unchanged.
 *
 * Mapping notes:
 * - Cost is never re-derived from segment sums: an event can carry both a
 *   provider-reported charge and a list-price estimate, and the SDK resolves
 *   it as `actual ?? estimated`. Adding a segment's two sums double-counts it.
 * - `byModel` merges harnesses. A model that ran under several harnesses in
 *   one task has its combined cost on the first harness's attribution entry
 *   and `costUsd: 0` on the others, so per-model entries still sum to the
 *   total. (A per-harness model breakdown would need an SDK report field.)
 * - When a total is `null` (an unresolved event), the numeric view is the
 *   SDK's lower bound `actual + estimated`, matching the legacy convention;
 *   attribution carries the truth (`coverage`, `reason`).
 * - `outputTokens` is the contract's `output_tokens`, which already includes
 *   reasoning (Codex reports `reasoning_tokens` as a breakdown of it).
 * - `pricedSessions` / `unpricedSessions` count model segments.
 *
 * @module sdk-task-cost/project
 */

import type { TaskCostBreakdown, TaskCostReport } from '@hokusai/costs';
import type {
  WorkflowCostAttribution,
  WorkflowCostAttributionModel,
  WorkflowCostAttributionReason,
  WorkflowCostByHarness,
  WorkflowCostPricingSource,
  WorkflowCostResult,
} from '../workflow-cost.ts';
import type { TaskCostModelSegment, TaskCostSummaryV1 } from './contract.ts';

const ATTRIBUTION_SOURCE: Record<string, WorkflowCostAttribution['source']> = {
  native: 'native',
  'claude-code': 'claude',
  codex: 'codex',
};

/** Reasons recorded for an unavailable/partial record, in priority order. */
const GAP_REASONS: readonly WorkflowCostAttributionReason[] = [
  'invalid_token_usage',
  'missing_token_usage',
  'unpriced_model',
  'no_priced_sessions',
];

function segmentPriced(segment: TaskCostModelSegment): boolean {
  return segment.actual_cost_usd !== null || segment.estimated_cost_usd !== null;
}

const PRICING_SOURCE: Partial<Record<TaskCostBreakdown['costSource'], WorkflowCostPricingSource>> = {
  provider_reported: 'openrouter_api',
  local_estimate: 'local_estimate',
  mixed: 'mixed',
};

function attributionReason(report: TaskCostReport): WorkflowCostAttributionReason | undefined {
  const codes = new Set<string>(report.diagnostics.map((diagnostic) => diagnostic.code));
  switch (report.coverage.status) {
    case 'partial':
      return GAP_REASONS.find((reason) => reason !== 'no_priced_sessions' && codes.has(reason)) ?? 'mixed_coverage';
    case 'known_zero':
      return undefined;
    case 'unavailable':
      return GAP_REASONS.find((reason) => codes.has(reason)) ?? 'no_priced_sessions';
    case 'complete':
      return codes.has('provider_reported_cost') ? 'provider_reported_cost' : undefined;
  }
}

/** The report's per-harness totals (`null` where a harness left an event unresolved). */
export function reportByHarness(report: TaskCostReport): WorkflowCostByHarness {
  const byHarness: WorkflowCostByHarness = {};
  for (const [harness, breakdown] of Object.entries(report.byHarness)) {
    if (breakdown) byHarness[harness] = breakdown.totalUsd;
  }
  return byHarness;
}

/** The numeric figure for a report: its total, else the SDK's lower bound. */
export function reportCostUsd(report: Pick<TaskCostReport, 'totalUsd' | 'actualUsd' | 'estimatedUsd'>): number {
  return report.totalUsd ?? (report.actualUsd ?? 0) + (report.estimatedUsd ?? 0);
}

/**
 * Project a `@hokusai/costs` report into the persisted workflow-cost shape.
 * `pricingUsed` is the caller's rate snapshot for the priced models (the
 * overrides it handed the SDK), never recomputed here.
 */
export function projectReportToWorkflowCost(
  report: TaskCostReport,
  pricingUsed: WorkflowCostResult['pricingUsed'] = {},
): WorkflowCostResult {
  const models: WorkflowCostResult['models'] = {};
  const attributionModels = new Map<string, WorkflowCostAttributionModel>();
  let pricedSegments = 0;
  let unpricedSegments = 0;
  const sessionIds = new Set<string>();

  for (const summary of report.summaries as readonly TaskCostSummaryV1[]) {
    for (const sessionId of summary.session_ids) sessionIds.add(`${summary.harness}\0${sessionId}`);
    const provider = ATTRIBUTION_SOURCE[summary.harness] ?? summary.harness;
    for (const segment of summary.model_segments) {
      const usage = segment.usage;
      const outputTokens = usage.output_tokens ?? 0;
      const legacy = models[segment.model] ??= {
        inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0,
      };
      legacy.inputTokens += usage.input_tokens ?? 0;
      legacy.cacheCreationTokens += usage.cache_write_tokens ?? 0;
      legacy.cacheReadTokens += usage.cache_read_tokens ?? 0;
      legacy.outputTokens += outputTokens;

      const key = `${provider}\0${segment.model}`;
      let model = attributionModels.get(key);
      if (!model) {
        model = { provider, modelId: segment.model, priced: false };
        attributionModels.set(key, model);
      }
      model.inputTokens = (model.inputTokens ?? 0) + (usage.input_tokens ?? 0);
      model.outputTokens = (model.outputTokens ?? 0) + outputTokens;
      model.cacheReadTokens = (model.cacheReadTokens ?? 0) + (usage.cache_read_tokens ?? 0);
      model.cacheCreationTokens = (model.cacheCreationTokens ?? 0) + (usage.cache_write_tokens ?? 0);
      model.totalTokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;

      if (!segmentPriced(segment)) {
        unpricedSegments++;
        if (!model.priced) model.reason = 'unpriced_model';
        continue;
      }
      pricedSegments++;
      model.priced = true;
      delete model.reason;
      if (segment.actual_cost_usd !== null) {
        model.providerReportedCostUsd = (model.providerReportedCostUsd ?? 0) + segment.actual_cost_usd;
      }
    }
  }

  // Cost comes from the SDK's resolved per-model breakdown, never segment sums.
  for (const [modelId, legacy] of Object.entries(models)) {
    const breakdown = report.byModel[modelId];
    legacy.costUsd = breakdown ? reportCostUsd(breakdown) : 0;
  }
  const costedModels = new Set<string>();
  for (const model of attributionModels.values()) {
    if (!model.priced) continue;
    const breakdown = report.byModel[model.modelId];
    const first = !costedModels.has(model.modelId);
    costedModels.add(model.modelId);
    model.costUsd = first && breakdown ? reportCostUsd(breakdown) : 0;
    const pricingSource = breakdown ? PRICING_SOURCE[breakdown.costSource] : undefined;
    if (pricingSource) model.pricingSource = pricingSource;
  }

  const harnesses = [...new Set(report.summaries.map((summary) => summary.harness))];
  const reason = attributionReason(report);
  return {
    totalCostUsd: reportCostUsd(report),
    models,
    sessionCount: sessionIds.size,
    turnCount: report.turnCount,
    status: 'success',
    pricingUsed,
    byHarness: reportByHarness(report),
    attribution: {
      source: harnesses.length === 1 ? ATTRIBUTION_SOURCE[harnesses[0]] ?? 'claude' : 'multi',
      coverage: report.coverage.status,
      ...(reason ? { reason } : {}),
      sessions: sessionIds.size,
      turns: report.turnCount,
      pricedSessions: pricedSegments,
      unpricedSessions: unpricedSegments,
      models: [...attributionModels.values()],
    },
  };
}
