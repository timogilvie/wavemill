import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import {
  computeNormalizedEvaluationCost,
  isExplicitZeroPricing,
  loadConfiguredPricingTable,
  loadPricingTable,
  type ModelPricing,
} from './model-pricing.ts';

const MTOK = 1_000_000;

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

  // protects: promotion evaluations priced with a different formula than @hokusai/costs
  it('prices complete usage through @hokusai/costs', () => {
    const usage = { inputTokens: MTOK, outputTokens: MTOK, cacheCreationTokens: MTOK, cacheReadTokens: MTOK };
    const result = computeNormalizedEvaluationCost(usage, pricing, { requireExplicitCache: true, pricingRevision: 'r1' });
    assert.deepEqual(result, {
      // 10 input + 50 output + 12.5 cache write + 1 cache read
      costUsd: 73.5,
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
