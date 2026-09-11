/**
 * Eval record builder — attach metadata to eval records.
 *
 * Provides functions to enrich eval records with:
 * - Difficulty analysis results
 * - Task context analysis results
 * - Repo context analysis results
 * - Workflow cost computation results
 * - Agent type
 *
 * All functions mutate the record in place (following existing patterns).
 *
 * @module eval-record-builder
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { BUDGET_MISSING } from './eval-validator.ts';
import type {
  ChallengeStageEval,
  EvalChallengeRouteContext,
  EvalExecutedPlanning,
  PlanningExecutionOutcome,
  EvalRouteArtifact,
  EvalRouteProvenance,
  RouteCalibration,
  RoutePrediction,
  EvalRecord,
  EligibilityErrorCode,
  PlanCritique,
  RubricEval,
  TaskContext,
  RepoContext,
  StageOutcomes,
  FallbackEventMetadata,
  TaskDescriptor,
  EvalConstraints,
  EvalPhaseDurations,
  EvalRouting,
  ManifestRef,
  PromptSizeDiagnostic,
  RoutingDecision,
  RubricCriterion,
  RubricDeterminativeBoundary,
  FeatureOutcomeDiagnostics,
  VerificationTelemetry,
  VerificationTelemetryLocalExecution,
  RoutingRole,
} from './eval-schema.ts';
import {
  getEffectiveRegistry,
  resolveModelIdentity,
  resolveProviderNativeModelId,
  type ModelRegistry,
} from './model-registry.ts';
import type {
  PrePrVerificationArtifact,
  PrePrVerificationConfig,
} from './pre-pr-verification-types.ts';
import type { DifficultyAnalysis } from './difficulty-analyzer.ts';
import type { ChallengeRouteContext } from './challenge-mode.ts';
import type { ChallengeStage } from './challenge-mode.ts';
import type {
  ChallengeExecutionAttestation,
  ChallengeExecutionIntent,
  ReviewExecutedIdentitySet,
} from './challenge-execution-contract.ts';
import { projectChallengeIntentForPersistence } from './challenge-execution-contract.ts';
import type { WorkflowCostOutcome, WorkflowCostResult, WorkflowCostFailure } from './workflow-cost.ts';
import { getHarnessId, getManifest, getManifestRef } from './resource-manifest.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';
import { getResource } from './resource-registry.ts';
import {
  POLICY_RESOLVER_VERSION,
  ROUTE_ARTIFACT_SCHEMA_VERSION,
  resolveRouterPolicyVersion,
} from './route-artifact.ts';
import {
  deriveNonRewardReasonFromIssues,
  isValidationNonRewardCode,
  validateEvalRecord,
} from './eval-validator.ts';
import { redactText, redactVerificationTelemetry } from './text-redaction.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

// Note: Using TaskContext and RepoContext from eval-schema.ts
// instead of defining duplicate types

/** All metadata to attach to an eval record. */
export interface EvalRecordMetadata {
  /** Registry snapshot used for model identity attribution. */
  registry?: ModelRegistry;
  /** Agent type that ran the workflow */
  agentType?: string;
  /** Execution provider metadata */
  provider?: string;
  endpoint?: string;
  /** Shared challenge pair identifier */
  challengePairId?: string;
  /** Side within a challenge pair. */
  challengeSide?: 'primary' | 'challenger';
  /** Immutable PR head SHA that was evaluated for this record. */
  evaluatedPrHeadSha?: string | null;
  /** Selected challenge execution contract. */
  challengeIntent?: ChallengeExecutionIntent | null;
  /** Challenge execution attestation. */
  challengeExecutionEvidence?: ChallengeExecutionAttestation | null;
  /** Challenge route provenance for evals */
  challengeRouteContext?: ChallengeRouteContext | null;
  /** General route provenance for all evals */
  routeProvenance?: EvalRouteProvenance | null;
  /** Actual planning execution provenance from `.planning-result.json`. */
  executedPlanning?: EvalExecutedPlanning | null;
  /** Structured native planning outcome from `.planning-result.json`. */
  planningExecutionOutcome?: PlanningExecutionOutcome | null;
  /** Per-phase wall-clock durations derived from workflow result artifacts. */
  phaseDurations?: EvalPhaseDurations | null;
  /** Compact router prediction metadata for calibration. */
  routePrediction?: RoutePrediction | null;
  /** Difficulty analysis results */
  difficulty?: DifficultyAnalysis | null;
  /** Task context analysis results */
  taskContext?: TaskContext | null;
  /** Repo context analysis results */
  repoContext?: RepoContext | null;
  /** Workflow cost computation results */
  workflowCost?: WorkflowCostOutcome | null;
  /** Task descriptor for router training */
  taskDescriptor?: TaskDescriptor | null;
  /** Cross-model fallback telemetry */
  fallbackEvent?: FallbackEventMetadata | null;
  /** Routing and execution constraints */
  constraints?: EvalConstraints | null;
  /** Structured rubric criteria evaluation (HOK-1406) */
  rubricEval?: RubricEval | null;
  /** Resolved-model routing decisions emitted during execution. */
  routing?: EvalRouting | null;
  /** Feature outcome artifact diagnostics (HOK-2262). */
  featureOutcomeDiagnostics?: FeatureOutcomeDiagnostics | null;
  /** First-class planner/reviewer stage evidence for challenge evals. */
  challengeStageEval?: ChallengeStageEval | null;
  /** Verification telemetry from pre-PR verification and remote CI. */
  verificationTelemetry?: VerificationTelemetry | null;
  /**
   * Executed review identities (orchestrator/substantive-analysis/remediation)
   * read from this arm's local `.review-result.json` (HOK-2969, Arbiter P2.4f).
   */
  reviewExecutedIdentity?: ReviewExecutedIdentitySet | null;
}

/** Richer eval metadata attachment used by training-facing eval entrypoints. */
export interface EnrichTrainingMetadataInput extends EvalRecordMetadata {}

const RUBRIC_DETERMINATIVE_BOUNDARY_VALUES: readonly RubricDeterminativeBoundary[] = [
  'no_interventions',
  'cosmetic_only',
  'functional_bug',
  'multiple_bugs',
  'heavy_intervention',
  'unverified_prediction',
  'vacuous_safety_gate',
];

const RUBRIC_DETERMINATIVE_BOUNDARY_SET = new Set<string>(RUBRIC_DETERMINATIVE_BOUNDARY_VALUES);

// ────────────────────────────────────────────────────────────────
// Metadata Attachment Functions
// ────────────────────────────────────────────────────────────────

/**
 * Attach agent type to eval record.
 * Sets agentType field unconditionally (even if undefined, it becomes 'claude').
 */
export function attachAgentType(record: EvalRecord, agentType?: string): void {
  record.agentType = agentType || 'claude';
}

export function attachProviderMetadata(
  record: EvalRecord,
  provider?: string,
  endpoint?: string,
): void {
  if (provider) {
    record.provider = provider;
  }

  if (endpoint) {
    record.endpoint = endpoint;
  }
}

export function attachChallengePairId(record: EvalRecord, challengePairId?: string): void {
  if (challengePairId) {
    record.challengePairId = challengePairId;
  }
}

/** Attach a sanitized evaluated PR head only when the producer can prove it. */
export function attachEvaluatedPrHeadSha(record: EvalRecord, headSha?: string | null): void {
  if (typeof headSha === 'string' && headSha.trim()) {
    record.evaluatedPrHeadSha = headSha.trim();
  }
}

