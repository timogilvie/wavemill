import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getQuotaConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { acquireStateLockSync, releaseStateLock, type StateLockHandle } from './state-lock.ts';

export type QuotaStatus = 'healthy' | 'degrading' | 'exhausted';

export interface QuotaEntry {
  status: QuotaStatus;
  remainingEstimate: number | null;
  resetAt: string | null;
  confidence: number;
  lastLimitErrorAt: string | null;
  lastSuccessAt: string | null;
  lastReason: string | null;
}

export interface QuotaSnapshot {
  models: Readonly<Record<string, Readonly<QuotaEntry>>>;
  providers?: ProvidersQuotaState;
  snapshotAt: string;
}

export interface OpenRouterCreditsSnapshot {
  totalCredits: number | null;
  totalUsage: number | null;
  balanceUsd: number | null;
  usageDaily: number | null;
  updatedAt: string;
  lastFetchError: { message: string; at: string } | null;
}

export interface ProvidersQuotaState {
  openrouter?: OpenRouterCreditsSnapshot;
}

export interface VendorQuotaStats {
  healthy: number;
  degraded: number;
  exhausted: number;
  total: number;
}

export interface LimitErrorInput {
  modelId: string;
  resetAt?: string | Date | null;
  remainingEstimate?: number | null;
  reason?: string;
}

export interface SuccessInput {
  modelId: string;
}

export interface ExhaustedInput extends LimitErrorInput {
  confidence?: number;
}

export interface BudgetSignal {
  remaining: number;
  limit: number;
  window: string;
}

export interface RequestInput {
  modelId: string;
  budgetSignal?: BudgetSignal;
}

export interface NearLimitInput {
  modelId: string;
  remainingEstimate?: number | null;
  limitEstimate?: number | null;
  reason?: string;
  budgetSignal?: BudgetSignal;
}

export type QuotaHealthEstimate = 'healthy' | 'approaching_degradation' | 'degrading';


interface StoredQuotaEntry extends QuotaEntry {
  consecutiveLimitErrors: number;
  requestHistory: Array<{ timestamp: string }>;
  consecutiveNearLimitSignals: number;
  lastNearLimitAt: string | null;
  budgetSignal: BudgetSignal | null;
}

interface QuotaStateFile {
  version: number;
  updatedAt: string;
  models: Record<string, StoredQuotaEntry>;
  providers?: ProvidersQuotaState;
}

interface LoadedQuotaState {
  state: QuotaStateFile;
  writeAllowed: boolean;
}

interface StatePaths {
  statePath: string;
  lockPath: string;
}

type LockHandle = StateLockHandle;

const QUOTA_STATE_VERSION = 2;
export const QUOTA_STATE_TIMINGS = {
  HEALTHY_DECAY_MS: 5 * 60_000,
  DEGRADING_DECAY_MS: 10 * 60_000,
  EXHAUSTED_DECAY_MS: 30 * 60_000,
  LOCK_ACQUIRE_TIMEOUT_MS: 2_000,
};
const REQUEST_WINDOW_MS = 5 * 60_000;
const REQUEST_HISTORY_MAX = 100;
const DEFAULT_VOLUME_THRESHOLD_PERCENT = 70;
const DEFAULT_BUDGET_THRESHOLD_PERCENT = 25;
const DEFAULT_NEAR_LIMIT_COUNT = 3;
const NEAR_LIMIT_REMAINING_THRESHOLD_PERCENT = 20;
const BASELINE_REQUESTS_PER_WINDOW = 100;

let clock: (() => number) | null = null;

function now(): number {
  return clock ? clock() : Date.now();
}

export function __setClock(fn: () => number): void {
  clock = fn;
}

export function __resetClock(): void {
  clock = null;
}

function emptyState(nowMs = now()): QuotaStateFile {
  return {
    version: QUOTA_STATE_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    models: {},
  };
}

function resolveStatePaths(repoDir?: string): StatePaths {
  const statePath = resolveFromMainRepo('.wavemill/quota-state.json', repoDir);
  return {
    statePath,
    lockPath: join(dirname(statePath), 'quota-state.lock'),
  };
}

