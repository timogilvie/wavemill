import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeModelCost } from '../pricing/model-pricing.ts';
import { piUsageToSessionModelUsage } from './pi-usage-cost.ts';

describe('piUsageToSessionModelUsage', () => {
  it('maps transcript usage fields to session model usage', () => {
    const result = piUsageToSessionModelUsage({
      input: 100,
      output: 25,
      cacheRead: 60,
      cacheWrite: 40,
      totalTokens: 225,
    });

    assert.deepEqual(result, {
      inputTokens: 100,
      cacheCreationTokens: 40,
      cacheReadTokens: 60,
      outputTokens: 25,
    });
  });

  it('returns zeros for zero-token usage', () => {
    const result = piUsageToSessionModelUsage({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });

    assert.deepEqual(result, {
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
  });

  it('defaults missing usage fields to zero', () => {
    const result = piUsageToSessionModelUsage({
      input: 100,
      output: 10,
      cacheRead: undefined as unknown as number,
      cacheWrite: undefined as unknown as number,
      totalTokens: 110,
    });

    assert.deepEqual(result, {
      inputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 10,
    });
  });

  it('preserves absent usage as undefined', () => {
    assert.equal(piUsageToSessionModelUsage(undefined), undefined);
  });

  it('produces data consumable by computeModelCost', () => {
    const usage = piUsageToSessionModelUsage({
      input: 1_000_000,
      output: 500_000,
      cacheRead: 250_000,
      cacheWrite: 125_000,
      totalTokens: 1_875_000,
    });

    const cost = computeModelCost(usage, {
      inputCostPerMTok: 2,
      outputCostPerMTok: 8,
      cacheReadCostPerMTok: 0.2,
      cacheWriteCostPerMTok: 2.5,
    });

    assert.equal(cost, 6.3625);
  });
});
