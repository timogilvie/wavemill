/**
 * Tests for the workflow router.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import type { QuotaStatus } from './quota-state.ts';
import { applyDifficultyFloor, readTaskPromptFromFile, routeWorkflow, routeWorkflowAuto, routeWorkflowHokusai, summarizeWorkflowRoute, tryPolicyResolution, STAGE_PHASE_REQUIREMENT } from './workflow-router.ts';
import type { RouterCertificationRejection } from './workflow-router.ts';
import { CERTIFICATION_SCHEMA_VERSION } from './native-agent/certification/schema.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import {
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  buildGlobalCertificationPath,
  resolveCertificationSubject,
} from './native-agent/certification/index.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { getHarnessId, openManifest } from './resource-manifest.ts';

let passed = 0;
let failed = 0;
// Native certification validation uses wall-clock time. Keep success fixtures
// fresh relative to the test run so they do not silently become stale.
const FRESH_CERTIFIED_AT = new Date().toISOString();

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function baseConfig() {
  return {
    router: {
      enabled: true,
      mode: 'heuristic',
      defaultAgent: 'claude',
      minRecords: 4,
      minModels: 2,
    },
    eval: {
      pricing: {
        'claude-opus-4-8': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.6-terra': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
  };
}

function stripRemovedLocalModelSettings(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete sanitized.modelRegistry;

  const router = sanitized.router as Record<string, unknown> | undefined;
  if (router) {
    delete router.models;
    delete router.availableModels;
    delete router.defaultModel;
    delete router.agentMap;
  }

  const providers = sanitized.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const providerConfig of Object.values(providers)) {
      if (providerConfig && typeof providerConfig === 'object') {
        delete (providerConfig as Record<string, unknown>).models;
        delete (providerConfig as Record<string, unknown>).stages;
      }
    }
  }

  return sanitized;
}

function frontierSiblingConfig() {
  return {
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
    modelRegistry: {
      models: {
        'gpt-5.6-terra': {
          vendor: 'openai',
          class: 'frontier',
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
      },
      ladders: {
        planning: ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.6-terra', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        coding: ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.6-terra', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.6-terra', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.6-terra'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.6-terra'],
      },
    },
  };
}

function restoredFrontierQuotaState(status: QuotaStatus): Record<string, QuotaStatus> {
  return {
    'claude-fable-5': status,
    'deepseek-r1': status,
    'gemini-2.5-pro': status,
    'qwen-3-235b': status,
    'kimi-k2-thinking': status,
  };
}

function makeRepo(configOverride?: Record<string, unknown>): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'workflow-router-test-'));
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  // Pin the cross-repo aggregated path inside the fixture. It otherwise falls
  // back to the wavemill install dir, so a developer's own eval history would
  // merge into these routing decisions and diverge from CI, where that file
  // does not exist.
  const previousAggregated = process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
  process.env.WAVEMILL_AGGREGATED_EVALS_PATH = join(repoDir, '.wavemill', 'evals', 'aggregated-evals.jsonl');
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  // Must be evals.jsonl — the name readEvalRecords() looks for.
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), [
    JSON.stringify({ id: '1', modelId: 'gpt-5.3-codex', originalPrompt: 'Create a CLI command', score: 0.91, timeSeconds: 100, interventionCount: 0 }),
    JSON.stringify({ id: '2', modelId: 'gpt-5.3-codex', originalPrompt: 'Add a route tool', score: 0.88, timeSeconds: 110, interventionCount: 0 }),
    JSON.stringify({ id: '3', modelId: 'gpt-5.3-codex', originalPrompt: 'Implement a feature', score: 0.9, timeSeconds: 95, interventionCount: 1 }),
    JSON.stringify({ id: '4', modelId: 'gpt-5.3-codex', originalPrompt: 'Build a new workflow', score: 0.87, timeSeconds: 120, interventionCount: 1 }),
    JSON.stringify({ id: '5', modelId: 'gpt-5.3-codex', originalPrompt: 'Create JSON output for CLI', score: 0.89, timeSeconds: 100, interventionCount: 0 }),
    JSON.stringify({ id: '6', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Create a CLI command', score: 0.84, timeSeconds: 140, interventionCount: 0 }),
    JSON.stringify({ id: '7', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Implement a feature', score: 0.82, timeSeconds: 150, interventionCount: 0 }),
    JSON.stringify({ id: '8', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Build a new workflow', score: 0.83, timeSeconds: 135, interventionCount: 0 }),
    JSON.stringify({ id: '9', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Refactor a route command', score: 0.81, timeSeconds: 160, interventionCount: 1 }),
    JSON.stringify({ id: '10', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Fix a CLI bug', score: 0.85, timeSeconds: 145, interventionCount: 1 }),
    JSON.stringify({ id: '11', modelId: 'claude-opus-4-6', originalPrompt: 'Implement a feature', score: 0.9, timeSeconds: 220, interventionCount: 0 }),
    JSON.stringify({ id: '12', modelId: 'claude-opus-4-6', originalPrompt: 'Fix a migration bug', score: 0.93, timeSeconds: 210, interventionCount: 0 }),
    JSON.stringify({ id: '13', modelId: 'claude-opus-4-6', originalPrompt: 'Complex infrastructure update', score: 0.92, timeSeconds: 230, interventionCount: 0 }),
    JSON.stringify({ id: '14', modelId: 'claude-opus-4-6', originalPrompt: 'Secure auth flow', score: 0.94, timeSeconds: 240, interventionCount: 0 }),
    JSON.stringify({ id: '15', modelId: 'claude-opus-4-6', originalPrompt: 'Review workflow config', score: 0.91, timeSeconds: 235, interventionCount: 0 }),
    '',
  ].join('\n'));

  const config = {
    ...baseConfig(),
    ...configOverride,
  };
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(stripRemovedLocalModelSettings(config)));
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
      if (previousAggregated === undefined) {
        delete process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
      } else {
        process.env.WAVEMILL_AGGREGATED_EVALS_PATH = previousAggregated;
      }
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function makeOpenRouterReadyRepo(configOverride: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const previousKey = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'test-openrouter-key';
  const providers = (configOverride.providers as Record<string, unknown> | undefined) || {};
  const repo = makeRepo({
    ...configOverride,
    providers: {
      ...providers,
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        ...((providers.openrouter as Record<string, unknown> | undefined) || {}),
      },
    },
  });
  return {
    repoDir: repo.repoDir,
    cleanup: () => {
      repo.cleanup();
      if (previousKey === undefined) {
        delete process.env.TEST_OPENROUTER_KEY;
      } else {
        process.env.TEST_OPENROUTER_KEY = previousKey;
      }
    },
  };
}

function writeQuotaState(
  repoDir: string,
  models: Record<string, QuotaStatus>,
): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-17T12:00:00.000Z',
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
        requestHistory: [],
        consecutiveNearLimitSignals: 0,
        lastNearLimitAt: null,
        budgetSignal: null,
      }]),
    ),
  }, null, 2), 'utf-8');
}

function writeNativeCertificationArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  phase: 'read-only' | 'patch' | 'workflow',
  certifiedAt = FRESH_CERTIFIED_AT,
): void {
  const identity = resolveWorkflowTestSubject(provider, model);
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase,
    suiteVersion,
    certifiedAt,
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...(phase !== 'read-only'
      ? { liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: certifiedAt }) }
      : {}),
  }, null, 2), 'utf-8');
}

function resolveWorkflowTestSubject(provider: string, model: string) {
  const nativeProvider = provider === 'openai' ? 'openai' : 'openrouter';
  const subjectModel = provider === 'openai' || provider === 'openrouter'
    ? model
    : `${provider}/${model}`;
  return resolveCertificationSubject({
    provider: nativeProvider,
    model: subjectModel,
    registry: DEFAULT_MODEL_REGISTRY,
  });
}

async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; stderr: string }> {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return { result, stderr: output };
  } finally {
    process.stderr.write = originalWrite;
  }
}

const originalFetch = globalThis.fetch;

function mockHokusaiFetch(strategy: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'claude-haiku-4-5-20251001',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'medium',
        code_depth: 'medium',
        review_mode: 'light',
        estimated_cost_usd: 4.55,
        rationale: 'Estimated highest_reliability strategy from 0 exact route match(es) across 40 nearest Wavemill router row(s).',
        ...strategy,
      },
    },
    metadata,
  }), { status: 200 });
}

console.log('\n--- workflow-router Tests ---\n');

await test('routes broad CLI workflow work to deep planning and medium-or-higher review', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Create a wavemill route CLI command that extends the router, outputs planner coder and reviewer, prints JSON and stdout, and estimates cost and success.',
      { repoDir },
    );
    assert.equal(decision.planDepth, 'deep');
    // Capable coders for broad workflow work. Keep in sync with the top of the
    // coding ladder in model-registry.ts when new frontier models land.
    assert.ok([
      'claude-fable-5',
      'gpt-5.5',
      'gpt-5.6-terra',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
    ].includes(decision.coder));
    assert.ok(['llm', 'static+llm'].includes(decision.reviewRecommended));
    assert.ok(['medium', 'deep'].includes(decision.codeDepth));
    assert.ok(decision.expectedCostCode >= 0);
    assert.ok(decision.expectedCostPlan >= 0);
    assert.ok(decision.expectedSuccess <= 0.97 && decision.expectedSuccess >= 0.35);
    assert.ok(decision.confidence >= 0.1 && decision.confidence <= 0.95);
  } finally {
    cleanup();
  }
});

await test('stamps route decisions with harnessId when a session manifest exists', () => {
  const { repoDir, cleanup } = makeRepo();
  const previousSession = process.env.WAVEMILL_SESSION;
  try {
    process.env.WAVEMILL_SESSION = 'route-harness-session';
    openManifest('route-harness-session', { workflowType: 'feature', repoDir });

    const decision = routeWorkflow('Implement a backend workflow feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.equal(decision.harnessId, getHarnessId('route-harness-session', repoDir));
  } finally {
    if (previousSession === undefined) {
      delete process.env.WAVEMILL_SESSION;
    } else {
      process.env.WAVEMILL_SESSION = previousSession;
    }
    cleanup();
  }
});

await test('omits route harnessId when no session is active', () => {
  const { repoDir, cleanup } = makeRepo();
  const previousSession = process.env.WAVEMILL_SESSION;
  try {
    delete process.env.WAVEMILL_SESSION;
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.equal(decision.harnessId, undefined);
  } finally {
    if (previousSession === undefined) {
      delete process.env.WAVEMILL_SESSION;
    } else {
      process.env.WAVEMILL_SESSION = previousSession;
    }
    cleanup();
  }
});

await test('routes documentation work to lighter review', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update the README.md documentation for the route command and add usage examples.',
      { repoDir },
    );
    assert.equal(decision.reviewRecommended, 'static');
    assert.equal(decision.planDepth, 'light');
    assert.equal(decision.routingMode, 'heuristic');
  } finally {
    cleanup();
  }
});

await test('includes budget constraints in heuristic routing decisions when provided', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      { repoDir, maxCostUsd: 3.5 },
    );
    assert.deepEqual(decision.constraints, { maxCostUsd: 3.5 });
  } finally {
    cleanup();
  }
});

await test('heuristic routing ignores repo-local stage-specific model pools', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['gpt-5.6-terra'],
        reviewer: ['claude-sonnet-5'],
      },
    },
  });
  try {
    const decision = routeWorkflow(
      'Create a wavemill route CLI command that extends the router, outputs planner coder and reviewer, prints JSON and stdout, and estimates cost and success.',
      { repoDir, maxCostUsd: 25, skipDifficultyClassification: true }
    );
    assert.notEqual(decision.planner, 'gpt-5.6-terra');
    assert.notEqual(decision.reviewer, 'claude-sonnet-5');
  } finally {
    cleanup();
  }
});

await test('disabled DeepSeek provider does not rely on repo-local stage pools', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['deepseek-v4-pro', 'claude-sonnet-5'],
        coder: ['deepseek-v4-pro', 'claude-sonnet-5'],
        reviewer: ['deepseek-v4-pro', 'claude-sonnet-5'],
      },
    },
    providers: {
      deepseek: {
        enabled: false,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'deepseek-v4-pro': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    },
  });
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
  } finally {
    cleanup();
  }
});

await test('default routing does not surface DeepSeek without explicit opt-in', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      { repoDir, skipDifficultyClassification: true },
    );
    assert.notEqual(decision.planner, 'deepseek-v4-pro');
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
    assert.notEqual(decision.reviewer, 'deepseek-v4-flash');
  } finally {
    cleanup();
  }
});

await test('explicit modelsAvailable opt-in can return DeepSeek', () => {
  const { repoDir, cleanup } = makeRepo({
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-flash'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      {
        repoDir,
        modelsAvailable: ['deepseek-v4-flash'],
        plannerModelsAvailable: ['deepseek-v4-flash'],
        coderModelsAvailable: ['deepseek-v4-flash'],
        reviewerModelsAvailable: ['deepseek-v4-flash'],
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.planner, 'deepseek-v4-flash');
    assert.equal(decision.coder, 'deepseek-v4-flash');
    assert.equal(decision.reviewer, 'deepseek-v4-flash');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('unknown DeepSeek in repo-local stage availability is ignored', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['deepseek-v4-ultra'],
      },
    },
  });
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.planner, 'deepseek-v4-ultra');
  } finally {
    cleanup();
  }
});

await test('policy routing can return DeepSeek when explicitly configured', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      models: ['deepseek-v4-pro'],
      difficulty: {
        enabled: false,
      },
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  try {
    writeQuotaState(repoDir, {
      'claude-fable-5': 'exhausted',
      'claude-opus-4-8': 'exhausted',
      'claude-opus-4-7': 'exhausted',
      'claude-opus-4-6': 'exhausted',
      'claude-sonnet-5': 'exhausted',
      'claude-sonnet-4-6': 'exhausted',
      'claude-sonnet-4-5-20250929': 'exhausted',
      'claude-haiku-4-5-20251001': 'exhausted',
      'gpt-5.3-codex': 'exhausted',
      'gpt-5': 'exhausted',
      'gpt-5-mini': 'exhausted',
      'gpt-5.5': 'exhausted',
      'gpt-5.6-terra': 'exhausted',
      'deepseek-r1': 'exhausted',
      'deepseek-v3': 'exhausted',
      'deepseek-reasoner': 'exhausted',
      'deepseek-v4-flash': 'exhausted',
      'deepseek-v4-pro': 'healthy',
    });
    const decision = tryPolicyResolution(
      'Implement a backend workflow feature with tests.',
      { repoDir, taskDifficulty: 'moderate' },
    );
    assert.ok(decision);
    assert.equal(decision?.planner, 'deepseek-v4-pro');
    assert.equal(decision?.coder, 'deepseek-v4-pro');
    assert.equal(decision?.reviewer, 'deepseek-v4-pro');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('DeepSeek provider config does not add repo-local stage candidates', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['claude-sonnet-5'],
        coder: ['deepseek-v4-pro'],
        reviewer: ['claude-sonnet-5'],
      },
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['coder'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'deepseek-v4-pro': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('missing DeepSeek API key is not reported for ignored repo-local stage candidates', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['claude-sonnet-5'],
        coder: ['deepseek-v4-pro', 'claude-sonnet-5'],
        reviewer: ['claude-sonnet-5'],
      },
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['coder'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'deepseek-v4-pro': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  delete process.env.TEST_DEEPSEEK_KEY;
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('OpenRouter aliases in repo-local stage pools do not force selection', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['glm-5.2'],
        coder: ['kimi-k2.7-code'],
        reviewer: ['glm-5.2'],
      },
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['glm-5.2', 'kimi-k2.7-code'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'glm-5.2': { inputCostPerMTok: 0.9, outputCostPerMTok: 4.2 },
        'kimi-k2.7-code': { inputCostPerMTok: 1.2, outputCostPerMTok: 3.6 },
      },
    },
    modelRegistry: {
      models: {
        'glm-5.2': {
          vendor: 'z-ai',
          class: 'strong_generalist',
          strengths: ['planning'],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 92, coding: 84, review: 90, classify: 60 },
          contextWindowTokens: 131_072,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 0.9,
          costPerMillionOutputTokensUsd: 4.2,
          agent: 'claude-openrouter',
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FRESH_CERTIFIED_AT,
              certificationSuiteVersion: 'v1',
            },
          },
        },
        'kimi-k2.7-code': {
          vendor: 'moonshotai',
          class: 'strong_generalist',
          strengths: ['coding'],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 80, coding: 93, review: 82, classify: 58 },
          contextWindowTokens: 262_144,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 1.2,
          costPerMillionOutputTokensUsd: 3.6,
          agent: 'claude-openrouter',
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FRESH_CERTIFIED_AT,
              certificationSuiteVersion: 'v1',
            },
          },
        },
      },
    },
  });
  const originalKey = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'test-key';
  try {
    writeNativeCertificationArtifact(repoDir, 'z-ai', 'glm-5.2', 'v1', 'workflow');
    writeNativeCertificationArtifact(repoDir, 'moonshotai', 'kimi-k2.7-code', 'v1', 'workflow', FRESH_CERTIFIED_AT);

    const decision = routeWorkflow('Implement a backend workflow feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.notEqual(decision.planner, 'glm-5.2');
    assert.notEqual(decision.coder, 'kimi-k2.7-code');
    assert.notEqual(decision.reviewer, 'glm-5.2');
    assert.ok((decision.nativeCertificationRejections ?? []).some((entry) =>
      entry.nativeProvider === 'openrouter'
      && entry.requiredSuiteVersion === DEFAULT_CERTIFICATION_SUITE_VERSION
      && entry.reason === 'missing-artifact'
    ));
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_OPENROUTER_KEY;
    } else {
      process.env.TEST_OPENROUTER_KEY = originalKey;
    }
    cleanup();
  }
});

await test('heuristic routing confidence varies across prompts instead of staying constant', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const featureDecision = routeWorkflow('Implement a feature for the workflow router.', { repoDir });
    const bugfixDecision = routeWorkflow('Fix the auth migration router bug in config.ts.', { repoDir });
    assert.notEqual(featureDecision.confidence, bugfixDecision.confidence);
    assert.ok(featureDecision.confidence >= 0.1 && featureDecision.confidence <= 0.95);
    assert.ok(bugfixDecision.confidence >= 0.1 && bugfixDecision.confidence <= 0.95);
  } finally {
    cleanup();
  }
});

await test('reads selected-task style json files', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const filePath = join(repoDir, 'selected-task.json');
    writeFileSync(filePath, JSON.stringify({
      title: 'Create route command',
      description: 'Add JSON output and CLI wiring.',
    }));
    assert.equal(readTaskPromptFromFile(filePath), 'Create route command\n\nAdd JSON output and CLI wiring.');
  } finally {
    cleanup();
  }
});

await test('reads markdown task-packet files without JSON parsing', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const filePath = join(repoDir, 'task-packet.md');
    writeFileSync(filePath, '# Task Packet\n\n## 1. Objective\n\nRoute against this content.\n');
    assert.equal(readTaskPromptFromFile(filePath), '# Task Packet\n\n## 1. Objective\n\nRoute against this content.');
  } finally {
    cleanup();
  }
});

await test('summary output includes stage lines and success', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow('Build a new CLI tool with JSON output and review support.', { repoDir });
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Planner:/);
    assert.match(summary, /Coder:/);
    assert.match(summary, /Reviewer:/);
    assert.match(summary, /Success:/);
    assert.match(summary, /confidence=\d+\.\d{2}/);
  } finally {
    cleanup();
  }
});

await test('auto mode uses hokusai first when configured', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.6-terra',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'medium',
        code_depth: 'medium',
        review_mode: 'light',
        estimated_success_under_budget: 0.88,
        estimated_cost_usd: 1.75,
        confidence: 0.81,
        rationale: 'Estimated highest_reliability strategy from 0 exact route match(es) across 40 nearest Wavemill router row(s).',
      },
    },
    metadata: {},
  }), { status: 200 });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.equal(decision.routingMode, 'hokusai');
    assert.equal(decision.coder, 'gpt-5.6-terra');
    assert.equal(decision.neighborCount, 40);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode rejects disabled hokusai model selections', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.3-codex',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'medium',
        code_depth: 'medium',
        review_mode: 'light',
        estimated_success_under_budget: 0.88,
        estimated_cost_usd: 1.75,
        confidence: 0.81,
      },
    },
    metadata: {},
  }), { status: 200 });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
    assert.notEqual(decision.coder, 'gpt-5.3-codex');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('low expected success escalates cheap hokusai coder when budget allows', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    confidence: 0.8,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.outcome, 'escalated');
    assert.equal(decision.provenance?.escalation?.initialRoute.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.finalRoute.coder, decision.coder);
    assert.deepEqual(
      decision.provenance?.escalation?.triggers.map((trigger) => trigger.metric),
      ['expectedSuccess'],
    );
    assert.ok(decision.provenance?.escalation?.finalRoute.cost ?? Infinity <= 25);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('low confidence independently escalates when expected success is above floor', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  mockHokusaiFetch({
    estimated_success_under_budget: 0.8,
    confidence: 0.29,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.outcome, 'escalated');
    assert.deepEqual(
      decision.provenance?.escalation?.triggers.map((trigger) => trigger.metric),
      ['confidence'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('low success at budget ceiling keeps original route and records affordability reason', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    estimated_cost_usd: 0.01,
    confidence: 0.8,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 0.01,
    });
    assert.equal(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.outcome, 'no_affordable_stronger_candidate');
    assert.match(decision.provenance?.escalation?.reason ?? '', /budget/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('escalation floors are strict and do not trigger at equality', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  mockHokusaiFetch({
    estimated_success_under_budget: 0.5,
    confidence: 0.4,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.equal(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('escalation can be disabled by router config', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      escalation: { enabled: false },
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    confidence: 0.29,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.equal(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode falls back to stage-aware chain without hokusai config', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
  } finally {
    cleanup();
  }
});

await test('auto mode uses degraded haiku-only routing in survival mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'exhausted',
    'gpt-5.6-terra': 'exhausted',
    ...restoredFrontierQuotaState('exhausted'),
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    const selectedModels = [decision.planner, decision.coder, decision.reviewer];

    assert.ok(selectedModels.every((modelId) => modelId.toLowerCase().includes('haiku')));
    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('opus')));
    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('sonnet')));
    assert.match(decision.reasoning[0], /Survival mode/);
    assert.equal(typeof decision.planner, 'string');
    assert.equal(typeof decision.coder, 'string');
    assert.equal(typeof decision.reviewer, 'string');
    assert.ok(['stage-aware', 'stage-aware-partial', 'heuristic-fallback'].includes(decision.routingMode));
    assert.equal(typeof decision.neighborCount, 'number');
    assert.ok(Array.isArray(decision.neighborSimilarityRange));
  } finally {
    cleanup();
  }
});

await test('auto mode excludes opus in constrained mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    const selectedModels = [decision.planner, decision.coder, decision.reviewer];

    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('opus')));
    assert.match(decision.reasoning[0], /Constrained mode/);
  } finally {
    cleanup();
  }
});

await test('auto mode emits a constrained router transparency line when quota is degrading', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] constrained mode: claude-fable-5 quota is degrading; reserving it for high-complexity steps/);
    assert.ok(result.reasoning[0].includes('Constrained mode'));
  } finally {
    cleanup();
  }
});

await test('auto mode does not prepend degraded reasoning in normal mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'healthy',
    'claude-opus-4-6': 'healthy',
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.doesNotMatch(decision.reasoning[0], /Survival mode|Constrained mode/);
  } finally {
    cleanup();
  }
});

await test('auto mode stays silent in normal routing mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'healthy',
    'claude-opus-4-6': 'healthy',
  });

  try {
    const { stderr } = await captureStderr(() =>
      routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir })
    );
    assert.doesNotMatch(stderr, /\[(router|coder|planner|reviewer|classifier)]/);
  } finally {
    cleanup();
  }
});

await test('policy routing excludes retired frontier from substitution', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      Promise.resolve(tryPolicyResolution(
        'Implement a backend feature with tests and review.',
        { repoDir, taskDifficulty: 'hard', skipDifficultyClassification: true }
      ))
    );
    assert.equal(result?.routingMode, 'policy');
    assert.match(stderr, /\[coder] policy adjustment: claude-fable-5 -> claude-sonnet-5 \(quota=exhausted\)/);
    assert.doesNotMatch(stderr, /gpt-5\.5/);
    assert.doesNotMatch(stderr, /same-class=frontier/);
    assert.doesNotMatch(stderr, /\[router] constrained mode:/);
  } finally {
    cleanup();
  }
});

await test('policy routing logs class downgrade without same-class metadata', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const { stderr } = await captureStderr(() =>
      Promise.resolve(tryPolicyResolution(
        'Implement a backend feature with tests and review.',
        { repoDir, taskDifficulty: 'hard', skipDifficultyClassification: true }
      ))
    );
    assert.match(stderr, /\[(planner|coder|reviewer)] policy adjustment: claude-fable-5 -> claude-sonnet-5 \(quota=degrading\)/);
    assert.doesNotMatch(stderr, /same-class=/);
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution records capability fallback rationale when constraints over-filter Layer 3', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      capabilityFiltering: {
        enabled: true,
      },
    },
  });

  writeQuotaState(repoDir, {});

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'moderate',
      skipDifficultyClassification: true,
      capabilityConstraints: {
        minContextWindow: 2_000_000,
      },
    });

    assert.equal(decision?.routingMode, 'policy');
    assert.ok(decision?.reasoning.some((line) => line.includes('Capability constraints filtered every in-pool policy candidate')));
  } finally {
    cleanup();
  }
});

await test('auto mode logs frontier substitution without constrained banner when healthy sibling exists', async () => {
  const { repoDir, cleanup } = makeRepo({
    ...frontierSiblingConfig(),
    router: {
      ...frontierSiblingConfig().router,
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
  });

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'gpt-5.6-terra',
          coder_model: 'gpt-5.6-terra',
          reviewer_model: 'gpt-5.6-terra',
          plan_depth: 'medium',
          code_depth: 'medium',
          review_mode: 'light',
          estimated_success_under_budget: 0.88,
          estimated_cost_usd: 1.75,
          confidence: 0.81,
        },
      },
      metadata: {},
    }), { status: 200 });
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.equal(result.routingMode, 'hokusai');
    assert.doesNotMatch(stderr, /policy adjustment:/);
    assert.doesNotMatch(stderr, /\[router] constrained mode:/);
    assert.doesNotMatch(result.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode excludes retired frontier when anthropic frontier is exhausted', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
  });

  try {
    const decision = await routeWorkflowAuto('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'hard',
      skipDifficultyClassification: true,
    });
    assert.equal(decision.planner, 'gpt-5.6-terra');
    assert.equal(decision.coder, 'claude-sonnet-5');
    assert.equal(decision.reviewer, 'gpt-5.6-terra');
    assert.ok(![decision.planner, decision.coder, decision.reviewer].includes('gpt-5.5'));
    assert.doesNotMatch(decision.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution pools exclude retired frontier for all three roles', () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
  });

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'hard',
      skipDifficultyClassification: true,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.planner, 'gpt-5.6-terra');
    assert.equal(decision?.coder, 'claude-sonnet-5');
    assert.equal(decision?.reviewer, 'gpt-5.6-terra');
    assert.ok(![decision?.planner, decision?.coder, decision?.reviewer].includes('gpt-5.5'));
  } finally {
    cleanup();
  }
});

await test('emits supported substitutions without selecting the retired frontier in case (a)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      })
    );
    assert.equal(result.planner, 'gpt-5.6-terra');
    assert.equal(result.coder, 'claude-sonnet-5');
    assert.equal(result.reviewer, 'gpt-5.6-terra');
    assert.match(stderr, /\[planner] policy adjustment: claude-fable-5 -> gpt-5\.6-terra \(quota=exhausted\)/);
    assert.match(stderr, /\[coder] policy adjustment: claude-fable-5 -> claude-sonnet-5 \(quota=exhausted\)/);
    assert.doesNotMatch(stderr, /gpt-5\.5/);
    assert.doesNotMatch(stderr, /\[router] (constrained|survival) mode:/);
    assert.doesNotMatch(result.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    cleanup();
  }
});

await test('emits constrained-mode banner when every frontier vendor is degrading (case b)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] constrained mode: .* quota is degrading; reserving it for high-complexity steps/);
    assert.ok(result.reasoning[0].includes('Constrained mode'));
    assert.doesNotMatch(stderr, /same-class=frontier/);
  } finally {
    cleanup();
  }
});

await test('emits survival-mode banner when every frontier vendor is exhausted (case c)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'exhausted',
    'gpt-5.6-terra': 'exhausted',
    ...restoredFrontierQuotaState('exhausted'),
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] survival mode: .* quota is exhausted; restricting routing to fast-economy models/);
    assert.ok(result.reasoning[0].includes('Survival mode'));
    assert.ok([result.planner, result.coder, result.reviewer].every((modelId) => modelId.toLowerCase().includes('haiku')));
    assert.doesNotMatch(stderr, /same-class=frontier/);
  } finally {
    cleanup();
  }
});

await test('explicit hokusai mode falls back gracefully to stage-aware', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'hokusai',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 100,
      },
    },
  });

  globalThis.fetch = async () => {
    throw new Error('unreachable');
  };

  try {
    const decision = await routeWorkflowHokusai('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// Difficulty integration tests
// ────────────────────────────────────────────────────────────────

await test('routeWorkflow with taskDifficulty=hard never returns haiku as coder', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Fix a small UI bug.',
      {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      },
    );
    assert.ok(
      !decision.coder.toLowerCase().includes('haiku'),
      `Expected non-haiku coder for hard task, got ${decision.coder}`,
    );
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=critical includes difficulty in reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update the payment processing module.',
      {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      },
    );
    const hasDifficultyReasoning = decision.reasoning.some(
      (r) => r.includes('critical'),
    );
    assert.ok(hasDifficultyReasoning, `Expected difficulty in reasoning, got: ${decision.reasoning.join(' | ')}`);
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=trivial does not add floor restriction to reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Fix a typo.',
      {
        repoDir,
        taskDifficulty: 'trivial',
        skipDifficultyClassification: true,
      },
    );
    // Trivial difficulty should mention the floor in reasoning (floor applied = true for trivial)
    const hasTrivialReasoning = decision.reasoning.some((r) => r.includes('trivial'));
    assert.ok(hasTrivialReasoning, `Expected trivial in reasoning: ${decision.reasoning.join(' | ')}`);
    // Trivial difficulty floor allows haiku — no upgrade warnings, coder can be any model
    assert.equal(decision.signals.taskDifficulty, 'trivial');
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=hard includes taskDifficulty in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Refactor the database layer.',
      {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.signals.taskDifficulty, 'hard');
  } finally {
    cleanup();
  }
});

await test('summarizeWorkflowRoute includes difficulty when present in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update critical payment service.',
      {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      },
    );
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /difficulty=critical/);
  } finally {
    cleanup();
  }
});

await test('applyDifficultyFloor upgrades haiku to opus for critical difficulty (not sonnet)', () => {
  const pool = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
  const criticalFloor = { allowHaiku: false, preferSonnet: false, preferOpus: true };
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', criticalFloor, pool, 'coder');
  assert.ok(
    result.toLowerCase().includes('opus'),
    `Expected opus upgrade for critical+haiku, got ${result}`,
  );
  assert.ok(
    !result.toLowerCase().includes('sonnet'),
    `Critical floor should prefer opus over sonnet, got ${result}`,
  );
});

await test('repo-local registry-only model addition is ignored by heuristic routing', () => {
  const { repoDir, cleanup } = makeRepo({
    modelRegistry: {
      models: {
        'acme-frontier-1': {
          vendor: 'acme',
          class: 'frontier',
          strengths: ['planning'],
          weaknesses: [],
          qualityScores: { planning: 99, coding: 99, review: 99, classify: 50, routing: 50 },
        },
      },
      ladders: {
        planning: ['acme-frontier-1', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      },
    },
  });
  try {
    const decision = routeWorkflow(
      'Plan a complex infrastructure migration across services with database changes and a security review.',
      { repoDir, skipDifficultyClassification: true },
    );
    assert.equal(decision.planDepth, 'deep');
    assert.notEqual(decision.planner, 'acme-frontier-1');
  } finally {
    cleanup();
  }
});

await test('routeWorkflow without difficulty options has no taskDifficulty in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Simple feature implementation.',
      {
        repoDir,
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.signals.taskDifficulty, undefined);
  } finally {
    cleanup();
  }
});

await test('enforces budget and downgrades when possible', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // Note: $1.00 budget may or may not require downgrade depending on default model costs.
    // This test verifies budget enforcement works correctly in both cases.
    const decision = routeWorkflow(
      'Implement a new feature',
      { repoDir, maxCostUsd: 1.00 }
    );

    // Final cost after routing (reflects any successful downgrade)
    const totalCost = decision.expectedCostPlan +
                     decision.expectedCostCode +
                     decision.expectedCostReview;

    // Budget enforcement should result in: downgrade succeeded OR violation reported
    if (decision.budgetViolation) {
      // Downgrade failed - verify violation is properly reported
      assert.ok(decision.budgetViolation.attemptedDowngrade);
      assert.ok(decision.budgetViolation.requestedCost > 1.00);
      assert.ok(decision.reasoning.some(r => r.includes('BUDGET VIOLATION')));
    } else {
      // Downgrade succeeded or not needed - verify cost is within budget
      assert.ok(totalCost <= 1.00, `Total cost ${totalCost} should be under $1.00`);
      if (decision.reasoning.some(r => r.includes('downgrade'))) {
        // If downgrade happened, it must have brought cost within budget
        assert.ok(totalCost <= 1.00, 'Downgrade should result in cost within budget');
      }
    }
  } finally {
    cleanup();
  }
});

await test('reports budget violation when impossible', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Complex infrastructure update requiring deep planning',
      { repoDir, maxCostUsd: 0.001 } // Impossibly tight - even cheaper than cheapest option
    );

    assert.ok(decision.budgetViolation, 'Should have budget violation');
    assert.equal(decision.budgetViolation.attemptedDowngrade, true);
    assert.ok(decision.budgetViolation.requestedCost > 0.001);
    assert.ok(decision.reasoning.some(r => r.includes('BUDGET VIOLATION')));
  } finally {
    cleanup();
  }
});

await test('uses survival mode budget when in survival', () => {
  const { repoDir, cleanup } = makeRepo({
    router: baseConfig().router,
    eval: baseConfig().eval,
    budget: {
      normalMode: 25,
      constrainedMode: 15,
      survivalMode: 5,
    }
  });

  // Write quota state showing survival mode
  writeQuotaState(repoDir, {
    'gpt-5.5': 'exhausted',
    'gpt-5.6-terra': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    ...restoredFrontierQuotaState('exhausted'),
  });

  try {
    const decision = routeWorkflow('Implement a feature', { repoDir });

    // Should use $5 survival budget, not $25 normal
    const totalCost = decision.expectedCostPlan +
                     decision.expectedCostCode +
                     decision.expectedCostReview;

    assert.ok(totalCost <= 5 || decision.budgetViolation);
    if (decision.budgetViolation) {
      assert.equal(decision.budgetViolation.operatingMode, 'survival');
      assert.equal(decision.budgetViolation.maxCostUsd, 5);
    }
  } finally {
    cleanup();
  }
});

await test('includes budget rule in reasoning when triggered', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Complex infrastructure update',
      { repoDir, maxCostUsd: 0.20 } // Tight enough to trigger downgrade
    );

    // Should have budget reasoning since we're constraining the cost
    const hasBudgetReasoning = decision.reasoning.some(r =>
      r.includes('budget') || r.includes('downgrade')
    );

    assert.ok(hasBudgetReasoning, 'Should mention budget in reasoning');
  } finally {
    cleanup();
  }
});


await test('tryPolicyResolution samples non-argmax candidates when exploration is enabled', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      exploration: { enabled: true, mode: 'epsilon', rate: 1, topK: 2 },
    },
  });
  writeQuotaState(repoDir, {});

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'moderate',
      skipDifficultyClassification: true,
      randomFn: () => 0,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.exploration?.mode, 'epsilon');
    assert.ok((decision?.exploration?.explored.length ?? 0) > 0);
    for (const entry of decision?.exploration?.explored ?? []) {
      assert.notEqual(entry.sampled, entry.argmax);
    }
    assert.ok(decision?.reasoning[0].startsWith('exploration(epsilon'));
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution stays deterministic with exploration disabled', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });
  writeQuotaState(repoDir, {});

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'moderate',
      skipDifficultyClassification: true,
      randomFn: () => 0,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.exploration, undefined);
    assert.ok(!decision?.reasoning.some((line) => line.startsWith('exploration(')));
  } finally {
    cleanup();
  }
});


// ===========================
// Native Certification Router Policy Tests
// ===========================

/** Write a certification artifact to the test repo */
function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  overrides: Record<string, unknown> = {},
): void {
  const identity = resolveWorkflowTestSubject(provider, model);
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
    certifiedAt: FRESH_CERTIFIED_AT,
    scenarios: [{ scenarioId: 's1', passed: true }],
    // HOK-2943: coder eligibility requires live canary evidence in addition
    // to the deterministic phase; canary-negative cases override liveCanary.
    ...((overrides.phase ?? 'patch') !== 'read-only'
      ? { liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: FRESH_CERTIFIED_AT }) }
      : {}),
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact));
}

