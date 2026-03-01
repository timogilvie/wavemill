#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { writeFileSync } from 'node:fs';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { exportEvalDataset } from '../shared/lib/eval-export.ts';
import type { ExportFormat } from '../shared/lib/eval-export.ts';

runTool({
  name: 'eval-export',
  description: 'Export eval records for ML training',
  options: {
    format: { type: 'string', description: 'Output format: csv or jsonl (default: jsonl)' },
    output: { type: 'string', short: 'o', description: 'Write to file instead of stdout' },
    redact: { type: 'boolean', description: 'Anonymize emails, URLs, and file paths in prompts' },
    from: { type: 'string', description: 'Include records from this date (YYYY-MM-DD)' },
    to: { type: 'string', description: 'Include records up to this date (YYYY-MM-DD)' },
    model: { type: 'string', description: 'Filter to a specific model identifier' },
    'min-score': { type: 'string', description: 'Include only records with score >= N' },
    'max-score': { type: 'string', description: 'Include only records with score <= N' },
    dir: { type: 'string', description: 'Override evals directory' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  examples: [
    'npx tsx tools/eval-export.ts',
    'npx tsx tools/eval-export.ts --format csv --redact -o dataset.csv',
    'npx tsx tools/eval-export.ts --model claude-opus-4-6 --from 2026-01-01',
  ],
  additionalHelp: `Exports eval records in ML-training-ready formats (CSV, JSONL).

Output Formats:
  jsonl   Newline-delimited JSON (default) — best for streaming & pandas
  csv     Comma-separated values — universal compatibility

Load into pandas:
  import pandas as pd
  df = pd.read_json('dataset.jsonl', lines=True)
  df = pd.read_csv('dataset.csv')`,
  run({ args }) {
    const format = (args.format || 'jsonl') as ExportFormat;

    if (format !== 'csv' && format !== 'jsonl') {
      console.error(`Error: unsupported format "${format}". Use "csv" or "jsonl".`);
      process.exit(1);
    }

    const records = readEvalRecords({
      dir: args.dir as string | undefined,
      model: args.model as string | undefined,
      after: args.from ? new Date(args.from as string) : undefined,
      before: args.to ? new Date((args.to as string) + 'T23:59:59') : undefined,
      minScore: args['min-score'] ? Number(args['min-score']) : undefined,
      maxScore: args['max-score'] ? Number(args['max-score']) : undefined,
    });

    if (records.length === 0) {
      console.error('No eval records found matching the given filters.');
      process.exit(0);
    }

    const output = exportEvalDataset({
      format,
      records,
      redact: !!args.redact,
    });

    if (args.output) {
      writeFileSync(args.output as string, output, 'utf-8');
      console.error(`Exported ${records.length} record(s) to ${args.output} (${format})`);
    } else {
      process.stdout.write(output);
      if (process.stderr.isTTY) {
        console.error(`\nExported ${records.length} record(s) as ${format}`);
      }
    }
  },
});
