#!/usr/bin/env -S npx tsx

/**
 * Eval Export CLI Tool
 *
 * Exports eval records in ML-training-ready formats (CSV, JSONL)
 * for building a router model that predicts the best LLM for a given prompt.
 *
 * Usage:
 *   npx tsx tools/eval-export.ts
 *   npx tsx tools/eval-export.ts --format csv --redact --output dataset.csv
 */

import { writeFileSync } from 'node:fs';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { exportEvalDataset } from '../shared/lib/eval-export.ts';
import type { ExportFormat } from '../shared/lib/eval-export.ts';

// ── Argument Parsing ─────────────────────────────────────────────────────────

interface Args {
  format: ExportFormat;
  output: string;
  redact: boolean;
  from: string;
  to: string;
  model: string;
  minScore: string;
  maxScore: string;
  dir: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    format: 'jsonl',
    output: '',
    redact: false,
    from: '',
    to: '',
    model: '',
    minScore: '',
    maxScore: '',
    dir: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--format':
        args.format = argv[++i] as ExportFormat;
        break;
      case '--output':
      case '-o':
        args.output = argv[++i];
        break;
      case '--redact':
        args.redact = true;
        break;
      case '--from':
        args.from = argv[++i];
        break;
      case '--to':
        args.to = argv[++i];
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--min-score':
        args.minScore = argv[++i];
        break;
      case '--max-score':
        args.maxScore = argv[++i];
        break;
      case '--dir':
        args.dir = argv[++i];
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
Eval Export Tool — Export eval records for ML training

Usage:
  npx tsx tools/eval-export.ts [options]
  wavemill eval export [options]

Output Formats:
  jsonl   Newline-delimited JSON (default) — best for streaming & pandas
  csv     Comma-separated values — universal compatibility

Options:
  --format csv|jsonl    Output format (default: jsonl)
  --output FILE, -o     Write to file instead of stdout
  --redact              Anonymize emails, URLs, and file paths in prompts
  --from YYYY-MM-DD     Include records from this date (inclusive)
  --to YYYY-MM-DD       Include records up to this date (inclusive)
  --model MODEL         Filter to a specific model identifier
  --min-score N         Include only records with score >= N
  --max-score N         Include only records with score <= N
  --dir DIR             Override evals directory
  --help, -h            Show this help message

Examples:
  # Export all records as JSONL
  wavemill eval export

  # Export redacted CSV for sharing
  wavemill eval export --format csv --redact -o dataset.csv

  # Filter to a specific model and date range
  wavemill eval export --model claude-opus-4-6 --from 2026-01-01

  # Load into pandas
  #   import pandas as pd
  #   df = pd.read_json('dataset.jsonl', lines=True)
  #   df = pd.read_csv('dataset.csv')
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.format !== 'csv' && args.format !== 'jsonl') {
    console.error(`Error: unsupported format "${args.format}". Use "csv" or "jsonl".`);
    process.exit(1);
  }

  // Read records with filters
  const records = readEvalRecords({
    dir: args.dir || undefined,
    model: args.model || undefined,
    after: args.from ? new Date(args.from) : undefined,
    before: args.to ? new Date(args.to + 'T23:59:59') : undefined,
    minScore: args.minScore ? Number(args.minScore) : undefined,
    maxScore: args.maxScore ? Number(args.maxScore) : undefined,
  });

  if (records.length === 0) {
    console.error('No eval records found matching the given filters.');
    process.exit(0);
  }

  // Export
  const output = exportEvalDataset({
    format: args.format,
    records,
    redact: args.redact,
  });

  // Write output
  if (args.output) {
    writeFileSync(args.output, output, 'utf-8');
    console.error(`Exported ${records.length} record(s) to ${args.output} (${args.format})`);
  } else {
    process.stdout.write(output);
    if (process.stderr.isTTY) {
      console.error(`\nExported ${records.length} record(s) as ${args.format}`);
    }
  }
}

main();
