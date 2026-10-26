#!/usr/bin/env npx tsx
/**
 * Recost historical eval records for claude-opus-4-6 pricing correction.
 *
 * The model was originally priced at $15/$75 per MTok (input/output).
 * The actual price is $5/$25 per MTok. This tool corrects the
 * pricingSnapshot, workflowTokenUsage.costUsd, and workflowCost
 * fields in all affected eval JSONL files.
 *
 * @module recost-opus-4-6
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readTransformWrite } from '../shared/lib/jsonl-utils.ts';
import { computeModelCost, type ModelPricing, type ModelTokenUsage } from '../shared/lib/pricing/model-pricing.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const MODEL_ID = 'claude-opus-4-6';

const OLD_PRICING: ModelPricing = {
  inputCostPerMTok: 15,
  outputCostPerMTok: 75,
  cacheWriteCostPerMTok: 18.75,
  cacheReadCostPerMTok: 1.5,
};

const NEW_PRICING: ModelPricing = {
  inputCostPerMTok: 5,
  outputCostPerMTok: 25,
  cacheWriteCostPerMTok: 6.25,
  cacheReadCostPerMTok: 0.5,
};

// Default files relative to the current working directory (repo root)
const DEFAULT_FILES = [
  join(process.cwd(), '.wavemill', 'evals', 'evals.jsonl'),
  join(process.cwd(), '.wavemill', 'evals', 'aggregated-evals.jsonl'),
  join(process.cwd(), '.wavemill', 'evals', 'aggregated-evals.backfilled.jsonl'),
];

// ────────────────────────────────────────────────────────────────
// Transform
// ────────────────────────────────────────────────────────────────

interface EvalLike {
  workflowCost?: number;
  workflowTokenUsage?: Record<string, ModelTokenUsage>;
  pricingSnapshot?: Record<string, ModelPricing>;
  [key: string]: unknown;
}

/**
 * Transform a single eval record, correcting opus-4-6 pricing if needed.
 * Returns { record, changed } where changed=true if the record was updated.
 */
function transformRecord(record: EvalLike): { record: EvalLike; changed: boolean } {
  const snap = record.pricingSnapshot;
  const opusPricing = snap?.[MODEL_ID];

  // Only update records that have the old (incorrect) pricing snapshot
  if (!opusPricing || opusPricing.inputCostPerMTok !== OLD_PRICING.inputCostPerMTok) {
    return { record, changed: false };
  }

  const wtu = record.workflowTokenUsage;
  const opusUsage = wtu?.[MODEL_ID];

  if (!opusUsage) {
    // Has old pricing snapshot but no usage — just fix the snapshot
    return {
      record: {
        ...record,
        pricingSnapshot: {
          ...snap,
          [MODEL_ID]: NEW_PRICING,
        },
      },
      changed: true,
    };
  }

  const oldOpusCost = opusUsage.costUsd ?? 0;
  const newOpusCost = computeModelCost(opusUsage, NEW_PRICING);
  const oldWorkflowCost = record.workflowCost ?? 0;
  const newWorkflowCost = oldWorkflowCost - oldOpusCost + newOpusCost;

  return {
    record: {
      ...record,
      workflowCost: newWorkflowCost,
      workflowTokenUsage: {
        ...wtu,
        [MODEL_ID]: { ...opusUsage, costUsd: newOpusCost },
      },
      pricingSnapshot: {
        ...snap,
        [MODEL_ID]: NEW_PRICING,
      },
    },
    changed: true,
  };
}

// ────────────────────────────────────────────────────────────────
// Per-file processing
// ────────────────────────────────────────────────────────────────

interface FileResult {
  path: string;
  recordsProcessed: number;
  recordsChanged: number;
  skipped: boolean;
  error?: string;
}

function processFile(filePath: string, dryRun: boolean): FileResult {
  const result: FileResult = {
    path: filePath,
    recordsProcessed: 0,
    recordsChanged: 0,
    skipped: false,
  };

  if (!existsSync(filePath)) {
    result.skipped = true;
    result.error = 'File not found';
    return result;
  }

  try {
    const summary = readTransformWrite<EvalLike>(
      filePath,
      (record, _ctx) => transformRecord(record),
      { dryRun },
    );
    result.recordsProcessed = summary.recordsProcessed;
    result.recordsChanged = summary.recordsChanged;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// CLI Entry Point
// ────────────────────────────────────────────────────────────────

runTool({
  name: 'recost-opus-4-6',
  description: `Correct claude-opus-4-6 pricing in historical eval records (was $15/$75, now $5/$25 per MTok)`,
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be updated without modifying files',
    },
  },
  positional: {
    name: 'files',
    description: 'JSONL files to process (default: all three eval files)',
    required: false,
    multiple: true,
  },
  examples: [
    'npx tsx tools/recost-opus-4-6.ts',
    'npx tsx tools/recost-opus-4-6.ts --dry-run',
    'npx tsx tools/recost-opus-4-6.ts .wavemill/evals/evals.jsonl',
  ],
  run({ args, positional }) {
    const dryRun = !!args['dry-run'];
    const files = positional.length > 0
      ? positional.map(p => resolve(p))
      : DEFAULT_FILES;

    if (dryRun) {
      console.log('\nDRY RUN — no files will be modified\n');
    }

    console.log(`Correcting ${MODEL_ID} pricing:`);
    console.log(`  Old: input=$${OLD_PRICING.inputCostPerMTok}/MTok  output=$${OLD_PRICING.outputCostPerMTok}/MTok`);
    console.log(`  New: input=$${NEW_PRICING.inputCostPerMTok}/MTok  output=$${NEW_PRICING.outputCostPerMTok}/MTok\n`);

    let totalProcessed = 0;
    let totalChanged = 0;
    let hasErrors = false;

    for (const filePath of files) {
      const result = processFile(filePath, dryRun);

      if (result.skipped) {
        console.log(`  SKIP  ${filePath}`);
        if (result.error) console.log(`        (${result.error})`);
        continue;
      }

      if (result.error) {
        console.error(`  ERROR ${filePath}: ${result.error}`);
        hasErrors = true;
        continue;
      }

      const label = dryRun ? 'would update' : 'updated';
      console.log(`  ${filePath}`);
      console.log(`    processed: ${result.recordsProcessed}  ${label}: ${result.recordsChanged}`);

      totalProcessed += result.recordsProcessed;
      totalChanged += result.recordsChanged;
    }

    console.log(`\nTotal: ${totalProcessed} records processed, ${totalChanged} ${dryRun ? 'would be ' : ''}updated`);

    if (hasErrors) {
      throw new Error('One or more files could not be processed');
    }
  },
});
