import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildInferenceReport,
  deriveInferenceStatus,
  deriveQueueAlertProjection,
  emptyInferenceState,
  INFERENCE_ERROR_MAX_CHARS,
  isInferredEdgeStale,
  normalizeInferenceState,
  planInferenceRefresh,
  QUEUE_INFERENCE_FAILURE_COOLDOWN_MS,
  QUEUE_INFERENCE_STALE_AFTER_MS,
  queueAlertSeverityForCount,
  recordInferenceAttempt,
  recordInferenceFailure,
  recordInferenceSuccess,
  type QueueAlertEpisode,
  type QueueInferenceState,
} from './queue-inference-status.ts';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function okState(successOffsetMs = -HOUR): QueueInferenceState {
  return recordInferenceSuccess({ model: 'claude-haiku-4-5-20251001', nowIso: iso(successOffsetMs) });
}

function failedState(attemptOffsetMs: number, base: QueueInferenceState = okState()): QueueInferenceState {
  return recordInferenceFailure(base, { error: new Error('classifier timeout'), nowIso: iso(attemptOffsetMs) });
}

describe('deriveInferenceStatus', () => {
  it('reports never for a missing or empty state', () => {
    assert.equal(deriveInferenceStatus(undefined, NOW), 'never');
    assert.equal(deriveInferenceStatus(emptyInferenceState(), NOW), 'never');
  });

  it('reports ok for a recent success', () => {
    assert.equal(deriveInferenceStatus(okState(), NOW), 'ok');
  });

  it('reports stale once the last success is older than the stale window', () => {
    assert.equal(deriveInferenceStatus(okState(-25 * HOUR), NOW), 'stale');
    assert.equal(deriveInferenceStatus(okState(-QUEUE_INFERENCE_STALE_AFTER_MS + MINUTE), NOW), 'ok');
  });

  it('keeps failed sticky even with an earlier success and outside the cooldown', () => {
    assert.equal(deriveInferenceStatus(failedState(-2 * HOUR, okState(-3 * HOUR)), NOW), 'failed');
  });
});

describe('planInferenceRefresh', () => {
  const base = {
    previousFingerprintCount: 4,
    pendingCount: 0,
    recordCount: 4,
    refreshMissing: true,
    nowMs: NOW,
  };

  it('runs a full refresh for empty fingerprints', () => {
    assert.deepEqual(
      planInferenceRefresh({ ...base, state: undefined, previousFingerprintCount: 0, pendingCount: 4 }),
      { kind: 'full', skipReason: null },
    );
  });

  it('runs a full refresh for never and stale states even with no pending changes', () => {
    assert.equal(planInferenceRefresh({ ...base, state: undefined }).kind, 'full');
    assert.equal(planInferenceRefresh({ ...base, state: okState(-25 * HOUR) }).kind, 'full');
  });

  it('runs a full refresh when every task is new or changed', () => {
    assert.equal(planInferenceRefresh({ ...base, state: okState(), pendingCount: 4 }).kind, 'full');
  });

  it('runs a partial refresh for a strict subset of changes', () => {
    assert.deepEqual(
      planInferenceRefresh({ ...base, state: okState(), pendingCount: 1 }),
      { kind: 'partial', skipReason: null },
    );
  });

  it('skips when nothing changed and inference is healthy', () => {
    assert.deepEqual(planInferenceRefresh({ ...base, state: okState() }), { kind: 'none', skipReason: 'no_changes' });
  });

  it('skips for an empty backlog', () => {
    assert.equal(planInferenceRefresh({ ...base, state: undefined, recordCount: 0, previousFingerprintCount: 0 }).kind, 'none');
  });

  it('holds a cooldown after a recent failure, then retries', () => {
    const recent = failedState(-5 * MINUTE);
    assert.deepEqual(
      planInferenceRefresh({ ...base, state: recent, pendingCount: 1 }),
      { kind: 'none', skipReason: 'cooldown' },
    );

    const cooled = failedState(-11 * MINUTE);
    assert.equal(planInferenceRefresh({ ...base, state: cooled, pendingCount: 1 }).kind, 'partial');
    assert.ok(11 * MINUTE > QUEUE_INFERENCE_FAILURE_COOLDOWN_MS);
  });

  it('retries a failed state with nothing pending as a full refresh after the cooldown', () => {
    assert.equal(planInferenceRefresh({ ...base, state: failedState(-11 * MINUTE) }).kind, 'full');
  });

  it('never forces a full refresh without refreshMissing, even when stale', () => {
    assert.deepEqual(
      planInferenceRefresh({ ...base, refreshMissing: false, state: okState(-25 * HOUR) }),
      { kind: 'none', skipReason: 'no_changes' },
    );
    assert.equal(
      planInferenceRefresh({ ...base, refreshMissing: false, state: undefined, previousFingerprintCount: 0, pendingCount: 4 }).kind,
      'none',
    );
    assert.equal(planInferenceRefresh({ ...base, refreshMissing: false, state: okState(), pendingCount: 1 }).kind, 'partial');
  });
});