console.log('\n--- Native Certification Router Policy Tests ---\n');

await test('STAGE_PHASE_REQUIREMENT maps reviewer→read-only, coder→patch, planner→workflow', () => {
  assert.equal(STAGE_PHASE_REQUIREMENT.reviewer, 'read-only');
  assert.equal(STAGE_PHASE_REQUIREMENT.coder, 'patch');
  assert.equal(STAGE_PHASE_REQUIREMENT.planner, 'workflow');
});

await test('valid read-only cert accepted for reviewer role', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'read-only' });

    const decision = routeWorkflow('Fix a small bug in the router.', {
      repoDir,
      reviewerModelsAvailable: ['qwen-3-coder'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    // reviewer pool had a valid read-only cert — no rejection for reviewer
    const reviewerRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'reviewer');
    assert.equal(reviewerRejection, undefined, 'valid read-only cert should not be rejected for reviewer');
  } finally {
    cleanup();
  }
});

await test('valid patch cert accepted for coder and reviewer roles', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });

    const decision = routeWorkflow('Implement a feature with tests.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder'],
      reviewerModelsAvailable: ['qwen-3-coder'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const coderRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    const reviewerRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'reviewer');
    assert.equal(coderRejection, undefined, 'patch cert should not be rejected for coder');
    assert.equal(reviewerRejection, undefined, 'patch cert satisfies read-only, should not be rejected for reviewer');
  } finally {
    cleanup();
  }
});

