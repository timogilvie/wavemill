import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStallCauses, deriveStallCause, type CauseSpan } from './stall-cause.ts';

// protects: stall cause majority overlap and tie-breaking precedence
describe('stall-cause', () => {
  it('picks the cause with the most overlap when it covers >= 50%', () => {
    const interval = { fromMs: 0, toMs: 120 * 60 * 1000 };
    const spans: CauseSpan[] = [
      { cause: 'stage-agent', fromMs: 0, toMs: 70 * 60 * 1000 },
      { cause: 'operator-attention', fromMs: 60 * 60 * 1000, toMs: 120 * 60 * 1000 },
    ];
    const result = deriveStallCause(interval, spans);
    assert.equal(result.cause, 'stage-agent');
  });

  it('returns unknown when no cause reaches 50%', () => {
    const interval = { fromMs: 0, toMs: 120 * 60 * 1000 };
    const spans: CauseSpan[] = [
      { cause: 'stage-agent', fromMs: 0, toMs: 40 * 60 * 1000 },
      { cause: 'operator-attention', fromMs: 80 * 60 * 1000, toMs: 120 * 60 * 1000 },
    ];
    const result = deriveStallCause(interval, spans);
    assert.equal(result.cause, 'unknown');
  });

  it('uses precedence on exact ties', () => {
    const interval = { fromMs: 0, toMs: 120 * 60 * 1000 };
    const spans: CauseSpan[] = [
      { cause: 'stage-agent', fromMs: 0, toMs: 120 * 60 * 1000 },
      { cause: 'operator-attention', fromMs: 0, toMs: 120 * 60 * 1000, detail: 'plan-approval' },
    ];
    const result = deriveStallCause(interval, spans);
    assert.equal(result.cause, 'operator-attention');
    assert.equal(result.causeDetail, 'plan-approval');
  });

  it('returns unknown for an empty span list', () => {
    assert.equal(deriveStallCause({ fromMs: 0, toMs: 100 }, []).cause, 'unknown');
  });

  it('aggregates only stalls over 1h by cause', () => {
    const intervals = [
      { durationMs: 30 * 60 * 1000, cause: 'stage-agent' as const },
      { durationMs: 90 * 60 * 1000, cause: 'stage-agent' as const },
      { durationMs: 120 * 60 * 1000, cause: 'unknown' as const },
    ];
    const result = aggregateStallCauses(intervals);
    assert.equal(result['stage-agent'].stalls, 1);
    assert.equal(result['stage-agent'].hours, 1.5);
    assert.equal(result.unknown.stalls, 1);
    assert.equal(result.unknown.hours, 2);
    assert.equal(result['operator-attention'].stalls, 0);
  });
});