function stageFromExplicitChallengeIntent(
  intent: ChallengeExecutionIntent,
  side?: 'primary' | 'challenger',
): ChallengeStage | undefined {
  if (intent.challengeStage) return intent.challengeStage;
  if (intent.selectedStage) return intent.selectedStage;

  const sideIntent = side === 'challenger' ? intent.challenger : intent.primary;
  return sideIntent?.challengeStage
    ?? intent.primary?.challengeStage
    ?? intent.challenger?.challengeStage;
}

export function attachChallengeExecutionMetadata(
  record: EvalRecord,
  input?: {
    side?: 'primary' | 'challenger';
    intent?: ChallengeExecutionIntent | null;
    evidence?: ChallengeExecutionAttestation | null;
  },
): void {
  if (input?.side) {
    record.challengeSide = input.side;
  }
  if (input?.intent) {
    const challengeStage = stageFromExplicitChallengeIntent(input.intent, input.side);
    const persistedIntent = projectChallengeIntentForPersistence(input.intent);
    if (persistedIntent) {
      record.challengeIntent = persistedIntent;
      const sideIntent = input.side === 'challenger' ? persistedIntent.challenger : persistedIntent.primary;
      record.challengeExecutionRoute = sideIntent.expectedRoute;
      if (challengeStage) {
        record.challengeStage = challengeStage;
      }
    }
  }
  if (input?.evidence) {
    record.challengeExecutionEvidence = input.evidence;
    if (input.evidence.effectiveRoute) {
      record.challengeExecutionRoute = input.evidence.effectiveRoute;
    }
    if (input.evidence.invalidReason) {
      record.challengeDivergenceReason = input.evidence.invalidReason;
      record.invalidChallenge = true;
      record.trainingEligible = false;
      record.nonRewardReason = {
        code: 'INVALID_CHALLENGE',
        message: `Invalid challenge: ${input.evidence.invalidReason}`,
      };
    }
  }
}

export function attachAttemptedModel(
  record: EvalRecord,
  input?: {
    attemptedModel?: string | null;
    modelAlias?: string | null;
  },
): void {
  if (input?.attemptedModel) {
    record.attempted_model = input.attemptedModel;
  }

  if (input?.modelAlias) {
    record.model_alias = input.modelAlias;
  }
}

export function attachChallengeStageEval(
  record: EvalRecord,
  challengeStageEval?: ChallengeStageEval | null,
): void {
  if (challengeStageEval) {
    record.challengeStageEval = challengeStageEval;
  }
}

/**
 * Attach this arm's local executed review identity (HOK-2969, Arbiter
 * P2.4f). Additive: absent when the review stage did not run natively or
 * produced no identity envelope, matching every other optional attach here.
 */
