/**
 * SDK task-cost bridge (HOK-3075): Wavemill session scans → SDK
 * `TaskCostSummaryV1`, plus the projection back to the legacy workflow-cost
 * shape. Authoritative for workflow/eval cost since the HOK-3076 cutover;
 * `WAVEMILL_COST_METERING_LEGACY` rolls readers back to the legacy engine.
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
  COST_METERING_LEGACY_ENV,
  isSdkTaskCostShadowEnabled,
  resolveCostMeteringEngine,
  resolveSdkTaskCostShadowMode,
  SDK_TASK_COST_SHADOW_ENV,
  type CostMeteringEngine,
  type SdkTaskCostShadowMode,
} from './feature-switch.ts';
export {
  projectTaskCostSummaryToWorkflowCost,
  selectPrimaryTaskCostSummary,
  type ProjectTaskCostOptions,
} from './project.ts';
export {
  resolveAuthoritativeWorkflowCost,
  type ResolvedWorkflowCost,
  type ResolveWorkflowCostInput,
  type WorkflowCostSelectionReason,
} from './resolve.ts';
export { runSdkTaskCostCollection, type SdkTaskCostCollectionOptions } from './shadow.ts';
export { collectSdkTaskCostSummariesLazy } from './lazy-collect.ts';
export type { TaskCostSummaryV1 } from './contract.ts';
