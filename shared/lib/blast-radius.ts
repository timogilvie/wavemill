/**
 * Blast-radius classifier (HOK-3238).
 *
 * A pure path-based classifier that labels a set of changed files `high` iff
 * any file matches one of the mill-core patterns (monitor, tend, merge-labels,
 * reconciler, state writers, ready stage, invariant checker). Everything else
 * is `normal`. The library is intentionally tiny: three callers consume it —
 * the router floor (`workflow-router.ts`), the review prompt gatherer
 * (`review-context-gatherer.ts`), and the post-promotion bake gate inside
 * `state-invariants.ts`. New mill-core paths belong in `MILL_CORE_PATTERNS`.
 *
 * @module blast-radius
 */

export type BlastRadius = 'high' | 'normal';

export interface BlastRadiusEvaluation {
  radius: BlastRadius;
  /** Files that triggered a `high` radius. Deduplicated and sorted. */
  matchedFiles: string[];
  /** Patterns (source strings) that matched a file. Deduplicated and sorted. */
  matchedPatterns: string[];
}

/**
 * Case-sensitive substring patterns, matched against repo-relative paths.
 * Each entry targets a specific mill-core surface from the HOK-3238 task-packet
 * B2 path list. A single file may match multiple patterns; the evaluator
 * reports every matched pattern for operator traceability.
 */
export const MILL_CORE_PATTERNS: readonly RegExp[] = [
  // Monitor loop
  /shared\/lib\/wavemill-monitor\.sh/,
  /tools\/wavemill-monitor\.ts/,
  // Merge executor
  /shared\/lib\/tend-loop\.ts/,
  /shared\/lib\/tend-controller\.ts/,
  /tools\/tend\.ts/,
  // Label reconciler core
  /shared\/lib\/merge-labels\.ts/,
  /shared\/lib\/pr-state-labels\.ts/,
  // Condition reconciler
  /shared\/lib\/condition-reconciler\.sh/,
  /shared\/lib\/condition-marker\.ts/,
  // State writers
  /shared\/lib\/workflow-state\.ts/,
  /shared\/schemas\/workflow-task\.schema\.json/,
  /shared\/schemas\/task-lifecycle-state\.schema\.json/,
  // Ready stage
  /shared\/lib\/ready-stage\.ts/,
  /shared\/lib\/ready-watchdog\.ts/,
  // Invariant checker itself
  /shared\/lib\/state-invariants\.ts/,
  /tools\/state-invariants\.ts/,
];

/**
 * Classify a changed-file set. Returns `'high'` iff at least one file matches
 * a mill-core pattern. An empty list returns `'normal'` (safe default).
 */
export function getBlastRadius(files: readonly string[]): BlastRadius {
  for (const file of files) {
    if (!file) continue;
    for (const pattern of MILL_CORE_PATTERNS) {
      if (pattern.test(file)) return 'high';
    }
  }
  return 'normal';
}

/**
 * Classify a changed-file set and report which files/patterns triggered a
 * `'high'` label. Deterministic: matchedFiles is deduplicated and sorted,
 * matchedPatterns is deduplicated by source string and sorted.
 */
export function evaluateBlastRadius(files: readonly string[]): BlastRadiusEvaluation {
  const matchedFiles = new Set<string>();
  const matchedPatterns = new Set<string>();
  for (const file of files) {
    if (!file) continue;
    for (const pattern of MILL_CORE_PATTERNS) {
      if (pattern.test(file)) {
        matchedFiles.add(file);
        matchedPatterns.add(pattern.source);
      }
    }
  }
  const radius: BlastRadius = matchedFiles.size > 0 ? 'high' : 'normal';
  return {
    radius,
    matchedFiles: [...matchedFiles].sort(),
    matchedPatterns: [...matchedPatterns].sort(),
  };
}
