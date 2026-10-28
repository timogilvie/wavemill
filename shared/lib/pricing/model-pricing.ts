/**
 * Wavemill's per-call pricing primitive (HOK-3077).
 *
 * The Hokusai SDK reducer (`aggregateTaskCost`) never prices: events arrive
 * carrying a dollar figure their producer computed. This module is how
 * Wavemill computes that figure — one price table, one formula. It is NOT a
 * cost engine: it never reads sessions, aggregates a task, or decides
 * coverage. Workflow/eval cost is the SDK bridge in `shared/lib/sdk-task-cost/`.
 *
 * Authorized consumers are the SDK bridge and the Wavemill-only decision
 * policy sites (router budgets, judge-call pricing, backfills) listed in
 * `tools/cost-ownership-allowlist.txt`; `tools/check-cost-ownership.ts`
 * enforces the list.
 *
 * @module pricing/model-pricing
 */

import { loadWavemillConfig } from '../config.ts';
import { getEffectiveRegistry } from '../model-registry.ts';

/** Per-model token usage breakdown. */
export interface ModelTokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Per-model pricing entry (from .wavemill-config.json or the model registry). */
export interface ModelPricing {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheWriteCostPerMTok?: number;
  cacheReadCostPerMTok?: number;
}

export type PricingTable = Record<string, ModelPricing>;

/** Default cache pricing multipliers (relative to input cost). */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Load the effective pricing table: model-registry pricing, overlaid by
 * `eval.pricing` from `.wavemill-config.json`.
 *
 * @param repoDir - Repository root directory
 * @returns Pricing table, or empty object if unavailable
 */
export function loadPricingTable(repoDir?: string): PricingTable {
  const registryPricing: PricingTable = Object.fromEntries(
    Object.entries(getEffectiveRegistry(repoDir).models)
      .filter(([, capabilities]) => capabilities.pricing)
      .map(([modelId, capabilities]) => [modelId, { ...capabilities.pricing! }]),
  );
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.pricing && typeof config.eval.pricing === 'object') {
    return {
      ...registryPricing,
      ...config.eval.pricing,
    };
  }
  return registryPricing;
}

/**
 * Load only the explicitly configured `eval.pricing` table (no registry
 * fallback). The router pool bounds use this so an unconfigured model is
 * never budgeted from a registry default.
 */
export function loadConfiguredPricingTable(repoDir?: string): PricingTable {
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.pricing && typeof config.eval.pricing === 'object') {
    return config.eval.pricing;
  }
  return {};
}

/**
 * Compute cost for a set of tokens using cache-aware pricing.
 *
 * If cache-specific rates aren't configured, derives them from
 * the base input rate using standard multipliers (1.25x write, 0.1x read).
 */
export function computeModelCost(
  usage: Omit<ModelTokenUsage, 'costUsd'>,
  pricing: ModelPricing,
): number {
  const inputRate = pricing.inputCostPerMTok;
  const outputRate = pricing.outputCostPerMTok;
  const cacheWriteRate = pricing.cacheWriteCostPerMTok ?? inputRate * CACHE_WRITE_MULTIPLIER;
  const cacheReadRate = pricing.cacheReadCostPerMTok ?? inputRate * CACHE_READ_MULTIPLIER;

  const inputCost = (usage.inputTokens * inputRate) / 1_000_000;
  const cacheWriteCost = (usage.cacheCreationTokens * cacheWriteRate) / 1_000_000;
  const cacheReadCost = (usage.cacheReadTokens * cacheReadRate) / 1_000_000;
  const outputCost = (usage.outputTokens * outputRate) / 1_000_000;

  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}

/**
 * True when every rate in the entry is zero — the model is genuinely free, so
 * a reported or computed `$0` is a known zero rather than a missing price.
 */
export function isExplicitZeroPricing(pricing: ModelPricing): boolean {
  return pricing.inputCostPerMTok === 0
    && pricing.outputCostPerMTok === 0
    && (pricing.cacheWriteCostPerMTok ?? 0) === 0
    && (pricing.cacheReadCostPerMTok ?? 0) === 0;
}

export interface NormalizedEvaluationCost {
  costUsd: number | null;
  basis: 'explicit_pricing' | 'incomplete';
  coverage: 'complete' | 'missing_token_usage' | 'missing_cache_usage' | 'missing_cache_pricing';
  pricingRevision?: string;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Price an evaluation's token usage only when every dimension is observed
 * (and, with `requireExplicitCache`, every cache rate is configured);
 * otherwise report which input was incomplete instead of a dollar figure.
 */
export function computeNormalizedEvaluationCost(
  usage: Partial<Omit<ModelTokenUsage, 'costUsd'>>,
  pricing: ModelPricing,
  options: { requireExplicitCache?: boolean; pricingRevision?: string } = {},
): NormalizedEvaluationCost {
  const incomplete = (coverage: Exclude<NormalizedEvaluationCost['coverage'], 'complete'>): NormalizedEvaluationCost => ({
    costUsd: null,
    basis: 'incomplete',
    coverage,
    pricingRevision: options.pricingRevision,
  });
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
    return incomplete('missing_token_usage');
  }
  if (typeof usage.cacheCreationTokens !== 'number' || typeof usage.cacheReadTokens !== 'number') {
    return incomplete('missing_cache_usage');
  }
  if (
    options.requireExplicitCache === true
    && (pricing.cacheWriteCostPerMTok === undefined || pricing.cacheReadCostPerMTok === undefined)
  ) {
    return incomplete('missing_cache_pricing');
  }
  if (
    !isFiniteNonNegative(usage.inputTokens)
    || !isFiniteNonNegative(usage.outputTokens)
    || !isFiniteNonNegative(usage.cacheCreationTokens)
    || !isFiniteNonNegative(usage.cacheReadTokens)
  ) {
    return incomplete('missing_cache_usage');
  }
  return {
    costUsd: computeModelCost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
    }, pricing),
    basis: 'explicit_pricing',
    coverage: 'complete',
    pricingRevision: options.pricingRevision,
  };
}
