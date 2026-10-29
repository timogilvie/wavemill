/**
 * Wavemill's model-registry rate table as `@hokusai/costs` host price
 * overrides (HOK-3328).
 *
 * Wavemill owns *rates* (the registry's `pricing` entries, overlaid by
 * `eval.pricing`); `@hokusai/costs` owns the arithmetic. This module only
 * reshapes one into the other — it never multiplies a token count by a rate.
 * Cache rates the table states explicitly become multipliers on the input
 * rate; unstated ones take the same defaults the pricing primitive documents
 * (`CACHE_WRITE_MULTIPLIER` / `CACHE_READ_MULTIPLIER`).
 *
 * @module sdk-task-cost/price-overrides
 */

import { resolveEventPrice, type HostPriceOverride } from '@hokusai/costs';
import { normalizeModelId } from '@hokusai/core';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  type ModelPricing,
  type ModelTokenUsage,
  type PricingTable,
} from '../pricing/model-pricing.ts';

function finiteRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Multiplier for an explicit cache rate, or the documented default. */
function cacheMultiplier(rate: number | undefined, inputRate: number, fallback: number): number | undefined {
  if (rate === undefined) return fallback;
  if (!finiteRate(rate)) return undefined;
  if (inputRate === 0) return rate === 0 ? 0 : undefined;
  return rate / inputRate;
}

function toOverride(model: string, pricing: ModelPricing, asOf: string | undefined): HostPriceOverride | null {
  const inputRate = pricing.inputCostPerMTok;
  const outputRate = pricing.outputCostPerMTok;
  if (!finiteRate(inputRate) || !finiteRate(outputRate)) return null;
  const cacheWriteMultiplier = cacheMultiplier(pricing.cacheWriteCostPerMTok, inputRate, CACHE_WRITE_MULTIPLIER);
  const cacheReadMultiplier = cacheMultiplier(pricing.cacheReadCostPerMTok, inputRate, CACHE_READ_MULTIPLIER);
  return {
    model,
    inputPerMTokUsd: inputRate,
    outputPerMTokUsd: outputRate,
    ...(cacheWriteMultiplier !== undefined ? { cacheWriteMultiplier } : {}),
    ...(cacheReadMultiplier !== undefined ? { cacheReadMultiplier } : {}),
    ...(asOf ? { asOf } : {}),
  };
}

/**
 * One override per pricing-table model. Entries whose ids normalize to the
 * same model (the SDK rejects ambiguous overrides) keep the first; entries
 * with non-finite rates are skipped, so the SDK reports those models
 * unpriced instead of mispricing them.
 */
export function buildHostPriceOverrides(
  pricingTable: PricingTable | null | undefined,
  options: { asOf?: string } = {},
): HostPriceOverride[] {
  const overrides: HostPriceOverride[] = [];
  const seen = new Set<string>();
  for (const [model, pricing] of Object.entries(pricingTable ?? {})) {
    if (!model.trim() || !pricing) continue;
    const key = normalizeModelId(model);
    if (seen.has(key)) continue;
    const override = toOverride(model, pricing, options.asOf);
    if (!override) continue;
    seen.add(key);
    overrides.push(override);
  }
  return overrides;
}

/** One key for the single override and the priced event, so model-id normalization never misses. */
const PRICED_MODEL_KEY = 'priced-model';

/**
 * Price one usage record at one model's rates through `@hokusai/costs`
 * (`resolveEventPrice` over a single host override) — the only per-token
 * pricing in Wavemill, and the SDK does the arithmetic.
 *
 * For Wavemill decision policy that needs a dollar figure outside task
 * measurement: the native loop's live `maxCostUsd` budget, judge calls,
 * native planning artifacts and promotion evaluations. Task / workflow cost
 * never comes from here — it is the `@hokusai/costs` report in `meter.ts`.
 *
 * Returns `null` when the rates are unusable (non-finite or negative), never
 * a fabricated `0`.
 */
export function priceUsageUsd(
  pricing: ModelPricing,
  usage: Omit<ModelTokenUsage, 'costUsd'>,
): number | null {
  const override = toOverride(PRICED_MODEL_KEY, pricing, undefined);
  if (!override) return null;
  const resolved = resolveEventPrice(
    {
      observedModel: PRICED_MODEL_KEY,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_write_tokens: usage.cacheCreationTokens,
        cache_read_tokens: usage.cacheReadTokens,
        reasoning_tokens: null,
      },
    },
    { overrides: [override] },
  );
  return resolved.estimatedCostUsd;
}
