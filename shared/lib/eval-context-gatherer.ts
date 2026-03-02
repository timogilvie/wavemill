/**
 * Eval context gathering — fetch and format all context needed for evaluation.
 *
 * Centralizes data fetching for:
 * - Linear issue data (via get-issue-json tool)
 * - GitHub PR data (diff and URL via gh CLI)
 *
 * All functions are non-throwing: errors are caught and return null/empty
 * values so eval can proceed with degraded data.
 *
 * @module eval-context-gatherer
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Complete context needed for running eval. */
export interface EvalContext {
  /** Formatted task prompt (issue title + description) */
  taskPrompt: string;
  /** PR diff content */
  prDiff: string;
  /** PR URL */
  prUrl: string;
  /** Raw issue data from Linear (null if fetch failed) */
  issueData: any | null;
}

/** Input parameters for gathering context. */
export interface GatherContextParams {
  /** Linear issue ID (e.g. "HOK-870") */
  issueId?: string;
  /** GitHub PR number */
  prNumber?: string;
  /** PR URL (if already known) */
  prUrl?: string;
  /** Repository directory */
  repoDir: string;
}

// ────────────────────────────────────────────────────────────────
// Issue Data Fetching
// ────────────────────────────────────────────────────────────────

/**
 * Fetch issue data from Linear via the get-issue-json tool.
 * Returns the parsed issue object or null on failure.
 */
export function fetchIssueData(issueId: string, repoDir: string): any | null {
  const toolPath = resolve(__dirname, '../../tools/get-issue-json.ts');
  try {
    const raw = execShellCommand(
      `npx tsx ${escapeShellArg(toolPath)} ${escapeShellArg(issueId)} 2>/dev/null | sed '/^\\[dotenv/d'`,
      { encoding: 'utf-8', cwd: repoDir }
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Format issue data as a markdown prompt.
 */
export function formatIssueAsPrompt(issue: any | null, issueId: string): string {
  if (!issue) return `Issue: ${issueId} (details unavailable)`;
  return `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
}

// ────────────────────────────────────────────────────────────────
// PR Data Fetching
// ────────────────────────────────────────────────────────────────

/**
 * Fetch PR diff and URL from GitHub.
 */
export function fetchPrContext(prNumber: string, repoDir: string): { diff: string; url: string } {
  let url = '';
  let diff = '';

  try {
    url = execShellCommand(`gh pr view ${escapeShellArg(prNumber)} --json url --jq .url 2>/dev/null`, {
      encoding: 'utf-8', cwd: repoDir,
    }).trim();
  } catch { /* best-effort */ }

  try {
    diff = execShellCommand(`gh pr diff ${escapeShellArg(prNumber)}`, {
      encoding: 'utf-8', cwd: repoDir, maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    diff = '(PR diff unavailable)';
  }

  return { diff, url };
}

// ────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Gather all context needed for evaluation in a single call.
 *
 * Fetches issue data from Linear and PR data from GitHub.
 * Non-blocking: failures result in degraded data (empty strings, null values).
 *
 * @param params - Context gathering parameters
 * @returns Complete eval context
 */
export function gatherEvalContext(params: GatherContextParams): EvalContext {
  const { issueId, prNumber, prUrl, repoDir } = params;

  // Fetch issue data
  let issueData: any | null = null;
  if (issueId) {
    issueData = fetchIssueData(issueId, repoDir);
  }
  const taskPrompt = formatIssueAsPrompt(issueData, issueId || '');

  // Fetch PR data
  let prDiff = '';
  let finalPrUrl = prUrl || '';
  if (prNumber) {
    const prCtx = fetchPrContext(prNumber, repoDir);
    prDiff = prCtx.diff;
    if (!finalPrUrl) finalPrUrl = prCtx.url;
  }

  return {
    taskPrompt,
    prDiff,
    prUrl: finalPrUrl,
    issueData,
  };
}
