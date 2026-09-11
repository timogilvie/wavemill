import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import type { ChallengeComparison } from './challenge-comparison.ts';
import {
  evaluateChallengeReadyEvidence,
  resolveChallengePairFromState,
} from './challenge-ready-evidence.ts';

const PAIR = 'HOK-2963-PAIR';
const PRIMARY_URL = 'https://github.example/acme/wavemill/pull/1328';
const CHALLENGER_URL = 'https://github.example/acme/wavemill/pull/1329';
const PRIMARY_HEAD = 'a'.repeat(40);
const CHALLENGER_HEAD = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);

const PRIMARY = { prUrl: PRIMARY_URL, prNumber: '1328', headSha: PRIMARY_HEAD };
const CHALLENGER = { prUrl: CHALLENGER_URL, prNumber: '1329', headSha: CHALLENGER_HEAD };

function evalRow(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-primary-current',
    challengePairId: PAIR,
    challengeSide: 'primary',
    prUrl: PRIMARY_URL,
    evaluatedPrHeadSha: PRIMARY_HEAD,
    score: 0.8,
    timestamp: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as EvalRecord;
}

function challengerEvalRow(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return evalRow({
    id: 'eval-challenger-current',
    challengeSide: 'challenger',
    prUrl: CHALLENGER_URL,
    evaluatedPrHeadSha: CHALLENGER_HEAD,
    ...overrides,
  });
}

function comparisonRow(overrides: Partial<ChallengeComparison> = {}): ChallengeComparison {
  return {
    challengePairId: PAIR,
    primaryModel: 'model-a',
    challengerModel: 'model-b',
    primaryPrUrl: PRIMARY_URL,
    challengerPrUrl: CHALLENGER_URL,
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.7,
    winner: 'primary',
    winnerModel: 'model-a',
    rationale: 'better',
    dimensions: {
      completeness: { primary: 9, challenger: 8 },
      correctness: { primary: 9, challenger: 8 },
      code_quality: { primary: 9, challenger: 8 },
      intervention_impact: { primary: 9, challenger: 8 },
      autonomy: { primary: 9, challenger: 8 },
    },
    timestamp: '2026-09-02T00:00:00.000Z',
    comparisonOutcome: 'compared',
    selectedEvalEvidence: {
      primary: { evalId: 'eval-primary-current', evaluatedPrHeadSha: PRIMARY_HEAD },
      challenger: { evalId: 'eval-challenger-current', evaluatedPrHeadSha: CHALLENGER_HEAD },
    },
    ...overrides,
  } as ChallengeComparison;
}

function evaluate(input: {
  evalRecords?: EvalRecord[];
  comparisons?: ChallengeComparison[];
  side?: 'primary' | 'challenger';
}) {
  return evaluateChallengeReadyEvidence({
    pairId: PAIR,
    side: input.side ?? 'primary',
    primary: PRIMARY,
    challenger: CHALLENGER,
    evalRecords: input.evalRecords ?? [],
    comparisons: input.comparisons ?? [],
  });
}

