import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import {
  computeModelCost,
  computeNormalizedEvaluationCost,
  isExplicitZeroPricing,
  loadConfiguredPricingTable,
  loadPricingTable,
  type ModelPricing,
} from './model-pricing.ts';

const MTOK = 1_000_000;

describe('computeModelCost', () => {
  it('prices every dimension with explicit cache rates', () => {
    const pricing: ModelPricing = {
      inputCostPerMTok: 15,
      outputCostPerMTok: 75,
      cacheWriteCostPerMTok: 18.75,
      cacheReadCostPerMTok: 1.5,
    };
    const cost = computeModelCost(
      { inputTokens: MTOK, cacheCreationTokens: 500_000, cacheReadTokens: 2 * MTOK, outputTokens: 100_000 },
      pricing,
    );
    // 15 input + 9.375 cache write + 3 cache read + 7.5 output
    assert.ok(Math.abs(cost - 34.875) < 1e-9, `Expected 34.875, got ${cost}`);
  });

  it('honours explicit zero cache rates instead of the multipliers', () => {
    const pricing: ModelPricing = { inputCostPerMTok: 10, outputCostPerMTok: 50, cacheWriteCostPerMTok: 0, cacheReadCostPerMTok: 0 };
    const cost = computeModelCost(
      { inputTokens: MTOK, cacheCreationTokens: MTOK, cacheReadTokens: MTOK, outputTokens: MTOK },
      pricing,
    );
    assert.equal(cost, 60);
  });

  it('derives cache rates from the input rate (1.25x write, 0.1x read) when unset', () => {
    const cost = computeModelCost(
      { inputTokens: MTOK, cacheCreationTokens: MTOK, cacheReadTokens: MTOK, outputTokens: MTOK },
      { inputCostPerMTok: 10, outputCostPerMTok: 50 },
    );
    // 10 input + 12.5 cache write + 1 cache read + 50 output
    assert.ok(Math.abs(cost - 73.5) < 1e-9, `Expected 73.50, got ${cost}`);
  });

  it('returns 0 for zero tokens', () => {
    const cost = computeModelCost(
      { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      { inputCostPerMTok: 15, outputCostPerMTok: 75 },
    );
    assert.equal(cost, 0);
  });
});

describe('isExplicitZeroPricing', () => {
  it('is true only when every configured rate is zero', () => {
    assert.equal(isExplicitZeroPricing({ inputCostPerMTok: 0, outputCostPerMTok: 0 }), true);
    assert.equal(isExplicitZeroPricing({ inputCostPerMTok: 0, outputCostPerMTok: 0, cacheReadCostPerMTok: 0 }), true);
    assert.equal(isExplicitZeroPricing({ inputCostPerMTok: 0, outputCostPerMTok: 0, cacheWriteCostPerMTok: 0.1 }), false);
    assert.equal(isExplicitZeroPricing({ inputCostPerMTok: 0, outputCostPerMTok: 1 }), false);
  });
});

describe('computeNormalizedEvaluationCost', () => {
  const pricing: ModelPricing = { inputCostPerMTok: 10, outputCostPerMTok: 50, cacheWriteCostPerMTok: 12.5, cacheReadCostPerMTok: 1 };

  it('requires explicit input and output token dimensions', () => {
    assert.deepEqual(
      computeNormalizedEvaluationCost({ cacheCreationTokens: 0, cacheReadTokens: 0 }, pricing, {
        requireExplicitCache: true,
        pricingRevision: 'test-revision',
      }),
      { costUsd: null, basis: 'incomplete', coverage: 'missing_token_usage', pricingRevision: 'test-revision' },
    );
  });

  it('requires both cache dimensions', () => {
    const result = computeNormalizedEvaluationCost({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, pricing);
    assert.equal(result.coverage, 'missing_cache_usage');
    assert.equal(result.costUsd, null);
  });

  it('requires explicit cache pricing only when asked to', () => {
    const usage = { inputTokens: MTOK, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    const derived = { inputCostPerMTok: 10, outputCostPerMTok: 50 };
    assert.equal(computeNormalizedEvaluationCost(usage, derived, { requireExplicitCache: true }).coverage, 'missing_cache_pricing');
    assert.deepEqual(computeNormalizedEvaluationCost(usage, derived), {
      costUsd: 10,
      basis: 'explicit_pricing',
      coverage: 'complete',
      pricingRevision: undefined,
    });
  });

  it('rejects negative or non-finite token counts', () => {
    const result = computeNormalizedEvaluationCost(
      { inputTokens: -1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      pricing,
    );
    assert.equal(result.costUsd, null);
    assert.equal(result.basis, 'incomplete');
  });

  it('prices complete usage with the shared formula', () => {
    const usage = { inputTokens: MTOK, outputTokens: MTOK, cacheCreationTokens: MTOK, cacheReadTokens: MTOK };
    const result = computeNormalizedEvaluationCost(usage, pricing, { requireExplicitCache: true, pricingRevision: 'r1' });
    assert.deepEqual(result, {
      costUsd: computeModelCost(usage, pricing),
      basis: 'explicit_pricing',
      coverage: 'complete',
      pricingRevision: 'r1',
    });
  });
});

describe('pricing table loaders', () => {
  function withRepoConfig(config: unknown, fn: (repoDir: string) => void): void {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-pricing-'));
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config));
      clearConfigCache(repoDir);
      fn(repoDir);
    } finally {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  }

  it('loadConfiguredPricingTable returns only eval.pricing', () => {
    const pricing = { 'only-configured': { inputCostPerMTok: 1, outputCostPerMTok: 2 } };
    withRepoConfig({ eval: { pricing } }, (repoDir) => {
      assert.deepEqual(loadConfiguredPricingTable(repoDir), pricing);
    });
    withRepoConfig({}, (repoDir) => {
      assert.deepEqual(loadConfiguredPricingTable(repoDir), {});
    });
  });

  it('loadPricingTable overlays eval.pricing on registry pricing', () => {
    const pricing = { 'only-configured': { inputCostPerMTok: 1, outputCostPerMTok: 2 } };
    withRepoConfig({ eval: { pricing } }, (repoDir) => {
      const table = loadPricingTable(repoDir);
      assert.deepEqual(table['only-configured'], pricing['only-configured']);
      const configuredOnly = loadConfiguredPricingTable(repoDir);
      assert.ok(Object.keys(table).length >= Object.keys(configuredOnly).length);
    });
  });
});
