import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getFamilyCapabilities } from './openrouter-capabilities.ts';
import type {
  ModelFamily,
  NormalizedCatalogEntry,
} from './openrouter-catalog.ts';
import { runOpenRouterSmoke } from './openrouter-smoke.ts';
import type { OpenRouterTransport } from './openrouter-runtime.ts';

function makeEntry(
  alias: string,
  family: ModelFamily,
  openrouterId: string,
): NormalizedCatalogEntry {
  return {
    wavemillAlias: alias,
    openrouterId,
    family,
    contextTokens: 32_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: getFamilyCapabilities(family),
    roleEligibility: ['coding'],
    status: 'active',
    priorityTier: 1,
    resolvedAt: '2026-07-10T00:00:00.000Z',
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

const successFixture = {
  id: 'gen-smoke',
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'pong',
      },
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 4,
  },
};

describe('runOpenRouterSmoke', () => {
  it('returns per-model results and continues after a provider failure', async () => {
    const entries = [
      makeEntry('kimi-k2', 'kimi', 'moonshotai/kimi-k2'),
      makeEntry('qwen-3-coder', 'qwen', 'qwen/qwen3-coder'),
      makeEntry('glm-5.2', 'glm', 'z-ai/glm-5.2'),
    ];
    const transport: OpenRouterTransport = async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { model: string };
      if (payload.model === 'qwen/qwen3-coder') {
        return jsonResponse({ error: { message: 'temporary outage' } }, 500);
      }
      return jsonResponse({ ...successFixture, model: payload.model });
    };

    const results = await runOpenRouterSmoke({
      entries,
      transport,
    });

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((result) => result.status),
      ['ok', 'blocker', 'ok'],
    );
    assert.equal(results[1]?.category, 'provider_unavailable');
  });

  it('caps smoke requests to a small max output budget', async () => {
    const entries = [makeEntry('gemini-3.1-pro-preview', 'gemini', 'google/gemini-3.1-pro-preview')];
    const seenMaxTokens: unknown[] = [];
    const transport: OpenRouterTransport = async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { max_tokens?: unknown };
      seenMaxTokens.push(payload.max_tokens);
      return jsonResponse(successFixture);
    };

    await runOpenRouterSmoke({ entries, transport });

    assert.deepEqual(seenMaxTokens, [256]);
  });

  it('returns an empty list for empty input', async () => {
    const results = await runOpenRouterSmoke({
      entries: [],
    });

    assert.deepEqual(results, []);
  });

  it('records transport throws for one entry and continues', async () => {
    const entries = [
      makeEntry('glm-5.2', 'glm', 'z-ai/glm-5.2'),
      makeEntry('kimi-k2', 'kimi', 'moonshotai/kimi-k2'),
    ];
    const transport: OpenRouterTransport = async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { model: string };
      if (payload.model === 'moonshotai/kimi-k2') {
        throw new Error('socket hang up');
      }
      return jsonResponse({ ...successFixture, model: payload.model });
    };

    const results = await runOpenRouterSmoke({
      entries,
      transport,
    });

    assert.equal(results[0]?.status, 'ok');
    assert.equal(results[1]?.status, 'blocker');
    assert.equal(results[1]?.category, 'provider_unavailable');
  });
});
