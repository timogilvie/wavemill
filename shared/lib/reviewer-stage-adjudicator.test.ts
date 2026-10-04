/**
 * HOK-2970 reviewer-stage adjudicator unit tests.
 *
 * Covers the four required outcomes (primary, challenger, tie,
 * insufficient_evidence), the presentation-order swap invariant, and the
 * fail-closed gates on non-review-forked or non-shared-prefix pairs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjudicateReviewerStageFromPair,
  REVIEWER_STAGE_ADJUDICATOR_PRODUCER,
} from './reviewer-stage-adjudicator.ts';
import type {
  ChallengeExecutionAttestation,
  ForkIdentity,
  ReviewExecutedIdentitySet,
} from './challenge-execution-contract.ts';

function makeAttestation(
  side: 'primary' | 'challenger',
  overrides: Partial<ChallengeExecutionAttestation> = {},
): ChallengeExecutionAttestation {
  return {
    pairId: 'pair-2970',
    side,
    validity: 'valid',
    challengeStage: 'review',
    expectedStageModel: side === 'primary' ? 'claude-opus-4-6' : 'gpt-5.4',
    evidence: [{
      stage: 'review',
      model: side === 'primary' ? 'claude-opus-4-6' : 'gpt-5.4',
      source: 'review-result',
    }],
    ...overrides,
  };
}

function makeForkIdentity(overrides: Partial<ForkIdentity> = {}): ForkIdentity {
  return {
    stage: 'review',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    taskPacketHash: 'c'.repeat(64),
    planHash: 'd'.repeat(64),
    promptHash: 'e'.repeat(64),
    toolConfigHash: 'f'.repeat(64),
    sharedPrefix: true,
    ...overrides,
  };
}

function makeReviewIdentitySet(): ReviewExecutedIdentitySet {
  return {
    orchestrator: {
      role: 'review_orchestrator',
      requestedModel: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6',
      source: 'route',
      pinned: true,
    },
    substantiveAnalysis: {
      role: 'substantive_analysis',
      requestedModel: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6',
      source: 'artifact',
      pinned: true,
    },
    remediation: null,
  };
}

test('emits valid primary outcome when judge picks primary with matched inputs', () => {
  const attribution = adjudicateReviewerStageFromPair({
    pairId: 'pair-2970',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: true,
    judgeWinner: 'primary',
    now: () => '2026-09-16T00:00:00Z',
  });
  assert.equal(attribution.status, 'valid');
  assert.equal(attribution.outcome, 'primary');
  assert.equal(attribution.producer, REVIEWER_STAGE_ADJUDICATOR_PRODUCER);
  assert.equal(attribution.decidedAt, '2026-09-16T00:00:00Z');
});

test('emits tie outcome when the judge decides tie', () => {
  const attribution = adjudicateReviewerStageFromPair({
    pairId: 'pair-2970',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: true,
    judgeWinner: 'tie',
  });
  assert.equal(attribution.status, 'valid');
  assert.equal(attribution.outcome, 'tie');
});

test('fails closed with insufficient_evidence when review iterations incomplete', () => {
  const attribution = adjudicateReviewerStageFromPair({
    pairId: 'pair-2970',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: false,
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'insufficient_evidence');
  assert.ok(attribution.reasonCodes.includes('insufficient_review_iterations'));
});

test('fails closed with insufficient_evidence when direct review evidence is missing', () => {
  const attribution = adjudicateReviewerStageFromPair({
    pairId: 'pair-2970',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    // evidenceProvenance omitted → treated as missing
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'insufficient_evidence');
  assert.ok(attribution.reasonCodes.includes('missing_direct_review_evidence'));
});

test('fails closed when pair did not fork at review', () => {
  const attribution = adjudicateReviewerStageFromPair({
    pairId: 'pair-2970',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity({ stage: 'implementation' }),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: true,
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'insufficient_evidence');
  assert.ok(attribution.reasonCodes.includes('inherited_stage_evidence_only'));
  assert.equal(attribution.outcome, null);
});

test('fails closed when sharedPrefix is false (independent codebases)', () => {
  const attribution = adjudicateReviewerStageFromPair({
    pairId: 'pair-2970',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity({ sharedPrefix: false }),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: true,
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'insufficient_evidence');
  assert.ok(attribution.reasonCodes.includes('missing_direct_review_evidence'));
});

test('presentation-order swap invariant: same evidence, opposite order, same outcome', () => {
  const commonInput = {
    pairId: 'pair-2970' as const,
    primary: makeAttestation('primary') as ChallengeExecutionAttestation | undefined,
    challenger: makeAttestation('challenger') as ChallengeExecutionAttestation | undefined,
    evidenceProvenance: 'direct' as const,
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: true,
    judgeWinner: 'challenger' as const,
    now: () => '2026-09-16T00:00:00Z',
  };
  const primaryFirst = adjudicateReviewerStageFromPair({
    ...commonInput,
    presentationOrder: 'primary-first',
  });
  const challengerFirst = adjudicateReviewerStageFromPair({
    ...commonInput,
    presentationOrder: 'challenger-first',
  });
  // Two independent objects with identical adjudication content.
  assert.deepEqual(primaryFirst, challengerFirst);
});
