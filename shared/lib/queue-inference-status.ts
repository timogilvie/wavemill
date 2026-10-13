/**
 * Queue dependency-inference status (HOK-3130).
 *
 * `tools/plan-queue.ts` is the only process that knows whether the queue
 * classifier actually answered. Before HOK-3130 a classifier failure was
 * swallowed, fingerprints advanced anyway (so the failed tasks were never
 * re-classified), and queue health reported `healthy` with zero inferred
 * edges. This module holds the pure state machine that replaces that:
 *
 * - {@link QueueInferenceState} is persisted additively in the task-dependency
 *   cache (`inference` block) so success/failure survives across runs.
 * - {@link deriveInferenceStatus} maps it to `ok | failed | stale | never`.
 * - {@link planInferenceRefresh} decides whether this run classifies the full
 *   backlog, only the changed tasks, or nothing (including a failure cooldown).
 * - {@link buildInferenceReport} is the JSON the monitor merges into
 *   `.wavemill/queue-health.json` (`--inference-report-file`).
 *
 * Every function takes the clock explicitly so behavior is deterministic in tests.
 */

/** Health-facing inference status. Anything but `ok` degrades queue health. */
export type QueueInferenceStatus = 'ok' | 'failed' | 'stale' | 'never';

/** Kind of classifier refresh a plan-queue run performs. */
export type InferenceRefreshKind = 'full' | 'partial' | 'none';

/** Why a run did not attempt inference. `null` when it did. */
export type InferenceSkipReason = 'cooldown' | 'no_changes' | 'cache_disabled' | null;

/** Persisted inference bookkeeping (the cache file's optional `inference` block). */
export interface QueueInferenceState {
  /** ISO timestamp of the last classifier attempt, successful or not. */
  lastAttemptAt: string | null;
  /** ISO timestamp of the last attempt where a model actually answered with parseable edges. */
  lastSuccessAt: string | null;
  lastOutcome: 'ok' | 'failed' | null;
  /** Model that actually answered on the last success. */
  lastModel: string | null;
  /** First line of the last failure, at most {@link INFERENCE_ERROR_MAX_CHARS} chars. */
  lastError: string | null;
  consecutiveFailures: number;
}

/** Refresh decision for one plan-queue run. */
export interface InferenceRefreshPlan {
  kind: InferenceRefreshKind;
  skipReason: InferenceSkipReason;
}

/** Report written to `--inference-report-file` for the monitor. */
export interface QueueInferenceReport {
  schemaVersion: 1;
  inferenceStatus: QueueInferenceStatus;
  /** Inferred (cache-sourced) edges used in this plan; explicit Linear relations excluded. */
  inferredEdgeCount: number;
  attempted: boolean;
  refreshKind: InferenceRefreshKind;
  skipReason: InferenceSkipReason;
  model: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** Last failure message while the status is `failed`, otherwise `null`. */
  error: string | null;
}

export const QUEUE_INFERENCE_REPORT_SCHEMA_VERSION = 1 as const;

/**
 * A success older than this is `stale`. The mill revalidates with a full
 * refresh once it is, so a static backlog re-proves inference about daily
 * instead of drifting into a false `degraded`.
 */
export const QUEUE_INFERENCE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * True when a cached inferred edge is older than the inference state's last
 * successful refresh (HOK-3179). A later successful refresh that did not
 * re-emit the edge means the current classifier no longer stands by it;
 * callers surface such edges as stale and prefer explicit relations.
 */
export function isInferredEdgeStale(
  classifiedAt: string | null | undefined,
  state: QueueInferenceState | undefined,
): boolean {
  if (!state || !state.lastSuccessAt || !classifiedAt) return false;
  const classifiedMs = Date.parse(classifiedAt);
  const lastSuccessMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(classifiedMs) || !Number.isFinite(lastSuccessMs)) return false;
  return classifiedMs < lastSuccessMs;
}

/**
 * After a failed attempt, skip inference for this long. The mill polls the
 * planner every ~60s and one failing ladder can hold the loop for most of
 * its 52s deadline, so without a cooldown a broken classifier stalls every poll.
 */
export const QUEUE_INFERENCE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

export const INFERENCE_ERROR_MAX_CHARS = 300;

