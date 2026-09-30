/**
 * Issue Expander
 *
 * Expands Linear issues into comprehensive task packets using LLM.
 * Provides utilities for:
 * - Parsing issue identifiers from URLs or direct IDs
 * - Formatting issue context for LLM consumption
 * - Calling Claude to expand issues
 * - Checking subsystem drift before expansion
 *
 * @module issue-expander
 */

import { linearIssueUrlRe, normalizeIssueId } from './task-identity.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { callClaude, type LLMCallOptions } from './llm-cli.ts';
import { fillPromptTemplate } from './prompt-utils.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { detectDriftForIssue, formatDriftWarning } from './drift-detector.ts';
import { errorMessage } from './error-utils.ts';
import { buildScopeConstraintContext, type OperatingMode } from './scope-shrinker.ts';
import {
  getContextWindowFloorsConfig,
  getNativeContextManagementConfig,
  getNativeExpansionConfig,
} from './config.ts';
import { estimatePromptTokens } from './native-agent/context-window-guard.ts';

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Extract issue identifier from various input formats.
 *
 * Handles:
 * - Full Linear URLs: https://linear.app/team/issue/HOK-123
 * - Direct identifiers: HOK-123
 *
 * @param input - URL or identifier
 * @returns Issue identifier (e.g., "HOK-123")
 * @throws Error if input format is invalid
 *
 * @example
 * ```typescript
 * parseIssueInput('https://linear.app/team/issue/HOK-123'); // "HOK-123"
 * parseIssueInput('HOK-123'); // "HOK-123"
 * parseIssueInput('invalid'); // throws Error
 * ```
 */
export function parseIssueInput(input: string): string {
  const trimmedInput = input.trim();

  // Pasted identifiers and Linear URLs may use lowercase letters.
  const urlMatch = linearIssueUrlRe('i').exec(trimmedInput);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const normalized = normalizeIssueId(trimmedInput.toUpperCase());
  if (normalized) return normalized;

  throw new Error(
    `Invalid issue identifier: ${input}. Expected format: TEAM-123 or Linear issue URL`
  );
}

/**
 * Format issue context for Claude.
 *
 * Converts a Linear issue object into structured markdown context
 * that includes metadata, relationships, and description.
 *
 * @param issue - Linear issue object
 * @returns Formatted markdown context
 *
 * @example
 * ```typescript
 * const issue = await getIssue('HOK-123');
 * const context = formatIssueContext(issue);
 * // Returns:
 * // # Issue Details
 * // **Issue ID**: HOK-123
 * // **Title**: Fix login bug
 * // ...
 * ```
 */
export function formatIssueContext(issue: any): string {
  let context = `# Issue Details\n\n`;
  context += `**Issue ID**: ${issue.identifier}\n`;
  context += `**Title**: ${issue.title}\n`;
  context += `**URL**: ${issue.url}\n`;
  context += `**State**: ${issue.state?.name || 'Unknown'}\n`;
  context += `**Project**: ${issue.project?.name || 'None'}\n`;
  context += `**Team**: ${issue.team?.name || 'Unknown'} (${issue.team?.key})\n`;

  if (issue.priority) {
    const priorities = ['No priority', 'Urgent', 'High', 'Normal', 'Low'];
    context += `**Priority**: ${priorities[issue.priority] || issue.priority}\n`;
  }

  if (issue.estimate) {
    context += `**Estimate**: ${issue.estimate} points\n`;
  }

  if (issue.assignee) {
    context += `**Assignee**: ${issue.assignee.name}\n`;
  }

  if (issue.labels?.nodes.length > 0) {
    context += `**Labels**: ${issue.labels.nodes.map((l: any) => l.name).join(', ')}\n`;
  }

  if (issue.parent) {
    context += `**Parent Issue**: ${issue.parent.identifier} - ${issue.parent.title}\n`;
  }

  if (issue.children?.nodes.length > 0) {
    context += `\n**Sub-tasks** (${issue.children.nodes.length}):\n`;
    issue.children.nodes.forEach((child: any) => {
      context += `- ${child.identifier}: ${child.title} (${child.state?.name})\n`;
    });
  }

  context += `\n## Current Description\n\n`;
  context += issue.description || '*(No description provided)*';

  return context;
}

