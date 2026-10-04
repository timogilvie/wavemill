/**
 * Reviewer-stage adjudicator (HOK-2970, Arbiter P2.4g).
 *
 * Reviewer-stage adjudication is intentionally separate from the generic
 * final-delivery arbiter (`deliveryVerdict`). Delivery selects the PR the
 * merge lane will ship; the reviewer-stage adjudicator only rules on whether
 * one reviewer produced better direct review evidence over one verified
 * shared implementation.
 *
 * This module is a thin façade over
 * {@link foldAttestationsIntoStageAttribution}. The delegate already scores
 * severity-weighted issue detection, precision/false-positive cost, severity
 * calibration, evidence quality, validation depth, remediation correctness,
 * introduced regressions and escaped defects across the pair. The façade adds:
 *
 * 1. **Reviewer-stage gating.** A stage attribution is emitted only when the
 *    pair actually forked at `review` and both arms shared an implementation
 *    prefix (`sharedPrefix === true`). Anything else fails closed to
 *    `insufficient_evidence`, so an "independently generated codebase" (the
 *    legacy quarantine target) can never become reviewer-stage evidence.
 * 2. **Fail-closed on missing direct evidence.** The delegate already handles
 *    this via `missing_direct_review_evidence`; the façade documents it and
 *    pins it with a unit test.
 * 3. **Presentation-order symmetry.** Reviewer-stage adjudication is invariant
 *    under `presentationOrder` swap; the façade never reads `presentationOrder`
 *    and pins the invariant with a unit test.
 * 4. **Producer stamping.** Each emitted attribution carries
 *    `producer: 'reviewer-stage-adjudicator/v1'` and a `decidedAt` timestamp
 *    so downstream consumers can attribute rulings back to this component.
 */

import {
  foldAttestationsIntoStageAttribution,
  type ChallengeExecutionAttestation,
  type ForkIdentity,
  type ReviewExecutedIdentitySet,
  type StageAttribution,
  type StageAttributionReasonCode,
} from './challenge-execution-contract.ts';

export const REVIEWER_STAGE_ADJUDICATOR_PRODUCER = 'reviewer-stage-adjudicator/v1';

export interface ReviewerStageAdjudicatorInput {
  pairId: string;
  primary?: ChallengeExecutionAttestation;
  challenger?: ChallengeExecutionAttestation;
  /** From `ChallengeStageEval.provenance`. */
  evidenceProvenance?: 'direct' | 'inferred';
  /** Pair-level fork identity used to prove matched pre-stage inputs. */
  forkIdentity?: ForkIdentity;
  /** Per-arm executed review identities used to detect pinning failures. */
  primaryReviewIdentity?: ReviewExecutedIdentitySet;
  challengerReviewIdentity?: ReviewExecutedIdentitySet;
  /**
   * False when either arm's local review artifact is missing complete
   * per-iteration evidence (findings, commands, reviewer delta).
   */
  reviewIterationsComplete?: boolean;
  /** Winner as decided by the comparison judge. */
  judgeWinner?: 'primary' | 'challenger' | 'tie' | null;
  /**
   * Optional presentation order recorded when the judge saw the pair.
   * Ignored by the adjudicator — it must not affect the outcome — but
   * accepted here so callers can pass through opaque metadata without
   * threading a second parameter.
   */
  presentationOrder?: 'primary-first' | 'challenger-first';
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

function insufficientEvidence(
  pairId: string,
  reasons: StageAttributionReasonCode[],
  details: string,
  now: () => string,
): StageAttribution {
  return {
    status: 'insufficient_evidence',
    outcome: null,
    stage: 'review',
    reasonCodes: reasons,
    reasonDetails: details,
    evidenceProvenance: 'insufficient',
    decidedAt: now(),
    producer: REVIEWER_STAGE_ADJUDICATOR_PRODUCER,
  };
}

function stampAdjudicatorMetadata(
  attribution: StageAttribution,
  now: () => string,
): StageAttribution {
  return {
    ...attribution,
    decidedAt: attribution.decidedAt ?? now(),
    producer: REVIEWER_STAGE_ADJUDICATOR_PRODUCER,
  };
}

/**
 * Decide the reviewer-stage attribution for one challenge pair.
 *
 * Fails closed (`insufficient_evidence`) when:
 * - The pair was not forked at the review stage.
 * - The two arms do not share a matched implementation prefix.
 * - Direct review evidence is missing, or executed identities are unpinned
 *   or conflict (delegated to
 *   {@link foldAttestationsIntoStageAttribution}).
 *
 * When all preconditions hold, delegates to the shared folder. The delegate
 * enforces the four required outcomes: `primary`, `challenger`, `tie`, or
 * `insufficient_evidence` (never a phantom winner).
 */
export function adjudicateReviewerStageFromPair(
  input: ReviewerStageAdjudicatorInput,
): StageAttribution {
  const now = input.now ?? (() => new Date().toISOString());

  if (input.forkIdentity?.stage !== 'review') {
    return insufficientEvidence(
      input.pairId,
      ['inherited_stage_evidence_only'],
      'Reviewer-stage adjudication requires a pair forked at the review stage; this pair either did not fork or forked at a different stage.',
      now,
    );
  }
  if (input.forkIdentity.sharedPrefix !== true) {
    return insufficientEvidence(
      input.pairId,
      ['missing_direct_review_evidence'],
      'Reviewer-stage adjudication requires a shared pre-review implementation; the two arms did not fork from a matched prefix.',
      now,
    );
  }

  const attribution = foldAttestationsIntoStageAttribution({
    pairId: input.pairId,
    stage: 'review',
    primary: input.primary,
    challenger: input.challenger,
    evidenceProvenance: input.evidenceProvenance,
    forkIdentity: input.forkIdentity,
    primaryReviewIdentity: input.primaryReviewIdentity,
    challengerReviewIdentity: input.challengerReviewIdentity,
    reviewIterationsComplete: input.reviewIterationsComplete,
    judgeWinner: input.judgeWinner,
  });

  return stampAdjudicatorMetadata(attribution, now);
}