describe('recordInferenceSuccess / recordInferenceFailure', () => {
  it('increments failures and resets them on success', () => {
    const once = failedState(-2 * MINUTE);
    const twice = recordInferenceFailure(once, { error: 'again', nowIso: iso(-MINUTE) });
    assert.equal(once.consecutiveFailures, 1);
    assert.equal(twice.consecutiveFailures, 2);
    assert.equal(twice.lastOutcome, 'failed');
    assert.equal(twice.lastSuccessAt, once.lastSuccessAt, 'failure keeps the last success timestamp');

    const recovered = recordInferenceSuccess({ model: 'claude-sonnet-5', nowIso: iso(0) });
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.lastOutcome, 'ok');
    assert.equal(recovered.lastModel, 'claude-sonnet-5');
    assert.equal(recovered.lastError, null);
  });

  it('keeps only the first non-empty line of an error, truncated', () => {
    const state = recordInferenceFailure(undefined, {
      error: new Error(`\n${'e'.repeat(INFERENCE_ERROR_MAX_CHARS * 2)}\nsecond line`),
      nowIso: iso(0),
    });
    assert.equal(state.lastError?.length, INFERENCE_ERROR_MAX_CHARS);
    assert.ok(state.lastError?.endsWith('…'));
    assert.doesNotMatch(state.lastError ?? '', /second line/);
  });
});

describe('normalizeInferenceState', () => {
  it('drops non-object blocks and coerces malformed fields', () => {
    assert.equal(normalizeInferenceState('nope'), undefined);
    assert.equal(normalizeInferenceState(null), undefined);
    assert.deepEqual(normalizeInferenceState({ lastOutcome: 'maybe', consecutiveFailures: -3, lastModel: 7 }), emptyInferenceState());
  });
});

describe('isInferredEdgeStale (HOK-3179)', () => {
  it('flags edges classified before the last successful refresh', () => {
    const state = recordInferenceSuccess({ model: 'claude-haiku-4-5-20251001', nowIso: iso(0) });
    assert.equal(isInferredEdgeStale(iso(-HOUR), state), true);
    assert.equal(isInferredEdgeStale(iso(+MINUTE), state), false);
    assert.equal(isInferredEdgeStale(iso(0), state), false);
  });

  it('returns false when there is no recorded success to compare against', () => {
    assert.equal(isInferredEdgeStale(iso(-HOUR), undefined), false);
    assert.equal(isInferredEdgeStale(iso(-HOUR), emptyInferenceState()), false);
  });

  it('returns false for an unparseable timestamp', () => {
    const state = recordInferenceSuccess({ model: 'claude-haiku-4-5-20251001', nowIso: iso(0) });
    assert.equal(isInferredEdgeStale('not-a-date', state), false);
    assert.equal(isInferredEdgeStale(null, state), false);
    assert.equal(isInferredEdgeStale(undefined, state), false);
  });
});

