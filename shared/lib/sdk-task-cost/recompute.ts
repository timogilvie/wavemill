/**
 * Recompute a stored eval record's workflow cost from the per-harness
 * `taskCostSummary` it persisted (schema ≥ 1.54) — the backfill counterpart
 * of `meter.ts` (HOK-3328).
 *
 * Records written before HOK-3328 kept every harness's SDK summary but chose
 * one of them as `workflowCost` (native first). The fix is the
 * `@hokusai/costs` total over *all* stored summaries: each summary's model
 * segments are replayed into the SDK tracker with their stored charges and
 * estimates passed through verbatim (`actualCostUsd` / caller-supplied
 * `estimatedCostUsd`), so the SDK combines them and nothing is re-priced or
 * re-scanned. A record without stored summaries cannot be recomputed and is
 * reported as such; `tools/backfill-workflow-cost-status.ts` marks those since
 * the native-first rule became destructive (2026-08) as unreliable.
 *
 * Value-imports `@hokusai/costs`: offline tools only — eval entrypoints go
 * through `meter.ts`.
 *
 * @module sdk-task-cost/recompute
 */

import { createTaskCostTracker } from '@hokusai/costs';
import type { EvalRecord } from '../eval-schema.ts';
import { reportableWorkflowCostUsd } from '../workflow-cost.ts';
import type { RecomputedWorkflowCost } from '../workflow-cost-pool-repair.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { toSdkId } from './measure.ts';
import { projectReportToWorkflowCost } from './project.ts';

/** First day the native-first selection discarded Claude/Codex cost at scale. */
export const NATIVE_FIRST_UNRELIABLE_SINCE = '2026-08-01T00:00:00.000Z';

export type RecordWorkflowCostRecovery =
  | { recomputed: RecomputedWorkflowCost & { byHarness: Record<string, number | null> }; reason?: undefined }
  | { recomputed: null; reason: string };

/** The `@hokusai/costs` report over stored summaries, replayed verbatim. */
export function reportFromStoredSummaries(taskId: string, summaries: readonly TaskCostSummaryV1[]) {
  const tracker = createTaskCostTracker({ taskId: toSdkId(taskId, 'unknown-task') });
  summaries.forEach((summary, summaryIndex) => {
    summary.model_segments.forEach((segment, segmentIndex) => {
      const eventId = toSdkId(`${summary.harness}.${summaryIndex}.${segmentIndex}`);
      tracker.record({
        eventId,
        taskId: tracker.taskId,
        sessionId: toSdkId(summary.session_ids[0] ?? tracker.taskId),
        turnId: eventId,
        sequence: segmentIndex + 1,
        harness: summary.harness,
        providerContractVersion: summary.provider_contract_version,
        observedModel: segment.model,
        usage: segment.usage,
        actualCostUsd: segment.actual_cost_usd,
        estimatedCostUsd: segment.estimated_cost_usd,
        observedAt: summary.collected_at,
        costBasis: summary.cost_basis,
      });
    });
  });
  return tracker.summary();
}

/**
 * Recompute one record's cost as the SDK total over its stored summaries.
 * Returns `null` with a reason when the record stored none, or when the
 * total is not reportable (unpriced, never `$0`).
 */
export function recomputeRecordWorkflowCost(record: EvalRecord): RecordWorkflowCostRecovery {
  const summaries = Array.isArray(record.taskCostSummary) ? record.taskCostSummary : [];
  if (summaries.length === 0) {
    return { recomputed: null, reason: 'No stored taskCostSummary (record predates schema 1.54 or metered nothing)' };
  }
  const report = reportFromStoredSummaries(record.issueId ?? 'unknown-task', summaries);
  const outcome = projectReportToWorkflowCost(report, record.pricingSnapshot ?? {});
  const cost = reportableWorkflowCostUsd(outcome);
  if (cost === undefined) {
    return { recomputed: null, reason: `No priced sessions (coverage ${outcome.attribution?.coverage ?? 'unknown'})` };
  }
  return {
    recomputed: {
      cost,
      tokenUsage: outcome.models,
      ...(outcome.attribution ? { attribution: outcome.attribution } : {}),
      byHarness: outcome.byHarness ?? {},
    },
  };
}

/**
 * Whether a record's stored cost came from the retired native-first rule and
 * cannot be recomputed: written since {@link NATIVE_FIRST_UNRELIABLE_SINCE},
 * carrying a cost, but no stored summaries to recompute from.
 */
export function isUnrecomputableNativeFirstCost(record: EvalRecord): boolean {
  if (record.workflowCost === undefined || record.workflowCostUnreliable) return false;
  if (Array.isArray(record.taskCostSummary) && record.taskCostSummary.length > 0) return false;
  const at = Date.parse(record.timestamp ?? '');
  return Number.isFinite(at) && at >= Date.parse(NATIVE_FIRST_UNRELIABLE_SINCE);
}
