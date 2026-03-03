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
// Constants
// ────────────────────────────────────────────────────────────────

const INTERACTIVE_DECOMPOSE_PROMPT = `You are an interactive planning assistant. You have FULL tool access:

- **WebFetch**: Fetch external URLs (GitHub PRs, docs, RFCs)
- **AskUserQuestion**: Ask clarifying questions when requirements are unclear
- **Read**: Read files from the codebase
- **Grep/Glob**: Search the codebase for patterns

## Workflow

1. **RESEARCH PHASE**: Gather context first
   - If external URLs are referenced, use WebFetch to retrieve them
   - If requirements are unclear, use AskUserQuestion to clarify
   - If files are mentioned, use Read to examine them
   - Take your time to gather all necessary context

2. **OUTPUT PHASE**: After research, output your decomposition as a JSON code block
   - Wrap in markdown code fence: \`\`\`json ... \`\`\`
   - Must match the schema in the prompt template
   - Include epic_summary and milestones

Do NOT rush to output. Research thoroughly first, THEN output JSON.`;

const NON_INTERACTIVE_DECOMPOSE_PROMPT = `You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be valid JSON matching the specified schema. No conversational text, no preamble, no markdown code fences. Start directly with the opening { brace.`;

const INTERACTIVE_RESEARCH_PROMPT = `You are an interactive research assistant. You have FULL tool access:

- **WebFetch**: Research comparable products, docs, articles
- **AskUserQuestion**: Ask clarifying questions about the domain
- **Read**: Read relevant codebase files
- **Grep/Glob**: Search for patterns and examples

## Workflow

1. **RESEARCH PHASE**: Investigate thoroughly
   - If you need information about comparable products, use WebFetch
   - If the domain is unclear, use AskUserQuestion
   - Use Read to examine relevant files if needed

2. **OUTPUT PHASE**: After research, output structured markdown
   - Follow the template: Comparable Products, Key Patterns, Anti-Patterns, Scope Adjustments
   - Be concise (max 300 words)
   - Start directly with the first markdown heading

Take your time to research. Do NOT rush to output.`;

const NON_INTERACTIVE_RESEARCH_PROMPT = `You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the structured markdown research summary and nothing else. No conversational text, no preamble. Start directly with the first markdown heading.`;

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Individual issue in a decomposed plan.
 */
export interface PlanIssue {
  /** Issue title */
  title: string;
  /** User story (brief narrative) */
  user_story: string;
  /** Detailed description */
  description: string;
  /** Array of dependency indices (refers to position in allIssues array) */
  dependencies: number[];
  /** Priority level (P0-P3) */
  priority: string;
}

/**
 * Milestone grouping issues together.
 */
export interface PlanMilestone {
  /** Milestone name */
  name: string;
  /** Issues in this milestone */
  issues: PlanIssue[];
}

/**
 * Complete decomposed plan output from LLM.
 */
