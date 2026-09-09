import type { SelectedAdjudicatedPair } from '../swap-test/pair-selection.ts';
import type { ProportionInterval } from '../stats-utils.ts';
import { wilsonInterval } from '../stats-utils.ts';
import type { HorizonDays, ReportOutcome } from '../arbiter-survival-label.ts';
import type { ArbiterSurvivalLabelV1, MISSING_REASON_CODES } from '../arbiter-survival-label.ts';
import { deriveChallengeType, deriveDifficultyBucket } from '../swap-test/strata.ts';
import { createCell, groupSuccessCells } from './strata-cells.ts';
import type { SuccessCell } from './strata-cells.ts';

/**
 * Classification of a pair in survival agreement analysis.
 */
export type SurvivalAgreementClassification =
  | 'analyzed'
  | 'excluded_no_label'
  | 'excluded_missing_horizon'
  | 'excluded_kept_pr_unmerged'
  | 'excluded_missing_eval_record';

/**
 * One pair's survival agreement result.
 */
export interface SurvivalAgreementRow {
  pairId: string;
  classification: SurvivalAgreementClassification;
  winner: 'primary' | 'challenger';
  keptPrUrl?: string;
  keptPrSurvived?: boolean;
  loserPrUrl?: string;
  loserPrSurvived?: boolean;
  keptPrOutcome?: ReportOutcome;
  loserPrOutcome?: ReportOutcome;
  challengeType: string;
  difficultyBucket: string;
  difficultyCollapsed: string;
  excludedFromStratifiedAnalysis?: boolean;
}

/**
 * Stratified summary of survival agreement analysis.
 */
export interface SurvivalAgreementSummary {
  population: number;
  analyzed: number;
  excluded: {
    noLabel: number;
    missingHorizon: number;
    keptPrUnmerged: number;
    missingEvalRecord: number;
  };
  overall: {
    cell: SuccessCell;
    keptPrSurvivors: number;
  };
  byChallengeType: Record<string, SuccessCell>;
  byDifficultyBucket: Record<string, SuccessCell>;
  byDifficultyCollapsed: Record<string, SuccessCell>;
  rows: SurvivalAgreementRow[];
}

/**
 * Determine if a pair should be analyzed based on kept-side survival label.
 */
function classifyPair(
  pair: SelectedAdjudicatedPair,
  keptLabel: ArbiterSurvivalLabelV1 | undefined,
): { classification: SurvivalAgreementClassification; shouldAnalyze: boolean } {
  if (!keptLabel) {
    return { classification: 'excluded_no_label', shouldAnalyze: false };
  }

  if (keptLabel.outcome.report_outcome === null) {
    const missingReason = keptLabel.outcome.reason_codes[0] as typeof MISSING_REASON_CODES[number];
    if (missingReason === 'unmerged_pr') {
      return { classification: 'excluded_kept_pr_unmerged', shouldAnalyze: false };
    }
    return { classification: 'excluded_missing_horizon', shouldAnalyze: false };
  }

  return { classification: 'analyzed', shouldAnalyze: true };
}

/**
 * Judge is "right" iff the kept side survived.
 */
function keptSideSurvived(outcome: ReportOutcome): boolean {
  return outcome === 'survived';
}

/**
 * Compute survival agreement: does the judge's verdict match whether the kept side survived?
 */
export function computeSurvivalAgreement(options: {
  pairs: SelectedAdjudicatedPair[];
  survivalLabels: Map<string, Map<HorizonDays, ArbiterSurvivalLabelV1>>;
  evalIndex?: Map<string, { record: any; provenance: string }>;
  horizon?: HorizonDays;
}): SurvivalAgreementSummary {
  const { pairs, survivalLabels, horizon = 30 } = options;

  const rows: SurvivalAgreementRow[] = [];
  const excluded = {
    noLabel: 0,
    missingHorizon: 0,
    keptPrUnmerged: 0,
    missingEvalRecord: 0,
  };

  for (const pair of pairs) {
    const keptPrUrl = pair.record.winner === 'primary'
      ? pair.record.primaryPrUrl
      : pair.record.challengerPrUrl;
    const loserPrUrl = pair.record.winner === 'primary'
      ? pair.record.challengerPrUrl
      : pair.record.primaryPrUrl;

    const keptLabel = survivalLabels.get(keptPrUrl)?.get(horizon);
    const { classification, shouldAnalyze } = classifyPair(pair, keptLabel);

    if (classification === 'excluded_no_label') excluded.noLabel++;
    if (classification === 'excluded_missing_horizon') excluded.missingHorizon++;
    if (classification === 'excluded_kept_pr_unmerged') excluded.keptPrUnmerged++;

    const row: SurvivalAgreementRow = {
      pairId: pair.pairId,
      classification,
      winner: pair.record.winner,
      keptPrUrl,
      loserPrUrl,
      keptPrOutcome: keptLabel?.outcome.report_outcome,
      challengeType: deriveChallengeType(pair.record).type,
      difficultyBucket: String(deriveDifficultyBucket(pair.record).bucket),
      difficultyCollapsed: deriveDifficultyBucket(pair.record).collapsed,
    };

    // Add loser-side outcome for diagnostic context (when loser merged).
    if (loserPrUrl) {
      const loserLabel = survivalLabels.get(loserPrUrl)?.get(horizon);
      row.loserPrOutcome = loserLabel?.outcome.report_outcome;
      row.loserPrSurvived = loserLabel?.outcome.report_outcome === 'survived';
    }

    // Mark unrecoverable challenge type.
    if (row.challengeType === 'unrecoverable') {
      row.excludedFromStratifiedAnalysis = true;
    }

    rows.push(row);
  }

  // Filter analyzed pairs for metric calculation.
  const analyzedRows = rows.filter((row) => row.classification === 'analyzed');

  // Compute agreement: judge is right iff kept side survived.
  const agreements = analyzedRows.filter((row) => {
    const kept = row.keptPrOutcome === 'survived';
    row.keptPrSurvived = kept;
    return kept;
  });

  const overallCell = createCell(agreements.length, analyzedRows.length);

  // Stratify by challenge type, difficulty bucket, and collapsed difficulty.
  const byType = groupSuccessCells(
    analyzedRows,
    (row) => row.challengeType,
    (row) => row.keptPrSurvived === true,
  );

  const byBucket = groupSuccessCells(
    analyzedRows,
    (row) => row.difficultyBucket,
    (row) => row.keptPrSurvived === true,
  );

  const byCollapsed = groupSuccessCells(
    analyzedRows,
    (row) => row.difficultyCollapsed,
    (row) => row.keptPrSurvived === true,
  );

  return {
    population: pairs.length,
    analyzed: analyzedRows.length,
    excluded,
    overall: {
      cell: overallCell,
      keptPrSurvivors: agreements.length,
    },
    byChallengeType: byType,
    byDifficultyBucket: byBucket,
    byDifficultyCollapsed: byCollapsed,
    rows,
  };
}

