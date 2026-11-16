import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonPlan, comparisonRequiredPairs, endpointComparisonReport } from './endpoint-comparison.ts';
const entries = ['reference', 'alternative'].map(tag => ({ tag, provider_name: tag, pricing: { prompt: '0.000001', completion: '0.000002' }, quantization: null }));
const policy = { maxSpendUsd: 25, maxCompletionRegression: .05, confidence: .95 as const, maxP95LatencyRatio: 2 };
test('sample size derives from the declared reliability margin, and a pilot cannot claim promotion', () => {
  assert.equal(comparisonRequiredPairs(.05), 73);
  assert.ok(comparisonRequiredPairs(.02) > comparisonRequiredPairs(.05));
  const plan = comparisonPlan(entries, 'reference', policy);
  assert.ok(plan.runs.length * plan.reservePerRunUsd <= policy.maxSpendUsd);
  assert.equal(plan.runs[0].profile, 'standard');
  assert.ok(endpointComparisonReport(plan, []).subjects.every(subject => subject.promotionVerdict === 'insufficient-evidence'));
  assert.throws(() => comparisonPlan(entries, 'missing', policy));
  assert.throws(() => comparisonRequiredPairs(0));
});

test('captured pilot replay preserves failures and treats missing billing as an estimate, never a billed zero', async () => {
  // allow-source-text-assertion: sanitized captured JSON data, never implementation source.
  const { readFileSync } = await import('node:fs');
  const { reconcileEndpointComparisonEconomics } = await import('./endpoint-comparison.ts');
  const { getEffectiveRegistry } = await import('../../model-registry.ts');
  const base = new URL('../../../../docs/experiments/hok3496/', import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL('catalog.json', base), 'utf8'));
  const runs = readFileSync(new URL('original-runs.jsonl', base), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const original = JSON.stringify(runs);
  const replayed = await reconcileEndpointComparisonEconomics(runs, catalog.endpoints, getEffectiveRegistry());
  assert.equal(JSON.stringify(runs), original, 'historical evidence is immutable');
  const plan = comparisonPlan(catalog.endpoints.filter((entry: { tag: string }) => ['moonshotai', 'wafer', 'relace/fp4'].includes(entry.tag)), 'moonshotai', policy);
  const report = endpointComparisonReport(plan, replayed);
  const relace = report.subjects.find(subject => subject.endpoint.tag === 'relace/fp4')!;
  assert.equal(relace.sdkReport.actualUsd, null);
  assert.equal(relace.sdkReport.estimatedUsd, 0.007529);
  assert.equal(relace.promotionVerdict, 'insufficient-evidence');
  assert.equal(report.subjects.find(subject => subject.endpoint.tag === 'moonshotai')!.compatibility, 'fail');
  assert.ok(report.subjects.every(subject => subject.promotionVerdict !== 'qualified'));
});
