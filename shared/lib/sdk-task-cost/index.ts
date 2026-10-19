/**
 * SDK task-cost bridge (HOK-3075): Wavemill session scans → SDK
 * `TaskCostSummaryV1`, plus the projection back to the legacy workflow-cost
 * shape. Shadow-only until the HOK-3076 cutover; gated by
 * `WAVEMILL_SDK_COST_METERING_SHADOW`.
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
  isSdkTaskCostShadowEnabled,
  resolveSdkTaskCostShadowMode,
  SDK_TASK_COST_SHADOW_ENV,
  type SdkTaskCostShadowMode,
} from './feature-switch.ts';
export {
  projectTaskCostSummaryToWorkflowCost,
  selectPrimaryTaskCostSummary,
  type ProjectTaskCostOptions,
} from './project.ts';
export type { TaskCostSummaryV1 } from './contract.ts';
