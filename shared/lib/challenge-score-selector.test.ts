// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import {
  selectChallengeEvalScore,
  scoreSourceLabel,
  collectPerStageScores,
} from './challenge-score-selector.ts';
import type { EvalRecord } from './eval-schema.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeEvalRecord(overrides?: Partial<EvalRecord>): EvalRecord {
  return {
    id: 'test-id',
    schemaVersion: '1.30.0',
    originalPrompt: 'test',
    modelId: 'claude-sonnet-4-6',
    modelVersion: '1',
    score: 0.65,
    scoreBand: 'Assisted Success',
    timeSeconds: 120,
    timestamp: '2026-06-26T00:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    ...overrides,
  } as EvalRecord;
}

console.log('\n--- selectChallengeEvalScore: overall fallback ---\n');

test('returns overall score for undefined challengeType', () => {
  const record = makeEvalRecord({ score: 0.65 });
  const result = selectChallengeEvalScore(record, undefined);
  assert.equal(result.score, 0.65);
  assert.equal(result.source, 'overall');
  assert.equal(result.warning, undefined);
});

test('returns overall score for multi-variable challengeType', () => {
  const record = makeEvalRecord({ score: 0.7 });
  const result = selectChallengeEvalScore(record, 'multi-variable');
  assert.equal(result.score, 0.7);
  assert.equal(result.source, 'overall');
  assert.equal(result.warning, undefined);
});

test('returns overall score for full-stack challengeType', () => {
  const record = makeEvalRecord({ score: 0.8 });
  const result = selectChallengeEvalScore(record, 'full-stack');
  assert.equal(result.score, 0.8);
  assert.equal(result.source, 'overall');
  assert.equal(result.warning, undefined);
});

console.log('\n--- selectChallengeEvalScore: reviewer-only ---\n');

test('reviewer-only uses metadata.stageScores.review.score', () => {
  const record = makeEvalRecord({
    score: 0.93,
    metadata: { stageScores: { review: { score: 0.75 } } },
  });
  const result = selectChallengeEvalScore(record, 'reviewer-only');
  assert.equal(result.score, 0.75);
  assert.equal(result.source, 'stage.review');
  assert.equal(result.warning, undefined);
});

test('reviewer-only falls back to stageOutcomes.review.score when metadata is absent', () => {
  const record = makeEvalRecord({
    score: 0.93,
    stageOutcomes: { review: { score: 0.75, rationale: 'ok' } },
  });
  const result = selectChallengeEvalScore(record, 'reviewer-only');
  assert.equal(result.score, 0.75);
  assert.equal(result.source, 'stage.review');
  assert.equal(result.warning, undefined);
});

test('reviewer-only: metadata.stageScores wins when both containers have review score', () => {
  const record = makeEvalRecord({
    score: 0.93,
    metadata: { stageScores: { review: { score: 0.64 } } },
    stageOutcomes: { review: { score: 0.75, rationale: 'ok' } },
  });
  const result = selectChallengeEvalScore(record, 'reviewer-only');
  assert.equal(result.score, 0.64);
  assert.equal(result.source, 'stage.review');
});

test('reviewer-only falls back to overall score with warning when stage score missing', () => {
  const record = makeEvalRecord({ score: 0.93 });
  const result = selectChallengeEvalScore(record, 'reviewer-only');
  assert.equal(result.score, 0.93);
  assert.equal(result.source, 'overall');
  assert.ok(result.warning?.includes('stage.review'));
  assert.ok(result.warning?.includes('fell back to overall'));
});

test('reviewer-only falls back to overall when stage score is null', () => {
  const record = makeEvalRecord({
    score: 0.93,
    metadata: { stageScores: { review: { score: null } } },
  });
  const result = selectChallengeEvalScore(record, 'reviewer-only');
  assert.equal(result.score, 0.93);
  assert.equal(result.source, 'overall');
  assert.ok(result.warning);
});

test('reviewer-only HOK-2353 fixture: primary=0.64, challenger=0.75', () => {
  const primary = makeEvalRecord({
    score: 0.65,
    metadata: { stageScores: { review: { score: 0.64 } } },
  });
  const challenger = makeEvalRecord({
    score: 0.93,
    metadata: { stageScores: { review: { score: 0.75 } } },
  });
  const primaryResult = selectChallengeEvalScore(primary, 'reviewer-only');
  const challengerResult = selectChallengeEvalScore(challenger, 'reviewer-only');
  assert.equal(primaryResult.score, 0.64);
  assert.equal(challengerResult.score, 0.75);
  assert.equal(primaryResult.source, 'stage.review');
  assert.equal(challengerResult.source, 'stage.review');
});

console.log('\n--- selectChallengeEvalScore: planner-only ---\n');

test('planner-only uses metadata.stageScores.plan.score', () => {
  const record = makeEvalRecord({
    score: 0.8,
    metadata: { stageScores: { plan: { score: 0.55 } } },
  });
  const result = selectChallengeEvalScore(record, 'planner-only');
  assert.equal(result.score, 0.55);
  assert.equal(result.source, 'stage.plan');
  assert.equal(result.warning, undefined);
});

