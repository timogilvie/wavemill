/**
 * Tests for the Hokusai router bridge.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { classifyHokusaiFailure, DEFAULT_HOKUSAI_MODEL30_ENDPOINT, routeViaHokusai } from './hokusai-router.ts';

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

function makeRepo(configOverrides: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'hokusai-router-test-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
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
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
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
    await routeViaHokusai('Implement a backend feature with tests.', {
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
