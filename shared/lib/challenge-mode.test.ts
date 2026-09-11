import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowRouteDecision } from './workflow-router.ts';
import {
  buildChallengeExecutionIntent,
  canRunChallenge,
  chooseChallengeStage,
  chooseDistinctChallengerModel,
  decideChallengeLaunch,
  extractChallengeRecommendation,
  routeChangedMaterially,
  deriveChallengeBranch,
  deriveChallengeSlug,
  deriveChallengerKey,
  filterDeepSeekChallengeModels,
  getChallengeModelPool,
  pickChallengeWorkflowsWithContext,
  pickChallengeWorkflowsWithContextAndReason,
  pickChallengeModels,
  pickChallengeModelsWithReason,
  pickChallengeWorkflows,
  pickChallengeWorkflowsWithReason,
  variedModelForStage,
} from './challenge-mode.ts';
import { listVariedRoutingDimensions, routingMetaFromChallengeEntry } from './challenge-comparison.ts';
import { projectChallengeIntentForPersistence } from './challenge-execution-contract.ts';
import { resolveOpenRouterModelId } from './openrouter-provider.ts';
import type { RouteArtifactSnapshot } from './route-artifact.ts';
import { CERTIFICATION_SCHEMA_VERSION, type CertificationSubject } from './native-agent/certification/schema.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import {
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  buildGlobalCertificationPath,
  resolveCertificationStorageIdentity,
  resolveCertificationSubject,
} from './native-agent/certification/index.ts';
import { clearConfigCache } from './config.ts';
import { listEffectiveModelsForStage } from './effective-models.ts';
import { computeIdentityFingerprint, getEffectiveRegistry } from './model-registry.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from './native-agent/coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from './native-agent/smoke.ts';
import { evaluateNativeProviderGate } from './native-agent/certification/eligibility-gate.ts';

let passed = 0;
let failed = 0;
// Some early native challenge fixtures are evaluated with wall-clock time.
const RUNTIME_FRESH_CERTIFIED_AT = new Date().toISOString();

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

console.log('\n--- Challenge Mode Tests ---\n');

test('challenge model pool ignores explicit repo-local challenge.models', () => {
  const pool = getChallengeModelPool(
    { models: ['claude-opus-4-6', 'gpt-5.6-terra', 'claude-opus-4-6'] },
    { models: ['claude-sonnet-4-5-20250929'] },
  );
  assert.ok(pool.includes('qwen-3-coder'));
  assert.ok(pool.includes('glm-5.2'));
  assert.ok(pool.includes('kimi-k2.7-code'));
});

test('challenge model pool keeps global promoted OpenRouter aliases', () => {
  const pool = getChallengeModelPool(
    { models: ['glm-5.2', 'kimi-k2.7-code', 'glm-5.2'] },
    { models: ['claude-sonnet-4-5-20250929'] },
  );
  assert.ok(pool.includes('glm-5.2'));
  assert.ok(pool.includes('kimi-k2.7-code'));
});

test('challenge model pool ignores router models when challenge.models is null', () => {
  const pool = getChallengeModelPool(
    { models: null },
    { models: ['claude-sonnet-4-5-20250929', 'gpt-5.6-terra'] },
  );
  assert.ok(pool.includes('qwen-3-coder'));
  assert.ok(pool.includes('claude-opus-4-6'));
});

test('challenge model pool excludes disabled models from the global pool', () => {
  const pool = getChallengeModelPool(
    { models: ['claude-opus-4-6', 'gpt-5.3-codex'] },
    { models: [] },
  );
  assert.ok(pool.includes('claude-opus-4-6'));
  assert.ok(!pool.includes('gpt-5.3-codex'));
  assert.ok(!pool.includes('llama-4-scout'));
});

test('challenge model pool excludes DeepSeek by default', () => {
  const pool = getChallengeModelPool(
    { models: ['deepseek-v4-flash', 'claude-opus-4-6', 'deepseek-v4-pro'] },
    { models: ['gpt-5.6-terra'] },
  );
  assert.ok(pool.includes('claude-opus-4-6'));
  assert.ok(!pool.some((model) => model.includes('deepseek')));
});

test('challenge model pool includes DeepSeek when allowDeepseek is enabled', () => {
  const pool = getChallengeModelPool(
    { allowDeepseek: true, models: ['deepseek-v4-flash', 'claude-opus-4-6', 'deepseek-v4-flash'] },
    { models: ['gpt-5.6-terra'] },
  );
  assert.ok(pool.includes('deepseek-v4-flash'));
  assert.ok(pool.includes('claude-opus-4-6'));
});

test('filterDeepSeekChallengeModels returns a clear rationale when it removes candidates', () => {
  const filtered = filterDeepSeekChallengeModels(
    ['deepseek-v4-flash', 'claude-deepseek', 'claude-opus-4-6', ''],
    {},
  );
  assert.deepEqual(filtered.models, ['claude-opus-4-6']);
  assert.deepEqual(filtered.warnings, ['DeepSeek excluded: challenge.allowDeepseek is not enabled']);
});

test('canRunChallenge requires at least two distinct models', () => {
  assert.equal(canRunChallenge(['claude-opus-4-6']), false);
  assert.equal(canRunChallenge(['claude-opus-4-6', 'claude-opus-4-6', 'gpt-5.6-terra']), true);
});

test('derive challenge identifiers and branches', () => {
  assert.equal(deriveChallengerKey('HOK-970'), 'HOK-970_c');
  assert.equal(deriveChallengeSlug('feature-name', 'primary'), 'feature-name');
  assert.equal(deriveChallengeSlug('feature-name', 'challenger'), 'feature-name-challenger');
  assert.equal(deriveChallengeBranch('feature-name', 'primary'), 'task/feature-name');
  assert.equal(deriveChallengeBranch('feature-name', 'challenger'), 'task/feature-name-challenger');
});

test('chooseDistinctChallengerModel skips the primary model', () => {
  const challenger = chooseDistinctChallengerModel(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    'claude-opus-4-6',
    () => 0,
  );
  assert.equal(challenger, 'claude-sonnet-4-5-20250929');
});

test('pickChallengeModels uses the router-selected primary model', () => {
  const pair = pickChallengeModels(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-970',
      issueId: 'HOK-970',
      slug: 'challenge-mode',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.6-terra': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0.9,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.primary.agent, 'claude');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
  assert.equal(pair!.challenger.agent, 'codex');
  assert.equal(pair!.challenger.key, 'HOK-970_c');
});

test('pickChallengeModels allows a router-selected primary model outside the configured pool', () => {
  const pair = pickChallengeModels(
    ['claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-971',
      issueId: 'HOK-971',
      slug: 'external-primary',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.6-terra': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
});

test('pickChallengeModels returns null when fewer than two distinct models exist', () => {
  const pair = pickChallengeModels(['claude-opus-4-6'], {
    pairId: 'HOK-970',
    issueId: 'HOK-970',
    slug: 'challenge-mode',
  });
  assert.equal(pair, null);
});

test('reason-aware model selection preserves generic selection failures', () => {
  const selection = pickChallengeModelsWithReason(['claude-opus-4-6'], {
    pairId: 'HOK-970R',
    issueId: 'HOK-970R',
    slug: 'challenge-mode-reason',
  });

  assert.equal(selection.pair, null);
  assert.equal(selection.failureReason, 'selection_failed');
});

test('repo-local all-DeepSeek pool does not remove global runnable models', () => {
  const pool = getChallengeModelPool(
    { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
    { models: [] },
  );
  assert.ok(!pool.some((model) => model.includes('deepseek')));
  assert.equal(canRunChallenge(pool), true);
  const pair = pickChallengeModels(pool, {
    pairId: 'HOK-982',
    issueId: 'HOK-982',
    slug: 'all-deepseek',
  });
  assert.ok(pair);
});

test('pickChallengeModels populates routing fields with empty strings', () => {
  const pair = pickChallengeModels(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-972',
      issueId: 'HOK-972',
      slug: 'test-routing-fields',
      primaryModel: 'claude-opus-4-6',
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.planner, '');
  assert.equal(pair!.primary.reviewer, '');
  assert.equal(pair!.primary.planDepth, '');
  assert.equal(pair!.primary.codeDepth, '');
  assert.equal(pair!.primary.reviewMode, '');
  assert.equal(pair!.challenger.planner, '');
  assert.equal(pair!.challenger.reviewer, '');
  assert.equal(pair!.challenger.planDepth, '');
  assert.equal(pair!.challenger.codeDepth, '');
  assert.equal(pair!.challenger.reviewMode, '');
});

const mockRouteFn = (): WorkflowRouteDecision => ({
  planner: 'claude-opus-4-6',
  coder: 'claude-opus-4-6',
  reviewer: 'claude-sonnet-4-5-20250929',
  planDepth: 'deep',
  codeDepth: 'medium',
  reviewRecommended: 'llm',
  expectedSuccess: 0.85,
  expectedCostPlan: 100,
  expectedCostCode: 200,
  expectedCostReview: 50,
  reasoning: [],
  signals: {},
});

function makeCoverage(
  counts: Partial<Record<'plan' | 'implementation' | 'review', Record<string, number>>>,
) {
  return (model: string, stage: 'plan' | 'implementation' | 'review') => counts[stage]?.[model] ?? 0;
}

function writePatchCodingCertification(repoDir: string, certifiedAt = RUNTIME_FRESH_CERTIFIED_AT): void {
  const certificationPath = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(certificationPath), { recursive: true });
  writeFileSync(certificationPath, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt,
    providers: [
      { provider: 'openai', model: 'native-certified', passed: true },
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
    ],
  }));
}

function writeNativeChallengeRepo(options: {
  model: string;
  provider: 'openai' | 'openrouter';
  phase: 'read-only' | 'patch' | 'workflow';
  suiteVersion?: string;
  enablePatchCoding?: boolean;
}): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-native-'));
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  const suiteVersion = options.suiteVersion ?? DEFAULT_CERTIFICATION_SUITE_VERSION;
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      ...(options.enablePatchCoding ? { patchCoding: { enabled: true } } : {}),
      providers: {
        [options.provider]: {
          enabled: true,
        },
      },
    },
    providers: {
      openrouter: {
        enabled: options.provider === 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
    },
  }));
  clearConfigCache(repoDir);
  const identity = resolveTestCertificationIdentity(repoDir, options.provider, options.model);
  const certPath = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
  );
  mkdirSync(dirname(certPath), { recursive: true });
  writeFileSync(
    certPath,
    JSON.stringify({
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      subject: identity.subject,
      provider: identity.storageIdentity.provider,
      model: identity.storageIdentity.model,
      phase: options.phase,
      suiteVersion,
      certifiedAt: RUNTIME_FRESH_CERTIFIED_AT,
      scenarios: [{ scenarioId: 'challenge.native.pass', passed: true }],
      ...(options.phase !== 'read-only'
        ? { liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: RUNTIME_FRESH_CERTIFIED_AT }) }
        : {}),
    }),
  );
  if (options.enablePatchCoding) {
    writePatchCodingCertification(repoDir);
  }
  clearConfigCache(repoDir);
  return repoDir;
}

