#!/usr/bin/env -S npx tsx
// @ts-nocheck

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

function parseArgs(argv: string[]) {
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
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = 'true';
    }
  }
  return args;
}

function showHelp() {
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
  --repo-dir DIR         Repository directory (default: current directory)
  --help, -h             Show this help message

Notes:
  - Reads autoEval from .wavemill-config.json; skips eval if disabled
  - Always exits 0 — eval failures are logged but never fail the workflow
  - Results are appended to .wavemill/eval-store.jsonl
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    return;
  }

  await runPostCompletionEval({
    issueId: args.issue,
    prNumber: args.pr,
    prUrl: args.prUrl,
    workflowType: args.workflowType || 'unknown',
    repoDir: args.repoDir,
    branchName: args.branch,
  });
}

main().catch((err) => {
  // Final safety net — never exit non-zero
  console.warn(`Post-completion eval hook: unexpected error — ${err.message}`);
});
