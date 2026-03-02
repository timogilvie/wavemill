/**
 * Plan Decomposer
 *
 * LLM-powered decomposition of initiatives into structured plans.
 * Uses Claude to analyze initiative descriptions and generate:
 * - Milestone breakdown
 * - Issue decomposition with dependencies
 * - Research summaries (optional)
 *
 * @module plan-decomposer
 */

import { callClaude } from './llm-cli.ts';
import { fillPromptTemplate } from './prompt-utils.ts';

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Decompose an initiative using Claude LLM.
 *
 * Takes a system prompt and initiative context, calls Claude with
 * tool calling disabled, and returns raw JSON output that should be
 * parsed and validated with plan-validator.ts.
 *
 * @param systemPrompt - Prompt template with decomposition instructions
 * @param initiativeContext - Initiative details (name, description, projects)
 * @param model - LLM model to use (default: PLAN_MODEL env or claude-opus-4-6)
 * @returns Raw LLM output (JSON string)
 *
 * @example
 * ```typescript
 * const prompt = await fs.readFile('prompts/initiative-planner.md', 'utf-8');
 * const context = formatInitiativeContext(initiative);
 * const rawOutput = await decomposeWithClaude(prompt, context);
 * const plan = parseJsonFromLLM<PlanOutput>(rawOutput);
 * ```
 */
export async function decomposeWithClaude(
  systemPrompt: string,
  initiativeContext: string,
  model?: string
): Promise<string> {
  const fullPrompt = fillPromptTemplate(systemPrompt, {
    INITIATIVE_CONTEXT: initiativeContext,
  });

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    model: model || process.env.PLAN_MODEL || 'claude-opus-4-6',
    cliFlags: [
      '--tools',
      '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be valid JSON matching the specified schema. No conversational text, no preamble, no markdown code fences. Start directly with the opening { brace.',
    ],
  });

  return result.text;
}

/**
 * Run research phase for an initiative.
 *
 * Similar to decomposeWithClaude but optimized for research output
 * (markdown summary instead of JSON). Used for optional pre-planning
 * research that gets injected into the decomposition context.
 *
 * @param researchPrompt - Research prompt template
 * @param initiativeContext - Initiative details
 * @param model - LLM model to use (default: PLAN_MODEL env or claude-opus-4-6)
 * @returns Markdown research summary
 *
 * @example
 * ```typescript
 * const prompt = await fs.readFile('prompts/research-phase.md', 'utf-8');
 * const context = formatInitiativeContext(initiative);
 * const research = await runResearch(prompt, context);
 * // Append research to context before decomposition
 * ```
 */
export async function runResearch(
  researchPrompt: string,
  initiativeContext: string,
  model?: string
): Promise<string> {
  const fullPrompt = fillPromptTemplate(researchPrompt, {
    INITIATIVE_CONTEXT: initiativeContext,
  });

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    model: model || process.env.PLAN_MODEL || 'claude-opus-4-6',
    cliFlags: [
      '--tools',
      '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the structured markdown research summary and nothing else. No conversational text, no preamble. Start directly with the first markdown heading.',
    ],
  });

  return result.text;
}
