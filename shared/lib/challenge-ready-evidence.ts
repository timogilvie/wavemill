/**
 * Current-head challenge readiness evidence (HOK-2963).
 *
 * Ready must distinguish three challenge situations that were previously
 * collapsed into a single fail-closed "no comparison record" verdict:
 *
 * 1. The pair already has a comparison that is valid at the live PR heads
 *    (or an explicit terminal resolution) — Ready may pass.
 * 2. One or both arms lack valid current-head eval evidence — orchestration
 *    should launch evals (`challenge-eval-pending`).
 * 3. Both arms have valid current-head evals but no valid comparison —
 *    orchestration should launch exactly one comparison
 *    (`challenge-comparison-pending`).
 *
 * Eval validity is delegated to the HOK-2949 selector via
 * `selectChallengeComparisonEvalEvidence()` so Ready, the monitor, and
 * `compare-prs` can never disagree about which JSONL row counts.
 */

import type { EvalRecord } from './eval-schema.ts';
import type { ChallengeComparison } from './challenge-comparison.ts';
import { isDecisiveChallengeComparison } from './challenge-comparison.ts';
import { canonicalChallengePrUrl } from './current-challenge-eval-selector.ts';
import {
  selectChallengeComparisonEvalEvidence,
  type ChallengeComparisonEvalEvidence,
} from './challenge-comparison-eval-evidence.ts';

export type ChallengeReadyPendingReason =
  | 'challenge-eval-pending'
  | 'challenge-comparison-pending';

export type ChallengeReadyOutcome =
  /** A comparison whose selected eval evidence matches both live heads. */
  | 'comparison-valid'
  /** An explicit terminal resolution (forfeit, invalid, hard failure, ...). */
  | 'terminal-resolution'
  /** At least one arm lacks valid current-head eval evidence. */
  | 'eval-pending'
  /** Both current-head evals exist; the comparison has not been produced. */
  | 'comparison-pending';

export interface ChallengeReadyArmIdentity {
  /** Canonical live PR URL. */
  prUrl: string;
  /** PR number as a string, for diagnostics and record matching. */
  prNumber: string;
  /** Live PR head SHA; evidence must match it exactly. */
  headSha: string;
}

export interface ChallengeReadyArmEvalSummary {
  ok: boolean;
  evalId?: string;
  evaluatedPrHeadSha?: string;
  refusalReason?: string;
}

export interface ChallengeReadyEvidence {
  pairId: string;
  /** Which side of the pair the Ready run is evaluating. */
  side: 'primary' | 'challenger';
  outcome: ChallengeReadyOutcome;
  /** Present only for the two pending outcomes. */
  pendingReason?: ChallengeReadyPendingReason;
  primaryEval: ChallengeReadyArmEvalSummary;
  challengerEval: ChallengeReadyArmEvalSummary;
  /**
   * Matched comparison records that could not satisfy the current-head gate
   * (winner-bearing records with missing or mismatched selected eval heads).
   * A non-zero count with a pending outcome means the pair regressed to a
   * new head after being compared.
   */
  staleComparisons: number;
  /** ISO timestamp of the accepted comparison record, when one satisfied the gate. */
  acceptedComparisonTimestamp?: string;
}

function summarizeEvalSelection(
  selection: ChallengeComparisonEvalEvidence['primary'],
): ChallengeReadyArmEvalSummary {
  if (selection.ok) {
    return {
      ok: true,
      evalId: selection.evalId,
      evaluatedPrHeadSha: selection.evaluatedPrHeadSha,
    };
  }
  return { ok: false, refusalReason: selection.reason };
}

/**
 * A record "bears a winner" when its outcome claims a judged comparison
 * (`compared`, stored `manual` with winner, or a legacy record with neither
 * outcome nor terminal reason). Winner-bearing records are only valid at the
 * exact heads their selected eval evidence names; everything else follows
 * existing terminal-resolution semantics.
 */
function classifyComparisonRecord(
  record: ChallengeComparison,
  primaryHead: string,
  challengerHead: string,
): 'current' | 'terminal' | 'stale' {
  const outcome = record.comparisonOutcome as string | undefined;
  const winnerBearing = outcome === 'compared'
    || outcome === 'manual'
    || (outcome === undefined && !record.terminalReason);

  if (!winnerBearing) {
    // Terminal records (forfeit, double-forfeit, skipped, invalid,
    // invalid_challenge, inconclusive, or explicit terminalReason) keep their
    // existing decisive semantics; non-decisive phantom forfeits never
    // satisfy the gate.
    return isDecisiveChallengeComparison(record) ? 'terminal' : 'stale';
  }

  const selected = record.selectedEvalEvidence;
  if (
    selected?.primary?.evaluatedPrHeadSha === primaryHead
    && selected?.challenger?.evaluatedPrHeadSha === challengerHead
  ) {
    return 'current';
  }
  // Legacy winner-bearing records without selected head evidence, and records
  // judged at older heads, are stale for active challenge PRs (HOK-2963).
  return 'stale';
}

