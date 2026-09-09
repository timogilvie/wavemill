import type { SelectedAdjudicatedPair } from '../swap-test/pair-selection.ts';
import { selectChallengeEvalScore } from '../challenge-score-selector.ts';
import { deriveChallengeType, deriveDifficultyBucket, lookupPairEvals } from '../swap-test/strata.ts';
import { createCell, groupSuccessCells } from './strata-cells.ts';
import type { SuccessCell } from './strata-cells.ts';

/**
 * Closeness of eval scores (used to characterize disagreements).
 */
export type EvalCloseness = 'lt_005' | 'lt_015' | 'lt_030' | 'gte_030';

/**
 * Classification of a pair in eval disagreement analysis.
 */
export type EvalDisagreementClassification =
  | 'analyzed'
  | 'eval_tie'
  | 'excluded_missing_eval_primary'
  | 'excluded_missing_eval_challenger'
  | 'excluded_score_fallback';

/**
 * One pair's eval disagreement result.
 */
export interface EvalDisagreementRow {
  pairId: string;
  classification: EvalDisagreementClassification;
  comparisonWinner: 'primary' | 'challenger';
  evalImpliedWinner?: 'primary' | 'challenger' | 'tie';
  evalDelta?: number; // |primary_score - challenger_score|
  evalCloseness?: EvalCloseness;
  agrees?: boolean;
  comparisonMargin?: number;
  scorePrimarySource?: string;
  scoreChallengerSource?: string;
  primaryScoreFallback?: boolean;
  challengerScoreFallback?: boolean;
  challengeType: string;
  difficultyBucket: string;
  difficultyCollapsed: string;
  excludedFromStratifiedAnalysis?: boolean;
}

/**
 * Stratified summary of eval disagreement analysis.
 */
export interface EvalDisagreementSummary {
  population: number;
  analyzed: number;
  excluded: {
    missingEvalPrimary: number;
    missingEvalChallenger: number;
    scoreFallback: number;
  };
  ties: number;
  fallback: {
    scoreFallback: number;
    disagreements: number;
    disagreementCell: SuccessCell;
  };
  overall: {
    disagreementCell: SuccessCell;
    disagreements: number;
    agreements: number;
  };
  marginClosenessTable: Record<string, Record<string, number>>;
  byChallengeType: Record<string, SuccessCell>;
  byDifficultyBucket: Record<string, SuccessCell>;
  byDifficultyCollapsed: Record<string, SuccessCell>;
  disagreementsByMarginCloseness: {
    margin: Record<string, number>; // abs-margin distribution
    medianMargin: number | null;
    closeness: Record<EvalCloseness, number>;
  };
  rows: EvalDisagreementRow[];
}

/**
 * Classify closeness of eval scores.
 */
function classifyCloseness(delta: number): EvalCloseness {
  if (delta < 0.05) return 'lt_005';
  if (delta < 0.15) return 'lt_015';
  if (delta < 0.30) return 'lt_030';
  return 'gte_030';
}

/**
 * Compute margin (sum of dimension differences).
 */
function computeMargin(record: any): number | undefined {
  if (!record?.dimensions) return undefined;
  return Object.values(record.dimensions).reduce(
    (sum, value: any) => sum + (value.primary - value.challenger),
    0,
  );
}

function classifyMargin(margin: number | undefined): string {
  if (margin === undefined) return 'unknown';
  return String(Math.round(Math.abs(margin)));
}

/**
 * Compute eval disagreement: characterise where comparison judge and eval judge differ.
 */
