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

// ---------------------------------------------------------------------------
// HOK-3314: single queue-alert projection shared by every consumer.
//
// Observer queue-health findings, dependency incident detection, dashboard
// rendering, status summaries, and the degraded banner all used to derive
// "is this queue condition active, and how serious is it?" independently.
// `deriveQueueAlertProjection` is the one answer — every consumer reads it.
// ---------------------------------------------------------------------------

/** Current queue alert status. `unknown` is explicit; never silently healthy. */
export type QueueAlertStatus =
  | 'healthy'
  | 'degraded-inference'
  | 'degraded-planner'
  | 'unknown';

export type QueueAlertSeverity = 'low' | 'medium' | 'high';

/**
 * Current failed-attempt episode. `startedAt` is `'unknown'` only when legacy
 * data cannot recover a start time — never substitute `firstObservedAt` or
 * `createdAt` from the incident store.
 */
export interface QueueAlertEpisode {
  /** Stable id for an unbroken run of failures. Changes when a new episode begins. */
  id: string;
  /** Deterministic kind for the id/debugging. */
  kind: 'inference' | 'planner';
  /** The first failed-attempt time of this run, or `'unknown'` for pre-HOK-3314 data. */
  startedAt: string | 'unknown';
  /**
   * Completed inference/planner attempts that failed in the current episode.
   * Cache-only / cooldown / skipped runs do not count.
   */
  consecutiveFailedAttempts: number;
  latestFailureAt: string | null;
  latestSuccessAt: string | null;
  severity: QueueAlertSeverity;
}

export interface QueueAlertProjection {
  schemaVersion: 1;
  status: QueueAlertStatus;
  /** Non-null only when `status !== 'healthy'` (unknown has a low-severity episode). */
  episode: QueueAlertEpisode | null;
  /** Human-readable current-episode summary. */
  summary: string;
  /** Downstream intent for the picker/banner. */
  nextAction: 'use_dependency_queue' | 'use_cached_and_explicit_edges' | 'use_explicit_edges_only' | 'retry_after_backoff' | 'operator';
  /** Stale/missing/incomplete-cycle labels; empty when evidence is fresh and complete. */
  evidenceWarnings: string[];
}

export const QUEUE_ALERT_PROJECTION_SCHEMA_VERSION = 1 as const;

/**
 * One queue-health shape the projection reads. Deliberately permissive: callers
 * pass whatever `.wavemill/queue-health.json` holds, warts and all.
 */