test('planner-only falls back to stageOutcomes.plan.score', () => {
  const record = makeEvalRecord({
    score: 0.8,
    stageOutcomes: { plan: { score: 0.55, rationale: 'ok' } },
  });
  const result = selectChallengeEvalScore(record, 'planner-only');
  assert.equal(result.score, 0.55);
  assert.equal(result.source, 'stage.plan');
});

test('planner-only falls back to overall score with warning when stage score missing', () => {
  const record = makeEvalRecord({ score: 0.8 });
  const result = selectChallengeEvalScore(record, 'planner-only');
  assert.equal(result.score, 0.8);
  assert.equal(result.source, 'overall');
  assert.ok(result.warning?.includes('stage.plan'));
});

console.log('\n--- selectChallengeEvalScore: coder-only ---\n');

test('coder-only uses metadata.stageScores.implementation.score', () => {
  const record = makeEvalRecord({
    score: 0.7,
    metadata: { stageScores: { implementation: { score: 0.62 } } },
  });
  const result = selectChallengeEvalScore(record, 'coder-only');
  assert.equal(result.score, 0.62);
  assert.equal(result.source, 'stage.implementation');
  assert.equal(result.warning, undefined);
});

test('coder-only falls back to stageOutcomes.implementation.score', () => {
  const record = makeEvalRecord({
    score: 0.7,
    stageOutcomes: { implementation: { score: 0.62, rationale: 'ok' } },
  });
  const result = selectChallengeEvalScore(record, 'coder-only');
  assert.equal(result.score, 0.62);
  assert.equal(result.source, 'stage.implementation');
});

test('coder-only falls back to overall score with warning when stage score missing', () => {
  const record = makeEvalRecord({ score: 0.7 });
  const result = selectChallengeEvalScore(record, 'coder-only');
  assert.equal(result.score, 0.7);
  assert.equal(result.source, 'overall');
  assert.ok(result.warning?.includes('stage.implementation'));
});

test('partial fallback: one side has stage score, other does not', () => {
  const withScore = makeEvalRecord({
    score: 0.9,
    metadata: { stageScores: { review: { score: 0.75 } } },
  });
  const withoutScore = makeEvalRecord({ score: 0.6 });

  const withResult = selectChallengeEvalScore(withScore, 'reviewer-only');
  const withoutResult = selectChallengeEvalScore(withoutScore, 'reviewer-only');

  assert.equal(withResult.score, 0.75);
  assert.equal(withResult.source, 'stage.review');
  assert.equal(withResult.warning, undefined);

  assert.equal(withoutResult.score, 0.6);
  assert.equal(withoutResult.source, 'overall');
  assert.ok(withoutResult.warning);
});

console.log('\n--- scoreSourceLabel ---\n');

test('stage.review + Primary → "Primary review-stage eval score"', () => {
  assert.equal(scoreSourceLabel('stage.review', 'Primary'), 'Primary review-stage eval score');
});

test('stage.plan + Challenger → "Challenger plan-stage eval score"', () => {
  assert.equal(scoreSourceLabel('stage.plan', 'Challenger'), 'Challenger plan-stage eval score');
});

test('stage.implementation + Primary → "Primary implementation-stage eval score"', () => {
  assert.equal(scoreSourceLabel('stage.implementation', 'Primary'), 'Primary implementation-stage eval score');
});

test('overall + Primary → "Primary eval score (overall)"', () => {
  assert.equal(scoreSourceLabel('overall', 'Primary'), 'Primary eval score (overall)');
});

test('overall + Challenger → "Challenger eval score (overall)"', () => {
  assert.equal(scoreSourceLabel('overall', 'Challenger'), 'Challenger eval score (overall)');
});

console.log('\n--- collectPerStageScores ---\n');

test('collectPerStageScores returns empty object for record with no stage scores', () => {
  const record = makeEvalRecord({ score: 0.7 });
  const result = collectPerStageScores(record);
  assert.deepEqual(result, {});
});

test('collectPerStageScores collects from metadata.stageScores', () => {
  const record = makeEvalRecord({
    metadata: {
      stageScores: {
        plan: { score: 0.6 },
        implementation: { score: 0.7 },
        review: { score: 0.5 },
      },
    },
  });
  const result = collectPerStageScores(record);
  assert.equal(result.plan, 0.6);
  assert.equal(result.implementation, 0.7);
  assert.equal(result.review, 0.5);
});

test('collectPerStageScores collects from stageOutcomes when metadata absent', () => {
  const record = makeEvalRecord({
    stageOutcomes: {
      plan: { score: 0.55, rationale: 'ok' },
      review: { score: 0.8, rationale: 'ok' },
    },
  });
  const result = collectPerStageScores(record);
  assert.equal(result.plan, 0.55);
  assert.equal(result.review, 0.8);
});

test('collectPerStageScores prefers metadata.stageScores over stageOutcomes', () => {
  const record = makeEvalRecord({
    metadata: { stageScores: { plan: { score: 0.6 } } },
    stageOutcomes: { plan: { score: 0.9, rationale: 'ok' } },
  });
  const result = collectPerStageScores(record);
  assert.equal(result.plan, 0.6);
});

test('collectPerStageScores skips non-finite values', () => {
  const record = makeEvalRecord({
    metadata: { stageScores: { plan: { score: Number.NaN }, review: { score: 0.7 } } },
  });
  const result = collectPerStageScores(record);
  assert.equal(result.plan, undefined);
  assert.equal(result.review, 0.7);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