export interface PlanOutput {
  /** High-level summary of the epic */
  epic_summary: string;
  /** Ordered list of milestones */
  milestones: PlanMilestone[];
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Convert priority string to Linear priority number.
 *
 * Maps:
 * - P0 → 1 (Urgent)
 * - P1 → 2 (High)
 * - P2 → 3 (Normal)
 * - P3 → 4 (Low)
 * - Other → 3 (Normal)
 *
 * @param priority - Priority string (P0-P3)
 * @returns Linear priority number (1-4)
 *
 * @example
 * ```typescript
 * priorityToNumber('P0'); // 1
 * priorityToNumber('P2'); // 3
 * priorityToNumber('unknown'); // 3
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

/**
 * Options for decomposing with Claude.
 */
export interface DecomposeOptions {
  /** System prompt template with decomposition instructions */
  systemPrompt: string;
  /** Initiative details (name, description, projects) */
  initiativeContext: string;
  /** LLM model to use (default: PLAN_MODEL env or claude-opus-4-6) */
  model?: string;
  /**
   * Enable interactive mode (allows Claude to use tools).
   * When true: Claude can use WebFetch, AskUserQuestion, Read, etc.
   * When false: Claude has no tools, must output pure JSON.
   * Default: false (backward compatible)
   */
  interactive?: boolean;
}

/**
 * Decompose an initiative using Claude LLM.
 *
 * Supports two modes:
 * - **Non-interactive** (default): Tools disabled, pure JSON output
 * - **Interactive**: Full tool access (WebFetch, AskUserQuestion, Read)
 *
 * @param options - Decomposition options
 * @returns Raw LLM output (JSON string)
 *
 * @example
 * ```typescript
 * // Non-interactive (backward compatible)
 * const prompt = await fs.readFile('prompts/initiative-planner.md', 'utf-8');
 * const context = formatInitiativeContext(initiative);
 * const rawOutput = await decomposeWithClaude({
 *   systemPrompt: prompt,
 *   initiativeContext: context,
 * });
 *
 * // Interactive (with tools)
 * const rawOutput = await decomposeWithClaude({
 *   systemPrompt: prompt,
 *   initiativeContext: context,
 *   interactive: true,
 * });
 * ```
 */
export async function decomposeWithClaude(
  options: DecomposeOptions | string,
  initiativeContext?: string,
  model?: string
): Promise<string> {
  // Support both new object API and legacy positional arguments
  let opts: DecomposeOptions;
  if (typeof options === 'string') {
    // Legacy API: decomposeWithClaude(systemPrompt, initiativeContext, model)
    opts = {
      systemPrompt: options,
      initiativeContext: initiativeContext || '',
      model,
      interactive: false,
    };
  } else {
    opts = options;
  }

  const fullPrompt = fillPromptTemplate(opts.systemPrompt, {
    INITIATIVE_CONTEXT: opts.initiativeContext,
  });

  const isInteractive = opts.interactive ?? false;

  // Build CLI flags based on mode
  const cliFlags: string[] = [];

  if (isInteractive) {
    // Interactive mode: Enable all tools, guide Claude to research then output JSON
    cliFlags.push('--append-system-prompt', INTERACTIVE_DECOMPOSE_PROMPT);
  } else {
    // Non-interactive mode: Disable tools, force pure JSON
    cliFlags.push('--tools', '', '--append-system-prompt', NON_INTERACTIVE_DECOMPOSE_PROMPT);
  }

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    model: opts.model || process.env.PLAN_MODEL || 'claude-opus-4-6',
    cliFlags,
  });

  return result.text;
}

/**
 * Options for running research phase.
 */
export interface ResearchOptions {
  /** Research prompt template */
  researchPrompt: string;
  /** Initiative details (name, description, projects) */
  initiativeContext: string;
  /** LLM model to use (default: PLAN_MODEL env or claude-opus-4-6) */
  model?: string;
  /**
   * Enable interactive mode (allows Claude to use tools).
   * When true: Claude can use WebFetch, AskUserQuestion, Read, etc.
   * When false: Claude has no tools, must output pure markdown.
   * Default: false (backward compatible)
   */
  interactive?: boolean;
}

/**
 * Run research phase for an initiative.
 *
 * Similar to decomposeWithClaude but optimized for research output
 * (markdown summary instead of JSON). Used for optional pre-planning
 * research that gets injected into the decomposition context.
 *
 * Supports two modes:
 * - **Non-interactive** (default): Tools disabled, pure markdown output
 * - **Interactive**: Full tool access (WebFetch for researching comparables)
 *
 * @param options - Research options
 * @returns Markdown research summary
 *
 * @example
 * ```typescript
 * // Non-interactive (backward compatible)
 * const prompt = await fs.readFile('prompts/research-phase.md', 'utf-8');
 * const context = formatInitiativeContext(initiative);
 * const research = await runResearch({
 *   researchPrompt: prompt,
 *   initiativeContext: context,
 * });
 *
 * // Interactive (with tools)
 * const research = await runResearch({
 *   researchPrompt: prompt,
 *   initiativeContext: context,
 *   interactive: true,
 * });
 * ```
 */
export async function runResearch(
  options: ResearchOptions | string,
  initiativeContext?: string,
  model?: string
): Promise<string> {
  // Support both new object API and legacy positional arguments
  let opts: ResearchOptions;
  if (typeof options === 'string') {
    // Legacy API: runResearch(researchPrompt, initiativeContext, model)
    opts = {
      researchPrompt: options,
      initiativeContext: initiativeContext || '',
      model,
      interactive: false,
    };
  } else {
    opts = options;
  }

  const fullPrompt = fillPromptTemplate(opts.researchPrompt, {
    INITIATIVE_CONTEXT: opts.initiativeContext,
  });

  const isInteractive = opts.interactive ?? false;

  // Build CLI flags based on mode
  const cliFlags: string[] = [];

  if (isInteractive) {
    // Interactive mode: Enable all tools, guide Claude to research then output markdown
    cliFlags.push('--append-system-prompt', INTERACTIVE_RESEARCH_PROMPT);
  } else {
    // Non-interactive mode: Disable tools, force pure markdown
    cliFlags.push('--tools', '', '--append-system-prompt', NON_INTERACTIVE_RESEARCH_PROMPT);
  }

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    model: opts.model || process.env.PLAN_MODEL || 'claude-opus-4-6',
    cliFlags,
  });

  return result.text;
}
