#!/usr/bin/env -S npx tsx
/**
 * update-branch-with-base — thin CLI over `updateBranchWithBase` (HOK-3092).
 *
 * Runs a fetch + merge of origin/<base> into <branch> inside <worktree>, then
 * pushes the result. Emits one JSON object on stdout summarizing the outcome
 * and exits with a status code the shell caller (`try_update_branch_from_base`
 * in wavemill-monitor.sh) uses to pick a disposition:
 *
 *   0  — success (branch was updated from origin/<base> and pushed)
 *   10 — conflict (JSON includes `conflictingFiles` when parseable)
 *   11 — dirty worktree (refused to touch a checkout with uncommitted work)
 *   12 — fetch failed
 *   13 — push failed
 *   1  — any other failure (`status: "unknown-failed"`)
 *
 * JSON always to stdout; human-readable prose is emitted to stderr.
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { updateBranchWithBase } from '../shared/lib/promotion-controller.ts';

const EXIT_CODE_BY_STATUS: Record<string, number> = {
  success: 0,
  conflict: 10,
  'dirty-worktree': 11,
  'fetch-failed': 12,
  'push-failed': 13,
  'unknown-failed': 1,
};

runTool({
  name: 'update-branch-with-base',
  description: 'Merge origin/<base> into <branch> in a worktree and push (HOK-3092)',
  options: {
    worktree: {
      type: 'string',
      description: 'Path to the git worktree the merge runs inside',
    },
    branch: {
      type: 'string',
      description: 'Branch to update (matches the worktree checkout)',
    },
    base: {
      type: 'string',
      description: 'Base branch to merge from (e.g. auto/integration)',
    },
    json: {
      type: 'boolean',
      description: 'Emit only the JSON result on stdout (default: true)',
      default: true,
    },
  },
  examples: [
    'npx tsx tools/update-branch-with-base.ts --worktree ./wt --branch task/foo --base auto/integration',
  ],
  async run({ args }) {
    const worktree = args.worktree;
    const branch = args.branch;
    const base = args.base;

    if (!worktree || !branch || !base) {
      console.error('Error: --worktree, --branch, and --base are all required');
      process.exit(1);
    }

    const result = updateBranchWithBase(branch, base, worktree);
    const exitCode = EXIT_CODE_BY_STATUS[result.status] ?? 1;

    // Prefer the JSON verbatim from the module so a future field addition
    // reaches the shell wrapper without a schema tweak here.
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'success') {
      console.error(`update-branch-with-base: ${result.status} — ${result.detail}`);
    }
    process.exit(exitCode);
  },
});
