import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import {
  getAuthoritativeEvaluatedPrHeadSha,
  selectCurrentChallengeEval,
} from './current-challenge-eval-selector.ts';

const PAIR = 'PAIR-2949';
const PRIMARY_URL = 'https://github.example/acme/wavemill/pull/1';
const HEAD_OLD = 'a'.repeat(40);
const HEAD_CURRENT = 'b'.repeat(40);

function evalRow(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-default',
    challengePairId: PAIR,
    challengeSide: 'primary',
    prUrl: PRIMARY_URL,
    evaluatedPrHeadSha: HEAD_CURRENT,
    score: 0.8,
    timestamp: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as EvalRecord;
}

function select(records: EvalRecord[], overrides: Record<string, unknown> = {}) {
  return selectCurrentChallengeEval(records, {
    pairId: PAIR,
    side: 'primary',
    prUrl: PRIMARY_URL,
    currentHeadSha: HEAD_CURRENT,
    ...overrides,
  });
}

describe('current challenge eval selector', () => {
  it('selects the current head rather than the first append-ordered row', () => {
    const result = select([
      evalRow({ id: 'old-first', evaluatedPrHeadSha: HEAD_OLD, timestamp: '2026-09-03T00:00:00.000Z' }),
      evalRow({ id: 'current-later', evaluatedPrHeadSha: HEAD_CURRENT, timestamp: '2026-09-02T00:00:00.000Z' }),
    ]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.evalId, 'current-later');
  });

  it('chooses the newest eval on the same current head', () => {
    const result = select([
      evalRow({ id: 'older', timestamp: '2026-09-01T00:00:00.000Z' }),
      evalRow({ id: 'newer', timestamp: '2026-09-02T00:00:00.000Z' }),
    ]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.evalId, 'newer');
  });

  it('uses descending eval ID as a stable timestamp tie-breaker', () => {
    const result = select([
      evalRow({ id: 'eval-a' }),
      evalRow({ id: 'eval-z' }),
    ]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.evalId, 'eval-z');
  });

  it('refuses old-head-only evidence with candidate diagnostics', () => {
    const result = select([evalRow({ id: 'old', evaluatedPrHeadSha: HEAD_OLD })]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'old_head_only');
      assert.deepEqual(result.diagnostics.candidates.map((candidate) => candidate.evaluatedPrHeadSha), [HEAD_OLD]);
    }
  });

  it('does not silently treat legacy rows without an authoritative head as current', () => {
    const result = select([evalRow({ id: 'legacy', evaluatedPrHeadSha: undefined })]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'legacy_head_ambiguous');
  });

  it('accepts an authoritative legacy verification head', () => {
    const record = evalRow({
      id: 'verified-legacy',
      evaluatedPrHeadSha: undefined,
      verificationTelemetry: { checked_shas: { head: HEAD_CURRENT } },
    });
    assert.equal(getAuthoritativeEvaluatedPrHeadSha(record), HEAD_CURRENT);
    const result = select([record]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.evalId, 'verified-legacy');
  });

  it('fails closed for pair, side, and PR identity disagreements', () => {
    const pair = select([evalRow({ challengePairId: 'OTHER' })]);
    assert.equal(pair.ok, false);
    if (!pair.ok) assert.equal(pair.reason, 'no_pair_records');

    const side = select([evalRow({ challengeSide: 'challenger' })]);
    assert.equal(side.ok, false);
    if (!side.ok) assert.equal(side.reason, 'side_mismatch');

    const pr = select([evalRow({ prUrl: 'https://github.example/acme/wavemill/pull/2' })]);
    assert.equal(pr.ok, false);
    if (!pr.ok) assert.equal(pr.reason, 'no_matching_pr');
  });

  it('refuses invalid scores only when the caller requires scored evidence', () => {
    const unscored = evalRow({ score: Number.NaN });
    const required = select([unscored], { requireScore: true });
    assert.equal(required.ok, false);
    if (!required.ok) assert.equal(required.reason, 'invalid_score');

    const allowed = select([unscored], { requireScore: false });
    assert.equal(allowed.ok, true);
  });

  it('passes invalid challenge divergence reasons through diagnostics', () => {
    const result = select([
      evalRow({
        id: 'invalid-current',
        invalidChallenge: true,
        challengeDivergenceReason: 'missing_challenge_intent',
      }),
    ], { requireScore: false });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'ineligible_evidence');
      assert.deepEqual(result.diagnostics.candidates.map((candidate) => ({
        evalId: candidate.evalId,
        rejection: candidate.rejection,
        challengeDivergenceReason: candidate.challengeDivergenceReason,
      })), [{
        evalId: 'invalid-current',
        rejection: 'invalid_challenge',
        challengeDivergenceReason: 'missing_challenge_intent',
      }]);
    }
  });

  it('refuses duplicate decisive timestamps and IDs as ambiguous', () => {
    const result = select([evalRow({ id: 'duplicate' }), evalRow({ id: 'duplicate' })]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'ambiguous_current_head');
  });
});
