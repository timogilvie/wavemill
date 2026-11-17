/** Read-only endpoint opportunity audit. SDK summaries and pricing remain authoritative. */
import type { EvalRecord } from './eval-schema.ts';
import { getOpenRouterRouting, resolveModelRegistryKey, type ModelRegistry } from './model-registry.ts';
import { normalizeOpenRouterPricing, type OpenRouterEndpoint } from './openrouter-catalog.ts';
import { reportFromStoredSummaries } from './sdk-task-cost/recompute.ts';
import { priceUsageUsd } from './sdk-task-cost/price-overrides.ts';
import { endpointRates } from './native-agent/certification/endpoint-comparison.ts';
import { validateTaskCostSummaryV1 } from './sdk-task-cost/contract.ts';
import type { TaskCostSummaryV1 } from './sdk-task-cost/contract.ts';

export interface EndpointAuditCatalog { model: string; capturedAt?: string; wire?: string; endpoints?: OpenRouterEndpoint[]; error?: string }

export function auditProviderEndpoints(records: EvalRecord[], registry: ModelRegistry, catalogs: EndpointAuditCatalog[], references: Record<string, string> = {}) {
  const latest = new Map<string, EvalRecord>();
  for (const record of records) {
    if (!record.issueId) continue;
    const previous = latest.get(record.id);
    if (!previous || record.timestamp > previous.timestamp) latest.set(record.id, record);
  }
  const exclusions: Array<{ issueId: string; harness?: string; reason: string }> = [];
  const seen = new Set<string>();
  const groups = new Map<string, { summaries: TaskCostSummaryV1[]; tasks: Set<string>; harnesses: Set<string> }>();
  for (const record of [...latest.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp))) {
    if (!record.taskCostSummary?.length) exclusions.push({ issueId: record.issueId!, reason: 'no-sdk-summary' });
    for (const summary of record.taskCostSummary ?? []) {
      try { validateTaskCostSummaryV1(summary); } catch { exclusions.push({ issueId: record.issueId!, reason: 'invalid-sdk-summary' }); continue; }
      const ids = summary.event_ids?.map(id => `${summary.harness}:${id}`) ?? [];
      if (!ids.length || ids.some(id => seen.has(id))) {
        exclusions.push({ issueId: record.issueId!, harness: summary.harness, reason: ids.length ? 'overlapping-sdk-events' : 'missing-sdk-event-identities' });
        continue;
      }
      ids.forEach(id => seen.add(id));
      for (const segment of summary.model_segments) {
        const model = resolveModelRegistryKey(registry, segment.model);
        const group = groups.get(model) ?? { summaries: [], tasks: new Set(), harnesses: new Set() };
        // Reuse the SDK replay over this observed model segment; never calculate token prices here.
        group.summaries.push({ ...summary, model_segments: [segment] });
        group.tasks.add(record.issueId!);
        group.harnesses.add(summary.harness);
        groups.set(model, group);
      }
    }
  }
  const models = [...groups].map(([model, group]) => {
    const report = reportFromStoredSummaries('endpoint-audit', group.summaries);
    const segments = group.summaries.flatMap(summary => summary.model_segments);
    const catalog = catalogs.find(catalog => catalog.model === model);
    const routing = getOpenRouterRouting(registry, model);
    const endpoints = (catalog?.endpoints ?? []).map(endpoint => {
      const { pricing } = normalizeOpenRouterPricing(endpoint.pricing);
      let estimate: number | null = null;
      let reason: string | undefined;
      try {
        const rates = endpointRates(endpoint);
        const estimates = segments.map(segment => {
          const u = segment.usage;
          if ((u.cache_read_tokens ?? 0) > 0 && pricing.cacheReadPerMTok === null) throw new Error('missing-cache-read-rate');
          if ((u.cache_write_tokens ?? 0) > 0 && pricing.cacheWritePerMTok === null) throw new Error('missing-cache-write-rate');
          if (u.input_tokens === null || u.output_tokens === null || u.cache_read_tokens === null || u.cache_write_tokens === null) throw new Error('incomplete-usage');
          return priceUsageUsd(rates, { inputTokens: u.input_tokens, outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_tokens, cacheCreationTokens: u.cache_write_tokens });
        });
        if (estimates.some(value => value === null)) throw new Error('unpriced-usage');
        // SDK combines already-priced estimates; no private dollar accumulator.
        const priced = group.summaries.map((summary, i) => ({ ...summary, model_segments: summary.model_segments.map(segment => ({ ...segment,
          actual_cost_usd: null, estimated_cost_usd: estimates[i]!, cost_source: 'local_estimate' as const })) }));
        estimate = reportFromStoredSummaries('endpoint-counterfactual', priced).totalUsd;
      } catch (error) { reason = (error as Error).message; }
      return { tag: endpoint.tag, providerName: endpoint.provider_name, quantization: endpoint.quantization ?? null,
        historicalMixEstimateUsd: estimate, ...(reason ? { unavailableReason: reason } : {}) };
    }).sort((a, b) => (a.historicalMixEstimateUsd ?? Infinity) - (b.historicalMixEstimateUsd ?? Infinity));
    const baselineTag = references[model] ?? routing?.only?.[0] ?? routing?.order?.[0];
    const baseline = baselineTag ? endpoints.find(endpoint => endpoint.tag === baselineTag) : undefined;
    const cheapest = endpoints.find(endpoint => endpoint.historicalMixEstimateUsd !== null);
    return { model, nativeProvider: registry.models[model]?.nativeCapability?.nativeProvider ?? null,
      tasks: group.tasks.size, harnesses: [...group.harnesses].sort(), measuredSdkReport: report,
      currentRouting: routing ?? null, catalogCapturedAt: catalog?.capturedAt ?? null, catalogError: catalog?.error ?? null,
      endpoints, referenceTag: baselineTag ?? null, referenceSource: references[model] ? 'operator-comparison-reference' : 'configured-restriction',
      potentialSavingsUsd: baseline?.historicalMixEstimateUsd != null && cheapest?.historicalMixEstimateUsd != null
        ? baseline.historicalMixEstimateUsd - cheapest.historicalMixEstimateUsd : null };
  }).sort((a, b) => (b.potentialSavingsUsd ?? -1) - (a.potentialSavingsUsd ?? -1) || (b.measuredSdkReport.totalUsd ?? -1) - (a.measuredSdkReport.totalUsd ?? -1));
  return { schemaVersion: 'provider-endpoint-audit/v1', unmeasuredModels: Object.entries(registry.models).filter(([model, value]) => value.nativeCapability?.nativeProvider === 'openrouter' && !groups.has(model)).map(([model]) => ({ model, catalogEndpoints: catalogs.find(catalog => catalog.model === model)?.endpoints?.length ?? null, reason: 'no-retained-sdk-segments' })), inputRecords: records.length, evaluatedTasks: new Set([...latest.values()].map(record => record.issueId)).size, exclusions, models,
    limitations: ['Evaluated task cohort, not account billing or all failed/running attempts.',
      'Latest row per eval ID retains distinct attempts; overlapping SDK summaries are excluded whole, not apportioned.',
      'Historical token/cache mix held fixed; new-host cache hits, tokenization, success and latency are unproven.',
      'Missing endpoint cache rates or incomplete usage prevent a counterfactual estimate.',
      'Catalog availability and prices do not qualify an endpoint. Model/executor routing is unchanged.'] };
}
