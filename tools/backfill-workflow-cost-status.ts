#!/usr/bin/env -S npx tsx

/**
 * Backfill workflow cost status for existing eval records (HOK-883).
 *
 * Adds workflowCostStatus and workflowCostDiagnostics fields to eval records
 * that don't have them, and repairs costs from the retired selection rules:
 *
 * - HOK-3328: a record that persisted per-harness `taskCostSummary` gets
 *   `workflowCost` recomputed as the `@hokusai/costs` total over those stored
 *   summaries (`recomputeRecordWorkflowCost`) — every harness, no re-pricing,
 *   no session re-scan. A costed record since 2026-08 with no stored
 *   summaries keeps its value but is marked `workflowCostUnreliable`.
 * - HOK-3256: a cost that absorbed the cross-task native session pool is
 *   marked `unreliable` (its stored summaries carry the same pool).
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { resolve, join } from 'node:path';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import {
  isUnrecomputableNativeFirstCost,
  recomputeRecordWorkflowCost,
} from '../shared/lib/sdk-task-cost/recompute.ts';
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
  recomputed: number;
  markedUnreliable: number;
  pooledUnreliable: number;
  statusSet: Record<string, number>;
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? 'none' : `$${value.toFixed(4)}`;
}

/** Apply a stored-summary recomputation to a record; null when it changes nothing. */
function applyRecomputation(record: EvalRecord): EvalRecord | null {
  const recovery = recomputeRecordWorkflowCost(record);
  if (!recovery.recomputed) return null;
  const { cost, tokenUsage, attribution, byHarness } = recovery.recomputed;
  const next: EvalRecord = {
    ...record,
    workflowCost: cost,
    workflowTokenUsage: tokenUsage,
    workflowCostStatus: 'success',
    workflowCostByHarness: byHarness,
    ...(attribution ? { workflowCostAttribution: attribution } : {}),
  };
  delete next.workflowCostUnreliable;
  return JSON.stringify(next) === JSON.stringify(record) ? null : next;
}

runTool({
  name: 'backfill-workflow-cost-status',
  description: 'Backfill workflow cost status for existing eval records (HOK-883)',
  options: {
    file: { type: 'string', short: 'f', description: 'Path to evals.jsonl file' },
    'repo-dir': { type: 'string', description: 'Repository directory holding .wavemill/evals (default: current dir)' },
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

For records WITH stored per-harness taskCostSummary (schema >= 1.54, HOK-3328):
  - Recomputes workflowCost as the @hokusai/costs total over every stored
    summary (no re-pricing) and persists workflowCostByHarness; prints old → new

For costed records since 2026-08 WITHOUT stored summaries:
  - Keeps workflowCost and adds workflowCostUnreliable (native-first selection)

For records WITHOUT workflowCost or status:
  - Sets status to 'no_sessions' (no stored summaries to recompute from)

For records whose native cost spans >= --pool-min-sessions sessions (HOK-3256):
  - Sets status to 'unreliable' and removes workflowCost, workflowTokenUsage
    and workflowCostAttribution (their stored summaries carry the same pool)

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

    const stats: BackfillStats = {
      total: records.length,
      alreadyHadStatus: 0,
      successfulBackfill: 0,
      recomputed: 0,
      markedUnreliable: 0,
      pooledUnreliable: 0,
      statusSet: {},
    };
    const markedAt = new Date().toISOString();

    readTransformWrite<EvalRecord>(filePath, (record, context) => {
      const issueId = record.issueId || 'unknown';
      const label = `[${context.index + 1}/${records.length}] ${issueId}`;

      if (isPooledWorkflowCost(record, poolMinSessions)) {
        // The stored native summary carries the same pool, so it cannot be
        // the recomputation source; only a re-metering could, and that needs
        // an ownership record these runs never wrote.
        stats.pooledUnreliable++;
        console.log(`${label}: pooled cost marked unreliable`);
        return {
          record: repairPooledWorkflowCost(record, null, 'stored summaries share the pooled native sessions'),
          changed: true,
        };
      }

      const recomputed = applyRecomputation(record);
      if (recomputed) {
        stats.recomputed++;
        console.log(`${label}: ${formatUsd(record.workflowCost)} → ${formatUsd(recomputed.workflowCost)} (all harnesses)`);
        return { record: recomputed, changed: true };
      }

      if (isUnrecomputableNativeFirstCost(record)) {
        stats.markedUnreliable++;
        return {
          record: {
            ...record,
            workflowCostUnreliable: { reason: 'native_first_harness_selection', markedAt },
          },
          changed: true,
        };
      }

      if (record.workflowCostStatus) {
        stats.alreadyHadStatus++;
        return { record, changed: false };
      }

      if (record.workflowCost !== undefined) {
        stats.successfulBackfill++;
        stats.statusSet.success = (stats.statusSet.success || 0) + 1;
        return { record: { ...record, workflowCostStatus: 'success' }, changed: true };
      }

      const reason = recomputeRecordWorkflowCost(record).reason ?? 'Unknown error';
      stats.successfulBackfill++;
      stats.statusSet.no_sessions = (stats.statusSet.no_sessions || 0) + 1;
      return {
        record: {
          ...record,
          workflowCostStatus: 'no_sessions',
          workflowCostDiagnostics: {
            reason,
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
    console.log(`Backfilled status:      ${stats.successfulBackfill}`);
    console.log(`Recomputed (HOK-3328):  ${stats.recomputed}`);
    console.log(`Marked unreliable:      ${stats.markedUnreliable}`);
    console.log(`Pooled costs (HOK-3256):`);
    console.log(`  - Marked unreliable:  ${stats.pooledUnreliable}`);
    console.log(`\nStatus distribution:`);
    for (const [status, count] of Object.entries(stats.statusSet).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / stats.total) * 100).toFixed(1);
      console.log(`  ${status.padEnd(15)} ${count} (${pct}%)`);
    }
  },
});
