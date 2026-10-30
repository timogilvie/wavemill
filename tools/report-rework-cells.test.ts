import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CELL_LABEL_SCHEMA_VERSION,
  type ReworkCellLabelV1,
} from '../shared/lib/rework-cell-label.ts';
import {
  formatReportText,
  generateReworkCellReport,
} from '../shared/lib/rework-cell-report.ts';
import { processCorrectivePair, type CorrectivePairInput } from './backfill-rework-cells.ts';

function buildLabel(id: number, overrides: Partial<ReworkCellLabelV1> = {}): ReworkCellLabelV1 {
  return {
    schema_version: CELL_LABEL_SCHEMA_VERSION,
    source_rework_label: {
      version: 'cr-0.1.0',
      rework_id: `cr:${id}:${id + 1}`,
    },
    original_pr: {
      number: id,
      url: `https://github.com/hokusai/wavemill/pull/${id}`,
      head_sha: 'a'.repeat(40),
      merge_commit_sha: 'b'.repeat(40),
      title: `PR ${id}`,
    },
    corrective_pr: {
      number: id + 1,
      url: `https://github.com/hokusai/wavemill/pull/${id + 1}`,
      head_sha: 'c'.repeat(40),
      merge_commit_sha: 'd'.repeat(40),
      title: `Fix for PR ${id}`,
    },
    chosen: {
      layer: 'wiring',
      lens: 'correctness',
      cell: 'wiring:correctness',
    },
    structural: {
      layer: 'wiring',
      lens: 'correctness',
      cell: 'wiring:correctness',
      confidence: 'high',
      matched_rules: ['path:wiring'],
    },
    llm: {
      layer: 'wiring',
      lens: 'correctness',
      cell: 'wiring:correctness',
      explanation: 'Matched wiring',
    },
    agreement: true,
    disagreement_state: 'agree',
    reason_codes: ['clean_agreement', 'llm_concurrence'],
    review_evidence: {
      reviewers_run: ['claude-3-7-sonnet'],
      challenge_stages: ['review'],
      provenance: 'direct',
      coverage_flags: ['review_artifact_direct'],
    },
    envelope: {
      schema_version: CELL_LABEL_SCHEMA_VERSION,
      labeller_version: '0.1.0',
      rules_version: '0.1.0',
      prompt_version: '0.1.0',
      model: 'claude-3-7-sonnet',
      diff_hash: 'e'.repeat(64),
      computed_at: '2026-10-31T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('rework-cell-report aggregator', () => {
  // protects: row, column, and cell distributions miscalculating proportions
  it('computes layer, lens, and cell distributions with correct percentages', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(1, { chosen: { layer: 'wiring', lens: 'correctness', cell: 'wiring:correctness' } }),
      buildLabel(2, { chosen: { layer: 'wiring', lens: 'correctness', cell: 'wiring:correctness' } }),
      buildLabel(3, { chosen: { layer: 'runtime', lens: 'reversibility', cell: 'runtime:reversibility' } }),
      buildLabel(4, { chosen: { layer: 'form', lens: 'correctness', cell: 'form:correctness' } }),
    ];

    const report = generateReworkCellReport(labels);
    assert.equal(report.total_records, 4);
    assert.equal(report.deduplicated_records, 4);
    assert.equal(report.row_distribution.wiring.count, 2);
    assert.equal(report.row_distribution.wiring.percentage, 50.0);
    assert.equal(report.row_distribution.runtime.count, 1);
    assert.equal(report.row_distribution.runtime.percentage, 25.0);
    assert.equal(report.column_distribution.correctness.count, 3);
    assert.equal(report.column_distribution.correctness.percentage, 75.0);
    assert.equal(report.column_distribution.reversibility.count, 1);
    assert.equal(report.column_distribution.reversibility.percentage, 25.0);
  });

  // protects: unknown share miscounting rows where either layer or lens is unknown
  it('computes unknown share across layer, lens, and cell levels', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(1, { chosen: { layer: 'wiring', lens: 'correctness', cell: 'wiring:correctness' } }),
      buildLabel(2, { chosen: { layer: 'unknown', lens: 'correctness', cell: 'unknown' } }),
      buildLabel(3, { chosen: { layer: 'runtime', lens: 'unknown', cell: 'unknown' } }),
      buildLabel(4, { chosen: { layer: 'unknown', lens: 'unknown', cell: 'unknown' } }),
    ];

    const report = generateReworkCellReport(labels);
    assert.equal(report.unknown_share.total_unknown, 3);
    assert.equal(report.unknown_share.percentage, 75.0);
    assert.equal(report.unknown_share.layer_unknown, 2);
    assert.equal(report.unknown_share.lens_unknown, 2);
  });

  // protects: structural vs LLM agreement rate metrics calculation errors
  it('computes agreement rates and disagreement state breakdowns accurately', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(1, { agreement: true, disagreement_state: 'agree' }),
      buildLabel(2, { agreement: true, disagreement_state: 'agree' }),
      buildLabel(3, { agreement: true, disagreement_state: 'agree' }),
      buildLabel(4, { agreement: false, disagreement_state: 'disagree' }),
      buildLabel(5, { agreement: false, disagreement_state: 'structural_only', llm: null }),
    ];

    const report = generateReworkCellReport(labels);
    // Evaluated by both: labels 1..4
    assert.equal(report.agreement_metrics.evaluated_by_both, 4);
    assert.equal(report.agreement_metrics.agreements, 3);
    assert.equal(report.agreement_metrics.disagreements, 1);
    assert.equal(report.agreement_metrics.agreement_rate, 75.0);
    assert.equal(report.agreement_metrics.disagreement_rate, 25.0);
    assert.equal(report.agreement_metrics.by_state.agree, 3);
    assert.equal(report.agreement_metrics.by_state.disagree, 1);
    assert.equal(report.agreement_metrics.by_state.structural_only, 1);
  });

  // protects: reviewer cross-tabs failing to track coverage provenance and reviewer assignments
  it('cross-tabulates by reviewer and calculates evidence coverage rate', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(1, {
        review_evidence: {
          reviewers_run: ['claude-3-7-sonnet'],
          challenge_stages: [],
          provenance: 'direct',
          coverage_flags: [],
        },
      }),
      buildLabel(2, {
        review_evidence: {
          reviewers_run: ['claude-3-7-sonnet'],
          challenge_stages: [],
          provenance: 'archived',
          coverage_flags: [],
        },
      }),
      buildLabel(3, {
        review_evidence: {
          reviewers_run: ['deepseek-r1'],
          challenge_stages: [],
          provenance: 'direct',
          coverage_flags: [],
        },
      }),
      buildLabel(4, {
        review_evidence: {
          reviewers_run: [],
          challenge_stages: [],
          provenance: 'unavailable',
          coverage_flags: ['missing_review_artifact'],
        },
      }),
    ];

    const report = generateReworkCellReport(labels);
    assert.equal(report.reviewer_cross_tabs.evidence_coverage.direct, 2);
    assert.equal(report.reviewer_cross_tabs.evidence_coverage.archived, 1);
    assert.equal(report.reviewer_cross_tabs.evidence_coverage.unavailable, 1);
    // (2 direct + 1 archived) / 4 = 75.0%
    assert.equal(report.reviewer_cross_tabs.evidence_coverage.coverage_rate, 75.0);
    assert.equal(report.reviewer_cross_tabs.by_reviewer['claude-3-7-sonnet']['wiring:correctness'], 2);
    assert.equal(report.reviewer_cross_tabs.by_reviewer['deepseek-r1']['wiring:correctness'], 1);
    assert.equal(report.reviewer_cross_tabs.by_reviewer['unattributed']['wiring:correctness'], 1);
  });

  // protects: disagreement sampling being non-deterministic or exceeding sample-size
  it('selects deterministic disagreement sample sorted by natural key', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(30, {
        disagreement_state: 'disagree',
        source_rework_label: { version: 'cr-0.1.0', rework_id: 'cr:30:31' },
      }),
      buildLabel(10, {
        disagreement_state: 'disagree',
        source_rework_label: { version: 'cr-0.1.0', rework_id: 'cr:10:11' },
      }),
      buildLabel(20, {
        disagreement_state: 'disagree',
        source_rework_label: { version: 'cr-0.1.0', rework_id: 'cr:20:21' },
      }),
    ];

    const report = generateReworkCellReport(labels, { sampleSize: 2 });
    assert.equal(report.disagreement_sample.length, 2);
    assert.equal(report.disagreement_sample[0].natural_key, 'cr:10:11');
    assert.equal(report.disagreement_sample[1].natural_key, 'cr:20:21');
  });

  // protects: premature recommendation when defect evidence is too sparse
  it('verdict reports insufficient evidence when sample size is below threshold', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(1, { chosen: { layer: 'wiring', lens: 'correctness', cell: 'wiring:correctness' } }),
      buildLabel(2, { chosen: { layer: 'wiring', lens: 'correctness', cell: 'wiring:correctness' } }),
    ];

    const report = generateReworkCellReport(labels);
    assert.equal(report.verdict.targeted_reviewer.recommended, false);
    assert.match(report.verdict.targeted_reviewer.statement, /Insufficient evidence/);
  });

  // protects: failure to recommend targeted reviewer when concentrated misses are present
  it('verdict recommends targeted reviewer when misses are concentrated with sufficient support', () => {
    const labels: ReworkCellLabelV1[] = [];
    // 6 wiring misses (>= 5 and >= 25% of total)
    for (let i = 1; i <= 6; i++) {
      labels.push(buildLabel(i, {
        chosen: { layer: 'wiring', lens: 'correctness', cell: 'wiring:correctness' },
      }));
    }
    // 2 runtime misses
    labels.push(buildLabel(7, { chosen: { layer: 'runtime', lens: 'correctness', cell: 'runtime:correctness' } }));
    labels.push(buildLabel(8, { chosen: { layer: 'runtime', lens: 'correctness', cell: 'runtime:correctness' } }));

    const report = generateReworkCellReport(labels);
    assert.equal(report.verdict.targeted_reviewer.recommended, true);
    assert.equal(report.verdict.targeted_reviewer.target_layer, 'wiring');
    assert.match(report.verdict.targeted_reviewer.statement, /Recommend targeted reviewer for wiring/);
  });

  // protects: declaring cell label ready when agreement is too low or unknown rate too high
  it('verdict distinguishes between ready vs unready adoption status', () => {
    // Unready due to high unknown rate
    const unreadyLabels: ReworkCellLabelV1[] = [];
    for (let i = 1; i <= 3; i++) {
      unreadyLabels.push(buildLabel(i));
    }
    for (let i = 4; i <= 10; i++) {
      unreadyLabels.push(buildLabel(i, {
        chosen: { layer: 'unknown', lens: 'unknown', cell: 'unknown' },
      }));
    }
    const unreadyReport = generateReworkCellReport(unreadyLabels);
    assert.equal(unreadyReport.verdict.adoption_readiness.ready_for_diagnosis, false);
    assert.match(unreadyReport.verdict.adoption_readiness.statement, /not yet reliable enough/);

    // Ready with high agreement and low unknown rate
    const readyLabels: ReworkCellLabelV1[] = [];
    for (let i = 1; i <= 8; i++) {
      readyLabels.push(buildLabel(i, { agreement: true, disagreement_state: 'agree' }));
    }
    readyLabels.push(buildLabel(9, { agreement: false, disagreement_state: 'disagree' }));
    readyLabels.push(buildLabel(10, {
      chosen: { layer: 'unknown', lens: 'unknown', cell: 'unknown' },
    }));
    const readyReport = generateReworkCellReport(readyLabels);
    assert.equal(readyReport.verdict.adoption_readiness.ready_for_diagnosis, true);
    assert.match(readyReport.verdict.adoption_readiness.statement, /reliable enough for Rework Risk diagnosis/);
  });

  // protects: report text formatting dropping sections or crashing
  it('formats human-readable report with all required sections', () => {
    const labels: ReworkCellLabelV1[] = [
      buildLabel(1),
      buildLabel(2, { disagreement_state: 'disagree' }),
    ];

    const report = generateReworkCellReport(labels);
    const text = formatReportText(report);

    assert.match(text, /Distribution by Review Layer/);
    assert.match(text, /Distribution by Review Lens/);
    assert.match(text, /Cell Matrix/);
    assert.match(text, /Unknown Share and Classifier Agreement/);
    assert.match(text, /Reviewer and Challenge Stage Evidence Coverage/);
    assert.match(text, /Disagreement Review Sample/);
    assert.match(text, /Experiment Verdict/);
  });
});