test('pickChallengeWorkflows populates routing fields for both sides', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-973',
      issueId: 'HOK-973',
      slug: 'oauth-auth',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.6-terra': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0.9,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);

  // Both sides should have routing fields populated from mock
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.planDepth, 'deep');
  assert.equal(pair!.primary.codeDepth, 'medium');
  assert.equal(pair!.primary.reviewMode, 'llm');

  assert.equal(pair!.challenger.planner, 'claude-opus-4-6');
  assert.equal(pair!.challenger.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.planDepth, 'deep');
  assert.equal(pair!.challenger.codeDepth, 'medium');
  assert.equal(pair!.challenger.reviewMode, 'llm');
});

test('review-stage challenge preserves native OpenRouter reviewer routing', () => {
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  const repoDir = writeNativeChallengeRepo({
    model: 'qwen-3-coder',
    provider: 'openrouter',
    phase: 'read-only',
  });

  try {
    const pair = pickChallengeWorkflows(
      ['gpt-5.6-terra', 'qwen-3-coder'],
      {
        pairId: 'HOK-2512',
        issueId: 'HOK-2512',
        slug: 'native-review-stage',
        prompt: 'Review the implementation and prepare the PR.',
        primaryModel: 'gpt-5.6-terra',
        challengeStage: 'review',
        repoDir,
        routeFn: () => ({
          planner: 'gpt-5.6-terra',
          coder: 'gpt-5.6-terra',
          reviewer: 'gpt-5.6-terra',
          planDepth: 'light',
          codeDepth: 'medium',
          reviewRecommended: 'llm',
          expectedSuccess: 0.85,
          expectedCostPlan: 10,
          expectedCostCode: 20,
          expectedCostReview: 5,
          reasoning: [],
          signals: {},
        }),
      },
    );

    assert.ok(pair);
    assert.equal(pair!.challengeStage, 'review');
    assert.equal(pair!.challenger.model, 'gpt-5.6-terra');
    assert.equal(pair!.challenger.reviewer, 'qwen-3-coder');
    assert.equal(pair!.challenger.reviewerAgent, 'native-openrouter');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});

test('plan-stage challenge preserves native OpenRouter planner routing with workflow certification', () => {
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  const repoDir = writeNativeChallengeRepo({
    model: 'qwen-3-coder',
    provider: 'openrouter',
    phase: 'workflow',
  });

  try {
    const result = pickChallengeWorkflowsWithReason(
      ['gpt-5.6-terra', 'claude-opus-4-6', 'qwen-3-coder'],
      {
        pairId: 'HOK-2779-PLAN',
        issueId: 'HOK-2779-PLAN',
        slug: 'native-plan-stage',
        prompt: 'Plan the implementation.',
        primaryModel: 'gpt-5.6-terra',
        challengeStage: 'plan',
        suggestedChallengerModel: 'qwen-3-coder',
        repoDir,
        routeFn: () => ({
          planner: 'gpt-5.6-terra',
          coder: 'gpt-5.6-terra',
          reviewer: 'gpt-5.6-terra',
          planDepth: 'light',
          codeDepth: 'medium',
          reviewRecommended: 'llm',
          expectedSuccess: 0.85,
          expectedCostPlan: 10,
          expectedCostCode: 20,
          expectedCostReview: 5,
          reasoning: [],
          signals: {},
        }),
      },
    );

    assert.ok(result.pair);
    assert.equal(result.pair!.challengeStage, 'plan');
    assert.equal(result.pair!.challenger.planner, 'qwen-3-coder');
    assert.equal(result.pair!.challenger.plannerAgent, 'native-openrouter');
    const rejection = (result.nativeCertificationRejections || []).find(
      (entry) => entry.modelId === 'qwen-3-coder' && entry.role === 'planner',
    );
    assert.equal(rejection, undefined);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});

test('plan-stage challenge rejects qwen-3-coder when only patch-certified', () => {
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  const repoDir = writeNativeChallengeRepo({
    model: 'qwen-3-coder',
    provider: 'openrouter',
    phase: 'patch',
  });

  try {
    const result = pickChallengeWorkflowsWithReason(
      ['gpt-5.6-terra', 'claude-opus-4-6', 'qwen-3-coder'],
      {
        pairId: 'HOK-2779-PATCH',
        issueId: 'HOK-2779-PATCH',
        slug: 'native-plan-stage-patch',
        prompt: 'Plan the implementation.',
        primaryModel: 'gpt-5.6-terra',
        challengeStage: 'plan',
        suggestedChallengerModel: 'qwen-3-coder',
        repoDir,
        randomFn: () => 0,
        routeFn: () => ({
          planner: 'gpt-5.6-terra',
          coder: 'gpt-5.6-terra',
          reviewer: 'gpt-5.6-terra',
          planDepth: 'light',
          codeDepth: 'medium',
          reviewRecommended: 'llm',
          expectedSuccess: 0.85,
          expectedCostPlan: 10,
          expectedCostCode: 20,
          expectedCostReview: 5,
          reasoning: [],
          signals: {},
        }),
      },
    );

    assert.ok(result.pair);
    assert.notEqual(result.pair!.challenger.planner, 'qwen-3-coder');
    const rejection = (result.nativeCertificationRejections || []).find(
      (entry) => entry.modelId === 'qwen-3-coder' && entry.role === 'planner',
    );
    assert.ok(rejection);
    assert.equal(rejection!.reason, 'insufficient-phase');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});

test('implementation-stage challenge retains native models with patch-coding opt-in', () => {
  const repoDir = writeNativeChallengeRepo({
    model: 'qwen-3-coder',
    provider: 'openrouter',
    phase: 'patch',
    enablePatchCoding: true,
  });
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

  try {
    const result = pickChallengeModelsWithReason(
      ['gpt-5.6-terra', 'claude-opus-4-6', 'qwen-3-coder'],
      {
        pairId: 'HOK-2235',
        issueId: 'HOK-2235',
        slug: 'native-coding-stage',
        primaryModel: 'gpt-5.6-terra',
        suggestedChallengerModel: 'qwen-3-coder',
        repoDir,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair);
    assert.equal(result.pair!.challenger.model, 'qwen-3-coder');
    assert.equal(result.pair!.challenger.agent, 'native-openrouter');
    const rejection = (result.nativeCertificationRejections || []).find((entry) => entry.modelId === 'qwen-3-coder');
    assert.equal(rejection, undefined);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});

test('implementation-stage challenge rejects native models when repo patch-coding opt-in is absent', () => {
  const repoDir = writeNativeChallengeRepo({
    model: 'qwen-3-coder',
    provider: 'openrouter',
    phase: 'patch',
  });
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

  try {
    const result = pickChallengeModelsWithReason(
      ['gpt-5.6-terra', 'claude-opus-4-6', 'qwen-3-coder'],
      {
        pairId: 'HOK-2235-OPT-OUT',
        issueId: 'HOK-2235-OPT-OUT',
        slug: 'native-coding-stage-opt-out',
        primaryModel: 'gpt-5.6-terra',
        repoDir,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair);
    assert.equal(result.pair!.challenger.model, 'claude-opus-4-6');
    const rejection = (result.nativeCertificationRejections || []).find((entry) => entry.modelId === 'qwen-3-coder');
    assert.ok(rejection);
    assert.equal(rejection!.reason, 'no-native-capability');
    assert.equal(rejection!.role, 'coder');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});

test('pickChallengeWorkflows uses same routing for both sides', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-974',
      issueId: 'HOK-974',
      slug: 'fix-oauth-bug',
      prompt: 'Fix authentication bug in OAuth flow',
      primaryModel: 'claude-opus-4-6',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  // Both sides should have the same planner/reviewer/depths
  assert.equal(pair!.primary.planner, pair!.challenger.planner);
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
  assert.equal(pair!.primary.planDepth, pair!.challenger.planDepth);
  assert.equal(pair!.primary.codeDepth, pair!.challenger.codeDepth);
  assert.equal(pair!.primary.reviewMode, pair!.challenger.reviewMode);

  // But different coders
  assert.notEqual(pair!.primary.model, pair!.challenger.model);
});

test('pickChallengeWorkflows returns null when fewer than two distinct models exist', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6'],
    {
      pairId: 'HOK-975',
      issueId: 'HOK-975',
      slug: 'new-feature',
      prompt: 'Add new feature',
      routeFn: mockRouteFn,
    },
  );
  assert.equal(pair, null);
});

test('routeChangedMaterially ignores model swaps within same class', () => {
  const bootstrap: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-7',
    codeDepth: 'medium',
    reviewMode: 'static+llm',
  };

  assert.deepEqual(routeChangedMaterially(bootstrap, expanded), { changed: false, reasons: [] });
});

test('routeChangedMaterially detects class and depth changes', () => {
  const bootstrap: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.6-terra',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'llm',
  };

  assert.deepEqual(routeChangedMaterially(bootstrap, expanded), {
    changed: true,
    reasons: ['code_depth', 'reviewer_class'],
  });
});

test('routeChangedMaterially compares unknown models by exact id', () => {
  const bootstrap: RouteArtifactSnapshot = {
    coder: 'custom-a',
    reviewer: 'custom-reviewer',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'custom-b',
    reviewer: 'custom-reviewer',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  assert.deepEqual(routeChangedMaterially(bootstrap, expanded), {
    changed: true,
    reasons: ['coder_class'],
  });
});

test('pickChallengeWorkflowsWithContext uses bootstrap route when expanded route is absent', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'gpt-5.6-terra',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-976',
      issueId: 'HOK-976',
      slug: 'bootstrap-only',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded: null },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'bootstrap');
  assert.equal(pair!.primary.planner, 'gpt-5.6-terra');
  assert.equal(pair!.primary.planDepth, 'deep');
  assert.equal(pair!.primary.reviewer, 'claude-opus-4-6');
});

test('pickChallengeWorkflowsWithContext uses expanded route when bootstrap is unavailable', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.6-terra',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.6-terra', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-977',
      issueId: 'HOK-977',
      slug: 'expanded-only',
      prompt: 'irrelevant',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.primary.model, 'gpt-5.6-terra');
  assert.equal(pair!.primary.codeDepth, 'deep');
});