await test('patch cert rejects planner role which requires workflow certification', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'z-ai', 'glm-5.2', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });

    const decision = routeWorkflow('Plan and implement a new auth workflow.', {
      repoDir,
      plannerModelsAvailable: ['glm-5.2', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['glm-5.2', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const plannerRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'glm-5.2' && r.role === 'planner');
    assert.ok(plannerRejection, 'patch-cert native model should be rejected for planner (requires workflow)');
    assert.equal(plannerRejection?.reason, 'insufficient-phase');
    assert.equal(plannerRejection?.requestedPhase, 'workflow');
    assert.notEqual(decision.planner, 'glm-5.2', 'planner must not be the rejected native model');
  } finally {
    cleanup();
  }
});

await test('launch-priority roleEligibility removes coding-only aliases from planner pool with diagnostics', () => {
  // mistral-medium-3 is the remaining coding-only launch-priority row
  // (qwen-2.5-coder-32b was retired by HOK-2947).
  const previousApiKey = process.env.HOK2540_OPENROUTER_KEY;
  process.env.HOK2540_OPENROUTER_KEY = 'test-openrouter-key';
  const { repoDir, cleanup } = makeRepo({
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'HOK2540_OPENROUTER_KEY',
        models: ['mistral-medium-3'],
        stages: ['planner'],
      },
    },
    modelRegistry: {
      models: {
        'mistral-medium-3': {
          class: 'strong_generalist',
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FRESH_CERTIFIED_AT,
              certificationSuiteVersion: 'v1',
            },
          },
        },
      },
    },
  });
  try {
    writeCertArtifact(repoDir, 'mistralai', 'mistral-medium-3-5', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'workflow' });

    const decision = routeWorkflow('Plan a new multi-stage workflow.', {
      repoDir,
      plannerModelsAvailable: ['mistral-medium-3', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['mistral-medium-3', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    assert.notEqual(decision.planner, 'mistral-medium-3');
    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'mistral-medium-3' && r.role === 'planner');
    assert.ok(rejection, 'coding-only planner candidate must be rejected before selection');
    assert.equal(rejection?.reason, 'role-ineligible');
    assert.equal(rejection?.requestedLaunchPhase, 'planning');
    assert.equal(rejection?.nativeProvider, 'openrouter');
    assert.deepEqual(rejection?.eligibleRoles, ['coding']);
    assert.ok(
      decision.reasoning.some((line) => (
        line.includes('mistral-medium-3')
        && line.includes('role-ineligible')
        && line.includes('provider=openrouter')
        && line.includes('eligibleRoles=coding')
      )),
      'router reasoning should include role/provider eligibility diagnostics',
    );
  } finally {
    cleanup();
    if (previousApiKey === undefined) {
      delete process.env.HOK2540_OPENROUTER_KEY;
    } else {
      process.env.HOK2540_OPENROUTER_KEY = previousApiKey;
    }
  }
});