function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeIsoDate(value: string | Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function normalizeRemainingEstimate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function normalizePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function normalizeBudgetSignal(value: unknown): BudgetSignal | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<BudgetSignal>;
  const remaining = normalizePositiveNumber(candidate.remaining);
  const limit = normalizePositiveNumber(candidate.limit);
  const window = typeof candidate.window === 'string' ? candidate.window : '';
  if (remaining == null || limit == null || !window) {
    return null;
  }

  return { remaining, limit, window };
}

function normalizeRequestHistory(
  value: unknown,
  nowMs = now(),
): Array<{ timestamp: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const timestamp = normalizeIsoDate((item as { timestamp?: unknown }).timestamp as string | null);
      return timestamp ? { timestamp } : null;
    })
    .filter((item): item is { timestamp: string } => item != null)
    .filter((item) => {
      const parsed = parseIsoDate(item.timestamp);
      return parsed != null && parsed <= nowMs;
    })
    .sort((a, b) => (parseIsoDate(a.timestamp) ?? 0) - (parseIsoDate(b.timestamp) ?? 0));

  return normalized.slice(-REQUEST_HISTORY_MAX);
}

function emptyStoredEntry(): StoredQuotaEntry {
  return {
    status: 'healthy',
    remainingEstimate: null,
    resetAt: null,
    confidence: 1,
    lastLimitErrorAt: null,
    lastSuccessAt: null,
    lastReason: null,
    consecutiveLimitErrors: 0,
    requestHistory: [],
    consecutiveNearLimitSignals: 0,
    lastNearLimitAt: null,
    budgetSignal: null,
  };
}

function sanitizeThresholdPercent(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, value));
}

function sanitizeNearLimitCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

interface ProactiveThresholds {
  volumeThresholdPercent: number;
  budgetThresholdPercent: number;
  nearLimitCount: number;
}

function resolveThresholds(repoDir?: string): ProactiveThresholds {
  const configured = getQuotaConfig(repoDir).thresholds;
  return {
    volumeThresholdPercent: sanitizeThresholdPercent(
      configured?.volumeThresholdPercent,
      DEFAULT_VOLUME_THRESHOLD_PERCENT,
    ),
    budgetThresholdPercent: sanitizeThresholdPercent(
      configured?.budgetThresholdPercent,
      DEFAULT_BUDGET_THRESHOLD_PERCENT,
    ),
    nearLimitCount: sanitizeNearLimitCount(
      configured?.nearLimitCount,
      DEFAULT_NEAR_LIMIT_COUNT,
    ),
  };
}

function trimRequestHistory(
  requestHistory: Array<{ timestamp: string }>,
  nowMs: number,
): Array<{ timestamp: string }> {
  return requestHistory
    .filter((request) => {
      const requestAt = parseIsoDate(request.timestamp);
      return requestAt != null && requestAt >= nowMs - REQUEST_WINDOW_MS && requestAt <= nowMs;
    })
    .slice(-REQUEST_HISTORY_MAX);
}

function volumeThresholdCount(thresholdPercent: number): number {
  return Math.max(
    1,
    Math.ceil((thresholdPercent / 100) * BASELINE_REQUESTS_PER_WINDOW),
  );
}

interface HeuristicSignals {
  volumeTriggered: boolean;
  nearLimitRatioTriggered: boolean;
  nearLimitCountTriggered: boolean;
  budgetTriggered: boolean;
  volumeCount: number;
  volumeThresholdCount: number;
}

function evaluateHeuristicSignals(
  entry: StoredQuotaEntry,
  nowMs: number,
  thresholds: ProactiveThresholds,
): HeuristicSignals {
  const recentRequests = trimRequestHistory(entry.requestHistory, nowMs).length;
  const volumeCutoff = volumeThresholdCount(thresholds.volumeThresholdPercent);
  const volumeTriggered = recentRequests >= volumeCutoff;

  const nearLimitRatioTriggered = entry.remainingEstimate != null
    && entry.budgetSignal != null
    && entry.budgetSignal.limit > 0
    && (entry.remainingEstimate / entry.budgetSignal.limit) * 100 <= NEAR_LIMIT_REMAINING_THRESHOLD_PERCENT;

  const recentNearLimit = parseIsoDate(entry.lastNearLimitAt);
  const hasRecentNearLimit = recentNearLimit != null
    && nowMs - recentNearLimit <= QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS;
  const nearLimitCountTriggered = hasRecentNearLimit
    && entry.consecutiveNearLimitSignals >= thresholds.nearLimitCount;

  const budgetTriggered = entry.budgetSignal != null
    && entry.budgetSignal.limit > 0
    && (entry.budgetSignal.remaining / entry.budgetSignal.limit) * 100 <= thresholds.budgetThresholdPercent;

  return {
    volumeTriggered,
    nearLimitRatioTriggered,
    nearLimitCountTriggered,
    budgetTriggered,
    volumeCount: recentRequests,
    volumeThresholdCount: volumeCutoff,
  };
}

