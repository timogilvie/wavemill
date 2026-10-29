import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelPricing } from '../pricing/model-pricing.ts';
import { buildHostPriceOverrides, priceUsageUsd } from './price-overrides.ts';

const MTOK = 1_000_000;

describe('buildHostPriceOverrides (HOK-3328)', () => {
  // protects: Wavemill rates reaching @hokusai/costs with the wrong cache multipliers
  it('maps rates and turns explicit cache rates into multipliers', () => {
    assert.deepEqual(buildHostPriceOverrides({
      'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
      'gpt-5.6-terra': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
    }), [
      { model: 'claude-opus-4-7', inputPerMTokUsd: 15, outputPerMTokUsd: 75, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
      // Unstated cache rates take the pricing primitive's documented defaults.
      { model: 'gpt-5.6-terra', inputPerMTokUsd: 2, outputPerMTokUsd: 8, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
    ]);
  });

  // protects: the SDK rejecting the whole override set (ambiguous ids) or mispricing a bad entry
  it('drops ambiguous and non-finite entries; zero-rate models keep zero cache rates', () => {
    const overrides = buildHostPriceOverrides({
      'claude-haiku-4-5': { inputCostPerMTok: 1, outputCostPerMTok: 5 },
      'anthropic/claude-haiku-4-5': { inputCostPerMTok: 9, outputCostPerMTok: 9 },
      broken: { inputCostPerMTok: Number.NaN, outputCostPerMTok: 1 },
      'free-model': { inputCostPerMTok: 0, outputCostPerMTok: 0, cacheReadCostPerMTok: 0, cacheWriteCostPerMTok: 0 },
    });
    assert.deepEqual(overrides.map((override) => override.model), ['claude-haiku-4-5', 'free-model']);
    assert.equal(overrides[1].cacheReadMultiplier, 0);
    assert.deepEqual(buildHostPriceOverrides(undefined), []);
  });
});

describe('priceUsageUsd (HOK-3328)', () => {
  // protects: a cache bucket billed at the wrong rate in the native loop budget or judge cost
  it('prices every dimension with explicit cache rates', () => {
    const pricing: ModelPricing = {
      inputCostPerMTok: 15,
      outputCostPerMTok: 75,
      cacheWriteCostPerMTok: 18.75,
      cacheReadCostPerMTok: 1.5,
    };
    const cost = priceUsageUsd(pricing, { inputTokens: MTOK, cacheCreationTokens: 500_000, cacheReadTokens: 2 * MTOK, outputTokens: 100_000 });
    // 15 input + 9.375 cache write + 3 cache read + 7.5 output
    assert.equal(cost, 34.875);
  });

  // protects: explicit zero cache rates silently replaced by the default multipliers
  it('honours explicit zero cache rates instead of the multipliers', () => {
    const pricing: ModelPricing = { inputCostPerMTok: 10, outputCostPerMTok: 50, cacheWriteCostPerMTok: 0, cacheReadCostPerMTok: 0 };
    assert.equal(priceUsageUsd(pricing, { inputTokens: MTOK, cacheCreationTokens: MTOK, cacheReadTokens: MTOK, outputTokens: MTOK }), 60);
  });

  // protects: unstated cache rates pricing cache tokens at zero (undercount)
  it('derives cache rates from the input rate (1.25x write, 0.1x read) when unset', () => {
    const cost = priceUsageUsd(
      { inputCostPerMTok: 10, outputCostPerMTok: 50 },
      { inputTokens: MTOK, cacheCreationTokens: MTOK, cacheReadTokens: MTOK, outputTokens: MTOK },
    );
    // 10 input + 12.5 cache write + 1 cache read + 50 output
    assert.equal(cost, 73.5);
  });

  // protects: an empty turn charged a non-zero amount
  it('returns 0 for zero tokens', () => {
    assert.equal(priceUsageUsd({ inputCostPerMTok: 15, outputCostPerMTok: 75 }, { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }), 0);
  });

  // protects: an unusable rate entry fabricating a $0 or NaN charge
  it('returns null for unusable rates', () => {
    assert.equal(priceUsageUsd({ inputCostPerMTok: Number.NaN, outputCostPerMTok: 1 }, { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1 }), null);
  });
});
