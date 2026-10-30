#!/usr/bin/env -S npx tsx
/**
 * MQ-0.1 (HOK-3336): one-off cost-per-task / queue-depth baseline.
 *
 * Read-only over `.wavemill/` data; writes baseline-report.md,
 * baseline-summary.json and baseline-per-task.jsonl into --feature-dir.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveMainRepo } from '../shared/lib/git-utils.ts';
import { fetchPrStates, loadBaseline, resolveBaselineSources } from '../shared/lib/cost-baseline/loader.ts';
import { aggregateBaseline } from '../shared/lib/cost-baseline/aggregator.ts';
import { DEFAULT_CI_USD_PER_MINUTE } from '../shared/lib/cost-baseline/dimensions.ts';
import {
  formatBaselineMarkdown,
  formatBaselineSummaryJson,
  formatPerTaskJsonl,
} from '../shared/lib/cost-baseline/report.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseInstant(value: string, flag: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${flag} must be an ISO date/time (got ${JSON.stringify(value)})`);
  return new Date(ms).toISOString();
}

runTool({
  name: 'analyze-cost-baseline',
  description: 'MQ-0.1 baseline: cost/wall-clock per merged task, queue depth, integration failures (HOK-3336)',
  options: {
    since: { type: 'string', description: 'Window start, ISO (default: now - 28d)' },
    until: { type: 'string', description: 'Window end, ISO (default: now)' },
    'repo-dir': { type: 'string', description: 'Repository whose .wavemill/ data is read (default: main checkout of cwd)' },
    'feature-dir': { type: 'string', description: 'Directory that receives the three output files (default: cwd)' },
    'ci-usd-per-minute': { type: 'string', description: `CI list-price rate for the $ comparison (default: ${DEFAULT_CI_USD_PER_MINUTE})` },
    'fetch-pr-state': { type: 'boolean', description: 'Read PR merge/close times with one read-only `gh pr list` call' },
    'no-write': { type: 'boolean', description: 'Do not write the output files' },
    'print-comment': { type: 'boolean', description: 'Print the Linear-ready markdown report to stdout' },
  },
  examples: [
    'npx tsx tools/analyze-cost-baseline.ts --since 2026-10-02 --until 2026-10-30T23:59:59Z --fetch-pr-state --print-comment',
    'npx tsx tools/analyze-cost-baseline.ts --feature-dir /tmp/mq-0-1 --no-write --print-comment',
  ],
  additionalHelp: `Read-only: the only network call is the opt-in --fetch-pr-state.

Operator recipe (mill host):
  1. npx tsx tools/migrate-archived-stage-artifacts.ts   # archives written before
     HOK-2891 dropped the leading dot of stage result names; the shared lookup needs it
  2. npx tsx tools/analyze-cost-baseline.ts --since <ISO> --until <ISO> \\
       --fetch-pr-state --feature-dir <dir> --print-comment
  3. Paste the printed report (decision-rule outcome first) on the Linear issue.`,
  async run({ args }) {
    const until = args.until ? parseInstant(args.until, '--until') : new Date().toISOString();
    const since = args.since ? parseInstant(args.since, '--since') : new Date(Date.parse(until) - 28 * DAY_MS).toISOString();
    if (Date.parse(since) >= Date.parse(until)) throw new Error('--since must be before --until');
    const rate = args['ci-usd-per-minute'] !== undefined ? Number(args['ci-usd-per-minute']) : DEFAULT_CI_USD_PER_MINUTE;
    if (!Number.isFinite(rate) || rate < 0) throw new Error('--ci-usd-per-minute must be a non-negative number');

    const repoDir = resolve(args['repo-dir'] ?? resolveMainRepo() ?? process.cwd());
    const sources = resolveBaselineSources(repoDir);
    const prStates = args['fetch-pr-state'] ? fetchPrStates(repoDir) : undefined;
    const loaded = await loadBaseline(sources, { since, until }, { prStates });
    const { rows, summary } = aggregateBaseline(loaded, rate);
    const markdown = formatBaselineMarkdown(summary);

    if (!args['no-write']) {
      const outDir = resolve(args['feature-dir'] ?? process.cwd());
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'baseline-report.md'), markdown);
      writeFileSync(join(outDir, 'baseline-summary.json'), formatBaselineSummaryJson(summary));
      writeFileSync(join(outDir, 'baseline-per-task.jsonl'), formatPerTaskJsonl(rows));
      console.error(`Wrote baseline-report.md, baseline-summary.json, baseline-per-task.jsonl to ${outDir}`);
    }
    if (args['print-comment']) {
      console.log(markdown);
    } else {
      const fired = summary.decisionRules.filter((r) => r.fired).map((r) => r.id);
      console.log(`${rows.length} merged task(s) ${since} → ${until}; fired: ${fired.join(', ') || 'none'}`);
    }
  },
});
