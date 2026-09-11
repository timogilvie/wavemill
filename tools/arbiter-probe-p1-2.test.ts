import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { StoredChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import type { ArbiterSurvivalLabelV1 } from '../shared/lib/arbiter-survival-label.ts';

const makeChallengeRecord = (id: string, winner: 'primary' | 'challenger'): StoredChallengeComparison => {
  return {
    challengePairId: id,
    primaryPrUrl: `https://github.com/owner/repo/pull/${parseInt(id) * 2}`,
    challengerPrUrl: `https://github.com/owner/repo/pull/${parseInt(id) * 2 + 1}`,
    winner,
    timestamp: '2026-01-01T00:00:00Z',
    dimensions: { planning: { primary: 0.8, challenger: 0.6 } },
    rationale: 'test verdict',
    variedDimensions: {},
    challengeType: undefined,
  };
};

const makeEvalRecord = (prUrl: string, score: number, pairId?: string, stage?: string): EvalRecord => {
  const record: EvalRecord = {
    prUrl,
    score,
    challengePairId: pairId,
    timestamp: '2026-01-01T00:00:00Z',
  };
  if (stage) {
    record.stageOutcomes = { [stage]: { score } };
  }
  return record;
};

const makeSurvivalLabel = (
  prUrl: string,
  reportOutcome: 'survived' | 'reverted' | null,
): ArbiterSurvivalLabelV1 => {
  return {
    schema_version: '1.0.0',
    prUrl,
    horizon_days: 30,
    label_provenance: 'harvested',
    line_ranges: [],
    outcome: {
      survived: reportOutcome === 'survived',
      survival_ratio: reportOutcome === 'survived' ? 1.0 : 0.0,
      reverted: reportOutcome === 'reverted',
      followup: false,
      undone_by: null,
      report_outcome: reportOutcome,
      reason_codes: [],
    },
    envelope: {
      schema_version: '1.0.0',
      labeller_version: '1.0.0',
      normalization_version: '1.0.0',
      pr_head_sha: 'abc123',
      merge_sha: 'def456',
      horizon_terminal_sha: 'ghi789',
      integration_branch: 'auto/integration',
      computed_at: '2026-01-01T00:00:00Z',
    },
  };
};

describe('arbiter-probe-p1-2 CLI', () => {
  it('runs both probes end-to-end with fixture data', () => {
    const tmpdir = mkdtempSync('/tmp/arbiter-probe-test-');
    const evalsDir = join(tmpdir, '.wavemill', 'evals');
    const outDir = join(tmpdir, 'docs', 'arbiter');
    const dataOutDir = join(tmpdir, '.wavemill', 'evals', 'arbiter-probes');

    // Create challenge records
    mkdirSync(evalsDir, { recursive: true });
    const pair1 = makeChallengeRecord('1', 'primary');
    const pair2 = makeChallengeRecord('2', 'primary');
    const recordsPath = join(evalsDir, 'challenge-records.jsonl');
    writeFileSync(`${recordsPath}`, `${JSON.stringify(pair1)}\n${JSON.stringify(pair2)}\n`);

    // Create eval records
    const evals = [
      makeEvalRecord(pair1.primaryPrUrl, 0.8, pair1.challengePairId, 'plan'),
      makeEvalRecord(pair1.challengerPrUrl, 0.6, pair1.challengePairId, 'plan'),
      makeEvalRecord(pair2.primaryPrUrl, 0.8, pair2.challengePairId, 'plan'),
      makeEvalRecord(pair2.challengerPrUrl, 0.6, pair2.challengePairId, 'plan'),
    ];
    const evalsPath = join(evalsDir, 'evals.jsonl');
    writeFileSync(evalsPath, evals.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // Create survival labels
    const labels = [
      makeSurvivalLabel(pair1.primaryPrUrl, 'survived'),
      makeSurvivalLabel(pair2.primaryPrUrl, 'reverted'),
    ];
    const labelsPath = join(evalsDir, 'survival-labels.jsonl');
    writeFileSync(labelsPath, labels.map((l) => JSON.stringify(l)).join('\n') + '\n');

    // Run the CLI
    const cmd = `npx tsx tools/arbiter-probe-p1-2.ts --repo-dir ${tmpdir} --evals-dir ${evalsDir} --out-dir ${outDir} --data-out-dir ${dataOutDir}`;

    const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8' });

    // Check that reports were generated
    assert(
      readFileSync(join(outDir, 'p1-2-survival-probe-report.md'), 'utf-8').includes('Probe B'),
    );
    assert(
      readFileSync(join(outDir, 'p1-2-eval-disagreement-report.md'), 'utf-8').includes('Probe C'),
    );

    // Check that data files were generated
    const survivalData = JSON.parse(readFileSync(join(dataOutDir, 'p1-2-survival-probe.json'), 'utf-8'));
    assert.strictEqual(survivalData.analyzed, 2);
    assert(survivalData.overall.cell.rate !== null);

    const evalData = JSON.parse(readFileSync(join(dataOutDir, 'p1-2-eval-disagreement.json'), 'utf-8'));
    assert.strictEqual(evalData.analyzed, 2);

    // Check stdout mentions reports
    assert(output.includes('Probe B report'));
    assert(output.includes('Probe C report'));
  });

  it('runs Probe B only when specified', () => {
    const tmpdir = mkdtempSync('/tmp/arbiter-probe-test-');
    const evalsDir = join(tmpdir, '.wavemill', 'evals');
    const outDir = join(tmpdir, 'docs', 'arbiter');
    const dataOutDir = join(tmpdir, '.wavemill', 'evals', 'arbiter-probes');

    mkdirSync(evalsDir, { recursive: true });
    const pair1 = makeChallengeRecord('3', 'primary');
    const recordsPath = join(evalsDir, 'challenge-records.jsonl');
    writeFileSync(recordsPath, JSON.stringify(pair1) + '\n');

    const evals = [
      makeEvalRecord(pair1.primaryPrUrl, 0.8, pair1.challengePairId, 'plan'),
      makeEvalRecord(pair1.challengerPrUrl, 0.6, pair1.challengePairId, 'plan'),
    ];
    const evalsPath = join(evalsDir, 'evals.jsonl');
    writeFileSync(evalsPath, evals.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const labels = [makeSurvivalLabel(pair1.primaryPrUrl, 'survived')];
    const labelsPath = join(evalsDir, 'survival-labels.jsonl');
    writeFileSync(labelsPath, labels.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const cmd = `npx tsx tools/arbiter-probe-p1-2.ts --repo-dir ${tmpdir} --evals-dir ${evalsDir} --out-dir ${outDir} --data-out-dir ${dataOutDir} --probe b`;
    const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8' });

    assert(output.includes('Probe B report'));
    assert(!output.includes('Probe C report'));

    // Survival report should exist
    assert(readFileSync(join(outDir, 'p1-2-survival-probe-report.md'), 'utf-8').length > 0);

    // But eval report should not be created
    const evalReportPath = join(outDir, 'p1-2-eval-disagreement-report.md');
    assert(!existsSync(evalReportPath), 'Eval report should not exist when running only Probe B');
  });

  it('handles missing survival labels gracefully', () => {
    const tmpdir = mkdtempSync('/tmp/arbiter-probe-test-');
    const evalsDir = join(tmpdir, '.wavemill', 'evals');
    const outDir = join(tmpdir, 'docs', 'arbiter');
    const dataOutDir = join(tmpdir, '.wavemill', 'evals', 'arbiter-probes');

    mkdirSync(evalsDir, { recursive: true });
    const pair1 = makeChallengeRecord('4', 'primary');
    const recordsPath = join(evalsDir, 'challenge-records.jsonl');
    writeFileSync(recordsPath, JSON.stringify(pair1) + '\n');

    const evals = [
      makeEvalRecord(pair1.primaryPrUrl, 0.8, pair1.challengePairId, 'plan'),
      makeEvalRecord(pair1.challengerPrUrl, 0.6, pair1.challengePairId, 'plan'),
    ];
    const evalsPath = join(evalsDir, 'evals.jsonl');
    writeFileSync(evalsPath, evals.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // No survival labels file

    const cmd = `npx tsx tools/arbiter-probe-p1-2.ts --repo-dir ${tmpdir} --evals-dir ${evalsDir} --out-dir ${outDir} --data-out-dir ${dataOutDir} --probe b`;
    const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8', stdio: 'pipe' });

    // Should still succeed and report 0 analyzed
    const survivalData = JSON.parse(readFileSync(join(dataOutDir, 'p1-2-survival-probe.json'), 'utf-8'));
    assert.strictEqual(survivalData.analyzed, 0);
  });
});
