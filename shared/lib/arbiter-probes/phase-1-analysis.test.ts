import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  analyzePhase1ProbeSummaries,
  renderPhase1AnalysisMarkdown,
  type Phase1SourceFile,
} from './phase-1-analysis.ts';
import type { SwapTestSummary } from '../swap-test/report.ts';

const sources: Phase1SourceFile[] = [
  { kind: 'swap-summary', path: '/tmp/swap-summary.json', sha256: 'swap-hash' },
  { kind: 'survival-summary', path: '/tmp/survival.json', sha256: 'survival-hash' },
  { kind: 'eval-disagreement-summary', path: '/tmp/eval.json', sha256: 'eval-hash' },
];

function interval(successes: number, n: number) {
  return {
    p: n === 0 ? null : successes / n,
    lo: n === 0 ? null : 0,
    hi: n === 0 ? null : 1,
  };
}

function flipCell(flips: number, n: number) {
  return { n, flips, rate: n === 0 ? null : flips / n, ci95: interval(flips, n) };
}

function successCell(successes: number, n: number) {
  return { n, successes, rate: n === 0 ? null : successes / n, ci95: interval(successes, n) };
}

function swapSummary(): SwapTestSummary {
  return {
    runId: 'swap-fixture',
    judge_model: 'test-judge',
    judge_template_hash: 'template-hash',
    totals: {
      pairs: 3,
      usablePairs: 2,
      judgeErrors: 1,
      hydrationFailed: 0,
      calls: 4,
      costUsd: 0,
      truncatedPrompts: 0,
      tokens: 0,
    },
    overall: flipCell(1, 2),
    withoutDegenerate: flipCell(1, 2),
    byChallengeType: {
      'coder-only': flipCell(1, 1),
      unrecoverable: { ...flipCell(0, 1), excludedFromStratifiedAnalysis: true },
    },
    byDifficultyBucket: {
      '3': flipCell(0, 1),
      '4': flipCell(1, 1),
    },
    byDifficultyCollapsed: {
      '3 medium': flipCell(0, 1),
      '4 hard': flipCell(1, 1),
    },
    typeDifficultyCrosstab: {},
    flipDirection: { first: 1, second: 0, none: 0 },
    agreementWithOriginal: {
      primaryFirst: flipCell(1, 2),
      challengerFirst: flipCell(1, 2),
    },
    pairs: [],
  };
}

function survivalSummary() {
  return {
    population: 3,
    analyzed: 2,
    excluded: {
      noLabel: 1,
      missingHorizon: 0,
      keptPrUnmerged: 0,
    },
    overall: {
      cell: successCell(1, 2),
      keptPrSurvivors: 1,
    },
    byChallengeType: {
      'coder-only': successCell(1, 1),
      'reviewer-only': successCell(0, 1),
    },
    byDifficultyBucket: {
      '3': successCell(1, 1),
      '4': successCell(0, 1),
    },
    byDifficultyCollapsed: {
      '3 medium': successCell(1, 1),
      '4 hard': successCell(0, 1),
    },
    rows: [
      { pairId: '1', classification: 'analyzed', keptPrOutcome: 'survived' },
      { pairId: '2', classification: 'analyzed', keptPrOutcome: 'reverted' },
      { pairId: '3', classification: 'excluded_no_label' },
    ],
  };
}

function evalSummary() {
  return {
    population: 4,
    analyzed: 2,
    excluded: {
      missingEvalPrimary: 1,
      missingEvalChallenger: 0,
      scoreFallback: 1,
    },
    ties: 1,
    fallback: {
      scoreFallback: 1,
      disagreements: 1,
      disagreementCell: successCell(1, 1),
    },
    overall: {
      disagreementCell: successCell(1, 2),
      disagreements: 1,
      agreements: 1,
    },
    marginClosenessTable: {},
    byChallengeType: {
      'coder-only': successCell(1, 1),
      'reviewer-only': successCell(0, 1),
    },
    byDifficultyBucket: {
      '3': successCell(1, 1),
      '4': successCell(0, 1),
    },
    byDifficultyCollapsed: {
      '3 medium': successCell(1, 1),
      '4 hard': successCell(0, 1),
    },
    disagreementsByMarginCloseness: {
      margin: {},
      medianMargin: null,
      closeness: { lt_005: 0, lt_015: 0, lt_030: 0, gte_030: 1 },
    },
    rows: [
      { pairId: '1', classification: 'analyzed', agrees: true },
      { pairId: '2', classification: 'excluded_score_fallback', agrees: false },
      { pairId: '3', classification: 'eval_tie' },
      { pairId: '4', classification: 'excluded_missing_eval_primary' },
    ],
  };
}

