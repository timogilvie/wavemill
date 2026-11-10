#!/usr/bin/env -S npx tsx
/**
 * open-task-pr — thin CLI over `openTaskPullRequest` (HOK-3463).
 *
 * The one task-PR opener: at review exit the mill publishes the head and
 * opens the PR. Title and body come from the review stage result
 * (`artifacts.prTitle` / `prBody`), never from an agent's own `gh pr create`.
 * Called by the monitor through `open_task_pr` in wavemill-common.sh.
 *
 * Emits one JSON object on stdout and exits:
 *   0  — success (`outcome`: created | reused, with `number` and `url`)
 *   10 — remote-divergence (conflict-shaped)
 *   11 — local ref missing
 *   13 — push, verification or PR open failed (retryable harness fault)
 *   1  — any other failure
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { openTaskPullRequest, resolveTaskPullRequestContent } from '../shared/lib/branch-publication.ts';
import { resolveOwnerRepo } from '../shared/lib/github.ts';

const EXIT_CODE_BY_REASON: Record<string, number> = {
  'remote-divergence': 10,
  'local-ref-missing': 11,
  'stale-reviewed-sha': 11,
  'remote-lookup-failed': 13,
  'push-failed': 13,
  'post-push-verification-failed': 13,
  'pr-open-failed': 13,
};

runTool({
  name: 'open-task-pr',
  description: 'Publish the task branch and open its PR at review exit through the one seam (HOK-3463)',
  options: {
    worktree: { type: 'string', description: 'Path to the task worktree' },
    branch: { type: 'string', description: 'Task branch (no refs/heads/ prefix)' },
    base: { type: 'string', description: 'Base branch from the launch contract' },
    'state-dir': { type: 'string', description: 'Task state dir (holds .review-result.json)' },
    issue: { type: 'string', description: 'Issue id' },
    'fallback-title': { type: 'string', description: 'Title used when the review recorded none' },
    repo: { type: 'string', description: 'owner/repo (default: resolved from the worktree)' },
    remote: { type: 'string', description: 'Remote name (default: origin)', default: 'origin' },
  },
  examples: [
    'npx tsx tools/open-task-pr.ts --worktree ./wt --branch task/foo --base main --state-dir ./wt/features/foo --issue HOK-1',
  ],
  async run({ args }) {
    const worktree = args.worktree as string | undefined;
    const branch = args.branch as string | undefined;
    const base = args.base as string | undefined;
    const stateDir = args['state-dir'] as string | undefined;
    const issue = args.issue as string | undefined;
    if (!worktree || !branch || !base || !stateDir || !issue) {
      console.error('Error: --worktree, --branch, --base, --state-dir and --issue are all required');
      process.exit(1);
    }
    const repo = (args.repo as string | undefined) || resolveOwnerRepo(worktree);
    if (!repo) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        reason: 'pr-open-failed',
        message: 'could not resolve owner/repo for the worktree',
        faultClass: 'harness-fault',
      })}\n`);
      process.exit(13);
    }

    const content = await resolveTaskPullRequestContent({
      stateDir,
      issue,
      fallbackTitle: args['fallback-title'] as string | undefined,
    });
    const result = await openTaskPullRequest({
      worktreeDir: worktree,
      remote: (args.remote as string | undefined) || 'origin',
      branch,
      base,
      repo,
      stateDir,
      issue,
      title: content.title,
      body: content.body,
      draft: content.draft,
    });

    process.stdout.write(`${JSON.stringify({ ...result, contentSource: content.source })}\n`);
    if (result.ok) {
      process.exit(0);
    }
    console.error(`open-task-pr: ${result.reason} — ${result.message}`);
    process.exit(EXIT_CODE_BY_REASON[result.reason] ?? 1);
  },
});
