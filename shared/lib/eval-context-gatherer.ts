/**
 * Eval Context Gatherer
 *
 * Gathers workflow context for evaluation from multiple sources:
 * - Wavemill workflow state (.wavemill/workflow-state.json)
 * - Current branch PR (via gh CLI)
 * - Linear issue details
 * - PR diff and review comments
 *
 * @module eval-context-gatherer
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { resolveOwnerRepo } from './intervention-detector.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface EvalContext {
  issueId: string;
  prNumber: string;
  prUrl: string;
  branch: string;
  taskPrompt: string;
  prReviewOutput: string;
  repoDir: string;
}

export interface GatherContextArgs {
  issue?: string;
  pr?: string;
  repoDir?: string;
  agent?: string;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Gather eval context from multiple sources.
 *
 * Resolution order:
 * 1. Explicit args (--issue, --pr) take priority
 * 2. Falls back to .wavemill/workflow-state.json (most recent task with PR)
 * 3. Falls back to current branch's open PR
 *
 * @param args - Arguments with optional issue/PR/repoDir
 * @returns Complete eval context
 * @throws Error if no context found
 */
export function gatherContext(args: GatherContextArgs): EvalContext {
  const repoDir = args.repoDir || process.cwd();
  const stateFile = path.join(repoDir, '.wavemill', 'workflow-state.json');

  let issueId = args.issue || '';
  let prNumber = args.pr || '';
  let branch = '';
  let prUrl = '';

  // Try auto-detect from wavemill state file (only when neither was explicitly provided)
  if (!issueId && !prNumber && existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const tasks = state.tasks || {};

    // Find most recently updated task that has a PR
    let mostRecent: any = null;
    let mostRecentTime = '';
    for (const [id, task] of Object.entries(tasks)) {
      const taskData = task as any;
      if (taskData.pr && (!mostRecentTime || taskData.updated > mostRecentTime)) {
        mostRecent = { id, ...taskData };
        mostRecentTime = taskData.updated;
      }
    }

    if (mostRecent) {
      if (!issueId) issueId = mostRecent.id;
      if (!prNumber) prNumber = String(mostRecent.pr);
      branch = mostRecent.branch || '';
    }
  }

  // Try auto-detect from current branch PR
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
      'No workflow context found. Provide explicit arguments:\n' +
        '  npx tsx tools/eval-workflow.ts --issue HOK-123 --pr 456\n\n' +
        'Or run after a completed wavemill workflow (requires .wavemill/workflow-state.json)'
    );
  }

  // Fetch issue details from Linear
  let taskPrompt = '';
  if (issueId) {
    try {
      const toolPath = path.resolve(
        path.dirname(require.resolve('../package.json')),
        'tools/get-issue-json.ts'
      );
      const raw = execShellCommand(
        `npx tsx ${escapeShellArg(toolPath)} ${escapeShellArg(issueId)} 2>/dev/null`,
        { encoding: 'utf-8', cwd: repoDir }
      ).trim();
      const issue = JSON.parse(raw);
      taskPrompt = `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
    } catch {
      taskPrompt = `Issue: ${issueId} (details unavailable)`;
    }
  }

  // Fetch PR diff as review output
  let prReviewOutput = '';
  if (prNumber) {
    if (!prUrl) {
      try {
        prUrl = execShellCommand(
          `gh pr view ${escapeShellArg(prNumber)} --json url --jq .url 2>/dev/null`,
          {
            encoding: 'utf-8',
            cwd: repoDir,
          }
        ).trim();
      } catch {
        /* best-effort */
      }
    }

    try {
      const diff = execShellCommand(`gh pr diff ${escapeShellArg(prNumber)}`, {
        encoding: 'utf-8',
        cwd: repoDir,
        maxBuffer: 10 * 1024 * 1024,
      });
      prReviewOutput = diff;
    } catch {
      prReviewOutput = '(PR diff unavailable)';
    }

    // Append review comments if any
    try {
      const nwo = resolveOwnerRepo(repoDir);
      const comments = nwo
        ? execShellCommand(
            `gh api repos/${escapeShellArg(nwo)}/pulls/${escapeShellArg(prNumber)}/comments --jq '.[].body' 2>/dev/null || echo ''`,
            { encoding: 'utf-8', cwd: repoDir }
          ).trim()
        : '';
      if (comments) {
        prReviewOutput += `\n\n## Review Comments\n\n${comments}`;
      }
    } catch {
      /* best-effort */
    }
  }

  // Ensure we have the branch name for intervention detection
  if (!branch) {
    try {
      branch = execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();
    } catch {
      /* best-effort */
    }
  }

  return { issueId, prNumber, prUrl, branch, taskPrompt, prReviewOutput, repoDir };
}
