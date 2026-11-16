import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonPlan, comparisonRequiredPairs, endpointComparisonReport } from './endpoint-comparison.ts';
const entries = ['reference', 'alternative'].map(tag => ({ tag, provider_name: tag, pricing: { prompt: '0.000001', completion: '0.000002' }, quantization: null }));
const policy = { maxSpendUsd: 25, maxCompletionRegression: .05, confidence: .95 as const, maxP95LatencyRatio: 2 };
test('sample size derives from the declared reliability margin, and a pilot cannot claim promotion', () => {
  assert.equal(comparisonRequiredPairs(.05), 73);
  assert.ok(comparisonRequiredPairs(.02) > comparisonRequiredPairs(.05));
  const plan = comparisonPlan(entries, 'reference', policy);
  assert.equal(plan.plannedRunCount, 2 + 73 * 2 * 2);
  assert.equal(plan.runs.length, 2, 'only compatibility runs are expanded eagerly');
  assert.equal(plan.admission, 'sdk-accounted-spend-plus-next-run-reserve/v1');
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

test('SDK-accounted admission can complete a full low-cost study and stops before an unaffordable reserve', async () => {
  const { readFileSync } = await import('node:fs');
  const { runEndpointComparison, comparisonSchedule } = await import('./endpoint-comparison.ts');
  const { getEffectiveRegistry } = await import('../../model-registry.ts');
  const base = new URL('../../../../docs/experiments/hok3496/', import.meta.url);
  const fixture = readFileSync(new URL('original-runs.jsonl', base), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(run => run.endpoint.tag === 'wafer').result;
  const plan = comparisonPlan(entries, 'reference', policy);
  const schedule = [...comparisonSchedule(plan)];
  assert.equal(schedule.length, 294);
  assert.equal(schedule.find(run => run.pair === 1)!.endpoint.tag, 'alternative', 'pair order is preregistered and rotates');
  const run = (maxSpendUsd: number, missingAccounting = false) => runEndpointComparison({ repoDir: process.cwd(), model: 'kimi-k3', registry: getEffectiveRegistry(), entries,
    plan: comparisonPlan(entries, 'reference', { ...policy, maxSpendUsd }), onRun() {},
    runConformance: (async () => ({ harnessPassed: true, results: [] })) as never,
    runCanary: (async () => ({ ...structuredClone(fixture), isLive: false, ...(missingAccounting ? { attemptEvidence: [] } : {}) })) as never });
  const full = await run(25);
  assert.equal(full.length, 294);
  assert.equal(endpointComparisonReport(plan, full).subjects[1].pairedSamples, 73);
  assert.equal(endpointComparisonReport(plan, full).subjects[1].promotionVerdict, 'insufficient-evidence', 'injected runs never grant promotion');
  assert.equal((await run(1)).length, 1, 'past spend plus the next full reserve must fit');
  assert.equal((await run(25, true)).length, 1, 'missing accounting stops probing');
});
