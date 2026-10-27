#!/usr/bin/env -S npx tsx

/**
 * Backfill workflow cost status for existing eval records (HOK-883).
 *
 * Adds workflowCostStatus and workflowCostDiagnostics fields to eval records
 * that don't have them, attempting to re-compute missing costs where possible.
 * Also repairs costs that absorbed the cross-task native session pool
 * (HOK-3256): recomputed when possible, otherwise marked `unreliable`.
 * Recomputation uses the SDK cost engine (`recomputeRecordWorkflowCost`,
 * HOK-3077), the same path live evals meter with.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { loadPricingTable, type PricingTable } from '../shared/lib/pricing/model-pricing.ts';
import { recomputeRecordWorkflowCost } from '../shared/lib/sdk-task-cost/recompute.ts';
import { readJsonlFile, readTransformWrite } from '../shared/lib/jsonl-utils.ts';
import {
  POOLED_COST_MIN_SESSIONS,
  isPooledWorkflowCost,
  repairPooledWorkflowCost,
} from '../shared/lib/workflow-cost-pool-repair.ts';

interface BackfillStats {
  total: number;
  alreadyHadStatus: number;
  successfulBackfill: number;
  recoveredCost: number;
  pooledRecomputed: number;
  pooledUnreliable: number;
  statusSet: Record<string, number>;
}

/** Recover a record's cost from its sessions, in the shape the backfill below reads. */
function attemptCostRecovery(
  record: EvalRecord,
  repoDir: string,
  pricingTable: PricingTable,
): { cost?: number; tokenUsage?: EvalRecord['workflowTokenUsage']; attribution?: EvalRecord['workflowCostAttribution']; reason?: string } {
  const recovery = recomputeRecordWorkflowCost(record, { repoDir, pricingTable });
  if (!recovery.recomputed) {
    return { reason: recovery.reason };
  }
  return {
    cost: recovery.recomputed.cost,
    tokenUsage: recovery.recomputed.tokenUsage,
    attribution: recovery.recomputed.attribution,
  };
}

runTool({
  name: 'backfill-workflow-cost-status',
  description: 'Backfill workflow cost status for existing eval records (HOK-883)',
  options: {
    file: { type: 'string', short: 'f', description: 'Path to evals.jsonl file' },
    'repo-dir': { type: 'string', description: 'Repository directory for pricing config (default: current dir)' },
    'dry-run': { type: 'boolean', description: 'Preview changes without modifying the file' },
    'pool-min-sessions': {
      type: 'string',
      description: `Native session count marking a HOK-3256 pooled cost (default: ${POOLED_COST_MIN_SESSIONS})`,
    },
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

For records whose native cost spans >= --pool-min-sessions sessions (HOK-3256):
  - Re-computes the cost with the fixed per-task session scan when possible
  - Otherwise sets status to 'unreliable' and removes workflowCost,
    workflowTokenUsage and workflowCostAttribution

Uses atomic write (temp file + rename) to prevent data corruption.
Uses shared JSONL rewrite helpers and writes a .backup file before live changes.`,
  run({ args }) {
    const repoDir = args['repo-dir'] ? resolve(args['repo-dir']) : process.cwd();
    const defaultPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const filePath = args.file ? resolve(args.file) : defaultPath;
    const dryRun = !!args['dry-run'];
    const poolMinSessions = args['pool-min-sessions'] ? Number(args['pool-min-sessions']) : POOLED_COST_MIN_SESSIONS;
    if (!Number.isInteger(poolMinSessions) || poolMinSessions < 1) {
      throw new Error(`--pool-min-sessions must be a positive integer, got: ${args['pool-min-sessions']}`);
    }

    console.log(`Backfilling workflow cost status for: ${filePath}`);
    if (dryRun) {
      console.log('DRY RUN: No changes will be written\n');
    }

    // Read records
    const records = readJsonlFile<EvalRecord>(filePath);
    console.log(`Loaded ${records.length} eval records\n`);

    // Load pricing table for cost recovery attempts
    const pricingTable = loadPricingTable(repoDir);

    // Process records
    const stats: BackfillStats = {
      total: records.length,
      alreadyHadStatus: 0,
      successfulBackfill: 0,
      recoveredCost: 0,
      pooledRecomputed: 0,
      pooledUnreliable: 0,
      statusSet: {},
    };

    readTransformWrite<EvalRecord>(filePath, (record, context) => {
      const issueId = record.issueId || 'unknown';

      if (isPooledWorkflowCost(record, poolMinSessions)) {
        const recovery = attemptCostRecovery(record, repoDir, pricingTable);
        const repaired = repairPooledWorkflowCost(
          record,
          recovery.cost !== undefined
            ? { cost: recovery.cost, tokenUsage: recovery.tokenUsage, attribution: recovery.attribution }
            : null,
          recovery.reason || 'Unknown error',
        );
        if (repaired.workflowCostStatus === 'unreliable') {
          stats.pooledUnreliable++;
          console.log(`[${context.index + 1}/${records.length}] ${issueId}: pooled cost marked unreliable`);
        } else {
          stats.pooledRecomputed++;
          console.log(`[${context.index + 1}/${records.length}] ${issueId}: pooled cost recomputed: $${recovery.cost!.toFixed(4)}`);
        }
        return { record: repaired, changed: true };
      }

      if (record.workflowCostStatus) {
        stats.alreadyHadStatus++;
        return { record, changed: false };
      }

      if (record.workflowCost !== undefined) {
        stats.successfulBackfill++;
        stats.statusSet.success = (stats.statusSet.success || 0) + 1;
        return {
          record: {
            ...record,
            workflowCostStatus: 'success',
          },
          changed: true,
        };
      }

      console.log(`[${context.index + 1}/${records.length}] ${issueId}: attempting cost recovery...`);
      const recovery = attemptCostRecovery(record, repoDir, pricingTable);

      if (recovery.cost !== undefined) {
        stats.successfulBackfill++;
        stats.recoveredCost++;
        stats.statusSet.success = (stats.statusSet.success || 0) + 1;
        console.log(`  ✓ Recovered cost: $${recovery.cost.toFixed(4)}`);
        return {
          record: {
            ...record,
            workflowCost: recovery.cost,
            workflowTokenUsage: recovery.tokenUsage,
            workflowCostStatus: 'success',
          },
          changed: true,
        };
      }

      const status = recovery.reason?.includes('No session')
        ? 'no_sessions'
        : recovery.reason?.includes('branch')
          ? 'no_branch'
          : 'no_sessions';

      stats.successfulBackfill++;
      stats.statusSet[status] = (stats.statusSet[status] || 0) + 1;
      console.log(`  ⚠ Could not recover: ${recovery.reason}`);
      return {
        record: {
          ...record,
          workflowCostStatus: status,
          workflowCostDiagnostics: {
            reason: recovery.reason || 'Unknown error',
            agentType: record.agentType || 'unknown',
          },
        },
        changed: true,
      };
    }, { dryRun });

    // Write results
    if (!dryRun) {
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
    console.log(`Pooled costs (HOK-3256):`);
    console.log(`  - Recomputed:         ${stats.pooledRecomputed}`);
    console.log(`  - Marked unreliable:  ${stats.pooledUnreliable}`);
    console.log(`\nStatus distribution:`);
    for (const [status, count] of Object.entries(stats.statusSet).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / stats.total) * 100).toFixed(1);
      console.log(`  ${status.padEnd(15)} ${count} (${pct}%)`);
    }
  },
});