/**
 * Evaluate whether a challenge pair satisfies the Ready comparison gate at
 * the live PR heads, and if not, which orchestration step is launchable.
 * Pure over its inputs so shell stays thin and behavior is unit-testable.
 */
export function evaluateChallengeReadyEvidence(input: {
  pairId: string;
  side: 'primary' | 'challenger';
  primary: ChallengeReadyArmIdentity;
  challenger: ChallengeReadyArmIdentity;
  evalRecords: readonly EvalRecord[];
  comparisons: readonly ChallengeComparison[];
}): ChallengeReadyEvidence {
  const canonicalPrimary = canonicalChallengePrUrl(input.primary.prUrl);
  const canonicalChallenger = canonicalChallengePrUrl(input.challenger.prUrl);

  const matching = input.comparisons.filter((record) => {
    if (record.challengePairId !== input.pairId) return false;
    const recordPrimary = canonicalChallengePrUrl(record.primaryPrUrl);
    const recordChallenger = canonicalChallengePrUrl(record.challengerPrUrl);
    return Boolean(
      (recordPrimary && recordPrimary === canonicalPrimary)
      || (recordChallenger && recordChallenger === canonicalChallenger),
    );
  });

  let accepted: ChallengeComparison | undefined;
  let acceptedOutcome: 'comparison-valid' | 'terminal-resolution' | undefined;
  let staleComparisons = 0;
  for (const record of matching) {
    const classification = classifyComparisonRecord(
      record,
      input.primary.headSha,
      input.challenger.headSha,
    );
    if (classification === 'current') {
      accepted = record;
      acceptedOutcome = 'comparison-valid';
      break;
    }
    if (classification === 'terminal' && !accepted) {
      accepted = record;
      acceptedOutcome = 'terminal-resolution';
      continue;
    }
    if (classification === 'stale') {
      staleComparisons += 1;
    }
  }

  const evalEvidence = selectChallengeComparisonEvalEvidence({
    records: input.evalRecords,
    pairId: input.pairId,
    primary: input.primary,
    challenger: input.challenger,
  });
  const primaryEval = summarizeEvalSelection(evalEvidence.primary);
  const challengerEval = summarizeEvalSelection(evalEvidence.challenger);

  if (accepted && acceptedOutcome) {
    return {
      pairId: input.pairId,
      side: input.side,
      outcome: acceptedOutcome,
      primaryEval,
      challengerEval,
      staleComparisons,
      acceptedComparisonTimestamp: accepted.timestamp,
    };
  }

  const outcome: ChallengeReadyOutcome = evalEvidence.hasRequiredEvalRecords
    ? 'comparison-pending'
    : 'eval-pending';
  return {
    pairId: input.pairId,
    side: input.side,
    outcome,
    pendingReason: outcome === 'eval-pending'
      ? 'challenge-eval-pending'
      : 'challenge-comparison-pending',
    primaryEval,
    challengerEval,
    staleComparisons,
  };
}

export interface ChallengePairStateResolution {
  pairId: string;
  side: 'primary' | 'challenger';
  /** The sibling arm's PR number. */
  siblingPr: number;
}

/**
 * Resolve challenge-pair identity for a PR from the monitor's workflow state
 * (`workflow-state.json`). Fail-closed: any missing or malformed piece
 * returns null and the caller falls back to the legacy challenge gate.
 */
export function resolveChallengePairFromState(
  state: unknown,
  prNumber: number,
): ChallengePairStateResolution | null {
  if (!state || typeof state !== 'object') return null;
  const tasks = (state as { tasks?: unknown }).tasks;
  if (!tasks || typeof tasks !== 'object') return null;

  const entries = Object.entries(tasks as Record<string, unknown>);
  for (const [, rawTask] of entries) {
    if (!rawTask || typeof rawTask !== 'object') continue;
    const task = rawTask as Record<string, unknown>;
    const taskPr = Number(task.pr);
    if (!Number.isFinite(taskPr) || taskPr !== prNumber) continue;
    const pairId = typeof task.challengePairId === 'string' ? task.challengePairId.trim() : '';
    if (!pairId) continue;
    const side: 'primary' | 'challenger' = task.challengeRole === 'challenger' ? 'challenger' : 'primary';
    const siblingKey = side === 'primary' ? `${pairId}_c` : pairId;
    const sibling = (tasks as Record<string, unknown>)[siblingKey];
    if (!sibling || typeof sibling !== 'object') return null;
    const siblingPr = Number((sibling as Record<string, unknown>).pr);
    if (!Number.isFinite(siblingPr) || siblingPr <= 0) return null;
    return { pairId, side, siblingPr };
  }
  return null;
}
