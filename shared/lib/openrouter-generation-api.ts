/**
 * OpenRouter generation-cost lookup.
 *
 * The generation endpoint exposes exact billed cost after a request has
 * completed. This client is deliberately best-effort: lookup failures return
 * null so workflow-cost accounting can fall back to local pricing.
 */

export type { ProviderGenerationEvidence as OpenRouterGenerationCost } from '@hokusai/core';
import type { ProviderGenerationEvidence as OpenRouterGenerationCost } from '@hokusai/core';
import { retryTransient, TransientError } from './transient-retry.ts';

export type FetchLike = typeof fetch;

export interface FetchGenerationOptions {
  fetchFn?: FetchLike;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Shared network retry controls; tests inject sleep, callers retain the shared bounds. */
  retry?: Pick<NonNullable<Parameters<typeof retryTransient>[1]>, 'sleep' | 'random' | 'maxAttempts'>;
}

const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 6;

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseGenerationCost(body: unknown): OpenRouterGenerationCost | null {
  const record = body as Record<string, unknown> | null;
  const data = (record?.data && typeof record.data === 'object')
    ? record.data as Record<string, unknown>
    : record;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const charge = finiteNumber(data.total_cost ?? data.totalCost);
  const totalCostUsd = charge !== undefined && charge >= 0 ? charge : null;
  const providerName = stringValue(data.provider_name ?? data.providerName);
  const modelPermaslug = stringValue(data.model);
  if (totalCostUsd === null && !providerName && !modelPermaslug) {
    return null;
  }

  const result: OpenRouterGenerationCost = { totalCostUsd };
  const cacheDiscountUsd = finiteNumber(data.cache_discount ?? data.cacheDiscount);
  const nativeTokensPrompt = finiteNumber(data.native_tokens_prompt ?? data.nativeTokensPrompt);
  const nativeTokensCached = finiteNumber(data.native_tokens_cached ?? data.nativeTokensCached);
  const nativeTokensCompletion = finiteNumber(data.native_tokens_completion ?? data.nativeTokensCompletion);
  if (cacheDiscountUsd !== undefined) result.cacheDiscountUsd = cacheDiscountUsd;
  if (providerName) result.providerName = providerName;
  if (modelPermaslug) result.modelPermaslug = modelPermaslug;
  if (nativeTokensPrompt !== undefined) result.nativeTokensPrompt = nativeTokensPrompt;
  if (nativeTokensCached !== undefined) result.nativeTokensCached = nativeTokensCached;
  if (nativeTokensCompletion !== undefined) result.nativeTokensCompletion = nativeTokensCompletion;
  return result;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export async function fetchGenerationCost(
  generationId: string,
  opts: FetchGenerationOptions = {},
): Promise<OpenRouterGenerationCost | null> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey || !generationId) {
    return null;
  }

  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const url = `${GENERATION_URL}?id=${encodeURIComponent(generationId)}`;
    return await retryTransient(async () => {
      if (opts.signal?.aborted) return null;
      const timeout = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          response = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout.signal });
        } catch (cause) {
          if (opts.signal?.aborted) return null;
          throw new TransientError('OpenRouter generation lookup unavailable', { cause });
        }
        // Completed generations can briefly be absent from the lookup index.
        // This retries metadata GETs only, never the model execution.
        if (response.status === 404 || response.status === 429 || response.status >= 500) throw new TransientError(`HTTP ${response.status} generation lookup`);
        if (!response.ok) return null;
        return parseGenerationCost(await response.json());
      } finally { timeout.cleanup(); }
    }, opts.retry);
  } catch {
    return null;
  }
}

export async function fetchGenerationCostsBatched(
  generationIds: readonly string[],
  opts: FetchGenerationOptions & { concurrency?: number } = {},
): Promise<Map<string, OpenRouterGenerationCost | null>> {
  const uniqueIds = [...new Set(generationIds.filter((id) => id.length > 0))];
  const results = new Map<string, OpenRouterGenerationCost | null>();
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < uniqueIds.length) {
      const id = uniqueIds[nextIndex++];
      results.set(id, await fetchGenerationCost(id, opts));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()));
  return results;
}