export function computeEvalDisagreement(options: {
  pairs: SelectedAdjudicatedPair[];
  evalIndex: Map<string, { record: any; provenance: string }>;
}): EvalDisagreementSummary {
  const { pairs, evalIndex } = options;

  const rows: EvalDisagreementRow[] = [];
  const excluded = {
    missingEvalPrimary: 0,
    missingEvalChallenger: 0,
    scoreFallback: 0,
  };

  let tieCount = 0;
  const disagreeRows: EvalDisagreementRow[] = [];
  const marginClosenessTable: Record<string, Record<string, number>> = {};
  const marginValues: number[] = [];
  const marginDistribution: Record<string, number> = {};
  const closenessDistribution: Record<EvalCloseness, number> = {
    lt_005: 0,
    lt_015: 0,
    lt_030: 0,
    gte_030: 0,
  };

  for (const pair of pairs) {
    const evalLookup = lookupPairEvals(evalIndex, pair.record);

    const primaryEval = evalLookup.primary;
    const challengerEval = evalLookup.challenger;

    // Classify missing eval records.
    let classification: EvalDisagreementClassification = 'analyzed';
    if (!primaryEval) {
      excluded.missingEvalPrimary++;
      classification = 'excluded_missing_eval_primary';
    }
    if (!challengerEval) {
      excluded.missingEvalChallenger++;
      classification = 'excluded_missing_eval_challenger';
    }

    // Skip if either side is missing eval entirely.
    if (classification !== 'analyzed') {
      const row: EvalDisagreementRow = {
        pairId: pair.pairId,
        classification,
        comparisonWinner: pair.record.winner,
        challengeType: deriveChallengeType(pair.record).type,
        difficultyBucket: String(deriveDifficultyBucket(pair.record).bucket),
        difficultyCollapsed: deriveDifficultyBucket(pair.record).collapsed,
      };
      rows.push(row);
      continue;
    }

    // Select scores (stage-specific or overall, with fallback warning).
    const challengeTypeObj = deriveChallengeType(pair.record);
    const primaryScoreSelection = selectChallengeEvalScore(primaryEval, challengeTypeObj.type);
    const challengerScoreSelection = selectChallengeEvalScore(challengerEval, challengeTypeObj.type);

    const primaryScore = primaryScoreSelection.score;
    const challengerScore = challengerScoreSelection.score;

    // Compute eval-implied winner.
    const scoreDelta = Math.abs(primaryScore - challengerScore);
    const eps = 1e-6;
    let evalImpliedWinner: 'primary' | 'challenger' | 'tie';
    if (Math.abs(scoreDelta) < eps) {
      evalImpliedWinner = 'tie';
      tieCount++;
    } else {
      evalImpliedWinner = primaryScore > challengerScore ? 'primary' : 'challenger';
    }

    // Classify score fallback (when stage-specific score unavailable).
    const hasFallback = Boolean(primaryScoreSelection.warning || challengerScoreSelection.warning);
    if (hasFallback) {
      excluded.scoreFallback++;
    }

    // Compute agreement.
    const agrees = evalImpliedWinner === 'tie'
      ? undefined
      : pair.record.winner === evalImpliedWinner;
    const comparisonMargin = computeMargin(pair.record);
    const evalCloseness = classifyCloseness(scoreDelta);

    const row: EvalDisagreementRow = {
      pairId: pair.pairId,
      classification: evalImpliedWinner === 'tie'
        ? 'eval_tie'
        : hasFallback
          ? 'excluded_score_fallback'
          : 'analyzed',
      comparisonWinner: pair.record.winner,
      evalImpliedWinner: evalImpliedWinner === 'tie' ? 'tie' : evalImpliedWinner,
      evalDelta: scoreDelta,
      evalCloseness,
      agrees,
      comparisonMargin,
      scorePrimarySource: primaryScoreSelection.source,
      scoreChallengerSource: challengerScoreSelection.source,
      primaryScoreFallback: Boolean(primaryScoreSelection.warning),
      challengerScoreFallback: Boolean(challengerScoreSelection.warning),
      challengeType: challengeTypeObj.type,
      difficultyBucket: String(deriveDifficultyBucket(pair.record).bucket),
      difficultyCollapsed: deriveDifficultyBucket(pair.record).collapsed,
    };

    // Mark unrecoverable challenge type.
    if (row.challengeType === 'unrecoverable') {
      row.excludedFromStratifiedAnalysis = true;
    }

    rows.push(row);

    // Collect disagreement data.
    if (evalImpliedWinner !== 'tie' && !agrees) {
      disagreeRows.push(row);
      if (comparisonMargin !== undefined) {
        marginValues.push(Math.abs(comparisonMargin));
      }
      const marginBucket = classifyMargin(comparisonMargin);
      marginDistribution[marginBucket] = (marginDistribution[marginBucket] ?? 0) + 1;
      closenessDistribution[evalCloseness]++;

      // Build margin × closeness cross-tab.
      if (!marginClosenessTable[evalCloseness]) {
        marginClosenessTable[evalCloseness] = {};
      }
      marginClosenessTable[evalCloseness][marginBucket] = (marginClosenessTable[evalCloseness][marginBucket] ?? 0) + 1;
    }
  }

  // Filter rows with both eval verdicts available. Fallback scores remain in the
  // denominator but ties do not produce an eval-judge verdict.
  const analyzedRows = rows.filter((row) => (
    row.classification === 'analyzed'
    || row.classification === 'excluded_score_fallback'
  ));
  const fallbackRows = analyzedRows.filter((row) => (
    row.primaryScoreFallback === true || row.challengerScoreFallback === true
  ));

  // Compute disagreement rate.
  const disagreements = disagreeRows.length;
  const agreements = analyzedRows.filter((row) => row.agrees === true).length;
  const disagreementCell = createCell(disagreements, analyzedRows.length);
  const fallbackDisagreements = fallbackRows.filter((row) => row.agrees === false).length;
  const fallbackDisagreementCell = createCell(fallbackDisagreements, fallbackRows.length);

  // Compute median margin for disagreements.
  marginValues.sort((a, b) => a - b);
  const medianMargin = marginValues.length > 0
    ? marginValues.length % 2 === 0
      ? (marginValues[marginValues.length / 2 - 1] + marginValues[marginValues.length / 2]) / 2
      : marginValues[Math.floor(marginValues.length / 2)]
    : null;

  // Stratify disagreements by challenge type, difficulty bucket, and collapsed difficulty.
  const byType = groupSuccessCells(
    analyzedRows,
    (row) => row.challengeType,
    (row) => row.agrees === true,
  );

  const byBucket = groupSuccessCells(
    analyzedRows,
    (row) => row.difficultyBucket,
    (row) => row.agrees === true,
  );

  const byCollapsed = groupSuccessCells(
    analyzedRows,
    (row) => row.difficultyCollapsed,
    (row) => row.agrees === true,
  );

  return {
    population: pairs.length,
    analyzed: analyzedRows.length,
    excluded,
    ties: tieCount,
    fallback: {
      scoreFallback: fallbackRows.length,
      disagreements: fallbackDisagreements,
      disagreementCell: fallbackDisagreementCell,
    },
    overall: {
      disagreementCell,
      disagreements,
      agreements,
    },
    marginClosenessTable,
    byChallengeType: byType,
    byDifficultyBucket: byBucket,
    byDifficultyCollapsed: byCollapsed,
    disagreementsByMarginCloseness: {
      margin: marginDistribution,
      medianMargin,
      closeness: closenessDistribution,
    },
    rows,
  };
}