function normalizeStoredEntry(value: unknown): StoredQuotaEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredQuotaEntry>;
  const status = candidate.status;
  if (status !== 'healthy' && status !== 'degrading' && status !== 'exhausted') {
    return null;
  }

  return {
    status,
    remainingEstimate: normalizeRemainingEstimate(candidate.remainingEstimate),
    resetAt: normalizeIsoDate(candidate.resetAt ?? null),
    confidence: normalizeConfidence(candidate.confidence),
    lastLimitErrorAt: normalizeIsoDate(candidate.lastLimitErrorAt ?? null),
    lastSuccessAt: normalizeIsoDate(candidate.lastSuccessAt ?? null),
    lastReason: typeof candidate.lastReason === 'string' ? candidate.lastReason : null,
    consecutiveLimitErrors: Number.isInteger(candidate.consecutiveLimitErrors)
      ? Math.max(0, candidate.consecutiveLimitErrors as number)
      : 0,
    requestHistory: normalizeRequestHistory(candidate.requestHistory),
    consecutiveNearLimitSignals: Number.isInteger(candidate.consecutiveNearLimitSignals)
      ? Math.max(0, candidate.consecutiveNearLimitSignals as number)
      : 0,
    lastNearLimitAt: normalizeIsoDate(candidate.lastNearLimitAt ?? null),
    budgetSignal: normalizeBudgetSignal(candidate.budgetSignal ?? null),
  };
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeOpenRouterCredits(value: unknown): OpenRouterCreditsSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Partial<OpenRouterCreditsSnapshot>;
  const updatedAt = normalizeIsoDate(candidate.updatedAt ?? null);
  if (!updatedAt) {
    return undefined;
  }

  let lastFetchError: OpenRouterCreditsSnapshot['lastFetchError'] = null;
  if (candidate.lastFetchError && typeof candidate.lastFetchError === 'object') {
    const error = candidate.lastFetchError as { message?: unknown; at?: unknown };
    const at = normalizeIsoDate(error.at as string | null);
    if (typeof error.message === 'string' && at) {
      lastFetchError = { message: error.message, at };
    }
  }

  return {
    totalCredits: normalizeNullableNumber(candidate.totalCredits),
    totalUsage: normalizeNullableNumber(candidate.totalUsage),
    balanceUsd: normalizeNullableNumber(candidate.balanceUsd),
    usageDaily: normalizeNullableNumber(candidate.usageDaily),
    updatedAt,
    lastFetchError,
  };
}

function normalizeProviders(value: unknown): ProvidersQuotaState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const openrouter = normalizeOpenRouterCredits((value as { openrouter?: unknown }).openrouter);
  return openrouter ? { openrouter } : undefined;
}

function loadFile(repoDir?: string): LoadedQuotaState {
  const { statePath } = resolveStatePaths(repoDir);

  if (!existsSync(statePath)) {
    return {
      state: emptyState(),
      writeAllowed: true,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<QuotaStateFile>;

    if (!parsed || typeof parsed !== 'object') {
      return { state: emptyState(), writeAllowed: true };
    }

    if (typeof parsed.version === 'number' && parsed.version > QUOTA_STATE_VERSION) {
      console.warn(
        `Quota state file at ${statePath} uses unsupported version ${parsed.version}; refusing to modify it.`,
      );
      return { state: emptyState(), writeAllowed: false };
    }

    if (parsed.version !== 1 && parsed.version !== QUOTA_STATE_VERSION) {
      return { state: emptyState(), writeAllowed: true };
    }

    const models = parsed.models && typeof parsed.models === 'object'
      ? Object.entries(parsed.models).reduce<Record<string, StoredQuotaEntry>>((acc, [modelId, entry]) => {
        const normalized = normalizeStoredEntry(entry);
        if (normalized) {
          acc[modelId] = normalized;
        }
        return acc;
      }, {})
      : {};

    return {
      state: {
        version: QUOTA_STATE_VERSION,
        updatedAt: normalizeIsoDate(parsed.updatedAt ?? null) ?? new Date(now()).toISOString(),
        models,
        providers: normalizeProviders(parsed.providers),
      },
      writeAllowed: true,
    };
  } catch {
    return { state: emptyState(), writeAllowed: true };
  }
}

function saveFile(state: QuotaStateFile, repoDir?: string): void {
  const { statePath } = resolveStatePaths(repoDir);
  const stateDir = dirname(statePath);
  const tmpPath = join(stateDir, `.quota-state.json.tmp-${process.pid}-${randomUUID()}`);

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, statePath);
}