export interface QueueHealthStateLike {
  status?: unknown;
  degradationReason?: unknown;
  episodeStartedAt?: unknown;
  failureCount?: unknown;
  inferenceStatus?: unknown;
  inferredEdgeCount?: unknown;
  lastAttemptAt?: unknown;
  lastFailureAt?: unknown;
  lastSuccessfulPlanAt?: unknown;
  inference?: {
    model?: unknown;
    lastAttemptAt?: unknown;
    lastSuccessAt?: unknown;
    consecutiveFailures?: unknown;
    error?: unknown;
    refreshKind?: unknown;
    skipReason?: unknown;
  } | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The one severity ladder. 1 → low; 3 → medium; 5 → high. */
export function queueAlertSeverityForCount(count: number): QueueAlertSeverity {
  if (count >= 5) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

/** Deterministic id so a repeated-poll projection is self-identifying. */
function queueAlertEpisodeId(kind: 'inference' | 'planner', startedAt: string | 'unknown'): string {
  return `queue-alert:${kind}:${startedAt}`;
}

/**
 * One projection. Three decisions:
 *  - status: healthy / degraded-inference / degraded-planner / unknown.
 *  - episode identity + count (never advanced by cache-only polls).
 *  - severity (ladder; current, not historical).
 *
 * `observerCycleComplete=false` forces `unknown` — "no cycle finished" never
 * implies healthy. Missing/corrupt queue-health is `unknown` with a warning,
 * never healthy.
 */
export function deriveQueueAlertProjection(input: {
  queueHealth: QueueHealthStateLike | undefined;
  inferenceState?: QueueInferenceState | undefined;
  previousEpisode?: QueueAlertEpisode | null;
  observerCycleComplete?: boolean;
  nowMs: number;
}): QueueAlertProjection {
  const { queueHealth, inferenceState, previousEpisode = null } = input;
  const observerCycleComplete = input.observerCycleComplete ?? true;
  const warnings: string[] = [];

  if (!observerCycleComplete) {
    warnings.push('observer cycle did not complete this pass');
  }

  if (!queueHealth || typeof queueHealth !== 'object') {
    warnings.push('queue-health.json missing or unreadable');
    return {
      schemaVersion: QUEUE_ALERT_PROJECTION_SCHEMA_VERSION,
      status: 'unknown',
      episode: {
        id: queueAlertEpisodeId('inference', 'unknown'),
        kind: 'inference',
        startedAt: 'unknown',
        consecutiveFailedAttempts: 0,
        latestFailureAt: null,
        latestSuccessAt: null,
        severity: 'low',
      },
      summary: 'Queue health evidence missing — unable to confirm inference or planner status.',
      nextAction: 'operator',
      evidenceWarnings: warnings,
    };
  }

  const topLevelStatus = asString(queueHealth.status);
  const reason = asString(queueHealth.degradationReason);
  const inferenceStatusField = asString(queueHealth.inferenceStatus);
  const inferredEdgeCount = asNumber(queueHealth.inferredEdgeCount) ?? 0;
  const inference = queueHealth.inference && typeof queueHealth.inference === 'object'
    ? queueHealth.inference
    : null;

  const inferenceLastSuccess = asString(inference?.lastSuccessAt) ?? inferenceState?.lastSuccessAt ?? null;
  const inferenceLastFailure = asString(inference?.lastAttemptAt) ?? inferenceState?.lastAttemptAt ?? null;
  const inferenceConsecutive = asNumber(inference?.consecutiveFailures) ?? inferenceState?.consecutiveFailures ?? 0;
  const plannerEpisodeStartedAt = asString(queueHealth.episodeStartedAt);
  const plannerFailureCount = asNumber(queueHealth.failureCount) ?? 0;
  const plannerLastFailure = asString(queueHealth.lastFailureAt);
  const plannerLastSuccess = asString(queueHealth.lastSuccessfulPlanAt);

  if (!observerCycleComplete) {
    return {
      schemaVersion: QUEUE_ALERT_PROJECTION_SCHEMA_VERSION,
      status: 'unknown',
      episode: previousEpisode ?? {
        id: queueAlertEpisodeId('inference', 'unknown'),
        kind: 'inference',
        startedAt: 'unknown',
        consecutiveFailedAttempts: 0,
        latestFailureAt: inferenceLastFailure,
        latestSuccessAt: inferenceLastSuccess,
        severity: 'low',
      },
      summary: 'Observer cycle incomplete — queue alert state is not authoritative.',
      nextAction: 'operator',
      evidenceWarnings: warnings,
    };
  }

  // Degraded-inference: planner succeeded, inference did not. Severity and
  // episode identity come from the inference block, not planner failureCount.
  if (reason === 'inference_unavailable' || inferenceStatusField === 'failed' || inferenceStatusField === 'stale') {
    const count = Math.max(1, inferenceConsecutive);
    const startedAt = carriedEpisodeStart({
      previous: previousEpisode?.kind === 'inference' ? previousEpisode : null,
      candidate: inferenceLastFailure,
    });
    const episode: QueueAlertEpisode = {
      id: queueAlertEpisodeId('inference', startedAt),
      kind: 'inference',
      startedAt,
      consecutiveFailedAttempts: count,
      latestFailureAt: inferenceLastFailure,
      latestSuccessAt: inferenceLastSuccess,
      severity: queueAlertSeverityForCount(count),
    };
    return {
      schemaVersion: QUEUE_ALERT_PROJECTION_SCHEMA_VERSION,
      status: 'degraded-inference',
      episode,
      summary: formatInferenceSummary(episode, inferredEdgeCount),
      nextAction: inferredEdgeCount > 0 ? 'use_cached_and_explicit_edges' : 'use_explicit_edges_only',
      evidenceWarnings: warnings,
    };
  }

  // Degraded-planner: a planner failure that is not inference-unavailable.
  if (topLevelStatus === 'degraded' && reason) {
    const count = Math.max(1, plannerFailureCount);
    const startedAt = carriedEpisodeStart({
      previous: previousEpisode?.kind === 'planner' ? previousEpisode : null,
      candidate: plannerEpisodeStartedAt ?? plannerLastFailure,
    });
    const episode: QueueAlertEpisode = {
      id: queueAlertEpisodeId('planner', startedAt),
      kind: 'planner',
      startedAt,
      consecutiveFailedAttempts: count,
      latestFailureAt: plannerLastFailure,
      latestSuccessAt: plannerLastSuccess,
      severity: queueAlertSeverityForCount(count),
    };
    return {
      schemaVersion: QUEUE_ALERT_PROJECTION_SCHEMA_VERSION,
      status: 'degraded-planner',
      episode,
      summary: formatPlannerSummary(episode, reason),
      nextAction: 'retry_after_backoff',
      evidenceWarnings: warnings,
    };
  }

  // Status says healthy. Trust it only when the inference block agrees.
  if (topLevelStatus === 'healthy' && (inferenceStatusField === 'ok' || inferenceStatusField === null || inferenceStatusField === 'never')) {
    return {
      schemaVersion: QUEUE_ALERT_PROJECTION_SCHEMA_VERSION,
      status: 'healthy',
      episode: null,
      summary: 'Queue inference and planner healthy.',
      nextAction: 'use_dependency_queue',
      evidenceWarnings: warnings,
    };
  }

  // Anything else (missing status, contradictory inferenceStatus): unknown.
  warnings.push(`queue-health status "${topLevelStatus ?? 'absent'}" / inferenceStatus "${inferenceStatusField ?? 'absent'}" is not conclusive`);
  return {
    schemaVersion: QUEUE_ALERT_PROJECTION_SCHEMA_VERSION,
    status: 'unknown',
    episode: previousEpisode ?? {
      id: queueAlertEpisodeId('inference', 'unknown'),
      kind: 'inference',
      startedAt: 'unknown',
      consecutiveFailedAttempts: 0,
      latestFailureAt: inferenceLastFailure,
      latestSuccessAt: inferenceLastSuccess,
      severity: 'low',
    },
    summary: 'Queue alert evidence inconclusive — manual inspection required.',
    nextAction: 'operator',
    evidenceWarnings: warnings,
  };
}

function carriedEpisodeStart(input: {
  previous: QueueAlertEpisode | null;
  candidate: string | null;
}): string | 'unknown' {
  if (input.previous && input.previous.startedAt !== 'unknown') return input.previous.startedAt;
  if (input.candidate) return input.candidate;
  if (input.previous && input.previous.startedAt === 'unknown') return 'unknown';
  return 'unknown';
}

function formatInferenceSummary(episode: QueueAlertEpisode, inferredEdgeCount: number): string {
  const attempts = episode.consecutiveFailedAttempts;
  const noun = attempts === 1 ? 'failed attempt' : 'failed attempts';
  const edges = inferredEdgeCount > 0
    ? ` · cached inferred edges still in use`
    : ` · explicit relations only`;
  const success = episode.latestSuccessAt ? ` · last success ${episode.latestSuccessAt}` : '';
  const failure = episode.latestFailureAt ? ` · last failure ${episode.latestFailureAt}` : '';
  return `Queue inference unavailable · ${attempts} consecutive ${noun}${success}${failure}${edges}`;
}

function formatPlannerSummary(episode: QueueAlertEpisode, reason: string): string {
  const attempts = episode.consecutiveFailedAttempts;
  const noun = attempts === 1 ? 'failure' : 'failures';
  const failure = episode.latestFailureAt ? ` · last ${episode.latestFailureAt}` : '';
  return `Queue planner degraded (${reason}) · ${attempts} consecutive ${noun}${failure}`;
}

/**
 * HOK-3314: unified name for an inference attempt. `recordInferenceSuccess` /
 * `recordInferenceFailure` are kept as thin aliases for existing call sites;
 * the attempt-id ties the state back to the real inference turn, so new code
 * can retrieve the authoritative identity instead of the planner wrapper.
 */
export function recordInferenceAttempt(
  state: QueueInferenceState | undefined,
  input:
    | { outcome: 'ok'; model: string | null; nowIso: string; attemptId?: string }
    | { outcome: 'failed'; error: unknown; nowIso: string; attemptId?: string; model?: string | null },
): QueueInferenceState {
  if (input.outcome === 'ok') return recordInferenceSuccess({ model: input.model ?? null, nowIso: input.nowIso });
  return recordInferenceFailure(state, { error: input.error, nowIso: input.nowIso });
}
