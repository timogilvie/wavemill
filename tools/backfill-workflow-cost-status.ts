#!/usr/bin/env -S npx tsx

/**
 * Backfill workflow cost status for existing eval records (HOK-883).
 *
 * Adds workflowCostStatus and workflowCostDiagnostics fields to eval records
 * that don't have them, attempting to re-compute missing costs where possible.
 * Also repairs costs that absorbed the cross-task native session pool
 * (HOK-3256): recomputed when possible, otherwise marked `unreliable`.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { errorMessage } from '../shared/lib/error-utils.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { computeWorkflowCost, loadPricingTable } from '../shared/lib/workflow-cost.ts';
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

/**
 * Attempt to recover workflow cost for a record that doesn't have it.
 */
function attemptCostRecovery(
  record: EvalRecord,
  repoDir: string,
  pricingTable: any,
): { cost?: number; tokenUsage?: any; attribution?: EvalRecord['workflowCostAttribution']; reason?: string } {
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
      issueId: record.issueId,
      pricingTable,
      agentType: record.agentType,
    });

    if (costOutcome.status === 'success') {
      return {
        cost: costOutcome.totalCostUsd,
        tokenUsage: costOutcome.models,
        attribution: costOutcome.attribution,
      };
    } else {
      return { reason: costOutcome.reason };
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
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