test('pickChallengeWorkflowsWithContext preserves bootstrap participants when route is not materially different', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-opus-4-6',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-7',
    codeDepth: 'medium',
    reviewMode: 'static+llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-978',
      issueId: 'HOK-978',
      slug: 'preserved',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-5-20250929',
      randomFn: () => 0,
    },
    { bootstrap, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'preserved');
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.routeContext.refreshRationale, 'expanded route matches bootstrap on coder class/depth');
});

test('pickChallengeWorkflowsWithContext refreshes participants when expanded route changes materially', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-sonnet-4-5-20250929',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.6-terra',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.6-terra', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-979',
      issueId: 'HOK-979',
      slug: 'refreshed',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.primary.model, 'gpt-5.6-terra');
  assert.equal(pair!.primary.codeDepth, 'deep');
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.planDepth, 'deep');
});

test('pickChallengeWorkflowsWithContext carries expanded route context to both challenge entries', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'bootstrap-planner',
    coder: 'claude-sonnet-4-6',
    reviewer: 'bootstrap-reviewer',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.6-terra',
    reviewer: 'claude-sonnet-4-6',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.6-terra', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-980',
      issueId: 'HOK-980',
      slug: 'expanded-context',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.routeContext.expandedRoute, expanded);
  assert.equal(pair!.primary.model, 'gpt-5.6-terra');
  assert.equal(pair!.primary.codeDepth, 'deep');
  assert.equal(pair!.primary.reviewMode, 'static+llm');
  assert.equal(pair!.primary.planner, 'bootstrap-planner');
  assert.equal(pair!.challenger.codeDepth, 'deep');
  assert.equal(pair!.challenger.reviewMode, 'static+llm');
  assert.equal(pair!.challenger.planner, 'bootstrap-planner');
});

test('pickChallengeWorkflowsWithContext treats absent invalid expanded snapshot as bootstrap-only', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'bootstrap-planner',
    coder: 'claude-sonnet-4-6',
    reviewer: 'bootstrap-reviewer',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-981',
      issueId: 'HOK-981',
      slug: 'invalid-expanded-absent',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded: null },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'bootstrap');
  assert.equal(pair!.routeContext.expandedRoute, undefined);
  assert.equal(pair!.primary.model, 'claude-sonnet-4-6');
  assert.equal(pair!.primary.codeDepth, 'medium');
  assert.equal(pair!.primary.reviewMode, 'llm');
});

function snapshotWithRecommendation(
  recommendation: Record<string, unknown> | undefined,
  coder = 'claude-sonnet-4-6',
): RouteArtifactSnapshot {
  return {
    coder,
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'llm',
    ...(recommendation !== undefined
      ? { expectedMetrics: { challengeRecommendation: recommendation } }
      : {}),
  };
}

test('extractChallengeRecommendation prefers the expanded artifact', () => {
  const recommendation = extractChallengeRecommendation({
    bootstrap: snapshotWithRecommendation({
      shouldChallenge: true,
      reason: 'low-confidence',
      challengerModel: 'gpt-5.6-terra',
      priority: 300,
    }),
    expanded: snapshotWithRecommendation({
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'claude-fable-5',
      priority: 200,
    }),
  });
  assert.equal(recommendation?.reason, 'new-model');
  assert.equal(recommendation?.challengerModel, 'claude-fable-5');
});

test('extractChallengeRecommendation accepts top-level recommendations and prefers expectedMetrics within an artifact', () => {
  const recommendation = extractChallengeRecommendation({
    bootstrap: null,
    expanded: {
      ...snapshotWithRecommendation({
        shouldChallenge: true,
        reason: 'low-data-stage',
        challengerModel: 'expected-metrics-model',
        stage: 'implementation',
        priority: 200,
      }),
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'new-model',
        challengerModel: 'top-level-model',
        stage: 'review',
        priority: 300,
      },
    },
  });

  assert.equal(recommendation?.challengerModel, 'expected-metrics-model');
  assert.equal(recommendation?.stage, 'implementation');

  const topLevelOnly = extractChallengeRecommendation({
    bootstrap: null,
    expanded: {
      coder: 'gpt-5.5',
      codeDepth: 'medium',
      reviewer: 'gpt-5.5',
      reviewMode: 'llm',
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'low-data-stage',
        challengerModel: 'glm-5.2',
        stage: 'implementation',
        priority: 200,
      },
    },
  });
  assert.equal(topLevelOnly?.challengerModel, 'glm-5.2');
  assert.equal(topLevelOnly?.stage, 'implementation');
});

test('extractChallengeRecommendation falls back to bootstrap and rejects non-actionable payloads', () => {
  const fromBootstrap = extractChallengeRecommendation({
    bootstrap: snapshotWithRecommendation({
      shouldChallenge: true,
      reason: 'low-data-stage',
      challengerModel: 'claude-fable-5',
      stage: 'review',
      priority: 100,
    }),
    expanded: snapshotWithRecommendation(undefined),
  });
  assert.equal(fromBootstrap?.reason, 'low-data-stage');
  assert.equal(fromBootstrap?.stage, 'review');

  assert.equal(extractChallengeRecommendation({ bootstrap: null, expanded: null }), null);
  assert.equal(
    extractChallengeRecommendation({
      bootstrap: snapshotWithRecommendation({ shouldChallenge: false, reason: 'disabled', priority: 0 }),
      expanded: null,
    }),
    null,
  );
  assert.equal(
    extractChallengeRecommendation({
      bootstrap: snapshotWithRecommendation({ shouldChallenge: true, reason: 'mystery', priority: 1 }),
      expanded: null,
    }),
    null,
  );
});

test('decideChallengeLaunch without recommendation is a plain random roll', () => {
  const win = decideChallengeLaunch({ pool: ['a-model-1', 'b-model-2'], rate: 0.3, randomFn: () => 0.2 });
  assert.equal(win.launch, true);
  assert.equal(win.selectionPath, 'random-roll');
  assert.equal(win.suggestedChallengerModel, undefined);

  const lose = decideChallengeLaunch({ pool: ['a-model-1', 'b-model-2'], rate: 0.3, randomFn: () => 0.9 });
  assert.equal(lose.launch, false);
});

test('decideChallengeLaunch fires exploration recommendations regardless of base rate', () => {
  const decision = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    primaryModel: 'claude-sonnet-4-6',
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'gpt-5.6-terra',
      priority: 200,
    },
    randomFn: () => 0.99,
  });
  assert.equal(decision.launch, true);
  assert.equal(decision.selectionPath, 'recommendation-driven');
  assert.equal(decision.suggestedChallengerModel, 'gpt-5.6-terra');
});

test('decideChallengeLaunch honors a reduced recommendationRate', () => {
  const decision = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'claude-fable-5'],
    rate: 0.1,
    recommendationRate: 0.5,
    recommendation: {
      shouldChallenge: true,
      reason: 'low-data-stage',
      challengerModel: 'claude-fable-5',
      priority: 100,
    },
    randomFn: () => 0.7,
  });
  assert.equal(decision.launch, false);
  assert.equal(decision.selectionPath, 'recommendation-driven');
});

test('decideChallengeLaunch keeps the base rate for low-confidence recommendations', () => {
  const decision = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    rate: 0.3,
    recommendation: {
      shouldChallenge: true,
      reason: 'low-confidence',
      challengerModel: 'gpt-5.6-terra',
      priority: 300,
    },
    randomFn: () => 0.5,
  });
  assert.equal(decision.launch, false);
  assert.equal(decision.selectionPath, 'recommendation-driven');
  assert.equal(decision.suggestedChallengerModel, 'gpt-5.6-terra');
});

test('decideChallengeLaunch drops unusable recommended challengers', () => {
  const notInPool = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'claude-fable-5',
      priority: 200,
    },
    randomFn: () => 0,
  });
  assert.equal(notInPool.launch, true);
  assert.equal(notInPool.suggestedChallengerModel, undefined);

  const samePrimary = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    primaryModel: 'gpt-5.6-terra',
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'gpt-5.6-terra',
      priority: 200,
    },
    randomFn: () => 0,
  });
  assert.equal(samePrimary.suggestedChallengerModel, undefined);

  const disabled = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.6-terra', 'gpt-5.3-codex'],
    primaryModel: 'claude-sonnet-4-6',
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'gpt-5.3-codex',
      priority: 200,
    },
    randomFn: () => 0,
  });
  assert.equal(disabled.launch, true);
  assert.equal(disabled.suggestedChallengerModel, undefined);
});

test('pickChallengeModels uses the forced challenger when usable', () => {
  const pair = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.6-terra', 'claude-opus-4-8'],
    {
      pairId: 'HOK-990',
      issueId: 'HOK-990',
      slug: 'forced-challenger',
      primaryModel: 'claude-sonnet-4-6',
      suggestedChallengerModel: 'claude-opus-4-8',
      randomFn: () => 0, // would otherwise pick gpt-5.6-terra
    },
  );
  assert.equal(pair?.challenger.model, 'claude-opus-4-8');
  assert.equal(pair?.primary.model, 'claude-sonnet-4-6');
});

test('pickChallengeModels falls back to random when the forced challenger is unusable', () => {
  const equalsPrimary = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-991',
      issueId: 'HOK-991',
      slug: 'forced-equals-primary',
      primaryModel: 'claude-sonnet-4-6',
      suggestedChallengerModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
  );
  assert.equal(equalsPrimary?.challenger.model, 'gpt-5.6-terra');

  const notInPool = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-992',
      issueId: 'HOK-992',
      slug: 'forced-not-in-pool',
      primaryModel: 'claude-sonnet-4-6',
      suggestedChallengerModel: 'claude-fable-5',
      randomFn: () => 0,
    },
  );
  assert.equal(notInPool?.challenger.model, 'gpt-5.6-terra');

  const disabled = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.6-terra', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-994',
      issueId: 'HOK-994',
      slug: 'forced-disabled',
      primaryModel: 'claude-sonnet-4-6',
      suggestedChallengerModel: 'gpt-5.3-codex',
      randomFn: () => 0,
    },
  );
  assert.equal(disabled?.challenger.model, 'gpt-5.6-terra');

  const disabledPrimary = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.6-terra', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-995',
      issueId: 'HOK-995',
      slug: 'primary-disabled',
      primaryModel: 'gpt-5.3-codex',
      randomFn: () => 0,
    },
  );
  assert.notEqual(disabledPrimary?.primary.model, 'gpt-5.3-codex');
  assert.notEqual(disabledPrimary?.challenger.model, 'gpt-5.3-codex');
});

