import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getFamilyCapabilities } from './openrouter-capabilities.ts';
import type {
  ModelFamily,
  NormalizedCatalogEntry,
  NormalizedPricing,
} from './openrouter-catalog.ts';
import {
  classifyOpenRouterError,
  computeRunCostUsd,
  dispatchOpenRouterRequest,
  enforceConstraints,
  type OpenRouterTransport,
  type TokenUsage,
} from './openrouter-runtime.ts';
import { writeOpenRouterCredits } from './quota-state.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(moduleDir, '..', 'fixtures', 'openrouter-responses');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, path), 'utf-8')) as unknown;
}

function makeEntry(
  family: ModelFamily,
  overrides: Partial<NormalizedCatalogEntry> = {},
): NormalizedCatalogEntry {
  return {
    wavemillAlias: overrides.wavemillAlias ?? `${family}-test-model`,
    openrouterId: overrides.openrouterId ?? `vendor/${family}-test-model`,
    family,
    contextTokens: overrides.contextTokens ?? 16_000,
    pricing: overrides.pricing ?? { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: overrides.capabilities ?? getFamilyCapabilities(family),
    roleEligibility: overrides.roleEligibility ?? ['coding'],
    status: overrides.status ?? 'active',
    priorityTier: overrides.priorityTier ?? 1,
    resolvedAt: overrides.resolvedAt ?? '2026-07-10T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe('classifyOpenRouterError', () => {
  it('maps transport failures to provider_unavailable', () => {
    const result = classifyOpenRouterError({
      status: 0,
      body: { error: { message: 'socket hang up' } },
      transportError: new Error('socket hang up'),
    });

    assert.equal(result.category, 'provider_unavailable');
    assert.match(result.detail, /socket hang up/);
  });

  it('maps auth and rate-limit responses to auth_rate_limit', () => {
    for (const [status, fixture] of [
      [401, 'errors/auth-401.json'],
      [429, 'errors/rate-limit-429.json'],
    ] as const) {
      const result = classifyOpenRouterError({
        status,
        body: readFixture(fixture),
      });
      assert.equal(result.category, 'auth_rate_limit');
    }
  });

  it('maps 5xx responses to provider_unavailable', () => {
    const result = classifyOpenRouterError({
      status: 503,
      body: readFixture('errors/service-unavailable-503.json'),
    });

    assert.equal(result.category, 'provider_unavailable');
  });

  it('maps unsupported parameter responses to unsupported_parameter', () => {
    const result = classifyOpenRouterError({
      status: 400,
      body: readFixture('errors/unsupported-param-400.json'),
    });

    assert.equal(result.category, 'unsupported_parameter');
  });

  it('maps payment-required responses to billing_exhausted', () => {
    const result = classifyOpenRouterError({
      status: 402,
      body: {
        error: {
          message: 'This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 1123.',
        },
      },
    });

    assert.equal(result.category, 'billing_exhausted');
    assert.match(result.detail, /requires more credits/);
  });

  it('treats malformed 200 responses as model_response_error', () => {
    const result = classifyOpenRouterError({
      status: 200,
      body: readFixture('errors/malformed-200.json'),
    });

    assert.equal(result.category, 'model_response_error');
  });

  it('falls back to model_response_error for unknown statuses', () => {
    const result = classifyOpenRouterError({
      status: 418,
      body: { error: { message: 'teapot' } },
    });

    assert.equal(result.category, 'model_response_error');
    assert.match(result.detail, /teapot/);
  });
});

describe('enforceConstraints', () => {
  it('rejects requests that exceed the context window before dispatch', async () => {
    const entry = makeEntry('qwen', { contextTokens: 100 });
    let calls = 0;
    const transport: OpenRouterTransport = async () => {
      calls += 1;
      return jsonResponse(readFixture('success/qwen.json'));
    };

    const result = await dispatchOpenRouterRequest(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        estimatedTokens: 80,
        maxOutputTokens: 21,
      },
      entry,
      { apiKey: 'sk-test', transport },
    );

    assert.equal(result.status, 'blocker');
    assert.equal(result.category, 'unsupported_parameter');
    assert.equal(calls, 0);
  });

  it('allows requests on the inclusive context boundary', () => {
    const entry = makeEntry('qwen', { contextTokens: 100 });
    const result = enforceConstraints(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        estimatedTokens: 80,
        maxOutputTokens: 20,
      },
      entry,
    );

    assert.deepEqual(result, { ok: true });
  });

  it('rejects unsupported streaming, tools, and temperature', () => {
    const entry = makeEntry('qwen', {
      capabilities: {
        supportsTools: false,
        supportsStreaming: false,
        supportsTemperature: false,
      },
    });

    const streamFailure = enforceConstraints(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      },
      entry,
    );
    assert.equal(streamFailure.ok, false);

    const toolFailure = enforceConstraints(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{ type: 'function' }],
      },
      entry,
    );
    assert.equal(toolFailure.ok, false);

    const temperatureFailure = enforceConstraints(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.4,
      },
      entry,
    );
    assert.equal(temperatureFailure.ok, false);
  });
});

describe('computeRunCostUsd', () => {
  const usage: TokenUsage = { inputTokens: 2_000, outputTokens: 500 };

  it('computes cost from pricing metadata', () => {
    const pricing: NormalizedPricing = {
      inputPerMTok: 1.5,
      outputPerMTok: 3,
    };

    assert.ok(
      Math.abs((computeRunCostUsd(usage, pricing) ?? 0) - 0.0045) < 1e-12,
    );
  });

  it('returns null when pricing is incomplete', () => {
    assert.equal(
      computeRunCostUsd(usage, { inputPerMTok: null, outputPerMTok: 3 }),
      null,
    );
  });

  it('returns null when usage is missing', () => {
    assert.equal(
      computeRunCostUsd(null, { inputPerMTok: 1, outputPerMTok: 2 }),
      null,
    );
  });
});

