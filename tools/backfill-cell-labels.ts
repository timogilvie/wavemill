#!/usr/bin/env -S npx tsx

/**
 * HOK-3361 — Rework-risk cell-label backfill and report CLI.
 *
 * Thin wrapper over shared/lib/cell-backfill.ts and shared/lib/cell-report.ts
 * (the thin-tools pattern: business logic lives in shared/lib).
 *
 * Backfill mode reads the authoritative `cr-0.1.0` rework corpus, classifies
 * each confirmed rework into a review layer x lens cell (structural first,
 * bounded LLM fallback), and appends validated `cell-0.1.0` rows to the
 * append-only stream. Rows are never rewritten; re-runs append and the latest
 * computed_at per natural key wins at query time.
 *
 * Report mode deduplicates the stream by natural key and prints the
 * experiment report: distributions by row/column/cell, unknown share,
 * structural-vs-LLM agreement, reviewer/challenge cross-tabs with evidence
 * coverage, a deterministic 10-15 disagreement sample, and the conservative
 * targeted-reviewer verdict.
 */

import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  backfillCellLabels,
  createDefaultCellBackfillDeps,
  loadDeduplicatedCellLabels,
} from '../shared/lib/cell-backfill.ts';
import { buildCellReport, type CellReportOptions } from '../shared/lib/cell-report.ts';

runTool({
  name: 'backfill-cell-labels',
  description: 'Backfill cell-0.1.0 rework-risk cell labels and report per-cell distributions',
  options: {
    'cr-labels': { type: 'string', description: 'Path to the authoritative cr-0.1.0 rework corpus (JSONL; backfill mode)' },
    'repo-dir': { type: 'string', description: 'Local checkout used to resolve corrective diffs (default: .)' },
    out: { type: 'string', description: 'Append-only cell-0.1.0 JSONL output stream (backfill mode)' },
    report: { type: 'boolean', description: 'Report mode: aggregate an existing cell-label stream' },
    labels: { type: 'string', description: 'Path to the cell-0.1.0 stream to report on (report mode)' },
    llm: { type: 'boolean', description: 'Enable the bounded LLM fallback during backfill (default: disabled)' },
    'sample-size': { type: 'string', description: 'Disagreement sample size, clamped to 10-15 (default: 12)' },
    'min-cell-support': { type: 'string', description: 'Minimum labelled reviewer misses for a targeted-reviewer verdict (default: 5)' },
    'computed-at': { type: 'string', description: 'Override the computed_at stamp (ISO; for deterministic replays)' },
  },
  examples: [
    'npx tsx tools/backfill-cell-labels.ts --cr-labels cr-labels.jsonl --out cell-labels.jsonl',
    'npx tsx tools/backfill-cell-labels.ts --report --labels cell-labels.jsonl --sample-size 12',
  ],
  async run({ args }) {
    if (args.report) {
      const labelsPath = args.labels as string | undefined;
      if (!labelsPath) {
        throw new Error('--labels is required in report mode');
      }
      const options: CellReportOptions = {};
      if (args['sample-size']) options.sampleSize = Number(args['sample-size']);
      if (args['min-cell-support']) options.minCellSupport = Number(args['min-cell-support']);
      const rows = loadDeduplicatedCellLabels(labelsPath);
      console.log(JSON.stringify(buildCellReport(rows, options), null, 2));
      return;
    }

    const crLabelsPath = args['cr-labels'] as string | undefined;
    if (!crLabelsPath) {
      throw new Error('--cr-labels is required in backfill mode (or pass --report --labels <stream>)');
    }
    const deps = createDefaultCellBackfillDeps();
    const result = await backfillCellLabels({
      crLabelsPath,
      repoDir: resolve((args['repo-dir'] as string | undefined) || '.'),
      ...(args.out ? { outPath: args.out as string } : {}),
      useLlm: args.llm === true,
      computedAt: (args['computed-at'] as string | undefined) ?? new Date().toISOString(),
      deps,
    });
    for (const row of result.rows) {
      console.log(JSON.stringify(row));
    }
    for (const skip of result.skipped) {
      console.error(`[backfill-cell-labels] skipped ${skip.correctivePrUrl}: ${skip.reason}`);
    }
    console.error(`[backfill-cell-labels] emitted ${result.rows.length} cell rows`);
  },
});