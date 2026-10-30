/**
 * Analysis, cross-tabulation, disagreement sampling, and conservative verdict
 * generation for rework cell labels (HOK-3361).
 */

import {
  type CellReasonCode,
  type DisagreementState,
  type ReviewLayer,
  type ReviewLens,
  type ReworkCellLabelV1,
  deduplicateReworkCellLabels,
  reworkCellNaturalKey,
  REVIEW_LAYERS,
  REVIEW_LENSES,
} from './rework-cell-label.ts';

export interface RowColDistribution {
  count: number;
  percentage: number;
}

export interface UnknownShare {
  total_unknown: number;
  percentage: number;
  layer_unknown: number;
  lens_unknown: number;
}

export interface AgreementMetrics {
  evaluated_by_both: number;
  agreements: number;
  disagreements: number;
  agreement_rate: number;
  disagreement_rate: number;
  by_state: Record<DisagreementState, number>;
}

export interface ReviewerCrossTabs {
  by_reviewer: Record<string, Record<string, number>>;
  evidence_coverage: {
    direct: number;
    archived: number;
    partial: number;
    unavailable: number;
    coverage_rate: number;
  };
}

export interface DisagreementSampleEntry {
  natural_key: string;
  original_pr: { number: number; url: string; title?: string };
  corrective_pr: { number: number; url: string; title?: string };
  structural: { layer: string; lens: string; cell: string; confidence: string };
  llm: { layer: string; lens: string; cell: string; explanation?: string };
  disagreement_state: DisagreementState;
  reason_codes: CellReasonCode[];
}

export interface TargetedReviewerVerdict {
  recommended: boolean;
  target_layer?: ReviewLayer;
  target_cell?: string;
  miss_share?: number;
  total_misses?: number;
  statement: string;
}

export interface AdoptionReadinessVerdict {
  ready_for_diagnosis: boolean;
  agreement_adequate: boolean;
  unknown_rate_adequate: boolean;
  statement: string;
}

export interface ReworkCellVerdict {
  targeted_reviewer: TargetedReviewerVerdict;
  adoption_readiness: AdoptionReadinessVerdict;
  summary: string;
}

export interface ReworkCellReport {
  total_records: number;
  deduplicated_records: number;
  row_distribution: Record<ReviewLayer | 'unknown', RowColDistribution>;
  column_distribution: Record<ReviewLens | 'unknown', RowColDistribution>;
  cell_matrix: Record<string, RowColDistribution>;
  unknown_share: UnknownShare;
  agreement_metrics: AgreementMetrics;
  reviewer_cross_tabs: ReviewerCrossTabs;
  disagreement_sample: DisagreementSampleEntry[];
  verdict: ReworkCellVerdict;
}

export interface ReportGenerateOptions {
  sampleSize?: number;
}

export const MIN_SUPPORT_FOR_RECOMMENDATION = 5;
export const CONCENTRATED_MISS_THRESHOLD = 0.25;
export const MIN_AGREEMENT_FOR_ADOPTION = 70.0;
export const MAX_UNKNOWN_FOR_ADOPTION = 30.0;