describe('dispatchOpenRouterRequest', () => {
  it('returns a successful normalized result with cost accounting', async () => {
    const entry = makeEntry('claude', {
      wavemillAlias: 'claude-fable-5',
      openrouterId: 'anthropic/claude-fable-5',
      pricing: { inputPerMTok: 1.5, outputPerMTok: 3 },
    });
    const fixture = readFixture('success/claude.json');
    let calledUrl = '';
    let requestBody: Record<string, unknown> | null = null;

    const transport: OpenRouterTransport = async (url, init) => {
      calledUrl = url;
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(fixture);
    };

    const result = await dispatchOpenRouterRequest(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        stream: true,
        maxOutputTokens: 300,
      },
      entry,
      {
        apiKey: 'sk-test',
        baseUrl: 'https://openrouter.ai/api',
        transport,
      },
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.modelId, 'claude-fable-5');
    assert.equal(result.content, 'Claude fixture response.');
    assert.ok(Math.abs((result.costUsd ?? 0) - 0.000288) < 1e-12);
    assert.match(calledUrl, /\/v1\/chat\/completions$/);
    assert.equal(requestBody?.model, 'anthropic/claude-fable-5');
    assert.equal(requestBody?.stream, undefined);
    assert.equal(requestBody?.max_tokens, 300);
  });

  it('classifies unsupported parameters from non-OK responses', async () => {
    const entry = makeEntry('qwen');
    const transport: OpenRouterTransport = async () =>
      jsonResponse(readFixture('errors/unsupported-param-400.json'), 400);

    const result = await dispatchOpenRouterRequest(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{ type: 'function' }],
      },
      entry,
      { apiKey: 'sk-test', transport },
    );

    assert.equal(result.status, 'blocker');
    assert.equal(result.category, 'unsupported_parameter');
  });

  it('classifies transport throws as provider_unavailable', async () => {
    const entry = makeEntry('qwen');
    const transport: OpenRouterTransport = async () => {
      throw new Error('connection reset');
    };

    const result = await dispatchOpenRouterRequest(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
      },
      entry,
      { apiKey: 'sk-test', transport },
    );

    assert.equal(result.status, 'blocker');
    assert.equal(result.category, 'provider_unavailable');
  });

  it('caps max_tokens against cached affordable OpenRouter balance', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'openrouter-runtime-'));
    tempDirs.push(repoDir);
    writeOpenRouterCredits(repoDir, {
      totalCredits: 1,
      totalUsage: 0.95,
      balanceUsd: 0.05,
      usageDaily: 0,
      updatedAt: new Date().toISOString(),
      lastFetchError: null,
    });

    const entry = makeEntry('qwen', {
      pricing: { inputPerMTok: 1, outputPerMTok: 10 },
    });
    let requestBody: Record<string, unknown> | null = null;
    const transport: OpenRouterTransport = async (_url, init) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(readFixture('success/qwen.json'));
    };

    const result = await dispatchOpenRouterRequest(
      {
        modelId: entry.wavemillAlias,
        messages: [{ role: 'user', content: 'ping' }],
        maxOutputTokens: 32768,
      },
      entry,
      { apiKey: 'sk-test', transport, repoDir },
    );

    assert.equal(result.status, 'ok');
    assert.equal(requestBody?.max_tokens, 5000);
  });

  it('covers representative family success fixtures', async () => {
    const cases: Array<{
      family: ModelFamily;
      alias: string;
      openrouterId: string;
      fixture: string;
    }> = [
      {
        family: 'claude',
        alias: 'claude-fable-5',
        openrouterId: 'anthropic/claude-fable-5',
        fixture: 'success/claude.json',
      },
      {
        family: 'gpt',
        alias: 'gpt-5.5',
        openrouterId: 'openai/gpt-5.5',
        fixture: 'success/gpt.json',
      },
      {
        family: 'qwen',
        alias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        fixture: 'success/qwen.json',
      },
      {
        family: 'deepseek',
        alias: 'deepseek-r1',
        openrouterId: 'deepseek/deepseek-r1',
        fixture: 'success/deepseek.json',
      },
      {
        family: 'kimi',
        alias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        fixture: 'success/kimi.json',
      },
      {
        family: 'gemini',
        alias: 'gemini-3.1-pro-preview',
        openrouterId: 'google/gemini-3.1-pro-preview',
        fixture: 'success/gemini.json',
      },
      {
        family: 'glm',
        alias: 'glm-5.2',
        openrouterId: 'z-ai/glm-5.2',
        fixture: 'success/glm.json',
      },
    ];

    for (const testCase of cases) {
      const entry = makeEntry(testCase.family, {
        wavemillAlias: testCase.alias,
        openrouterId: testCase.openrouterId,
      });
      const transport: OpenRouterTransport = async () =>
        jsonResponse(readFixture(testCase.fixture));

      const result = await dispatchOpenRouterRequest(
        {
          modelId: entry.wavemillAlias,
          messages: [{ role: 'user', content: 'ping' }],
        },
        entry,
        { apiKey: 'sk-test', transport },
      );

      assert.equal(result.status, 'ok');
      assert.equal(result.modelId, testCase.alias);
    }
  });
});
