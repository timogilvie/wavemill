#!/usr/bin/env npx tsx

/**
 * CLI tool to discover GitHub required checks.
 *
 * Usage:
 *   npx tsx tools/discover-ci-checks.ts owner/repo
 *   npx tsx tools/discover-ci-checks.ts owner/repo --branch integration
 *   npx tsx tools/discover-ci-checks.ts owner/repo --json
 *   npx tsx tools/discover-ci-checks.ts owner/repo --list-workflows
 *
 * Discovers GitHub branch-protection and ruleset required checks,
 * returning check names and workflow job provenance (without executing YAML).
 *
 * Output formats:
 * - Human-readable: "Found 3 checks: Shell and Unit Tests, Type Check, ..."
 * - JSON: { checks: [...], source: "...", workflows: [...] }
 */

import { discoverGitHubRequiredChecks, getWorkflowJobs } from '../shared/lib/github-ci-discovery.ts';
import type { GitHubDiscoveryResult, GitHubPermissionError } from '../shared/lib/github-ci-discovery.ts';

// ────────────────────────────────────────────────────────────────
// CLI Arguments
// ────────────────────────────────────────────────────────────────

interface CLIOptions {
  repo: string;
  branch: string;
  json: boolean;
  listWorkflows: boolean;
}

function parseCLI(): CLIOptions | null {
  const args = process.argv.slice(2);

  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (args.length === 0 || wantsHelp) {
    console.log(`Usage: npx tsx tools/discover-ci-checks.ts <repo> [options]

Arguments:
  <repo>    Repository in owner/repo format (required)

Options:
  --branch          Branch name (default: auto/integration)
  --json            Output JSON instead of human-readable
  --list-workflows  Also list available workflow jobs
  --help            Show this help message
`);
    if (wantsHelp) process.exit(0);
    return null;
  }

  let repo = '';
  let branch = 'auto/integration';
  let json = false;
  let listWorkflows = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--list-workflows') {
      listWorkflows = true;
    } else if (arg.startsWith('--branch')) {
      if (arg === '--branch' && i < args.length - 1) {
        branch = args[++i];
      } else if (arg.startsWith('--branch=')) {
        branch = arg.slice('--branch='.length);
      }
    } else if (!arg.startsWith('--')) {
      repo = arg;
    }
  }

  if (!repo) {
    console.error('Error: <repo> argument is required (owner/repo format)');
    return null;
  }

  return { repo, branch, json, listWorkflows };
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCLI();
  if (!opts) {
    process.exit(1);
  }

  try {
    // Discover checks
    const discovery = await discoverGitHubRequiredChecks(opts.repo, opts.branch);

    // Optionally list workflows
    let workflows: any = undefined;
    if (opts.listWorkflows) {
      try {
        workflows = await getWorkflowJobs(opts.repo);
      } catch (err) {
        if (!opts.json) {
          console.warn(`⚠️  Could not list workflows: ${(err as Error).message}`);
        }
      }
    }

    // Output results
    if (opts.json) {
      const output: any = {
        checks: discovery.checks,
        source: discovery.source,
        timestamp: discovery.timestamp,
      };
      if (workflows) {
        output.workflows = workflows;
      }
      console.log(JSON.stringify(output, null, 2));
    } else {
      const checkList = discovery.checks.join(', ');
      console.log(`✓ Found ${discovery.checks.length} required check(s):`);
      console.log(`  ${checkList}`);
      console.log(`  Source: ${discovery.source}`);

      if (workflows && workflows.length > 0) {
        console.log(`\nAvailable workflow jobs (${workflows.length}):`);
        workflows.forEach((job: any) => {
          console.log(`  - ${job.name} (${job.path})`);
        });
      }

    }
  } catch (err) {
    if (!opts.json) {
      const msg = (err as Error).message;
      console.error(`✗ Discovery failed: ${msg}`);

      if (msg.includes('permission denied') || msg.includes('unauthorized')) {
        console.error(`\nTo fix: gh auth login`);
      }
      if (msg.includes('not found')) {
        console.error(`\nCheck that the repository and branch exist.`);
      }
    } else {
      console.log(JSON.stringify({ error: (err as Error).message }));
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
