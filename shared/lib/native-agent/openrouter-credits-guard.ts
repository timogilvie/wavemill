import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  getNativeOpenRouterProviderConfig,
  getOpenRouterProviderConfig,
  type NativeAgentProviderConfig,
} from '../config.ts';
import { resolveEnvValue } from '../env-file.ts';
import type { NormalizedPricing } from '../openrouter-catalog.ts';
import { readOpenRouterCredits, type OpenRouterCreditsSnapshot } from '../quota-state.ts';
import { OPENROUTER_DEFAULT_API_KEY_ENV } from './providers.ts';
import { resolveWavemillToolPath } from './install-paths.ts';

export const DEFAULT_OPENROUTER_MIN_CREDITS_USD = 0.02;
export const DEFAULT_OPENROUTER_WARN_CREDITS_USD = 2.00;
export const DEFAULT_OPENROUTER_CREDIT_TTL_SECONDS = 600;
export const DEFAULT_OPENROUTER_OUTPUT_PRICE_PER_MTOK = 5;
export const OPENROUTER_MIN_MEANINGFUL_OUTPUT_TOKENS = 4096;
export const OPENROUTER_MIN_ADAPTIVE_MAX_TOKENS = 1024;

export interface OpenRouterBalanceEvaluation {
  status: 'ok' | 'warn' | 'refuse';
  balanceUsd: number | null;
  updatedAt: string | null;
  minCreditsUsd: number;
  warnCreditsUsd: number;
  reservedOutputTokens?: number;
  reservationUsd?: number;
  stale: boolean;
  lastFetchError?: string;
}

export class InsufficientOpenRouterCreditsError extends Error {
  readonly kind = 'openrouter-credits-exhausted';
  readonly balanceUsd: number | null;
  readonly minRequiredUsd: number;
  readonly updatedAt: string | null;

  constructor(input: {
    balanceUsd: number | null;
    minRequiredUsd: number;
    updatedAt: string | null;
    model?: string;
  }) {
    const balance = input.balanceUsd == null ? 'unknown' : `$${input.balanceUsd.toFixed(4)}`;
    super(
      `OpenRouter credits exhausted${input.model ? ` for ${input.model}` : ''}: `
      + `cached balance is ${balance}, below required $${input.minRequiredUsd.toFixed(4)}. `
      + 'Top up OpenRouter credits or lower nativeAgent.providers.openrouter.minCreditsUsd.',
    );
    this.name = 'InsufficientOpenRouterCreditsError';
    this.balanceUsd = input.balanceUsd;
    this.minRequiredUsd = input.minRequiredUsd;
    this.updatedAt = input.updatedAt;
  }
}

export function evaluateOpenRouterBalance(input: {
  repoDir?: string;
  config?: NativeAgentProviderConfig;
  model?: string;
  pricing?: NormalizedPricing;
  reservedOutputTokens?: number;
} = {}): OpenRouterBalanceEvaluation {
  const repoDir = input.repoDir;
  const config = input.config ?? getNativeOpenRouterProviderConfig(repoDir);
  const thresholds = resolveThresholds(config);
  const snapshot = readOpenRouterCredits(repoDir);

  if (!snapshot) {
    triggerBackgroundRefresh(repoDir, config);
    return {
      status: 'ok',
      balanceUsd: null,
      updatedAt: null,
      minCreditsUsd: thresholds.minCreditsUsd,
      warnCreditsUsd: thresholds.warnCreditsUsd,
      ...(input.reservedOutputTokens !== undefined ? { reservedOutputTokens: input.reservedOutputTokens } : {}),
      stale: false,
    };
  }

  const stale = isSnapshotStale(snapshot, thresholds.creditRefreshTtlSeconds);
  if (stale) {
    triggerBackgroundRefresh(repoDir, config);
  }

  const priceFloor = priceFloorUsd(input.pricing);
  const reservationUsd = reservationPriceUsd(input.pricing, input.reservedOutputTokens);
  const minCreditsUsd = Math.max(thresholds.minCreditsUsd, priceFloor);
  const balanceUsd = snapshot.balanceUsd;
  const status = balanceUsd == null
    ? 'ok'
    : balanceUsd < minCreditsUsd
      ? 'refuse'
      : balanceUsd < thresholds.warnCreditsUsd || (reservationUsd !== undefined && balanceUsd < reservationUsd)
        ? 'warn'
        : 'ok';

  return {
    status,
    balanceUsd,
    updatedAt: snapshot.updatedAt,
    minCreditsUsd,
    warnCreditsUsd: thresholds.warnCreditsUsd,
    ...(input.reservedOutputTokens !== undefined ? { reservedOutputTokens: input.reservedOutputTokens } : {}),
    ...(reservationUsd !== undefined ? { reservationUsd } : {}),
    stale,
    lastFetchError: snapshot.lastFetchError?.message,
  };
}

