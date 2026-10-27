#!/usr/bin/env npx tsx
/**
 * Backfill pricing snapshots to existing eval records.
 *
 * Updates eval records that have workflowTokenUsage but no pricingSnapshot
 * by adding the current pricing table from .wavemill-config.json.
 *
 * @module backfill-pricing-snapshot
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import type { ModelPricing } from '../shared/lib/pricing/model-pricing.ts';
import { readTransformWrite } from '../shared/lib/jsonl-utils.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface BackfillStats {
  filesProcessed: number;
  recordsUpdated: number;
  recordsSkipped: number;
  recordsAlreadyHaveSnapshot: number;
  recordsWithoutWorkflowUsage: number;
  errors: string[];
}

// ────────────────────────────────────────────────────────────────
// Main Logic
// ────────────────────────────────────────────────────────────────

/**
 * Backfill pricing snapshots for all eval records in a repository.
 *
 * @param repoDir - Absolute path to repository directory
 * @param dryRun - If true, show what would be updated without modifying files
 * @returns Statistics about the backfill operation
 */
function backfillRepo(repoDir: string, dryRun: boolean): BackfillStats {
  const stats: BackfillStats = {
    filesProcessed: 0,
    recordsUpdated: 0,
    recordsSkipped: 0,
    recordsAlreadyHaveSnapshot: 0,
    recordsWithoutWorkflowUsage: 0,
    errors: [],
  };

  // Load pricing table from repo config
  const config = loadWavemillConfig(repoDir);
  const pricingTable = config.eval?.pricing || {};

  if (Object.keys(pricingTable).length === 0) {
    stats.errors.push('No pricing table found in .wavemill-config.json');
    return stats;
  }

  // Find eval directory
  const evalsDir = config.eval?.evalsDir
    ? resolve(repoDir, config.eval.evalsDir)
    : join(repoDir, '.wavemill', 'evals');

  if (!existsSync(evalsDir)) {
    stats.errors.push(`Evals directory not found: ${evalsDir}`);
    return stats;
  }

  // Process all .jsonl files
  const files = readdirSync(evalsDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = join(evalsDir, file);
    stats.filesProcessed++;

    try {
      readTransformWrite<EvalRecord>(filePath, (record) => {
        const workflowTokenUsage = record.workflowTokenUsage;

        if (record.pricingSnapshot) {
          stats.recordsAlreadyHaveSnapshot++;
          return { record, changed: false };
        }

        if (!workflowTokenUsage) {
          stats.recordsWithoutWorkflowUsage++;
          return { record, changed: false };
        }

        const pricingSnapshot: Record<string, ModelPricing> = {};
        const modelsUsed = Object.keys(workflowTokenUsage);

        for (const modelId of modelsUsed) {
          const pricing = pricingTable[modelId];
          if (pricing) {
            pricingSnapshot[modelId] = pricing;
          }
        }

        if (Object.keys(pricingSnapshot).length > 0) {
          stats.recordsUpdated++;
          return {
            record: {
              ...record,
              pricingSnapshot,
            },
            changed: true,
          };
        }

        stats.recordsSkipped++;
        return { record, changed: false };
      }, { dryRun });
    } catch (err) {
      stats.errors.push(`Error processing ${file}: ${errorMessage(err)}`);
    }
  }

  return stats;
}

/**
 * Print backfill statistics.
 */
function printStats(repoPath: string, stats: BackfillStats, dryRun: boolean): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Repository: ${repoPath}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes made)' : 'LIVE'}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Files processed:                ${stats.filesProcessed}`);
  console.log(`Records updated:                ${stats.recordsUpdated}`);
  console.log(`Records skipped (no pricing):   ${stats.recordsSkipped}`);
  console.log(`Records already have snapshot:  ${stats.recordsAlreadyHaveSnapshot}`);
  console.log(`Records without workflow usage: ${stats.recordsWithoutWorkflowUsage}`);

  if (stats.errors.length > 0) {
    console.log(`\nErrors (${stats.errors.length}):`);
    stats.errors.forEach(err => console.log(`  • ${err}`));
  }

  console.log(`${'─'.repeat(60)}\n`);
}

// ────────────────────────────────────────────────────────────────
// CLI Entry Point
// ────────────────────────────────────────────────────────────────

runTool({
  name: 'backfill-pricing-snapshot',
  description: 'Backfill pricing snapshots to existing eval records',
  options: {
    'dry-run': { type: 'boolean', description: 'Show what would be updated without modifying files' },
  },
  positional: {
    name: 'repo-path',
    description: 'Absolute path to repository directory',
    required: true,
    multiple: true,
  },
  examples: [
    'npx tsx tools/backfill-pricing-snapshot.ts /Users/tim/myrepo',
    'npx tsx tools/backfill-pricing-snapshot.ts /Users/tim/myrepo --dry-run',
  ],
  run({ args, positional }) {
    const dryRun = !!args['dry-run'];
    const repoPaths = positional.map(p => resolve(p));

    let totalStats: BackfillStats = {
      filesProcessed: 0,
      recordsUpdated: 0,
      recordsSkipped: 0,
      recordsAlreadyHaveSnapshot: 0,
      recordsWithoutWorkflowUsage: 0,
      errors: [],
    };

    for (const repoPath of repoPaths) {
      if (!existsSync(repoPath)) {
        console.error(`Error: Repository path does not exist: ${repoPath}`);
        continue;
      }

      const stats = backfillRepo(repoPath, dryRun);
      printStats(repoPath, stats, dryRun);

      // Aggregate stats
      totalStats.filesProcessed += stats.filesProcessed;
      totalStats.recordsUpdated += stats.recordsUpdated;
      totalStats.recordsSkipped += stats.recordsSkipped;
      totalStats.recordsAlreadyHaveSnapshot += stats.recordsAlreadyHaveSnapshot;
      totalStats.recordsWithoutWorkflowUsage += stats.recordsWithoutWorkflowUsage;
      totalStats.errors.push(...stats.errors.map(e => `${repoPath}: ${e}`));
    }

    if (repoPaths.length > 1) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log('TOTAL SUMMARY');
      console.log(`${'═'.repeat(60)}`);
      console.log(`Repositories processed:         ${repoPaths.length}`);
      console.log(`Files processed:                ${totalStats.filesProcessed}`);
      console.log(`Records updated:                ${totalStats.recordsUpdated}`);
      console.log(`Records skipped:                ${totalStats.recordsSkipped}`);
      console.log(`Records already have snapshot:  ${totalStats.recordsAlreadyHaveSnapshot}`);
      console.log(`Records without workflow usage: ${totalStats.recordsWithoutWorkflowUsage}`);
      console.log(`Total errors:                   ${totalStats.errors.length}`);
      console.log(`${'═'.repeat(60)}\n`);
    }

    if (totalStats.errors.length > 0) {
      throw new Error(`Backfill completed with ${totalStats.errors.length} error(s)`);
    }
  },
});
