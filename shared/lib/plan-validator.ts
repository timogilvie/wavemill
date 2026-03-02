/**
 * Plan Validator
 *
 * Validates and transforms initiative plan output from LLM decomposition.
 * Used by plan-initiative.ts to ensure plans have the correct structure
 * before creating issues in Linear.
 *
 * @module plan-validator
 */

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * A single issue within a plan milestone.
 */
export interface PlanIssue {
  /** Issue title */
  title: string;
  /** User story (narrative description) */
  user_story: string;
  /** Detailed implementation description */
  description: string;
  /** Indices of issues this depends on (zero-based, within flat list) */
  dependencies: number[];
  /** Priority level (P0-P3) */
  priority: string;
}

/**
 * A milestone containing related issues.
 */
export interface PlanMilestone {
  /** Milestone name */
  name: string;
  /** Issues in this milestone */
  issues: PlanIssue[];
}

/**
 * Complete plan output from initiative decomposition.
 */
export interface PlanOutput {
  /** High-level summary of the epic/initiative */
  epic_summary: string;
  /** Milestones with their issues */
  milestones: PlanMilestone[];
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Validate that output conforms to PlanOutput schema.
 *
 * Type guard function that checks:
 * - epic_summary is a non-empty string
 * - milestones is a non-empty array
 * - Each milestone has a name and non-empty issues array
 * - Each issue has required fields (title, description, dependencies)
 *
 * @param output - Object to validate
 * @returns True if output is a valid PlanOutput
 *
 * @example
 * ```typescript
 * const parsed = JSON.parse(llmOutput);
 * if (!validatePlanOutput(parsed)) {
 *   throw new Error('Invalid plan structure');
 * }
 * // TypeScript now knows parsed is PlanOutput
 * ```
 */
export function validatePlanOutput(output: any): output is PlanOutput {
  if (!output || typeof output !== 'object') return false;
  if (!output.epic_summary || typeof output.epic_summary !== 'string')
    return false;
  if (!Array.isArray(output.milestones) || output.milestones.length === 0)
    return false;

  for (const milestone of output.milestones) {
    if (!milestone.name || typeof milestone.name !== 'string') return false;
    if (!Array.isArray(milestone.issues) || milestone.issues.length === 0)
      return false;

    for (const issue of milestone.issues) {
      if (!issue.title || typeof issue.title !== 'string') return false;
      if (!issue.description || typeof issue.description !== 'string')
        return false;
      if (!Array.isArray(issue.dependencies)) return false;
    }
  }

  return true;
}

/**
 * Convert priority string to Linear priority number.
 *
 * Maps P0-P3 to Linear's priority scale:
 * - P0 → 1 (Urgent)
 * - P1 → 2 (High)
 * - P2 → 3 (Normal)
 * - P3 → 4 (Low)
 * - Default → 3 (Normal)
 *
 * @param priority - Priority string (e.g., "P0", "P1")
 * @returns Linear priority number
 *
 * @example
 * ```typescript
 * const linearPriority = priorityToNumber('P0'); // 1 (Urgent)
 * const defaultPriority = priorityToNumber('Unknown'); // 3 (Normal)
 * ```
 */
export function priorityToNumber(priority: string): number {
  switch (priority) {
    case 'P0':
      return 1; // Urgent
    case 'P1':
      return 2; // High
    case 'P2':
      return 3; // Normal
    case 'P3':
      return 4; // Low
    default:
      return 3; // Normal
  }
}
