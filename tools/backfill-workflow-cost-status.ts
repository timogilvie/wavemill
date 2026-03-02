#!/usr/bin/env -S npx tsx

/**
 * Backfill workflow cost status for existing eval records (HOK-883).
 *
 * Adds workflowCostStatus and workflowCostDiagnostics fields to eval records
 * that don't have them, attempting to re-compute missing costs where possible.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { computeWorkflowCost, loadPricingTable } from '../shared/lib/workflow-cost.ts';

interface BackfillStats {
  total: number;
  alreadyHadStatus: number;
  successfulBackfill: number;
  recoveredCost: number;
  statusSet: Record<string, number>;
}

/**
 * Read eval records from a JSONL file.
 */
function readEvalRecords(filePath: string): EvalRecord[] {
  if (!existsSync(filePath)) {
    throw new Error(`Eval file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: EvalRecord[] = [];

  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as EvalRecord);
    } catch {
      console.warn(`Skipping malformed line: ${line.substring(0, 50)}...`);
    }
  }

  return records;
}

/**
 * Write eval records to a JSONL file atomically.
 */
function writeEvalRecords(filePath: string, records: EvalRecord[]): void {
  const tmpPath = join(dirname(filePath), `.backfill-${randomUUID()}.tmp`);
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Attempt to recover workflow cost for a record that doesn't have it.
 */
function attemptCostRecovery(
  record: EvalRecord,
  repoDir: string,
  pricingTable: any,
): { cost?: number; tokenUsage?: any; reason?: string } {
  // Need metadata to attempt recovery
  const meta = record.metadata as any;
  if (!meta) {
    return { reason: 'No metadata available for recovery' };
  }

  // Extract worktree path and branch from metadata
  const worktreePath = meta.worktreePath;
  const branchName = meta.branchName;

  if (!worktreePath || !branchName) {
    return { reason: 'Missing worktreePath or branchName in metadata' };
  }

  try {
    const costOutcome = computeWorkflowCost({
      worktreePath,
      branchName,
      repoDir,
      pricingTable,
      agentType: record.agentType,
    });

    if (costOutcome.status === 'success') {
      return {
        cost: costOutcome.totalCostUsd,
        tokenUsage: costOutcome.models,
      };
    } else {
      return { reason: costOutcome.reason };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reason: `Recovery failed: ${msg}` };
  }
}

runTool({
  name: 'backfill-workflow-cost-status',
  description: 'Backfill workflow cost status for existing eval records (HOK-883)',
  options: {
    file: { type: 'string', short: 'f', description: 'Path to evals.jsonl file' },
    'repo-dir': { type: 'string', description: 'Repository directory for pricing config (default: current dir)' },
    'dry-run': { type: 'boolean', description: 'Preview changes without modifying the file' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  examples: [
    'npx tsx tools/backfill-workflow-cost-status.ts --dry-run',
    'npx tsx tools/backfill-workflow-cost-status.ts --file .wavemill/evals/evals.jsonl',
  ],
  additionalHelp: `Adds workflowCostStatus and workflowCostDiagnostics fields to eval records.

For records WITH workflowCost:
  - Sets workflowCostStatus to 'success'

For records WITHOUT workflowCost:
  - Attempts to re-compute cost from session data
  - If recovery succeeds: sets workflowCost and status to 'success'
  - If recovery fails: sets status to best-guess reason (e.g., 'no_sessions')

Uses atomic write (temp file + rename) to prevent data corruption.`,
  run({ args }) {
    const repoDir = args['repo-dir'] ? resolve(args['repo-dir']) : process.cwd();
    const defaultPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const filePath = args.file ? resolve(args.file) : defaultPath;
    const dryRun = !!args['dry-run'];

    console.log(`Backfilling workflow cost status for: ${filePath}`);
    if (dryRun) {
      console.log('DRY RUN: No changes will be written\n');
    }

    // Read records
    const records = readEvalRecords(filePath);
    console.log(`Loaded ${records.length} eval records\n`);

    // Load pricing table for cost recovery attempts
    const pricingTable = loadPricingTable(repoDir);

    // Process records
    const stats: BackfillStats = {
      total: records.length,
      alreadyHadStatus: 0,
      successfulBackfill: 0,
      recoveredCost: 0,
      statusSet: {},
    };

    const updatedRecords: EvalRecord[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const issueId = record.issueId || 'unknown';

      // Skip if already has status
      if (record.workflowCostStatus) {
        stats.alreadyHadStatus++;
        updatedRecords.push(record);
        continue;
      }

      // Case 1: Has workflowCost → set status to 'success'
      if (record.workflowCost !== undefined) {
        record.workflowCostStatus = 'success';
        stats.successfulBackfill++;
        stats.statusSet['success'] = (stats.statusSet['success'] || 0) + 1;
        updatedRecords.push(record);
        continue;
      }

      // Case 2: No workflowCost → attempt recovery
      console.log(`[${i + 1}/${records.length}] ${issueId}: attempting cost recovery...`);
      const recovery = attemptCostRecovery(record, repoDir, pricingTable);

      if (recovery.cost !== undefined) {
        // Recovery successful!
        record.workflowCost = recovery.cost;
        record.workflowTokenUsage = recovery.tokenUsage;
        record.workflowCostStatus = 'success';
        stats.successfulBackfill++;
        stats.recoveredCost++;
        stats.statusSet['success'] = (stats.statusSet['success'] || 0) + 1;
        console.log(`  ✓ Recovered cost: $${recovery.cost.toFixed(4)}`);
      } else {
        // Recovery failed - set diagnostic status
        const status = recovery.reason?.includes('No session')
          ? 'no_sessions'
          : recovery.reason?.includes('branch')
            ? 'no_branch'
            : 'no_sessions';

        record.workflowCostStatus = status;
        record.workflowCostDiagnostics = {
          reason: recovery.reason || 'Unknown error',
          agentType: record.agentType || 'unknown',
        };
        stats.successfulBackfill++;
        stats.statusSet[status] = (stats.statusSet[status] || 0) + 1;
        console.log(`  ⚠ Could not recover: ${recovery.reason}`);
      }

      updatedRecords.push(record);
    }

    // Write results
    if (!dryRun) {
      writeEvalRecords(filePath, updatedRecords);
      console.log(`\n✓ Updated ${filePath}`);
    } else {
      console.log('\nDRY RUN: No changes written');
    }

    // Print summary
    console.log('\n=== Backfill Summary ===');
    console.log(`Total records:          ${stats.total}`);
    console.log(`Already had status:     ${stats.alreadyHadStatus}`);
    console.log(`Backfilled:             ${stats.successfulBackfill}`);
    console.log(`  - Recovered costs:    ${stats.recoveredCost}`);
    console.log(`\nStatus distribution:`);
    for (const [status, count] of Object.entries(stats.statusSet).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / stats.total) * 100).toFixed(1);
      console.log(`  ${status.padEnd(15)} ${count} (${pct}%)`);
    }
  },
});
