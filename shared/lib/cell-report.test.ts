/**
 * Report aggregation and conservative verdict thresholds (HOK-3361).
 * protects: distributions, unknown share, agreement rate, cross-tabs with
 * coverage, deterministic disagreement selection (10-15), and the
 * targeted-reviewer recommendation threshold.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCellReport, type CellReportOptions } from './cell-report.ts';
import { buildTestRow, decidedLlm, decidedStructural, undecidedLlm, undecidedStructural } from '../../tests/lib/cell-label-fixtures.ts';
import type { CellLabelRowV0 } from './cell-label-contract.ts';

function cellRow(layer: string, lens: string, overrides: {
  originalUrl?: string;
  correctiveUrl?: string;
  reviewerRan?: boolean;
  coverageUnavailable?: boolean;
  computedAt?: string;
} = {}): CellLabelRowV0 {
  const row = buildTestRow({
    structural: decidedStructural(layer, lens),
    llm: decidedLlm(layer, lens),
    ...(overrides.computedAt ? { computedAt: overrides.computedAt } : {}),
    ...(overrides.originalUrl ? { originalUrl: overrides.originalUrl } : {}),
    ...(overrides.correctiveUrl ? { correctiveUrl: overrides.correctiveUrl } : {}),
  });
  if (overrides.coverageUnavailable) {
    row.review_evidence = { coverage: 'unavailable', reason_codes: ['no_stage_artifact'], reviewer_runs: [], challenge_runs: [] };
  } else {
    row.review_evidence = {
      coverage: 'available',
      reason_codes: [],
      reviewer_runs: [{
        stage: 'review',
        artifact: '.review-result.json',
        status: 'completed',
        evidence_backed: overrides.reviewerRan === true,
        executed_model: overrides.reviewerRan === true ? 'claude-haiku-4-5-20251001' : null,
        evidence_status: overrides.reviewerRan === true ? 'direct' : 'missing',
        head_sha_match: 'unknown',
        recorded_at: '2026-01-01T00:00:00Z',
      }],
      challenge_runs: [],
    };
  }
  return row;
}

describe('cell report', () => {
  it('protects: distributions by row, column and populated cell are counted', () => {
    const rows = [
      cellRow('wiring', 'correctness'),
      cellRow('wiring', 'correctness', { correctiveUrl: 'https://github.com/owner/repo/pull/12' }),
      cellRow('runtime', 'reversibility', { correctiveUrl: 'https://github.com/owner/repo/pull/13' }),
    ];
    const report = buildCellReport(rows);
    assert.equal(report.totals.labelled, 3);
    const wiring = report.byLayer.find((entry) => entry.layer === 'wiring');
    assert.equal(wiring?.total, 2);
    assert.equal(wiring?.byLens.correctness, 2);
    assert.equal(report.byLens.reversibility, 1);
    assert.deepEqual(report.cells[0], { layer: 'wiring', lens: 'correctness', count: 2 });
  });

  it('protects: unknown share is measured explicitly, never imputed', () => {
    const rows = [
      cellRow('wiring', 'correctness'),
      buildTestRow({ structural: undecidedStructural('no_substrate'), llm: undecidedLlm('llm_disabled') }),
    ];
    const report = buildCellReport(rows);
    assert.equal(report.totals.unknown, 1);
    assert.equal(report.totals.unknownShare, 0.5);
  });

  it('protects: agreement rate counts only comparable decisions', () => {
    const rows = [
      buildTestRow(),
      buildTestRow({ originalUrl: 'https://github.com/owner/repo/pull/20', structural: decidedStructural('runtime', 'security'), llm: decidedLlm('use', 'correctness') }),
      buildTestRow({ originalUrl: 'https://github.com/owner/repo/pull/21', structural: decidedStructural(), llm: undecidedLlm('llm_disabled') }),
    ];
    const report = buildCellReport(rows);
    assert.equal(report.agreement.agree, 1);
    assert.equal(report.agreement.disagree, 1);
    assert.equal(report.agreement.notComparable, 1);
    assert.equal(report.agreement.agreementRate, 0.5);
  });

  it('protects: cross-tabs report coverage separately from reviewer misses', () => {
    const rows = [
      cellRow('wiring', 'correctness', { reviewerRan: true }),
      cellRow('wiring', 'correctness', { correctiveUrl: 'https://github.com/owner/repo/pull/12', reviewerRan: false }),
      cellRow('wiring', 'correctness', { correctiveUrl: 'https://github.com/owner/repo/pull/13', coverageUnavailable: true }),
    ];
    const report = buildCellReport(rows);
    const wiring = report.reviewCrossTabs.find((entry) => entry.layer === 'wiring');
    assert.equal(wiring?.reviewerMisses, 1);
    assert.equal(wiring?.noEvidenceBackedRun, 1);
    assert.equal(wiring?.coverageUnavailable, 1);
  });

  it('protects: a concentrated, well-supported cell earns a targeted-reviewer verdict', () => {
    const rows: CellLabelRowV0[] = [];
    for (let index = 0; index < 6; index++) {
      rows.push(cellRow('wiring', 'correctness', {
        correctiveUrl: `https://github.com/owner/repo/pull/${20 + index}`,
        reviewerRan: true,
      }));
    }
    rows.push(cellRow('runtime', 'correctness', { correctiveUrl: 'https://github.com/owner/repo/pull/40', reviewerRan: true }));
    const report = buildCellReport(rows);
    assert.equal(report.verdict.verdict, 'targeted_reviewer');
    assert.deepEqual(report.verdict.cell, { layer: 'wiring', lens: 'correctness' });
    assert.equal(report.verdict.support, 6);
  });

  it('protects: thin support stays insufficient even when concentrated', () => {
    const rows = [cellRow('wiring', 'correctness', { reviewerRan: true })];
    const report = buildCellReport(rows, { minCellSupport: 5 });
    assert.equal(report.verdict.verdict, 'insufficient_evidence');
  });

  it('protects: adequacy is stated separately from the reviewer recommendation', () => {
    const good = buildCellReport([buildTestRow()]);
    assert.equal(good.adequacy.agreementAdequate, true);
    assert.equal(good.adequacy.adequateForReworkRiskDiagnosis, true);
    const lowAgreement = buildCellReport([
      buildTestRow(),
      buildTestRow({ originalUrl: 'https://github.com/owner/repo/pull/30', structural: decidedStructural('runtime', 'security'), llm: decidedLlm('use', 'correctness') }),
    ]);
    assert.equal(lowAgreement.adequacy.agreementAdequate, false);
    assert.equal(lowAgreement.adequacy.adequateForReworkRiskDiagnosis, false);
    assert.ok(lowAgreement.adequacy.reasons.some((reason) => reason.includes('agreement rate')));
  });

  it('protects: the disagreement sample is deterministic and clamped to 10-15', () => {
    const rows: CellLabelRowV0[] = [];
    for (let index = 0; index < 20; index++) {
      rows.push(buildTestRow({
        originalUrl: `https://github.com/owner/repo/pull/${100 + index}`,
        correctiveUrl: `https://github.com/owner/repo/pull/${200 + index}`,
        structural: decidedStructural('wiring', 'correctness'),
        llm: decidedLlm('runtime', 'security'),
        computedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      }));
    }
    const defaultReport = buildCellReport(rows);
    assert.equal(defaultReport.disagreementSample.length, 12);
    const clampedLow = buildCellReport(rows, { sampleSize: 3 });
    assert.equal(clampedLow.disagreementSample.length, 10);
    const clampedHigh = buildCellReport(rows, { sampleSize: 50 });
    assert.equal(clampedHigh.disagreementSample.length, 15);
    const first = defaultReport.disagreementSample[0]?.labelKey.original_pr_url;
    const rerun = buildCellReport(rows).disagreementSample[0]?.labelKey.original_pr_url;
    assert.equal(first, rerun);
    assert.equal(first, 'https://github.com/owner/repo/pull/100');
  });

  it('protects: an empty corpus produces an empty, insufficient report', () => {
    const report = buildCellReport([], {} as CellReportOptions);
    assert.equal(report.totals.labelled, 0);
    assert.equal(report.totals.unknownShare, 0);
    assert.equal(report.agreement.agreementRate, null);
    assert.equal(report.verdict.verdict, 'insufficient_evidence');
    assert.equal(report.adequacy.adequateForReworkRiskDiagnosis, false);
  });
});