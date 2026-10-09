import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInferenceReport,
  deriveInferenceStatus,
  emptyInferenceState,
  INFERENCE_ERROR_MAX_CHARS,
  isInferredEdgeStale,
  normalizeInferenceState,
  planInferenceRefresh,
  QUEUE_INFERENCE_FAILURE_COOLDOWN_MS,
  QUEUE_INFERENCE_STALE_AFTER_MS,
  recordInferenceFailure,
  recordInferenceSuccess,
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
