/**
 * Shared fixtures for workflow-router custom harness tests.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import type { QuotaStatus } from './quota-state.ts';
import { CERTIFICATION_SCHEMA_VERSION } from './native-agent/certification/schema.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import {
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  buildGlobalCertificationPath,
  resolveCertificationSubject,
} from './native-agent/certification/index.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';

export { DEFAULT_CERTIFICATION_SUITE_VERSION };

export function createTestHarness(suiteName: string) {
  let passed = 0;
  let failed = 0;

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

  function printBanner() {
    console.log(`\n--- ${suiteName} ---\n`);
  }

  function conclude() {
    console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
    if (failed > 0) {
      process.exit(1);
    }
  }

  return { test, printBanner, conclude };
}

// Native certification validation uses wall-clock time. Keep success fixtures
// fresh relative to the test run so they do not silently become stale.
export const FRESH_CERTIFIED_AT = new Date().toISOString();

export function baseConfig() {
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
        'gpt-5.5': { inputCostPerMTok: 5, outputCostPerMTok: 30, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      },
    },
  };
}

export function stripRemovedLocalModelSettings(config: Record<string, unknown>): Record<string, unknown> {
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

export function frontierSiblingConfig() {
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
        'gpt-5.5': {
          vendor: 'openai',
          class: 'frontier',
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 92, coding: 90, review: 90, classify: 72, routing: 74 },
        },
      },
      ladders: {
        planning: ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.5', 'gpt-5.6-terra', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        coding: ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.5', 'gpt-5.6-terra', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.5', 'gpt-5.6-terra', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.5', 'gpt-5.6-terra'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.5', 'gpt-5.6-terra'],
      },
    },
  };
}

export function restoredFrontierQuotaState(status: QuotaStatus): Record<string, QuotaStatus> {
  return {
    'claude-fable-5': status,
    'deepseek-r1': status,
    'gemini-2.5-pro': status,
    'qwen-3-235b': status,
    'kimi-k2-thinking': status,
  };
}

export function makeRepo(configOverride?: Record<string, unknown>): { repoDir: string; cleanup: () => void } {
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

export function makeOpenRouterReadyRepo(configOverride: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
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

export function writeQuotaState(
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

export function writeNativeCertificationArtifact(
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

export function resolveWorkflowTestSubject(provider: string, model: string) {
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

export async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; stderr: string }> {
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

export const originalFetch = globalThis.fetch;

export function mockHokusaiFetch(strategy: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
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

/** Write a certification artifact to the test repo */
export function writeCertArtifact(
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
