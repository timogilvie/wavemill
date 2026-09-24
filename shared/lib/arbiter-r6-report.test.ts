import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildArbiterR6Report,
  classifyCohort,
  formatArbiterR6ReportJson,
  formatArbiterR6ReportMarkdown,
  type R6EvalRow,
} from './arbiter-r6-report.ts';
import type { StoredChallengeComparison } from './challenge-comparison.ts';
import type { ChallengeRecordVoid } from './challenge-record-void.ts';

function emptyDimensions(): StoredChallengeComparison['dimensions'] {
  return {
    completeness: { primary: 0, challenger: 0 },
    correctness: { primary: 0, challenger: 0 },
    code_quality: { primary: 0, challenger: 0 },
    intervention_impact: { primary: 0, challenger: 0 },
    autonomy: { primary: 0, challenger: 0 },
  };
}

function record(overrides: Partial<StoredChallengeComparison> & Pick<StoredChallengeComparison, 'challengePairId'>): StoredChallengeComparison {
  return {
    timestamp: '2026-08-10T00:00:00Z',
    comparisonOutcome: 'compared',
    winner: 'primary',
    primaryModel: 'a',
    challengerModel: 'b',
    primaryPrUrl: 'url1',
    challengerPrUrl: 'url2',
    primaryEvalScore: 1,
    challengerEvalScore: 1,
    rationale: 'test',
    dimensions: emptyDimensions(),
    ...overrides,
  };
}

test('classifyCohort', async (t) => {
  await t.test('reviewer-fork requires sharedPrefix=true and forkStage=review', () => {
    assert.equal(classifyCohort(record({ challengePairId: 'a', sharedPrefix: true, forkStage: 'review' })), 'reviewer-fork');
    assert.equal(classifyCohort(record({ challengePairId: 'a', sharedPrefix: true, forkStage: 'plan' })), 'other-fork');
    assert.equal(classifyCohort(record({ challengePairId: 'a', sharedPrefix: false })), 'pre-fork');
    assert.equal(classifyCohort(record({ challengePairId: 'a', sharedPrefix: undefined, forkStage: undefined })), 'pre-fork');
    assert.equal(classifyCohort(record({ challengePairId: 'a', sharedPrefix: undefined, forkStage: 'plan' })), 'ambiguous');
  });
});