describe('buildInferenceReport', () => {
  it('reports a failed attempt with its error', () => {
    const report = buildInferenceReport({
      state: failedState(-MINUTE),
      inferredEdgeCount: 0,
      plan: { kind: 'partial', skipReason: null },
      nowMs: NOW,
    });
    assert.deepEqual(report, {
      schemaVersion: 1,
      inferenceStatus: 'failed',
      inferredEdgeCount: 0,
      attempted: true,
      refreshKind: 'partial',
      skipReason: null,
      model: 'claude-haiku-4-5-20251001',
      lastAttemptAt: iso(-MINUTE),
      lastSuccessAt: iso(-HOUR),
      consecutiveFailures: 1,
      error: 'classifier timeout',
    });
  });

  it('reports never with cache_disabled when no cache is in use', () => {
    const report = buildInferenceReport({
      state: undefined,
      inferredEdgeCount: 0,
      plan: { kind: 'none', skipReason: 'cache_disabled' },
      nowMs: NOW,
    });
    assert.equal(report.inferenceStatus, 'never');
    assert.equal(report.attempted, false);
    assert.equal(report.skipReason, 'cache_disabled');
    assert.equal(report.error, null);
  });
});

describe('deriveQueueAlertProjection (HOK-3314)', () => {
  const PROJECTION_NOW = Date.parse('2026-10-22T14:03:54.000Z');

  it('healthy status when queue-health and inference block agree', () => {
    const projection = deriveQueueAlertProjection({
      queueHealth: {
        status: 'healthy',
        inferenceStatus: 'ok',
        inferredEdgeCount: 49,
        inference: { consecutiveFailures: 0, lastSuccessAt: '2026-10-22T13:59:14.469Z' },
      },
      nowMs: PROJECTION_NOW,
    });
    assert.equal(projection.status, 'healthy');
    assert.equal(projection.episode, null);
    assert.equal(projection.nextAction, 'use_dependency_queue');
    assert.deepEqual(projection.evidenceWarnings, []);
  });

  it('degraded-inference projection carries current episode fields, not lifetime counts', () => {
    const projection = deriveQueueAlertProjection({
      queueHealth: {
        status: 'degraded',
        degradationReason: 'inference_unavailable',
        inferenceStatus: 'failed',
        inferredEdgeCount: 49,
        inference: {
          consecutiveFailures: 1,
          lastAttemptAt: '2026-10-22T14:03:54.249Z',
          lastSuccessAt: '2026-10-22T13:59:14.469Z',
          error: 'LLM fallback deadline exhausted before claude-sonnet-5',
        },
      },
      nowMs: PROJECTION_NOW,
    });
    assert.equal(projection.status, 'degraded-inference');
    assert.ok(projection.episode);
    assert.equal(projection.episode!.consecutiveFailedAttempts, 1);
    assert.equal(projection.episode!.severity, 'low');
    assert.equal(projection.episode!.startedAt, '2026-10-22T14:03:54.249Z');
    assert.equal(projection.episode!.kind, 'inference');
    assert.equal(projection.nextAction, 'use_cached_and_explicit_edges');
    assert.match(projection.summary, /1 consecutive failed attempt/);
    assert.match(projection.summary, /cached inferred edges still in use/);
  });

  it('severity ladder is 1→low, 3→medium, 5→high', () => {
    assert.equal(queueAlertSeverityForCount(0), 'low');
    assert.equal(queueAlertSeverityForCount(1), 'low');
    assert.equal(queueAlertSeverityForCount(2), 'low');
    assert.equal(queueAlertSeverityForCount(3), 'medium');
    assert.equal(queueAlertSeverityForCount(4), 'medium');
    assert.equal(queueAlertSeverityForCount(5), 'high');
    assert.equal(queueAlertSeverityForCount(10), 'high');
  });

  it('episode id is stable across polls of the same unchanged failure', () => {
    const health = {
      status: 'degraded',
      degradationReason: 'inference_unavailable',
      inferenceStatus: 'failed',
      inference: {
        consecutiveFailures: 1,
        lastAttemptAt: '2026-10-22T14:03:54.249Z',
      },
    };
    const first = deriveQueueAlertProjection({ queueHealth: health, nowMs: PROJECTION_NOW });
    // Simulate the planner updating only its own lastAttemptAt on a cache-only poll — the inference block is unchanged.
    const laterHealth = { ...health, lastAttemptAt: '2026-10-22T14:05:00.000Z' };
    const second = deriveQueueAlertProjection({
      queueHealth: laterHealth,
      previousEpisode: first.episode,
      nowMs: PROJECTION_NOW + 60_000,
    });
    assert.equal(second.episode?.id, first.episode?.id);
    assert.equal(second.episode?.startedAt, first.episode?.startedAt);
    assert.equal(second.episode?.consecutiveFailedAttempts, 1);
  });

  it('episode resets on recovery; a subsequent failure starts at count=1', () => {
    const failed = deriveQueueAlertProjection({
      queueHealth: {
        status: 'degraded',
        degradationReason: 'inference_unavailable',
        inferenceStatus: 'failed',
        inference: {
          consecutiveFailures: 2,
          lastAttemptAt: '2026-10-22T14:03:54.249Z',
          lastSuccessAt: '2026-10-22T13:59:14.469Z',
        },
      },
      nowMs: PROJECTION_NOW,
    });
    assert.equal(failed.episode?.consecutiveFailedAttempts, 2);

    const recovered = deriveQueueAlertProjection({
      queueHealth: {
        status: 'healthy',
        inferenceStatus: 'ok',
        inference: { consecutiveFailures: 0, lastSuccessAt: '2026-10-22T14:10:00.000Z' },
      },
      previousEpisode: failed.episode,
      nowMs: PROJECTION_NOW + 10 * 60_000,
    });
    assert.equal(recovered.status, 'healthy');
    assert.equal(recovered.episode, null);

    const newFailure = deriveQueueAlertProjection({
      queueHealth: {
        status: 'degraded',
        degradationReason: 'inference_unavailable',
        inferenceStatus: 'failed',
        inference: {
          consecutiveFailures: 1,
          lastAttemptAt: '2026-10-22T14:30:00.000Z',
          lastSuccessAt: '2026-10-22T14:10:00.000Z',
        },
      },
      previousEpisode: recovered.episode,
      nowMs: PROJECTION_NOW + 30 * 60_000,
    });
    assert.equal(newFailure.episode?.consecutiveFailedAttempts, 1);
    assert.equal(newFailure.episode?.severity, 'low');
    assert.equal(newFailure.episode?.startedAt, '2026-10-22T14:30:00.000Z');
    assert.notEqual(newFailure.episode?.id, failed.episode?.id);
  });

  it('missing queue-health is unknown, never healthy', () => {
    const projection = deriveQueueAlertProjection({ queueHealth: undefined, nowMs: PROJECTION_NOW });
    assert.equal(projection.status, 'unknown');
    assert.ok(projection.evidenceWarnings.length > 0);
    assert.notEqual(projection.nextAction, 'use_dependency_queue');
  });

  it('observerCycleComplete=false forces unknown even when queueHealth looks healthy', () => {
    const projection = deriveQueueAlertProjection({
      queueHealth: {
        status: 'healthy',
        inferenceStatus: 'ok',
        inference: { consecutiveFailures: 0, lastSuccessAt: '2026-10-22T13:59:14.469Z' },
      },
      observerCycleComplete: false,
      nowMs: PROJECTION_NOW,
    });
    assert.equal(projection.status, 'unknown');
    assert.ok(projection.evidenceWarnings.some((warning) => /observer cycle/i.test(warning)));
  });

  it('legacy data without an episode startedAt reports unknown, never substitutes firstObservedAt', () => {
    const projection = deriveQueueAlertProjection({
      queueHealth: {
        status: 'degraded',
        degradationReason: 'inference_unavailable',
        inferenceStatus: 'failed',
        inference: { consecutiveFailures: 1 },
      },
      nowMs: PROJECTION_NOW,
    });
    assert.equal(projection.episode?.startedAt, 'unknown');
    assert.equal(projection.episode?.consecutiveFailedAttempts, 1);
  });

  it('planner degradation uses planner failureCount and episodeStartedAt', () => {
    const projection = deriveQueueAlertProjection({
      queueHealth: {
        status: 'degraded',
        degradationReason: 'timeout',
        failureCount: 3,
        episodeStartedAt: '2026-10-22T13:00:00.000Z',
        lastFailureAt: '2026-10-22T14:03:07.000Z',
        inference: { consecutiveFailures: 0 },
      },
      nowMs: PROJECTION_NOW,
    });
    assert.equal(projection.status, 'degraded-planner');
    assert.equal(projection.episode?.kind, 'planner');
    assert.equal(projection.episode?.consecutiveFailedAttempts, 3);
    assert.equal(projection.episode?.severity, 'medium');
    assert.equal(projection.episode?.startedAt, '2026-10-22T13:00:00.000Z');
  });
});

