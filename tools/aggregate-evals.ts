#!/usr/bin/env -S npx tsx

/**
 * Aggregate Evals Tool
 *
 * Collects eval records from multiple repositories into a single
 * aggregated JSONL file for cross-repo analysis and DSPy training.
 *
 * Usage:
 *   npx tsx tools/aggregate-evals.ts
 *   npx tsx tools/aggregate-evals.ts --repos ~/proj1 ~/proj2
 *   npx tsx tools/aggregate-evals.ts --output .wavemill/evals/aggregated-evals.jsonl
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { getEvalConfig } from '../shared/lib/config.ts';

// ── Argument Parsing ─────────────────────────────────────────────────────────

interface Args {
  repos: string[];
  output: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repos: [],
    output: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repos':
        while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
          args.repos.push(argv[++i]);
        }
        break;
      case '--output':
      case '-o':
        args.output = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
Aggregate Evals Tool — Collect eval records from multiple repositories

Usage:
  npx tsx tools/aggregate-evals.ts [options]

Options:
  --repos PATH [PATH...]   Repository directories to aggregate from.
                            If omitted, reads eval.aggregation.repos from
                            .wavemill-config.json.
  --output FILE, -o        Output path (default: .wavemill/evals/aggregated-evals.jsonl)
  --help, -h               Show this help message

Examples:
  # Aggregate using repos from config
  npx tsx tools/aggregate-evals.ts

  # Aggregate specific repos
  npx tsx tools/aggregate-evals.ts --repos ~/Dropbox/Hokusai/hokusai-site ~/Dropbox/Hokusai/hokusai-data-pipeline
`);
}

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

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const config = loadAggregationConfig();

  // Determine repos list
  let repos = args.repos.length > 0 ? args.repos : config.repos;

  // Always include the current repo
  const currentRepo = resolve('.');
  const repoSet = new Set([currentRepo, ...repos.map((r) => resolve(r))]);

  if (repoSet.size === 1 && repos.length === 0) {
    console.error(
      'No external repos configured. Add repos via --repos flag or set eval.aggregation.repos in .wavemill-config.json.',
    );
    console.error('Aggregating current repo only.');
  }

  // Collect records
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

  // Sort by timestamp
  allRecords.sort((a, b) => {
    const ta = String(a.timestamp || '');
    const tb = String(b.timestamp || '');
    return ta.localeCompare(tb);
  });

  // Write output
  const outputPath = resolve(args.output || config.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    allRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );

  // Report
  console.log(`Aggregated ${allRecords.length} records from ${Object.keys(repoStats).length} repos:`);
  for (const [repo, count] of Object.entries(repoStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${repo}: ${count} records`);
  }
  console.log(`\nOutput: ${outputPath}`);
}

main();