export function assertOpenRouterBalanceSufficient(input: {
  repoDir?: string;
  config?: NativeAgentProviderConfig;
  model?: string;
  pricing?: NormalizedPricing;
  reservedOutputTokens?: number;
} = {}): OpenRouterBalanceEvaluation {
  const evaluation = evaluateOpenRouterBalance(input);
  if (evaluation.status === 'refuse') {
    throw new InsufficientOpenRouterCreditsError({
      balanceUsd: evaluation.balanceUsd,
      minRequiredUsd: evaluation.minCreditsUsd,
      updatedAt: evaluation.updatedAt,
      model: input.model,
    });
  }

  if (evaluation.status === 'warn') {
    const balance = `$${(evaluation.balanceUsd ?? 0).toFixed(4)}`;
    if (evaluation.reservationUsd !== undefined && evaluation.balanceUsd !== null && evaluation.balanceUsd < evaluation.reservationUsd) {
      console.warn(
        `OpenRouter credit balance is below this request's max_tokens reservation: ${balance} `
        + `< $${evaluation.reservationUsd.toFixed(4)} for ${evaluation.reservedOutputTokens ?? 0} output tokens.`,
      );
    } else {
      console.warn(
        `OpenRouter credit balance is low: ${balance} `
        + `(warning threshold $${evaluation.warnCreditsUsd.toFixed(2)}).`,
      );
    }
  }
  return evaluation;
}

export function capOpenRouterMaxTokensForBalance(input: {
  requestedMaxTokens?: number;
  pricing: NormalizedPricing;
  repoDir?: string;
  inputCostReserveUsd?: number;
}): number | undefined {
  const requested = input.requestedMaxTokens;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return undefined;
  }

  const balanceUsd = readOpenRouterCredits(input.repoDir)?.balanceUsd;
  if (typeof balanceUsd !== 'number' || !Number.isFinite(balanceUsd) || balanceUsd <= 0) {
    return requested;
  }

  const outputPerToken = outputPricePerToken(input.pricing);
  const reserve = Math.max(0, input.inputCostReserveUsd ?? 0);
  const affordableTokens = Math.floor(Math.max(0, balanceUsd - reserve) / outputPerToken);
  if (affordableTokens <= 0) {
    return OPENROUTER_MIN_ADAPTIVE_MAX_TOKENS;
  }
  return Math.min(
    requested,
    Math.max(OPENROUTER_MIN_ADAPTIVE_MAX_TOKENS, affordableTokens),
  );
}

function resolveThresholds(config: NativeAgentProviderConfig): {
  minCreditsUsd: number;
  warnCreditsUsd: number;
  creditRefreshTtlSeconds: number;
} {
  return {
    minCreditsUsd: positiveNumber(config.minCreditsUsd, DEFAULT_OPENROUTER_MIN_CREDITS_USD),
    warnCreditsUsd: positiveNumber(config.warnCreditsUsd, DEFAULT_OPENROUTER_WARN_CREDITS_USD),
    creditRefreshTtlSeconds: positiveInteger(
      config.creditRefreshTtlSeconds,
      DEFAULT_OPENROUTER_CREDIT_TTL_SECONDS,
    ),
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function isSnapshotStale(snapshot: OpenRouterCreditsSnapshot, ttlSeconds: number): boolean {
  const updatedAtMs = Date.parse(snapshot.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return true;
  }
  return Date.now() - updatedAtMs > ttlSeconds * 1000;
}

function outputPricePerToken(pricing: NormalizedPricing): number {
  const outputPerMTok = pricing.outputPerMTok;
  const resolved = typeof outputPerMTok === 'number' && Number.isFinite(outputPerMTok) && outputPerMTok > 0
    ? outputPerMTok
    : DEFAULT_OPENROUTER_OUTPUT_PRICE_PER_MTOK;
  return resolved / 1_000_000;
}

function priceFloorUsd(pricing?: NormalizedPricing): number {
  if (!pricing) {
    return 0;
  }
  return outputPricePerToken(pricing) * OPENROUTER_MIN_MEANINGFUL_OUTPUT_TOKENS;
}

function reservationPriceUsd(pricing: NormalizedPricing | undefined, reservedOutputTokens: number | undefined): number | undefined {
  if (typeof reservedOutputTokens !== 'number' || !Number.isFinite(reservedOutputTokens) || reservedOutputTokens <= 0) {
    return undefined;
  }
  return outputPricePerToken(pricing ?? { inputPerMTok: 0, outputPerMTok: DEFAULT_OPENROUTER_OUTPUT_PRICE_PER_MTOK }) * reservedOutputTokens;
}

function triggerBackgroundRefresh(repoDir: string | undefined, config: NativeAgentProviderConfig): void {
  const providerConfig = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = config.apiKeyEnv?.trim()
    || providerConfig.apiKeyEnv?.trim()
    || OPENROUTER_DEFAULT_API_KEY_ENV;
  if (!resolveEnvValue([apiKeyEnv], repoDir)) {
    return;
  }

  const args = [
    'tsx',
    resolveWavemillToolPath('refresh-openrouter-credits.ts'),
    '--repo-dir',
    resolve(repoDir ?? process.cwd()),
  ];
  const child = spawn('npx', args, {
    cwd: resolve(repoDir ?? process.cwd()),
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => {});
  child.unref();
}
