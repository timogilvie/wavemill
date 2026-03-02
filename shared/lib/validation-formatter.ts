/**
 * Validation Formatter
 *
 * Formats validation issues for display to users.
 * Provides human-readable output for task packet validation results.
 *
 * @module validation-formatter
 */

import type { ValidationIssue } from './task-packet-validator.ts';

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Format validation issues for display.
 *
 * Groups issues by severity (errors, warnings) and formats them
 * with clear visual hierarchy. Returns a string suitable for
 * console output.
 *
 * @param issues - Array of validation issues
 * @returns Formatted string with errors and warnings
 *
 * @example
 * ```typescript
 * const result = await validateTaskPacket(content, repoPath);
 * console.log(formatValidationIssues(result.issues));
 * // Output:
 * // ❌ ERRORS (2):
 * //
 * // 1. [missing_section] Section 1
 * //    Missing required section: Objective
 * //    → Add a "## 1. Objective" section with clear goals
 * //
 * // ⚠️  WARNINGS (1):
 * // ...
 * ```
 */
export function formatValidationIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return '✓ No validation issues found';
  }

  // Group by severity
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  let output = '';

  if (errors.length > 0) {
    output += `\n❌ ERRORS (${errors.length}):\n`;
    errors.forEach((issue, idx) => {
      output += `\n${idx + 1}. [${issue.type}] ${issue.section}\n`;
      output += `   ${issue.description}\n`;
      output += `   → ${issue.suggestedFix}\n`;
    });
  }

  if (warnings.length > 0) {
    output += `\n⚠️  WARNINGS (${warnings.length}):\n`;
    warnings.forEach((issue, idx) => {
      output += `\n${idx + 1}. [${issue.type}] ${issue.section}\n`;
      output += `   ${issue.description}\n`;
      output += `   → ${issue.suggestedFix}\n`;
    });
  }

  return output;
}