await test('missing artifact rejects native model and routes to non-native fallback', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // Intentionally do NOT write any cert artifact

    const decision = routeWorkflow('Build a new CLI tool.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const coderRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(coderRejection, 'missing artifact must produce a rejection record');
    assert.equal(coderRejection?.reason, 'missing-artifact');
    assert.notEqual(decision.coder, 'qwen-3-coder', 'coder must fall back to non-native model');
    assert.ok(
      decision.reasoning.some((line) => line.includes('qwen-3-coder') && line.includes('missing')),
      'reasoning should mention the rejected native model',
    );
  } finally {
    cleanup();
  }
});

await test('stale artifact rejects native model', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // Cert older than 60 days from now (2026-06-30)
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
      phase: 'patch',
      certifiedAt: '2020-01-01T00:00:00.000Z',
    });

    const decision = routeWorkflow('Implement a feature.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'stale cert must produce a rejection');
    assert.equal(rejection?.reason, 'stale');
    assert.notEqual(decision.coder, 'qwen-3-coder');
  } finally {
    cleanup();
  }
});

await test('wrong suite version rejects native model', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
      phase: 'patch',
      suiteVersion: 'v1',
    });

    const decision = routeWorkflow('Fix a router bug.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'suite version mismatch must produce a rejection');
    assert.equal(rejection?.reason, 'wrong-suite');
    assert.notEqual(decision.coder, 'qwen-3-coder');
  } finally {
    cleanup();
  }
});

