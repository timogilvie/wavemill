/**
 * Prompt Template Utilities
 *
 * Provides utilities for filling prompt templates with context variables.
 * Used by expand-issue.ts, plan-initiative.ts, and other tools that work
 * with LLM prompts.
 *
 * @module prompt-utils
 */

import { readFile } from 'node:fs/promises';
import { logPromptUsage, type RegistryOptions } from './prompt-registry.ts';

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
      // Replacer function: a string replacement would expand `$&`, `$'` and `$\``.
      result = result.replaceAll(placeholder, () => value);
    }
  }

  return result;
}

/**
 * Substitute `{{NAME}}` slots in one pass over the template only.
 *
 * - A slot is a placeholder alone on its line. Review templates also mention
 *   placeholders inline (the "Template Parameters" list, conditional prose);
 *   those stay literal. Templates without a standalone slot fall back to the
 *   first occurrence.
 * - Values are inserted verbatim through a replacer function. A string
 *   replacement would expand `$\``, `$'` and `$&` found in diffs, plans and
 *   packets — each `$\`` re-inserts everything before the match, which turned
 *   a 2.7 MB diff into a 32 MB review prompt.
 * - Filled values are never rescanned, so placeholder text inside a diff or
 *   plan is not substituted.
 */
export function fillPromptSlots(template: string, values: Record<string, string>): string {
  const names = Object.keys(values).filter((name) => /^[A-Z_]+$/.test(name));
  if (names.length === 0) return template;
  const alternation = names.join('|');
  const standalone = new Set(
    [...template.matchAll(new RegExp(`^\\{\\{(${alternation})\\}\\}$`, 'gm'))].map((match) => match[1]),
  );
  const filled = new Set<string>();
  return template.replace(
    new RegExp(`^\\{\\{(${alternation})\\}\\}$|\\{\\{(${alternation})\\}\\}`, 'gm'),
    (match, slotName: string | undefined, inlineName: string | undefined) => {
      const name = slotName ?? inlineName!;
      if (filled.has(name)) return match;
      if (slotName === undefined && standalone.has(name)) return match;
      filled.add(name);
      return values[name];
    },
  );
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

/**
 * Load a prompt template file and optionally log its usage to the prompt registry.
 *
 * This is the recommended way to load templates as it automatically tracks
 * template versions for GEPA training attribution. The registry logging uses
 * graceful degradation - failures won't prevent the template from loading.
 *
 * @param templatePath - Path to the template file (e.g., "tools/prompts/issue-writer.md")
 * @param options - Optional configuration
 * @param options.dir - Override directory for registry storage
 * @param options.skipRegistry - Skip registry logging (default: false)
 * @returns The template content
 * @throws {Error} If the template file cannot be read
 *
 * @example
 * ```typescript
 * // Load template with automatic registry logging
 * const template = await loadPromptTemplate("tools/prompts/issue-writer.md");
 *
 * // Load template without registry logging
 * const template = await loadPromptTemplate(
 *   "tools/prompts/issue-writer.md",
 *   { skipRegistry: true }
 * );
 * ```
 */
export async function loadPromptTemplate(
  templatePath: string,
  options?: RegistryOptions & { skipRegistry?: boolean }
): Promise<string> {
  const content = await readFile(templatePath, 'utf-8');

  if (!options?.skipRegistry) {
    try {
      logPromptUsage(templatePath, content, { dir: options?.dir });
    } catch (err) {
      // Log warning but don't fail - registry is metadata
      console.warn(`[prompt-registry] Failed to log: ${err}`);
    }
  }

  return content;
}
