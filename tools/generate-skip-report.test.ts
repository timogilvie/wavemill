import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..');
const toolPath = resolve(__dirname, 'generate-skip-report.ts');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    challengePairId: 'pair',
    timestamp: '2026-08-20T00:00:00Z',
    comparisonOutcome: 'compared',
    winner: 'primary',
    primaryModel: 'a',
    challengerModel: 'b',
    primaryPrUrl: 'url1',
    challengerPrUrl: 'url2',
    primaryEvalScore: 1,
    challengerEvalScore: 1,
    rationale: 'test',
    dimensions: {
      completeness: { primary: 0, challenger: 0 },
      correctness: { primary: 0, challenger: 0 },
      code_quality: { primary: 0, challenger: 0 },
      intervention_impact: { primary: 0, challenger: 0 },
      autonomy: { primary: 0, challenger: 0 },
    },
    ...overrides,
  };
}

describe('generate-skip-report CLI', () => {
  it('prints JSON rates and excludes explicit phantom pairs from launched denominator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generate-skip-report-'));
    tempDirs.push(dir);
    const recordsFile = join(dir, 'challenge-records.jsonl');
    const records = [
      makeRecord({ challengePairId: 'compared' }),
      makeRecord({
        challengePairId: 'invalid',
        comparisonOutcome: 'invalid',
        winner: undefined,
        provenanceValidation: { valid: false, outcome: 'invalid', issues: [] },
      }),
      makeRecord({
        challengePairId: 'phantom',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        noComparisonReason: 'challenger_never_launched',
      }),
    ];
    writeFileSync(recordsFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8');

    const result = spawnSync(process.execPath, [toolPath, '--file', recordsFile, '--no-evals', '--json'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env },
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.launchedPairs, 2);
    assert.equal(report.phantomPairs, 1);
    assert.equal(report.skipRate, 0.5);
    assert.equal(report.byReason.challenger_never_launched.count, 1);
  });
});
