import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { StoredChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import {
  aggregatePairs,
  computeFunnel,
  computeYieldStats,
  estimateUsableForfeits,
  partitionByForkDate,
  recommend,
  stratifyFunnel,
} from './arbiter-r6-analysis.ts';

const dims = {
  completeness: { primary: 0, challenger: 0 },
  correctness: { primary: 0, challenger: 0 },
  code_quality: { primary: 0, challenger: 0 },
  intervention_impact: { primary: 0, challenger: 0 },
  autonomy: { primary: 0, challenger: 0 },
};

function makeComparison(
  overrides: Partial<StoredChallengeComparison> & { challengePairId: string; timestamp: string },
): StoredChallengeComparison {
  return {
    primaryModel: 'primary',
    challengerModel: 'challenger',
    primaryPrUrl: `https://x/${overrides.challengePairId}-p`,
    challengerPrUrl: `https://x/${overrides.challengePairId}-c`,
    primaryEvalScore: null,
    challengerEvalScore: null,
    rationale: '',
    dimensions: dims,
    ...overrides,
  } as StoredChallengeComparison;
}

function makeEval(overrides: Partial<EvalRecord> & { challengePairId: string; timestamp: string }): EvalRecord {
  return {
    schemaVersion: '1.40.0',
    originalPrompt: '',
    modelId: 'claude-opus',
    modelVersion: 'v1',
    score: 0.5,
    scoreBand: 'good' as EvalRecord['scoreBand'],
    timeSeconds: 100,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: '',
    agentType: 'native-openrouter',
    ...overrides,
  } as EvalRecord;
}

describe('partitionByForkDate', () => {
  it('splits records around the cutoff and keeps unparseable timestamps in pre-fork', () => {
    const records = [
      { timestamp: '2026-07-01T00:00:00Z' },
      { timestamp: '2026-08-15T00:00:00Z' },
      { timestamp: 'not-a-date' },
    ];
    const { pre, post } = partitionByForkDate(records, new Date('2026-08-01T00:00:00Z'));
    assert.equal(pre.length, 2);
    assert.equal(post.length, 1);
  });
});

describe('computeYieldStats', () => {
  it('counts compared vs launched and buckets no-comparison causes', () => {
    const stats = computeYieldStats([
      makeComparison({ challengePairId: '1', timestamp: '2026-07-01', comparisonOutcome: 'compared' }),
      makeComparison({
        challengePairId: '2',
        timestamp: '2026-07-02',
        comparisonOutcome: 'forfeit',
        terminalReason: 'primary_eval_hard_failed',
      }),
      makeComparison({
        challengePairId: '3',
        timestamp: '2026-07-03',
        comparisonOutcome: 'invalid_challenge',
        invalidChallengeReason: 'stage_override_lost',
      }),
    ]);
    assert.equal(stats.launched, 3);
    assert.equal(stats.compared, 1);
    assert.ok(stats.yieldPercent > 33 && stats.yieldPercent < 34);
    assert.equal(stats.noComparisonBreakdown.get('primary_eval_hard_failed'), 1);
    assert.equal(stats.noComparisonBreakdown.get('stage_override_lost'), 1);
  });

  it('handles empty input', () => {
    const stats = computeYieldStats([]);
    assert.equal(stats.launched, 0);
    assert.equal(stats.yieldPercent, 0);
  });
});

describe('estimateUsableForfeits', () => {
  it('counts primary-failure pairs as usable forfeits', () => {
    const forfeits = estimateUsableForfeits([
      makeComparison({
        challengePairId: '1',
        timestamp: '2026-07-01',
        comparisonOutcome: 'forfeit',
        terminalReason: 'primary_eval_hard_failed',
      }),
      makeComparison({
        challengePairId: '2',
        timestamp: '2026-07-02',
        comparisonOutcome: 'forfeit',
        terminalReason: 'challenger_eval_hard_failed',
      }),
      makeComparison({
        challengePairId: '3',
        timestamp: '2026-07-03',
        comparisonOutcome: 'compared',
      }),
    ]);
    assert.equal(forfeits, 1);
  });
});

describe('aggregatePairs and computeFunnel', () => {
  it('collapses per-side eval records into per-pair aggregates and computes the seven funnel stages', () => {
    const evals: EvalRecord[] = [
      makeEval({
        challengePairId: 'pair1',
        timestamp: '2026-08-15T00:00:00Z',
        challengeSide: 'primary',
        challengeRouteContext: { decisionSource: 'expanded' } as EvalRecord['challengeRouteContext'],
        challengeIntent: {
          pairId: 'pair1',
          challengeStage: 'review',
          primary: {
            pairId: 'pair1',
            side: 'primary',
            challengeStage: 'review',
            expectedStageModel: 'primary',
            expectedRoute: { planner: 'x', coder: 'x', reviewer: 'primary', planDepth: 'x', codeDepth: 'x', reviewMode: 'x' },
          },
          challenger: {
            pairId: 'pair1',
            side: 'challenger',
            challengeStage: 'review',
            expectedStageModel: 'challenger',
            expectedRoute: { planner: 'x', coder: 'x', reviewer: 'challenger', planDepth: 'x', codeDepth: 'x', reviewMode: 'x' },
          },
        },
        challengeExecutionEvidence: {
          pairId: 'pair1',
          side: 'primary',
          validity: 'valid',
          challengeStage: 'review',
          expectedStageModel: 'primary',
          evidence: [{ stage: 'review', model: 'primary' }],
        },
        prUrl: 'https://x/1',
        workflowCost: 0.2,
        timeSeconds: 100,
      }),
    ];
    const comparisonsByPair = new Map<string, StoredChallengeComparison>();
    comparisonsByPair.set(
      'pair1',
      makeComparison({
        challengePairId: 'pair1',
        timestamp: '2026-08-15T00:00:00Z',
        comparisonOutcome: 'compared',
      }),
    );
    const pairs = [...aggregatePairs(evals, comparisonsByPair).values()];
    assert.equal(pairs.length, 1);
    const pair = pairs[0]!;
    assert.equal(pair.eligible, true);
    assert.equal(pair.selected, true);
    assert.equal(pair.stageLaunched, true);
    assert.equal(pair.validComparison, true);

    const funnel = computeFunnel(pairs);
    assert.equal(funnel.length, 7);
    assert.equal(funnel[6]!.name, 'Valid comparison');
    assert.equal(funnel[6]!.count, 1);
    assert.equal(funnel[0]!.cumulativeYieldPercent, 100);
  });
});

describe('stratifyFunnel', () => {
  it('groups pairs by the requested key and computes per-group yield', () => {
    const pairs = [
      {
        pairId: '1', timestamp: 0, eligible: true, selected: true, intentPersisted: true,
        armMaterialized: true, stageLaunched: true, terminalReached: true, validComparison: true,
        provider: 'openrouter', canonicalModel: 'x', sharedPrefix: true, costUsd: 0.5, elapsedSeconds: 100,
      },
      {
        pairId: '2', timestamp: 0, eligible: true, selected: true, intentPersisted: true,
        armMaterialized: true, stageLaunched: true, terminalReached: true, validComparison: false,
        provider: 'openrouter', canonicalModel: 'y', sharedPrefix: false, costUsd: 0.3, elapsedSeconds: 200,
      },
    ];
    const strata = stratifyFunnel(pairs, (p) => p.provider);
    assert.equal(strata.length, 1);
    assert.equal(strata[0]!.eligible, 2);
    assert.equal(strata[0]!.compared, 1);
    assert.equal(strata[0]!.yieldPercent, 50);
  });
});

describe('recommend', () => {
  it('returns Insufficient Data when the post-fork sample is too small', () => {
    const stats = computeYieldStats([]);
    const rec = recommend(stats, stats, stats, stats);
    assert.equal(rec.decision, 'Insufficient Data');
  });

  it('returns Go when yield improves meaningfully and forked pairs match independent ones', () => {
    const empty = computeYieldStats([]);
    const smallLaunched = 30;
    const pre: typeof empty = { ...empty, launched: smallLaunched, compared: 10, yieldPercent: 33.3, usableForfeits: 5 };
    const post: typeof empty = { ...empty, launched: smallLaunched, compared: 20, yieldPercent: 66.6 };
    const forked: typeof empty = { ...empty, launched: 15, compared: 10, yieldPercent: 66.6 };
    const indep: typeof empty = { ...empty, launched: 15, compared: 10, yieldPercent: 66.6 };
    const rec = recommend(pre, post, forked, indep);
    assert.equal(rec.decision, 'Go');
  });

  it('returns No-Go when yield regresses meaningfully', () => {
    const empty = computeYieldStats([]);
    const pre: typeof empty = { ...empty, launched: 30, compared: 20, yieldPercent: 66.6, usableForfeits: 5 };
    const post: typeof empty = { ...empty, launched: 30, compared: 10, yieldPercent: 33.3 };
    const forked: typeof empty = { ...empty, launched: 15, compared: 4, yieldPercent: 26.6 };
    const indep: typeof empty = { ...empty, launched: 15, compared: 6, yieldPercent: 40.0 };
    const rec = recommend(pre, post, forked, indep);
    assert.equal(rec.decision, 'No-Go');
  });
});
