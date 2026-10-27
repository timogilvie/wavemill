#!/usr/bin/env -S npx tsx
/**
 * HOK-3312: thin CLI wrapper around `archiveTaskResidue`. The monitor's
 * cleanup consumers call this before any destructive step when the TS
 * decider's action is `archive-and-reap`. Prints the archive result as a
 * compact JSON object; exits non-zero on failure.
 */
import { fileURLToPath } from 'node:url';

import { archiveTaskResidue } from '../shared/lib/task-residue-archive.ts';
import { runTool, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const options = {
  issue: { type: 'string', description: 'Linear issue id (used as archive root dir)' },
  worktree: { type: 'string', description: 'Task worktree path' },
  'repo-dir': { type: 'string', description: 'Repository directory holding .wavemill/evals/artifacts/' },
  branch: { type: 'string', description: 'Local task branch (optional; used for bundle range + provenance)' },
  'base-branch': { type: 'string', description: 'Fallback base branch when the task has no launchContract' },
  'pr-number': { type: 'string', description: 'PR number if the task had one' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export async function runArchiveTaskResidueCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'archive-task-residue',
    description: 'HOK-3312: archive a terminal task\'s worktree residue before destructive cleanup.',
    options,
    examples: [
      'wavemill tool archive-task-residue --issue HOK-3312 --worktree ./worktrees/foo --repo-dir .',
    ],
    async run({ args }: { args: CliArgs }) {
      const issue = typeof args.issue === 'string' ? args.issue : '';
      const worktree = typeof args.worktree === 'string' ? args.worktree : '';
      const repoDir = typeof args['repo-dir'] === 'string' ? args['repo-dir'] : '';
      if (!issue || !worktree || !repoDir) {
        throw new Error('archive-task-residue: --issue, --worktree and --repo-dir are required');
      }
      const result = archiveTaskResidue({
        issue,
        worktree,
        repoDir,
        branch: typeof args.branch === 'string' ? args.branch : undefined,
        baseBranch: typeof args['base-branch'] === 'string' ? args['base-branch'] : undefined,
        prNumber: typeof args['pr-number'] === 'string' ? args['pr-number'] : undefined,
      });
      console.log(JSON.stringify(result));
      if (!result.success) {
        process.exitCode = 1;
      }
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runArchiveTaskResidueCli();
}