function acquireLock(repoDir?: string): LockHandle {
  const { lockPath } = resolveStatePaths(repoDir);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  return acquireStateLockSync(lockPath.slice(0, -5), { timeoutMs: QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS, purpose: 'quota-state' });
}

function releaseLock(handle: LockHandle): void { releaseStateLock(handle); }

function toPublicEntry(entry: StoredQuotaEntry): QuotaEntry {
  return {
    status: entry.status,
    remainingEstimate: entry.remainingEstimate,
    resetAt: entry.resetAt,
    confidence: entry.confidence,
    lastLimitErrorAt: entry.lastLimitErrorAt,
    lastSuccessAt: entry.lastSuccessAt,
    lastReason: entry.lastReason,
  };
}

function cloneProviders(providers: ProvidersQuotaState | undefined): ProvidersQuotaState | undefined {
  if (!providers?.openrouter) {
    return undefined;
  }
  return {
    openrouter: {
      ...providers.openrouter,
      lastFetchError: providers.openrouter.lastFetchError
        ? { ...providers.openrouter.lastFetchError }
        : null,
    },
  };
}

function project(
  entry: StoredQuotaEntry,
  nowMs: number,
  thresholds: ProactiveThresholds = resolveThresholds(),
): StoredQuotaEntry {
  const resetAtMs = parseIsoDate(entry.resetAt);
  const trimmedHistory = trimRequestHistory(entry.requestHistory, nowMs);
  const recentNearLimitAt = parseIsoDate(entry.lastNearLimitAt);
  const nearLimitStillRecent = recentNearLimitAt != null
    && nowMs - recentNearLimitAt <= QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS;
  const baseEntry: StoredQuotaEntry = {
    ...entry,
    requestHistory: trimmedHistory,
    consecutiveNearLimitSignals: nearLimitStillRecent
      ? entry.consecutiveNearLimitSignals
      : 0,
    lastNearLimitAt: nearLimitStillRecent ? entry.lastNearLimitAt : null,
  };

  if (resetAtMs != null && nowMs >= resetAtMs) {
    return {
      ...baseEntry,
      status: 'healthy',
      remainingEstimate: null,
      resetAt: null,
      confidence: 0.8,
      consecutiveLimitErrors: 0,
      consecutiveNearLimitSignals: 0,
      lastNearLimitAt: null,
    };
  }

  const lastLimitErrorAtMs = parseIsoDate(entry.lastLimitErrorAt);
  if (lastLimitErrorAtMs == null) {
    const signals = evaluateHeuristicSignals(baseEntry, nowMs, thresholds);
    if (baseEntry.status === 'healthy' && (
      signals.volumeTriggered
      || signals.nearLimitRatioTriggered
      || signals.nearLimitCountTriggered
      || signals.budgetTriggered
    )) {
      return {
        ...baseEntry,
        status: 'degrading',
        confidence: Math.max(baseEntry.confidence, 0.55),
      };
    }
    return baseEntry;
  }

  if (
    entry.status === 'degrading'
    && nowMs - lastLimitErrorAtMs > QUOTA_STATE_TIMINGS.DEGRADING_DECAY_MS
  ) {
    return {
      ...baseEntry,
      status: 'healthy',
      confidence: 0.6,
      consecutiveLimitErrors: 0,
    };
  }

  if (
    entry.status === 'exhausted'
    && nowMs - lastLimitErrorAtMs > QUOTA_STATE_TIMINGS.EXHAUSTED_DECAY_MS
  ) {
    return {
      ...baseEntry,
      status: 'degrading',
      confidence: 0.5,
      consecutiveLimitErrors: 0,
    };
  }

  const signals = evaluateHeuristicSignals(baseEntry, nowMs, thresholds);
  if (baseEntry.status === 'healthy' && (
    signals.volumeTriggered
    || signals.nearLimitRatioTriggered
    || signals.nearLimitCountTriggered
    || signals.budgetTriggered
  )) {
    return {
      ...baseEntry,
      status: 'degrading',
      confidence: Math.max(baseEntry.confidence, 0.55),
    };
  }

  return baseEntry;
}

