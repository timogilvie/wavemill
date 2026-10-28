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

import type { HostPriceOverride } from '@hokusai/costs';
import { normalizeModelId } from '@hokusai/core';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  type ModelPricing,
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