describe('backfill-rework-cells processing', () => {
  // protects: backfill processing crashing or generating invalid schema rows
  it('processes corrective pair input into valid schema record in temp dir', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'backfill-test-'));
    try {
      const pair: CorrectivePairInput = {
        version: 'cr-0.1.0',
        rework_id: 'cr:500:501',
        original_pr: {
          number: 500,
          url: 'https://github.com/hokusai/wavemill/pull/500',
          head_sha: 'a'.repeat(40),
          title: 'Original feature',
        },
        corrective_pr: {
          number: 501,
          url: 'https://github.com/hokusai/wavemill/pull/501',
          head_sha: 'b'.repeat(40),
          title: 'Fix null pointer exception',
        },
        diff: 'diff --git a/src/app.ts b/src/app.ts\n-if (x.val)\n+if (x?.val)',
      };

      const record = await processCorrectivePair(pair, {
        repoDir: tmp,
        offline: true,
      });

      assert.equal(record.schema_version, '0.1.0');
      assert.equal(record.source_rework_label.rework_id, 'cr:500:501');
      assert.equal(record.chosen.layer, 'local_meaning');
      assert.equal(record.chosen.lens, 'correctness');
      assert.equal(record.disagreement_state, 'structural_only');
      assert.ok(record.reason_codes.includes('llm_skipped_offline'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
