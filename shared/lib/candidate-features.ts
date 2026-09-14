/**
 * Candidate features extractor for the Arbiter S1 contract (candidate_features/v1).
 *
 * Extracts five feature groups (Shape, Static, Test, Intent, Provenance) from
 * a bare checkout and PR metadata, with optional enrichment via a derived task
 * descriptor for Intent features.
 *
 * ## Design invariants
 *
 * - **No wavemill state.** Reads only committed files, git objects, and GitHub PR metadata.
 * - **Stateless.** Same PR yields identical feature values whether called standalone or from wavemill.
 * - **Intent boundary.** Without enrichment context (derived task descriptor), all Intent fields are null.
 * - **Null discipline.** `null` means "evidence unavailable", never a coerced default like 0 or false.
 *
 * @module candidate-features
 */

import { fetchPrDiff, type PrDiffResult } from './pr-diff-provider.ts';
import {
  resolvePrIdentityMetadata,
  parseUnifiedDiffLineRanges,
  type PrIdentityMetadata,
} from './pr-comparison.ts';
import {
  collectStaticFeatures,
  type StaticFeaturesResult,
  type StaticFeaturesOptions,
} from './static-features.ts';
import { errorMessage } from './error-utils.ts';

// ────────────────────────────────────────────────────────────────
// Type Definitions
// ────────────────────────────────────────────────────────────────

export interface ShapeFeatures {
  files_changed: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}

export interface StaticFeatures extends StaticFeaturesResult {
  // Includes: type_errors, lint_errors, build_ok, complexity_delta,
  // build_evidence, complexity_metric
}

export interface TestFeatures {
  test_files_changed: number | null;
  test_changed_lines: number | null;
}

export interface IntentFeatures {
  touched_out_of_scope_files: boolean | null;
  modified_non_implementation_files: boolean | null;
  added_new_dependencies: boolean | null;
  schema_migration: boolean | null;
  database_change_risk: string | null;
}

export interface ProvenanceFeatures {
  pr_number: string | null;
  head_sha: string | null;
  base_ref: string | null;
  pr_url: string | null;
}

export interface CandidateFeaturesV1 {
  shape: ShapeFeatures;
  static: StaticFeatures;
  test: TestFeatures;
  intent: IntentFeatures;
  provenance: ProvenanceFeatures;
}

export interface ExtractCandidateFeaturesOptions {
  /** Directory that contains the candidate checkout (its HEAD is the candidate). */
  checkoutDir: string;
  /** Optional repo directory (defaults to checkoutDir for gh commands). */
  repoDir?: string;
  /** GitHub PR number. */
  prNumber: string;
  /** Optional base ref for diff analysis (defaults to 'origin/main'). */
  baseRef?: string;
  /** Optional derived task descriptor for Intent enrichment. */
  enrichmentContext?: {
    outOfScopeFiles?: string[];
    schemaChanges?: boolean;
    databaseChanges?: boolean;
    newDependencies?: boolean;
  };
}

// ────────────────────────────────────────────────────────────────
// Diff Analysis Helpers
// ────────────────────────────────────────────────────────────────

interface DiffStats {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  test_files_changed: number;
  test_changed_lines: number;
  all_files: string[];
}

function parseDiffStats(diffText: string): DiffStats {
  const stats: DiffStats = {
    files_changed: 0,
    lines_added: 0,
    lines_removed: 0,
    test_files_changed: 0,
    test_changed_lines: 0,
    all_files: [],
  };

  let currentFile: string | undefined;
  let currentFileIsTest = false;
  let currentFileAddedLines = 0;
  let currentFileRemovedLines = 0;

  for (const line of diffText.split(/\r?\n/)) {
    // Parse file name from unified diff header
    if (line.startsWith('+++ b/')) {
      if (currentFile) {
        stats.files_changed++;
        if (currentFileIsTest) {
          stats.test_files_changed++;
          stats.test_changed_lines += currentFileAddedLines + currentFileRemovedLines;
        }
        stats.lines_added += currentFileAddedLines;
        stats.lines_removed += currentFileRemovedLines;
      }

      currentFile = line.slice('+++ b/'.length).replace(/\t.*$/, '');
      stats.all_files.push(currentFile);
      currentFileIsTest = isTestFile(currentFile);
      currentFileAddedLines = 0;
      currentFileRemovedLines = 0;
      continue;
    }

    // Count added/removed lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentFileAddedLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentFileRemovedLines++;
    }
  }

  // Handle the last file
  if (currentFile) {
    stats.files_changed++;
    if (currentFileIsTest) {
      stats.test_files_changed++;
      stats.test_changed_lines += currentFileAddedLines + currentFileRemovedLines;
    }
    stats.lines_added += currentFileAddedLines;
    stats.lines_removed += currentFileRemovedLines;
  }

  return stats;
}

function isTestFile(filePath: string): boolean {
  // Match common test file patterns
  const testPatterns = [
    /\.test\.(ts|tsx|js|jsx)$/,
    /\.spec\.(ts|tsx|js|jsx)$/,
    /\.test\.mjs$/,
    /\.spec\.mjs$/,
    /^tests?\//,
    /__tests__\//,
    /\/test\//,
  ];
  return testPatterns.some((pattern) => pattern.test(filePath));
}

// ────────────────────────────────────────────────────────────────
// Feature Collectors
// ────────────────────────────────────────────────────────────────

function extractShapeFeatures(diffStats: DiffStats): ShapeFeatures {
  return {
    files_changed: diffStats.files_changed > 0 ? diffStats.files_changed : null,
    lines_added: diffStats.lines_added > 0 ? diffStats.lines_added : null,
    lines_removed: diffStats.lines_removed > 0 ? diffStats.lines_removed : null,
  };
}