export function generateReworkCellReport(
  labels: readonly ReworkCellLabelV1[],
  options?: ReportGenerateOptions,
): ReworkCellReport {
  const sampleSize = options?.sampleSize ?? 15;
  const deduplicated = deduplicateReworkCellLabels(labels);
  const total = deduplicated.length;

  // Initialize distributions
  const rowCounts: Record<ReviewLayer | 'unknown', number> = {
    form: 0,
    local_meaning: 0,
    wiring: 0,
    runtime: 0,
    use: 0,
    unknown: 0,
  };

  const colCounts: Record<ReviewLens | 'unknown', number> = {
    correctness: 0,
    security: 0,
    history: 0,
    reversibility: 0,
    unknown: 0,
  };

  const cellCounts: Record<string, number> = {
    unknown: 0,
  };

  for (const layer of REVIEW_LAYERS) {
    for (const lens of REVIEW_LENSES) {
      cellCounts[`${layer}:${lens}`] = 0;
    }
  }

  let totalUnknown = 0;
  let layerUnknown = 0;
  let lensUnknown = 0;

  // Agreement counts
  let evaluatedByBoth = 0;
  let agreements = 0;
  let disagreements = 0;
  const byState: Record<DisagreementState, number> = {
    agree: 0,
    disagree: 0,
    structural_only: 0,
    llm_only: 0,
    both_unknown: 0,
    llm_failed: 0,
  };

  // Reviewer cross-tabs
  const byReviewer: Record<string, Record<string, number>> = {};
  const coverage = {
    direct: 0,
    archived: 0,
    partial: 0,
    unavailable: 0,
  };

  // Disagreements collection for sampling
  const disagreementCandidates: DisagreementSampleEntry[] = [];

  for (const label of deduplicated) {
    const chosenLayer = label.chosen.layer;
    const chosenLens = label.chosen.lens;
    const chosenCell = label.chosen.cell;

    rowCounts[chosenLayer] = (rowCounts[chosenLayer] ?? 0) + 1;
    colCounts[chosenLens] = (colCounts[chosenLens] ?? 0) + 1;
    cellCounts[chosenCell] = (cellCounts[chosenCell] ?? 0) + 1;

    if (chosenLayer === 'unknown') layerUnknown++;
    if (chosenLens === 'unknown') lensUnknown++;
    if (chosenCell === 'unknown') totalUnknown++;

    // Agreement tracking
    const state = label.disagreement_state;
    byState[state] = (byState[state] ?? 0) + 1;

    if (label.structural && label.llm && !label.llm.error) {
      evaluatedByBoth++;
      if (label.agreement) {
        agreements++;
      } else {
        disagreements++;
      }
    }

    if (state === 'disagree') {
      disagreementCandidates.push({
        natural_key: reworkCellNaturalKey(label),
        original_pr: {
          number: label.original_pr.number,
          url: label.original_pr.url,
          title: label.original_pr.title,
        },
        corrective_pr: {
          number: label.corrective_pr.number,
          url: label.corrective_pr.url,
          title: label.corrective_pr.title,
        },
        structural: {
          layer: label.structural.layer,
          lens: label.structural.lens,
          cell: label.structural.cell,
          confidence: label.structural.confidence,
        },
        llm: {
          layer: label.llm?.layer ?? 'unknown',
          lens: label.llm?.lens ?? 'unknown',
          cell: label.llm?.cell ?? 'unknown',
          explanation: label.llm?.explanation,
        },
        disagreement_state: state,
        reason_codes: label.reason_codes,
      });
    }

    // Reviewer cross tabs
    const prov = label.review_evidence.provenance;
    if (prov === 'direct') coverage.direct++;
    else if (prov === 'archived') coverage.archived++;
    else if (prov === 'partial') coverage.partial++;
    else coverage.unavailable++;

    const reviewers = label.review_evidence.reviewers_run.length > 0
      ? label.review_evidence.reviewers_run
      : ['unattributed'];

    for (const rev of reviewers) {
      if (!byReviewer[rev]) {
        byReviewer[rev] = {};
      }
      byReviewer[rev][chosenCell] = (byReviewer[rev][chosenCell] ?? 0) + 1;
    }
  }

  // Build distributions
  const rowDistribution: Record<ReviewLayer | 'unknown', RowColDistribution> = {} as Record<ReviewLayer | 'unknown', RowColDistribution>;
  for (const [key, count] of Object.entries(rowCounts)) {
    rowDistribution[key as ReviewLayer | 'unknown'] = {
      count,
      percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0,
    };
  }

  const columnDistribution: Record<ReviewLens | 'unknown', RowColDistribution> = {} as Record<ReviewLens | 'unknown', RowColDistribution>;
  for (const [key, count] of Object.entries(colCounts)) {
    columnDistribution[key as ReviewLens | 'unknown'] = {
      count,
      percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0,
    };
  }

  const cellMatrix: Record<string, RowColDistribution> = {};
  for (const [key, count] of Object.entries(cellCounts)) {
    cellMatrix[key] = {
      count,
      percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0,
    };
  }

  const unknownRate = total > 0 ? Number(((totalUnknown / total) * 100).toFixed(1)) : 0;
  const unknownShare: UnknownShare = {
    total_unknown: totalUnknown,
    percentage: unknownRate,
    layer_unknown: layerUnknown,
    lens_unknown: lensUnknown,
  };

  const agreementRate = evaluatedByBoth > 0
    ? Number(((agreements / evaluatedByBoth) * 100).toFixed(1))
    : 0;
  const disagreementRate = evaluatedByBoth > 0
    ? Number(((disagreements / evaluatedByBoth) * 100).toFixed(1))
    : 0;

  const agreementMetrics: AgreementMetrics = {
    evaluated_by_both: evaluatedByBoth,
    agreements,
    disagreements,
    agreement_rate: agreementRate,
    disagreement_rate: disagreementRate,
    by_state: byState,
  };

  const coverageRate = total > 0
    ? Number((((coverage.direct + coverage.archived) / total) * 100).toFixed(1))
    : 0;

  const reviewerCrossTabs: ReviewerCrossTabs = {
    by_reviewer: byReviewer,
    evidence_coverage: {
      ...coverage,
      coverage_rate: coverageRate,
    },
  };

  // Deterministic disagreement sample sorted by natural key
  disagreementCandidates.sort((a, b) => a.natural_key.localeCompare(b.natural_key));
  const disagreementSample = disagreementCandidates.slice(0, sampleSize);

  // Conservative Verdict Generation
  const knownTotal = total - totalUnknown;
  let topConcentratedLayer: ReviewLayer | null = null;
  let topConcentratedLayerCount = 0;

  for (const layer of REVIEW_LAYERS) {
    const count = rowCounts[layer];
    if (count > topConcentratedLayerCount) {
      topConcentratedLayerCount = count;
      topConcentratedLayer = layer;
    }
  }

  const topLayerShare = knownTotal > 0 ? topConcentratedLayerCount / knownTotal : 0;

  let targetedReviewerVerdict: TargetedReviewerVerdict;
  if (
    topConcentratedLayer &&
    topConcentratedLayerCount >= MIN_SUPPORT_FOR_RECOMMENDATION &&
    topLayerShare >= CONCENTRATED_MISS_THRESHOLD
  ) {
    targetedReviewerVerdict = {
      recommended: true,
      target_layer: topConcentratedLayer,
      total_misses: topConcentratedLayerCount,
      miss_share: Number(topLayerShare.toFixed(3)),
      statement: `Recommend targeted reviewer for ${topConcentratedLayer}: concentrated rework misses (${topConcentratedLayerCount} PRs, ${(topLayerShare * 100).toFixed(1)}% of known rework).`,
    };
  } else {
    targetedReviewerVerdict = {
      recommended: false,
      statement: `Insufficient evidence to justify a targeted wavemill reviewer (requires >=${MIN_SUPPORT_FOR_RECOMMENDATION} misses and >=${CONCENTRATED_MISS_THRESHOLD * 100}% concentration).`,
    };
  }

  const agreementAdequate = evaluatedByBoth >= 5 && agreementRate >= MIN_AGREEMENT_FOR_ADOPTION;
  const unknownRateAdequate = total >= 5 && unknownRate <= MAX_UNKNOWN_FOR_ADOPTION;
  const readyForDiagnosis = agreementAdequate && unknownRateAdequate;

  let readinessStatement = '';
  if (readyForDiagnosis) {
    readinessStatement = `Cell label is reliable enough for Rework Risk diagnosis and v2 check menu adoption (${agreementRate}% agreement, ${unknownRate}% unknown).`;
  } else {
    const deficits: string[] = [];
    if (!agreementAdequate) deficits.push(`low agreement rate (${agreementRate}% vs required >=${MIN_AGREEMENT_FOR_ADOPTION}%)`);
    if (!unknownRateAdequate) deficits.push(`high unknown rate (${unknownRate}% vs allowed <=${MAX_UNKNOWN_FOR_ADOPTION}%)`);
    if (total < 5) deficits.push(`insufficient sample count (${total})`);
    readinessStatement = `Cell label is not yet reliable enough for production diagnosis: ${deficits.join(', ')}.`;
  }

  const adoptionReadinessVerdict: AdoptionReadinessVerdict = {
    ready_for_diagnosis: readyForDiagnosis,
    agreement_adequate: agreementAdequate,
    unknown_rate_adequate: unknownRateAdequate,
    statement: readinessStatement,
  };

  const summary = `${targetedReviewerVerdict.statement} ${adoptionReadinessVerdict.statement}`;

  return {
    total_records: labels.length,
    deduplicated_records: total,
    row_distribution: rowDistribution,
    column_distribution: columnDistribution,
    cell_matrix: cellMatrix,
    unknown_share: unknownShare,
    agreement_metrics: agreementMetrics,
    reviewer_cross_tabs: reviewerCrossTabs,
    disagreement_sample: disagreementSample,
    verdict: {
      targeted_reviewer: targetedReviewerVerdict,
      adoption_readiness: adoptionReadinessVerdict,
      summary,
    },
  };
}

