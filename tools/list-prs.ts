#!/usr/bin/env -S npx tsx

/**
 * List PRs Tool
 *
 * Lists GitHub pull requests with optional filtering by state, author, and branch pattern.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { listPullRequests } from '../shared/lib/github.js';

interface PR {
  number: number;
  title: string;
  state: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  labels: any[];
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

/**
 * Match a branch name against a glob-style pattern.
 * Supports wildcards (*) for any characters.
 */
function matchBranchPattern(branchName: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(branchName);
}

runTool({
  name: 'list-prs',
  description: 'List GitHub pull requests with filtering',
  options: {
    state: {
      type: 'string',
      description: 'Filter by PR state: open|closed|all (default: open)',
      default: 'open'
    },
    author: {
      type: 'string',
      description: 'Filter by PR author'
    },
    branch: {
      type: 'string',
      description: 'Filter by branch name pattern (supports wildcards)'
    },
    limit: {
      type: 'string',
      description: 'Maximum number of PRs to fetch (default: 50)',
      default: '50'
    },
    help: {
      type: 'boolean',
      short: 'h',
      description: 'Show help message'
    },
  },
  examples: [
    '# List open PRs (default)',
    'npx tsx tools/list-prs.ts',
    '',
    '# List closed PRs',
    'npx tsx tools/list-prs.ts --state closed',
    '',
    '# List PRs by specific author',
    'npx tsx tools/list-prs.ts --author octocat',
    '',
    '# List PRs from feature branches',
    'npx tsx tools/list-prs.ts --branch "feature/*"',
    '',
    '# Combine filters',
    'npx tsx tools/list-prs.ts --state all --author timogilvie --branch "task/*"',
  ],
  additionalHelp: `Output:
  JSON array of PR objects with fields:
  - number, title, state, author
  - headRefName (branch), baseRefName
  - labels, url
  - createdAt, updatedAt, mergedAt, closedAt`,
  async run({ args }) {
    // Validate state
    const state = args.state || 'open';
    if (!['open', 'closed', 'all'].includes(state)) {
      console.error(`Error: Invalid state "${state}". Must be one of: open, closed, all`);
      process.exit(1);
    }

    // Validate and parse limit
    const limit = parseInt(args.limit || '50', 10);
    if (isNaN(limit) || limit < 1) {
      console.error(`Error: Invalid limit "${args.limit}". Must be a positive number.`);
      process.exit(1);
    }

    // Fetch PRs from GitHub
    const prs = listPullRequests({
      state: state as 'open' | 'closed' | 'all',
      author: args.author,
      limit,
    }) as PR[];

    // Apply client-side branch filtering if pattern provided
    let filteredPRs = prs;
    if (args.branch) {
      filteredPRs = prs.filter(pr => matchBranchPattern(pr.headRefName, args.branch!));
    }

    // Output JSON
    console.log(JSON.stringify(filteredPRs, null, 2));
  },
});
