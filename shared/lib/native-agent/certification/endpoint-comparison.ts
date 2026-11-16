import { validateContributionRow } from '@hokusai/core';
import { measureProviderExecutionEvidence } from '../../sdk-task-cost/measure.ts';
import { buildHostPriceOverrides } from '../../sdk-task-cost/price-overrides.ts';
import { resolveModelRegistryKey } from '../../model-registry.ts';
import { writeGlobalCertification } from './store.ts';
import { CERTIFICATION_SCHEMA_VERSION } from './schema.ts';
import { toArtifactScenario } from './scenario-runner.ts';
/** Fixed-model paired endpoint qualification; never selects a production provider. */
import type { ModelRegistry } from '../../model-registry.ts';
import { normalizeOpenRouterPricing, type OpenRouterEndpoint } from '../../openrouter-catalog.ts';
import { wilsonInterval } from '../../stats-utils.ts';
import { reportFromStoredSummaries } from '../../sdk-task-cost/recompute.ts';
import { resolveCertificationSubject, endpointIdentity } from './identity.ts';
import { runLiveCodingCanary, DEFAULT_CANARY_LIMITS, DEFAULT_CANARY_MAX_ATTEMPTS } from './live-coding-canary.ts';
import { getDefaultScenarios, DEFAULT_CERTIFICATION_SUITE_VERSION } from './scenarios.ts';
import { runScenarios } from './scenario-runner.ts';
import type { CertificationEndpoint, LiveCodingCanaryResult } from './schema.ts';