/**
 * Render survival agreement summary as markdown report.
 */
export function renderSurvivalReportMarkdown(summary: SurvivalAgreementSummary): string {
  const lines: string[] = [];

  lines.push('# Arbiter Probe B — Judge vs kept-side survival (30-day)');
  lines.push('');

  // Overall
  lines.push('## Overall');
  lines.push('');
  lines.push('| Population | Analyzed | Excluded | Agreement Rate | 95% CI |');
  lines.push('|---:|---:|---:|---:|---:|');

  const totalExcluded = summary.excluded.noLabel
    + summary.excluded.missingHorizon
    + summary.excluded.keptPrUnmerged
    + summary.excluded.missingEvalRecord;

  const rateStr = summary.overall.cell.rate === null
    ? 'n/a'
    : `${(summary.overall.cell.rate * 100).toFixed(1)}%`;
  const ciStr = summary.overall.cell.rate === null
    ? 'n/a'
    : `${(summary.overall.cell.ci95.lo! * 100).toFixed(1)}% - ${(summary.overall.cell.ci95.hi! * 100).toFixed(1)}%`;

  lines.push(`| ${summary.population} | ${summary.analyzed} | ${totalExcluded} | ${rateStr} | ${ciStr} |`);
  lines.push('');

  // Exclusions
  if (totalExcluded > 0) {
    lines.push('## Exclusions');
    lines.push('');
    if (summary.excluded.noLabel > 0) {
      lines.push(`- No label available: ${summary.excluded.noLabel}`);
    }
    if (summary.excluded.missingHorizon > 0) {
      lines.push(`- Missing horizon (too recent, unmerged, etc.): ${summary.excluded.missingHorizon}`);
    }
    if (summary.excluded.keptPrUnmerged > 0) {
      lines.push(`- Kept side (winner) unmerged: ${summary.excluded.keptPrUnmerged}`);
    }
    if (summary.excluded.missingEvalRecord > 0) {
      lines.push(`- Missing eval record: ${summary.excluded.missingEvalRecord}`);
    }
    lines.push('');
  }

  // By Challenge Type
  if (Object.keys(summary.byChallengeType).length > 0) {
    lines.push('## By Challenge Type');
    lines.push('');
    lines.push('| Challenge Type | n | Survived | Rate | 95% CI |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [type, cell] of Object.entries(summary.byChallengeType)) {
      const rate = cell.rate === null ? 'n/a' : `${(cell.rate * 100).toFixed(1)}%`;
      const ci = cell.rate === null
        ? 'n/a'
        : `${(cell.ci95.lo! * 100).toFixed(1)}% - ${(cell.ci95.hi! * 100).toFixed(1)}%`;
      lines.push(`| ${type} | ${cell.n} | ${cell.successes} | ${rate} | ${ci} |`);
    }
    lines.push('');
  }

  // By Difficulty Bucket
  if (Object.keys(summary.byDifficultyBucket).length > 0) {
    lines.push('## By Difficulty Bucket');
    lines.push('');
    lines.push('| Bucket | n | Survived | Rate | 95% CI |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [bucket, cell] of Object.entries(summary.byDifficultyBucket)) {
      const rate = cell.rate === null ? 'n/a' : `${(cell.rate * 100).toFixed(1)}%`;
      const ci = cell.rate === null
        ? 'n/a'
        : `${(cell.ci95.lo! * 100).toFixed(1)}% - ${(cell.ci95.hi! * 100).toFixed(1)}%`;
      lines.push(`| ${bucket} | ${cell.n} | ${cell.successes} | ${rate} | ${ci} |`);
    }
    lines.push('');
  }

  // By Difficulty Collapsed
  if (Object.keys(summary.byDifficultyCollapsed).length > 0) {
    lines.push('## By Difficulty Collapsed');
    lines.push('');
    lines.push('| Difficulty | n | Survived | Rate | 95% CI |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [collapsed, cell] of Object.entries(summary.byDifficultyCollapsed)) {
      const rate = cell.rate === null ? 'n/a' : `${(cell.rate * 100).toFixed(1)}%`;
      const ci = cell.rate === null
        ? 'n/a'
        : `${(cell.ci95.lo! * 100).toFixed(1)}% - ${(cell.ci95.hi! * 100).toFixed(1)}%`;
      lines.push(`| ${collapsed} | ${cell.n} | ${cell.successes} | ${rate} | ${ci} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
