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

import { callClaude, type LLMCallResult } from './llm-cli.ts';
import { fillPromptTemplate } from './prompt-utils.ts';
import { startHeartbeat } from './progress-heartbeat.ts';
import { createIssue, createIssueRelation } from './linear.ts';

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
  /** LLM model to use (default: PLAN_MODEL env or claude-opus-4-7) */
  model?: string;
  /**
   * Enable interactive mode (allows Claude to use tools).
   * When true: Claude can use WebFetch, AskUserQuestion, Read, etc.
   * When false: Claude has no tools, must output pure JSON.
   * Default: false (backward compatible)
   */
  interactive?: boolean;
  /**
   * Timeout in milliseconds for the Claude call.
   * Default: 600_000 (10 min) for interactive mode, 120_000 (2 min) for non-interactive.
   */
  timeout?: number;
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

  // Smart timeout: 10 min for interactive (allows tool use), 2 min for non-interactive
  const timeout = opts.timeout ?? (isInteractive ? 600_000 : 120_000);

  // Build CLI flags based on mode
  const cliFlags: string[] = [];

  if (isInteractive) {
    // Interactive mode: Enable all tools, guide Claude to research then output JSON
    cliFlags.push('--append-system-prompt', INTERACTIVE_DECOMPOSE_PROMPT);
  } else {
    // Non-interactive mode: Disable tools, force pure JSON
    cliFlags.push('--tools', '', '--append-system-prompt', NON_INTERACTIVE_DECOMPOSE_PROMPT);
  }

  const stopHeartbeat = startHeartbeat({
    label: 'plan-decomposer',
    initialMessage: '  (This typically takes 1-3 minutes. You can leave this running.)',
  });

  let result: LLMCallResult;
  try {
    result = await callClaude(fullPrompt, {
      mode: 'stream',
      model: opts.model || process.env.PLAN_MODEL || 'claude-opus-4-7',
      taskType: 'planning',
      cliFlags,
      timeout,
    });
  } finally {
    stopHeartbeat();
  }

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
  /** LLM model to use (default: PLAN_MODEL env or claude-opus-4-7) */
  model?: string;
  /**
   * Enable interactive mode (allows Claude to use tools).
   * When true: Claude can use WebFetch, AskUserQuestion, Read, etc.
   * When false: Claude has no tools, must output pure markdown.
   * Default: false (backward compatible)
   */
  interactive?: boolean;
  /**
   * Timeout in milliseconds for the Claude call.
   * Default: 600_000 (10 min) for interactive mode, 120_000 (2 min) for non-interactive.
   */
  timeout?: number;
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

  // Smart timeout: 10 min for interactive (allows tool use), 2 min for non-interactive
  const timeout = opts.timeout ?? (isInteractive ? 600_000 : 120_000);

  // Build CLI flags based on mode
  const cliFlags: string[] = [];

  if (isInteractive) {
    // Interactive mode: Enable all tools, guide Claude to research then output markdown
    cliFlags.push('--append-system-prompt', INTERACTIVE_RESEARCH_PROMPT);
  } else {
    // Non-interactive mode: Disable tools, force pure markdown
    cliFlags.push('--tools', '', '--append-system-prompt', NON_INTERACTIVE_RESEARCH_PROMPT);
  }

  const stopHeartbeat = startHeartbeat({
    label: 'plan-decomposer',
    initialMessage: '  (This typically takes 1-3 minutes. You can leave this running.)',
  });

  let result: LLMCallResult;
  try {
    result = await callClaude(fullPrompt, {
      mode: 'stream',
      model: opts.model || process.env.PLAN_MODEL || 'claude-opus-4-7',
      taskType: 'planning',
      cliFlags,
      timeout,
    });
  } finally {
    stopHeartbeat();
  }

  return result.text;
}

// ────────────────────────────────────────────────────────────────
// Issue Creation With Dependencies
// ────────────────────────────────────────────────────────────────

/**
 * One issue to create as part of a batch.
 */
export interface IssueCreationSpec {
  /** Issue title. */
  title: string;
  /** Issue description (markdown). */
  description: string;
  /** Linear priority number (0-4). */
  priority?: number;
  /** Grouping name (for example a milestone) resolved by `resolveMilestoneId`. */
  milestone?: string;
  /** Team label ids applied to this issue only. */
  labelIds?: string[];
  /** Indexes, earlier in the same array, that block this issue. */
  blockedBy?: number[];
}

/** An issue created by {@link createIssuesWithDependencies}. */
export interface CreatedIssue {
  id: string;
  identifier: string;
  title: string;
  url?: string;
}

export interface CreateIssuesOptions {
  /** Team the issues are created in. */
  teamId: string;
  /** Optional project for every created issue. */
  projectId?: string;
  /** Label ids applied to every created issue. */
  labelIds?: string[];
  /** Resolve a milestone name to a project milestone id. */
  resolveMilestoneId?: (name: string) => Promise<string | undefined>;
  /** Progress logger (defaults to silence). */
  log?: (message: string) => void;
}

export interface CreateIssuesResult {
  /** Created issues, in the same order as `specs`. */
  created: CreatedIssue[];
  specs: IssueCreationSpec[];
}

/**
 * Create a batch of Linear issues and their `blocks` relations.
 *
 * Shared by plan decomposition and task splitting (HOK-3469): callers describe
 * issues and their dependencies as data, and this function owns the ordering
 * rules (create every issue first, then relations pointing at earlier indexes).
 * Invalid dependency indexes (out of range, self-references) are skipped rather
 * than failing the batch, matching the historical plan-decomposition behaviour.
 */
export async function createIssuesWithDependencies(
  specs: IssueCreationSpec[],
  options: CreateIssuesOptions,
): Promise<CreateIssuesResult> {
  const log = options.log ?? (() => {});
  const milestoneCache = new Map<string, string | undefined>();
  const created: CreatedIssue[] = [];

  for (const spec of specs) {
    let milestoneId: string | undefined;
    if (spec.milestone && options.resolveMilestoneId) {
      if (!milestoneCache.has(spec.milestone)) {
        milestoneCache.set(spec.milestone, await options.resolveMilestoneId(spec.milestone));
      }
      milestoneId = milestoneCache.get(spec.milestone);
    }
    const labelIds = [...(options.labelIds ?? []), ...(spec.labelIds ?? [])];
    log(`  Creating: ${spec.title}`);
    const issue = await createIssue({
      title: spec.title,
      description: spec.description,
      teamId: options.teamId,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(milestoneId ? { projectMilestoneId: milestoneId } : {}),
      ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
      ...(labelIds.length > 0 ? { labelIds } : {}),
    });
    created.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title ?? spec.title,
      ...(issue.url ? { url: issue.url } : {}),
    });
    log(`    ✓ ${issue.identifier}${issue.url ? ` - ${issue.url}` : ''}`);
  }

  for (let i = 0; i < specs.length; i++) {
    for (const depIndex of specs[i].blockedBy ?? []) {
      if (!Number.isInteger(depIndex) || depIndex < 0 || depIndex >= created.length || depIndex === i) {
        continue;
      }
      log(`  ${created[i].identifier} blocked by ${created[depIndex].identifier}`);
      await createIssueRelation(created[depIndex].id, created[i].id, 'blocks');
    }
  }

  return { created, specs };
}
