#!/usr/bin/env -S npx tsx

/**
 * CLI tool to gather review context for the current branch.
 *
 * Usage:
 *   npx tsx tools/gather-review-context.ts [targetBranch] [repoDir]
 *   npx tsx tools/gather-review-context.ts main
 *   npx tsx tools/gather-review-context.ts main /path/to/repo
 *
 * Outputs JSON to stdout.
 */

import { resolve } from 'node:path';
import { gatherReviewContext } from '../shared/lib/review-context-gatherer.ts';

function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const targetBranch = args[0] || 'main';
  const repoDir = args[1] ? resolve(args[1]) : process.cwd();

  // Check for help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: gather-review-context.ts [targetBranch] [repoDir]

Gathers review context for the current branch, including:
- Git diff against target branch
- Task packet (if found)
- Plan document (if found)
- Design context (if enabled and artifacts exist)
- Metadata (branch, files, line counts, UI changes)

Arguments:
  targetBranch   Branch to diff against (default: "main")
  repoDir        Repository directory (default: current directory)

Options:
  --help, -h     Show this help message

Examples:
  npx tsx tools/gather-review-context.ts
  npx tsx tools/gather-review-context.ts develop
  npx tsx tools/gather-review-context.ts main /path/to/repo
`);
    process.exit(0);
  }

  try {
    // Gather context
    const context = gatherReviewContext(targetBranch, repoDir);

    // Output as JSON
    console.log(JSON.stringify(context, null, 2));
  } catch (error) {
    console.error('Error gathering review context:', (error as Error).message);
    process.exit(1);
  }
}

main();