export function attachReviewExecutedIdentity(
  record: EvalRecord,
  reviewExecutedIdentity?: ReviewExecutedIdentitySet | null,
): void {
  if (reviewExecutedIdentity) {
    record.reviewExecutedIdentity = reviewExecutedIdentity;
  }
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function attachPromptSizeDiagnostic(
  record: EvalRecord,
  diagnostic?: PromptSizeDiagnostic | null,
): void {
  if (!diagnostic) {
    return;
  }

  const perComponentBytes = Object.fromEntries(
    Object.entries(diagnostic.perComponentBytes).map(([name, bytes]) => [
      name,
      finiteNonNegative(bytes),
    ]),
  ) as PromptSizeDiagnostic['perComponentBytes'];

  record.promptSizeDiagnostic = {
    totalBytes: finiteNonNegative(diagnostic.totalBytes),
    limitBytes: finiteNonNegative(diagnostic.limitBytes),
    perComponentBytes,
    policy: diagnostic.policy,
    action: diagnostic.action,
    ...(diagnostic.truncatedComponents
      ? {
          truncatedComponents: diagnostic.truncatedComponents.map((component) => ({
            name: component.name,
            originalBytes: finiteNonNegative(component.originalBytes),
            finalBytes: finiteNonNegative(component.finalBytes),
            removedBytes: finiteNonNegative(component.removedBytes),
          })),
        }
      : {}),
  };
}

function toEvalChallengeRouteContext(
  challengeRouteContext: ChallengeRouteContext,
): EvalChallengeRouteContext {
  const bootstrapRoute = challengeRouteContext.bootstrapRoute
    ? {
        coder: challengeRouteContext.bootstrapRoute.coder,
        codeDepth: challengeRouteContext.bootstrapRoute.codeDepth,
        reviewer: challengeRouteContext.bootstrapRoute.reviewer,
        reviewMode: challengeRouteContext.bootstrapRoute.reviewMode,
      }
    : undefined;
  const expandedRoute = challengeRouteContext.expandedRoute
    ? {
        coder: challengeRouteContext.expandedRoute.coder,
        codeDepth: challengeRouteContext.expandedRoute.codeDepth,
        reviewer: challengeRouteContext.expandedRoute.reviewer,
        reviewMode: challengeRouteContext.expandedRoute.reviewMode,
      }
    : undefined;

  return {
    decisionSource: challengeRouteContext.decisionSource,
    ...(bootstrapRoute ? { bootstrapRoute } : {}),
    ...(expandedRoute ? { expandedRoute } : {}),
    ...(challengeRouteContext.refreshRationale
      ? { refreshRationale: challengeRouteContext.refreshRationale }
      : {}),
  };
}

function toEvalRouteArtifact(route: EvalRouteArtifact): EvalRouteArtifact {
  return {
    coder: route.coder,
    codeDepth: route.codeDepth,
    reviewer: route.reviewer,
    reviewMode: route.reviewMode,
    ...(route.planner ? { planner: route.planner } : {}),
    ...(route.planDepth ? { planDepth: route.planDepth } : {}),
    ...(route.artifactPath ? { artifactPath: route.artifactPath } : {}),
    ...(route.artifactHash ? { artifactHash: route.artifactHash } : {}),
    ...(route.inputHash ? { inputHash: route.inputHash } : {}),
    ...(route.source ? { source: route.source } : {}),
    ...(typeof route.cacheHit === 'boolean' ? { cacheHit: route.cacheHit } : {}),
    ...(route.routeSource ? { routeSource: route.routeSource } : {}),
    ...(route.routerMode ? { routerMode: route.routerMode } : {}),
    ...(route.routingMode ? { routingMode: route.routingMode } : {}),
    ...(route.expectedMetrics ? { expectedMetrics: route.expectedMetrics } : {}),
  };
}

function toEvalRouteProvenance(routeProvenance: EvalRouteProvenance): EvalRouteProvenance {
  return {
    ...(routeProvenance.bootstrapRoute
      ? { bootstrapRoute: toEvalRouteArtifact(routeProvenance.bootstrapRoute) }
      : {}),
    ...(routeProvenance.expandedRoute
      ? { expandedRoute: toEvalRouteArtifact(routeProvenance.expandedRoute) }
      : {}),
    ...(routeProvenance.activeRoute
      ? { activeRoute: toEvalRouteArtifact(routeProvenance.activeRoute) }
      : {}),
    ...(typeof routeProvenance.routeChanged === 'boolean'
      ? { routeChanged: routeProvenance.routeChanged }
      : {}),
    ...(routeProvenance.decisionSource
      ? { decisionSource: routeProvenance.decisionSource }
      : {}),
    ...(typeof routeProvenance.expandedCacheHit === 'boolean'
      ? { expandedCacheHit: routeProvenance.expandedCacheHit }
      : {}),
    ...(routeProvenance.packetHash
      ? { packetHash: routeProvenance.packetHash }
      : {}),
    ...(routeProvenance.routeSource
      ? { routeSource: routeProvenance.routeSource }
      : {}),
    ...(routeProvenance.routerMode
      ? { routerMode: routeProvenance.routerMode }
      : {}),
    ...(routeProvenance.routingMode
      ? { routingMode: routeProvenance.routingMode }
      : {}),
    ...(routeProvenance.artifactPath
      ? { artifactPath: routeProvenance.artifactPath }
      : {}),
    ...(routeProvenance.artifactHash
      ? { artifactHash: routeProvenance.artifactHash }
      : {}),
  };
}

function toEvalExecutedPlanning(executedPlanning: EvalExecutedPlanning): EvalExecutedPlanning {
  return {
    ...(executedPlanning.agent ? { agent: executedPlanning.agent } : {}),
    ...(executedPlanning.model ? { model: executedPlanning.model } : {}),
    ...(executedPlanning.status ? { status: executedPlanning.status } : {}),
    ...(executedPlanning.source ? { source: executedPlanning.source } : {}),
  };
}

const PLANNING_OUTCOME_STATUSES = new Set(['running', 'awaiting_user', 'completed', 'aborted', 'failed']);
const PLANNING_TERMINAL_REASONS = new Set([
  'turn_limit',
  'tool_call_limit',
  'wall_clock_limit',
  'tool_stagnation',
  'invalid_final_plan',
  'empty_final_plan',
  'aborted',
  'error',
]);

function toPlanningExecutionOutcome(outcome: PlanningExecutionOutcome): PlanningExecutionOutcome {
  const status = PLANNING_OUTCOME_STATUSES.has(String(outcome.status)) ? outcome.status : undefined;
  const failureReason = outcome.failureReason === null
    ? null
    : PLANNING_TERMINAL_REASONS.has(String(outcome.failureReason))
      ? outcome.failureReason
      : undefined;
  const bounds = outcome.bounds
    ? {
        ...(isFiniteNonNegativeBudget(outcome.bounds.maxTurns) ? { maxTurns: outcome.bounds.maxTurns } : {}),
        ...(isFiniteNonNegativeBudget(outcome.bounds.maxToolCalls) ? { maxToolCalls: outcome.bounds.maxToolCalls } : {}),
        ...(isFiniteNonNegativeBudget(outcome.bounds.maxWallClockMs) ? { maxWallClockMs: outcome.bounds.maxWallClockMs } : {}),
      }
    : undefined;
  const usage = outcome.usage
    ? {
        ...(isFiniteNonNegativeBudget(outcome.usage.turnsCompleted) ? { turnsCompleted: outcome.usage.turnsCompleted } : {}),
        ...(isFiniteNonNegativeBudget(outcome.usage.toolCallsExecuted) ? { toolCallsExecuted: outcome.usage.toolCallsExecuted } : {}),
        ...(isFiniteNonNegativeBudget(outcome.usage.wallClockMs) ? { wallClockMs: outcome.usage.wallClockMs } : {}),
        ...(isFiniteNonNegativeBudget(outcome.usage.totalInputTokens) ? { totalInputTokens: outcome.usage.totalInputTokens } : {}),
        ...(isFiniteNonNegativeBudget(outcome.usage.totalOutputTokens) ? { totalOutputTokens: outcome.usage.totalOutputTokens } : {}),
        ...(isFiniteNonNegativeBudget(outcome.usage.totalCostUsd) ? { totalCostUsd: outcome.usage.totalCostUsd } : {}),
      }
    : undefined;
  const promptRef = outcome.promptRef && isNonEmptyString(outcome.promptRef.id) && isNonEmptyString(outcome.promptRef.version)
    ? { id: outcome.promptRef.id, version: outcome.promptRef.version }
    : undefined;

  return {
    ...(isNonEmptyString(outcome.agent) ? { agent: outcome.agent } : {}),
    ...(isNonEmptyString(outcome.model) ? { model: outcome.model } : {}),
    ...(status ? { status } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(typeof outcome.planArtifactValid === 'boolean' ? { planArtifactValid: outcome.planArtifactValid } : {}),
    ...(typeof outcome.approvalReady === 'boolean' ? { approvalReady: outcome.approvalReady } : {}),
    ...(bounds && Object.keys(bounds).length > 0 ? { bounds } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ...(promptRef ? { promptRef } : {}),
    ...(outcome.source === '.planning-result.json' ? { source: outcome.source } : {}),
  };
}

export function attachChallengeRouteContext(
  record: EvalRecord,
  challengeRouteContext?: ChallengeRouteContext | null,
): void {
  if (!challengeRouteContext) {
    return;
  }
  record.challengeRouteContext = toEvalChallengeRouteContext(challengeRouteContext);
}

export function attachRouteProvenance(
  record: EvalRecord,
  routeProvenance?: EvalRouteProvenance | null,
): void {
  if (!routeProvenance) {
    return;
  }
  record.routeProvenance = toEvalRouteProvenance(routeProvenance);
}

export function attachExecutedPlanning(
  record: EvalRecord,
  executedPlanning?: EvalExecutedPlanning | null,
): void {
  if (!executedPlanning) {
    return;
  }
  record.executedPlanning = toEvalExecutedPlanning(executedPlanning);
}

export function attachPlanningExecutionOutcome(
  record: EvalRecord,
  planningExecutionOutcome?: PlanningExecutionOutcome | null,
): void {
  if (!planningExecutionOutcome) {
    return;
  }
  const sanitized = toPlanningExecutionOutcome(planningExecutionOutcome);
  if (Object.keys(sanitized).length === 0) {
    return;
  }
  record.planningExecutionOutcome = sanitized;
}

export function attachVerificationTelemetry(
  record: EvalRecord,
  telemetry?: VerificationTelemetry | null,
): void {
  if (!telemetry) {
    return;
  }

  record.verificationTelemetry = redactVerificationTelemetry(telemetry);
}

function classifyCheckFailure(command: string): VerificationTelemetryLocalExecution['first_failure_category'] {
  const normalized = command.toLowerCase();
  if (/\blint\b|eslint|biome lint|ruff|flake8/.test(normalized)) {
    return 'lint';
  }
  if (/\btest\b|vitest|jest|pytest|go test|cargo test/.test(normalized)) {
    return 'test';
  }
  if (/\bbuild\b|webpack|vite build|next build|tsup/.test(normalized)) {
    return 'build';
  }
  if (/\btypecheck\b|\btype-check\b|\btsc\b|mypy|pyright/.test(normalized)) {
    return 'type';
  }
  return 'custom';
}

function hashCheckOutput(logPath?: string): string | undefined {
  if (!logPath) {
    return undefined;
  }

  try {
    // Hash only a bounded excerpt to avoid run-specific noise (timestamps, etc)
    // This makes identical failures produce the same fingerprint
    if (!existsSync(logPath)) {
      return undefined;
    }
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');

    // Use first 50 and last 50 lines (matching extractBoundedLogExcerpt default)
    const captureLines = 50;
    const excerpt = lines.length <= captureLines * 2
      ? content
      : lines.slice(0, captureLines).concat(lines.slice(-captureLines)).join('\n');

    return createHash('sha256').update(redactText(excerpt)).digest('hex');
  } catch {
    return undefined;
  }
}

export function buildVerificationTelemetryFromArtifact(
  artifact: PrePrVerificationArtifact,
  config: PrePrVerificationConfig,
): VerificationTelemetry {
  const commandDurations = artifact.commands
    .map((command) => command.durationMs)
    .filter((duration): duration is number => isFiniteNonNegativeBudget(duration));
  const totalDurationMs = commandDurations.reduce((sum, duration) => sum + duration, 0);
  const failedCommand = artifact.commands.find((command) => command.status !== 'pass');
  const localVerification: VerificationTelemetryLocalExecution = {
    ran: true,
    passed: artifact.overallStatus === 'pass',
    command_count: artifact.commands.length,
    total_duration_ms: totalDurationMs,
    command_durations_ms: commandDurations,
    timed_out: artifact.overallStatus === 'timeout',
  };

  if (failedCommand) {
    localVerification.first_failure_index = failedCommand.index;
    localVerification.first_failure_category = classifyCheckFailure(failedCommand.command);
    const fingerprint = hashCheckOutput(failedCommand.logPath);
    if (fingerprint) {
      localVerification.first_failure_fingerprint = fingerprint;
    }
  }

  const telemetry: VerificationTelemetry = {
    schema_version: '1.0',
    contract: {
      source: config.source,
      version: artifact.version || '1.0',
    },
    checked_shas: {
      head: artifact.headSha,
      base: artifact.baseSha,
    },
    local_verification: localVerification,
    timeline: {
      // Legacy artifacts predate startTime/endTime. Their required timestamp
      // still describes the verification start and must not be discarded.
      local_start: artifact.startTime
        ? new Date(artifact.startTime).toISOString()
        : artifact.timestamp,
      local_end: artifact.endTime ? new Date(artifact.endTime).toISOString() : undefined,
    },
  };

  if (artifact.overriddenBy) {
    telemetry.operator_override = {
      applied: true,
      reason: artifact.overriddenBy.reason,
      timestamp: artifact.overriddenBy.timestamp,
    };
    telemetry.remediation = {
      local_remediation_outcome: 'override',
    };
  }

  return telemetry;
}

export function attachPhaseDurations(
  record: EvalRecord,
  durations?: EvalPhaseDurations | null,
): void {
  if (!durations) {
    return;
  }

  record.phaseDurationsSeconds = {
    ...(isFiniteNonNegativeBudget(durations.planning) ? { planning: durations.planning } : {}),
    ...(isFiniteNonNegativeBudget(durations.coding) ? { coding: durations.coding } : {}),
    ...(isFiniteNonNegativeBudget(durations.review) ? { review: durations.review } : {}),
    ...(isFiniteNonNegativeBudget(durations.total) ? { total: durations.total } : {}),
  };
}

function pickFirstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickOperatingMode(
  ...values: Array<unknown>
): RoutingDecision['operatingModeDependency'] | undefined {
  for (const value of values) {
    if (value === 'normal' || value === 'constrained' || value === 'survival') {
      return value;
    }
  }
  return undefined;
}

export function attachRouterPolicyMetadata(
  record: EvalRecord | null | undefined,
  routeProvenance?: EvalRouteProvenance | null,
): void {
  if (!record?.routingDecision) {
    return;
  }
  // No-op when there is no provenance data to derive from — avoids
  // overwriting a correctly-set decisionPolicyVersion with 'baseline'.
  if (!routeProvenance && !record.routeProvenance) {
    return;
  }

  const routeMode = pickFirstNonEmptyString(
    record.routeProvenance?.routingMode,
    routeProvenance?.routingMode,
    routeProvenance?.activeRoute?.routingMode,
    routeProvenance?.expandedRoute?.routingMode,
    routeProvenance?.bootstrapRoute?.routingMode,
  );
  const source = pickFirstNonEmptyString(
    routeProvenance?.activeRoute?.source,
    routeProvenance?.expandedRoute?.source,
    routeProvenance?.bootstrapRoute?.source,
  );
  const operatingMode = pickOperatingMode(
    record.routeProvenance?.routerMode,
    routeProvenance?.routerMode,
    routeProvenance?.activeRoute?.routerMode,
    routeProvenance?.expandedRoute?.routerMode,
    routeProvenance?.bootstrapRoute?.routerMode,
  );

  record.routingDecision.decisionPolicyVersion = resolveRouterPolicyVersion({
    routingMode: routeMode,
    source,
    routerMode: operatingMode,
  });

  record.routingDecision.routeArtifactSchemaVersion = ROUTE_ARTIFACT_SCHEMA_VERSION;
  record.routingDecision.policyResolverVersion = POLICY_RESOLVER_VERSION;

  if (routeMode) {
    record.routingDecision.routeMode = routeMode;
  }
  if (operatingMode) {
    record.routingDecision.operatingModeDependency = operatingMode;
  }
}

/**
 * Attach difficulty analysis metadata to eval record.
 * Only mutates record if difficultyData is non-null.
 */
export function attachDifficultyMetadata(
  record: EvalRecord,
  difficultyData: DifficultyAnalysis | null
): void {
  if (difficultyData) {
    record.difficultyBand = difficultyData.difficultyBand;
    record.difficultySignals = difficultyData.difficultySignals;
    record.stratum = difficultyData.stratum;
  }
}

/**
 * Attach task context analysis metadata to eval record.
 * Only mutates record if taskContextData is non-null.
 */
export function attachTaskContextMetadata(
  record: EvalRecord,
  taskContextData: TaskContext | null
): void {
  if (taskContextData) {
    record.taskContext = taskContextData;
  }
}

/**
 * Attach repo context analysis metadata to eval record.
 * Only mutates record if repoContextData is non-null.
 */
export function attachRepoContextMetadata(
  record: EvalRecord,
  repoContextData: RepoContext | null
): void {
  if (repoContextData) {
    record.repoContext = repoContextData;
  }
}

/**
 * Attach workflow cost computation metadata to eval record.
 *
 * Handles both success and failure cases:
 * - Success: sets workflowCost, workflowTokenUsage, workflowCostStatus, pricingSnapshot
 * - Failure: sets workflowCostStatus, workflowCostDiagnostics
 */
export function attachWorkflowCostMetadata(
  record: EvalRecord,
  costOutcome: WorkflowCostOutcome | null
): void {
  if (!costOutcome) {
    return;
  }

  if (costOutcome.status === 'success') {
    const success = costOutcome as WorkflowCostResult;
    record.workflowCost = success.totalCostUsd;
    record.workflowTokenUsage = success.models;
    record.workflowCostStatus = 'success';
    record.pricingSnapshot = success.pricingUsed;
    if (success.attribution) {
      record.workflowCostAttribution = success.attribution;
    }
  } else {
    const failure = costOutcome as WorkflowCostFailure;
    record.workflowCostStatus = failure.status;
    record.workflowCostDiagnostics = {
      reason: failure.reason,
      ...failure.diagnostics,
    };
  }
}

export function attachRoutePrediction(
  record: EvalRecord,
  prediction: RoutePrediction | null | undefined,
): void {
  if (!prediction) {
    return;
  }

  const normalized: RoutePrediction = {};

  if (isFiniteNumber(prediction.expectedSuccess)) {
    normalized.expectedSuccess = prediction.expectedSuccess;
  }
  if (isFiniteNonNegativeBudget(prediction.expectedCostUsd)) {
    normalized.expectedCostUsd = prediction.expectedCostUsd;
  }
  if (isFiniteNumber(prediction.confidence)) {
    normalized.confidence = prediction.confidence;
  }
  if (isFiniteNonNegativeBudget(prediction.riskScore)) {
    normalized.riskScore = prediction.riskScore;
  }
  if (isNonEmptyString(prediction.taskType)) {
    normalized.taskType = prediction.taskType;
  }
  if (isNonEmptyString(prediction.taskDifficulty)) {
    normalized.taskDifficulty = prediction.taskDifficulty;
  }
  if (Array.isArray(prediction.topFeatures)) {
    const topFeatures = prediction.topFeatures
      .filter((entry): entry is string => isNonEmptyString(entry))
      .slice(0, 5);
    if (topFeatures.length > 0) {
      normalized.topFeatures = topFeatures;
    }
  }
  if (isNonEmptyString(prediction.rationaleSummary)) {
    normalized.rationaleSummary = prediction.rationaleSummary;
  }

  if (hasObjectValues(normalized as Record<string, unknown>)) {
    record.routePrediction = normalized;
  }
}

export function attachRoutingDecisions(
  record: EvalRecord,
  routing: EvalRouting | null | undefined,
): void {
  if (!routing || Object.keys(routing).length === 0) {
    return;
  }
  record.routing = routing;
}

export function attachRouteCalibration(
  record: EvalRecord,
  calibration: RouteCalibration | null | undefined,
): void {
  if (!calibration) {
    return;
  }

  const normalized: RouteCalibration = {};

  if (isFiniteNumber(calibration.costErrorUsd)) {
    normalized.costErrorUsd = roundMetric(calibration.costErrorUsd);
  }
  if (isFiniteNumber(calibration.successDelta)) {
    normalized.successDelta = roundMetric(calibration.successDelta);
  }
  if (isFiniteNumber(calibration.predictedSuccess)) {
    normalized.predictedSuccess = calibration.predictedSuccess;
  }
  if (typeof calibration.actualSuccess === 'boolean') {
    normalized.actualSuccess = calibration.actualSuccess;
  }
  if (isFiniteNonNegativeBudget(calibration.predictedCostUsd)) {
    normalized.predictedCostUsd = calibration.predictedCostUsd;
  }
  if (isFiniteNonNegativeBudget(calibration.actualCostUsd)) {
    normalized.actualCostUsd = calibration.actualCostUsd;
  }
  if (
    typeof calibration.interventionCount === 'number'
    && Number.isInteger(calibration.interventionCount)
    && calibration.interventionCount >= 0
  ) {
    normalized.interventionCount = calibration.interventionCount;
  }
  if (isFiniteNonNegativeBudget(calibration.durationMs)) {
    normalized.durationMs = calibration.durationMs;
  }

  if (hasObjectValues(normalized as Record<string, unknown>)) {
    record.routeCalibration = normalized;
  }
}

export function computeRouteCalibration(
  recordOrActuals: Pick<EvalRecord, 'workflowCost' | 'outcomes' | 'timeSeconds' | 'interventionCount'>,
  prediction: RoutePrediction | null | undefined,
): RouteCalibration | undefined {
  if (!prediction) {
    return undefined;
  }

  const actualSuccess = typeof recordOrActuals.outcomes?.success === 'boolean'
    ? recordOrActuals.outcomes.success
    : undefined;
  const actualCostUsd = isFiniteNonNegativeBudget(recordOrActuals.workflowCost)
    ? recordOrActuals.workflowCost
    : undefined;
  const durationMs = isFiniteNonNegativeBudget(recordOrActuals.timeSeconds)
    ? roundMetric(recordOrActuals.timeSeconds * 1000)
    : undefined;
  const interventionCount = Number.isInteger(recordOrActuals.interventionCount)
    && recordOrActuals.interventionCount >= 0
    ? recordOrActuals.interventionCount
    : undefined;

  const calibration: RouteCalibration = {
    ...(isFiniteNumber(prediction.expectedSuccess)
      ? { predictedSuccess: prediction.expectedSuccess }
      : {}),
    ...(typeof actualSuccess === 'boolean' ? { actualSuccess } : {}),
    ...(isFiniteNonNegativeBudget(prediction.expectedCostUsd)
      ? { predictedCostUsd: prediction.expectedCostUsd }
      : {}),
    ...(typeof actualCostUsd === 'number' ? { actualCostUsd } : {}),
    ...(typeof interventionCount === 'number' ? { interventionCount } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  };

  if (isFiniteNumber(prediction.expectedSuccess) && typeof actualSuccess === 'boolean') {
    calibration.successDelta = roundMetric((actualSuccess ? 1 : 0) - prediction.expectedSuccess);
  }
  if (isFiniteNonNegativeBudget(prediction.expectedCostUsd) && typeof actualCostUsd === 'number') {
    calibration.costErrorUsd = roundMetric(prediction.expectedCostUsd - actualCostUsd);
  }

  return hasObjectValues(calibration as Record<string, unknown>) ? calibration : undefined;
}

const TRAINING_METADATA_DIAGNOSTIC_CHECKS = [
  { field: 'workflowCost', isPresent: (record: EvalRecord) => typeof record.workflowCost === 'number' && Number.isFinite(record.workflowCost) },
  { field: 'taskDescriptor', isPresent: (record: EvalRecord) => record.taskDescriptor != null },
  { field: 'constraints', isPresent: (record: EvalRecord) => record.constraints != null },
  {
    field: 'difficulty',
    isPresent: (record: EvalRecord) =>
      record.difficultyBand != null || record.difficultySignals != null || record.stratum != null,
  },
  { field: 'taskContext', isPresent: (record: EvalRecord) => record.taskContext != null },
  { field: 'repoContext', isPresent: (record: EvalRecord) => record.repoContext != null },
  { field: 'routeProvenance', isPresent: (record: EvalRecord) => record.routeProvenance != null },
] as const;

function attachEnrichmentDiagnostics(record: EvalRecord): void {
  const missingFields = TRAINING_METADATA_DIAGNOSTIC_CHECKS
    .filter(({ isPresent }) => !isPresent(record))
    .map(({ field }) => field);
  if (missingFields.length === 0) {
    delete record.enrichmentDiagnostics;
    return;
  }

  record.enrichmentDiagnostics = [...missingFields];

  const identity = [record.id, record.issueId].filter(Boolean).join(' / ') || '<unknown-record>';
  console.warn(
    `Eval record enrichment missing metadata for ${identity}: ${record.enrichmentDiagnostics.join(', ')}`
  );
}

const TRAINING_ELIGIBILITY_CODES: readonly EligibilityErrorCode[] = [
  'missing_model_identity',
  'missing_outcome',
  'missing_routing',
  'missing_task_descriptor',
  'eval_fast_failed',
  'provisional_model_identity',
];

const BUDGET_EVAL_ELIGIBILITY_CODES: readonly EligibilityErrorCode[] = [
  BUDGET_MISSING,
  'missing_budget_snapshot',
  'missing_cost',
  'missing_routing',
  'eval_fast_failed',
  'provisional_model_identity',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegativeBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function hasObjectValues(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function hasBudgetSnapshot(record: EvalRecord): boolean {
  return isFiniteNonNegativeBudget(record.constraints?.maxCostUsd)
    || isFiniteNonNegativeBudget(record.taskDescriptor?.constraints?.max_cost_usd);
}

function roleFromDescriptorStage(stage: string): RoutingRole | null {
  const normalized = stage.toLowerCase();
  if (normalized === 'planner' || normalized === 'planning' || normalized === 'expansion') return 'planner';
  if (normalized === 'coder' || normalized === 'coding' || normalized === 'implementation') return 'coder';
  if (normalized === 'reviewer' || normalized === 'review') return 'reviewer';
  return null;
}

function collectExecutedModelRefs(record: EvalRecord): Array<{ role: RoutingRole; modelId: string }> {
  const refs: Array<{ role: RoutingRole; modelId: string }> = [];
  const add = (role: RoutingRole, modelId: unknown): void => {
    if (typeof modelId !== 'string' || modelId.trim().length === 0) return;
    refs.push({ role, modelId: modelId.trim() });
  };

  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    add(role, record.routing?.[role]?.resolvedModelId);
  }
  add('planner', record.executedPlanning?.model);
  add('planner', record.planningExecutionOutcome?.model);
  add('coder', record.attempted_model);

  for (const [stage, descriptor] of Object.entries(record.taskDescriptor?.stages ?? {})) {
    const role = roleFromDescriptorStage(stage);
    if (role) {
      add(role, descriptor.model);
    }
  }

  return refs;
}

function collectCandidateModelRefs(record: EvalRecord): string[] {
  const models = new Set<string>();
  for (const candidate of record.routingDecision?.candidates ?? []) {
    if (typeof candidate.modelId === 'string' && candidate.modelId.trim().length > 0) {
      models.add(candidate.modelId.trim());
    }
  }
  for (const modelId of record.taskDescriptor?.constraints?.models_available ?? []) {
    if (typeof modelId === 'string' && modelId.trim().length > 0) {
      models.add(modelId.trim());
    }
  }
  return [...models];
}

export function computeModelIdentityAttribution(
  record: EvalRecord,
  registry: ModelRegistry = getEffectiveRegistry(),
  observedAt: string = new Date().toISOString(),
): EvalRecord['modelIdentityAttribution'] {
  const roles: EvalRecord['modelIdentityAttribution']['roles'] = {};
  const provisionalRoles = new Set<RoutingRole>();
  const executedModels = new Set<string>();

  for (const ref of collectExecutedModelRefs(record)) {
    executedModels.add(ref.modelId);
    const resolved = resolveProviderNativeModelId(ref.modelId, registry);
    const identity = resolveModelIdentity(registry, ref.modelId);
    roles[ref.role] = {
      alias: resolved?.wavemillAlias ?? ref.modelId,
      providerId: resolved?.providerNativeId,
      identityStatus: identity.status,
      identityRevision: identity.revision,
      fingerprint: identity.fingerprint,
      evidencePolicy: identity.evidencePolicy,
    };
    if (identity.status === 'provisional' || identity.evidencePolicy === 'held') {
      provisionalRoles.add(ref.role);
    }
  }

  const candidateOnlyProvisional = collectCandidateModelRefs(record)
    .filter((modelId) => !executedModels.has(modelId))
    .filter((modelId) => {
      const identity = resolveModelIdentity(registry, modelId);
      return identity.status === 'provisional' || identity.evidencePolicy === 'held';
    })
    .sort();

  if (Object.keys(roles).length === 0 && candidateOnlyProvisional.length === 0) {
    return undefined;
  }

  return {
    observedAt,
    roles,
    provisionalRoles: [...provisionalRoles].sort(),
    candidateOnlyProvisional,
  };
}

export function attachModelIdentityAttribution(
  record: EvalRecord | null | undefined,
  registry: ModelRegistry = getEffectiveRegistry(),
  observedAt?: string,
): void {
  if (!record) return;
  const attribution = computeModelIdentityAttribution(record, registry, observedAt);
  if (attribution) {
    record.modelIdentityAttribution = attribution;
  } else {
    delete record.modelIdentityAttribution;
  }
}

/**
 * Compute deterministic eligibility diagnostics for downstream exports.
 */
export function computeEligibility(record: EvalRecord): {
  trainingEligible: boolean;
  budgetEvalEligible: boolean;
  eligibilityErrors: EligibilityErrorCode[];
} {
  const errors = new Set<EligibilityErrorCode>();

  if (!record.routingDecision) {
    errors.add('missing_routing');
  }

  if (record.failureReason) {
    errors.add('eval_fast_failed');
  }

  if (!record.taskDescriptor) {
    errors.add('missing_task_descriptor');
  }

  if (!isNonEmptyString(record.modelId)) {
    errors.add('missing_model_identity');
  }

  if (!record.outcomes) {
    errors.add('missing_outcome');
  }

  if (typeof record.workflowCost !== 'number' || !Number.isFinite(record.workflowCost)) {
    errors.add('missing_cost');
  }

  if (!hasBudgetSnapshot(record)) {
    errors.add(BUDGET_MISSING);
    errors.add('missing_budget_snapshot');
  }

  if ((record.modelIdentityAttribution?.provisionalRoles.length ?? 0) > 0) {
    errors.add('provisional_model_identity');
  }

  const eligibilityErrors = [...errors].sort();
  const trainingEligible = !TRAINING_ELIGIBILITY_CODES.some((code) => errors.has(code));
  const budgetEvalEligible = !BUDGET_EVAL_ELIGIBILITY_CODES.some((code) => errors.has(code));

  return {
    trainingEligible,
    budgetEvalEligible,
    eligibilityErrors,
  };
}

/**
 * Attach deterministic export eligibility diagnostics to an eval record.
 *
 * Overwrites any existing eligibility fields so repeated calls are idempotent.
 */
export function attachEligibility(record: EvalRecord | null | undefined): void {
  if (!record) {
    return;
  }

  const eligibility = computeEligibility(record);
  record.trainingEligible = record.invalidChallenge === true ? false : eligibility.trainingEligible;
  record.budgetEvalEligible = eligibility.budgetEvalEligible;
  record.eligibilityErrors = eligibility.eligibilityErrors;
  if (eligibility.eligibilityErrors.includes(BUDGET_MISSING)) {
    record.budgetEvalEligibilityError = BUDGET_MISSING;
  } else {
    delete record.budgetEvalEligibilityError;
  }
  const reason = deriveNonRewardReasonFromIssues(
    validateEvalRecord(record, { file: '<inline>', line: 0 }),
  );
  if (!reason && isValidationNonRewardCode(record.nonRewardReason?.code)) {
    delete record.nonRewardReason;
    return;
  }
  attachNonRewardReason(record, reason);
}

export function attachNonRewardReason(
  record: EvalRecord,
  reason?: { code: string; message: string } | null,
): void {
  if (!reason) {
    return;
  }

  record.nonRewardReason = reason;
}

/**
 * Attach stage outcomes to eval record (HOK-1004).
 *
 * Converts judge's stageScores (from metadata) into StageOutcomes format
 * and builds the RoutingOutcome from routing decision + workflow results.
 *
 * @param record - Eval record to mutate
 * @param stageScores - Judge's per-stage scores from metadata (optional)
 */
export function attachStageOutcomes(
  record: EvalRecord,
  stageScores?: Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] | null }>,
  planCritique?: PlanCritique,
): void {
  if (!stageScores || Object.keys(stageScores).length === 0) {
    return;
  }

  const stageOutcomes: StageOutcomes = {};

  // Convert judge stageScores to StageScore format
  if (stageScores.expansion) {
    stageOutcomes.expansion = {
      score: stageScores.expansion.score,
      rationale: stageScores.expansion.rationale,
      ...(stageScores.expansion.rubricCriteria?.length && {
        rubricCriteria: stageScores.expansion.rubricCriteria,
      }),
    };
  }

  if (stageScores.plan) {
    stageOutcomes.plan = {
      score: stageScores.plan.score,
      rationale: stageScores.plan.rationale,
      ...(stageScores.plan.rubricCriteria?.length && {
        rubricCriteria: stageScores.plan.rubricCriteria,
      }),
      ...(planCritique && { planCritique }),
    };
  }

  if (stageScores.implementation) {
    stageOutcomes.implementation = {
      score: stageScores.implementation.score,
      rationale: stageScores.implementation.rationale,
      ...(stageScores.implementation.rubricCriteria?.length && {
        rubricCriteria: stageScores.implementation.rubricCriteria,
      }),
    };
  }

  if (stageScores.review) {
    stageOutcomes.review = {
      score: stageScores.review.score,
      rationale: stageScores.review.rationale,
      ...(stageScores.review.rubricCriteria?.length && {
        rubricCriteria: stageScores.review.rubricCriteria,
      }),
    };
  }

  // Build RoutingOutcome from routing decision + workflow results
  if (record.routingDecision) {
    const rd = record.routingDecision;
    stageOutcomes.routing = {
      routingUsed: rd.candidates.length >= 2,
      candidateCount: rd.candidates.length,
      chosenModel: typeof rd.chosen === 'number'
        ? rd.candidates[rd.chosen]?.modelId
        : rd.chosen?.modelId,
      scoreAchieved: record.score,
      costUsd: record.workflowCost,
      policyVersion: rd.decisionPolicyVersion,
    };
  }

  // Only attach if we have at least one stage outcome
  if (Object.keys(stageOutcomes).length > 0) {
    record.stageOutcomes = stageOutcomes;
  }
}

/**
 * Attach task descriptor to eval record (HOK-1120).
 *
 * Adds the taskDescriptor field if a valid descriptor is provided.
 * The descriptor consolidates generalizable task features for router training.
 *
 * @param record - Eval record to mutate
 * @param descriptor - Task descriptor from buildTaskDescriptor (optional)
 */
export function attachTaskDescriptor(
  record: EvalRecord,
  descriptor: TaskDescriptor | null,
): void {
  if (descriptor) {
    record.taskDescriptor = descriptor;
  }
}

/**
 * Attach fallback event telemetry to the eval record.
 */
export function attachFallbackEvent(
  record: EvalRecord,
  fallbackEvent: FallbackEventMetadata | null,
): void {
  if (fallbackEvent) {
    record.fallbackEvent = fallbackEvent;
  }
}

/**
 * Attach routing constraints to the eval record.
 */
export function attachConstraints(
  record: EvalRecord,
  constraints: EvalConstraints | null,
): void {
  if (!constraints) {
    return;
  }

  const normalized: EvalConstraints = {};
  if (typeof constraints.maxCostUsd === 'number') {
    normalized.maxCostUsd = constraints.maxCostUsd;
  }

  if (Object.keys(normalized).length > 0) {
    record.constraints = normalized;
  }
}

/**
 * Attach the routing budget snapshot to every eval-facing budget location.
 *
 * `0` is a valid budget. Missing, null, negative, or non-finite values mark
 * the record as explicitly missing budget metadata without fabricating a
 * descriptor that otherwise has required training fields.
 */
export function attachBudgetMetadata(record: EvalRecord, budgetUsd: unknown): void {
  if (!isFiniteNonNegativeBudget(budgetUsd)) {
    if (record.constraints && 'maxCostUsd' in record.constraints) {
      const { maxCostUsd: _maxCostUsd, ...rest } = record.constraints;
      record.constraints = Object.keys(rest).length > 0 ? rest : undefined;
    }
    if (record.taskDescriptor?.constraints) {
      delete record.taskDescriptor.constraints.max_cost_usd;
    }
    record.budgetEvalEligible = false;
    record.budgetEvalEligibilityError = BUDGET_MISSING;
    record.eligibilityErrors = Array.from(new Set([...(record.eligibilityErrors ?? []), BUDGET_MISSING])).sort();
    return;
  }

  record.constraints = {
    ...(record.constraints ?? {}),
    maxCostUsd: budgetUsd,
  };
  if (record.taskDescriptor?.constraints) {
    record.taskDescriptor.constraints.max_cost_usd = budgetUsd;
  }
  record.budgetEvalEligible = true;
  delete record.budgetEvalEligibilityError;
  if (record.eligibilityErrors) {
    record.eligibilityErrors = record.eligibilityErrors.filter((code) => code !== BUDGET_MISSING && code !== 'missing_budget_snapshot');
  }
}

/**
 * Extract and attach budget violation metadata from routing decision (HOK-1350).
 *
 * Populates budgetViolated and budgetViolationDetails fields when the routing
 * decision contains a budget violation, enabling analysis of cost constraint
 * effectiveness and budget tuning.
 *
 * @param record - Eval record to mutate
 */
export function attachBudgetViolation(record: EvalRecord): void {
  const routingDecision = record.routingDecision as any;
  if (!routingDecision?.budgetViolation) {
    return;
  }

  const v = routingDecision.budgetViolation;
  record.budgetViolated = true;
  record.budgetViolationDetails = {
    requestedCost: v.requestedCost,
    maxCostUsd: v.maxCostUsd,
    operatingMode: v.operatingMode,
    attemptedDowngrade: v.attemptedDowngrade,
    cheapestOption: v.cheapestViableOption ? {
      totalCost: v.cheapestViableOption.totalCost,
      wouldStillExceed: v.cheapestViableOption.totalCost > v.maxCostUsd,
    } : undefined,
  };
}

export function attachManifestRef(
  record: EvalRecord,
  sessionId?: string | null,
  repoDir?: string,
): void {
  if (!sessionId) {
    return;
  }
  const harnessId = getHarnessId(sessionId, repoDir);
  if (harnessId) {
    record.harnessId = harnessId;
  }
  const manifestRef = getManifestRef(sessionId, repoDir);
  if (manifestRef) {
    record.manifestRef = manifestRef as ManifestRef;
  }
}

export function attachResourceSelections(record: EvalRecord): void {
  const routingDecision = record.routingDecision as (RoutingDecision & { resourceSelections?: RuntimeResourceSelection[] }) | undefined;
  // Routing decision may carry router-surface entries; manifest carries planner/reviewer prompt entries.
  // Both sources are merged so no surface is silently omitted when both are present.
  const routingSelections: RuntimeResourceSelection[] = routingDecision?.resourceSelections ?? [];

  const sessionId = process.env.WAVEMILL_SESSION;
  const manifestSelections: RuntimeResourceSelection[] = [];

  if (sessionId) {
    const manifest = getManifest(sessionId);
    if (manifest) {
      for (const ref of manifest.resources) {
        const resource = getResource(ref.id, ref.version);
        if (!resource) {
          continue;
        }

        if (resource.type === 'prompt' && resource.uri === 'tools/prompts/planning-phase.md') {
          manifestSelections.push({
            surface: 'planner',
            variant: 'baseline',
            requestedVariant: 'baseline',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'prompt' && resource.uri === 'tools/prompts/review-phase.md') {
          manifestSelections.push({
            surface: 'reviewer',
            variant: 'baseline',
            requestedVariant: 'baseline',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'prompt' && resource.name === 'planner-optimized') {
          manifestSelections.push({
            surface: 'planner',
            variant: 'optimized',
            requestedVariant: 'optimized',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'prompt' && resource.name === 'reviewer-optimized') {
          manifestSelections.push({
            surface: 'reviewer',
            variant: 'optimized',
            requestedVariant: 'optimized',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'optimizer-artifact') {
          // Router artifacts are registered as optimizer-artifact type, not prompt.
          const routerVariant = resource.name.includes('optimized') ? 'optimized' : 'baseline';
          manifestSelections.push({
            surface: 'router',
            variant: routerVariant as 'baseline' | 'optimized' | 'canary',
            requestedVariant: 'baseline' as const,
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        }
      }
    }
  }

  // Routing selections take priority; manifest fills surfaces not already covered.
  const coveredSurfaces = new Set(routingSelections.map((s) => s.surface));
  const merged = [
    ...routingSelections,
    ...manifestSelections.filter((s) => !coveredSurfaces.has(s.surface)),
  ];

  if (merged.length > 0) {
    record.resourceSelections = merged;
  }
}

/**
 * Attach structured rubric criteria evaluation to the eval record (HOK-1406).
 *
 * No-op when rubricEval is undefined, so old records and LLM non-compliance
 * both leave record.rubricEval unset without errors.
 */
export function attachRubricEval(record: EvalRecord, rubricEval?: RubricEval): void {
  if (!rubricEval) return;
  const normalizedRubricEval = { ...rubricEval };
  // Drop anything that is not one of the allowed enum strings. The previous
  // `typeof === 'string'` precondition meant only invalid *strings* were
  // dropped, so a non-string the judge emitted -- `null` above all -- survived
  // here and then failed write-time validation against the schema's
  // `"type": "string"`, discarding the whole eval record
  // (SCHEMA_VIOLATION(rubricEval.determinative_boundary), HOK-2844).
  if (
    'determinative_boundary' in normalizedRubricEval
    && !(
      typeof normalizedRubricEval.determinative_boundary === 'string'
      && RUBRIC_DETERMINATIVE_BOUNDARY_SET.has(normalizedRubricEval.determinative_boundary)
    )
  ) {
    delete normalizedRubricEval.determinative_boundary;
  }
  record.rubricEval = normalizedRubricEval;
  record.rubric_provenance = 'judge';
}

/**
 * Attach a trace correlation ID to an eval record (HOK-2259).
 *
 * Links the eval record to the task lifecycle event stream so route decisions,
 * phase durations, check outcomes, and fallbacks can be attributed to the same
 * task execution.
 *
 * No-op when `traceId` is falsy.
 */
export function attachTraceId(record: EvalRecord, traceId: string | undefined | null): void {
  if (traceId && typeof traceId === 'string' && traceId.trim().length > 0) {
    record.traceId = traceId.trim();
  }
}

/**
 * Attach feature outcome artifact diagnostics to an eval record (HOK-2262).
 *
 * Records artifact presence, validity, source provenance, normalized outcome
 * fields, and eligibility classification from the feature-state artifact.
 * No-op when diagnostics is null or undefined; does not erase existing data.
 */
export function attachFeatureOutcomeDiagnostics(
  record: EvalRecord,
  diagnostics: FeatureOutcomeDiagnostics | null | undefined,
): void {
  if (!diagnostics) {
    return;
  }
  record.featureOutcomeDiagnostics = diagnostics;
}

// ────────────────────────────────────────────────────────────────
// Main Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Enrich an eval record with all available metadata.
 *
 * Mutates the record in place by attaching:
 * - Agent type
 * - Difficulty analysis
 * - Task context analysis
 * - Repo context analysis
 * - Workflow cost computation
 * - Stage outcomes (from judge's stageScores)
 * - Task descriptor (from buildTaskDescriptor)
 *
 * @param record - Base eval record from evaluateTask()
 * @param metadata - All metadata to attach
 */
export function enrichEvalRecord(record: EvalRecord, metadata: EvalRecordMetadata): void {
  attachAgentType(record, metadata.agentType);
  attachProviderMetadata(record, metadata.provider, metadata.endpoint);
  attachChallengePairId(record, metadata.challengePairId);
  attachEvaluatedPrHeadSha(record, metadata.evaluatedPrHeadSha);
  attachChallengeExecutionMetadata(record, {
    side: metadata.challengeSide,
    intent: metadata.challengeIntent,
    evidence: metadata.challengeExecutionEvidence,
  });
  attachChallengeStageEval(record, metadata.challengeStageEval);
  attachReviewExecutedIdentity(record, metadata.reviewExecutedIdentity);
  attachChallengeRouteContext(record, metadata.challengeRouteContext);
  attachRouteProvenance(record, metadata.routeProvenance);
  attachExecutedPlanning(record, metadata.executedPlanning);
  attachPlanningExecutionOutcome(record, metadata.planningExecutionOutcome);
  attachVerificationTelemetry(record, metadata.verificationTelemetry);
  attachPhaseDurations(record, metadata.phaseDurations);
  attachRouterPolicyMetadata(record, metadata.routeProvenance);
  attachRoutePrediction(record, metadata.routePrediction);
  attachDifficultyMetadata(record, metadata.difficulty || null);
  attachTaskContextMetadata(record, metadata.taskContext || null);
  attachRepoContextMetadata(record, metadata.repoContext || null);
  attachRoutingDecisions(record, metadata.routing);
  attachWorkflowCostMetadata(record, metadata.workflowCost || null);
  attachRouteCalibration(record, computeRouteCalibration(record, record.routePrediction));
  attachTaskDescriptor(record, metadata.taskDescriptor || null);
  attachFallbackEvent(record, metadata.fallbackEvent || null);
  attachConstraints(record, metadata.constraints || null);
  attachBudgetMetadata(record, metadata.constraints?.maxCostUsd);
  attachBudgetViolation(record);
  if (metadata.rubricEval) {
    attachRubricEval(record, metadata.rubricEval);
  }
  attachManifestRef(record, process.env.WAVEMILL_SESSION, undefined);
  attachResourceSelections(record);
  attachModelIdentityAttribution(record, metadata.registry ?? getEffectiveRegistry());
  attachEligibility(record);
  attachChallengeExecutionMetadata(record, {
    side: metadata.challengeSide,
    intent: metadata.challengeIntent,
    evidence: metadata.challengeExecutionEvidence,
  });

  // Extract stageScores from record metadata (set by evaluateTask)
  const stageScores = record.metadata?.stageScores as
    | Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] }>
    | undefined;
  const planCritique = record.metadata?.planCritique as PlanCritique | undefined;
  attachStageOutcomes(record, stageScores, planCritique);
}

/**
 * Enrich an eval record with full training-facing metadata plus diagnostics.
 *
 * Mirrors enrichEvalRecord's attachment order and adds structured diagnostics
 * when expected enrichment inputs are missing.
 */
export function enrichTrainingMetadata(
  record: EvalRecord,
  metadata: EnrichTrainingMetadataInput,
): void {
  attachAgentType(record, metadata.agentType);
  attachProviderMetadata(record, metadata.provider, metadata.endpoint);
  attachChallengePairId(record, metadata.challengePairId);
  attachEvaluatedPrHeadSha(record, metadata.evaluatedPrHeadSha);
  attachChallengeExecutionMetadata(record, {
    side: metadata.challengeSide,
    intent: metadata.challengeIntent,
    evidence: metadata.challengeExecutionEvidence,
  });
  attachChallengeStageEval(record, metadata.challengeStageEval);
  attachReviewExecutedIdentity(record, metadata.reviewExecutedIdentity);
  attachChallengeRouteContext(record, metadata.challengeRouteContext);
  attachRouteProvenance(record, metadata.routeProvenance);
  attachExecutedPlanning(record, metadata.executedPlanning);
  attachPlanningExecutionOutcome(record, metadata.planningExecutionOutcome);
  attachVerificationTelemetry(record, metadata.verificationTelemetry);
  attachRouterPolicyMetadata(record, metadata.routeProvenance);
  attachRoutePrediction(record, metadata.routePrediction);
  attachDifficultyMetadata(record, metadata.difficulty || null);
  attachTaskContextMetadata(record, metadata.taskContext || null);
  attachRepoContextMetadata(record, metadata.repoContext || null);
  attachRoutingDecisions(record, metadata.routing);
  attachWorkflowCostMetadata(record, metadata.workflowCost || null);
  attachRouteCalibration(record, computeRouteCalibration(record, record.routePrediction));
  attachTaskDescriptor(record, metadata.taskDescriptor || null);
  attachFallbackEvent(record, metadata.fallbackEvent || null);
  attachConstraints(record, metadata.constraints || null);
  attachBudgetViolation(record);
  if (metadata.rubricEval) {
    attachRubricEval(record, metadata.rubricEval);
  }
  attachFeatureOutcomeDiagnostics(record, metadata.featureOutcomeDiagnostics ?? null);
  attachManifestRef(record, process.env.WAVEMILL_SESSION, undefined);
  attachResourceSelections(record);
  attachEnrichmentDiagnostics(record);
  attachModelIdentityAttribution(record, metadata.registry ?? getEffectiveRegistry());
  attachEligibility(record);
  attachChallengeExecutionMetadata(record, {
    side: metadata.challengeSide,
    intent: metadata.challengeIntent,
    evidence: metadata.challengeExecutionEvidence,
  });

  const stageScores = record.metadata?.stageScores as
    | Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] }>
    | undefined;
  const planCritique = record.metadata?.planCritique as PlanCritique | undefined;
  attachStageOutcomes(record, stageScores, planCritique);
}
