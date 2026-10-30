#!/usr/bin/env -S npx tsx

/**
 * Rework Risk: cell-0.1.0 analysis and reporting CLI (HOK-3361).
 *
 * Deduplicates derived label streams by versioned natural key, computes
 * distributions by row/column/cell, unknown share, structural vs LLM
 * agreement rate, reviewer and challenge-stage cross-tabs with evidence
 * coverage, deterministic disagreement review sample, and conservative
 * reviewer / adoption verdicts.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import { parseReworkCellLabelsJsonl } from '../shared/lib/rework-cell-label.ts';
import { formatReportText, generateReworkCellReport } from '../shared/lib/rework-cell-report.ts';

const DEFAULT_INPUT = '.wavemill/evals/rework-cell-labels.jsonl';

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  runTool({
  name: 'report-rework-cells',
  description: 'Generate report and conservative adoption verdicts for cell-0.1.0 rework defect labels',
  options: {
    input: { type: 'string', description: `Path to rework-cell-labels.jsonl (default: ${DEFAULT_INPUT})` },
    json: { type: 'boolean', description: 'Emit structured JSON instead of human-readable text' },
    'sample-size': { type: 'string', description: 'Number of disagreement rows to sample (default: 15)' },
    out: { type: 'string', description: 'Write report to file instead of stdout' },
  },
  examples: [
    'npx tsx tools/report-rework-cells.ts',
    'npx tsx tools/report-rework-cells.ts --input .wavemill/evals/rework-cell-labels.jsonl --json',
    'npx tsx tools/report-rework-cells.ts --sample-size 10 --out report.md',
  ],
  run({ args }) {
    const inputPath = (args.input as string | undefined) || DEFAULT_INPUT;
    const resolvedInput = resolve(inputPath);

    if (!existsSync(resolvedInput)) {
      throw new Error(`Input file does not exist: ${resolvedInput}`);
    }

    const content = readFileSync(resolvedInput, 'utf-8');
    const { records, errors } = parseReworkCellLabelsJsonl(content);

    if (errors.length > 0) {
      process.stderr.write(`[report-rework-cells] Warning: encountered ${errors.length} invalid lines in ${inputPath}\n`);
    }

    const sampleSize = args['sample-size'] ? Number(args['sample-size']) : 15;
    const report = generateReworkCellReport(records, { sampleSize });

    const emitJson = args.json === true;
    const formatted = emitJson
      ? JSON.stringify(report, null, 2)
      : formatReportText(report);

    const outPath = args.out ? resolve(args.out as string) : undefined;
    if (outPath) {
      writeFileSync(outPath, formatted, 'utf-8');
      process.stderr.write(`[report-rework-cells] Wrote report to ${outPath}\n`);
    } else {
      process.stdout.write(formatted + '\n');
    }
  },
});
}
