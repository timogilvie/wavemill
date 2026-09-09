import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { SelectedAdjudicatedPair } from '../swap-test/pair-selection.ts';
import type { StoredChallengeComparison } from '../challenge-comparison.ts';
import type { ArbiterSurvivalLabelV1 } from '../arbiter-survival-label.ts';
import { computeSurvivalAgreement, renderSurvivalReportMarkdown } from './survival-agreement.ts';

const makePair = (id: string, winner: 'primary' | 'challenger'): SelectedAdjudicatedPair => {
  const record: StoredChallengeComparison = {
    challengePairId: id,
    primaryPrUrl: `https://github.com/owner/repo/pull/${parseInt(id) * 2}`,
    challengerPrUrl: `https://github.com/owner/repo/pull/${parseInt(id) * 2 + 1}`,
    winner,
    timestamp: '2026-01-01T00:00:00Z',
    dimensions: { planning: { primary: 0.8, challenger: 0.6 } },
    rationale: 'test',
    variedDimensions: {},
    challengeType: undefined,
  };
  return { pairId: id, record };
};

const makeSurvivalLabel = (
  prUrl: string,
  reportOutcome: 'survived' | 'followup' | 'substantially_rewritten' | 'reverted' | null,
  reasonCodes: string[] = [],
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
      followup: reportOutcome === 'followup',
      undone_by: null,
      report_outcome: reportOutcome,
      reason_codes: reasonCodes.length > 0 ? reasonCodes : [],
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

describe('survival-agreement', () => {
  describe('computeSurvivalAgreement', () => {
    it('marks winner-survived pairs as analyzed agreement', () => {
      const pair = makePair('1', 'primary');
      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, 'survived')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      assert.strictEqual(summary.analyzed, 1);
      assert.strictEqual(summary.overall.keptPrSurvivors, 1);
      assert(summary.overall.cell.rate === 1.0);
      assert.strictEqual(summary.rows[0].classification, 'analyzed');
      assert.strictEqual(summary.rows[0].keptPrSurvived, true);
    });

    it('marks winner-reworked pairs as analyzed disagreement', () => {
      const pair = makePair('2', 'primary');
      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, 'reverted')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      assert.strictEqual(summary.analyzed, 1);
      assert.strictEqual(summary.overall.keptPrSurvivors, 0);
      assert(summary.overall.cell.rate === 0.0);
      assert.strictEqual(summary.rows[0].keptPrSurvived, false);
    });

    it('excludes pairs with no label', () => {
      const pair = makePair('3', 'primary');
      const labels = new Map(); // Empty

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      assert.strictEqual(summary.analyzed, 0);
      assert.strictEqual(summary.excluded.noLabel, 1);
      assert.strictEqual(summary.rows[0].classification, 'excluded_no_label');
    });

    it('excludes pairs with missing horizon (too recent)', () => {
      const pair = makePair('4', 'primary');
      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, null, ['missing_horizon'])]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      assert.strictEqual(summary.analyzed, 0);
      assert.strictEqual(summary.excluded.missingHorizon, 1);
      assert.strictEqual(summary.rows[0].classification, 'excluded_missing_horizon');
    });

    it('excludes pairs with unmerged winner', () => {
      const pair = makePair('5', 'primary');
      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, null, ['unmerged_pr'])]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      assert.strictEqual(summary.analyzed, 0);
      assert.strictEqual(summary.excluded.keptPrUnmerged, 1);
      assert.strictEqual(summary.rows[0].classification, 'excluded_kept_pr_unmerged');
    });

    it('counts diverse rework outcomes as disagreement', () => {
      const pairs = [
        makePair('6', 'primary'),
        makePair('7', 'primary'),
        makePair('8', 'primary'),
      ];

      const labels = new Map([
        [
          pairs[0].record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pairs[0].record.primaryPrUrl, 'followup')]]),
        ],
        [
          pairs[1].record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pairs[1].record.primaryPrUrl, 'substantially_rewritten')]]),
        ],
        [
          pairs[2].record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pairs[2].record.primaryPrUrl, 'reverted')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs, survivalLabels: labels });

      assert.strictEqual(summary.analyzed, 3);
      assert.strictEqual(summary.overall.keptPrSurvivors, 0);
      assert(summary.overall.cell.rate === 0.0);
    });

    it('stratifies by challenge type', () => {
      const pair1 = makePair('9', 'primary');
      pair1.record.challengeType = 'planner-only';

      const pair2 = makePair('10', 'challenger');
      pair2.record.challengeType = 'coder-only';

      const labels = new Map([
        [
          pair1.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair1.record.primaryPrUrl, 'survived')]]),
        ],
        [
          pair2.record.challengerPrUrl,
          new Map([[30, makeSurvivalLabel(pair2.record.challengerPrUrl, 'survived')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair1, pair2], survivalLabels: labels });

      assert(summary.byChallengeType['planner-only']);
      assert.strictEqual(summary.byChallengeType['planner-only'].n, 1);
      assert.strictEqual(summary.byChallengeType['planner-only'].successes, 1);
      assert(summary.byChallengeType['coder-only']);
    });

    it('includes loser-side diagnostic outcome', () => {
      const pair = makePair('11', 'primary');
      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, 'survived')]]),
        ],
        [
          pair.record.challengerPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.challengerPrUrl, 'reverted')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      const row = summary.rows[0];
      assert.strictEqual(row.keptPrOutcome, 'survived');
      assert.strictEqual(row.loserPrOutcome, 'reverted');
      assert.strictEqual(row.loserPrSurvived, false);
    });

    it('handles empty pair set', () => {
      const summary = computeSurvivalAgreement({
        pairs: [],
        survivalLabels: new Map(),
      });

      assert.strictEqual(summary.population, 0);
      assert.strictEqual(summary.analyzed, 0);
    });

    it('marks unrecoverable challenge type as excludedFromStratifiedAnalysis', () => {
      const pair = makePair('12', 'primary');
      pair.record.challengeType = 'unrecoverable';

      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, 'survived')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });

      assert.strictEqual(summary.rows[0].excludedFromStratifiedAnalysis, true);
    });
  });

  describe('renderSurvivalReportMarkdown', () => {
    it('renders basic markdown report', () => {
      const pair = makePair('13', 'primary');
      const labels = new Map([
        [
          pair.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair.record.primaryPrUrl, 'survived')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair], survivalLabels: labels });
      const markdown = renderSurvivalReportMarkdown(summary);

      assert(markdown.includes('Arbiter Probe B'));
      assert(markdown.includes('Overall'));
      assert(markdown.includes('100.0%'));
      assert(markdown.includes('| 1 | 1 | 0 |'));
    });

    it('renders exclusion counts when present', () => {
      const pairs = [makePair('14', 'primary'), makePair('15', 'primary')];
      const labels = new Map([
        [
          pairs[0].record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pairs[0].record.primaryPrUrl, 'survived')]]),
        ],
        // pairs[1] has no label
      ]);

      const summary = computeSurvivalAgreement({ pairs, survivalLabels: labels });
      const markdown = renderSurvivalReportMarkdown(summary);

      assert(markdown.includes('Exclusions'));
      assert(markdown.includes('No label available: 1'));
    });

    it('renders stratified tables when data present', () => {
      const pair1 = makePair('16', 'primary');
      pair1.record.challengeType = 'planner-only';

      const labels = new Map([
        [
          pair1.record.primaryPrUrl,
          new Map([[30, makeSurvivalLabel(pair1.record.primaryPrUrl, 'survived')]]),
        ],
      ]);

      const summary = computeSurvivalAgreement({ pairs: [pair1], survivalLabels: labels });
      const markdown = renderSurvivalReportMarkdown(summary);

      assert(markdown.includes('By Challenge Type'));
      assert(markdown.includes('planner-only'));
    });
  });
});
