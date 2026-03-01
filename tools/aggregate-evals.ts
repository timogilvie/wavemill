#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { getEvalConfig } from '../shared/lib/config.ts';

// ── Config Loading ───────────────────────────────────────────────────────────

interface AggregationConfig {
  repos: string[];
  outputPath: string;
}

function loadAggregationConfig(): AggregationConfig {
  const defaults: AggregationConfig = {
    repos: [],
    outputPath: '.wavemill/evals/aggregated-evals.jsonl',
  };

  const evalConfig = getEvalConfig();
  const agg = evalConfig.aggregation;

  if (agg) {
    if (Array.isArray(agg.repos)) defaults.repos = agg.repos;
    if (agg.outputPath) defaults.outputPath = agg.outputPath;
  }

  return defaults;
}

// ── Core Logic ───────────────────────────────────────────────────────────────

interface EvalRecord {
  id: string;
  sourceRepo?: string;
  [key: string]: unknown;
}

function readEvalsFromRepo(repoDir: string): EvalRecord[] {
  const evalsFile = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  if (!existsSync(evalsFile)) return [];

  const content = readFileSync(evalsFile, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: EvalRecord[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as EvalRecord;
      record.sourceRepo = basename(repoDir);
      records.push(record);
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

runTool({
  name: 'aggregate-evals',
  description: 'Aggregate eval records from multiple repositories',
  options: {
    repos: { type: 'string', multiple: true, description: 'Repository directories to aggregate from' },
    output: { type: 'string', short: 'o', description: 'Output path (default: .wavemill/evals/aggregated-evals.jsonl)' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  examples: [
    'npx tsx tools/aggregate-evals.ts',
    'npx tsx tools/aggregate-evals.ts --repos ~/proj1 ~/proj2',
    'npx tsx tools/aggregate-evals.ts --output custom-path.jsonl',
  ],
  additionalHelp: `Collects eval records from multiple repositories into a single
aggregated JSONL file for cross-repo analysis and DSPy training.

If --repos is omitted, reads eval.aggregation.repos from .wavemill-config.json.`,
  run({ args }) {
    const config = loadAggregationConfig();

    const repos = Array.isArray(args.repos) ? args.repos : (args.repos ? [args.repos] : config.repos);

    const currentRepo = resolve('.');
    const repoSet = new Set([currentRepo, ...repos.map((r) => resolve(r))]);

    if (repoSet.size === 1 && repos.length === 0) {
      console.error(
        'No external repos configured. Add repos via --repos flag or set eval.aggregation.repos in .wavemill-config.json.',
      );
      console.error('Aggregating current repo only.');
    }

    const allRecords: EvalRecord[] = [];
    const seenIds = new Set<string>();
    const repoStats: Record<string, number> = {};

    for (const repoDir of repoSet) {
      const repoName = basename(repoDir);
      const records = readEvalsFromRepo(repoDir);
      let added = 0;

      for (const record of records) {
        if (!seenIds.has(record.id)) {
          seenIds.add(record.id);
          allRecords.push(record);
          added++;
        }
      }

      repoStats[repoName] = added;
    }

    allRecords.sort((a, b) => {
      const ta = String(a.timestamp || '');
      const tb = String(b.timestamp || '');
      return ta.localeCompare(tb);
    });

    const outputPath = resolve(args.output || config.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      allRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );

    console.log(`Aggregated ${allRecords.length} records from ${Object.keys(repoStats).length} repos:`);
    for (const [repo, count] of Object.entries(repoStats).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${repo}: ${count} records`);
    }
    console.log(`\nOutput: ${outputPath}`);
  },
});
