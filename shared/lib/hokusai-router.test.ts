/**
 * Tests for the Hokusai router bridge.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { classifyHokusaiFailure, DEFAULT_HOKUSAI_MODEL30_ENDPOINT, routeViaHokusai } from './hokusai-router.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import { resolveCertificationSubject } from './native-agent/certification/identity.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  LIVE_CODING_CANARY_TTL_DAYS,
} from './native-agent/certification/schema.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeRepo(
  configOverrides: Record<string, unknown> = {},
  topLevelOverrides: Record<string, unknown> = {},
): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'hokusai-router-test-'));
  // Isolate the certification store: the native pool offered to Model 30 reads
  // the global store, so without this the request bodies would depend on
  // whatever certifications the developer happens to have run locally.
  const previousCertificationRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      ...topLevelOverrides,
      router: {
        hokusai: {
          endpoint: 'http://localhost:8080/predict',
        apiKeyEnv: 'TEST_HOKUSAI_TOKEN',
        timeout: 100,
      },
      ...configOverrides,
    },
  }));

  return {
    repoDir,
    cleanup: () => {
      if (previousCertificationRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousCertificationRoot;
      }
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

// `routeViaHokusai` evaluates certification/canary freshness against the real
// system clock, so these timestamps are derived from `Date.now()` rather than
// hardcoded: a fixed `certifiedAt`/`ranAt` would deterministically drift past
// the 60-day certification TTL / 14-day live-canary TTL and break these tests.
const CERTIFICATION_AT = new Date().toISOString();
const FRESH_CANARY_RAN_AT = new Date().toISOString();
const STALE_CANARY_RAN_AT = new Date(
  Date.now() - (LIVE_CODING_CANARY_TTL_DAYS + 1) * 24 * 60 * 60 * 1000,
).toISOString();

/** Write a fresh (or canary-stale) certification artifact for a native model. */
function writeCertification(repoDir: string, modelId: string, canaryRanAt = FRESH_CANARY_RAN_AT): void {
  const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
  const suiteVersion = capabilities?.nativeCapability?.certification?.certificationSuiteVersion;
  const provider = capabilities?.nativeCapability?.nativeProvider;
  assert.ok(suiteVersion);
  assert.ok(provider);
  const identity = resolveCertificationSubject({
    provider,
    model: modelId,
    registry: DEFAULT_MODEL_REGISTRY,
  });
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
    phase: 'workflow',
    suiteVersion,
    certifiedAt: CERTIFICATION_AT,
    scenarios: [{ scenarioId: 'native-openrouter-workflow-launch', passed: true }],
    liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: canaryRanAt }),
  }, null, 2));
}

function makeOpenRouterRepo(configOverrides: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const previousKey = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'test-openrouter-key';
  const repo = makeRepo(configOverrides, {
    providers: {
      openrouter: { enabled: true, apiKeyEnv: 'TEST_OPENROUTER_KEY' },
    },
  });
  const cleanup = repo.cleanup;
  return {
    repoDir: repo.repoDir,
    cleanup: () => {
      cleanup();
      if (previousKey === undefined) {
        delete process.env.TEST_OPENROUTER_KEY;
      } else {
        process.env.TEST_OPENROUTER_KEY = previousKey;
      }
    },
  };
}

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalToken = process.env.TEST_HOKUSAI_TOKEN;
const originalApiKey = process.env.HOKUSAI_API_KEY;

console.log('\n--- hokusai-router Tests ---\n');

