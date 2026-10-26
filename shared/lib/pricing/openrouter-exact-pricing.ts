/**
 * OpenRouter exact generation pricing for native turns (HOK-3077).
 *
 * OpenRouter's `/generation` endpoint reports the billed charge of a
 * completed request. When a native transcript recorded the response id of a
 * turn, that charge is more exact than a local estimate. This module turns a
 * set of response ids into a `responseId → USD` map; the SDK bridge
 * (`sdk-task-cost/events-from-session.ts`) emits those turns as
 * provider-reported `actual_cost_usd`, so the exact figure flows through the
 * one SDK reducer instead of patching a computed total afterwards.
 *
 * Best-effort by design: a failed lookup is simply absent from the map and
 * the turn keeps its local estimate.
 *
 * @module pricing/openrouter-exact-pricing
 */

import {
  fetchGenerationCostsBatched,
  type OpenRouterGenerationCost,
} from '../openrouter-generation-api.ts';

export interface ExactPricingOptions {
  /** Injected per-id lookup (tests); defaults to the OpenRouter client. */
  fetchGenerationCost?: (id: string) => Promise<OpenRouterGenerationCost | null>;
  concurrency?: number;
  /** Defaults to whether `OPENROUTER_API_KEY` is set. */
  enabled?: boolean;
  logger?: Pick<Console, 'warn'>;
}

const DEFAULT_CONCURRENCY = 6;

/** True when exact lookups should run for these options. */
export function isExactPricingEnabled(opts: ExactPricingOptions = {}): boolean {
  return opts.enabled ?? !!process.env.OPENROUTER_API_KEY;
}

async function fetchWithInjectedCost(
  generationIds: readonly string[],
  fetchGenerationCost: (id: string) => Promise<OpenRouterGenerationCost | null>,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<Map<string, OpenRouterGenerationCost | null>> {
  const uniqueIds = [...new Set(generationIds)];
  const results = new Map<string, OpenRouterGenerationCost | null>();
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < uniqueIds.length) {
      const id = uniqueIds[nextIndex++];
      try {
        results.set(id, await fetchGenerationCost(id));
      } catch {
        results.set(id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), uniqueIds.length) }, () => worker()));
  return results;
}

/**
 * Fetch the billed USD charge for each response id.
 *
 * Returns `undefined` when exact pricing is disabled (no API key, or
 * `enabled: false`) or there is nothing to look up, so callers can skip the
 * exact path entirely. Otherwise returns only the ids whose charge resolved;
 * failures are logged once through `opts.logger` and left out.
 */
export async function fetchOpenRouterExactCosts(
  responseIds: readonly string[],
  opts: ExactPricingOptions = {},
): Promise<Map<string, number> | undefined> {
  if (!isExactPricingEnabled(opts)) return undefined;
  const ids = [...new Set(responseIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return undefined;

  const fetched = opts.fetchGenerationCost
    ? await fetchWithInjectedCost(ids, opts.fetchGenerationCost, opts.concurrency)
    : await fetchGenerationCostsBatched(ids, { concurrency: opts.concurrency });

  const exact = new Map<string, number>();
  let failedCount = 0;
  for (const [id, cost] of fetched) {
    if (cost && Number.isFinite(cost.totalCostUsd) && cost.totalCostUsd >= 0) {
      exact.set(id, cost.totalCostUsd);
    } else {
      failedCount++;
    }
  }
  if (failedCount > 0) {
    opts.logger?.warn?.(`[COST] OpenRouter exact cost unavailable for ${failedCount} generation(s); using local pricing fallback`);
  }
  return exact;
}
