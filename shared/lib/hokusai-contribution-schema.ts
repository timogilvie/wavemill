/**
 * Validation for redacted Hokusai contribution rows.
 *
 * Queue payloads must only contain already-redacted contribution shapes.
 *
 * The canonical schema now lives in `@hokusai/core`; this module is a thin
 * re-export shim that preserves wavemill's historical public surface so every
 * existing importer keeps working unchanged.
 *
 * HOK-3415: dropped the `submit_data` row (no longer produced). v1/v2 benchmark
 * types stay exported — the audit reader still recognises historical rows.
 *
 * @module hokusai-contribution-schema
 */

export {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V3,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V4,
  COST_BUCKET_THRESHOLDS_USD,
  TIME_BUCKET_THRESHOLDS_SECONDS,
  ContributionValidationError,
  isSubmitDataContributionRow,
  isTechnicalTaskRouterContributionRowV2,
  isTechnicalTaskRouterContributionRowV4,
  validateContributionRow,
} from '@hokusai/core';

export type {
  TechnicalTaskRouterSelectedModels,
  TechnicalTaskRouterContributionRowV1,
  TechnicalTaskRouterContributionRowV2,
  TechnicalTaskRouterContributionRowV3,
  TechnicalTaskRouterContributionRowV4,
  RoleAvailableModels,
  OutcomeLabels,
  CandidatePoolMetadata,
  SparseCellMetadata,
  ContributionRow,
  StageExecution,
  StageExecutionStage,
  ComparisonGroup,
  ModelEvidence,
  RouteRole,
} from '@hokusai/core';
