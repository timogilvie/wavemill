import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHostPriceOverrides } from './price-overrides.ts';

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
