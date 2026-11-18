#!/usr/bin/env -S npx tsx
/**
 * One task spend limit (HOK-3492) — shell bridge.
 *
 * Prints the task's recorded budget and the spend its owned sessions have
 * already accrued, so the monitor's failed-stage gate and operator inspection
 * ask `shared/lib/task-spend.ts` rather than re-deriving either number.
 *
 * One JSON line: {budget, spentUsd, remainingUsd, metering} or {"budget":null}
 * when no budget is recorded. `remainingUsd` is null when metering could not
 * establish spend; callers must not read that as unlimited (see the module).
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveTaskSpendRemainder } from '../shared/lib/task-spend.ts';

runTool({
  name: 'task-spend-cli',
  description: 'Report the task spend remainder from the recorded budget and owned sessions (HOK-3492)',
  options: {
    'repo-dir': { type: 'string', description: 'Repository root' },
    worktree: { type: 'string', description: 'Task worktree (defaults to repo-dir)' },
    'feature-dir': { type: 'string', description: 'Task feature directory' },
    issue: { type: 'string', description: 'Linear issue id' },
    slug: { type: 'string', description: 'Feature slug (defaults to the feature directory name)' },
    branch: { type: 'string', description: 'Task branch' },
    model: { type: 'string', description: 'Model the launch will run (resolves its rates)' },
  },
  examples: [
    'npx tsx tools/task-spend-cli.ts --repo-dir . --feature-dir features/my-task --issue HOK-1 --slug my-task',
  ],
  async run({ args }) {
    const repoDir = args['repo-dir'] ?? process.cwd();
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      worktreePath: args.worktree ?? repoDir,
      featureDir: args['feature-dir'],
      issueId: args.issue,
      slug: args.slug,
      branchName: args.branch,
      modelId: args.model,
      // stdout is the JSON contract; the meter's own log lines go to stderr.
      logger: { log: (...parts: unknown[]) => console.error(...parts), warn: (...parts: unknown[]) => console.error(...parts) },
    });
    console.log(JSON.stringify(spend ?? { budget: null }));
  },
});