test('pickChallengeWorkflowsWithContext threads the forced challenger through route snapshots', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'llm',
    planner: 'claude-sonnet-4-6',
    planDepth: 'light',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.6-terra', 'claude-opus-4-8'],
    {
      pairId: 'HOK-993',
      issueId: 'HOK-993',
      slug: 'forced-with-context',
      prompt: 'irrelevant',
      suggestedChallengerModel: 'claude-opus-4-8',
      randomFn: () => 0, // would otherwise pick gpt-5.6-terra
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-sonnet-4-6');
  assert.equal(pair!.challenger.model, 'claude-opus-4-8');
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
});


test('chooseChallengeStage defaults to implementation and honors recommendations', () => {
  assert.equal(chooseChallengeStage(), 'implementation');
  assert.equal(chooseChallengeStage({ weights: {} }), 'implementation');
  assert.equal(chooseChallengeStage({ weights: { plan: 0, review: 0 } }), 'implementation');
  assert.equal(
    chooseChallengeStage({ weights: { implementation: 1 }, recommendedStage: 'review' }),
    'review',
  );
  assert.equal(chooseChallengeStage({ recommendedStage: 'plan' }), 'plan');
});

test('chooseChallengeStage samples stages by weight with a seeded randomFn', () => {
  const weights = { plan: 1, implementation: 2, review: 1 };
  // Cumulative mass: plan [0, 0.25), implementation [0.25, 0.75), review [0.75, 1)
  assert.equal(chooseChallengeStage({ weights, randomFn: () => 0.1 }), 'plan');
  assert.equal(chooseChallengeStage({ weights, randomFn: () => 0.5 }), 'implementation');
  assert.equal(chooseChallengeStage({ weights, randomFn: () => 0.9 }), 'review');
});

test('variedModelForStage maps stage to the right entry field', () => {
  const entry = {
    key: 'K', issueId: 'K', slug: 's', branch: 'task/s', role: 'primary' as const,
    model: 'coder-m', agent: 'claude',
    planner: 'planner-m', plannerAgent: 'claude',
    reviewer: 'reviewer-m', reviewerAgent: 'claude',
    planDepth: '', codeDepth: '', reviewMode: '',
  };
  assert.equal(variedModelForStage(entry, 'plan'), 'planner-m');
  assert.equal(variedModelForStage(entry, 'review'), 'reviewer-m');
  assert.equal(variedModelForStage(entry, 'implementation'), 'coder-m');
  assert.equal(variedModelForStage(entry, undefined), 'coder-m');
});

test('pickChallengeWorkflows varies only the planner for plan-stage challenges', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-995',
      issueId: 'HOK-995',
      slug: 'plan-stage',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-sonnet-4-5-20250929',
      challengeStage: 'plan',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'plan');
  // Coder and reviewer are shared; only the planner differs
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.notEqual(pair!.challenger.planner, pair!.primary.planner);
  assert.equal(pair!.primary.planDepth, pair!.challenger.planDepth);
});

test('pickChallengeWorkflows varies only the reviewer for review-stage challenges', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-996',
      issueId: 'HOK-996',
      slug: 'review-stage',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'review',
      suggestedChallengerModel: 'gpt-5.6-terra',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'review');
  assert.equal(pair!.primary.model, pair!.challenger.model);
  assert.equal(pair!.primary.planner, pair!.challenger.planner);
  assert.equal(pair!.primary.reviewer, 'claude-sonnet-4-5-20250929');
  // Forced challenger applies to the varied stage
  assert.equal(pair!.challenger.reviewer, 'gpt-5.6-terra');
});

test('pickChallengeWorkflows falls back to coder variation when the route lacks the stage model', () => {
  const plannerlessRoute = (): WorkflowRouteDecision => ({
    ...mockRouteFn(),
    planner: '',
  });
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-997',
      issueId: 'HOK-997',
      slug: 'fallback-stage',
      prompt: 'irrelevant',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'plan',
      randomFn: () => 0,
      routeFn: plannerlessRoute,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'implementation');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
});

test('pickChallengeModels selects the least-used zero-record implementation challenger', () => {
  const selection = pickChallengeModelsWithReason(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-997A',
      issueId: 'HOK-997A',
      slug: 'least-used-implementation',
      primaryModel: 'claude-opus-4-6',
      suggestedChallengerModel: 'gpt-5.6-terra',
      recommendedChallengerModel: 'gpt-5.6-terra',
      agentMap: {
        'claude-sonnet-4-5-20250929': 'claude',
        'gpt-5.6-terra': 'codex',
      },
      coverage: makeCoverage({
        implementation: {
          'claude-sonnet-4-5-20250929': 0,
          'gpt-5.6-terra': 2,
        },
      }),
      rotationSeed: 'HOK-997A|implementation',
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.challengeStage, 'implementation');
  assert.equal(selection.pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(selection.pair!.selectionReason, 'least-used-zero-record');
  assert.equal(selection.pair!.challengerCoverageCount, 0);
});

test('pickChallengeModels filters offered challengers through the implementation effective projection', () => {
  assert.equal(
    listEffectiveModelsForStage('coding').models.includes('ox-alpha'),
    false,
    'fixture must remain absent from the launch preflight coding projection',
  );

  const selection = pickChallengeModelsWithReason(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'ox-alpha'],
    {
      pairId: 'HOK-2920',
      issueId: 'HOK-2920',
      slug: 'projection-filtered-implementation',
      primaryModel: 'claude-opus-4-6',
      suggestedChallengerModel: 'ox-alpha',
      recommendedChallengerModel: 'ox-alpha',
      coverage: makeCoverage({
        implementation: {
          'ox-alpha': 0,
          'claude-sonnet-4-5-20250929': 4,
        },
      }),
      rotationSeed: 'HOK-2920|implementation',
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.notEqual(selection.pair!.challenger.model, 'ox-alpha');
});

test('pickChallengeWorkflows varies only the planner and selects the least-used zero-record planner challenger', () => {
  const selection = pickChallengeWorkflowsWithReason(
    ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-997B',
      issueId: 'HOK-997B',
      slug: 'least-used-plan',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-sonnet-4-5-20250929',
      challengeStage: 'plan',
      agentMap: {
        'claude-sonnet-4-6': 'claude',
        'gpt-5.6-terra': 'codex',
      },
      coverage: makeCoverage({
        plan: {
          'claude-sonnet-4-6': 0,
          'gpt-5.6-terra': 4,
        },
      }),
      rotationSeed: 'HOK-997B|plan',
      routeFn: mockRouteFn,
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.challengeStage, 'plan');
  assert.equal(selection.pair!.primary.model, selection.pair!.challenger.model);
  assert.equal(selection.pair!.primary.reviewer, selection.pair!.challenger.reviewer);
  assert.equal(selection.pair!.challenger.planner, 'claude-sonnet-4-6');
  assert.equal(selection.pair!.selectionReason, 'last-resort-incumbent');
  assert.equal(selection.pair!.challengerCoverageCount, 0);
});

test('pickChallengeWorkflows varies only the reviewer and selects the least-used zero-record reviewer challenger', () => {
  const selection = pickChallengeWorkflowsWithReason(
    ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-997C',
      issueId: 'HOK-997C',
      slug: 'least-used-review',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'review',
      agentMap: {
        'claude-sonnet-4-6': 'claude',
        'gpt-5.6-terra': 'codex',
      },
      coverage: makeCoverage({
        review: {
          'claude-sonnet-4-6': 0,
          'gpt-5.6-terra': 5,
        },
      }),
      rotationSeed: 'HOK-997C|review',
      routeFn: mockRouteFn,
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.challengeStage, 'review');
  assert.equal(selection.pair!.primary.model, selection.pair!.challenger.model);
  assert.equal(selection.pair!.primary.planner, selection.pair!.challenger.planner);
  assert.equal(selection.pair!.challenger.reviewer, 'claude-sonnet-4-6');
  assert.equal(selection.pair!.selectionReason, 'last-resort-incumbent');
  assert.equal(selection.pair!.challengerCoverageCount, 0);
});

test('pickChallengeWorkflowsWithContext uses the bootstrap route and least-used implementation challenger', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const selection = pickChallengeWorkflowsWithContextAndReason(
    ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-997D',
      issueId: 'HOK-997D',
      slug: 'bootstrap-zero-record',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      agentMap: {
        'claude-sonnet-4-5-20250929': 'claude',
        'gpt-5.6-terra': 'codex',
      },
      coverage: makeCoverage({
        implementation: {
          'claude-sonnet-4-5-20250929': 0,
          'gpt-5.6-terra': 2,
        },
      }),
      rotationSeed: 'HOK-997D|implementation',
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
    { bootstrap, expanded: null },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.routeContext?.decisionSource, 'bootstrap');
  assert.equal(selection.pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(selection.pair!.selectionReason, 'least-used-zero-record');
  assert.equal(selection.pair!.challengerCoverageCount, 0);
});

test('pickChallengeWorkflowsWithContext uses the expanded route and least-used implementation challenger', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  };

  const selection = pickChallengeWorkflowsWithContextAndReason(
    ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-997E',
      issueId: 'HOK-997E',
      slug: 'expanded-zero-record',
      prompt: 'irrelevant',
      agentMap: {
        'claude-sonnet-4-5-20250929': 'claude',
        'gpt-5.6-terra': 'codex',
      },
      coverage: makeCoverage({
        implementation: {
          'claude-sonnet-4-5-20250929': 0,
          'gpt-5.6-terra': 3,
        },
      }),
      rotationSeed: 'HOK-997E|implementation',
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
    { bootstrap: null, expanded },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.routeContext?.decisionSource, 'expanded');
  assert.equal(selection.pair!.primary.model, 'claude-sonnet-4-6');
  assert.equal(selection.pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(selection.pair!.selectionReason, 'least-used-zero-record');
  assert.equal(selection.pair!.challengerCoverageCount, 0);
});

test('coverage-aware selection falls forward when the recommended challenger is not least-used', () => {
  const selection = pickChallengeModelsWithReason(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-997F',
      issueId: 'HOK-997F',
      slug: 'fallforward',
      primaryModel: 'claude-opus-4-6',
      suggestedChallengerModel: 'gpt-5.6-terra',
      recommendedChallengerModel: 'gpt-5.6-terra',
      agentMap: {
        'claude-sonnet-4-5-20250929': 'claude',
        'gpt-5.6-terra': 'codex',
      },
      coverage: makeCoverage({
        implementation: {
          'claude-sonnet-4-5-20250929': 2,
          'gpt-5.6-terra': 5,
        },
      }),
      rotationSeed: 'HOK-997F|implementation',
      randomFn: () => {
        throw new Error('random fallback should not run');
      },
    },
  );

  assert.ok(selection.pair);
  assert.equal(selection.pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(selection.pair!.selectionReason, 'least-used-fallforward');
  assert.equal(selection.pair!.challengerCoverageCount, 2);
});

test('pickChallengeWorkflowsWithContext varies the planner from a route snapshot', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-5-20250929',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-5-20250929',
    reviewMode: 'llm',
    planner: 'claude-opus-4-6',
    planDepth: 'deep',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'],
    {
      pairId: 'HOK-998',
      issueId: 'HOK-998',
      slug: 'snapshot-plan-stage',
      prompt: 'irrelevant',
      challengeStage: 'plan',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'plan');
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  // Coder shared from the route; planner varied on the challenger only
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.notEqual(pair!.challenger.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
  assert.equal(pair!.challenger.planDepth, 'deep');
});

test('pickChallengeWorkflowsWithContext keeps coder variation by default', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-5-20250929',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-5-20250929',
    reviewMode: 'llm',
    planner: 'claude-opus-4-6',
    planDepth: 'light',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-999',
      issueId: 'HOK-999',
      slug: 'default-stage',
      prompt: 'irrelevant',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'implementation');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
  assert.equal(pair!.primary.planner, pair!.challenger.planner);
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
});

