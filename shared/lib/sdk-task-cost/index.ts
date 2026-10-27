/**
 * SDK task-cost bridge (HOK-3075): Wavemill session scans → SDK
 * `TaskCostSummaryV1`, plus the projection back to the persisted
 * workflow-cost shape. The only workflow/eval cost engine since HOK-3077
 * retired the legacy one; rollback is a revert, not a runtime switch.
 *
 * @module sdk-task-cost
 */

export {
  buildSdkTaskCostSummaries,
  collectSdkTaskCostSummaries,
  type BuildSdkTaskCostSummariesInput,
  type CollectSdkTaskCostSummariesInput,
} from './collect.ts';
export {
  projectTaskCostSummaryToWorkflowCost,
  selectPrimaryTaskCostSummary,
  type ProjectTaskCostOptions,
} from './project.ts';
export {
  resolveWorkflowCost,
  type ResolvedWorkflowCost,
  type ResolveWorkflowCostInput,
  type WorkflowCostSelectionReason,
} from './resolve.ts';
export {
  meterWorkflowCost,
  type MeteredWorkflowCost,
  type MeterWorkflowCostInput,
  type SdkTaskCostCollector,
} from './meter.ts';
export { collectSdkTaskCostSummariesLazy } from './lazy-collect.ts';
export type { TaskCostSummaryV1 } from './contract.ts';