async function extractStaticFeatures(options: ExtractCandidateFeaturesOptions): Promise<StaticFeatures> {
  try {
    const staticOptions: StaticFeaturesOptions = {
      checkoutDir: options.checkoutDir,
      baseRef: options.baseRef,
      prNumber: options.prNumber,
      repoDir: options.repoDir,
    };
    const result = await collectStaticFeatures(staticOptions);
    return result;
  } catch (err) {
    const message = errorMessage(err);
    console.warn(`[candidate-features] Failed to collect static features: ${message}`);
    return {
      type_errors: null,
      lint_errors: null,
      build_ok: null,
      complexity_delta: null,
      build_evidence: null,
      complexity_metric: null,
    };
  }
}

function extractTestFeatures(diffStats: DiffStats): TestFeatures {
  return {
    test_files_changed: diffStats.test_files_changed > 0 ? diffStats.test_files_changed : null,
    test_changed_lines: diffStats.test_changed_lines > 0 ? diffStats.test_changed_lines : null,
  };
}

function extractIntentFeatures(
  _diffStats: DiffStats,
  _metadata: PrIdentityMetadata,
  enrichmentContext?: ExtractCandidateFeaturesOptions['enrichmentContext'],
): IntentFeatures {
  // Without enrichment context, all Intent fields are explicitly null.
  // The wavemill adapter will provide enrichment via deriveTaskDescriptor
  // when called from within a workflow with task context.

  if (!enrichmentContext) {
    return {
      touched_out_of_scope_files: null,
      modified_non_implementation_files: null,
      added_new_dependencies: null,
      schema_migration: null,
      database_change_risk: null,
    };
  }

  // With enrichment, derived fields are populated (not implemented here in phase 1)
  return {
    touched_out_of_scope_files: enrichmentContext.outOfScopeFiles
      ? enrichmentContext.outOfScopeFiles.length > 0
      : null,
    modified_non_implementation_files: null,
    added_new_dependencies: enrichmentContext.newDependencies ?? null,
    schema_migration: enrichmentContext.schemaChanges ?? null,
    database_change_risk: enrichmentContext.databaseChanges ? 'unknown' : null,
  };
}

function extractProvenanceFeatures(
  prNumber: string,
  metadata: PrIdentityMetadata,
): ProvenanceFeatures {
  return {
    pr_number: prNumber,
    head_sha: metadata.head_sha,
    base_ref: metadata.baseRefName,
    pr_url: metadata.url,
  };
}

// ────────────────────────────────────────────────────────────────
// Main Extractor
// ────────────────────────────────────────────────────────────────

export async function extractCandidateFeatures(
  options: ExtractCandidateFeaturesOptions,
): Promise<CandidateFeaturesV1> {
  try {
    // Resolve PR metadata (throws on invalid PR or missing metadata)
    const metadata = resolvePrIdentityMetadata(options.prNumber, options.repoDir || options.checkoutDir);

    // Fetch PR diff
    const diffResult = fetchPrDiff(options.prNumber, options.repoDir || options.checkoutDir);

    if (diffResult.kind !== 'diff') {
      // Diff unavailable; emit null for diff-dependent features
      console.warn(
        `[candidate-features] PR diff unavailable (${diffResult.reason}): ${diffResult.detail}`,
      );
      const emptyStatic = await extractStaticFeatures(options);
      return {
        shape: {
          files_changed: null,
          lines_added: null,
          lines_removed: null,
        },
        static: emptyStatic,
        test: {
          test_files_changed: null,
          test_changed_lines: null,
        },
        intent: extractIntentFeatures({} as DiffStats, metadata, options.enrichmentContext),
        provenance: extractProvenanceFeatures(options.prNumber, metadata),
      };
    }

    // Parse diff statistics
    const diffStats = parseDiffStats(diffResult.text);

    // Collect all feature groups
    const [shape, staticFeatures, test, intent, provenance] = await Promise.all([
      Promise.resolve(extractShapeFeatures(diffStats)),
      extractStaticFeatures(options),
      Promise.resolve(extractTestFeatures(diffStats)),
      Promise.resolve(extractIntentFeatures(diffStats, metadata, options.enrichmentContext)),
      Promise.resolve(extractProvenanceFeatures(options.prNumber, metadata)),
    ]);

    return {
      shape,
      static: staticFeatures,
      test,
      intent,
      provenance,
    };
  } catch (err) {
    const message = errorMessage(err);
    console.error(`[candidate-features] Failed to extract features: ${message}`);
    throw err;
  }
}

/**
 * Wavemill adapter: extract candidate features with optional task descriptor enrichment.
 *
 * This is the entry point for calling the extractor from within wavemill workflows.
 * It differs from the standalone extractCandidateFeatures by accepting a derived task
 * descriptor (from @hokusai/core's deriveTaskDescriptor) to enrich Intent features.
 *
 * When called without enrichment, yields the same output as extractCandidateFeatures.
 *
 * @internal Used by wavemill post-completion hook and outcome collectors.
 */
export async function extractCandidateFeaturesForWavemill(
  options: ExtractCandidateFeaturesOptions,
): Promise<CandidateFeaturesV1> {
  // Phase 3: Thin wavemill adapter.
  // In a full implementation, this would:
  // 1. Read the task descriptor from wavemill state (already derived by caller)
  // 2. Compute Intent enrichment from the descriptor + PR diff
  // 3. Pass enrichmentContext to extractCandidateFeatures
  //
  // For now, it's a passthrough. Intent will be fully null.
  // TODO: Add Intent enrichment logic when task descriptor context is available.

  return extractCandidateFeatures(options);
}
