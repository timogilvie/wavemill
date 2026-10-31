/**
 * Cell-label report/aggregation (HOK-3361, phase 3).
 *
 * Consumes deduplicated `cell-0.1.0` rows and produces the experiment
 * deliverable: distributions by row (layer), column (lens) and populated
 * cell; unknown share; structural-vs-LLM agreement; reviewer/challenge
 * cross-tabs with evidence coverage; a deterministic 10-15 row disagreement
 * sample for short human review; and a conservative verdict.
 *
 * The verdict is conservative by construction: a targeted reviewer is only
 * recommended when a cell has sufficient labelled support AND materially
 * concentrated reviewer misses; otherwise the report says insufficient
 * evidence. Adequacy for Rework Risk diagnosis / v2 check-menu use is stated
 * separately from the reviewer recommendation.
 */

import {
  CELL_LAYERS,
  CELL_LENSES,
  type CellLabelRowV0,
  type CellLayer,
  type CellLens,
} from './cell-label-contract.ts';

export interface CellReportOptions {
  /** Disagreement sample size; clamped to the 10-15 review window. Default 12. */
  sampleSize?: number;
  /** Minimum labelled rows a cell needs before a targeted-reviewer verdict. Default 5. */
  minCellSupport?: number;
  /** Share of a layer's reviewer misses the cell must concentrate. Default 0.5. */
  concentrationThreshold?: number;
}

export interface CellDistributionEntry {
  layer: CellLayer;
  total: number;
  byLens: Partial<Record<CellLens, number>>;
}

export interface CellCrossTabEntry {
  layer: CellLayer;
  /** Reworks where evidence-backed reviewer coverage ran on the original PR. */
  reviewerMisses: number;
  /** Reworks with durable artifacts but no evidence-backed reviewer run. */
  noEvidenceBackedRun: number;
  /** Reworks whose historical review artifacts are unavailable. */
  coverageUnavailable: number;
}

export interface CellVerdict {
  verdict: 'targeted_reviewer' | 'insufficient_evidence';
  cell?: { layer: CellLayer; lens: CellLens };
  support?: number;
  concentration?: number;
  rationale: string;
}

export interface CellAdequacy {
  agreementAdequate: boolean;
  unknownAdequate: boolean;
  adequateForReworkRiskDiagnosis: boolean;
  reasons: string[];
}

export interface CellReport {
  totals: { labelled: number; unknown: number; unknownShare: number };
  byLayer: CellDistributionEntry[];
  byLens: Record<CellLens, number>;
  cells: Array<{ layer: CellLayer; lens: CellLens; count: number }>;
  agreement: {
    agree: number;
    disagree: number;
    notComparable: number;
    agreementRate: number | null;
  };
  reviewCrossTabs: CellCrossTabEntry[];
  adequacy: CellAdequacy;
  verdict: CellVerdict;
  disagreementSample: Array<{
    labelKey: CellLabelRowV0['label_key'];
    structural: { layer: CellLayer | null; lens: CellLens | null };
    llm: { layer: CellLayer | null; lens: CellLens | null };
    chosen: CellLabelRowV0['chosen'];
    agreement: CellLabelRowV0['agreement'];
  }>;
}

const DEFAULT_SAMPLE_SIZE = 12;
const MIN_SAMPLE_SIZE = 10;
const MAX_SAMPLE_SIZE = 15;
const DEFAULT_MIN_CELL_SUPPORT = 5;
const DEFAULT_CONCENTRATION_THRESHOLD = 0.5;

/**
 * Build the experiment report. Pure and deterministic: rows are sorted before
 * any sampling so the disagreement sample is stable across runs.
 */