/** Fresh state for caches that predate HOK-3130 (derives to `never`). */
export function emptyInferenceState(): QueueInferenceState {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    lastModel: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Coerce an untrusted `inference` block (read from disk) into a valid state.
 * Returns `undefined` for anything that is not an object so a malformed block
 * is dropped on its own without invalidating the rest of the cache.
 */
export function normalizeInferenceState(value: unknown): QueueInferenceState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const failures = typeof raw.consecutiveFailures === 'number' && Number.isFinite(raw.consecutiveFailures)
    ? Math.max(0, Math.floor(raw.consecutiveFailures))
    : 0;
  return {
    lastAttemptAt: stringOrNull(raw.lastAttemptAt),
    lastSuccessAt: stringOrNull(raw.lastSuccessAt),
    lastOutcome: raw.lastOutcome === 'ok' || raw.lastOutcome === 'failed' ? raw.lastOutcome : null,
    lastModel: stringOrNull(raw.lastModel),
    lastError: stringOrNull(raw.lastError),
    consecutiveFailures: failures,
  };
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Derive the health-facing status.
 *
 * Precedence: `failed` (sticky until the next success, including through the
 * cooldown) → `never` (no recorded success; covers pre-HOK-3130 caches) →
 * `stale` (success older than {@link QUEUE_INFERENCE_STALE_AFTER_MS}) → `ok`.
 */
export function deriveInferenceStatus(
  state: QueueInferenceState | undefined,
  nowMs: number,
): QueueInferenceStatus {
  const current = state ?? emptyInferenceState();
  if (current.lastOutcome === 'failed') return 'failed';
  const lastSuccessMs = parseMs(current.lastSuccessAt);
  if (lastSuccessMs === null) return 'never';
  if (nowMs - lastSuccessMs > QUEUE_INFERENCE_STALE_AFTER_MS) return 'stale';
  return 'ok';
}

/** True while a recent failure should suppress another attempt. */
export function isInCooldown(state: QueueInferenceState | undefined, nowMs: number): boolean {
  if (!state || state.lastOutcome !== 'failed') return false;
  const lastAttemptMs = parseMs(state.lastAttemptAt);
  return lastAttemptMs !== null && nowMs - lastAttemptMs < QUEUE_INFERENCE_FAILURE_COOLDOWN_MS;
}

/**
 * Decide what this run classifies.
 *
 * - `none/cooldown` while a recent failure is cooling down.
 * - `full` (only with `refreshMissing`, i.e. the mill) when there are no
 *   fingerprints yet, every task is new/changed, or the status is
 *   `never`/`stale`, or `failed` with nothing left pending. This self-heals
 *   caches whose fingerprints advanced without inference ever succeeding.
 * - `partial` when a strict subset of the backlog is new/changed.
 * - `none/no_changes` otherwise.
 */
export function planInferenceRefresh(input: {
  state: QueueInferenceState | undefined;
  previousFingerprintCount: number;
  /** `added + changed` from the backlog diff. */
  pendingCount: number;
  recordCount: number;
  refreshMissing: boolean;
  nowMs: number;
}): InferenceRefreshPlan {
  const { state, previousFingerprintCount, pendingCount, recordCount, refreshMissing, nowMs } = input;
  if (recordCount === 0) {
    return { kind: 'none', skipReason: 'no_changes' };
  }
  if (isInCooldown(state, nowMs)) {
    return { kind: 'none', skipReason: 'cooldown' };
  }

  const status = deriveInferenceStatus(state, nowMs);
  if (refreshMissing) {
    const needsFull =
      previousFingerprintCount === 0 ||
      pendingCount >= recordCount ||
      status === 'never' ||
      status === 'stale' ||
      (status === 'failed' && pendingCount === 0);
    if (needsFull) {
      return { kind: 'full', skipReason: null };
    }
  }

  if (previousFingerprintCount > 0 && pendingCount > 0 && pendingCount < recordCount) {
    return { kind: 'partial', skipReason: null };
  }

  return { kind: 'none', skipReason: 'no_changes' };
}

/** State after a model answered with a parseable edge list (an empty list counts). */
export function recordInferenceSuccess(input: { model: string | null; nowIso: string }): QueueInferenceState {
  return {
    lastAttemptAt: input.nowIso,
    lastSuccessAt: input.nowIso,
    lastOutcome: 'ok',
    lastModel: input.model,
    lastError: null,
    consecutiveFailures: 0,
  };
}

/** First line of an error message, capped at {@link INFERENCE_ERROR_MAX_CHARS}. */
export function summarizeInferenceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'unknown error';
  return firstLine.length > INFERENCE_ERROR_MAX_CHARS
    ? `${firstLine.slice(0, INFERENCE_ERROR_MAX_CHARS - 1)}…`
    : firstLine;
}

/** State after a classifier attempt failed (no model answered, or the answer was unparseable). */
export function recordInferenceFailure(
  state: QueueInferenceState | undefined,
  input: { error: unknown; nowIso: string },
): QueueInferenceState {
  const current = state ?? emptyInferenceState();
  return {
    ...current,
    lastAttemptAt: input.nowIso,
    lastOutcome: 'failed',
    lastError: summarizeInferenceError(input.error),
    consecutiveFailures: current.consecutiveFailures + 1,
  };
}

/** Assemble the monitor-facing report for one plan-queue run. */
export function buildInferenceReport(input: {
  state: QueueInferenceState | undefined;
  inferredEdgeCount: number;
  plan: InferenceRefreshPlan;
  nowMs: number;
}): QueueInferenceReport {
  const state = input.state ?? emptyInferenceState();
  const inferenceStatus = deriveInferenceStatus(state, input.nowMs);
  return {
    schemaVersion: QUEUE_INFERENCE_REPORT_SCHEMA_VERSION,
    inferenceStatus,
    inferredEdgeCount: input.inferredEdgeCount,
    attempted: input.plan.kind !== 'none',
    refreshKind: input.plan.kind,
    skipReason: input.plan.skipReason,
    model: state.lastModel,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    consecutiveFailures: state.consecutiveFailures,
    error: inferenceStatus === 'failed' ? state.lastError : null,
  };
}
