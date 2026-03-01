#!/usr/bin/env -S npx tsx

/**
 * Post-Completion Eval Hook — CLI wrapper
 *
 * Triggers eval automatically after a workflow completes.
 * Always exits 0 so eval failures never break workflows.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { runPostCompletionEval } from '../shared/lib/post-completion-hook.ts';

runTool({
  name: 'run-eval-hook',
  description: 'Automatically evaluate a completed workflow',
  options: {
    issue: { type: 'string', description: 'Linear issue identifier (e.g., HOK-123)' },
    pr: { type: 'string', description: 'GitHub PR number' },
    'pr-url': { type: 'string', description: 'GitHub PR URL (auto-detected if not provided)' },
    'workflow-type': { type: 'string', description: 'Workflow type: workflow, bugfix, mill, or plan' },
    branch: { type: 'string', description: 'Git branch name' },
    worktree: { type: 'string', description: 'Worktree directory' },
    agent: { type: 'string', description: 'Agent type: claude or codex (default: claude)' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: current directory)' },
    debug: { type: 'boolean', description: 'Enable detailed cost computation diagnostics' },
    help: { type: 'boolean', short: 'h', description: 'Show help message' },
  },
  examples: [
    'npx tsx tools/run-eval-hook.ts --issue HOK-123 --pr 456 --workflow-type workflow',
    'npx tsx tools/run-eval-hook.ts --issue HOK-123 --pr 456 --workflow-type bugfix',
  ],
  additionalHelp: `Notes:
  - Reads autoEval from .wavemill-config.json; skips eval if disabled
  - Always exits 0 — eval failures are logged but never fail the workflow
  - Results are appended to .wavemill/eval-store.jsonl
  - Use --debug to troubleshoot "no session data found" issues`,
  async run({ args }) {
    // Enable debug mode if requested
    if (args.debug) {
      process.env.DEBUG_COST = '1';
    }

    const debug = process.env.DEBUG_COST === '1';

    if (debug) {
      console.error('[DEBUG_COST] ========================================');
      console.error('[DEBUG_COST] Eval hook invoked with CLI arguments:');
      console.error(`[DEBUG_COST]   --issue: ${args.issue || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --pr: ${args.pr || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --pr-url: ${args['pr-url'] || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --workflow-type: ${args['workflow-type'] || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --branch: ${args.branch || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --worktree: ${args.worktree || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --agent: ${args.agent || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --repo-dir: ${args['repo-dir'] || '(not provided)'}`);
      console.error('[DEBUG_COST] ========================================');
    }

    const context = {
      issueId: args.issue,
      prNumber: args.pr,
      prUrl: args['pr-url'],
      workflowType: args['workflow-type'] || 'unknown',
      repoDir: args['repo-dir'],
      branchName: args.branch,
      worktreePath: args.worktree,
      agentType: args.agent,
    };

    if (debug) {
      console.error('[DEBUG_COST] Resolved context object:');
      console.error(`[DEBUG_COST]   issueId: ${context.issueId || '(undefined)'}`);
      console.error(`[DEBUG_COST]   prNumber: ${context.prNumber || '(undefined)'}`);
      console.error(`[DEBUG_COST]   prUrl: ${context.prUrl || '(undefined)'}`);
      console.error(`[DEBUG_COST]   workflowType: ${context.workflowType}`);
      console.error(`[DEBUG_COST]   repoDir: ${context.repoDir || '(undefined)'}`);
      console.error(`[DEBUG_COST]   branchName: ${context.branchName || '(undefined)'}`);
      console.error(`[DEBUG_COST]   worktreePath: ${context.worktreePath || '(undefined)'}`);
      console.error(`[DEBUG_COST]   agentType: ${context.agentType || '(undefined)'}`);
      console.error('[DEBUG_COST] ========================================');
    }

    try {
      await runPostCompletionEval(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Post-completion eval hook: unexpected error — ${message}`);
    }
  },
});
