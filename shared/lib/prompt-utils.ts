/**
 * Prompt Template Utilities
 *
 * Provides utilities for filling prompt templates with context variables.
 * Used by expand-issue.ts, plan-initiative.ts, and other tools that work
 * with LLM prompts.
 *
 * @module prompt-utils
 */

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Variables that can be substituted in prompt templates.
 * Common placeholders:
 * - {{ISSUE_CONTEXT}} - Issue details from Linear
 * - {{INITIATIVE_CONTEXT}} - Initiative/epic details
 * - {{CODEBASE_CONTEXT}} - Repository structure and conventions
 */
export interface PromptTemplateVars {
  ISSUE_CONTEXT?: string;
  INITIATIVE_CONTEXT?: string;
  CODEBASE_CONTEXT?: string;
  [key: string]: string | undefined;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Fill a prompt template with context variables.
 *
 * Replaces placeholders like {{VARIABLE_NAME}} with corresponding values
 * from the vars object. Case-sensitive.
 *
 * @param template - Template string with {{PLACEHOLDER}} markers
 * @param vars - Variables to substitute
 * @returns Filled template
 *
 * @example
 * ```typescript
 * const template = "Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}";
 * const filled = fillPromptTemplate(template, {
 *   ISSUE_CONTEXT: "HOK-123: Fix login bug",
 *   CODEBASE_CONTEXT: "Uses React + TypeScript"
 * });
 * ```
 */
export function fillPromptTemplate(
  template: string,
  vars: PromptTemplateVars
): string {
  let result = template;

  // Replace each variable (all occurrences)
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) {
      const placeholder = `{{${key}}}`;
      result = result.replaceAll(placeholder, value);
    }
  }

  return result;
}

/**
 * Fill a prompt template using positional arguments (legacy compatibility).
 *
 * This is a convenience wrapper for tools that use positional args instead
 * of named variables. Maps to the standard variable names.
 *
 * @param template - Template string
 * @param issueContext - Issue/initiative context (maps to ISSUE_CONTEXT or INITIATIVE_CONTEXT)
 * @param codebaseContext - Codebase context (maps to CODEBASE_CONTEXT)
 * @returns Filled template
 *
 * @example
 * ```typescript
 * const filled = fillPromptTemplatePositional(
 *   "Issue: {{ISSUE_CONTEXT}}",
 *   "HOK-123: Fix bug",
 *   "Uses React"
 * );
 * ```
 */
export function fillPromptTemplatePositional(
  template: string,
  issueContext: string,
  codebaseContext: string = ''
): string {
  // Auto-detect which variable name to use based on template content
  const usesInitiativeContext = template.includes('{{INITIATIVE_CONTEXT}}');

  return fillPromptTemplate(template, {
    [usesInitiativeContext ? 'INITIATIVE_CONTEXT' : 'ISSUE_CONTEXT']: issueContext,
    CODEBASE_CONTEXT: codebaseContext,
  });
}
