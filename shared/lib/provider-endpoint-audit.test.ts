import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskCostTracker } from '@hokusai/costs';
import { auditProviderEndpoints } from './provider-endpoint-audit.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import type { EvalRecord } from './eval-schema.ts';

const registry = getEffectiveRegistry();
function evalRow(id: string, event: string, charge: number): EvalRecord {
  const tracker = createTaskCostTracker({ taskId: 'audit-fixture' });
  tracker.recordUsage({ eventId: event, sessionId: event, harness: 'native', model: 'kimi-k3', providerCostUsd: charge,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningTokens: 0 } });
  return { id, issueId: 'fixture-task', timestamp: '2026-11-16T00:00:00Z', taskCostSummary: [...tracker.summary().summaries] } as EvalRecord;
}
const catalogs = [{ model: 'kimi-k3', endpoints: ['moonshotai', 'cheaper'].map((tag, i) => ({ tag, provider_name: tag,
  pricing: { prompt: i ? '0.000001' : '0.000002', completion: i ? '0.000002' : '0.000004', input_cache_read: i ? '0.0000001' : '0.0000002' } })) }];

test('audit retains distinct attempts for a task and excludes overlapping SDK evidence', () => {
  const a = evalRow('eval-a', 'event-a', 2); const b = evalRow('eval-b', 'event-b', 3);
  const report = auditProviderEndpoints([a, b, { ...a, id: 'duplicate-eval' }], registry, catalogs);
  const kimi = report.models.find(row => row.model === 'kimi-k3')!;
  assert.equal(kimi.measuredSdkReport.totalUsd, 5);
  assert.equal(kimi.tasks, 1);
  assert.equal(report.exclusions.filter(row => row.reason === 'overlapping-sdk-events').length, 1);
  assert.equal(kimi.endpoints[0].tag, 'cheaper');
  assert.ok(kimi.potentialSavingsUsd! > 0);
  assert.equal(kimi.endpoints[0].historicalMixEstimateUsd! * 2, kimi.endpoints[1].historicalMixEstimateUsd);
});

test('missing cache prices are unknown, and explicit references never assert historical execution', () => {
  const noCache = structuredClone(catalogs);
  delete noCache[0].endpoints[1].pricing.input_cache_read;
  const report = auditProviderEndpoints([evalRow('eval-a', 'event-a', 2)], registry, noCache, { 'kimi-k3': 'cheaper' });
  const kimi = report.models[0];
  assert.equal(kimi.referenceSource, 'operator-comparison-reference');
  assert.equal(kimi.potentialSavingsUsd, null);
  assert.equal(kimi.endpoints.find(row => row.tag === 'cheaper')!.historicalMixEstimateUsd, null);
  assert.equal(kimi.endpoints.find(row => row.tag === 'cheaper')!.unavailableReason, 'missing-cache-read-rate');
  assert.ok(report.unmeasuredModels.some(row => row.model === 'glm-5.3-flash'));
});