/**
 * Render eval disagreement summary as markdown report.
 */
export function renderEvalDisagreementReportMarkdown(summary: EvalDisagreementSummary): string {
  const lines: string[] = [];

  lines.push('# Arbiter Probe C — Judge vs eval judge disagreement');
  lines.push('');

  // Overall
  lines.push('## Overall');
  lines.push('');
  lines.push('| Population | Analyzed | Ties | Disagreements | Disagreement Rate | 95% CI |');
  lines.push('|---:|---:|---:|---:|---:|---:|');

  const totalExcluded = summary.excluded.missingEvalPrimary
    + summary.excluded.missingEvalChallenger;

  const rateStr = summary.overall.disagreementCell.rate === null
    ? 'n/a'
    : `${(summary.overall.disagreementCell.rate * 100).toFixed(1)}%`;
  const ciStr = summary.overall.disagreementCell.rate === null
    ? 'n/a'
    : `${(summary.overall.disagreementCell.ci95.lo! * 100).toFixed(1)}% - ${(summary.overall.disagreementCell.ci95.hi! * 100).toFixed(1)}%`;

  lines.push(
    `| ${summary.population} | ${summary.analyzed} | ${summary.ties} | ${summary.overall.disagreements} | ${rateStr} | ${ciStr} |`,
  );
  lines.push('');

  // Exclusions
  if (totalExcluded > 0 || summary.excluded.scoreFallback > 0) {
    lines.push('## Exclusions');
    lines.push('');
    if (summary.excluded.missingEvalPrimary > 0) {
      lines.push(`- Missing eval primary: ${summary.excluded.missingEvalPrimary}`);
    }
    if (summary.excluded.missingEvalChallenger > 0) {
      lines.push(`- Missing eval challenger: ${summary.excluded.missingEvalChallenger}`);
    }
    if (summary.excluded.scoreFallback > 0) {
      lines.push(
        `- Score fallback (stage unavailable, used overall; included in analyzed denominator): ${summary.excluded.scoreFallback}`,
      );
    }
    lines.push('');
  }

  if (summary.fallback.scoreFallback > 0) {
    const fallbackRate = summary.fallback.disagreementCell.rate === null
      ? 'n/a'
      : `${(summary.fallback.disagreementCell.rate * 100).toFixed(1)}%`;
    lines.push('## Score Fallback Sensitivity');
    lines.push('');
    lines.push('| Fallback Rows | Disagreements | Disagreement Rate |');
    lines.push('|---:|---:|---:|');
    lines.push(`| ${summary.fallback.scoreFallback} | ${summary.fallback.disagreements} | ${fallbackRate} |`);
    lines.push('');
  }

  // By Challenge Type
  if (Object.keys(summary.byChallengeType).length > 0) {
    lines.push('## By Challenge Type');
    lines.push('');
    lines.push('| Challenge Type | n | Disagreements | Rate | 95% CI |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [type, cell] of Object.entries(summary.byChallengeType)) {
      const rate = cell.rate === null ? 'n/a' : `${((1 - cell.rate) * 100).toFixed(1)}%`;
      const ci = cell.rate === null
        ? 'n/a'
        : `${((1 - cell.ci95.hi!) * 100).toFixed(1)}% - ${((1 - cell.ci95.lo!) * 100).toFixed(1)}%`;
      const disagreeCount = cell.n - cell.successes;
      lines.push(`| ${type} | ${cell.n} | ${disagreeCount} | ${rate} | ${ci} |`);
    }
    lines.push('');
  }

  // By Difficulty Bucket
  if (Object.keys(summary.byDifficultyBucket).length > 0) {
    lines.push('## By Difficulty Bucket');
    lines.push('');
    lines.push('| Bucket | n | Disagreements | Rate | 95% CI |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [bucket, cell] of Object.entries(summary.byDifficultyBucket)) {
      const rate = cell.rate === null ? 'n/a' : `${((1 - cell.rate) * 100).toFixed(1)}%`;
      const ci = cell.rate === null
        ? 'n/a'
        : `${((1 - cell.ci95.hi!) * 100).toFixed(1)}% - ${((1 - cell.ci95.lo!) * 100).toFixed(1)}%`;
      const disagreeCount = cell.n - cell.successes;
      lines.push(`| ${bucket} | ${cell.n} | ${disagreeCount} | ${rate} | ${ci} |`);
    }
    lines.push('');
  }

  // By Difficulty Collapsed
  if (Object.keys(summary.byDifficultyCollapsed).length > 0) {
    lines.push('## By Difficulty Collapsed');
    lines.push('');
    lines.push('| Difficulty | n | Disagreements | Rate | 95% CI |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [collapsed, cell] of Object.entries(summary.byDifficultyCollapsed)) {
      const rate = cell.rate === null ? 'n/a' : `${((1 - cell.rate) * 100).toFixed(1)}%`;
      const ci = cell.rate === null
        ? 'n/a'
        : `${((1 - cell.ci95.hi!) * 100).toFixed(1)}% - ${((1 - cell.ci95.lo!) * 100).toFixed(1)}%`;
      const disagreeCount = cell.n - cell.successes;
      lines.push(`| ${collapsed} | ${cell.n} | ${disagreeCount} | ${rate} | ${ci} |`);
    }
    lines.push('');
  }

  // Eval Closeness Distribution
  lines.push('## Eval Score Closeness (Disagreements Only)');
  lines.push('');
  const closeness = summary.disagreementsByMarginCloseness.closeness;
  if (Object.values(closeness).some((v) => v > 0)) {
    lines.push('| Score Delta Bucket | Count |');
    lines.push('|---|---:|');
    lines.push(`| < 0.05 | ${closeness.lt_005} |`);
    lines.push(`| 0.05 - 0.15 | ${closeness.lt_015} |`);
    lines.push(`| 0.15 - 0.30 | ${closeness.lt_030} |`);
    lines.push(`| >= 0.30 | ${closeness.gte_030} |`);
    lines.push('');
  }

  const marginEntries = Object.entries(summary.disagreementsByMarginCloseness.margin)
    .sort(([a], [b]) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return Number(a) - Number(b);
    });
  if (marginEntries.length > 0) {
    lines.push('## Comparison Judge Margin (Disagreements Only)');
    lines.push('');
    lines.push('| Abs Margin Bucket | Count |');
    lines.push('|---:|---:|');
    for (const [bucket, count] of marginEntries) {
      lines.push(`| ${bucket} | ${count} |`);
    }
    lines.push('');
  }

  if (summary.disagreementsByMarginCloseness.medianMargin !== null) {
    lines.push(
      `Median comparison judge margin (disagreements): ${summary.disagreementsByMarginCloseness.medianMargin.toFixed(2)}`,
    );
    lines.push('');
  }

  const disagreementRows = summary.rows.filter((row) => row.agrees === false);
  if (disagreementRows.length > 0) {
    lines.push('## Disagreement Pairs');
    lines.push('');
    lines.push('| Pair | Challenge Type | Difficulty | Judge Winner | Eval Winner | Judge Margin | Eval Delta | Primary Source | Challenger Source | Fallback |');
    lines.push('|---|---|---|---|---|---:|---:|---|---|---|');
    for (const row of disagreementRows) {
      const fallback = row.primaryScoreFallback || row.challengerScoreFallback ? 'yes' : 'no';
      const margin = row.comparisonMargin === undefined ? 'n/a' : row.comparisonMargin.toFixed(2);
      const delta = row.evalDelta === undefined ? 'n/a' : row.evalDelta.toFixed(3);
      lines.push(
        `| ${row.pairId} | ${row.challengeType} | ${row.difficultyCollapsed} | ${row.comparisonWinner} | ${row.evalImpliedWinner ?? 'n/a'} | ${margin} | ${delta} | ${row.scorePrimarySource ?? 'n/a'} | ${row.scoreChallengerSource ?? 'n/a'} | ${fallback} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