export function buildCellReport(rows: CellLabelRowV0[], options: CellReportOptions = {}): CellReport {
  const sampleSize = clamp(options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const minCellSupport = options.minCellSupport ?? DEFAULT_MIN_CELL_SUPPORT;
  const concentrationThreshold = options.concentrationThreshold ?? DEFAULT_CONCENTRATION_THRESHOLD;

  const labelledRows = rows.filter((row) => row.chosen.kind === 'cell');
  const unknownRows = rows.filter((row) => row.chosen.kind === 'unknown');

  const byLayer: CellDistributionEntry[] = CELL_LAYERS.map((layer) => {
    const layerRows = labelledRows.filter((row) => row.chosen.kind === 'cell' && row.chosen.layer === layer);
    const byLens: Partial<Record<CellLens, number>> = {};
    for (const row of layerRows) {
      const lens = (row.chosen as { lens: CellLens }).lens;
      byLens[lens] = (byLens[lens] ?? 0) + 1;
    }
    return { layer, total: layerRows.length, byLens };
  });

  const byLens = Object.fromEntries(CELL_LENSES.map((lens) => [lens, 0])) as Record<CellLens, number>;
  const cells: Array<{ layer: CellLayer; lens: CellLens; count: number }> = [];
  for (const row of labelledRows) {
    if (row.chosen.kind !== 'cell') continue;
    byLens[row.chosen.lens] += 1;
    cells.push({ layer: row.chosen.layer, lens: row.chosen.lens, count: 1 });
  }
  const cellCounts = new Map<string, { layer: CellLayer; lens: CellLens; count: number }>();
  for (const cell of cells) {
    const key = `${cell.layer}/${cell.lens}`;
    const existing = cellCounts.get(key);
    if (existing) existing.count += 1;
    else cellCounts.set(key, { ...cell });
  }
  const populatedCells = [...cellCounts.values()].sort((a, b) =>
    b.count - a.count || a.layer.localeCompare(b.layer) || a.lens.localeCompare(b.lens));

  const agree = rows.filter((row) => row.agreement === 'agree').length;
  const disagree = rows.filter((row) => row.agreement === 'disagree').length;
  const notComparable = rows.filter((row) => row.agreement === 'not_comparable').length;
  const comparable = agree + disagree;

  const reviewCrossTabs = CELL_LAYERS.map((layer) => {
    const layerRows = rows.filter((row) => row.chosen.kind === 'cell' && row.chosen.layer === layer);
    let reviewerMisses = 0;
    let noEvidenceBackedRun = 0;
    let coverageUnavailable = 0;
    for (const row of layerRows) {
      const evidence = row.review_evidence;
      if (!evidence) {
        coverageUnavailable += 1;
        continue;
      }
      if (evidence.coverage === 'unavailable') {
        coverageUnavailable += 1;
      } else if (evidence.reviewer_runs.some((run) => run.evidence_backed)) {
        reviewerMisses += 1;
      } else {
        noEvidenceBackedRun += 1;
      }
    }
    return { layer, reviewerMisses, noEvidenceBackedRun, coverageUnavailable };
  });

  const verdict = buildVerdict(rows, populatedCells, reviewCrossTabs, minCellSupport, concentrationThreshold);
  const adequacy = buildAdequacy(rows.length, comparable > 0 ? agree / comparable : null, unknownRows.length);

  const disagreementRows = rows
    .filter((row) => row.agreement === 'disagree')
    .sort(compareRowsDeterministically)
    .slice(0, sampleSize);

  return {
    totals: {
      labelled: labelledRows.length,
      unknown: unknownRows.length,
      unknownShare: rows.length > 0 ? unknownRows.length / rows.length : 0,
    },
    byLayer,
    byLens,
    cells: populatedCells,
    agreement: {
      agree,
      disagree,
      notComparable,
      agreementRate: comparable > 0 ? agree / comparable : null,
    },
    reviewCrossTabs,
    adequacy,
    verdict,
    disagreementSample: disagreementRows.map((row) => ({
      labelKey: row.label_key,
      structural: { layer: row.structural.layer, lens: row.structural.lens },
      llm: { layer: row.llm.layer, lens: row.llm.lens },
      chosen: row.chosen,
      agreement: row.agreement,
    })),
  };
}

function buildVerdict(
  rows: CellLabelRowV0[],
  populatedCells: Array<{ layer: CellLayer; lens: CellLens; count: number }>,
  crossTabs: CellCrossTabEntry[],
  minCellSupport: number,
  concentrationThreshold: number,
): CellVerdict {
  let best: { layer: CellLayer; lens: CellLens; misses: number; concentration: number } | null = null;
  for (const cell of populatedCells) {
    const tab = crossTabs.find((entry) => entry.layer === cell.layer);
    if (!tab || tab.reviewerMisses === 0) continue;
    // A reviewer miss for this experiment: the rework happened even though an
    // evidence-backed reviewer run is on record for the original PR.
    const cellMisses = rows.filter((row) => row.chosen.kind === 'cell'
      && row.chosen.layer === cell.layer
      && row.chosen.lens === cell.lens
      && row.review_evidence?.coverage === 'available'
      && row.review_evidence.reviewer_runs.some((run) => run.evidence_backed)).length;
    const concentration = cellMisses / tab.reviewerMisses;
    if (cellMisses >= minCellSupport && concentration >= concentrationThreshold) {
      if (!best || cellMisses > best.misses || (cellMisses === best.misses && concentration > best.concentration)) {
        best = { layer: cell.layer, lens: cell.lens, misses: cellMisses, concentration };
      }
    }
  }
  if (best) {
    return {
      verdict: 'targeted_reviewer',
      cell: { layer: best.layer, lens: best.lens },
      support: best.misses,
      concentration: best.concentration,
      rationale: `Cell ${best.layer}/${best.lens} has ${best.misses} labelled reviewer misses concentrated at ${(best.concentration * 100).toFixed(0)}% of its layer's misses — sufficient support for a targeted reviewer.`,
    };
  }
  return {
    verdict: 'insufficient_evidence',
    rationale: `No cell reaches ${minCellSupport} labelled reviewer misses with >=${(concentrationThreshold * 100).toFixed(0)}% of its layer's misses concentrated — insufficient evidence for a targeted reviewer recommendation.`,
  };
}

function buildAdequacy(totalRows: number, agreementRate: number | null, unknownCount: number): CellAdequacy {
  const unknownRate = totalRows > 0 ? unknownCount / totalRows : 1;
  const agreementAdequate = agreementRate !== null && agreementRate >= 0.8;
  const unknownAdequate = unknownRate <= 0.2;
  const reasons: string[] = [];
  if (agreementRate === null) reasons.push('no comparable structural/LLM decisions; agreement rate undefined');
  else if (!agreementAdequate) reasons.push(`agreement rate ${(agreementRate * 100).toFixed(0)}% below the 80% adequacy bar`);
  if (!unknownAdequate) reasons.push(`unknown share ${(unknownRate * 100).toFixed(0)}% above the 20% adequacy bar`);
  if (totalRows === 0) reasons.push('no labelled rows');
  return {
    agreementAdequate,
    unknownAdequate,
    adequateForReworkRiskDiagnosis: agreementAdequate && unknownAdequate && totalRows > 0,
    reasons: reasons.length > 0 ? reasons : ['agreement and unknown rates are within adequacy bars'],
  };
}

function compareRowsDeterministically(a: CellLabelRowV0, b: CellLabelRowV0): number {
  return a.label_key.repo.localeCompare(b.label_key.repo)
    || a.label_key.original_pr_url.localeCompare(b.label_key.original_pr_url)
    || a.label_key.corrective_pr_url.localeCompare(b.label_key.corrective_pr_url);
}

function clamp(size: number): number {
  return Math.min(MAX_SAMPLE_SIZE, Math.max(MIN_SAMPLE_SIZE, Math.round(size)));
}