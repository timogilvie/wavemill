#!/usr/bin/env -S npx tsx

/**
 * Post-Completion Eval Hook — CLI wrapper
 *
 * Triggers eval automatically after a workflow completes.
 * Always exits 0 so eval failures never break workflows.
 *
 * Usage:
 *   npx tsx tools/run-eval-hook.ts --issue HOK-123 --pr 456 --workflow-type workflow
 *   npx tsx tools/run-eval-hook.ts --issue HOK-123 --pr 456 --workflow-type bugfix
 */

import { runPostCompletionEval } from '../shared/lib/post-completion-hook.ts';

// Early diagnostic logging
if (process.env.DEBUG_COST === '1' || process.argv.includes('--debug')) {
  process.stderr.write('[DEBUG_COST] run-eval-hook.ts loaded\n');
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue' && argv[i + 1]) {
      args.issue = argv[++i];
    } else if (argv[i] === '--pr' && argv[i + 1]) {
      args.pr = argv[++i];
    } else if (argv[i] === '--pr-url' && argv[i + 1]) {
      args.prUrl = argv[++i];
    } else if (argv[i] === '--workflow-type' && argv[i + 1]) {
      args.workflowType = argv[++i];
    } else if (argv[i] === '--branch' && argv[i + 1]) {
      args.branch = argv[++i];
    } else if (argv[i] === '--repo-dir' && argv[i + 1]) {
      args.repoDir = argv[++i];
    } else if (argv[i] === '--worktree' && argv[i + 1]) {
      args.worktree = argv[++i];
    } else if (argv[i] === '--agent' && argv[i + 1]) {
      args.agent = argv[++i];
    } else if (argv[i] === '--debug') {
      args.debug = 'true';
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = 'true';
    }
  }
  return args;
}

function showHelp(): void {
  console.log(`
Post-Completion Eval Hook — Automatically evaluate a completed workflow

Usage:
  npx tsx tools/run-eval-hook.ts [options]

Options:
  --issue ID             Linear issue identifier (e.g., HOK-123)
  --pr NUMBER            GitHub PR number
  --pr-url URL           GitHub PR URL (auto-detected if not provided)
  --workflow-type TYPE   Workflow type: workflow, bugfix, mill, or plan
  --branch NAME          Git branch name (for intervention detection from non-worktree context)
  --worktree DIR         Worktree directory (for workflow cost computation from session data)
  --agent TYPE           Agent type: claude or codex (default: claude)
  --repo-dir DIR         Repository directory (default: current directory)
  --debug                Enable detailed cost computation diagnostics (sets DEBUG_COST=1)
  --help, -h             Show this help message

Notes:
  - Reads autoEval from .wavemill-config.json; skips eval if disabled
  - Always exits 0 — eval failures are logged but never fail the workflow
  - Results are appended to .wavemill/eval-store.jsonl
  - Use --debug to troubleshoot "no session data found" issues
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    return;
  }

  // Enable debug mode if requested
  if (args.debug === 'true') {
    process.env.DEBUG_COST = '1';
  }

  // Log received CLI arguments for diagnostics
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

  if (debug) {
    // Use console.error to ensure output appears before async operations
    console.error('[DEBUG_COST] ========================================');
    console.error('[DEBUG_COST] Eval hook invoked with CLI arguments:');
    console.error(`[DEBUG_COST]   --issue: ${args.issue || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --pr: ${args.pr || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --pr-url: ${args.prUrl || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --workflow-type: ${args.workflowType || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --branch: ${args.branch || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --worktree: ${args.worktree || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --agent: ${args.agent || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --repo-dir: ${args.repoDir || '(not provided)'}`);
    console.error(`[DEBUG_COST]   --debug: ${args.debug || '(not provided)'}`);
    console.error('[DEBUG_COST] ========================================');
  }

  const context = {
    issueId: args.issue,
    prNumber: args.pr,
    prUrl: args.prUrl,
    workflowType: args.workflowType || 'unknown',
    repoDir: args.repoDir,
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

  await runPostCompletionEval(context);
}

main().catch((err) => {
  // Final safety net — never exit non-zero
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`Post-completion eval hook: unexpected error — ${message}`);
});