await test('malformed artifact rejects native model', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    const certPath = buildGlobalCertificationPath('qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION);
    mkdirSync(dirname(certPath), { recursive: true });
    // Write an incomplete / structurally invalid artifact
    writeFileSync(certPath, JSON.stringify({ schemaVersion: 1, provider: 'openai' }));

    const decision = routeWorkflow('Refactor a service.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'malformed artifact must produce a rejection');
    assert.equal(rejection?.reason, 'malformed');
    assert.notEqual(decision.coder, 'qwen-3-coder');
  } finally {
    cleanup();
  }
});

await test('native-only ineligible pool is rejected fail-closed, not silently treated as eligible', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // No cert artifact written — native model will be rejected

    const decision = routeWorkflow('Build a feature.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder'],
      modelsAvailable: ['qwen-3-coder'],
      skipDifficultyClassification: true,
    });

    assert.equal(decision.coder, '', 'route should surface an empty coder slot when no eligible candidates remain');
    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'rejection must be recorded even when no fallback exists in the pool');
    assert.equal(rejection?.reason, 'missing-artifact');
    assert.ok(
      decision.reasoning.some((line) => line.includes('No eligible coder models remain')),
      'reasoning should surface the empty eligible pool failure',
    );
  } finally {
    cleanup();
  }
});