describe('evaluateChallengeReadyEvidence', () => {
  it('reports eval-pending when the challenger eval is missing', () => {
    const result = evaluate({ evalRecords: [evalRow()] });
    assert.equal(result.outcome, 'eval-pending');
    assert.equal(result.pendingReason, 'challenge-eval-pending');
    assert.equal(result.primaryEval.ok, true);
    assert.equal(result.primaryEval.evalId, 'eval-primary-current');
    assert.equal(result.challengerEval.ok, false);
    assert.equal(result.challengerEval.refusalReason, 'no_matching_pr');
  });

  it('reports eval-pending when one side has only old-head evidence', () => {
    const result = evaluate({
      evalRecords: [evalRow(), challengerEvalRow({ evaluatedPrHeadSha: OLD_HEAD })],
    });
    assert.equal(result.outcome, 'eval-pending');
    assert.equal(result.challengerEval.refusalReason, 'old_head_only');
  });

  it('reports comparison-pending with exact selected eval IDs once both current-head evals exist', () => {
    const result = evaluate({ evalRecords: [evalRow(), challengerEvalRow()] });
    assert.equal(result.outcome, 'comparison-pending');
    assert.equal(result.pendingReason, 'challenge-comparison-pending');
    assert.equal(result.primaryEval.evalId, 'eval-primary-current');
    assert.equal(result.challengerEval.evalId, 'eval-challenger-current');
  });

  it('accepts a comparison whose selected eval evidence matches both live heads', () => {
    const result = evaluate({
      evalRecords: [evalRow(), challengerEvalRow()],
      comparisons: [comparisonRow()],
    });
    assert.equal(result.outcome, 'comparison-valid');
    assert.equal(result.pendingReason, undefined);
    assert.equal(result.acceptedComparisonTimestamp, '2026-09-02T00:00:00.000Z');
  });

  it('treats a compared record with mismatched selected heads as stale', () => {
    const result = evaluate({
      evalRecords: [evalRow(), challengerEvalRow()],
      comparisons: [comparisonRow({
        selectedEvalEvidence: {
          primary: { evalId: 'eval-primary-old', evaluatedPrHeadSha: OLD_HEAD },
          challenger: { evalId: 'eval-challenger-current', evaluatedPrHeadSha: CHALLENGER_HEAD },
        },
      })],
    });
    assert.equal(result.outcome, 'comparison-pending');
    assert.equal(result.staleComparisons, 1);
  });

  it('treats a legacy compared record without selected eval evidence as stale', () => {
    const result = evaluate({
      evalRecords: [evalRow()],
      comparisons: [comparisonRow({ selectedEvalEvidence: undefined })],
    });
    assert.equal(result.outcome, 'eval-pending');
    assert.equal(result.staleComparisons, 1);
  });

  it('accepts an explicit terminal resolution regardless of eval heads', () => {
    const result = evaluate({
      comparisons: [comparisonRow({
        comparisonOutcome: 'forfeit',
        terminalReason: 'challenger_eval_hard_failed',
        selectedEvalEvidence: undefined,
      })],
    });
    assert.equal(result.outcome, 'terminal-resolution');
  });

  it('does not accept a non-decisive phantom forfeit record', () => {
    const result = evaluate({
      comparisons: [comparisonRow({
        comparisonOutcome: 'forfeit',
        winner: undefined,
        winnerModel: undefined,
        selectedEvalEvidence: undefined,
        terminalReason: undefined,
        primaryCompleted: false,
        challengerCompleted: false,
        armFailures: [],
      })],
    });
    assert.equal(result.outcome, 'eval-pending');
  });

  it('ignores records from other pairs and other PRs', () => {
    const result = evaluate({
      evalRecords: [evalRow(), challengerEvalRow()],
      comparisons: [
        comparisonRow({ challengePairId: 'OTHER-PAIR' }),
        comparisonRow({
          primaryPrUrl: 'https://github.example/acme/wavemill/pull/9998',
          challengerPrUrl: 'https://github.example/acme/wavemill/pull/9999',
        }),
      ],
    });
    assert.equal(result.outcome, 'comparison-pending');
  });

  it('prefers a current-head comparison over an earlier terminal record', () => {
    const result = evaluate({
      evalRecords: [evalRow(), challengerEvalRow()],
      comparisons: [
        comparisonRow({
          comparisonOutcome: 'forfeit',
          terminalReason: 'orphan_pair',
          selectedEvalEvidence: undefined,
        }),
        comparisonRow(),
      ],
    });
    assert.equal(result.outcome, 'comparison-valid');
  });
});

describe('resolveChallengePairFromState', () => {
  const state = {
    tasks: {
      'HOK-1': {
        pr: '1328',
        challengePairId: 'HOK-1',
        challengeRole: 'primary',
      },
      'HOK-1_c': {
        pr: '1329',
        challengePairId: 'HOK-1',
        challengeRole: 'challenger',
      },
    },
  };

  it('resolves the primary arm and its challenger sibling', () => {
    assert.deepEqual(resolveChallengePairFromState(state, 1328), {
      pairId: 'HOK-1',
      side: 'primary',
      siblingPr: 1329,
    });
  });

  it('resolves the challenger arm and its primary sibling', () => {
    assert.deepEqual(resolveChallengePairFromState(state, 1329), {
      pairId: 'HOK-1',
      side: 'challenger',
      siblingPr: 1328,
    });
  });

  it('returns null when the sibling arm is missing from state', () => {
    assert.equal(resolveChallengePairFromState({
      tasks: { 'HOK-1': state.tasks['HOK-1'] },
    }, 1328), null);
  });

  it('returns null for non-challenge tasks and malformed state', () => {
    assert.equal(resolveChallengePairFromState({ tasks: { 'HOK-2': { pr: '77' } } }, 77), null);
    assert.equal(resolveChallengePairFromState(null, 1328), null);
    assert.equal(resolveChallengePairFromState('nope', 1328), null);
    assert.equal(resolveChallengePairFromState(state, 4242), null);
  });
});
