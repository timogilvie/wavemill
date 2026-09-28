#!/usr/bin/env -S npx tsx

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readJsonlFile } from '../shared/lib/jsonl-utils.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';
import { ARBITER_JUDGE_PROMPT_TEMPLATE_FILE, type PresentationOrder } from '../shared/lib/pr-comparison.ts';
import { readChallengeRecordVoids } from '../shared/lib/challenge-record-void.ts';
import type { StoredChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import { selectAdjudicatedPairs } from '../shared/lib/swap-test/pair-selection.ts';
import { hydrateCorpus } from '../shared/lib/swap-test/corpus.ts';
import { runSwapTest } from '../shared/lib/swap-test/runner.ts';
import { writeSwapTestReport, renderSwapTestSummaryMarkdown } from '../shared/lib/swap-test/report.ts';

function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOrder(value: string | undefined): PresentationOrder | undefined {
  if (!value) return undefined;
  if (value === 'primary-first' || value === 'challenger-first') return value;
  throw new Error(`Invalid order: ${value}`);
}

runTool({
  name: 'swap-test',
  description: 'Hydrate, replay, and report the Arbiter presentation-order swap test.',
  options: {
    hydrate: { type: 'boolean', description: 'Hydrate local diff corpus for selected adjudicated pairs' },
    run: { type: 'boolean', description: 'Run or resume the blinded judge replay' },
    report: { type: 'boolean', description: 'Write summary.json and summary.md for a run' },
    'dry-run': { type: 'boolean', description: 'Build prompts and estimate token count without LLM calls' },
    'run-id': { type: 'string', description: 'Run identifier' },
    'judge-model': { type: 'string', description: 'Judge model override' },
    'max-cost-usd': { type: 'string', description: 'Stop when cumulative replay cost reaches this amount' },
    pairs: { type: 'string', description: 'Comma-separated pair IDs to include' },
    limit: { type: 'string', description: 'Limit selected pairs for smoke tests' },
    concurrency: { type: 'string', description: 'Concurrent judge calls, bounded by the runner' },
    force: { type: 'boolean', description: 'Re-run rows already present in results.jsonl' },
    'only-order': { type: 'string', description: 'Only run primary-first or challenger-first' },
    'repo-dir': { type: 'string', description: 'Repository directory for config and GitHub CLI calls' },
    'evals-dir': { type: 'string', description: 'Eval corpus directory' },
    records: { type: 'string', description: 'Alternate challenge-records.jsonl path' },
  },
  examples: [
    'npx tsx tools/swap-test.ts --hydrate',
    'npx tsx tools/swap-test.ts --run --dry-run',
    'npx tsx tools/swap-test.ts --run --max-cost-usd 200',
    'npx tsx tools/swap-test.ts --report --run-id swap-2026-08-22',
  ],
  async run({ args }) {
    const repoDir = (args['repo-dir'] as string | undefined) ?? process.cwd();
    const evalsDir = resolveEvalsDir(args['evals-dir'] as string | undefined, repoDir).dir;
    const recordsPath = (args.records as string | undefined) ?? join(evalsDir, 'challenge-records.jsonl');
    if (!existsSync(recordsPath)) {
      throw new Error(`No challenge records found at ${recordsPath}`);
    }

    const records = readJsonlFile<StoredChallengeComparison>(recordsPath);
    const voids = readChallengeRecordVoids(dirname(recordsPath));
    const selected = selectAdjudicatedPairs(records, voids);
    const requestedPairs = splitCsv(args.pairs as string | undefined);
    const limit = args.limit ? Number.parseInt(args.limit as string, 10) : undefined;
    let pairs = requestedPairs
      ? selected.pairs.filter((pair) => requestedPairs.includes(pair.pairId))
      : selected.pairs;
    if (limit && Number.isFinite(limit)) {
      pairs = pairs.slice(0, limit);
    }
    const pairIds = pairs.map((pair) => pair.pairId);

    const runId = (args['run-id'] as string | undefined) ?? `swap-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const config = loadWavemillConfig(repoDir);
    const judgeModel = (args['judge-model'] as string | undefined)
      ?? config.challenge?.comparisonModel
      ?? 'claude-opus-4-7';
    const maxPromptBytes = Number.parseInt(process.env.CHALLENGE_COMPARISON_MAX_PROMPT_BYTES || '500000', 10);
    const promptTemplate = await loadPromptTemplate(ARBITER_JUDGE_PROMPT_TEMPLATE_FILE, { dir: evalsDir });

    if (args.hydrate) {
      const ledger = hydrateCorpus({ pairs, evalsDir, repoDir });
      console.log(JSON.stringify({ selection: selected.ledger, hydration: ledger }, null, 2));
    }

    if (args.run) {
      const summary = await runSwapTest({
        evalsDir,
        runId,
        pairIds,
        judgeModel,
        promptTemplate,
        maxPromptBytes: Number.isFinite(maxPromptBytes) ? maxPromptBytes : 500000,
        concurrency: Number.parseInt((args.concurrency as string | undefined) ?? '2', 10),
        maxCostUsd: args['max-cost-usd'] ? parseNumber(args['max-cost-usd'] as string, Number.POSITIVE_INFINITY) : undefined,
        dryRun: args['dry-run'] === true,
        force: args.force === true,
        onlyOrder: parseOrder(args['only-order'] as string | undefined),
      });
      const estimateTokens = args['dry-run']
        ? readFileSync(join(evalsDir, 'swap-test', 'runs', runId, 'results.jsonl'), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { promptBytes?: { final?: number } })
          .reduce((sum, row) => sum + Math.ceil((row.promptBytes?.final ?? 0) / 4), 0)
        : undefined;
      console.log(JSON.stringify({ ...summary, estimatedTokens: estimateTokens }, null, 2));
    }

    if (args.report) {
      const summary = writeSwapTestReport(evalsDir, runId, pairIds);
      const resultsDoc = join(repoDir, 'docs', 'arbiter', 'swap-test-results.md');
      writeFileSync(resultsDoc, renderSwapTestSummaryMarkdown(summary), 'utf-8');
      console.log(JSON.stringify({
        runId,
        summary: join(evalsDir, 'swap-test', 'runs', runId, 'summary.md'),
        resultsDoc,
      }, null, 2));
    }
  },
});