function mutateWithLock(repoDir: string | undefined, mutator: (state: QuotaStateFile) => boolean): void {
  const lock = acquireLock(repoDir);

  try {
    const loaded = loadFile(repoDir);
    if (!loaded.writeAllowed) {
      return;
    }

    const changed = mutator(loaded.state);
    if (!changed) {
      return;
    }

    loaded.state.updatedAt = new Date(now()).toISOString();
    saveFile(loaded.state, repoDir);
  } finally {
    releaseLock(lock);
  }
}

function freezeValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    freezeValue(nestedValue);
  }

  return value;
}

function warnWriteFailure(action: string, error: unknown): void {
  console.warn(`Failed to ${action} quota state: ${errorMessage(error)}`);
}

export function readQuotaSnapshot(repoDir?: string): QuotaSnapshot {
  const { state } = loadFile(repoDir);
  const snapshotAt = new Date(now()).toISOString();
  const quotaConfig = getQuotaConfig(repoDir);
  const thresholds = resolveThresholds(repoDir);
  const models = Object.entries(state.models).reduce<Record<string, Readonly<QuotaEntry>>>((acc, [modelId, entry]) => {
    const projected = project(entry, now(), thresholds);
    const override = quotaConfig.manualOverrides?.[modelId];
    const expiresAtMs = parseIsoDate(override?.expiresAt);
    const overrideActive = override != null
      && (expiresAtMs == null || expiresAtMs > now());
    if (overrideActive && override) {
      acc[modelId] = freezeValue(toPublicEntry({
        ...projected,
        status: override.status,
        confidence: Math.max(projected.confidence, 0.9),
        lastReason: override.reason ?? projected.lastReason,
      }));
      return acc;
    }
    acc[modelId] = freezeValue(toPublicEntry(projected));
    return acc;
  }, {});

  if (quotaConfig.manualOverrides) {
    for (const [modelId, override] of Object.entries(quotaConfig.manualOverrides)) {
      if (models[modelId]) {
        continue;
      }
      const expiresAtMs = parseIsoDate(override.expiresAt);
      const overrideActive = expiresAtMs == null || expiresAtMs > now();
      if (!overrideActive) {
        continue;
      }
      models[modelId] = freezeValue({
        status: override.status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 0.9,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: override.reason ?? 'manual override',
      });
    }
  }

  return freezeValue({
    models,
    providers: cloneProviders(state.providers),
    snapshotAt,
  });
}

export function readOpenRouterCredits(repoDir?: string): OpenRouterCreditsSnapshot | null {
  return cloneProviders(loadFile(repoDir).state.providers)?.openrouter ?? null;
}

export function writeOpenRouterCredits(
  repoDir: string | undefined,
  input: OpenRouterCreditsSnapshot | { error: string },
): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const nowIso = new Date(now()).toISOString();
      const current = state.providers?.openrouter;
      state.providers = state.providers ?? {};

      if ('error' in input) {
        state.providers.openrouter = {
          totalCredits: current?.totalCredits ?? null,
          totalUsage: current?.totalUsage ?? null,
          balanceUsd: current?.balanceUsd ?? null,
          usageDaily: current?.usageDaily ?? null,
          updatedAt: current?.updatedAt ?? nowIso,
          lastFetchError: { message: input.error, at: nowIso },
        };
        return true;
      }

      state.providers.openrouter = {
        totalCredits: normalizeNullableNumber(input.totalCredits),
        totalUsage: normalizeNullableNumber(input.totalUsage),
        balanceUsd: normalizeNullableNumber(input.balanceUsd),
        usageDaily: normalizeNullableNumber(input.usageDaily),
        updatedAt: normalizeIsoDate(input.updatedAt) ?? nowIso,
        lastFetchError: input.lastFetchError,
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('write OpenRouter credits', error);
  }
}

