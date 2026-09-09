import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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

function writeFixtureArtifacts(dir: string) {
  mkdirSync(dir, { recursive: true });
  const swapPath = join(dir, 'swap-summary.json');
  const survivalPath = join(dir, 'survival.json');
  const evalPath = join(dir, 'eval.json');

  writeFileSync(swapPath, `${JSON.stringify({
    runId: 'swap-fixture',
    judge_model: 'test-judge',
    judge_template_hash: 'template-hash',
    totals: {
      pairs: 2,
      usablePairs: 2,
      judgeErrors: 0,
      hydrationFailed: 0,
      calls: 4,
      costUsd: 0,
      truncatedPrompts: 0,
      tokens: 0,
    },
    overall: flipCell(1, 2),
    withoutDegenerate: flipCell(1, 2),
    byChallengeType: { 'coder-only': flipCell(1, 2) },
    byDifficultyBucket: { '4': flipCell(1, 2) },
    byDifficultyCollapsed: { '4 hard': flipCell(1, 2) },
    typeDifficultyCrosstab: {},
    flipDirection: { first: 1, second: 0, none: 0 },
    agreementWithOriginal: {
      primaryFirst: flipCell(1, 2),
      challengerFirst: flipCell(1, 2),
    },
    pairs: [],
  })}\n`);

  writeFileSync(survivalPath, `${JSON.stringify({
    population: 2,
    analyzed: 2,
    excluded: { noLabel: 0, missingHorizon: 0, keptPrUnmerged: 0 },
    overall: { cell: successCell(1, 2), keptPrSurvivors: 1 },
    byChallengeType: { 'coder-only': successCell(1, 2) },
    byDifficultyBucket: { '4': successCell(1, 2) },
    byDifficultyCollapsed: { '4 hard': successCell(1, 2) },
    rows: [],
  })}\n`);

  writeFileSync(evalPath, `${JSON.stringify({
    population: 2,
    analyzed: 2,
    excluded: { missingEvalPrimary: 0, missingEvalChallenger: 0, scoreFallback: 0 },
    ties: 0,
    fallback: {
      scoreFallback: 0,
      disagreements: 0,
      disagreementCell: successCell(0, 0),
    },
    overall: {
      disagreementCell: successCell(1, 2),
      disagreements: 1,
      agreements: 1,
    },
    marginClosenessTable: {},
    byChallengeType: { 'coder-only': successCell(1, 2) },
    byDifficultyBucket: { '4': successCell(1, 2) },
    byDifficultyCollapsed: { '4 hard': successCell(1, 2) },
    disagreementsByMarginCloseness: {
      margin: {},
      medianMargin: null,
      closeness: { lt_005: 0, lt_015: 0, lt_030: 0, gte_030: 1 },
    },
    rows: [],
  })}\n`);

  return { swapPath, survivalPath, evalPath };
}

function runCli(args: string[], cwd = process.cwd()): string {
  return execFileSync('npx', ['tsx', 'tools/arbiter-analyze-p1-probes.ts', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('arbiter-analyze-p1-probes CLI', () => {
  it('writes deterministic JSON and Markdown from valid artifacts', () => {
    const tmpdir = mkdtempSync('/tmp/arbiter-p1-analysis-');
    const artifacts = writeFixtureArtifacts(join(tmpdir, 'artifacts'));
    const outJson = join(tmpdir, 'out', 'analysis.json');
    const outMd = join(tmpdir, 'out', 'analysis.md');

    const output = runCli([
      '--swap-summary', artifacts.swapPath,
      '--survival-summary', artifacts.survivalPath,
      '--eval-disagreement-summary', artifacts.evalPath,
      '--out-json', outJson,
      '--out-md', outMd,
      '--generated-at', '2026-09-09T00:00:00.000Z',
      '--git-revision', 'fixture-sha',
      '--horizon', '30',
    ]);

    assert(output.includes('analysis.json'));
    assert(output.includes('analysis.md'));
    const json = JSON.parse(readFileSync(outJson, 'utf-8'));
    assert.equal(json.generatedAt, '2026-09-09T00:00:00.000Z');
    assert.equal(json.gitRevision, 'fixture-sha');
    assert.equal(json.horizonDays, 30);
    assert.equal(json.gate.call, 'decision_layer');
    assert.equal(json.metrics.flipRate.overall.events, 1);

    const markdown = readFileSync(outMd, 'utf-8');
    assert.match(markdown, /^# Arbiter Phase 1 Gate Write-up/);
    assert.match(markdown, /\*\*arbitrate\(\) remains a decision layer\.\*\*/);
    assert.match(markdown, /swap-summary/);
  });

  it('fails clearly when a required artifact is missing', () => {
    const tmpdir = mkdtempSync('/tmp/arbiter-p1-analysis-');
    const artifacts = writeFixtureArtifacts(join(tmpdir, 'artifacts'));

    assert.throws(() => runCli([
      '--swap-summary', join(tmpdir, 'missing.json'),
      '--survival-summary', artifacts.survivalPath,
      '--eval-disagreement-summary', artifacts.evalPath,
    ]), /Required Phase 1 artifact is missing/);
  });

  it('fails clearly on malformed JSON before writing outputs', () => {
    const tmpdir = mkdtempSync('/tmp/arbiter-p1-analysis-');
    const artifacts = writeFixtureArtifacts(join(tmpdir, 'artifacts'));
    const malformed = join(tmpdir, 'artifacts', 'malformed.json');
    const outJson = join(tmpdir, 'out', 'analysis.json');
    writeFileSync(malformed, '{not-json}\n');

    assert.throws(() => runCli([
      '--swap-summary', artifacts.swapPath,
      '--survival-summary', malformed,
      '--eval-disagreement-summary', artifacts.evalPath,
      '--out-json', outJson,
    ]), /Malformed JSON/);
    assert.equal(existsSync(outJson), false);
  });
});
