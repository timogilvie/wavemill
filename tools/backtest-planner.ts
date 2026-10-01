#!/usr/bin/env -S npx tsx
/**
 * Backtest the grounded wave planner against the legacy planner (HOK-3131).
 * Business logic lives in shared/lib/planner-backtest.ts.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { runTool } from '../shared/lib/tool-runner.ts';
import { createGitRepoProbe, type RepoProbe } from '../shared/lib/touch-set-predictor.ts';
import { createGroundedLlm, loadCoChangeIndex, runGroundedPlanning } from '../shared/lib/grounded-planner.ts';
import { computeTaskFingerprint } from '../shared/lib/task-dependency-plan-cache.ts';
import {
  commitBefore,
  fetchIssueFromLinear,
  fetchMergedPrsWithGh,
  legacyClassifyWithLlm,
  renderBacktestReport,
  runPlannerBacktest,
  type BacktestTask,
} from '../shared/lib/planner-backtest.ts';

runTool({
  name: 'backtest-planner',
  description: 'Compare grounded vs legacy queue planners against historical merged-PR file overlap',
  options: {
    limit: { type: 'string', description: 'Merged PRs to fetch (default 80)' },
    base: { type: 'string', description: 'Base branch the PRs merged into (default auto/integration)' },
    output: { type: 'string', description: 'Report path (default docs/backtest-grounded-planner.md)' },
    'no-llm': { type: 'boolean', description: 'Skip every LLM call (legacy = explicit relations, grounded = deterministic)' },
    'max-llm-calls': { type: 'string', description: 'Grounded ordering calls allowed (40 pairs each, default 10)' },
    stdout: { type: 'boolean', description: 'Print the report instead of writing it' },
  },
  examples: [
    'npx tsx tools/backtest-planner.ts',
    'npx tsx tools/backtest-planner.ts --limit 40 --no-llm --stdout',
  ],
  async run({ args }) {
    const repoDir = process.cwd();
    const limit = Number.parseInt(args.limit ?? '80', 10);
    const maxLlmCalls = Number.parseInt(args['max-llm-calls'] ?? '10', 10);
    if (!Number.isInteger(limit) || limit < 2) throw new Error('--limit must be an integer >= 2');
    if (!Number.isInteger(maxLlmCalls) || maxLlmCalls < 1) throw new Error('--max-llm-calls must be a positive integer');
    const base = args.base ?? 'auto/integration';
    const useLlm = !args['no-llm'];
    const log = (message: string) => process.stderr.write(`backtest-planner: ${message}\n`);
    const fingerprint = (task: BacktestTask) => computeTaskFingerprint(task);
    let probeRef: string | null = null;

    const result = await runPlannerBacktest(limit, {
      fetchMergedPrs: async (count) => fetchMergedPrsWithGh(repoDir, base, count),
      fetchIssue: fetchIssueFromLinear,
      ...(useLlm ? { legacyClassify: (tasks: BacktestTask[]) => legacyClassifyWithLlm(tasks, { repoDir, fingerprint }) } : {}),
      fingerprint,
      log,
      judged: useLlm,
      groundedPlan: (tasks, { earliestStart, isConcurrent }) => {
        // Resolve touch sets and co-change against the repo as it was before the
        // window opened, so no task "finds" a file its own PR created.
        probeRef = commitBefore(repoDir, `origin/${base}`, earliestStart) ?? commitBefore(repoDir, base, earliestStart);
        if (!probeRef) log('no commit before the window; resolving against the working tree');
        const probe: RepoProbe = createGitRepoProbe(repoDir, probeRef ? { ref: probeRef } : {});
        return runGroundedPlanning(tasks, {
          repoDir,
          probe,
          coChange: loadCoChangeIndex(repoDir, probeRef ? { ref: probeRef } : {}),
          // Only concurrent pairs have ground truth, so only they are judged.
          pairFilter: isConcurrent,
          ...(useLlm ? { llm: createGroundedLlm({ repoDir, timeoutMs: 300_000 }), maxLlmCalls } : {}),
          warn: log,
        });
      },
    });

    const report = renderBacktestReport({
      generatedAt: new Date().toISOString(),
      repo: base,
      prsFetched: result.prsFetched,
      tasks: result.tasks,
      outcomes: result.outcomes,
      legacyMode: useLlm ? 'classifier' : 'explicit-only',
      groundedMode: useLlm ? 'llm' : 'deterministic-only',
      probeRef,
      notes: result.notes,
      stats: result.grounded.stats,
    });

    if (args.stdout) {
      process.stdout.write(report);
      return;
    }
    const output = resolve(repoDir, args.output ?? 'docs/backtest-grounded-planner.md');
    writeFileSync(output, report, 'utf8');
    log(`wrote ${output}`);
  },
});