export function getVendorQuotaBreakdown(
  snapshot: QuotaSnapshot,
  frontierModels: ReadonlyArray<{ modelId: string; vendor: string }>,
): Record<string, VendorQuotaStats> {
  return frontierModels.reduce<Record<string, VendorQuotaStats>>((acc, { modelId, vendor }) => {
    const vendorKey = typeof vendor === 'string' && vendor.trim().length > 0
      ? vendor.trim()
      : 'unknown';
    const stats = acc[vendorKey] ?? {
      healthy: 0,
      degraded: 0,
      exhausted: 0,
      total: 0,
    };
    const status = snapshot.models[modelId]?.status ?? 'healthy';

    if (status === 'healthy') {
      stats.healthy += 1;
    } else if (status === 'degrading') {
      stats.degraded += 1;
    } else {
      stats.exhausted += 1;
    }

    stats.total += 1;
    acc[vendorKey] = stats;
    return acc;
  }, {});
}

export function getModelStatus(modelId: string, repoDir?: string): QuotaStatus {
  return readQuotaSnapshot(repoDir).models[modelId]?.status ?? 'healthy';
}

export function recordLimitError(input: LimitErrorInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const thresholds = resolveThresholds(repoDir);
      const current = state.models[input.modelId] ?? emptyStoredEntry();
      const effective = project(current, now(), thresholds);
      const lastLimitErrorAtMs = parseIsoDate(effective.lastLimitErrorAt);
      const lastWasRecent = lastLimitErrorAtMs != null
        && now() - lastLimitErrorAtMs <= QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS;
      const consecutiveLimitErrors = lastWasRecent
        ? effective.consecutiveLimitErrors + 1
        : 1;

      const nextStatus: QuotaStatus = effective.status === 'exhausted'
        ? 'exhausted'
        : consecutiveLimitErrors >= 2
          ? 'exhausted'
          : 'degrading';

      state.models[input.modelId] = {
        status: nextStatus,
        remainingEstimate: normalizeRemainingEstimate(input.remainingEstimate),
        resetAt: normalizeIsoDate(input.resetAt ?? null),
        confidence: nextStatus === 'degrading' ? 0.5 : 0.9,
        lastLimitErrorAt: new Date(now()).toISOString(),
        lastSuccessAt: effective.lastSuccessAt,
        lastReason: input.reason ?? null,
        consecutiveLimitErrors,
        requestHistory: effective.requestHistory,
        consecutiveNearLimitSignals: effective.consecutiveNearLimitSignals,
        lastNearLimitAt: effective.lastNearLimitAt,
        budgetSignal: effective.budgetSignal,
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('record limit-error', error);
  }
}

export function recordSuccess(input: SuccessInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const current = state.models[input.modelId];
      const lastLimitErrorAt = current?.lastLimitErrorAt ?? null;
      const requestHistory = trimRequestHistory(current?.requestHistory ?? [], now());
      const budgetSignal = normalizeBudgetSignal(current?.budgetSignal ?? null);

      state.models[input.modelId] = {
        status: 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt,
        lastSuccessAt: new Date(now()).toISOString(),
        lastReason: null,
        consecutiveLimitErrors: 0,
        requestHistory,
        consecutiveNearLimitSignals: 0,
        lastNearLimitAt: null,
        budgetSignal,
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('record success', error);
  }
}

export function markExhausted(input: ExhaustedInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const current = state.models[input.modelId] ?? emptyStoredEntry();
      const effective = project(current, now());

      state.models[input.modelId] = {
        status: 'exhausted',
        remainingEstimate: normalizeRemainingEstimate(input.remainingEstimate),
        resetAt: normalizeIsoDate(input.resetAt ?? null),
        confidence: typeof input.confidence === 'number' ? normalizeConfidence(input.confidence) : 0.9,
        lastLimitErrorAt: new Date(now()).toISOString(),
        lastSuccessAt: effective.lastSuccessAt,
        lastReason: input.reason ?? effective.lastReason,
        consecutiveLimitErrors: Math.max(2, effective.consecutiveLimitErrors),
        requestHistory: effective.requestHistory,
        consecutiveNearLimitSignals: effective.consecutiveNearLimitSignals,
        lastNearLimitAt: effective.lastNearLimitAt,
        budgetSignal: effective.budgetSignal,
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('mark exhausted', error);
  }
}