export interface AuthoredLinksFooterParts {
  body: string;
  footer: string | null;
}

const HORIZONTAL_RULE_LINE_PATTERN = /(^|\n)[ \t]*---[ \t]*(?:\r?\n|$)/g;
const LINKS_FOOTER_START_PATTERN = /^[ \t]*---[ \t]*\r?\n##[ \t]+[^\n]*links[^\n]*(?:\r?\n|$)/i;

/**
 * Split a preserved authored-links footer from a Linear issue description.
 *
 * A footer is only recognized when the final trailing block starts with a
 * horizontal rule immediately followed by a level-two heading containing
 * "links". The returned footer is the exact source text from the delimiter
 * through EOF.
 */
export function extractAuthoredLinksFooter(description: string): AuthoredLinksFooterParts {
  let footerStart: number | null = null;
  for (const match of description.matchAll(HORIZONTAL_RULE_LINE_PATTERN)) {
    footerStart = match.index + match[1].length;
  }

  if (footerStart === null) {
    return { body: description, footer: null };
  }

  const possibleFooter = description.slice(footerStart);
  if (!LINKS_FOOTER_START_PATTERN.test(possibleFooter)) {
    return { body: description, footer: null };
  }

  return {
    body: description.slice(0, footerStart),
    footer: possibleFooter,
  };
}

/**
 * Append an extracted authored-links footer to generated task-packet content.
 */
export function appendAuthoredLinksFooter(content: string, footer: string | null): string {
  if (!footer) {
    return content;
  }

  const withoutTrailingDuplicate = content.endsWith(footer)
    ? content.slice(0, -footer.length)
    : content;

  return `${withoutTrailingDuplicate.trimEnd()}\n\n${footer}`;
}

const ISSUE_EXPANDER_CLI_FLAGS = [
  '--tools',
  '',
  '--append-system-prompt',
  'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the task packet markdown and nothing else. No conversational text, no preamble, no apologies, no questions. Start directly with the first markdown heading.',
];

export function buildIssueExpansionCallOptions(cliCmd?: string): LLMCallOptions {
  return {
    mode: 'stream',
    cliCmd: cliCmd || process.env.CLAUDE_CMD || 'claude',
    taskType: 'planning',
    cliFlags: ISSUE_EXPANDER_CLI_FLAGS,
    retry: true,
    maxRetries: 2,
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024,
  };
}

export interface NativeExpansionDeniedToolCall {
  tool: string;
  reason: string;
}

export interface NativeExpansionMetadata {
  agent: 'native-openai' | 'native-openrouter';
  model: string;
  provider: 'openai' | 'openrouter';
  api: string;
  transcriptPath: string;
  cost: number;
  durationMs: number;
  stopReason: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  deniedToolCalls: ReadonlyArray<NativeExpansionDeniedToolCall>;
}

export interface ExpandIssueOptions {
  promptTemplate: string;
  issueContext: string;
  codebaseContext?: string;
  claudeCmd?: string;
  mode?: OperatingMode;
  repoDir?: string;
  issueId?: string;
  env?: Record<string, string | undefined>;
}

export interface ExpandIssueResult {
  text: string;
  native?: NativeExpansionMetadata;
}

export interface PacketBudgetOptions {
  targetContextWindowTokens?: number;
  maxPacketTokens?: number;
  truncationMarker?: string;
}

export interface PacketBudgetResult {
  markdown: string;
  truncated: boolean;
  originalTokens: number;
  retainedTokens: number;
}

const DEFAULT_PACKET_TARGET_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_PACKET_TRUNCATION_MARKER = '\n\n[... truncated for context budget ...]';

interface ExpansionDispatchDecision {
  kind: 'default' | 'native';
  fallbackOnUnavailable: boolean;
}

export interface ExpandIssueInternals {
  expandIssueWithClaude?: typeof expandIssueWithClaude;
  runNativeExpansion?: (options: {
    promptTemplate: string;
    issueContext: string;
    codebaseContext: string;
    mode: OperatingMode;
    repoDir: string;
    issueId?: string;
    env?: Record<string, string | undefined>;
  }) => Promise<ExpandIssueResult>;
  importNativeExpansion?: () => Promise<{
    NativeExpansionUnavailableError: typeof Error;
    runNativeExpansion: NonNullable<ExpandIssueInternals['runNativeExpansion']>;
  }>;
}

