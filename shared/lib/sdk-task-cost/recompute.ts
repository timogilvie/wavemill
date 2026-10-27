/**
 * Recompute a stored eval record's workflow cost from its sessions with the
 * SDK engine (HOK-3077) — the backfill counterpart of `meter.ts`.
 *
 * `tools/backfill-workflow-cost-status.ts` uses it to recover costs a record
 * never got and to repair HOK-3256 pooled costs. It reads the same session
 * files through the same adapters as live metering, so a recomputed cost is
 * exactly what a live eval of that worktree would record today.
 *
 * Synchronous and value-imports the collector (and so `@hokusai/core`):
 * offline tools only — eval entrypoints go through `meter.ts`.
 *
 * @module sdk-task-cost/recompute
 */

import { errorMessage } from '../error-utils.ts';
import type { EvalRecord } from '../eval-schema.ts';
import type { PricingTable } from '../pricing/model-pricing.ts';
import { reportableWorkflowCostUsd } from '../workflow-cost.ts';
import type { RecomputedWorkflowCost } from '../workflow-cost-pool-repair.ts';
import { collectSdkTaskCostSummaries, type CollectSdkTaskCostSummariesInput } from './collect.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { resolveWorkflowCost } from './resolve.ts';

export interface RecomputeRecordWorkflowCostOptions {
  repoDir: string;
  pricingTable?: PricingTable;
  /** Defaults to {@link collectSdkTaskCostSummaries}; injected by tests. */
  collect?: (input: CollectSdkTaskCostSummariesInput) => TaskCostSummaryV1[] | null;
}

export type RecordWorkflowCostRecovery =
  | { recomputed: RecomputedWorkflowCost; reason?: undefined }
  | { recomputed: null; reason: string };

/**
 * Recompute one record's cost from the worktree/branch in its metadata.
 *
 * Returns the recomputed cost, or `null` with a reason when the record lacks
 * the join inputs, no session produced a cost event, collection failed, or
 * nothing was priced. An unpriced run is never recovered as `$0`: only a
 * reportable figure (`reportableWorkflowCostUsd`) counts.
 */
export function recomputeRecordWorkflowCost(
  record: EvalRecord,
  options: RecomputeRecordWorkflowCostOptions,
): RecordWorkflowCostRecovery {
  const meta = record.metadata as { worktreePath?: unknown; branchName?: unknown } | undefined;
  if (!meta) {
    return { recomputed: null, reason: 'No metadata available for recovery' };
  }
  const worktreePath = typeof meta.worktreePath === 'string' ? meta.worktreePath : '';
  const branchName = typeof meta.branchName === 'string' ? meta.branchName : '';
  if (!worktreePath || !branchName) {
    return { recomputed: null, reason: 'Missing worktreePath or branchName in metadata' };
  }

  const collect = options.collect ?? collectSdkTaskCostSummaries;
  let summaries: TaskCostSummaryV1[] | null = null;
  let collectionError: string | null = null;
  try {
    summaries = collect({
      worktreePath,
      branchName,
      repoDir: options.repoDir,
      issueId: record.issueId,
      pricingTable: options.pricingTable,
    });
  } catch (error) {
    collectionError = errorMessage(error);
  }

  const { outcome } = resolveWorkflowCost({
    summaries,
    collectionError,
    agentType: record.agentType,
    pricingTable: options.pricingTable,
    repoDir: options.repoDir,
    diagnostics: { worktreePath, branchName },
  });
  if (outcome.status !== 'success') {
    return { recomputed: null, reason: outcome.reason };
  }
  const cost = reportableWorkflowCostUsd(outcome);
  if (cost === undefined) {
    return {
      recomputed: null,
      reason: `No priced sessions (coverage ${outcome.attribution?.coverage ?? 'unknown'})`,
    };
  }
  return {
    recomputed: {
      cost,
      tokenUsage: outcome.models,
      ...(outcome.attribution ? { attribution: outcome.attribution } : {}),
    },
  };
}