test('buildArbiterR6Report', async (t) => {
  await t.test('dedupes pairs and honours voids', () => {
    const older = record({ challengePairId: 'p1', timestamp: '2026-08-10T00:00:00Z', comparisonOutcome: 'compared' });
    const newer = record({ challengePairId: 'p1', timestamp: '2026-08-11T00:00:00Z', comparisonOutcome: 'forfeit', terminalReason: 'primary_eval_hard_failed' });
    const voids: ChallengeRecordVoid[] = [];
    const report = buildArbiterR6Report({ comparisons: [older, newer], voids });
    assert.equal(report.totals.dedupedPairs, 1);
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.launchedPairs, 1);
    assert.equal(preFork.forfeitPairs, 1);
    assert.equal(preFork.deliveryComparedPairs, 0);
  });

  await t.test('drops voided records', () => {
    const rec = record({ challengePairId: 'p1', timestamp: '2026-08-10T00:00:00Z' });
    const voids: ChallengeRecordVoid[] = [
      { challengePairId: 'p1', recordTimestamp: '2026-08-10T00:00:00Z', voidedAt: '2026-08-11T00:00:00Z', reason: 'test' },
    ];
    const report = buildArbiterR6Report({ comparisons: [rec], voids });
    assert.equal(report.totals.dedupedPairs, 0);
  });

  await t.test('separates pre-fork and reviewer-fork cohorts', () => {
    const pre = record({ challengePairId: 'pre1', sharedPrefix: false, comparisonOutcome: 'compared' });
    const post = record({
      challengePairId: 'post1',
      sharedPrefix: true,
      forkStage: 'review',
      forkIdentity: { commit: 'abc', stage: 'review', tree: null, taskPacketHash: null, planHash: null, promptHash: null, toolConfigHash: null },
      stageAttribution: { status: 'valid', outcome: 'primary', stage: 'review', reasonCodes: [], evidenceProvenance: 'direct' },
      comparisonOutcome: 'compared',
    });
    const report = buildArbiterR6Report({ comparisons: [pre, post] });
    assert.equal(report.cohorts.get('pre-fork')?.launchedPairs, 1);
    assert.equal(report.cohorts.get('reviewer-fork')?.launchedPairs, 1);
    assert.equal(report.cohorts.get('reviewer-fork')?.validLabelPairs, 1);
    assert.equal(report.cohorts.get('reviewer-fork')?.successfullyForkedPairs, 1);
  });

  await t.test('phantom pairs excluded from launched denominator', () => {
    const phantom = record({
      challengePairId: 'ph1',
      comparisonOutcome: 'forfeit',
      terminalReason: 'orphan_pair',
      challengerPrUrl: 'https://github.com/x/y/pull/0',
      challengerModel: 'unknown',
      noComparisonReason: 'challenger_never_launched',
    });
    const report = buildArbiterR6Report({ comparisons: [phantom] });
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.phantomPairs, 1);
    assert.equal(preFork.launchedPairs, 0);
  });

  await t.test('deliveryYieldRate uses launchedPairs denominator, ignoring phantoms', () => {
    const launchedCompared = record({ challengePairId: 'lc1', comparisonOutcome: 'compared' });
    const launchedForfeit = record({
      challengePairId: 'lf1',
      comparisonOutcome: 'forfeit',
      terminalReason: 'primary_eval_hard_failed',
    });
    const phantom = record({
      challengePairId: 'ph1',
      comparisonOutcome: 'forfeit',
      terminalReason: 'orphan_pair',
      challengerPrUrl: 'https://github.com/x/y/pull/0',
      challengerModel: 'unknown',
      noComparisonReason: 'challenger_never_launched',
    });
    const report = buildArbiterR6Report({ comparisons: [launchedCompared, launchedForfeit, phantom] });
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.launchedPairs, 2);
    assert.equal(preFork.phantomPairs, 1);
    assert.equal(preFork.totalPairs, 3);
    assert.equal(preFork.deliveryComparedPairs, 1);
    assert.equal(preFork.deliveryYieldRate, 0.5);
  });

  await t.test('counterfactual counts pre-fork primary failures with surviving challenger', () => {
    const primaryFailedNoSurvivor = record({
      challengePairId: 'pf1',
      comparisonOutcome: 'forfeit',
      terminalReason: 'primary_eval_hard_failed',
      challengerCompleted: false,
    });
    const primaryFailedChallengerSurvived = record({
      challengePairId: 'pf2',
      comparisonOutcome: 'forfeit',
      terminalReason: 'primary_eval_hard_failed',
      challengerCompleted: true,
    });
    const doubleForfeit = record({
      challengePairId: 'pf3',
      comparisonOutcome: 'double-forfeit',
      terminalReason: 'both_eval_hard_failed',
      challengerCompleted: false,
    });
    const report = buildArbiterR6Report({ comparisons: [primaryFailedNoSurvivor, primaryFailedChallengerSurvived, doubleForfeit] });
    assert.equal(report.counterfactual.preForkPrimaryFailures, 3);
    assert.equal(report.counterfactual.wouldHaveProducedForfeitUnderOldScheme, 1);
    assert.equal(report.counterfactual.actualHistoricalForfeits, 2);
    assert.equal(report.counterfactual.actualDoubleForfeits, 1);
  });

  await t.test('cause aggregation reports typed no-comparison reasons per cohort', () => {
    const identicalRoute = record({
      challengePairId: 'ir1',
      comparisonOutcome: 'invalid_challenge',
      invalidChallengeReason: 'identical_effective_route',
    });
    const invalidChallenge = record({
      challengePairId: 'ic1',
      comparisonOutcome: 'invalid_challenge',
      invalidChallengeReason: 'stage_override_lost',
    });
    const report = buildArbiterR6Report({ comparisons: [identicalRoute, invalidChallenge] });
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.causes.size, 2);
    assert.ok(preFork.causes.has('identical_effective_route'));
    assert.ok(preFork.causes.has('stage_override_lost'));
  });

  await t.test('cost/time per usable pair uses eval join with unavailable counts', () => {
    const rec = record({ challengePairId: 'p1', comparisonOutcome: 'compared' });
    const evals: R6EvalRow[] = [
      { challengePairId: 'p1', challengeSide: 'primary', totalCostUsd: 0.5, timeSeconds: 100 },
      { challengePairId: 'p1', challengeSide: 'challenger', totalCostUsd: 0.75, timeSeconds: 200 },
    ];
    const report = buildArbiterR6Report({ comparisons: [rec], evals });
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.costUsdPerUsablePair, 1.25);
    assert.equal(preFork.wallSecondsPerUsablePair, 300);
    assert.equal(preFork.costUnavailablePairs, 0);
  });

  await t.test('cost/time reports null and unavailable count when evals absent', () => {
    const rec = record({ challengePairId: 'p1', comparisonOutcome: 'compared' });
    const report = buildArbiterR6Report({ comparisons: [rec] });
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.costUsdPerUsablePair, null);
    assert.equal(preFork.wallSecondsPerUsablePair, null);
    assert.equal(preFork.costUnavailablePairs, 1);
    assert.equal(preFork.durationUnavailablePairs, 1);
  });

  await t.test('sharedPrefix strata split records inside each cohort', () => {
    const preSharedFalse = record({ challengePairId: 'pf', sharedPrefix: false, comparisonOutcome: 'compared' });
    const preSharedUnknown = record({ challengePairId: 'pu', comparisonOutcome: 'compared' });
    const report = buildArbiterR6Report({ comparisons: [preSharedFalse, preSharedUnknown] });
    const preFork = report.cohorts.get('pre-fork');
    assert.ok(preFork);
    assert.equal(preFork.bySharedPrefix.get('false')?.launchedPairs, 1);
    assert.equal(preFork.bySharedPrefix.get('unknown')?.launchedPairs, 1);
  });

  await t.test('valid stage-label yield uses successfully-forked denominator for reviewer-fork', () => {
    const forkedValid = record({
      challengePairId: 'v1',
      sharedPrefix: true,
      forkStage: 'review',
      forkIdentity: { commit: 'abc', stage: 'review', tree: null, taskPacketHash: null, planHash: null, promptHash: null, toolConfigHash: null },
      stageAttribution: { status: 'valid', outcome: 'primary', stage: 'review', reasonCodes: [], evidenceProvenance: 'direct' },
      comparisonOutcome: 'compared',
    });
    const forkedInvalid = record({
      challengePairId: 'v2',
      sharedPrefix: true,
      forkStage: 'review',
      forkIdentity: { commit: 'def', stage: 'review', tree: null, taskPacketHash: null, planHash: null, promptHash: null, toolConfigHash: null },
      stageAttribution: { status: 'invalid', outcome: null, stage: 'review', reasonCodes: ['missing_direct_review_evidence'], evidenceProvenance: 'insufficient' },
      comparisonOutcome: 'compared',
    });
    const report = buildArbiterR6Report({ comparisons: [forkedValid, forkedInvalid] });
    const reviewer = report.cohorts.get('reviewer-fork');
    assert.ok(reviewer);
    assert.equal(reviewer.validLabelPairs, 1);
    assert.equal(reviewer.successfullyForkedPairs, 2);
    assert.equal(reviewer.validLabelYieldRate, 0.5);
    assert.equal(reviewer.invalidLabelPairs, 1);
  });

  await t.test('native funnel reports observability and detects phantoms from persisted intent', () => {
    const phantom = record({
      challengePairId: 'ph1',
      comparisonOutcome: 'forfeit',
      terminalReason: 'orphan_pair',
      challengerPrUrl: 'https://github.com/x/y/pull/0',
      challengerModel: 'unknown',
      noComparisonReason: 'challenger_never_launched',
    });
    const evals: R6EvalRow[] = [
      {
        challengePairId: 'ph1',
        challengeSide: 'primary',
        agentType: 'native-openrouter',
        modelId: 'openrouter/kimi-k2',
        challengeIntent: { pairId: 'ph1' },
        challengeStage: 'review',
      },
    ];
    const report = buildArbiterR6Report({ comparisons: [phantom], evals });
    const step1 = report.nativeFunnel.steps.find((step) => step.step === 1);
    const step3 = report.nativeFunnel.steps.find((step) => step.step === 3);
    assert.ok(step1);
    assert.ok(step3);
    assert.equal(step1.count, 1);
    assert.equal(step3.count, 1);
    assert.equal(report.nativeFunnel.phantomPairsFromPersistedIntent, 1);
    assert.equal(report.gateChecks.noPhantomsFromPersistedIntent, false);
  });

  await t.test('recommendation defaults to no-go / insufficient evidence without canaries', () => {
    const rec = record({ challengePairId: 'p1', comparisonOutcome: 'compared', sharedPrefix: false });
    const report = buildArbiterR6Report({ comparisons: [rec] });
    assert.equal(report.recommendation.extendForkToCoderStage, false);
    assert.equal(report.recommendation.decision, 'no-go-insufficient-evidence');
    assert.ok(report.recommendation.reasons.some((reason) => reason.includes('canaries below required minimum')));
  });

  await t.test('recommendation still no-go when reviewer yield drops below pre-fork', () => {
    const preOk = record({ challengePairId: 'pre-ok', sharedPrefix: false, comparisonOutcome: 'compared' });
    const preSkip = record({
      challengePairId: 'pre-skip',
      sharedPrefix: false,
      comparisonOutcome: 'invalid_challenge',
      invalidChallengeReason: 'identical_effective_route',
    });
    const postForfeit = record({
      challengePairId: 'post-forfeit',
      sharedPrefix: true,
      forkStage: 'review',
      forkIdentity: { commit: 'abc', stage: 'review', tree: null, taskPacketHash: null, planHash: null, promptHash: null, toolConfigHash: null },
      stageAttribution: { status: 'valid', outcome: 'primary', stage: 'review', reasonCodes: [], evidenceProvenance: 'direct' },
      comparisonOutcome: 'forfeit',
      terminalReason: 'primary_eval_hard_failed',
    });
    const report = buildArbiterR6Report({
      comparisons: [preOk, preSkip, postForfeit],
      freshCodingCanaryCount: 2,
      challengeRateUnchanged: true,
    });
    assert.equal(report.recommendation.extendForkToCoderStage, false);
    assert.ok(report.recommendation.reasons.some((reason) => reason.includes('lower than pre-fork')));
  });

  await t.test('markdown formatter emits recommendation and cohort tables', () => {
    const rec = record({ challengePairId: 'p1', comparisonOutcome: 'compared', sharedPrefix: false });
    const report = buildArbiterR6Report({ comparisons: [rec] });
    const md = formatArbiterR6ReportMarkdown(report);
    assert.match(md, /Arbiter R6 Report/);
    assert.match(md, /Recommendation/);
    assert.match(md, /pre-fork/);
    assert.match(md, /Native launch funnel/);
  });

  await t.test('json formatter is deterministic and round-trip parseable', () => {
    const rec = record({ challengePairId: 'p1', comparisonOutcome: 'compared', sharedPrefix: false });
    const report = buildArbiterR6Report({ comparisons: [rec] });
    const json = formatArbiterR6ReportJson(report);
    const roundtrip = JSON.parse(JSON.stringify(json));
    assert.equal(roundtrip.totals.dedupedPairs, 1);
    assert.equal(roundtrip.recommendation.decision, 'no-go-insufficient-evidence');
  });

  await t.test('empty corpus emits evidence gaps and no-go / insufficient evidence', () => {
    const report = buildArbiterR6Report({ comparisons: [] });
    assert.equal(report.totals.dedupedPairs, 0);
    assert.equal(report.recommendation.decision, 'no-go-insufficient-evidence');
    assert.ok(report.evidenceGaps.length > 0);
  });

  await t.test('challengeRateUnchanged=false shows up as a rollout gate failure', () => {
    const rec = record({ challengePairId: 'p1', comparisonOutcome: 'compared', sharedPrefix: false });
    const report = buildArbiterR6Report({
      comparisons: [rec],
      challengeRateUnchanged: false,
      freshCodingCanaryCount: 3,
    });
    assert.equal(report.gateChecks.challengeRateUnchanged, false);
    assert.ok(report.recommendation.reasons.some((reason) => reason.includes('challenge.rate changed')));
  });
});
