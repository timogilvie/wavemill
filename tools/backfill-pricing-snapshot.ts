#!/usr/bin/env npx tsx
/**
 * Backfill pricing snapshots to existing eval records.
 *
 * Updates eval records that have workflowTokenUsage but no pricingSnapshot
 * by adding the current pricing table from .wavemill-config.json.
 *
 * Usage:
 *   npx tsx tools/backfill-pricing-snapshot.ts /path/to/repo [--dry-run]
 *
 * @module backfill-pricing-snapshot
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import type { ModelPricing } from '../shared/lib/workflow-cost.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface EvalRecord {
  workflowTokenUsage?: Record<string, {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  pricingSnapshot?: Record<string, ModelPricing>;
  [key: string]: unknown;
}

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
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const updatedLines: string[] = [];
      let fileModified = false;

      for (const line of lines) {
        let record: EvalRecord;

        try {
          record = JSON.parse(line);
        } catch (parseErr) {
          stats.errors.push(`Failed to parse record in ${file}: ${parseErr}`);
          updatedLines.push(line); // Keep original line
          continue;
        }

        // Skip if already has pricingSnapshot
        if (record.pricingSnapshot) {
          stats.recordsAlreadyHaveSnapshot++;
          updatedLines.push(line);
          continue;
        }

        // Skip if no workflowTokenUsage
        if (!record.workflowTokenUsage) {
          stats.recordsWithoutWorkflowUsage++;
          updatedLines.push(line);
          continue;
        }

        // Build pricing snapshot with only models that were used
        const pricingSnapshot: Record<string, ModelPricing> = {};
        const modelsUsed = Object.keys(record.workflowTokenUsage);

        for (const modelId of modelsUsed) {
          const pricing = pricingTable[modelId];
          if (pricing) {
            pricingSnapshot[modelId] = pricing;
          }
        }

        // Only add pricingSnapshot if we found pricing for at least one model
        if (Object.keys(pricingSnapshot).length > 0) {
          record.pricingSnapshot = pricingSnapshot;
          updatedLines.push(JSON.stringify(record));
          stats.recordsUpdated++;
          fileModified = true;
        } else {
          stats.recordsSkipped++;
          updatedLines.push(line);
        }
      }

      // Write back if modified and not dry-run
      if (fileModified && !dryRun) {
        // Create backup
        const backupPath = `${filePath}.backup`;
        copyFileSync(filePath, backupPath);

        // Write updated content
        writeFileSync(filePath, updatedLines.join('\n') + '\n', 'utf-8');
      }
    } catch (err) {
      stats.errors.push(`Error processing ${file}: ${err}`);
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

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: npx tsx tools/backfill-pricing-snapshot.ts <repo-path> [--dry-run]

Backfill pricing snapshots to existing eval records.

Arguments:
  repo-path    Absolute path to repository directory

Options:
  --dry-run    Show what would be updated without modifying files
  --help, -h   Show this help message

Examples:
  npx tsx tools/backfill-pricing-snapshot.ts /Users/tim/myrepo
  npx tsx tools/backfill-pricing-snapshot.ts /Users/tim/myrepo --dry-run
`);
    process.exit(0);
  }

  const repoPaths: string[] = [];
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else {
      repoPaths.push(resolve(arg));
    }
  }

  if (repoPaths.length === 0) {
    console.error('Error: No repository path provided');
    process.exit(1);
  }

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
    process.exit(1);
  }
}

main();
