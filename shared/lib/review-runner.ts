/**
 * Review runner - Wrapper for review engine for local changes.
 *
 * Provides backward-compatible interface for reviewing local changes.
 * Delegates all review logic to shared/lib/review-engine.ts
 *
 * @module review-runner
 */

import { resolve } from 'node:path';
import {
  gatherReviewContext,
} from './review-context-gatherer.ts';
import { runReview, type ReviewResult, type ReviewFinding } from './review-engine.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReviewOptions {
  /** Branch to diff against (default: "main") */
  targetBranch?: string;
  /** Repository directory (default: cwd) */
  repoDir?: string;
  /** Skip UI verification even if design context exists */
  skipUi?: boolean;
  /** Run only UI verification (skip code review) */
  uiOnly?: boolean;
  /** Print verbose output */
  verbose?: boolean;
}

// Re-export types from review-engine for backward compatibility
export type { ReviewFinding, ReviewResult } from './review-engine.ts';


// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Run a code review on the current branch.
 *
 * This is a backward-compatible wrapper that gathers local change context
 * and delegates to the shared review engine.
 *
 * @param options - Review configuration options
 * @returns ReviewResult with verdict and findings
 */
export async function reviewChanges(
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  const targetBranch = options.targetBranch || 'main';
  const repoDir = options.repoDir ? resolve(options.repoDir) : process.cwd();

  // Gather review context (skip design standards if explicitly requested)
  const context = gatherReviewContext(targetBranch, repoDir, {
    designStandards: !options.skipUi,
  });

  // Delegate to review engine
  return runReview(context, repoDir, {
    skipUi: options.skipUi,
    verbose: options.verbose,
  });
}
