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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { callClaude } from './llm-cli.ts';
import { fillPromptTemplate } from './prompt-utils.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { detectDriftForIssue, formatDriftWarning } from './drift-detector.ts';

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
  // Handle full Linear URLs
  const urlMatch = input.match(/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/);
  if (urlMatch) return urlMatch[1];

  // Handle direct identifier
  const idMatch = input.match(/^([A-Z]+-\d+)$/);
  if (idMatch) return idMatch[1];

  throw new Error(
    `Invalid issue identifier: ${input}. Expected format: LIN-123 or Linear URL`
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
  claudeCmd?: string
): Promise<string> {
  // Fill template with context using placeholder substitution
  const fullPrompt = fillPromptTemplate(promptTemplate, {
    ISSUE_CONTEXT: issueContext,
    CODEBASE_CONTEXT: codebaseContext,
  });

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    claudeCmd: claudeCmd || process.env.CLAUDE_CMD || 'claude',
    cliFlags: [
      '--tools',
      '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the task packet markdown and nothing else. No conversational text, no preamble, no apologies, no questions. Start directly with the first markdown heading.',
    ],
  });

  return result.text;
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
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Drift detection failed: ${message}`);
  }
}