/** Formats a text report for terminal / markdown output. */
export function formatReportText(report: ReworkCellReport): string {
  const lines: string[] = [];

  lines.push('# Rework Risk: Review Layer x Lens Cell Experiment Report (cell-0.1.0)');
  lines.push('');
  lines.push(`Total rows processed: ${report.total_records} (${report.deduplicated_records} deduplicated)`);
  lines.push('');

  lines.push('## 1. Distribution by Review Layer (Rows)');
  lines.push('| Layer | Count | Share (%) |');
  lines.push('|---|---:|---:|');
  for (const [layer, dist] of Object.entries(report.row_distribution)) {
    lines.push(`| ${layer} | ${dist.count} | ${dist.percentage}% |`);
  }
  lines.push('');

  lines.push('## 2. Distribution by Review Lens (Columns)');
  lines.push('| Lens | Count | Share (%) |');
  lines.push('|---|---:|---:|');
  for (const [lens, dist] of Object.entries(report.column_distribution)) {
    lines.push(`| ${lens} | ${dist.count} | ${dist.percentage}% |`);
  }
  lines.push('');

  lines.push('## 3. Cell Matrix (5 x 4 + Unknown)');
  lines.push('| Cell | Count | Share (%) |');
  lines.push('|---|---:|---:|');
  for (const [cell, dist] of Object.entries(report.cell_matrix)) {
    if (dist.count > 0 || cell === 'unknown') {
      lines.push(`| ${cell} | ${dist.count} | ${dist.percentage}% |`);
    }
  }
  lines.push('');

  lines.push('## 4. Unknown Share and Classifier Agreement');
  lines.push(`- Unknown cell rate: ${report.unknown_share.percentage}% (${report.unknown_share.total_unknown}/${report.deduplicated_records})`);
  lines.push(`  - Layer unknown: ${report.unknown_share.layer_unknown}`);
  lines.push(`  - Lens unknown: ${report.unknown_share.lens_unknown}`);
  lines.push(`- Evaluated by both structural & LLM: ${report.agreement_metrics.evaluated_by_both}`);
  lines.push(`- Agreement rate: ${report.agreement_metrics.agreement_rate}% (${report.agreement_metrics.agreements} agree, ${report.agreement_metrics.disagreements} disagree)`);
  lines.push(`- Disagreement breakdown:`);
  for (const [state, count] of Object.entries(report.agreement_metrics.by_state)) {
    lines.push(`  - ${state}: ${count}`);
  }
  lines.push('');

  lines.push('## 5. Reviewer and Challenge Stage Evidence Coverage');
  lines.push(`- Evidence coverage rate: ${report.reviewer_cross_tabs.evidence_coverage.coverage_rate}%`);
  lines.push(`  - Direct live: ${report.reviewer_cross_tabs.evidence_coverage.direct}`);
  lines.push(`  - Archived: ${report.reviewer_cross_tabs.evidence_coverage.archived}`);
  lines.push(`  - Unavailable: ${report.reviewer_cross_tabs.evidence_coverage.unavailable}`);
  lines.push('');
  lines.push('Cross-tab by Reviewer:');
  for (const [rev, cells] of Object.entries(report.reviewer_cross_tabs.by_reviewer)) {
    const summary = Object.entries(cells).map(([c, n]) => `${c}: ${n}`).join(', ');
    lines.push(`- **${rev}**: ${summary}`);
  }
  lines.push('');

  lines.push(`## 6. Disagreement Review Sample (${report.disagreement_sample.length} cases)`);
  if (report.disagreement_sample.length === 0) {
    lines.push('No structural vs LLM disagreements found in this sample.');
  } else {
    report.disagreement_sample.forEach((item, idx) => {
      lines.push(`### ${idx + 1}. Pair: #${item.original_pr.number} -> Fix #${item.corrective_pr.number}`);
      lines.push(`- **Original PR**: ${item.original_pr.title ?? 'no title'} (${item.original_pr.url})`);
      lines.push(`- **Corrective PR**: ${item.corrective_pr.title ?? 'no title'} (${item.corrective_pr.url})`);
      lines.push(`- **Structural decision**: \`${item.structural.cell}\` (confidence: ${item.structural.confidence})`);
      lines.push(`- **LLM decision**: \`${item.llm.cell}\` (${item.llm.explanation ?? 'no explanation'})`);
      lines.push(`- **Reason codes**: ${item.reason_codes.join(', ')}`);
      lines.push('');
    });
  }

  lines.push('## 7. Experiment Verdict');
  lines.push(`- **Targeted Reviewer Recommendation**: ${report.verdict.targeted_reviewer.statement}`);
  lines.push(`- **Rework Risk / Check-Menu Readiness**: ${report.verdict.adoption_readiness.statement}`);
  lines.push('');

  return lines.join('\n');
}
