/**
 * Build redacted Hokusai contribution rows from safe Wavemill projections.
 *
 * The canonical builder now lives in `@hokusai/core`; this module is a thin
 * re-export shim that preserves wavemill's historical public surface so every
 * existing importer keeps working unchanged.
 *
 * HOK-3415: v4 is the only row Wavemill writes. The legacy `submit_data`
 * producer and the v1/v2/v3 benchmark builders were deleted along with the
 * `inputs` dict; `technical_task_router_row/v4` carries the same facts under
 * `stage_executions[]` and the HOK-3363 routing-outcome block.
 *
 * @module hokusai-contribution-builder
 */

export {
  deriveOutcomeLabels,
  buildTechnicalTaskRouterRowV4,
} from '@hokusai/core';

export type {
  FeatureOutcomeDiagnosticProjection,
  RedactedEvalContributionProjectionV4,
  StageExecutionProjection,
  StageCostInput,
  ComparisonGroup,
  StageExecution,
  StageExecutionStage,
  ModelEvidence,
  RouteRole,
} from '@hokusai/core';
