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
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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

// ────────────────────────────────────────────────────────────────
// Auto-Detection
// ────────────────────────────────────────────────────────────────

/**
 * Auto-detect context from workflow state or current branch.
 *
 * Falls back in this order:
 * 1. .wavemill/workflow-state.json (most recent task with PR)
 * 2. Current branch's open PR (via gh CLI)
 *
 * @param repoDir - Repository directory
 * @returns Detected context (issueId, prNumber, branch, prUrl)
 */
export function autoDetectContext(repoDir: string): {
  issueId: string;
  prNumber: string;
  branch: string;
  prUrl: string;
} {
  let issueId = '';
  let prNumber = '';
  let branch = '';
  let prUrl = '';

  // Try workflow state file
  const stateFile = path.join(repoDir, '.wavemill', 'workflow-state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const tasks = state.tasks || {};

      // Find most recently updated task that has a PR
      let mostRecent: any = null;
      let mostRecentTime = '';
      for (const [id, task] of Object.entries(tasks)) {
        const t = task as any;
        if (t.pr && (!mostRecentTime || t.updated > mostRecentTime)) {
          mostRecent = { id, ...t };
          mostRecentTime = t.updated;
        }
      }

      if (mostRecent) {
        issueId = mostRecent.id;
        prNumber = String(mostRecent.pr);
        branch = mostRecent.branch || '';
      }
    } catch {
      // Best-effort
    }
  }

  // Try current branch PR
  if (!prNumber) {
    try {
      branch = execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();

      const prJson = execShellCommand(
        'gh pr view --json number,url 2>/dev/null || echo "{}"',
        {
          encoding: 'utf-8',
          cwd: repoDir,
        }
      ).trim();

      const prData = JSON.parse(prJson);
      if (prData.number) {
        prNumber = String(prData.number);
        prUrl = prData.url || '';
      }
    } catch {
      // Best-effort
    }
  }

  if (!issueId && !prNumber) {
    throw new Error(
      'No workflow context found. Auto-detection requires either:\n' +
        '  1. .wavemill/workflow-state.json with a completed task\n' +
        '  2. An open PR on the current branch\n\n' +
        'Or provide explicit arguments: --issue HOK-123 --pr 456'
    );
  }

  return { issueId, prNumber, branch, prUrl };
}