test('implementation-stage pair remains unchanged when coder differs', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'gpt-5.6-terra', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-2301-I',
      issueId: 'HOK-2301-I',
      slug: 'implementation-already-varied',
      prompt: 'irrelevant',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'implementation',
      suggestedChallengerModel: 'gpt-5.6-terra',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'implementation');
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.challenger.model, 'gpt-5.6-terra');
  assert.deepEqual(
    listVariedRoutingDimensions(
      routingMetaFromChallengeEntry(pair!.primary),
      routingMetaFromChallengeEntry(pair!.challenger),
    ),
    ['coder'],
  );
});

test('already-varied plan and review pairs remain single-variable', () => {
  const planPair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'gpt-5.6-terra', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-2301-P',
      issueId: 'HOK-2301-P',
      slug: 'plan-already-varied',
      prompt: 'irrelevant',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'plan',
      suggestedChallengerModel: 'gpt-5.6-terra',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(planPair);
  assert.equal(planPair!.challengeStage, 'plan');
  assert.deepEqual(
    listVariedRoutingDimensions(
      routingMetaFromChallengeEntry(planPair!.primary),
      routingMetaFromChallengeEntry(planPair!.challenger),
    ),
    ['planner'],
  );

  const reviewPair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'gpt-5.6-terra', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-2301-R',
      issueId: 'HOK-2301-R',
      slug: 'review-already-varied',
      prompt: 'irrelevant',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'review',
      suggestedChallengerModel: 'gpt-5.6-terra',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(reviewPair);
  assert.equal(reviewPair!.challengeStage, 'review');
  assert.deepEqual(
    listVariedRoutingDimensions(
      routingMetaFromChallengeEntry(reviewPair!.primary),
      routingMetaFromChallengeEntry(reviewPair!.challenger),
    ),
    ['reviewer'],
  );
});

test('pickChallengeWorkflows repairs a forced review challenger that matches the primary reviewer', () => {
  const pair = pickChallengeWorkflows(
    ['gpt-5.6-terra', 'claude-opus-4-7', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-2301-A',
      issueId: 'HOK-2301-A',
      slug: 'repair-review-stage',
      prompt: 'irrelevant',
      primaryModel: 'gpt-5.6-terra',
      challengeStage: 'review',
      suggestedChallengerModel: 'claude-opus-4-7',
      randomFn: () => 0,
      routeFn: () => ({
        planner: 'claude-opus-4-7',
        coder: 'gpt-5.6-terra',
        reviewer: 'claude-opus-4-7',
        planDepth: 'medium',
        codeDepth: 'medium',
        reviewRecommended: 'llm',
        expectedSuccess: 0.9,
        expectedCostPlan: 1,
        expectedCostCode: 1,
        expectedCostReview: 1,
        reasoning: [],
        signals: {},
      }),
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'review');
  assert.equal(pair!.primary.reviewer, 'claude-opus-4-7');
  assert.notEqual(pair!.challenger.reviewer, pair!.primary.reviewer);
  assert.equal(pair!.challenger.reviewer, 'gpt-5.6-terra');
});

test('pickChallengeModels returns null when no routing divergence can be created', () => {
  const pair = pickChallengeModels(
    ['claude-opus-4-7'],
    {
      pairId: 'HOK-2301-B',
      issueId: 'HOK-2301-B',
      slug: 'no-divergence',
      primaryModel: 'claude-opus-4-7',
      suggestedChallengerModel: 'claude-opus-4-7',
      randomFn: () => 0,
    },
  );

  assert.equal(pair, null);
});

test('pickChallengeWorkflowsWithContext preserves route context while repairing identical review dimensions', () => {
  const expanded: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-7',
    coder: 'gpt-5.6-terra',
    reviewer: 'claude-opus-4-7',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.6-terra', 'claude-opus-4-7', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-2301-C',
      issueId: 'HOK-2301-C',
      slug: 'context-repair',
      prompt: 'irrelevant',
      challengeStage: 'review',
      suggestedChallengerModel: 'claude-opus-4-7',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.primary.reviewer, 'claude-opus-4-7');
  assert.notEqual(pair!.challenger.reviewer, pair!.primary.reviewer);
  assert.equal(pair!.challenger.codeDepth, 'medium');
  assert.equal(pair!.challenger.reviewMode, 'llm');
});

