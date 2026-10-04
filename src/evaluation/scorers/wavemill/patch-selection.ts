import type {
  WavemillRouterDiagnostics,
  WavemillRouterMeasurementPolicy,
  WavemillRouterScoringMetadata,
} from '../../../../shared/lib/eval-schema.ts';
import type {
  ReplayPatchSelectionInstance,
} from '../../../../shared/fixtures/harness-replay/patch-selection-v1/schema.ts';

export const WAVEMILL_PATCH_SELECTION_SCORER_ID =
  'hokusai.scorers.wavemill.patch_selection_accuracy:v1';

/**
 * Input record for patch-selection scoring.
 * Represents a single selection attempt on a replay instance.
 */
export interface PatchSelectionScoreRecord {
  /** Instance id from the replay corpus */
  instanceId: string;
  /** The patch content that was selected (or candidate id) */
  selectedPatchOrId: string;
  /** Reference to the replay instance for ground truth lookup */
  instance: ReplayPatchSelectionInstance;
}

/**
 * Result of patch-selection scoring.
 */
export interface PatchSelectionScoreResult {
  patch_selection_accuracy: number;
  wavemill_router_diagnostics: WavemillRouterDiagnostics;
  wavemill_router_scoring: WavemillRouterScoringMetadata;
}

export interface ScorePatchSelectionOptions {
  measurementPolicy: WavemillRouterMeasurementPolicy;
  /** If true, use strict patch equality fallback; if false, require ids */
  allowPatchFallback?: boolean;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundMetric(numerator / denominator) : 0;
}

/**
 * Check if a record is valid and scoreable.
 * A record is scoreable if it has an instance with valid ground truth.
 * Note: selectedPatchOrId can be empty (which is tracked as missing, not invalid).
 */
function isScoreable(record: PatchSelectionScoreRecord): boolean {
  return (
    !!record.instanceId &&
    !!record.instance &&
    !!record.instance.id &&
    !!record.instance.knownGoodCandidateId &&
    record.instance.candidates &&
    record.instance.candidates.length >= 2
  );
}

/**
 * Determine if a selection matches the known-good candidate.
 * Supports both candidate id matching and (optionally) strict patch equality.
 */
function isSelectionCorrect(
  record: PatchSelectionScoreRecord,
  allowPatchFallback: boolean = false,
): boolean {
  const { instance, selectedPatchOrId } = record;

  // First try: id-based matching
  if (selectedPatchOrId === instance.knownGoodCandidateId) {
    return true;
  }

  // Second try: find by patch content (if fallback enabled)
  if (allowPatchFallback) {
    // Find candidate with matching patch
    const selectedCandidate = instance.candidates.find(
      (c) => c.patch === selectedPatchOrId,
    );

    if (selectedCandidate && selectedCandidate.id === instance.knownGoodCandidateId) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a selection is a known-bad candidate.
 */
function isSelectionKnownBad(record: PatchSelectionScoreRecord): boolean {
  const { instance, selectedPatchOrId } = record;

  // Check if it's a known-bad id
  if (instance.knownBadCandidateIds?.includes(selectedPatchOrId)) {
    return true;
  }

  // Check if it matches a known-bad patch
  const selectedCandidate = instance.candidates.find(
    (c) => c.patch === selectedPatchOrId,
  );
  return selectedCandidate
    ? instance.knownBadCandidateIds?.includes(selectedCandidate.id) ?? false
    : false;
}

/**
 * Score patch-selection records against ground truth.
 * Returns accuracy and diagnostic counts.
 */
export function scorePatchSelection(
  records: PatchSelectionScoreRecord[],
  options: ScorePatchSelectionOptions,
): PatchSelectionScoreResult {
  const totalRecords = records.length;
  const scoreableRecords = records.filter(isScoreable);
  const scoreableCount = scoreableRecords.length;

  let correctCount = 0;
  let knownBadSelectedCount = 0;
  let unknownSelectedCount = 0;
  let missingSelectionCount = 0;
  let ambiguousSelectionCount = 0;

  for (const record of scoreableRecords) {
    if (!record.selectedPatchOrId) {
      missingSelectionCount += 1;
      continue;
    }

    if (isSelectionCorrect(record, options.allowPatchFallback)) {
      correctCount += 1;
    } else if (isSelectionKnownBad(record)) {
      knownBadSelectedCount += 1;
    } else {
      unknownSelectedCount += 1;
    }
  }

  const diagnostics: WavemillRouterDiagnostics = {
    scoreable_coverage: rate(scoreableCount, totalRecords),
    total_records: totalRecords,
    scoreable_records: scoreableCount,
    invalid_route_records: totalRecords - scoreableCount,
    // Patch-selection specific diagnostics
    correct_selection_count: correctCount,
    known_bad_selected_count: knownBadSelectedCount,
    unknown_selected_count: unknownSelectedCount,
    missing_selection_count: missingSelectionCount,
    ambiguous_selection_count: ambiguousSelectionCount,
  };

  return {
    patch_selection_accuracy: rate(correctCount, scoreableCount),
    wavemill_router_diagnostics: diagnostics,
    wavemill_router_scoring: {
      scorer_id: WAVEMILL_PATCH_SELECTION_SCORER_ID,
      measurement_policy: options.measurementPolicy,
    },
  };
}
