/**
 * Recovery-predicate evaluation for open incidents (HOK-2595).
 *
 * A correlated incident's remediation proposal declares how to tell it has
 * been overtaken by progress (`recoveryPredicate`). The Observer evaluates
 * that predicate against current, read-only artifacts after each complete
 * detection cycle and resolves the record as soon as it holds, instead of
 * waiting out the absence sweep. Missing or unreadable evidence is *never*
 * treated as recovery.
 *
 * @module wavemill-incident-recovery
 */

import { dirname } from 'node:path';
import {
  readPrIdentity,
  readReviewResultDiagnostic,
  type PrIdentityDiagnostic,
  type ReviewResultDiagnostic,
} from './artifact-diagnostics.ts';
import { comparisonSucceededForPair, currentHeadEvalPresent } from './wavemill-incident-detector.ts';
import type { IncidentRecord, RemediationProposal } from './wavemill-incident-model.ts';

export interface RecoveryEvaluation {
  satisfied: boolean;
  /** Resolution reason, `recovery_predicate:<kind>`, when satisfied. */
  reason?: string;
  /** Bounded description of the evidence that satisfied (or blocked) the predicate. */
  evidence?: string;
}

/** Injectable readers so the evaluator is pure under test. */
export interface RecoveryReaders {
  readReview: (taskDir: string) => ReviewResultDiagnostic | null;
  readPr: (prNumber: number, repoDir: string) => PrIdentityDiagnostic | null;
  comparisonSucceeded: (repoDir: string, pairId: string) => boolean;
  currentHeadEval: (repoDir: string, issueId: string | undefined, pairId: string, headSha: string | undefined) => boolean;
}

const DEFAULT_READERS: RecoveryReaders = {
  readReview: readReviewResultDiagnostic,
  readPr: readPrIdentity,
  comparisonSucceeded: comparisonSucceededForPair,
  currentHeadEval: currentHeadEvalPresent,
};

const NOT_SATISFIED: RecoveryEvaluation = { satisfied: false };

/**
 * Evaluate an incident's declared recovery predicate. Returns
 * `{ satisfied: false }` when the record has no predicate, the predicate is
 * unknown, or the evidence it needs is missing.
 */
export function evaluateRecoveryPredicate(
  record: IncidentRecord,
  repoDir: string,
  readers: Partial<RecoveryReaders> = {},
): RecoveryEvaluation {
  const read = { ...DEFAULT_READERS, ...readers };
  const proposal = record.metadata?.proposal as RemediationProposal | undefined;
  const predicate = proposal?.recoveryPredicate;
  if (!predicate || typeof predicate !== 'object') return NOT_SATISFIED;
  const details = predicate.details ?? {};
  const satisfied = (evidence: string): RecoveryEvaluation => ({
    satisfied: true,
    reason: `recovery_predicate:${predicate.kind}`,
    evidence,
  });

  switch (predicate.kind) {
    case 'head_changed': {
      const prNumber = positiveInt(details.pr);
      const recordedHead = known(details.head);
      if (!prNumber || !recordedHead) return NOT_SATISFIED;
      const currentHead = read.readPr(prNumber, repoDir)?.headSha;
      return currentHead && currentHead !== recordedHead
        ? satisfied(`pr=${prNumber} head ${short(recordedHead)} -> ${short(currentHead)}`)
        : NOT_SATISFIED;
    }
    case 'review_now_ready': {
      const review = readRecordedReview(details, read);
      if (!review) return NOT_SATISFIED;
      if (review.verdict === 'ready') return satisfied(`review verdict ready at ${short(review.reviewedHead)}`);
      const attempt = newReviewAttempt(review, details);
      return attempt ? satisfied(attempt) : NOT_SATISFIED;
    }
    case 'review_attempt_progressed': {
      const review = readRecordedReview(details, read);
      if (!review) return NOT_SATISFIED;
      if (review.stageStatus === 'running') return satisfied('failed arm review is running');
      if (review.verdict === 'ready') return satisfied(`failed arm review verdict ready at ${short(review.reviewedHead)}`);
      const attempt = newReviewAttempt(review, details);
      return attempt ? satisfied(attempt) : NOT_SATISFIED;
    }
    case 'current_head_eval_present': {
      const pairId = known(details.pairId);
      const head = known(details.head);
      if (!pairId || !head) return NOT_SATISFIED;
      return read.currentHeadEval(repoDir, known(details.issue), pairId, head)
        ? satisfied(`eval present for ${pairId} at ${short(head)}`)
        : NOT_SATISFIED;
    }
    case 'comparison_present': {
      const pairId = known(details.pairId);
      if (!pairId) return NOT_SATISFIED;
      return read.comparisonSucceeded(repoDir, pairId) ? satisfied(`comparison succeeded for ${pairId}`) : NOT_SATISFIED;
    }
    case 'pr_merged': {
      const prNumber = positiveInt(details.pr);
      if (!prNumber) return NOT_SATISFIED;
      const pr = read.readPr(prNumber, repoDir);
      if (!pr) return NOT_SATISFIED;
      return pr.merged || pr.state?.toUpperCase() === 'MERGED'
        ? satisfied(`pr=${prNumber} merged`)
        : NOT_SATISFIED;
    }
    default:
      return NOT_SATISFIED;
  }
}

function readRecordedReview(details: Record<string, string>, read: RecoveryReaders): ReviewResultDiagnostic | null {
  const reviewPath = known(details.reviewResultPath);
  return reviewPath ? read.readReview(dirname(reviewPath)) : null;
}

/** A new review attempt: a completed review whose head or finish time differs from the recorded one. */
function newReviewAttempt(review: ReviewResultDiagnostic, details: Record<string, string>): string | null {
  const recordedHead = known(details.reviewHead);
  const recordedFinishedAt = known(details.reviewFinishedAt);
  const currentFinishedAt = review.finishedAt ?? review.reviewedAtIso;
  if (recordedHead && review.reviewedHead && review.reviewedHead !== recordedHead) {
    return `new review attempt at head ${short(review.reviewedHead)} (was ${short(recordedHead)})`;
  }
  if (recordedFinishedAt && currentFinishedAt && currentFinishedAt !== recordedFinishedAt) {
    return `new review attempt finished ${currentFinishedAt} (was ${recordedFinishedAt})`;
  }
  return null;
}

function known(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value !== 'unknown' ? value : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : 'unknown';
}