await test('successful routing returns a workflow decision from the model 30 response', async () => {
  const { repoDir, cleanup } = makeRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.3-codex',
        reviewer_model: 'claude-haiku-4-5-20251001',
        stages: ['plan', 'code', 'review'],
        estimated_success_under_budget: 0.91,
        estimated_cost_usd: 2.5,
        estimated_duration_seconds: 480,
        confidence: 0.72,
      },
      alternatives: [{ coder_model: 'gpt-5.4' }],
      tradeoffs: [{ type: 'cost' }],
      nearest_neighbors: [{ id: 'n1' }],
    },
    metadata: {
      request_id: 'req-1',
      inference_log_id: 'log-1',
    },
  }), { status: 200 });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.planner, 'claude-sonnet-4-5-20250929');
    assert.equal(decision?.coder, 'gpt-5.3-codex');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
    assert.equal(decision?.planDepth, 'medium');
    assert.equal(decision?.reviewRecommended, 'llm');
    assert.equal(decision?.provenance?.requestId, 'req-1');
    assert.equal(decision?.provenance?.inferenceLogId, 'log-1');
    assert.equal(decision?.provenance?.estimatedDurationSeconds, 480);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('upgrades retired Codex IDs returned by Hokusai to supported successors', async () => {
  const { repoDir, cleanup } = makeRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'gpt-5.4',
        coder_model: 'gpt-5',
        reviewer_model: 'gpt-5.4',
        stages: ['plan', 'code', 'review'],
        estimated_success_under_budget: 0.9,
        estimated_cost_usd: 2.5,
        confidence: 0.8,
      },
    },
    metadata: {},
  }), { status: 200 });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision?.planner, 'gpt-5.6-terra');
    assert.equal(decision?.coder, 'gpt-5.6-terra');
    assert.equal(decision?.reviewer, 'gpt-5.6-terra');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('sends the nested inputs payload and prevents legacy flat payload keys', async () => {
  const { repoDir, cleanup } = makeRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  let requestBody = '';
  let authorization = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    authorization = String((init?.headers as Record<string, string>).authorization ?? '');
    return new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'planner',
          coder_model: 'coder',
          reviewer_model: 'reviewer',
          stages: ['plan', 'code', 'review'],
          estimated_success_under_budget: 0.7,
          estimated_cost_usd: 1.1,
          confidence: 0.6,
        },
      },
      metadata: {},
    }), { status: 200 });
  };

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', {
      repoDir,
      maxCostUsd: 3.25,
      plannerModels: ['planner-a'],
      coderModels: ['coder-a'],
      reviewerModels: ['reviewer-a'],
    });
    const parsed = JSON.parse(requestBody);
    assert.ok(parsed.inputs);
    assert.equal(parsed.inputs.task.description, 'Implement a backend feature with tests.');
    assert.equal(parsed.inputs.routing.max_cost_usd, 3.25);
    assert.deepEqual(parsed.inputs.routing.available_planner_models, ['planner-a']);
    assert.deepEqual(parsed.inputs.routing.available_coder_models, ['coder-a']);
    assert.deepEqual(parsed.inputs.routing.available_reviewer_models, ['reviewer-a']);
    assert.deepEqual(parsed.inputs.workflow.stages, ['plan', 'code', 'review']);
    assert.equal(parsed.schema_version, undefined);
    assert.equal(parsed.task_descriptor, undefined);
    assert.equal(parsed.available_models, undefined);
    assert.equal(parsed.constraints, undefined);
    assert.equal(authorization, 'Bearer secret-token');
    // protects: HOK-3390 — the request's max_cost_usd is recorded as an explicit budget.
    assert.deepEqual(decision?.constraints, { maxCostUsd: 3.25, budgetSource: 'request' });
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('offers certified native models to Model 30 and leaves a native recommendation intact', async () => {
  const { repoDir, cleanup } = makeOpenRouterRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  const nativeModels = ['qwen-3-coder', 'kimi-k2.7-code', 'glm-5.3', 'glm-5.3-flash'];
  for (const modelId of nativeModels) {
    writeCertification(repoDir, modelId);
  }
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'claude-sonnet-4-5-20250929',
          coder_model: 'qwen-3-coder',
          reviewer_model: 'claude-haiku-4-5-20251001',
          estimated_success_under_budget: 0.84,
          estimated_cost_usd: 1.2,
          confidence: 0.7,
        },
      },
      metadata: {},
    }), { status: 200 });
  };

  try {
    const decision = await routeViaHokusai('Add a JSON export command with tests.', { repoDir });
    const routing = JSON.parse(requestBody).inputs.routing;
    for (const modelId of nativeModels) {
      assert.ok(
        routing.available_coder_models.includes(modelId),
        `${modelId} must be offered to Model 30 as a coder candidate`,
      );
    }
    // protects: a native recommendation is not rewritten by the successor upgrade.
    assert.equal(decision?.coder, 'qwen-3-coder');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('drops a stale-canary native model from the pool and records the reason', async () => {
  const { repoDir, cleanup } = makeOpenRouterRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  writeCertification(repoDir, 'qwen-3-coder', STALE_CANARY_RAN_AT);
  writeCertification(repoDir, 'kimi-k2.7-code');
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'claude-sonnet-4-5-20250929',
          coder_model: 'claude-haiku-4-5-20251001',
          reviewer_model: 'claude-haiku-4-5-20251001',
          estimated_success_under_budget: 0.8,
          estimated_cost_usd: 1.5,
          confidence: 0.7,
        },
      },
      metadata: {},
    }), { status: 200 });
  };

  try {
    const decision = await routeViaHokusai('Add a JSON export command with tests.', { repoDir });
    const routing = JSON.parse(requestBody).inputs.routing;
    assert.ok(!routing.available_coder_models.includes('qwen-3-coder'));
    assert.ok(routing.available_coder_models.includes('kimi-k2.7-code'));
    const rejection = decision?.nativeCertificationRejections?.find(
      (entry) => entry.modelId === 'qwen-3-coder' && entry.role === 'coder',
    );
    assert.equal(rejection?.reason, 'stale-live-canary');
    // protects: the reason is visible in the route artifact, not just the pool.
    assert.ok(
      decision?.reasoning.some(
        (line) => line.includes('qwen-3-coder') && line.includes('stale-live-canary'),
      ),
      'reasoning must state why the model was rejected',
    );
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('uses the documented production endpoint when routeViaHokusai is called without an override', async () => {
  const { repoDir, cleanup } = makeRepo();
  const originalDefaultToken = process.env.HOKUSAI_API_TOKEN;
  process.env.HOKUSAI_API_TOKEN = 'secret-token';
  let endpoint = '';
  globalThis.fetch = async (input) => {
    endpoint = String(input);
    return new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'planner',
          coder_model: 'coder',
          reviewer_model: 'reviewer',
        },
      },
      metadata: {},
    }), { status: 200 });
  };

  try {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({}));
    clearConfigCache(repoDir);
    await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(endpoint, DEFAULT_HOKUSAI_MODEL30_ENDPOINT);
  } finally {
    if (originalDefaultToken === undefined) {
      delete process.env.HOKUSAI_API_TOKEN;
    } else {
      process.env.HOKUSAI_API_TOKEN = originalDefaultToken;
    }
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('missing auth fails fast and never sends a request', async () => {
  const { repoDir, cleanup } = makeRepo();
  const currentApiKey = process.env.HOKUSAI_API_KEY;
  delete process.env.TEST_HOKUSAI_TOKEN;
  delete process.env.HOKUSAI_API_KEY;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('should not call');
  };

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
    assert.equal(called, false);
  } finally {
    if (currentApiKey === undefined) {
      delete process.env.HOKUSAI_API_KEY;
    } else {
      process.env.HOKUSAI_API_KEY = currentApiKey;
    }
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('loads bearer token from repo .env using HOKUSAI_API_KEY alias', async () => {
  const { repoDir, cleanup } = makeRepo();
  delete process.env.TEST_HOKUSAI_TOKEN;
  delete process.env.HOKUSAI_API_KEY;
  writeFileSync(join(repoDir, '.env'), 'HOKUSAI_API_KEY=repo-secret\n');
  let authorization = '';
  globalThis.fetch = async (_input, init) => {
    authorization = String((init?.headers as Record<string, string>).authorization ?? '');
    return new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'planner',
          coder_model: 'coder',
          reviewer_model: 'reviewer',
        },
      },
      metadata: {},
    }), { status: 200 });
  };

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.ok(decision);
    assert.equal(authorization, 'Bearer repo-secret');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('timeout handling returns null and classifies timeout', async () => {
  const { repoDir, cleanup } = makeRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
    assert.equal(classifyHokusaiFailure(new DOMException('aborted', 'AbortError')), 'timeout');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('network errors return null and warn without leaking the token', async () => {
  const { repoDir, cleanup } = makeRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
    assert.ok(warnings.some((message) => message.includes('network_error')));
    assert.ok(warnings.every((message) => !message.includes('secret-token')));
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

for (const [status, classification] of [
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [404, 'not_found'],
  [422, 'invalid_payload'],
  [429, 'rate_limited'],
  [500, 'server_error'],
  [502, 'server_error'],
] as const) {
  await test(`HTTP ${status} returns null and classifies ${classification}`, async () => {
    const { repoDir, cleanup } = makeRepo();
    process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    globalThis.fetch = async () => new Response('error', { status });

    try {
      const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
      assert.equal(decision, null);
      assert.ok(warnings.some((message) => message.includes(classification)));
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });
}

await test('invalid success responses return null and classify invalid_response', async () => {
  const { repoDir, cleanup } = makeRepo();
  process.env.TEST_HOKUSAI_TOKEN = 'secret-token';
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
    assert.ok(warnings.some((message) => message.includes('invalid_response')));
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
globalThis.fetch = originalFetch;
console.warn = originalWarn;
if (originalToken === undefined) {
  delete process.env.TEST_HOKUSAI_TOKEN;
} else {
  process.env.TEST_HOKUSAI_TOKEN = originalToken;
}
if (originalApiKey === undefined) {
  delete process.env.HOKUSAI_API_KEY;
} else {
  process.env.HOKUSAI_API_KEY = originalApiKey;
}
if (failed > 0) {
  process.exit(1);
}
