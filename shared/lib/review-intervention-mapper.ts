/**
 * Review Intervention Mapper
 *
 * Converts self-review findings (from review-metrics.ts) into intervention
 * records for eval scoring. Maps finding severity to intervention severity:
 * - blocker → high severity (0.20 penalty)
 * - warning → med severity (0.05 penalty)
 *
 * @module review-intervention-mapper
 */

import { loadMetrics, type ReviewMetric } from './review-metrics.ts';
import type { InterventionRecord } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Review intervention data separated by severity.
 */
export interface ReviewInterventionData {
  /** Intervention records for blocker findings (high severity) */
  blockers: InterventionRecord[];
  /** Intervention records for warning findings (med severity) */
  warnings: InterventionRecord[];
  /** Total count of blocker findings */
  blockerCount: number;
  /** Total count of warning findings */
  warningCount: number;
  /** Total iterations in the review run */
  totalIterations: number;
}

// ────────────────────────────────────────────────────────────────
// Core Functions
// ────────────────────────────────────────────────────────────────

/**
 * Find the most recent review metric for a given issue or branch.
 *
 * Filters metrics by issueId (if provided) or branchName (if provided),
 * then returns the most recent metric by timestamp.
 *
 * @param metrics - Array of review metrics from review-log.json
 * @param issueId - Optional Linear issue ID (e.g., "HOK-892")
 * @param branchName - Optional git branch name
 * @returns The most recent matching metric, or undefined if none found
 */
export function findRelevantReviewMetric(
  metrics: ReviewMetric[],
  issueId?: string,
  branchName?: string
): ReviewMetric | undefined {
  if (metrics.length === 0) {
    return undefined;
  }

  // Filter by issueId or branchName
  let filtered = metrics;

  if (issueId) {
    filtered = filtered.filter((m) => m.issueId === issueId);
  }

  if (branchName && filtered.length === 0) {
    // Fallback to branch name if no issueId match
    filtered = metrics.filter((m) => m.branch === branchName);
  }

  if (filtered.length === 0) {
    return undefined;
  }

  // Sort by timestamp (most recent first) and return the first
  filtered.sort((a, b) => {
    const dateA = new Date(a.timestamp).getTime();
    const dateB = new Date(b.timestamp).getTime();
    return dateB - dateA; // Descending order
  });

  return filtered[0];
}

/**
 * Convert a ReviewMetric to intervention records.
 *
 * Extracts all findings from all iterations and converts them to
 * InterventionRecord objects with appropriate severity mapping:
 * - blocker findings → high severity
 * - warning findings → med severity
 *
 * @param metric - Review metric to convert
 * @returns Review intervention data with blockers and warnings separated
 */
export function reviewMetricToInterventions(
  metric: ReviewMetric
): ReviewInterventionData {
  const blockers: InterventionRecord[] = [];
  const warnings: InterventionRecord[] = [];

  // Extract findings from all iterations
  for (const iteration of metric.iterations) {
    const timestamp = iteration.timestamp;

    // Process each finding in this iteration
    for (const finding of iteration.findings || []) {
      const note = `[self_review_${finding.severity}] [${finding.category}] ${finding.location}`;

      const record: InterventionRecord = {
        timestamp,
        type: 'bugfix', // Review findings are code quality issues
        severity: finding.severity === 'blocker' ? 'high' : 'med',
        note,
      };

      if (finding.severity === 'blocker') {
        blockers.push(record);
      } else {
        warnings.push(record);
      }
    }
  }

  return {
    blockers,
    warnings,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    totalIterations: metric.totalIterations,
  };
}

/**
 * Load review interventions for a specific issue or branch.
 *
 * This is the main entry point for the eval system. It:
 * 1. Loads all review metrics from .wavemill/review-log.json
 * 2. Finds the most recent metric for the given issue/branch
 * 3. Converts findings to intervention records
 *
 * @param opts - Options for loading review interventions
 * @returns Review intervention data, or empty data if no metrics found
 *
 * @example
 * ```typescript
 * const data = loadReviewInterventions({
 *   issueId: 'HOK-892',
 *   branchName: 'task/add-review-assessment',
 *   repoDir: process.cwd(),
 * });
 *
 * console.log(`Blockers: ${data.blockerCount}`);
 * console.log(`Warnings: ${data.warningCount}`);
 * ```
 */
export function loadReviewInterventions(opts: {
  issueId?: string;
  branchName?: string;
  repoDir: string;
  verbose?: boolean;
}): ReviewInterventionData {
  const { issueId, branchName, repoDir, verbose } = opts;

  // Default empty result
  const emptyResult: ReviewInterventionData = {
    blockers: [],
    warnings: [],
    blockerCount: 0,
    warningCount: 0,
    totalIterations: 0,
  };

  try {
    // Load all review metrics
    const metrics = loadMetrics(repoDir, verbose);

    if (metrics.length === 0) {
      if (verbose) {
        console.error('[review-intervention-mapper] No review metrics found');
      }
      return emptyResult;
    }

    // Find the most recent metric for this issue/branch
    const metric = findRelevantReviewMetric(metrics, issueId, branchName);

    if (!metric) {
      if (verbose) {
        console.error(
          `[review-intervention-mapper] No review metric found for ` +
            `issueId=${issueId || 'none'}, branch=${branchName || 'none'}`
        );
      }
      return emptyResult;
    }

    // Convert to interventions
    const data = reviewMetricToInterventions(metric);

    if (verbose) {
      console.error(
        `[review-intervention-mapper] Found review metric ${metric.id}: ` +
          `${data.blockerCount} blockers, ${data.warningCount} warnings ` +
          `(${data.totalIterations} iterations)`
      );
    }

    return data;
  } catch (error) {
    // Non-throwing - return empty result on any error
    if (verbose) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[review-intervention-mapper] Failed to load review interventions: ${message}`);
    }
    return emptyResult;
  }
}
