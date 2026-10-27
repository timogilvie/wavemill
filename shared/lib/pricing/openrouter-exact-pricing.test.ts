import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fetchOpenRouterExactCosts, isExactPricingEnabled } from './openrouter-exact-pricing.ts';

describe('isExactPricingEnabled', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  it('defaults to whether an OpenRouter key is configured', () => {
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(isExactPricingEnabled(), false);
    process.env.OPENROUTER_API_KEY = 'sk-test';
    assert.equal(isExactPricingEnabled(), true);
  });

  it('lets an explicit flag win over the key', () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    assert.equal(isExactPricingEnabled({ enabled: false }), false);
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(isExactPricingEnabled({ enabled: true }), true);
  });
});

describe('fetchOpenRouterExactCosts', () => {
  it('returns undefined without fetching when disabled or there is nothing to look up', async () => {
    let calls = 0;
    const fetchGenerationCost = async () => {
      calls++;
      return { totalCostUsd: 1 };
    };
    assert.equal(await fetchOpenRouterExactCosts(['gen-1'], { enabled: false, fetchGenerationCost }), undefined);
    assert.equal(await fetchOpenRouterExactCosts([], { enabled: true, fetchGenerationCost }), undefined);
    assert.equal(await fetchOpenRouterExactCosts([''], { enabled: true, fetchGenerationCost }), undefined);
    assert.equal(calls, 0);
  });

  it('fetches each unique id once and keeps only resolved charges', async () => {
    const seen: string[] = [];
    const warnings: string[] = [];
    const exact = await fetchOpenRouterExactCosts(['gen-1', 'gen-2', 'gen-1', 'gen-3', 'gen-4'], {
      enabled: true,
      concurrency: 2,
      logger: { warn: (message) => warnings.push(String(message)) },
      fetchGenerationCost: async (id) => {
        seen.push(id);
        if (id === 'gen-2') return null;
        if (id === 'gen-3') throw new Error('timeout');
        if (id === 'gen-4') return { totalCostUsd: Number.NaN };
        return { totalCostUsd: 0.25 };
      },
    });
    assert.deepEqual([...seen].sort(), ['gen-1', 'gen-2', 'gen-3', 'gen-4']);
    assert.deepEqual(exact, new Map([['gen-1', 0.25]]));
    assert.deepEqual(warnings, ['[COST] OpenRouter exact cost unavailable for 3 generation(s); using local pricing fallback']);
  });

  it('keeps a billed zero', async () => {
    const exact = await fetchOpenRouterExactCosts(['gen-free'], {
      enabled: true,
      fetchGenerationCost: async () => ({ totalCostUsd: 0 }),
    });
    assert.deepEqual(exact, new Map([['gen-free', 0]]));
  });
});