export interface EndpointComparisonPolicy {
  maxSpendUsd: number;
  maxCompletionRegression: number;
  confidence: 0.95;
  maxP95LatencyRatio: number;
}
export interface EndpointComparisonRun {
  pair: number;
  profile: 'standard' | 'workflow' | 'cache-heavy';
  endpoint: CertificationEndpoint;
  result: LiveCodingCanaryResult;
}
export function comparisonRequiredPairs(margin: number): number {
  if (!(margin > 0 && margin < 1)) throw new Error('Completion regression must be between zero and one');
  // Invert the existing Wilson bound by monotone search, without a second CI formula.
  let low = 1;
  let high = 1;
  while (wilsonInterval(0, high).hi! > margin) {
    high *= 2;
    if (!Number.isSafeInteger(high)) throw new Error('Required sample size exceeds exact integer capacity');
  }
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (wilsonInterval(0, mid).hi! <= margin) high = mid;
    else low = mid + 1;
  }
  return high;
}
export function endpointFromCatalog(entry: OpenRouterEndpoint): CertificationEndpoint {
  if (!entry.tag || !entry.provider_name) throw new Error('Catalog endpoint lacks exact tag or provider name');
  return { tag: entry.tag, providerName: entry.provider_name, quantization: entry.quantization ?? null, deploymentRevision: null };
}
export function endpointRates(entry: OpenRouterEndpoint) {
  const { pricing, invalid } = normalizeOpenRouterPricing(entry.pricing);
  if (invalid.length || pricing.inputPerMTok === null || pricing.outputPerMTok === null) throw new Error('Endpoint estimate requires valid input and output rates');
  return { inputCostPerMTok: pricing.inputPerMTok, outputCostPerMTok: pricing.outputPerMTok,
    ...(pricing.cacheReadPerMTok !== null ? { cacheReadCostPerMTok: pricing.cacheReadPerMTok } : {}),
    ...(pricing.cacheWritePerMTok !== null ? { cacheWriteCostPerMTok: pricing.cacheWritePerMTok } : {}) };
}
export function comparisonPlan(entries: OpenRouterEndpoint[], referenceTag: string, policy: EndpointComparisonPolicy) {
  if (policy.confidence !== 0.95 || !(policy.maxSpendUsd > 0) || !Number.isFinite(policy.maxSpendUsd) || !(policy.maxP95LatencyRatio > 0)) throw new Error('Invalid comparison policy');
  const subjects = entries.map(endpointFromCatalog);
  for (const entry of entries) endpointRates(entry);
  if (!subjects.some(subject => subject.tag === referenceTag) || new Set(subjects.map(subject => subject.tag)).size !== subjects.length || subjects.length < 2) throw new Error('Comparison needs distinct discovered endpoints including its reference');
  const requiredPairs = comparisonRequiredPairs(policy.maxCompletionRegression);
  const profiles = ['workflow', 'cache-heavy'] as const;
  const planned: Array<{ pair: number; profile: EndpointComparisonRun['profile']; endpoint: CertificationEndpoint }> = subjects.map(endpoint => ({ pair: -1, profile: 'standard', endpoint }));
  const reservePerRunUsd = DEFAULT_CANARY_LIMITS.maxCostUsd! * DEFAULT_CANARY_MAX_ATTEMPTS;
  // Preregister the full order. Admission uses the SDK's accounted spend and
  // reserves the next bounded run, rather than treating every past run as $1.
  // Reserve every allowed outer canary attempt at the existing per-attempt cap.
  // This is experiment admission, not a new task-wide spend/retry mechanism.
  return { schemaVersion: 'endpoint-comparison-plan/v2', policy, referenceTag, subjects, requiredPairs, profiles,
    reservePerRunUsd, admission: 'sdk-accounted-spend-plus-next-run-reserve/v1', runs: planned,
    schedule: 'compatibility-first; pair-ascending; profile-order; endpoint-index=(index+pair)%subject-count',
    stoppingRules: ['Missing accounting or an unaffordable next-run reserve stops the study.', 'A non-passing reference compatibility run stops paired testing.', 'A definitive candidate failure rejects it; subsequent candidate probes are skipped. All prior outcomes remain.'],
    plannedRunCount: subjects.length + requiredPairs * profiles.length * subjects.length,
    qualificationScope: 'exact requested tag with observed host; deployment/quantization not independently attested' };
}
/** Lazy expansion of the immutable order: even a stringent margin cannot allocate an enormous plan. */
export function* comparisonSchedule(plan: ReturnType<typeof comparisonPlan>) {
  yield* plan.runs;
  for (let pair = 0; pair < plan.requiredPairs; pair++) for (const profile of plan.profiles) {
    for (let index = 0; index < plan.subjects.length; index++) yield { pair, profile, endpoint: plan.subjects[(index + pair) % plan.subjects.length]! };
  }
}
export async function runEndpointComparison(options: {
  repoDir: string; model: string; registry: ModelRegistry; entries: OpenRouterEndpoint[];
  plan: ReturnType<typeof comparisonPlan>;
  certificationRoot?: string;
  onRun: (run: EndpointComparisonRun) => void | Promise<void>;
  runCanary?: typeof runLiveCodingCanary;
  runConformance?: typeof runScenarios;
}): Promise<EndpointComparisonRun[]> {
  const { plan } = options;
  const conformance = await (options.runConformance ?? runScenarios)({ provider: 'openrouter', model: options.model,
    transport: 'openai-completions', registry: options.registry, scenarios: getDefaultScenarios(true), dryRun: true });
  if (!conformance.harnessPassed) throw new Error('Deterministic conformance failed; live comparison refused');
  const results: EndpointComparisonRun[] = [];
  for (const scheduled of comparisonSchedule(plan)) {
    const accounted = economics(results);
    if (results.length && (accounted.attempts !== accounted.accountedAttempts || accounted.report.totalUsd === null)) break;
    if ((accounted.report.totalUsd ?? 0) + plan.reservePerRunUsd > plan.policy.maxSpendUsd) break;
    if (scheduled.profile !== 'standard') {
      if (results.some(run => run.profile === 'standard' && run.endpoint.tag === plan.referenceTag && run.result.status !== 'pass')) break;
      if (plan.subjects.filter(endpoint => endpoint.tag !== plan.referenceTag).every(endpoint =>
        results.some(run => run.endpoint.tag === endpoint.tag && ((run.profile === 'standard' && run.result.status !== 'pass') || run.result.status === 'fail')))) break;
      if (results.some(run => run.profile === 'standard' && run.endpoint.tag === scheduled.endpoint.tag && run.result.status !== 'pass')) continue;
      if (scheduled.endpoint.tag !== plan.referenceTag && results.some(run => run.endpoint.tag === scheduled.endpoint.tag && run.result.status === 'fail')) continue;
    }
    const entry = options.entries.find(candidate => candidate.tag === scheduled.endpoint.tag)!;
    const subject = resolveCertificationSubject({ provider: 'openrouter', model: options.model, registry: options.registry, endpoint: scheduled.endpoint }).subject;
    const result = await (options.runCanary ?? runLiveCodingCanary)({ provider: 'openrouter', registryModelId: options.model, subject,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION, registry: options.registry, repoDir: options.repoDir,
      endpointPricing: endpointRates(entry), profile: scheduled.profile, maxAttempts: DEFAULT_CANARY_MAX_ATTEMPTS, limits: DEFAULT_CANARY_LIMITS });
    const run = { ...scheduled, result };
    results.push(run);
    await options.onRun(run);
    if (options.certificationRoot) {
      const history = results.filter(candidate => candidate.endpoint.tag === scheduled.endpoint.tag);
      const authoritative = history.find(candidate => candidate.result.status === 'fail')?.result ?? result;
      const resolved = resolveCertificationSubject({ provider: 'openrouter', model: options.model, registry: options.registry, endpoint: scheduled.endpoint });
      writeGlobalCertification({ schemaVersion: CERTIFICATION_SCHEMA_VERSION, subject, ...resolved.storageIdentity,
        phase: 'workflow', suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION, certifiedAt: new Date().toISOString(),
        scenarios: conformance.results.filter(result => result.status !== 'not-run').map(toArtifactScenario),
        liveCanary: authoritative, knownLimitations: ['Endpoint tag was requested with fallback disabled; observed host does not independently verify deployment or quantization.'] }, { root: options.certificationRoot });
    }
    // Missing accounting never means free probing. Stop rather than spending blind.
    if (result.attemptEvidence?.some(attempt => !attempt.contribution) || !result.attemptEvidence?.length) break;
  }
  return results;
}
function economics(runs: EndpointComparisonRun[]) {
  const contributions = runs.flatMap(run => run.result.attemptEvidence?.flatMap(attempt => attempt.contribution ? [attempt.contribution] : []) ?? []);
  const summaries = contributions.flatMap(row => row.stage_executions.map(stage => stage.task_cost));
  const report = reportFromStoredSummaries('endpoint-comparison', summaries);
  return { report, contributions, accountedAttempts: contributions.length,
    attempts: runs.reduce((count, run) => count + (run.result.attempts ?? 0), 0) };
}
function p95(values: number[]) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]! : null; }
export function endpointComparisonReport(plan: ReturnType<typeof comparisonPlan>, runs: EndpointComparisonRun[]) {
  const total = economics(runs);
  return { schemaVersion: 'endpoint-comparison-report/v1', plan, runs, economics: { sdkReport: total.report, accountedAttempts: total.accountedAttempts, attempts: total.attempts },
    subjects: plan.subjects.map(endpoint => {
      const subjectRuns = runs.filter(run => endpointIdentity(run.endpoint) === endpointIdentity(endpoint));
      const paired = subjectRuns.filter(run => run.profile !== 'standard').flatMap(candidate => {
        const reference = runs.find(run => run.endpoint.tag === plan.referenceTag && run.pair === candidate.pair && run.profile === candidate.profile);
        return reference ? [{ candidate, reference }] : [];
      });
      const completePairs = [...new Set(paired.map(pair => pair.candidate.pair))].flatMap(index => {
        const members = paired.filter(pair => pair.candidate.pair === index);
        return members.length === plan.profiles.length ? [{ lost: members.some(pair => pair.reference.result.status === 'pass' && pair.candidate.result.status !== 'pass') }] : [];
      });
      const losses = completePairs.filter(pair => pair.lost).length;
      const lossInterval = wilsonInterval(losses, completePairs.length);
      const latency = p95(subjectRuns.flatMap(run => run.result.usage ? [run.result.usage.wallClockMs] : []));
      const referenceLatency = p95(runs.filter(run => run.endpoint.tag === plan.referenceTag).flatMap(run => run.result.usage ? [run.result.usage.wallClockMs] : []));
      const cost = economics(subjectRuns);
      const successes = subjectRuns.filter(run => run.result.status === 'pass').length;
      const observations = cost.contributions.flatMap(row => row.stage_executions.flatMap(stage => stage.provider_executions ?? []));
      const charged = observations.filter(row => row.generation?.totalCostUsd !== null && row.generation?.totalCostUsd !== undefined).length;
      const cache = observations.map(row => ({ input: row.usage?.input_tokens ?? null, cacheRead: row.usage?.cache_read_tokens ?? null, output: row.usage?.output_tokens ?? null }));
      const compatibility = subjectRuns.find(run => run.profile === 'standard')?.result;
      const evidenceComplete = cost.attempts === cost.accountedAttempts && observations.length > 0 && charged === observations.length;
      const enough = completePairs.length >= plan.requiredPairs;
      const reliable = lossInterval.hi !== null && lossInterval.hi <= plan.policy.maxCompletionRegression;
      const latencyPass = latency !== null && referenceLatency !== null && latency <= referenceLatency * plan.policy.maxP95LatencyRatio;
      return { endpoint, compatibility: compatibility?.status ?? 'not-run', pairedSamples: completePairs.length, losses, lossInterval,
        p95LatencyMs: latency, referenceP95LatencyMs: referenceLatency, sdkReport: cost.report,
        spendPerSuccessfulRunUsd: successes && cost.report.totalUsd !== null ? cost.report.totalUsd / successes : null,
        exactChargeCoverage: observations.length ? charged / observations.length : null, cacheMix: cache,
        promotionVerdict: subjectRuns.some(run => run.result.status === 'fail') ? 'rejected' : compatibility?.isLive && compatibility.status === 'pass' && enough && reliable && latencyPass && evidenceComplete ? 'qualified' : 'insufficient-evidence' };
    }) };
}