export function compactQuotaState(repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const thresholds = resolveThresholds(repoDir);
      let changed = false;
      const nextModels = Object.entries(state.models).reduce<Record<string, StoredQuotaEntry>>((acc, [modelId, entry]) => {
        const projected = project(entry, now(), thresholds);
        acc[modelId] = projected;

        if (JSON.stringify(projected) !== JSON.stringify(entry)) {
          changed = true;
        }

        return acc;
      }, {});

      if (!changed) {
        return false;
      }

      state.models = nextModels;
      return true;
    });
  } catch (error) {
    warnWriteFailure('compact', error);
  }
}

export function recordRequest(input: RequestInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const thresholds = resolveThresholds(repoDir);
      const current = state.models[input.modelId] ?? emptyStoredEntry();
      const effective = project(current, now(), thresholds);
      const requestHistory = trimRequestHistory([
        ...effective.requestHistory,
        { timestamp: new Date(now()).toISOString() },
      ], now());

      state.models[input.modelId] = {
        ...effective,
        requestHistory,
        lastSuccessAt: new Date(now()).toISOString(),
        budgetSignal: normalizeBudgetSignal(input.budgetSignal ?? effective.budgetSignal),
      };

      return true;
    });
  } catch (error) {
    warnWriteFailure('record request', error);
  }
}

export function recordNearLimit(input: NearLimitInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const thresholds = resolveThresholds(repoDir);
      const current = state.models[input.modelId] ?? emptyStoredEntry();
      const effective = project(current, now(), thresholds);
      const nearLimitAt = new Date(now()).toISOString();
      const lastNearLimitAtMs = parseIsoDate(effective.lastNearLimitAt);
      const lastWasRecent = lastNearLimitAtMs != null
        && now() - lastNearLimitAtMs <= QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS;

      const consecutiveNearLimitSignals = lastWasRecent
        ? effective.consecutiveNearLimitSignals + 1
        : 1;

      state.models[input.modelId] = {
        ...effective,
        status: effective.status === 'exhausted' ? 'exhausted' : 'degrading',
        confidence: Math.max(effective.confidence, 0.55),
        remainingEstimate: normalizeRemainingEstimate(input.remainingEstimate),
        lastNearLimitAt: nearLimitAt,
        lastReason: input.reason ?? effective.lastReason,
        consecutiveNearLimitSignals,
        budgetSignal: normalizeBudgetSignal(input.budgetSignal ?? (
          normalizePositiveNumber(input.remainingEstimate ?? null) != null
          && normalizePositiveNumber(input.limitEstimate ?? null) != null
            ? {
                remaining: input.remainingEstimate as number,
                limit: input.limitEstimate as number,
                window: 'provider',
              }
            : effective.budgetSignal
        )),
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('record near-limit', error);
  }
}

export function estimateQuotaHealth(modelId: string, repoDir?: string): QuotaHealthEstimate {
  const { state } = loadFile(repoDir);
  const thresholds = resolveThresholds(repoDir);
  const entry = project(state.models[modelId] ?? emptyStoredEntry(), now(), thresholds);
  const signals = evaluateHeuristicSignals(entry, now(), thresholds);
  if (
    entry.status === 'degrading'
    || entry.status === 'exhausted'
    || signals.volumeTriggered
    || signals.nearLimitRatioTriggered
    || signals.nearLimitCountTriggered
    || signals.budgetTriggered
  ) {
    return 'degrading';
  }

  const approachVolume = signals.volumeCount >= Math.ceil(signals.volumeThresholdCount * 0.8);
  const hasNearLimitSignal = entry.consecutiveNearLimitSignals > 0;
  const lowBudget = entry.budgetSignal != null
    && entry.budgetSignal.limit > 0
    && (entry.budgetSignal.remaining / entry.budgetSignal.limit) * 100 <= thresholds.budgetThresholdPercent * 1.2;
  if (approachVolume || hasNearLimitSignal || lowBudget) {
    return 'approaching_degradation';
  }

  return 'healthy';
}

export function __resetQuotaStateTestState(): void {
  __resetClock();
  QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS = 5 * 60_000;
  QUOTA_STATE_TIMINGS.DEGRADING_DECAY_MS = 10 * 60_000;
  QUOTA_STATE_TIMINGS.EXHAUSTED_DECAY_MS = 30 * 60_000;
  QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
}
