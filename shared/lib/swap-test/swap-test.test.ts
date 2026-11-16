import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectAdjudicatedPairs } from './pair-selection.ts';
import { deriveChallengeType, deriveDifficultyBucket } from './strata.ts';
import { hydrateCorpus, defaultFetchDiff } from './corpus.ts';
import { runSwapTest } from './runner.ts';
import { writeSwapTestReport } from './report.ts';
import { wilsonInterval } from '../stats-utils.ts';
import type { StoredChallengeComparison } from '../challenge-comparison.ts';

function dimensions(primary = 8, challenger = 7) {
  return {
    completeness: { primary, challenger },
    correctness: { primary, challenger },
    code_quality: { primary, challenger },
    intervention_impact: { primary, challenger },
    autonomy: { primary, challenger },
  };
}

function record(id: string, timestamp = '2026-01-01T00:00:00.000Z'): StoredChallengeComparison {
  return {
    challengePairId: id,
    primaryModel: 'primary-model',
    challengerModel: 'challenger-model',
    primaryPrUrl: `https://github.com/acme/repo/pull/${id}-p`,
    challengerPrUrl: `https://github.com/acme/repo/pull/${id}-c`,
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.7,
    winner: 'primary',
    winnerModel: 'primary-model',
    rationale: 'LLM verdict',
    dimensions: dimensions(),
    timestamp,
    comparisonOutcome: 'compared',
    variedDimensions: {
      planner: true,
      coder: false,
      reviewer: false,
      planDepth: false,
      codeDepth: false,
      reviewMode: false,
      routerVariant: false,
      plannerPromptVariant: false,
      reviewerPromptVariant: false,
    },
  } as StoredChallengeComparison;
}

function evalRow(pairId: string, prUrl: string, complexity: number, side: 'primary' | 'challenger') {
  return {
    id: `${pairId}-${side}`,
    schemaVersion: '1.41.0',
    originalPrompt: `Issue ${pairId}`,
    modelId: 'model',
    modelVersion: 'model',
    score: 0.8,
    scoreBand: 'good',
    timeSeconds: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    issueId: pairId,
    challengePairId: pairId,
    challengeSide: side,
    prUrl,
    difficultyBand: 'medium',
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        learned: { complexity, domain: 'infra', risk_flags: [] },
        heuristic: {},
      },
      constraints: { models_available: ['model'], objective: 'balanced' },
      stages: {},
      outcome: { overall_score: 0.8, interventions: 0, intervention_types: [] },
    },
  };
}

function blindVerdict(winner: 'A' | 'B') {
  return JSON.stringify({
    winner,
    rationale: 'ok',
    dimensions: {
      completeness: { A: 8, B: 7 },
      correctness: { A: 8, B: 7 },
      code_quality: { A: 8, B: 7 },
      intervention_impact: { A: 8, B: 7 },
      autonomy: { A: 8, B: 7 },
    },
    criterionRationales: {
      completeness: { rationale: 'ok' },
      correctness: { rationale: 'ok' },
      code_quality: { rationale: 'ok' },
      intervention_impact: { rationale: 'ok' },
      autonomy: { rationale: 'ok' },
    },
  });
}

test('selectAdjudicatedPairs filters exclusions, voids, and keeps newest duplicate', () => {
  const older = record('HOK-1', '2026-01-01T00:00:00.000Z');
  const newer = { ...record('HOK-1', '2026-01-02T00:00:00.000Z'), winner: 'challenger' as const };
  const manual = { ...record('HOK-2'), rationale: 'Manual operator resolution' };
  const skipped = { ...record('HOK-3'), comparisonOutcome: 'skipped' as const };
  const voided = record('HOK-4');
  const result = selectAdjudicatedPairs([older, newer, manual, skipped, voided], [
    { challengePairId: 'HOK-4', recordTimestamp: voided.timestamp, reason: 'test', voidedAt: '2026-01-03T00:00:00.000Z' },
  ]);

  assert.deepEqual(result.pairs.map((pair) => pair.pairId), ['HOK-1']);
  assert.equal(result.pairs[0].record.winner, 'challenger');
  assert.equal(result.ledger.duplicatesDropped, 1);
  assert.equal(result.ledger.manualExcluded, 1);
  assert.equal(result.ledger.nonVerdictExcluded, 1);
  assert.equal(result.ledger.voidedExcluded, 1);
});