await test('repo-local openrouter-only model metadata is ignored by fallback routing', () => {
  const { repoDir, cleanup } = makeRepo({
    modelRegistry: {
      models: {
        'legacy-mistral-openrouter': {
          class: 'strong_generalist',
          vendor: 'mistral',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 70, coding: 70, review: 70, classify: 60 },
          contextWindowTokens: 128_000,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 2,
          costPerMillionOutputTokensUsd: 6,
          agent: 'claude-openrouter',
        },
      },
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['legacy-mistral-openrouter'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
  });
  const originalKey = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'test-key';
  try {
    const decision = routeWorkflow('Plan a workflow feature.', {
      repoDir,
      plannerModelsAvailable: ['legacy-mistral-openrouter'],
      modelsAvailable: ['legacy-mistral-openrouter'],
      skipDifficultyClassification: true,
    });

    assert.equal(decision.planner, 'legacy-mistral-openrouter');
    assert.equal(decision.nativeCertificationRejections?.length ?? 0, 0);
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_OPENROUTER_KEY;
    } else {
      process.env.TEST_OPENROUTER_KEY = originalKey;
    }
    cleanup();
  }
});

await test('diagnostics contain modelId, role, requestedPhase, nativeCapability, requiredSuiteVersion, and reason', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // No artifact — triggers missing rejection

    const decision = routeWorkflow('Implement a workflow feature.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder');
    assert.ok(rejection, 'expected a rejection record');

    // Verify all required diagnostic fields
    assert.equal(typeof rejection?.modelId, 'string');
    assert.equal(typeof rejection?.role, 'string');
    assert.equal(typeof rejection?.requestedPhase, 'string');
    assert.equal(typeof rejection?.nativeCapability, 'string');
    assert.equal(typeof rejection?.requiredSuiteVersion, 'string');
    assert.equal(typeof rejection?.reason, 'string');

    assert.equal(rejection?.nativeCapability, 'certified');
    assert.equal(rejection?.requiredSuiteVersion, DEFAULT_CERTIFICATION_SUITE_VERSION);
  } finally {
    cleanup();
  }
});

await test('non-native models are unaffected by native certification filter', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow('Implement a new feature with tests.', {
      repoDir,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    assert.equal(
      (decision.nativeCertificationRejections ?? []).length,
      0,
      'non-native models should produce zero native certification rejections',
    );
  } finally {
    cleanup();
  }
});

await test('routeWorkflow records shared packet signals in route provenance', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const packet = readFileSync(
      join(process.cwd(), 'tests', 'fixtures', 'router-signal-corpus', 'hok-2845-greenfield.md'),
      'utf-8',
    );
    const decision = routeWorkflow(packet, {
      repoDir,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    assert.equal(decision.signals.taskType, 'feature');
    assert.equal(decision.signals.complexityScore, 5);
    assert.equal(decision.signals.complexityBand, 'xl');
    assert.ok(decision.signals.riskFlags?.includes('greenfield'));
    assert.equal(decision.provenance?.signalVector?.taskType, 'feature');
    assert.equal(decision.provenance?.signalVector?.complexityScore, 5);
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