/** Replay a retained experiment through the existing SDK after an accounting fix; never mutate history. */
export async function reconcileEndpointComparisonEconomics(runs: readonly EndpointComparisonRun[], entries: readonly OpenRouterEndpoint[], registry: ModelRegistry) {
  const replayed = structuredClone(runs) as EndpointComparisonRun[];
  for (const run of replayed) {
    const entry = entries.find(entry => entry.tag === run.endpoint.tag);
    if (!entry) throw new Error('Reconciliation requires the original captured endpoint catalog');
    for (const attempt of run.result.attemptEvidence ?? []) {
      const row = attempt.contribution;
      if (!row) continue;
      row.harness = 'wavemill-certification';
      const observations = row.stage_executions.flatMap(stage => stage.provider_executions ?? []);
      const report = await measureProviderExecutionEvidence({ taskId: row.task_id!, observations, collectedAt: row.observed_at,
        priceOverrides: buildHostPriceOverrides({ [run.result.providerNativeId]: endpointRates(entry), [run.result.model]: endpointRates(entry), [observations[0]?.requestedModel ?? 'unknown']: endpointRates(entry) }),
        registryLookup: model => resolveModelRegistryKey(registry, model) });
      if (report.summaries.length === 1 && row.stage_executions.length === 1) {
        row.stage_executions[0]!.task_cost = report.summaries[0]!;
        row.actual_cost_usd = report.totalUsd ?? undefined;
        validateContributionRow(row);
      }
    }
  }
  return replayed;
}