describe('HOK-3314 replay: Oct-22 snapshot (157 lifetime, 1 current)', () => {
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'queue-inference', 'legacy-157-current-1.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    queueHealth: Record<string, unknown>;
    incident: {
      occurrenceCount: number;
      firstObservedAt: string;
      metadata: { recurrence: { count: number } };
    };
  };

  it('projection returns 1 current failed attempt and timing — not the lifetime 157', () => {
    const projection = deriveQueueAlertProjection({
      queueHealth: fixture.queueHealth as never,
      nowMs: Date.parse('2026-10-22T14:03:54.249Z'),
    });
    assert.equal(projection.status, 'degraded-inference');
    assert.equal(projection.episode?.consecutiveFailedAttempts, 1);
    assert.equal(projection.episode?.severity, 'low');
    assert.equal(projection.episode?.latestFailureAt, '2026-10-22T14:03:54.249Z');
    assert.equal(projection.episode?.latestSuccessAt, '2026-10-22T13:59:14.469Z');
    assert.equal(projection.nextAction, 'use_cached_and_explicit_edges', 'inferredEdgeCount=49 → cached edges still in use');
    assert.match(projection.summary, /1 consecutive failed attempt/);
    assert.match(projection.summary, /cached inferred edges still in use/);
    // Deliberately NOT in the current-episode summary:
    assert.doesNotMatch(projection.summary, /157/);
    assert.doesNotMatch(projection.summary, /2026-10-01/);
  });

  it('lifetime history (157 events, 19 recurrences, first observed 10-01) remains readable on the incident record', () => {
    // The fixture's incident object is the sanitized snapshot the operator
    // saw. HOK-3314 preserves these fields on the stored record so the
    // dashboard history row can still show them — the projection just does
    // not consume them.
    assert.equal(fixture.incident.occurrenceCount, 157);
    assert.equal(fixture.incident.metadata.recurrence.count, 19);
    assert.equal(fixture.incident.firstObservedAt, '2026-10-01T17:07:26.006Z');
  });
});

describe('recordInferenceAttempt (HOK-3314)', () => {
  it('is a thin wrapper around recordInferenceSuccess / recordInferenceFailure', () => {
    const ok = recordInferenceAttempt(undefined, { outcome: 'ok', model: 'claude-haiku-4-5-20251001', nowIso: '2026-10-22T13:59:14.469Z' });
    assert.equal(ok.lastOutcome, 'ok');
    assert.equal(ok.lastModel, 'claude-haiku-4-5-20251001');

    const failed = recordInferenceAttempt(ok, { outcome: 'failed', error: new Error('boom'), nowIso: '2026-10-22T14:03:54.249Z' });
    assert.equal(failed.lastOutcome, 'failed');
    assert.equal(failed.consecutiveFailures, 1);
    assert.equal(failed.lastError, 'boom');
    assert.equal(failed.lastSuccessAt, ok.lastSuccessAt, 'failure must keep last success timestamp');
    const _unused: QueueAlertEpisode | null = null;
    void _unused;
  });
});