describe('phase-1-analysis', () => {
  it('normalizes probe summaries into event rates with Wilson CIs', () => {
    const snapshot = analyzePhase1ProbeSummaries({
      swapSummary: swapSummary(),
      survivalSummary: survivalSummary(),
      evalDisagreementSummary: evalSummary(),
      sources,
      generatedAt: '2026-09-09T00:00:00.000Z',
      gitRevision: 'abc123',
    });

    assert.equal(snapshot.metrics.flipRate.overall.events, 1);
    assert.equal(snapshot.metrics.flipRate.overall.n, 2);
    assert.equal(snapshot.metrics.flipRate.overall.rate, 0.5);
    assert(snapshot.metrics.flipRate.overall.ci95.lo! > 0);
    assert(snapshot.metrics.flipRate.overall.ci95.hi! < 1);
  });

  it('inverts eval agreement strata into disagreement strata without counting ties', () => {
    const snapshot = analyzePhase1ProbeSummaries({
      swapSummary: swapSummary(),
      survivalSummary: survivalSummary(),
      evalDisagreementSummary: evalSummary(),
      sources,
      generatedAt: '2026-09-09T00:00:00.000Z',
      gitRevision: 'abc123',
    });

    assert.equal(snapshot.population.evalTies, 1);
    assert.equal(snapshot.metrics.judgeEvalDisagreement.overall.n, 2);
    assert.equal(snapshot.metrics.judgeEvalDisagreement.byChallengeType['coder-only'].events, 0);
    assert.equal(snapshot.metrics.judgeEvalDisagreement.byChallengeType['reviewer-only'].events, 1);
  });

  it('preserves exclusions and fallback annotations in report notes', () => {
    const snapshot = analyzePhase1ProbeSummaries({
      swapSummary: swapSummary(),
      survivalSummary: survivalSummary(),
      evalDisagreementSummary: evalSummary(),
      sources,
      generatedAt: '2026-09-09T00:00:00.000Z',
      gitRevision: 'abc123',
    });
    const markdown = renderPhase1AnalysisMarkdown(snapshot);

    assert.match(markdown, /No-label, missing-horizon, and unmerged kept-side rows are not counted/);
    assert.match(markdown, /Score fallback rows remain analyzed and annotated: 1; fallback disagreements: 1/);
    assert.match(markdown, /unrecoverable .*included overall; excluded from per-type interpretation/);
  });

  it('reports insufficient data when any required probe denominator is zero', () => {
    const survival = survivalSummary();
    survival.analyzed = 0;
    survival.overall.cell = successCell(0, 0);
    survival.byChallengeType = {};
    survival.byDifficultyBucket = {};
    survival.byDifficultyCollapsed = {};

    const snapshot = analyzePhase1ProbeSummaries({
      swapSummary: swapSummary(),
      survivalSummary: survival,
      evalDisagreementSummary: evalSummary(),
      sources,
      generatedAt: '2026-09-09T00:00:00.000Z',
      gitRevision: 'abc123',
    });

    assert.equal(snapshot.gate.call, 'insufficient_data');
    assert.match(snapshot.decisionLogEntry, /Phase 1 gate not called/);
  });

  it('refuses the de-noising branch unless every non-empty cell is above 90 percent stable or agreement', () => {
    assert.throws(() => analyzePhase1ProbeSummaries({
      swapSummary: swapSummary(),
      survivalSummary: survivalSummary(),
      evalDisagreementSummary: evalSummary(),
      sources,
      generatedAt: '2026-09-09T00:00:00.000Z',
      gitRevision: 'abc123',
      gateMode: 'de-noising-feature',
    }), /Refusing to call the de-noising branch/);
  });
});
