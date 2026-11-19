/**
 * The single import surface for the `@hokusai/core` task-cost contract
 * (HOK-3075). Every Wavemill module that needs an SDK task-cost name imports
 * it from here, so the SDK dependency stays in one place and a contract bump
 * is a one-file review.
 *
 * @module sdk-task-cost/contract
 */

export {
  aggregateTaskCost,
  isTaskCostSummaryV1,
  validateTaskCostEventV1,
  validateTaskCostSummaryV1,
  TaskCostValidationError,
  TASK_COST_BASES,
  TASK_COST_COVERAGES,
  TASK_COST_DIAGNOSTIC_CODES,
  TASK_COST_EVENT_SCHEMA_VERSION,
  TASK_COST_FIELD_AVAILABILITIES,
  TASK_COST_HARNESSES,
  TASK_COST_JOIN_CONFIDENCES,
  TASK_COST_PRICING_SOURCES,
  TASK_COST_SOURCES,
  TASK_COST_SUMMARY_SCHEMA_VERSION,
  TASK_COST_TOKEN_FIELDS,
  PROVIDER_CONTRACT_VERSIONS as SDK_PROVIDER_CONTRACT_VERSIONS,
} from '@hokusai/core';

export type {
  TaskCostBasis,
  TaskCostCoverage,
  TaskCostDiagnosticCode,
  TaskCostEventV1,
  TaskCostFieldAvailability,
  TaskCostHarness,
  TaskCostModelSegment,
  TaskCostSource,
  TaskCostSummaryV1,
  TaskCostTokenUsage,
} from '@hokusai/core';

/**
 * The `task_attempt/v1` identity contract (HOK-3372, adopted HOK-3476). One
 * definition of *which attempt* a fact belongs to; `shared/lib/attempt-identity.ts`
 * is the only module that mints or projects these — every other Wavemill
 * module imports the types/validators from here, never from `@hokusai/core`
 * directly (`tools/check-attempt-lineage.ts`).
 */
export {
  TASK_ATTEMPT_ARM_ROLES,
  TASK_ATTEMPT_KINDS,
  TASK_ATTEMPT_RECORD_TYPES,
  TASK_ATTEMPT_SCHEMA_VERSION,
  isTaskAttemptLogEntryV1,
  validateTaskAttemptLogEntryV1,
  validateTaskAttemptRef,
  MINTED_ID_PATTERN,
} from '@hokusai/core';

export type {
  TaskAttemptArmRole,
  TaskAttemptKind,
  TaskAttemptRecordV1,
  TaskAttemptRef,
  TaskAttemptSessionRef,
} from '@hokusai/core';