test('reason-aware context selection preserves selection_failed diagnostics', () => {
  const expanded: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-7',
    coder: 'claude-opus-4-7',
    reviewer: 'claude-opus-4-7',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const selection = pickChallengeWorkflowsWithContextAndReason(
    ['claude-opus-4-7'],
    {
      pairId: 'HOK-2301-D',
      issueId: 'HOK-2301-D',
      slug: 'context-selection-failed',
      prompt: 'irrelevant',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.equal(selection.pair, null);
  assert.equal(selection.failureReason, 'selection_failed');
});


// ===========================
// Native Certification Guardrail Tests
// ===========================

// Certification validation also runs against wall-clock time, so anchor all
// fixture timestamps to this test run instead of a calendar date that expires.
const TEST_NOW = new Date();
const CERT_DATE_FRESH = TEST_NOW.toISOString();
const CERT_DATE_STALE = new Date(TEST_NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

/** Create a temp repo with the given model registry and return cleanup fn */
function makeNativeTestRepo(
  _modelRegistryModels: Record<string, unknown>,
  opts: {
    config?: Record<string, unknown>;
    env?: Record<string, string>;
    patchCodingEnabled?: boolean;
  } = {},
): {
  repoDir: string;
  cleanup: () => void;
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-native-test-'));
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    ...(opts.patchCodingEnabled
      ? { nativeAgent: { patchCoding: { enabled: true } } }
      : {}),
    ...(opts.config || {}),
  }));
  if (opts.patchCodingEnabled) {
    writePatchCodingCertification(repoDir, CERT_DATE_FRESH);
  }
  if (opts.env && Object.keys(opts.env).length > 0) {
    writeFileSync(
      join(repoDir, '.env'),
      `${Object.entries(opts.env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    );
  }
  clearConfigCache(repoDir);
  return {
    repoDir,
    cleanup: () => {
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

/** Write a certification artifact to a test repo */
function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  overrides: Record<string, unknown> = {},
): void {
  const identity = resolveTestCertificationIdentity(repoDir, provider, model);
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
  );
  mkdirSync(dirname(path), { recursive: true });
  const artifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'patch',
    suiteVersion,
    certifiedAt: CERT_DATE_FRESH,
    scenarios: [{ scenarioId: 's1', passed: true }],
    // Coding-capable phases carry an eligible live canary by default so the
    // HOK-2943 coder gate exercises the downstream rejection under test;
    // canary-negative cases override liveCanary explicitly.
    ...((overrides.phase ?? 'patch') !== 'read-only'
      ? { liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: CERT_DATE_FRESH }) }
      : {}),
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact));
}

function certArtifactPath(repoDir: string, provider: string, model: string, suiteVersion: string): string {
  const identity = resolveTestCertificationIdentity(repoDir, provider, model);
  return buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
  );
}

function resolveTestCertificationIdentity(repoDir: string, provider: string, model: string): {
  subject: CertificationSubject;
  storageIdentity: { provider: string; model: string };
} {
  const nativeProvider = provider === 'openai' ? 'openai' : 'openrouter';
  const providerNativeId = nativeProvider === 'openrouter'
    ? resolveOpenRouterModelId(model) ?? (provider === 'openrouter' ? model : `${provider}/${model}`)
    : model;
  try {
    return resolveCertificationSubject({
      provider: nativeProvider,
      model,
      registry: getEffectiveRegistry(repoDir),
    });
  } catch {
    const storageIdentity = resolveCertificationStorageIdentity(nativeProvider, providerNativeId);
    return {
      storageIdentity,
      subject: {
        registryKey: model,
        nativeProvider,
        providerId: storageIdentity.provider,
        providerModelId: storageIdentity.model,
        providerNativeId,
        identityRevision: 1,
        identityFingerprint: computeIdentityFingerprint({
          alias: model,
          providerNativeId,
          provider: nativeProvider,
          revision: 1,
        }),
        catalogHash: nativeProvider === 'openrouter' ? 'test-catalog' : 'registry',
      },
    };
  }
}

/** Build a minimal native model registry entry */
function nativeModelEntry(phase: string = 'patch', suiteVersion: string = 'v1') {
  return {
    class: 'strong_generalist',
    nativeCapability: {
      nativeProvider: 'openai',
      piTransportKind: 'openai-responses',
      readOnlyNative: 'certified',
      certification: {
        maxCertifiedPhase: phase,
        certifiedAt: CERT_DATE_FRESH,
        certificationSuiteVersion: suiteVersion,
      },
    },
  };
}

function openRouterNativeModelEntry(phase: string = 'workflow', suiteVersion: string = 'v1') {
  return {
    class: 'strong_generalist',
    agent: 'native-openrouter',
    nativeCapability: {
      nativeProvider: 'openrouter',
      piTransportKind: 'openai-completions',
      readOnlyNative: 'certified',
      compatFlags: { thinkingFormat: 'openrouter' },
      certification: {
        maxCertifiedPhase: phase,
        certifiedAt: CERT_DATE_FRESH,
        certificationSuiteVersion: suiteVersion,
      },
    },
  };
}

const HOK_2569_OPENROUTER_ALIASES = ['qwen-3-coder', 'glm-5.2', 'kimi-k2.7-code'] as const;

function makeHok2569Repo(
  alias: typeof HOK_2569_OPENROUTER_ALIASES[number],
  opts: { patchCodingEnabled?: boolean } = { patchCodingEnabled: true },
) {
  return makeNativeTestRepo(
    {
      [alias]: openRouterNativeModelEntry('patch', DEFAULT_CERTIFICATION_SUITE_VERSION),
    },
    {
      patchCodingEnabled: opts.patchCodingEnabled,
      config: {
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'HOK_2569_OPENROUTER_KEY',
          },
        },
      },
      env: {
        HOK_2569_OPENROUTER_KEY: 'test-openrouter-key',
      },
    },
  );
}

console.log('\n--- Native Certification Guardrail Tests ---\n');

test('HOK-2569 OpenRouter v3 patch aliases pass canonical gate and challenge filtering', () => {
  for (const alias of HOK_2569_OPENROUTER_ALIASES) {
    const { repoDir, cleanup } = makeHok2569Repo(alias);
    try {
      writeCertArtifact(repoDir, 'openrouter', alias, DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });

      const gate = evaluateNativeProviderGate({
        modelId: alias,
        mode: 'task',
        requiredPhase: 'patch',
        registry: getEffectiveRegistry(repoDir),
        repoDir,
        apiKeyPresent: true,
        apiKeyEnv: 'HOK_2569_OPENROUTER_KEY',
        now: TEST_NOW,
      });
      assert.equal(gate.ok, true, `${alias} should pass canonical gate`);

      const result = pickChallengeModelsWithReason(
        ['claude-opus-4-6', alias],
        {
          pairId: `HOK-2569-${alias}`,
          issueId: `HOK-2569-${alias}`,
          slug: `hok-2569-${alias}`,
          primaryModel: 'claude-opus-4-6',
          suggestedChallengerModel: alias,
          repoDir,
          now: TEST_NOW,
          randomFn: () => 0,
        },
      );

      assert.ok(result.pair, `${alias} should remain challenge-eligible`);
      assert.equal(result.pair!.challenger.model, alias);
      assert.equal(
        (result.nativeCertificationRejections || []).find((entry) => entry.modelId === alias),
        undefined,
        `${alias} should not have challenge native rejections`,
      );
    } finally {
      cleanup();
    }
  }
});

test('HOK-2569 OpenRouter v3 patch aliases fail closed consistently for degraded artifacts', () => {
  const cases: Array<{
    name: string;
    configure: (repoDir: string, alias: typeof HOK_2569_OPENROUTER_ALIASES[number]) => void;
    gateReason: string;
    challengeReason: string;
  }> = [
    {
      name: 'missing',
      configure: () => {},
      gateReason: 'missing_artifact',
      challengeReason: 'missing-artifact',
    },
    {
      name: 'stale',
      configure: (repoDir, alias) => writeCertArtifact(repoDir, 'openrouter', alias, DEFAULT_CERTIFICATION_SUITE_VERSION, {
        phase: 'patch',
        certifiedAt: CERT_DATE_STALE,
      }),
      gateReason: 'stale_artifact',
      challengeReason: 'stale',
    },
    {
      name: 'wrong-suite',
      configure: (repoDir, alias) => writeCertArtifact(repoDir, 'openrouter', alias, DEFAULT_CERTIFICATION_SUITE_VERSION, {
        phase: 'patch',
        suiteVersion: 'v1',
      }),
      gateReason: 'wrong_suite',
      challengeReason: 'wrong-suite',
    },
    {
      name: 'malformed',
      configure: (repoDir, alias) => {
        const artifactPath = certArtifactPath(repoDir, 'openrouter', alias, DEFAULT_CERTIFICATION_SUITE_VERSION);
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, '{');
      },
      gateReason: 'malformed_artifact',
      challengeReason: 'malformed',
    },
    {
      name: 'phase-insufficient',
      configure: (repoDir, alias) => writeCertArtifact(repoDir, 'openrouter', alias, DEFAULT_CERTIFICATION_SUITE_VERSION, {
        phase: 'read-only',
      }),
      gateReason: 'insufficient_phase',
      challengeReason: 'insufficient-phase',
    },
  ];

  for (const testCase of cases) {
    const alias = 'qwen-3-coder';
    const { repoDir, cleanup } = makeHok2569Repo(alias);
    try {
      testCase.configure(repoDir, alias);

      const gate = evaluateNativeProviderGate({
        modelId: alias,
        mode: 'task',
        requiredPhase: 'patch',
        registry: getEffectiveRegistry(repoDir),
        repoDir,
        apiKeyPresent: true,
        apiKeyEnv: 'HOK_2569_OPENROUTER_KEY',
        now: TEST_NOW,
      });
      assert.equal(gate.ok, false, `${testCase.name} should fail canonical gate`);
      assert.equal(gate.ok ? '' : gate.reason, testCase.gateReason);

      const result = pickChallengeModelsWithReason(
        ['claude-opus-4-6', alias],
        {
          pairId: `HOK-2569-${testCase.name}`,
          issueId: `HOK-2569-${testCase.name}`,
          slug: `hok-2569-${testCase.name}`,
          primaryModel: 'claude-opus-4-6',
          suggestedChallengerModel: alias,
          repoDir,
          now: TEST_NOW,
          randomFn: () => 0,
        },
      );
      assert.equal(result.pair, null, `${testCase.name} should not produce a native challenge`);
      const rejection = (result.nativeCertificationRejections || []).find((entry) => entry.modelId === alias);
      assert.ok(rejection, `${testCase.name} should have challenge rejection`);
      assert.equal(rejection!.reason, testCase.challengeReason);
    } finally {
      cleanup();
    }
  }
});

test('HOK-2569 OpenRouter implementation aliases reject when repo patch-coding opt-in is absent', () => {
  const alias = 'qwen-3-coder';
  const { repoDir, cleanup } = makeHok2569Repo(alias, { patchCodingEnabled: false });
  try {
    writeCertArtifact(repoDir, 'openrouter', alias, DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', alias],
      {
        pairId: 'HOK-2569-OPT-OUT',
        issueId: 'HOK-2569-OPT-OUT',
        slug: 'hok-2569-opt-out',
        primaryModel: 'claude-opus-4-6',
        suggestedChallengerModel: alias,
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.equal(result.pair, null);
    const rejection = (result.nativeCertificationRejections || []).find((entry) => entry.modelId === alias);
    assert.ok(rejection);
    assert.equal(rejection!.reason, 'no-native-capability');
  } finally {
    cleanup();
  }
});

test('implementation-stage native challenger is excluded without repo patch-coding opt-in', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-patch-model': nativeModelEntry('patch'),
  });
  try {
    writeCertArtifact(repoDir, 'openai', 'native-patch-model', 'v1', { phase: 'patch' });

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'native-patch-model'],
      {
        pairId: 'NC-001',
        issueId: 'NC-001',
        slug: 'nc-certified',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.equal(result.pair, null);
    const rejection = (result.nativeCertificationRejections || []).find((entry) => entry.modelId === 'native-patch-model');
    assert.ok(rejection, 'native coding challenger should be rejected');
    assert.equal(rejection!.reason, 'no-native-capability');
    assert.equal(rejection!.role, 'coder');
  } finally {
    cleanup();
  }
});

test('repo-local native challenger is ignored even with patch-coding opt-in', () => {
  const { repoDir, cleanup } = makeNativeTestRepo(
    {
      'native-patch-model': nativeModelEntry('patch'),
    },
    { patchCodingEnabled: true },
  );
  try {
    writeCertArtifact(repoDir, 'openai', 'native-patch-model', 'v1', { phase: 'patch' });

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'native-patch-model', 'claude-sonnet-4-5-20250929'],
      {
        pairId: 'NC-001B',
        issueId: 'NC-001B',
        slug: 'nc-certified-enabled',
        primaryModel: 'claude-opus-4-6',
        suggestedChallengerModel: 'native-patch-model',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair);
    assert.notEqual(result.pair!.challenger.model, 'native-patch-model');
    const rejection = (result.nativeCertificationRejections || []).find((entry) => entry.modelId === 'native-patch-model');
    assert.ok(rejection);
    assert.equal(rejection!.reason, 'no-native-capability');
  } finally {
    cleanup();
  }
});

test('uncertified native challenger excluded when artifact is missing', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-no-cert': nativeModelEntry('patch'),
  });
  try {
    // No artifact written → missing rejection

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'native-no-cert'],
      {
        pairId: 'NC-002',
        issueId: 'NC-002',
        slug: 'nc-uncertified',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    // Direct pools with only a primary and rejected native candidate cannot form a pair.
    assert.equal(result.pair, null);
    assert.equal(result.failureReason, 'selection_failed');
    assert.ok(result.nativeCertificationRejections && result.nativeCertificationRejections.length > 0,
      'should have native rejection');
    const rejection = result.nativeCertificationRejections![0];
    assert.equal(rejection.modelId, 'native-no-cert');
    assert.equal(rejection.reason, 'no-native-capability');
    assert.equal(rejection.role, 'coder');
    assert.equal(rejection.requestedPhase, 'patch');
  } finally {
    cleanup();
  }
});

test('stale native challenger excluded', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-stale': nativeModelEntry('patch'),
  });
  try {
    writeCertArtifact(repoDir, 'openai', 'native-stale', 'v1', {
      phase: 'patch',
      certifiedAt: CERT_DATE_STALE,
    });

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'native-stale', 'claude-sonnet-4-5-20250929'],
      {
        pairId: 'NC-003',
        issueId: 'NC-003',
        slug: 'nc-stale',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair);
    assert.notEqual(result.pair!.challenger.model, 'native-stale');
    const rejection = (result.nativeCertificationRejections || [])[0];
    assert.ok(rejection, 'should have native rejection');
    assert.equal(rejection.modelId, 'native-stale');
    assert.equal(rejection.reason, 'no-native-capability');
  } finally {
    cleanup();
  }
});

test('phase-insufficient native challenger excluded for plan stage', () => {
  // Plan stage requires workflow phase; this model only has patch cert.
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-patch-only': nativeModelEntry('patch'),
  });
  try {
    writeCertArtifact(repoDir, 'openai', 'native-patch-only', 'v1', { phase: 'patch' });

    const mockPlannerRoute = (): WorkflowRouteDecision => ({
      planner: 'native-patch-only',
      coder: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewRecommended: 'llm',
      expectedSuccess: 0.9,
      expectedCostPlan: 1,
      expectedCostCode: 1,
      expectedCostReview: 1,
      reasoning: [],
      signals: {},
    });

    const result = pickChallengeWorkflowsWithReason(
      ['claude-opus-4-6', 'native-patch-only'],
      {
        pairId: 'NC-004',
        issueId: 'NC-004',
        slug: 'nc-phase-insufficient',
        prompt: 'implement feature',
        challengeStage: 'plan',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
        routeFn: mockPlannerRoute,
      },
    );

    // repo-local-only native models are no longer a supported runtime input.
    const rejections = result.nativeCertificationRejections || [];
    const planRejection = rejections.find((r) => r.modelId === 'native-patch-only' && r.role === 'planner');
    assert.ok(planRejection, 'should have a rejection for native-patch-only');
    assert.equal(planRejection!.reason, 'no-native-capability');
    assert.equal(planRejection!.requestedPhase, 'workflow');
    assert.equal(planRejection!.role, 'planner');
  } finally {
    cleanup();
  }
});

test('wrong suite version produces wrong-suite rejection', () => {
  // Registry expects v2; artifact file is at v2.json but contains suiteVersion: 'v1' → mismatch.
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-wrong-suite': nativeModelEntry('patch', 'v2'),
  });
  try {
    // Write at the path the loader will look for ('v2.json') but with wrong suiteVersion inside.
    writeCertArtifact(repoDir, 'openai', 'native-wrong-suite', 'v2', {
      phase: 'patch',
      suiteVersion: 'v1',  // content says v1 but filename and registry say v2 → wrong-version
    });

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'native-wrong-suite', 'claude-sonnet-4-5-20250929'],
      {
        pairId: 'NC-005',
        issueId: 'NC-005',
        slug: 'nc-wrong-suite',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    const rejection = (result.nativeCertificationRejections || []).find(
      (r) => r.modelId === 'native-wrong-suite',
    );
    assert.ok(result.pair);
    assert.notEqual(result.pair!.challenger.model, 'native-wrong-suite');
    assert.ok(rejection, 'should have rejection for native-wrong-suite');
    assert.equal(rejection!.reason, 'no-native-capability');
  } finally {
    cleanup();
  }
});

test('native-only pool returns selection_failed with rejections populated', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-uncert-a': nativeModelEntry('patch'),
    'native-uncert-b': nativeModelEntry('patch'),
  });
  try {
    // No artifacts written → both missing

    const result = pickChallengeModelsWithReason(
      ['native-uncert-a', 'native-uncert-b'],
      {
        pairId: 'NC-006',
        issueId: 'NC-006',
        slug: 'nc-pool-exhausted',
        primaryModel: 'native-uncert-a',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.equal(result.pair, null, 'pair should be null');
    assert.equal(result.failureReason, 'selection_failed');
    const rejections = result.nativeCertificationRejections || [];
    assert.ok(rejections.length >= 2, 'both uncertified natives should be rejected');
    const rejectedIds = rejections.map((r) => r.modelId);
    assert.ok(rejectedIds.includes('native-uncert-a'));
    assert.ok(rejectedIds.includes('native-uncert-b'));
  } finally {
    cleanup();
  }
});

test('forced primary set to uncertified native falls back to random pick from pool', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-uncert': nativeModelEntry('patch'),
  });
  try {
    // No artifact → uncertified

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'claude-sonnet-4-6', 'native-uncert'],
      {
        pairId: 'NC-007A',
        issueId: 'NC-007A',
        slug: 'nc-forced-primary',
        primaryModel: 'native-uncert',   // forced primary is an uncertified native
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair, 'pair should be selected with fallback primary');
    // Primary must not be the uncertified native
    assert.notEqual(result.pair!.primary.model, 'native-uncert');
    // A rejection should be recorded for the native
    const rejections = result.nativeCertificationRejections || [];
    assert.ok(rejections.some((r) => r.modelId === 'native-uncert'), 'should record rejection for native-uncert');
  } finally {
    cleanup();
  }
});

test('workflow selection rejects uncertified native primary coder', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-uncert': nativeModelEntry('patch'),
    'native-workflow-model': nativeModelEntry('workflow'),
  });
  try {
    writeCertArtifact(repoDir, 'openai', 'native-workflow-model', 'v1', { phase: 'workflow' });

    const mockPlanRoute = (): WorkflowRouteDecision => ({
      planner: 'native-workflow-model',
      coder: 'native-uncert',
      reviewer: 'claude-opus-4-6',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewRecommended: 'llm',
      expectedSuccess: 0.9,
      expectedCostPlan: 1,
      expectedCostCode: 1,
      expectedCostReview: 1,
      reasoning: [],
      signals: {},
    });

    const result = pickChallengeWorkflowsWithReason(
      ['native-uncert', 'claude-opus-4-6', 'native-workflow-model'],
      {
        pairId: 'NC-007C',
        issueId: 'NC-007C',
        slug: 'nc-workflow-primary',
        prompt: 'implement feature',
        challengeStage: 'plan',
        primaryModel: 'native-uncert',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
        routeFn: mockPlanRoute,
      },
    );

    assert.ok(result.pair, 'pair should be selected with fallback coder');
    assert.notEqual(result.pair!.primary.model, 'native-uncert');
    assert.notEqual(result.pair!.challenger.model, 'native-uncert');
    const rejections = result.nativeCertificationRejections || [];
    assert.equal(rejections.filter((r) => r.modelId === 'native-uncert' && r.role === 'coder').length, 1);
  } finally {
    cleanup();
  }
});

test('route snapshot selection rejects uncertified native primary coder', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-uncert': nativeModelEntry('patch'),
    'native-workflow-model': nativeModelEntry('workflow'),
  });
  try {
    writeCertArtifact(repoDir, 'openai', 'native-workflow-model', 'v1', { phase: 'workflow' });

    const bootstrap: RouteArtifactSnapshot = {
      planner: 'native-workflow-model',
      coder: 'native-uncert',
      reviewer: 'claude-opus-4-6',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    };

    const result = pickChallengeWorkflowsWithContextAndReason(
      ['native-uncert', 'claude-opus-4-6', 'native-workflow-model'],
      {
        pairId: 'NC-007D',
        issueId: 'NC-007D',
        slug: 'nc-snapshot-primary',
        prompt: 'implement feature',
        challengeStage: 'plan',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
      { bootstrap, expanded: null },
    );

    assert.ok(result.pair, 'pair should be selected with fallback coder');
    assert.notEqual(result.pair!.primary.model, 'native-uncert');
    assert.notEqual(result.pair!.challenger.model, 'native-uncert');
    const rejections = result.nativeCertificationRejections || [];
    assert.equal(rejections.filter((r) => r.modelId === 'native-uncert' && r.role === 'coder').length, 1);
  } finally {
    cleanup();
  }
});

test('forced challenger set to uncertified native falls back to random pick', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-uncert': nativeModelEntry('patch'),
  });
  try {
    // No artifact → uncertified

    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'claude-sonnet-4-6', 'native-uncert'],
      {
        pairId: 'NC-007B',
        issueId: 'NC-007B',
        slug: 'nc-forced-challenger',
        primaryModel: 'claude-opus-4-6',
        suggestedChallengerModel: 'native-uncert',  // forced challenger is uncertified
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair, 'pair should be selected with fallback challenger');
    // Challenger must not be the uncertified native
    assert.notEqual(result.pair!.challenger.model, 'native-uncert');
    // A rejection should be recorded for the native
    const rejections = result.nativeCertificationRejections || [];
    assert.ok(rejections.some((r) => r.modelId === 'native-uncert'), 'should record rejection for native-uncert');
  } finally {
    cleanup();
  }
});

test('non-native pool passes through with empty rejections', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({});
  try {
    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'claude-sonnet-4-6'],
      {
        pairId: 'NC-008',
        issueId: 'NC-008',
        slug: 'nc-non-native',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );

    assert.ok(result.pair, 'pair should be selected');
    assert.ok(!result.nativeCertificationRejections || result.nativeCertificationRejections.length === 0,
      'no rejections expected for non-native pool');
  } finally {
    cleanup();
  }
});

test('phase semantics match router: native implementation is fail-closed and plan still requires workflow', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({
    'native-patch-model': nativeModelEntry('patch'),
    'native-workflow-model': nativeModelEntry('workflow'),
  });
  try {
    writeCertArtifact(repoDir, 'openai', 'native-patch-model', 'v1', { phase: 'patch' });
    writeCertArtifact(repoDir, 'openai', 'native-workflow-model', 'v1', { phase: 'workflow' });

    const implResult = pickChallengeModelsWithReason(
      ['native-patch-model', 'native-workflow-model'],
      {
        pairId: 'NC-009-I',
        issueId: 'NC-009-I',
        slug: 'nc-phase-semantics-impl',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
      },
    );
    assert.equal(implResult.pair, null);
    assert.ok((implResult.nativeCertificationRejections || []).every((entry) => entry.role === 'coder'));

    const mockPlanRoute = (): WorkflowRouteDecision => ({
      planner: 'native-workflow-model',
      coder: 'claude-opus-4-6',
      reviewer: '',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewRecommended: 'llm',
      expectedSuccess: 0.9,
      expectedCostPlan: 1,
      expectedCostCode: 1,
      expectedCostReview: 1,
      reasoning: [],
      signals: {},
    });
    const planResult = pickChallengeWorkflowsWithReason(
      ['claude-opus-4-6', 'native-patch-model', 'native-workflow-model'],
      {
        pairId: 'NC-009-P',
        issueId: 'NC-009-P',
        slug: 'nc-phase-semantics-plan',
        prompt: 'implement feature',
        challengeStage: 'plan',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
        routeFn: mockPlanRoute,
      },
    );
    const planRejections = planResult.nativeCertificationRejections || [];
    const patchRejection = planRejections.find((r) => r.modelId === 'native-patch-model' && r.role === 'planner');
    assert.ok(patchRejection, 'patch-only model should be rejected for plan stage');
    assert.equal(patchRejection!.reason, 'no-native-capability');
    assert.equal(patchRejection!.requestedPhase, 'workflow');
  } finally {
    cleanup();
  }
});

test('plan-stage challenge rejects role-ineligible forced native challenger before route expansion', () => {
  // HOK-2947 retired qwen-2.5-coder-32b; mistral-medium-3 is the remaining
  // coding-only launch-priority row that exercises the same rejection path.
  const { repoDir, cleanup } = makeNativeTestRepo({
    'mistral-medium-3': openRouterNativeModelEntry('workflow'),
  });
  try {
    writeCertArtifact(repoDir, 'mistralai', 'mistral-medium-3-5', 'v1', { phase: 'workflow' });

    const result = pickChallengeWorkflowsWithReason(
      ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'mistral-medium-3'],
      {
        pairId: 'NC-010-R',
        issueId: 'NC-010-R',
        slug: 'nc-role-ineligible-plan',
        prompt: 'plan the implementation workflow',
        challengeStage: 'plan',
        primaryModel: 'claude-opus-4-6',
        suggestedChallengerModel: 'mistral-medium-3',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
        routeFn: () => ({
          planner: 'claude-opus-4-6',
          coder: 'claude-opus-4-6',
          reviewer: 'claude-opus-4-6',
          planDepth: 'medium',
          codeDepth: 'medium',
          reviewRecommended: 'llm',
          expectedSuccess: 0.9,
          expectedCostPlan: 1,
          expectedCostCode: 1,
          expectedCostReview: 1,
          reasoning: [],
          signals: {},
        }),
      },
    );

    assert.ok(result.pair, 'eligible non-native fallback should keep plan challenge viable');
    assert.equal(result.pair!.challengeStage, 'plan');
    assert.notEqual(result.pair!.challenger.planner, 'mistral-medium-3');
    assert.equal(result.pair!.challenger.planner, 'claude-sonnet-4-5-20250929');
    const rejection = (result.nativeCertificationRejections || []).find(
      (entry) => entry.modelId === 'mistral-medium-3' && entry.role === 'planner',
    );
    assert.ok(rejection, 'role-ineligible native planner challenger must be reported');
    assert.equal(rejection!.reason, 'role-ineligible');
    assert.equal(rejection!.requestedLaunchPhase, 'planning');
    assert.equal(rejection!.nativeProvider, 'openrouter');
    assert.deepEqual(rejection!.eligibleRoles, ['coding']);
  } finally {
    cleanup();
  }
});

test('workflow-certified OpenRouter aliases remain challenge-eligible for review-stage variation', () => {
  const { repoDir, cleanup } = makeNativeTestRepo(
    {
      'glm-5.2': openRouterNativeModelEntry('workflow'),
    },
    {
      config: {
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'NC_OPENROUTER_KEY',
          },
        },
      },
      env: {
        NC_OPENROUTER_KEY: 'test-openrouter-key',
      },
    },
  );
  try {
    writeCertArtifact(repoDir, 'openrouter', 'glm-5.2', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'workflow' });

    const result = pickChallengeWorkflowsWithReason(
      ['claude-opus-4-6', 'glm-5.2'],
      {
        pairId: 'NC-010',
        issueId: 'NC-010',
        slug: 'nc-openrouter-alias',
        prompt: 'review the implementation and open the PR',
        challengeStage: 'review',
        primaryModel: 'claude-opus-4-6',
        repoDir,
        now: TEST_NOW,
        randomFn: () => 0,
        routeFn: () => ({
          planner: 'claude-opus-4-6',
          coder: 'claude-opus-4-6',
          reviewer: 'claude-opus-4-6',
          planDepth: 'medium',
          codeDepth: 'medium',
          reviewRecommended: 'llm',
          expectedSuccess: 0.9,
          expectedCostPlan: 1,
          expectedCostCode: 1,
          expectedCostReview: 1,
          reasoning: [],
          signals: {},
        }),
      },
    );

    assert.ok(result.pair, 'pair should be selected');
    assert.equal(result.pair!.challenger.reviewer, 'glm-5.2');
    assert.equal(result.pair!.challenger.reviewerAgent, 'native-openrouter');
    const reviewerRejection = (result.nativeCertificationRejections || []).find(
      (entry) => entry.modelId === 'glm-5.2' && entry.role === 'reviewer',
    );
    assert.equal(reviewerRejection, undefined);
  } finally {
    cleanup();
  }
});

test('missing OPENROUTER_API_KEY excludes OpenRouter challengers and falls back to incumbents', () => {
  const { repoDir, cleanup } = makeNativeTestRepo({}, {
    config: {
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'NC_MISSING_OPENROUTER_KEY',
          },
        },
    },
  });
  try {
    const result = pickChallengeModelsWithReason(
      ['claude-opus-4-6', 'claude-sonnet-4-6', 'qwen-3-coder'],
      {
        pairId: 'NC-011',
        issueId: 'NC-011',
        slug: 'missing-openrouter-key',
        primaryModel: 'claude-opus-4-6',
        agentMap: {
          'qwen-3-coder': 'claude',
        },
        coverage: makeCoverage({
          implementation: {
            'claude-sonnet-4-6': 3,
            'qwen-3-coder': 0,
          },
        }),
        rotationSeed: 'NC-011|implementation',
        repoDir,
        now: TEST_NOW,
        randomFn: () => {
          throw new Error('random fallback should not run');
        },
      },
    );

    assert.ok(result.pair);
    assert.equal(result.pair!.challenger.model, 'claude-sonnet-4-6');
    assert.equal(result.pair!.selectionReason, 'last-resort-incumbent');
    assert.equal(result.pair!.challengerCoverageCount, 3);
  } finally {
    cleanup();
  }
});

// --- persisted intent is one schema, not two -------------------------------
//
// The rerouting merge in wavemill-common.sh and the eval attestation in
// challenge-execution-contract.ts historically read different, incompatible
// objects that shared the field name `challengeIntent`. Whichever consumer got
// the shape it could not parse silently degraded — the merge to a no-op that
// let the expanded route replace the selected arm, the attestation to a
// permanent `undefined`. These tests pin the superset invariant.

function intentEntry(role: 'primary' | 'challenger', overrides: Record<string, string> = {}) {
  return {
    key: role === 'primary' ? 'HOK-536' : 'HOK-536_c',
    issueId: 'HOK-536',
    slug: 'credit-service',
    branch: 'task/credit-service',
    role,
    model: 'gpt-5.5',
    agent: 'codex',
    planner: 'gpt-5.6-terra',
    plannerAgent: 'codex',
    reviewer: 'gpt-5.6-terra',
    reviewerAgent: 'codex',
    planDepth: 'light',
    codeDepth: 'light',
    reviewMode: 'llm',
    ...overrides,
  } as const;
}

test('persisted intent carries both stage keys in agreement', () => {
  const intent = buildChallengeExecutionIntent({
    pairId: 'HOK-536',
    issueId: 'HOK-536',
    selectedStage: 'review',
    primary: intentEntry('primary'),
    challenger: intentEntry('challenger', { reviewer: 'kimi-k2', reviewerAgent: 'native-openrouter' }),
  });

  assert.equal(intent.selectedStage, 'review');
  assert.equal(intent.challengeStage, 'review');
});

test('persisted intent sides carry runtime and projection fields together', () => {
  const intent = buildChallengeExecutionIntent({
    pairId: 'HOK-536',
    issueId: 'HOK-536',
    selectedStage: 'review',
    primary: intentEntry('primary'),
    challenger: intentEntry('challenger', { reviewer: 'kimi-k2', reviewerAgent: 'native-openrouter' }),
  });

  const challenger = intent.challenger!;
  // Runtime half, read by the launchers.
  assert.deepEqual(challenger.reviewer, { model: 'kimi-k2', agent: 'native-openrouter' });
  assert.deepEqual(challenger.coder, { model: 'gpt-5.5', agent: 'codex' });
  // Projection half, read by the rerouting merge and eval attestation.
  assert.equal(challenger.side, 'challenger');
  assert.equal(challenger.pairId, 'HOK-536');
  assert.equal(challenger.challengeStage, 'review');
  assert.equal(challenger.expectedStageModel, 'kimi-k2');
  assert.equal(challenger.expectedStageAgent, 'native-openrouter');
  assert.equal(challenger.expectedRoute?.reviewer, 'kimi-k2');
  assert.equal(challenger.expectedRoute?.coder, 'gpt-5.5');
});

test('persisted intent projects for eval attestation without translation', () => {
  const intent = buildChallengeExecutionIntent({
    pairId: 'HOK-536',
    issueId: 'HOK-536',
    selectedStage: 'implementation',
    primary: intentEntry('primary'),
    challenger: intentEntry('challenger', { model: 'qwen-2.5-coder-32b', agent: 'native-openrouter' }),
  });

  const projection = projectChallengeIntentForPersistence(intent as never);
  assert.ok(projection, 'canonical intent must project for persistence');
  assert.equal(projection!.challengeStage, 'implementation');
  assert.equal(projection!.primary.expectedStageModel, 'gpt-5.5');
  assert.equal(projection!.challenger.expectedStageModel, 'qwen-2.5-coder-32b');
  assert.equal(projection!.challenger.expectedStageAgent, 'native-openrouter');
});

test('a runtime-only side is backfilled rather than persisted half-formed', () => {
  const intent = buildChallengeExecutionIntent({
    pairId: 'HOK-777',
    issueId: 'HOK-777',
    selectedStage: 'plan',
    primary: {
      key: 'HOK-777',
      role: 'primary',
      planner: { model: 'claude-fable-5', agent: 'claude' },
      coder: { model: 'gpt-5.5', agent: 'codex' },
      reviewer: { model: '', agent: '' },
    },
    challenger: {
      key: 'HOK-777_c',
      role: 'challenger',
      planner: { model: 'glm-5.2', agent: 'native-openrouter' },
      coder: { model: 'gpt-5.5', agent: 'codex' },
      reviewer: { model: '', agent: '' },
    },
  });

  assert.equal(intent.challenger!.expectedStageModel, 'glm-5.2');
  assert.equal(intent.challenger!.expectedStageAgent, 'native-openrouter');
  assert.equal(intent.challenger!.side, 'challenger');
  assert.equal(intent.primary!.expectedStageModel, 'claude-fable-5');
});

// ────────────────────────────────────────────────────────────────
// P0.5 Phase 0 Fork Descriptor Fields Tests (HOK-2794)
// ────────────────────────────────────────────────────────────────

test('buildChallengeExecutionIntent emits fork descriptor fields and per-side inheritedStages', () => {
  const intent = buildChallengeExecutionIntent({
    pairId: 'HOK-2794',
    issueId: 'HOK-2794',
    selectedStage: 'implementation',
    primary: intentEntry('primary'),
    challenger: intentEntry('challenger'),
  });

  assert.equal(intent.forkStage, null);
  assert.equal(intent.forkCommit, null);
  assert.equal(intent.sharedPrefix, false);
  assert.deepEqual(intent.primary!.inheritedStages, []);
  assert.deepEqual(intent.challenger!.inheritedStages, []);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