test('deriveChallengeType and deriveDifficultyBucket recover planned strata without defaulting unknowns', () => {
  const depthOnly = {
    variedDimensions: {
      planner: false,
      coder: false,
      reviewer: false,
      planDepth: true,
      codeDepth: false,
      reviewMode: false,
      routerVariant: false,
      plannerPromptVariant: false,
      reviewerPromptVariant: false,
    },
  };
  assert.deepEqual(deriveChallengeType(depthOnly), { type: 'depth-varied', source: 'variedDimensions' });
  assert.deepEqual(deriveChallengeType({ challengeType: 'multi-variable' as const }), { type: 'multi-variable', source: 'challengeType' });
  assert.deepEqual(deriveChallengeType({}, { challenger: { challengeStage: 'review' } as any, provenance: {} }), { type: 'reviewer-only', source: 'evalChallengeStage' });
  assert.deepEqual(deriveChallengeType({}), { type: 'unrecoverable', source: 'none' });

  assert.equal(deriveDifficultyBucket(undefined, evalRow('HOK-1', 'url', 5, 'challenger') as any).bucket, 5);
  assert.equal(deriveDifficultyBucket(undefined, undefined).collapsed, 'unknown');
});

test('hydrateCorpus is idempotent and runner/report measure flips', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'swap-test-'));
  try {
    const flip = record('HOK-FLIP');
    const stable = record('HOK-STABLE');
    writeFileSync(join(tmp, 'evals.jsonl'), [
      JSON.stringify(evalRow(flip.challengePairId, flip.primaryPrUrl, 4, 'primary')),
      JSON.stringify(evalRow(flip.challengePairId, flip.challengerPrUrl, 4, 'challenger')),
      JSON.stringify(evalRow(stable.challengePairId, stable.primaryPrUrl, 2, 'primary')),
      JSON.stringify(evalRow(stable.challengePairId, stable.challengerPrUrl, 2, 'challenger')),
    ].join('\n') + '\n', 'utf-8');

    let fetches = 0;
    const pairs = [flip, stable].map((item) => ({ pairId: item.challengePairId, record: item }));
    const firstLedger = hydrateCorpus({
      pairs,
      evalsDir: tmp,
      repoDir: tmp,
      deps: {
        fetchDiff(prUrl) {
          fetches++;
          return Buffer.from(`diff for ${prUrl}`);
        },
        fetchPrHead() {
          return { head_sha: 'head' };
        },
      },
    });
    const secondLedger = hydrateCorpus({
      pairs,
      evalsDir: tmp,
      repoDir: tmp,
      deps: {
        fetchDiff() {
          throw new Error('should not refetch');
        },
        fetchPrHead() {
          return { head_sha: 'head' };
        },
      },
    });

    assert.equal(fetches, 4);
    assert.equal(firstLedger.hydrated, 2);
    assert.equal(secondLedger.reused, 4);

    const promptTemplate = '{{ISSUE_PROMPT}}\n{{CANDIDATE_A_DIFF}}\n{{CANDIDATE_B_DIFF}}\n{{RUBRIC}}\n{{WORKFLOW_CONTEXT}}\n{{STAGE_EVIDENCE_CONTEXT}}';
    const dryRun = await runSwapTest({
      evalsDir: tmp,
      runId: 'run-dry-then-real',
      pairIds: pairs.map((pair) => pair.pairId),
      judgeModel: 'judge',
      promptTemplate,
      dryRun: true,
    });
    const realAfterDryRun = await runSwapTest({
      evalsDir: tmp,
      runId: 'run-dry-then-real',
      pairIds: pairs.map((pair) => pair.pairId),
      judgeModel: 'judge',
      promptTemplate,
      deps: {
        async callLlm() {
          return {
            text: blindVerdict('A'),
            rawOutput: blindVerdict('A'),
            provider: 'claude',
            model: 'judge',
          };
        },
      },
    });
    assert.equal(dryRun.rowsWritten, 4);
    assert.equal(realAfterDryRun.rowsWritten, 4);

    await runSwapTest({
      evalsDir: tmp,
      runId: 'run-1',
      pairIds: pairs.map((pair) => pair.pairId),
      judgeModel: 'judge',
      promptTemplate,
      concurrency: 2,
      deps: {
        async callLlm(prompt) {
          const isFlip = prompt.includes('Issue HOK-FLIP');
          const active = isFlip ? flip : stable;
          const challengerFirst = prompt.indexOf(`diff for ${active.challengerPrUrl}`) < prompt.indexOf(`diff for ${active.primaryPrUrl}`);
          const winner = isFlip ? 'A' : challengerFirst ? 'B' : 'A';
          return {
            text: blindVerdict(winner),
            rawOutput: blindVerdict(winner),
            provider: 'claude',
            model: 'judge',
            costUsd: 0.01,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          };
        },
      },
    });
    const rerun = await runSwapTest({
      evalsDir: tmp,
      runId: 'run-1',
      pairIds: pairs.map((pair) => pair.pairId),
      judgeModel: 'judge',
      promptTemplate,
      deps: {
        async callLlm() {
          throw new Error('should skip existing rows');
        },
      },
    });

    assert.equal(rerun.rowsWritten, 0);
    const summary = writeSwapTestReport(tmp, 'run-1', pairs.map((pair) => pair.pairId));
    assert.equal(summary.overall.n, 2);
    assert.equal(summary.overall.flips, 1);
    assert.equal(summary.byChallengeType['planner-only'].n, 2);
    assert.match(readFileSync(join(tmp, 'swap-test', 'runs', 'run-1', 'summary.md'), 'utf-8'), /All usable pairs/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('corpus diff hydration maps the one PR-diff reader onto the ledger (HOK-3493)', () => {
  const tooLarge = Object.assign(
    new Error(`HTTP 406: Sorry, the diff exceeded the maximum number of files (300).\nPullRequest.diff too_large`),
    { stderr: 'PullRequest.diff too_large' },
  );
  const fetchDiff = defaultFetchDiff('/repo', 1_000, {
    runGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          url: 'https://github.com/org/repo/pull/1',
          headRefName: 'feature',
          baseRefName: 'main',
          headRefOid: 'head-sha',
        });
      }
      if (args[0] === 'pr' && args[1] === 'diff') throw tooLarge;
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    runGit: () => {
      throw new Error('fetch failed');
    },
  });

  // An unavailable diff that is too large is the ledger's `too_large`, not an error.
  assert.equal(fetchDiff('https://github.com/org/repo/pull/1'), 'too_large');

  // A readable local diff is the reader's text, as a Buffer.
  const local = defaultFetchDiff('/repo', 1_000, {
    runGh: () =>
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/1',
        headRefName: 'feature',
        baseRefName: 'main',
        headRefOid: 'head-sha',
      }),
    runGit: (args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'diff') return 'diff --git a/a.ts b/a.ts\n+x\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  });
  const buffer = local('https://github.com/org/repo/pull/1');
  assert.ok(Buffer.isBuffer(buffer));
  assert.match(buffer.toString('utf8'), /\+x/);
});

test('wilsonInterval handles empty and known proportions', () => {  assert.deepEqual(wilsonInterval(0, 0), { p: null, lo: null, hi: null });
  const interval = wilsonInterval(5, 10);
  assert.equal(interval.p, 0.5);
  assert.ok(interval.lo! > 0.23 && interval.lo! < 0.24);
  assert.ok(interval.hi! > 0.76 && interval.hi! < 0.77);
  assert.equal(wilsonInterval(138, 138).hi, 1);
});