export function resolveExpansionDispatch(repoDir?: string): ExpansionDispatchDecision {
  const nativeExpansion = getNativeExpansionConfig(repoDir);
  if (!nativeExpansion.enabled || !nativeExpansion.allowedForExpansion) {
    return {
      kind: 'default',
      fallbackOnUnavailable: nativeExpansion.fallbackOnUnavailable,
    };
  }

  return {
    kind: 'native',
    fallbackOnUnavailable: nativeExpansion.fallbackOnUnavailable,
  };
}

export function enforcePacketBudget(
  packetMarkdown: string,
  options: PacketBudgetOptions = {},
): PacketBudgetResult {
  const originalTokens = estimateMarkdownTokens(packetMarkdown);
  const maxPacketTokens = resolveMaxPacketTokens(options);
  if (originalTokens <= maxPacketTokens) {
    return {
      markdown: packetMarkdown,
      truncated: false,
      originalTokens,
      retainedTokens: originalTokens,
    };
  }

  const marker = options.truncationMarker ?? DEFAULT_PACKET_TRUNCATION_MARKER;
  const skeleton = buildRetainedPacketSkeleton(packetMarkdown);
  const budgetForBody = Math.max(0, maxPacketTokens - estimateMarkdownTokens(marker));
  const truncatedBody = truncateMarkdownToTokens(skeleton, budgetForBody);
  const markdown = `${truncatedBody.trimEnd()}${marker}`;
  return {
    markdown,
    truncated: true,
    originalTokens,
    retainedTokens: estimateMarkdownTokens(markdown),
  };
}

/**
 * Expand issue with Claude LLM.
 *
 * Calls Claude with the issue-writer prompt and context, returning
 * a comprehensive task packet. Tool calling is disabled to ensure
 * clean markdown output.
 *
 * @param promptTemplate - Issue-writer prompt template
 * @param issueContext - Formatted issue context
 * @param codebaseContext - Codebase context (optional)
 * @param claudeCmd - Claude CLI command (default: CLAUDE_CMD env or 'claude')
 * @returns Expanded task packet (markdown)
 *
 * @example
 * ```typescript
 * const prompt = await fs.readFile('prompts/issue-writer.md', 'utf-8');
 * const issueCtx = formatIssueContext(issue);
 * const codebaseCtx = await gatherCodebaseContext({...});
 * const taskPacket = await expandIssueWithClaude(prompt, issueCtx, codebaseCtx);
 * ```
 */
export async function expandIssueWithClaude(
  promptTemplate: string,
  issueContext: string,
  codebaseContext: string = '',
  claudeCmd?: string,
  mode: OperatingMode = 'normal',
): Promise<string> {
  // Fill template with context using placeholder substitution
  const fullPrompt = fillPromptTemplate(promptTemplate, {
    ISSUE_CONTEXT: issueContext,
    CODEBASE_CONTEXT: codebaseContext,
    DEGRADED_MODE_CONTEXT: buildScopeConstraintContext(mode),
  });

  const result = await callClaude(fullPrompt, buildIssueExpansionCallOptions(claudeCmd));

  return result.text;
}

