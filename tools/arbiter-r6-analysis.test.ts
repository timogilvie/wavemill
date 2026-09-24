import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..');
const toolPath = resolve(__dirname, 'arbiter-r6-analysis.ts');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function emptyDimensions(): Record<string, Record<string, number>> {
  return {
    completeness: { primary: 0, challenger: 0 },
    correctness: { primary: 0, challenger: 0 },
    code_quality: { primary: 0, challenger: 0 },
    intervention_impact: { primary: 0, challenger: 0 },
    autonomy: { primary: 0, challenger: 0 },
  };
}

function makeRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    challengePairId: 'pair',
    timestamp: '2026-09-20T00:00:00Z',
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

function writeCorpus(dir: string, records: Record<string, unknown>[], evals: Record<string, unknown>[] = []): { recordsFile: string; evalsFile: string; evalsDir: string } {
  const evalsDir = join(dir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });
  const recordsFile = join(evalsDir, 'challenge-records.jsonl');
  const evalsFile = join(evalsDir, 'evals.jsonl');
  writeFileSync(recordsFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
  writeFileSync(evalsFile, `${evals.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
  return { recordsFile, evalsFile, evalsDir };
}

describe('arbiter-r6-analysis CLI', () => {
  it('emits JSON with cohort yields, funnel, and recommendation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arbiter-r6-analysis-'));
    tempDirs.push(dir);
    writeCorpus(dir, [
      makeRecord({ challengePairId: 'pre1', sharedPrefix: false, comparisonOutcome: 'compared' }),
      makeRecord({
        challengePairId: 'post1',
        sharedPrefix: true,
        forkStage: 'review',
        forkIdentity: { commit: 'abc', stage: 'review', tree: null, taskPacketHash: null, planHash: null, promptHash: null, toolConfigHash: null },
        stageAttribution: { status: 'valid', outcome: 'primary', stage: 'review', reasonCodes: [], evidenceProvenance: 'direct' },
        comparisonOutcome: 'compared',
      }),
    ]);

    const result = spawnSync('npx', ['tsx', toolPath, '--repo-dir', dir, '--json'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.report.totals.dedupedPairs, 2);
    assert.equal(payload.report.cohorts['pre-fork'].launchedPairs, 1);
    assert.equal(payload.report.cohorts['reviewer-fork'].launchedPairs, 1);
    assert.equal(payload.report.recommendation.decision, 'no-go-insufficient-evidence');
    assert.equal(payload.corpus.records.bytes > 0, true);
    assert.match(payload.corpus.records.sha256, /^[0-9a-f]{64}$/);
  });

  it('emits Markdown with a recommendation and corpus fingerprints by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arbiter-r6-analysis-'));
    tempDirs.push(dir);
    writeCorpus(dir, [makeRecord({ challengePairId: 'pre1', sharedPrefix: false })]);

    const result = spawnSync('npx', ['tsx', toolPath, '--repo-dir', dir], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Arbiter R6 Report/);
    assert.match(result.stdout, /Recommendation/);
    assert.match(result.stdout, /Corpus fingerprints/);
    assert.match(result.stdout, /Extend fork to coder-stage/);
  });

  it('honours strict-cohort by exiting non-zero on ambiguous provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arbiter-r6-analysis-'));
    tempDirs.push(dir);
    writeCorpus(dir, [
      makeRecord({ challengePairId: 'amb1', forkStage: 'plan' }),
    ]);

    const result = spawnSync('npx', ['tsx', toolPath, '--repo-dir', dir, '--strict-cohort', '--json'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /strict-cohort violation/);
  });
});