export async function expandIssue(
  options: ExpandIssueOptions,
  internals: ExpandIssueInternals = {},
): Promise<ExpandIssueResult> {
  const repoDir = options.repoDir ?? process.cwd();
  const codebaseContext = options.codebaseContext ?? '';
  const mode = options.mode ?? 'normal';
  const dispatch = resolveExpansionDispatch(repoDir);
  const callClaudeImpl = internals.expandIssueWithClaude ?? expandIssueWithClaude;

  if (dispatch.kind === 'native') {
    const loadNativeExpansion = internals.importNativeExpansion
      ?? (async () => await import('./native-expansion.ts'));
    const nativeModule = await loadNativeExpansion();

    try {
      const runNativeExpansion = internals.runNativeExpansion ?? nativeModule.runNativeExpansion;
      const result = await runNativeExpansion({
        promptTemplate: options.promptTemplate,
        issueContext: options.issueContext,
        codebaseContext,
        mode,
        repoDir,
        issueId: options.issueId,
        env: options.env,
      });
      return applyPacketBudget(result, repoDir);
    } catch (error) {
      const NativeExpansionUnavailableError = nativeModule.NativeExpansionUnavailableError;
      if (error instanceof NativeExpansionUnavailableError) {
        if (dispatch.fallbackOnUnavailable) {
          console.warn(`[native-expansion] ${error.message}; falling back to Claude expansion`);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  const text = await callClaudeImpl(
    options.promptTemplate,
    options.issueContext,
    codebaseContext,
    options.claudeCmd,
    mode,
  );
  return applyPacketBudget({ text }, repoDir);
}

function applyPacketBudget(result: ExpandIssueResult, repoDir: string): ExpandIssueResult {
  const floors = getContextWindowFloorsConfig(repoDir);
  const contextManagement = getNativeContextManagementConfig(repoDir);
  const budget = enforcePacketBudget(result.text, {
    targetContextWindowTokens: floors.coding ?? DEFAULT_PACKET_TARGET_CONTEXT_WINDOW_TOKENS,
    maxPacketTokens: floors.coding
      ? Math.floor(floors.coding * contextManagement.packetBudgetFraction)
      : undefined,
  });
  if (!budget.truncated) return result;
  return { ...result, text: budget.markdown };
}

function resolveMaxPacketTokens(options: PacketBudgetOptions): number {
  if (options.maxPacketTokens !== undefined) {
    validatePositiveInteger(options.maxPacketTokens, 'maxPacketTokens');
    return options.maxPacketTokens;
  }
  const targetContextWindowTokens = options.targetContextWindowTokens ?? DEFAULT_PACKET_TARGET_CONTEXT_WINDOW_TOKENS;
  validatePositiveInteger(targetContextWindowTokens, 'targetContextWindowTokens');
  return Math.floor(targetContextWindowTokens * 0.5);
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function estimateMarkdownTokens(markdown: string): number {
  return estimatePromptTokens({
    messages: [{ role: 'user', content: markdown }],
  }).inputTokens;
}

function buildRetainedPacketSkeleton(markdown: string): string {
  const lines = markdown.split('\n');
  const retained: string[] = [];
  let coreSectionNumber = 0;
  let keep = true;

  for (const line of lines) {
    const headingMatch = /^##\s+/.exec(line);
    if (headingMatch) {
      if (/detailed sections/i.test(line)) {
        keep = true;
      } else {
        coreSectionNumber += 1;
        keep = coreSectionNumber <= 4;
      }
    }
    if (keep) {
      retained.push(line);
    }
  }

  return retained.join('\n').trimEnd();
}

function truncateMarkdownToTokens(markdown: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateMarkdownTokens(markdown) <= maxTokens) return markdown;

  let low = 0;
  let high = markdown.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateMarkdownTokens(markdown.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return markdown.slice(0, low);
}

/**
 * Check for subsystem drift before expansion.
 *
 * Compares subsystem spec last-modified timestamps against recent file
 * changes to detect stale specs. Logs warnings if drift is detected.
 *
 * @param repoPath - Repository root path
 * @param issueDescription - Issue description text
 *
 * @example
 * ```typescript
 * await checkSubsystemDrift('/path/to/repo', issue.description);
 * // Logs drift warnings to console if specs are stale
 * ```
 */
export async function checkSubsystemDrift(
  repoPath: string,
  issueDescription: string
): Promise<void> {
  const contextDir = path.join(repoPath, '.wavemill', 'context');

  // Skip if no subsystem specs exist
  if (!existsSync(contextDir)) {
    return;
  }

  try {
    console.log('Checking for subsystem drift...');

    // Detect subsystems
    const subsystems = detectSubsystems(repoPath, {
      minFiles: 3,
      useGitAnalysis: false, // Skip git analysis for speed
      maxSubsystems: 20,
    });

    if (subsystems.length === 0) {
      return;
    }

    // Check for drift
    const driftResult = detectDriftForIssue(
      issueDescription,
      subsystems,
      repoPath
    );

    if (driftResult.hasDrift) {
      console.log('');
      console.log(formatDriftWarning(driftResult));
      console.log('');
    } else {
      console.log(
        `✓ All ${driftResult.totalChecked} subsystem spec(s) are up to date\n`
      );
    }
  } catch (error) {
    // Drift detection is non-blocking
    const message = errorMessage(error);
    console.warn(`⚠️  Drift detection failed: ${message}`);
  }
}
