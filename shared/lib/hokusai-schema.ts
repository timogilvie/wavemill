/**
 * Hokusai model input and output schema adapters.
 *
 * Maps wavemill task descriptors plus repo metadata into the structured
 * Hokusai input shape expected by downstream model selection logic,
 * and converts Hokusai output back to WorkflowRouteDecision.
 *
 * @module hokusai-schema
 */

import type {
  EvalRecord,
  EligibilityErrorCode,
  RepoContext,
  RouteCalibration,
  RoutePrediction,
  RoutingCandidate,
  RoutingDecision,
  TaskDescriptor,
} from './eval-schema.ts';
import { isEvalSuccess } from './eval-success-policy.ts';
import { evaluateEvidenceEligibility } from './model-evidence-policy.ts';
import { estimateTokensDefault } from './model-adapters/token-estimator.ts';

// ============================================================================
// Input Schema Types
// ============================================================================

export type HokusaiTaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'infra'
  | 'tests'
  | 'migration'
  | 'docs'
  | 'unknown';

export type HokusaiLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'rust'
  | 'java'
  | 'bash'
  | 'multi'
  | 'unknown';

export type HokusaiDomain =
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'devops'
  | 'data'
  | 'ml'
  | 'mobile'
  | 'unknown';

export type HokusaiRepoSizeBucket = 'small' | 'medium' | 'large' | 'xlarge';
export type HokusaiFilesTouchedBucket = '1' | '2_5' | '6_15' | '16_plus';
export type HokusaiDescriptionLengthBucket = 'short' | 'medium' | 'long';
export type HokusaiRiskLevel = 'low' | 'medium' | 'high';

export interface HokusaiTaskDescriptor {
  task_type: HokusaiTaskType;
  language: HokusaiLanguage;
  domain: HokusaiDomain;
  complexity: number;
  repo_size_bucket: HokusaiRepoSizeBucket;
  files_touched_bucket: HokusaiFilesTouchedBucket;
  description_length_bucket: HokusaiDescriptionLengthBucket;
  is_greenfield: boolean;
  is_migration: boolean;
  requires_tests: boolean;
  cross_service: boolean;
  ui_heavy: boolean;
  risk_level: HokusaiRiskLevel;
}

export interface HokusaiConstraints {
  max_cost_usd: number;
}

export interface HokusaiAvailableModels {
  planner_models: string[];
  coder_models: string[];
  reviewer_models: string[];
}

export interface HokusaiInput {
  schema_version: string;
  task_id: string;
  task_descriptor: HokusaiTaskDescriptor;
  constraints: HokusaiConstraints;
  available_models: HokusaiAvailableModels;
}

export interface HokusaiBooleanFlags {
  is_greenfield: boolean;
  is_migration: boolean;
  requires_tests: boolean;
  cross_service: boolean;
  ui_heavy: boolean;
}

export interface HokusaiInputOverrides {
  maxCostUsd?: number;
  max_cost_usd?: number;
  modelsAvailable?: string[];
  availableModels?: string[];
  plannerModels?: string[];
  coderModels?: string[];
  reviewerModels?: string[];
}

export type HokusaiModel30TaskType =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'research'
  | 'maintenance';

export type HokusaiModel30Objective =
  | 'lowest_cost'
  | 'fastest_completion'
  | 'highest_reliability';

export type HokusaiModel30WorkflowStage = 'plan' | 'code' | 'review';
export type HokusaiModel30RiskLevel = 'low' | 'medium' | 'high';
export type HokusaiModel30EstimatedComplexity = 'low' | 'medium' | 'high';
export type HokusaiModel30Depth = 'low' | 'medium' | 'high';
export type HokusaiModel30ReviewMode = 'light' | 'standard' | 'deep';

export interface HokusaiModel30TaskInput {
  description: string;
  task_type: HokusaiModel30TaskType;
}

export interface HokusaiModel30Routing {
  available_models?: string[];
  available_planner_models?: string[];
  available_coder_models?: string[];
  available_reviewer_models?: string[];
  max_cost_usd?: number;
  objective?: HokusaiModel30Objective;
}

export interface HokusaiModel30Context {
  domain?: Exclude<HokusaiDomain, 'unknown'>;
  repo_size_bucket?: HokusaiRepoSizeBucket;
  requires_tests?: boolean;
  risk_level?: HokusaiModel30RiskLevel;
  file_count?: number;
  estimated_complexity?: HokusaiModel30EstimatedComplexity;
  security_sensitive?: boolean;
}

export interface HokusaiModel30Workflow {
  stages?: HokusaiModel30WorkflowStage[];
}

export interface HokusaiModel30Metadata {
  external_task_id?: string;
  run_id?: string;
  integration_version?: string;
  idempotency_key?: string;
}

export interface HokusaiModel30Inputs {
  task: HokusaiModel30TaskInput;
  routing?: HokusaiModel30Routing;
  context?: HokusaiModel30Context;
  workflow?: HokusaiModel30Workflow;
  metadata?: HokusaiModel30Metadata;
}

export interface HokusaiModel30Request {
  inputs: HokusaiModel30Inputs;
}

export interface HokusaiModel30StrategyAlternative {
  [key: string]: unknown;
}

export interface HokusaiModel30Tradeoff {
  [key: string]: unknown;
}

export interface HokusaiModel30NearestNeighbor {
  [key: string]: unknown;
}

export interface HokusaiRecommendedStrategy {
  planner_model: string;
  coder_model: string;
  reviewer_model: string;
  objective?: HokusaiModel30Objective | string;
  stages?: HokusaiModel30WorkflowStage[];
  estimated_success_under_budget?: number;
  estimated_cost_usd?: number;
  estimated_duration_seconds?: number;
  confidence?: number;
  rationale?: string;
  plan_depth?: HokusaiModel30Depth;
  code_depth?: HokusaiModel30Depth;
  review_mode?: HokusaiModel30ReviewMode;
}

export interface HokusaiModel30Predictions {
  recommended_strategy: HokusaiRecommendedStrategy;
  alternatives?: HokusaiModel30StrategyAlternative[];
  tradeoffs?: HokusaiModel30Tradeoff[];
  nearest_neighbors?: HokusaiModel30NearestNeighbor[];
}

export interface HokusaiModel30ResponseMetadata {
  request_id?: string;
  inference_log_id?: string;
  [key: string]: unknown;
}

export interface HokusaiModel30Response {
  predictions: HokusaiModel30Predictions;
  metadata?: HokusaiModel30ResponseMetadata;
}

export interface HokusaiModel30RequestOptions extends HokusaiInputOverrides {
  description?: string;
  externalTaskId?: string;
  runId?: string;
  integrationVersion?: string;
  idempotencyKey?: string;
  objective?: HokusaiModel30Objective | string;
  workflowStages?: string[];
}

// ============================================================================
// Output Schema Types
// ============================================================================

export type HokusaiPlanDepth = 'low' | 'medium' | 'high';
export type HokusaiCodeDepth = 'low' | 'medium' | 'high';
export type HokusaiReviewMode = 'light' | 'standard' | 'deep';

export interface HokusaiRoute {
  planner_model: string;
  coder_model: string;
  reviewer_model: string;
  plan_depth: HokusaiPlanDepth;
  code_depth: HokusaiCodeDepth;
  review_mode: HokusaiReviewMode;
}

export interface HokusaiPredictions {
  expected_success_probability: number;
  expected_cost_usd: number;
  confidence: number;
}

export interface HokusaiOutput {
  schema_version: string;
  route: HokusaiRoute;
  predictions: HokusaiPredictions;
}

// ============================================================================
// Submission Schema Types
// ============================================================================

export interface HokusaiSubmissionRoutes {
  planner_model: string;
  coder_model: string;
  reviewer_model: string;
}

export interface HokusaiSubmissionOutcomes {
  completed_successfully: boolean;
  actual_cost_usd: number | null;
  /**
   * Coder-model execution latency in seconds, sourced from the eval record's
   * `phaseDurationsSeconds.coding`. Null when no valid coding duration exists —
   * never total workflow elapsed time, which includes queue/idle waits
   * uncorrelated with model performance (HOK-2895).
   */
  actual_time_seconds: number | null;
  intervention_count: number;
}

export interface HokusaiSubmissionRubricSignals {
  rubric_version: string;
  criterion_count: number;
  mean_score: number;
  criteria_scores: {
    completeness: number;
    correctness: number;
    code_quality: number;
    intervention_impact: number;
    autonomy: number;
  };
  determinative_boundary?: string;
  rubric_provenance?: string;
}

export interface HokusaiSubmission {
  schema_version?: string;
  run_id: string;
  task_id: string;
  constraints: { max_cost_usd: number | null };
  route_taken: HokusaiSubmissionRoutes;
  observed_outcomes: HokusaiSubmissionOutcomes;
  rubric_signals?: HokusaiSubmissionRubricSignals;
  route_prediction?: RoutePrediction;
  route_calibration?: RouteCalibration;
}

export type HokusaiSubmissionResult =
  | { ok: true; submission: HokusaiSubmission }
  | { ok: false; reasons: string[] };

// ============================================================================
// Input Schema Adapters
// ============================================================================

const COMPLEXITY_MAP: Record<number, number> = {
  1: 1,
  2: 3,
  3: 5,
  4: 7,
  5: 9,
};

const HIGH_RISK_FLAGS = new Set([
  'schema-migration',
  'modifies-existing-runtime',
  'cross-service',
  'large-scope-refactor',
]);

const MEDIUM_RISK_FLAGS = new Set([
  'rsc-serialization',
  'test-infrastructure',
]);

function normalizeLanguageValue(language: string | undefined): HokusaiLanguage | 'unknown-language' {
  const lower = (language || '').trim().toLowerCase();

  if (lower === 'python' || lower === 'py') return 'python';
  if (lower === 'typescript' || lower === 'ts' || lower === 'tsx') return 'typescript';
  if (lower === 'javascript' || lower === 'js' || lower === 'jsx') return 'javascript';
  if (lower === 'go' || lower === 'golang') return 'go';
  if (lower === 'rust' || lower === 'rs') return 'rust';
  if (lower === 'java') return 'java';
  if (lower === 'bash' || lower === 'sh' || lower === 'shell' || lower === 'zsh') return 'bash';

  return lower.length > 0 ? 'unknown-language' : 'unknown';
}

/**
 * Maps wavemill complexity (1-5) to Hokusai complexity score (1-10 scale).
 *
 * @param complexity - Wavemill complexity value (1-5)
 * @returns Hokusai complexity score (1=xs, 3=s, 5=m, 7=l, 9=xl), defaults to 5 if invalid
 */
export function complexityToHokusaiScore(complexity: number | undefined): number {
  if (typeof complexity !== 'number' || !Number.isFinite(complexity)) {
    return 5;
  }

  return COMPLEXITY_MAP[Math.round(complexity)] || 5;
}

/**
 * Maps repository lines of code to a size bucket.
 *
 * @param loc - Lines of code in the repository
 * @returns Size bucket: 'small' (<5K), 'medium' (5K-50K), 'large' (50K-500K), 'xlarge' (≥500K), defaults to 'medium' if invalid
 */
export function repoSizeToBucket(loc: number | undefined): HokusaiRepoSizeBucket {
  if (typeof loc !== 'number' || !Number.isFinite(loc) || loc < 0) {
    return 'medium';
  }

  if (loc < 5_000) return 'small';
  if (loc < 50_000) return 'medium';
  if (loc < 500_000) return 'large';
  return 'xlarge';
}

/**
 * Maps number of files touched to a bucket.
 *
 * @param count - Number of files touched in the task
 * @returns Files bucket: '1' (1 file), '2_5' (2-5 files), '6_15' (6-15 files), '16_plus' (≥16 files), defaults to '2_5' if invalid
 */
export function filesTouchedToBucket(count: number | undefined): HokusaiFilesTouchedBucket {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return '2_5';
  }

  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 15) return '6_15';
  return '16_plus';
}

/**
 * Maps task description length to a bucket.
 *
 * @param value - Either token count (number) or raw text (string, estimated as chars/4)
 * @returns Length bucket: 'short' (<50 tokens), 'medium' (50-200 tokens), 'long' (≥200 tokens), defaults to 'medium' if invalid
 */
export function descriptionLengthToBucket(
  value: number | string | undefined,
): HokusaiDescriptionLengthBucket {
  let tokenCount: number | undefined;

  if (typeof value === 'number' && Number.isFinite(value)) {
    tokenCount = value;
  } else if (typeof value === 'string') {
    tokenCount = estimateTokensDefault(value);
  }

  if (typeof tokenCount !== 'number' || tokenCount < 0) {
    return 'medium';
  }

  if (tokenCount < 50) return 'short';
  if (tokenCount < 200) return 'medium';
  return 'long';
}

/**
 * Determines overall risk level from risk flag array.
 *
 * @param flags - Array of risk flag strings (e.g., 'schema-migration', 'cross-service')
 * @returns Risk level: 'high' (≥2 high-risk flags), 'medium' (≥1 high-risk or ≥2 medium-risk flags), 'low' (default)
 */
export function riskFlagsToLevel(flags: string[] | undefined): HokusaiRiskLevel {
  if (!Array.isArray(flags) || flags.length === 0) {
    return 'low';
  }

  let highCount = 0;
  let mediumCount = 0;

  for (const flag of flags) {
    if (HIGH_RISK_FLAGS.has(flag)) {
      highCount += 1;
    } else if (MEDIUM_RISK_FLAGS.has(flag)) {
      mediumCount += 1;
    }
  }

  if (highCount >= 2) return 'high';
  if (highCount >= 1 || mediumCount >= 2) return 'medium';
  return 'low';
}

/**
 * Maps risk flags to boolean feature flags.
 *
 * @param flags - Array of risk flag strings
 * @returns Object with boolean flags: is_greenfield, is_migration, requires_tests, cross_service, ui_heavy
 */
export function riskFlagsToBooleans(flags: string[] | undefined): HokusaiBooleanFlags {
  const set = new Set(flags || []);

  return {
    is_greenfield: false,
    is_migration: set.has('schema-migration'),
    requires_tests: set.has('test-infrastructure'),
    cross_service: set.has('cross-service'),
    ui_heavy: set.has('rsc-serialization'),
  };
}

/**
 * Maps wavemill task type to Hokusai task type.
 *
 * @param taskType - Task type string from wavemill descriptor
 * @param options - Optional configuration, including hasMigration override
 * @returns Hokusai task type: 'bugfix', 'feature', 'refactor', 'infra', 'tests', 'migration', 'docs', or 'unknown'
 */
export function mapTaskType(
  taskType: string | undefined,
  options?: { hasMigration?: boolean },
): HokusaiTaskType {
  if (options?.hasMigration) {
    return 'migration';
  }

  switch ((taskType || '').trim().toLowerCase()) {
    case 'bugfix':
      return 'bugfix';
    case 'feature':
      return 'feature';
    case 'refactor':
      return 'refactor';
    case 'infra':
      return 'infra';
    case 'docs':
      return 'docs';
    case 'test':
    case 'tests':
      return 'tests';
    default:
      return 'unknown';
  }
}

/**
 * Maps wavemill domain to Hokusai domain.
 *
 * @param domain - Domain string from wavemill descriptor
 * @returns Hokusai domain: 'backend', 'frontend', 'fullstack', 'devops', 'data', 'ml', 'mobile', or 'unknown'
 */
export function mapDomain(domain: string | undefined): HokusaiDomain {
  switch ((domain || '').trim().toLowerCase()) {
    case 'backend':
      return 'backend';
    case 'frontend':
      return 'frontend';
    case 'full-stack':
    case 'fullstack':
      return 'fullstack';
    case 'infrastructure':
    case 'devtools':
    case 'devops':
      return 'devops';
    case 'data-pipeline':
    case 'data':
      return 'data';
    case 'ml':
      return 'ml';
    case 'mobile':
      return 'mobile';
    default:
      return 'unknown';
  }
}

/**
 * Maps language array to Hokusai language (with multi-language detection).
 *
 * @param languages - Array of language strings from wavemill descriptor
 * @param primaryLanguage - Optional primary language fallback from repo context
 * @returns Hokusai language: specific language name, 'multi' (if >1 language), or 'unknown'
 */
export function mapLanguage(languages: string[] | undefined, primaryLanguage?: string): HokusaiLanguage {
  const normalized = new Set<HokusaiLanguage>();

  for (const language of languages || []) {
    const mapped = normalizeLanguageValue(language);
    if (mapped !== 'unknown-language' && mapped !== 'unknown') {
      normalized.add(mapped);
    }
  }

  if (normalized.size > 1) {
    return 'multi';
  }

  if (normalized.size === 1) {
    return [...normalized][0];
  }

  const primary = normalizeLanguageValue(primaryLanguage);
  if (primary !== 'unknown-language') {
    return primary;
  }

  return 'unknown';
}

function pickAvailableModels(
  descriptor: Partial<TaskDescriptor> | undefined,
  overrides?: HokusaiInputOverrides,
): HokusaiAvailableModels {
  const sharedModels =
    overrides?.availableModels
    || overrides?.modelsAvailable
    || descriptor?.constraints?.models_available
    || [];

  const pickStageModels = (models: string[] | undefined): string[] =>
    models && models.length > 0 ? models : sharedModels;

  return {
    planner_models: pickStageModels(overrides?.plannerModels),
    coder_models: pickStageModels(overrides?.coderModels),
    reviewer_models: pickStageModels(overrides?.reviewerModels),
  };
}

function pickNonEmptyStrings(values: string[] | undefined): string[] | undefined {
  const filtered = values?.filter((value) => typeof value === 'string' && value.trim().length > 0);
  return filtered && filtered.length > 0 ? filtered : undefined;
}

function isModel30Objective(value: string | undefined): value is HokusaiModel30Objective {
  return value === 'lowest_cost' || value === 'fastest_completion' || value === 'highest_reliability';
}

function isModel30WorkflowStage(value: string): value is HokusaiModel30WorkflowStage {
  return value === 'plan' || value === 'code' || value === 'review';
}

function inferResearchTask(description: string): boolean {
  return /\b(research|investigate|explore|spike|evaluate|compare|analysis)\b/i.test(description);
}

export function mapTaskTypeToModel30(
  taskType: string | undefined,
  options: { hasMigration?: boolean; description?: string } = {},
): HokusaiModel30TaskType {
  const normalized = (taskType || '').trim().toLowerCase();
  const description = options.description?.trim() || '';
  const inferredResearch = inferResearchTask(description);

  if (normalized === 'research' || inferredResearch) return 'research';

  if (normalized === 'bugfix') return 'bugfix';
  if (normalized === 'feature') return 'feature';
  if (normalized === 'refactor') return 'refactor';
  if (normalized === 'docs' || normalized === 'test' || normalized === 'tests' || normalized === 'infra' || normalized === 'chore' || options.hasMigration) {
    return 'maintenance';
  }

  return 'feature';
}

function normalizeWorkflowStages(stages: string[] | undefined): HokusaiModel30WorkflowStage[] | undefined {
  const filtered = stages?.filter((stage): stage is HokusaiModel30WorkflowStage => isModel30WorkflowStage(stage));
  return filtered && filtered.length > 0 ? filtered : undefined;
}

function mapEstimatedComplexity(complexity: number | undefined): HokusaiModel30EstimatedComplexity | undefined {
  if (typeof complexity !== 'number' || !Number.isFinite(complexity)) {
    return undefined;
  }
  if (complexity >= 4) return 'high';
  if (complexity >= 2) return 'medium';
  return 'low';
}

function inferSecuritySensitive(
  description: string,
  riskFlags: string[] | undefined,
): boolean | undefined {
  if (Array.isArray(riskFlags) && riskFlags.some((flag) =>
    flag.includes('auth') || flag.includes('security') || flag.includes('payment')
  )) {
    return true;
  }
  if (/\b(auth|security|token|secret|credential|payment|permission|oauth)\b/i.test(description)) {
    return true;
  }
  return undefined;
}

function resolveHokusaiDescription(
  descriptor: Partial<TaskDescriptor> | undefined,
  description: string | undefined,
): string {
  const explicit = description?.trim();
  if (explicit) {
    return explicit;
  }

  const tokenEstimate = descriptor?.signals?.heuristic?.description_tokens;
  if (typeof tokenEstimate === 'number' && tokenEstimate > 0) {
    return `Task requiring approximately ${tokenEstimate} tokens of implementation context.`;
  }

  throw new Error('Hokusai Model 30 request requires a non-empty task description');
}

function resolveChosenCandidate(
  decision?: RoutingDecision,
): RoutingCandidate | undefined {
  if (!decision) {
    return undefined;
  }

  if (typeof decision.chosen === 'number') {
    return decision.candidates[decision.chosen];
  }

  return decision.chosen;
}

function extractRoutes(record: EvalRecord): HokusaiSubmissionRoutes | null {
  const stages = record.taskDescriptor?.stages;
  const plannerModel = stages?.planner?.model;
  const coderModel = stages?.coder?.model;
  const reviewerModel = stages?.reviewer?.model;

  if (plannerModel && coderModel && reviewerModel) {
    return {
      planner_model: plannerModel,
      coder_model: coderModel,
      reviewer_model: reviewerModel,
    };
  }

  const chosenCandidate = resolveChosenCandidate(record.routingDecision);
  if (chosenCandidate?.modelId) {
    return {
      planner_model: chosenCandidate.modelId,
      coder_model: chosenCandidate.modelId,
      reviewer_model: chosenCandidate.modelId,
    };
  }

  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueSortedCodes<T extends string>(codes: T[]): T[] {
  return [...new Set(codes)].sort();
}

function filterEligibilityReasons(
  record: EvalRecord,
  allowed: readonly EligibilityErrorCode[],
  fallback: EligibilityErrorCode,
): EligibilityErrorCode[] {
  const allowedSet = new Set<EligibilityErrorCode>(allowed);
  const reasons = record.eligibilityErrors?.filter((code) => allowedSet.has(code)) ?? [];
  return reasons.length > 0 ? uniqueSortedCodes(reasons) : [fallback];
}

function extractRubricSignals(record: EvalRecord): HokusaiSubmissionRubricSignals | undefined {
  const rubric = record.taskDescriptor?.rubric;

  if (!rubric?.has_rubric) {
    return undefined;
  }

  return {
    rubric_version: record.rubricEval?.rubric_version ?? 'unknown',
    criterion_count: rubric.criterion_count,
    mean_score: rubric.mean_score,
    criteria_scores: {
      completeness: rubric.criteria_scores.completeness,
      correctness: rubric.criteria_scores.correctness,
      code_quality: rubric.criteria_scores.code_quality,
      intervention_impact: rubric.criteria_scores.intervention_impact,
      autonomy: rubric.criteria_scores.autonomy,
    },
    ...(rubric.determinative_boundary && {
      determinative_boundary: rubric.determinative_boundary,
    }),
    ...(record.rubric_provenance && {
      rubric_provenance: record.rubric_provenance,
    }),
  };
}

function extractRoutePrediction(record: EvalRecord): RoutePrediction | undefined {
  return record.routePrediction;
}

function extractRouteCalibration(record: EvalRecord): RouteCalibration | undefined {
  return record.routeCalibration;
}

/**
 * Converts an eval result into the Hokusai training/submission schema.
 *
 * Returns structured failure reasons when the record does not contain the
 * required identifiers, routing details, or observed outcome data needed for
 * a complete submission.
 */
export function toHokusaiSubmission(
  record: EvalRecord,
): HokusaiSubmissionResult {
  const evidence = evaluateEvidenceEligibility(record, 'hokusai_contribution', { strict: true });
  if (!evidence.eligible) {
    return { ok: false, reasons: evidence.reasons as EligibilityErrorCode[] };
  }

  if (record.trainingEligible === false) {
    const reasons = uniqueSortedCodes(record.eligibilityErrors ?? []);
    return {
      ok: false,
      reasons: reasons.length > 0
        ? reasons
        : [record.nonRewardReason?.code ?? 'training_ineligible_unspecified'],
    };
  }

  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.issueId)) {
    return { ok: false, reasons: ['missing_model_identity'] };
  }

  const routeTaken = extractRoutes(record);
  if (!routeTaken) {
    return {
      ok: false,
      reasons: filterEligibilityReasons(record, ['missing_routing'], 'missing_routing'),
    };
  }

  const actualCostUsd =
    typeof record.workflowCost === 'number'
    && Number.isFinite(record.workflowCost)
    && record.workflowCost >= 0
      ? record.workflowCost
      : null;

  // Latency is attributed to the coder model, so only the coding-phase
  // duration qualifies. `record.timeSeconds` is total elapsed time dominated
  // by queue/idle waits (observed ~96x inflation, HOK-2895) and must never be
  // used as a fallback; missing latency beats systematically false latency.
  const codingSeconds = record.phaseDurationsSeconds?.coding;
  const actualTimeSeconds =
    typeof codingSeconds === 'number'
    && Number.isFinite(codingSeconds)
    && codingSeconds >= 0
      ? codingSeconds
      : null;

  const rubricSignals = extractRubricSignals(record);
  const routePrediction = extractRoutePrediction(record);
  const routeCalibration = extractRouteCalibration(record);
  const schemaVersion = routePrediction || routeCalibration
    ? '1.2'
    : rubricSignals
      ? '1.1'
      : '1.0';

  return {
    ok: true,
    submission: {
      schema_version: schemaVersion,
      run_id: record.id,
      task_id: record.issueId,
      constraints: {
        max_cost_usd:
          record.constraints?.maxCostUsd
          ?? record.taskDescriptor?.constraints?.max_cost_usd
          ?? null,
      },
      route_taken: routeTaken,
      observed_outcomes: {
        completed_successfully: isEvalSuccess(record),
        actual_cost_usd: actualCostUsd,
        actual_time_seconds: actualTimeSeconds,
        intervention_count: record.interventionCount ?? 0,
      },
      ...(rubricSignals && { rubric_signals: rubricSignals }),
      ...(routePrediction && { route_prediction: routePrediction }),
      ...(routeCalibration && { route_calibration: routeCalibration }),
    },
  };
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBoundedFiniteNumber(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && value <= 1;
}

/**
 * Validates a Hokusai submission object and reports all field errors found.
 */
export function validateHokusaiSubmission(
  submission: HokusaiSubmission,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (
    submission.schema_version !== undefined
    && submission.schema_version !== '1.0'
    && submission.schema_version !== '1.1'
    && submission.schema_version !== '1.2'
  ) {
    errors.push('schema_version must be "1.0", "1.1", or "1.2"');
  }

  if (!isNonEmptyString(submission.run_id)) {
    errors.push('run_id must be a non-empty string');
  }

  if (!isNonEmptyString(submission.task_id)) {
    errors.push('task_id must be a non-empty string');
  }

  if (!isNonEmptyString(submission.route_taken?.planner_model)) {
    errors.push('route_taken.planner_model must be a non-empty string');
  }

  if (!isNonEmptyString(submission.route_taken?.coder_model)) {
    errors.push('route_taken.coder_model must be a non-empty string');
  }

  if (!isNonEmptyString(submission.route_taken?.reviewer_model)) {
    errors.push('route_taken.reviewer_model must be a non-empty string');
  }

  if (
    typeof submission.observed_outcomes?.completed_successfully !== 'boolean'
  ) {
    errors.push(
      'observed_outcomes.completed_successfully must be a boolean',
    );
  }

  if (
    submission.observed_outcomes?.actual_cost_usd !== null
    && !isNonNegativeFiniteNumber(submission.observed_outcomes?.actual_cost_usd)
  ) {
    errors.push(
      'observed_outcomes.actual_cost_usd must be null or a non-negative number',
    );
  }

  if (
    submission.observed_outcomes?.actual_time_seconds !== null
    && !isNonNegativeFiniteNumber(submission.observed_outcomes?.actual_time_seconds)
  ) {
    errors.push(
      'observed_outcomes.actual_time_seconds must be null or a non-negative number',
    );
  }

  if (
    typeof submission.observed_outcomes?.intervention_count !== 'number'
    || !Number.isInteger(submission.observed_outcomes.intervention_count)
    || submission.observed_outcomes.intervention_count < 0
  ) {
    errors.push(
      'observed_outcomes.intervention_count must be a non-negative integer',
    );
  }

  if (
    submission.constraints?.max_cost_usd !== null
    && (
      typeof submission.constraints?.max_cost_usd !== 'number'
      || !Number.isFinite(submission.constraints.max_cost_usd)
      || submission.constraints.max_cost_usd < 0
    )
  ) {
    errors.push('constraints.max_cost_usd must be null or a non-negative number');
  }

  if (submission.rubric_signals) {
    const rubric = submission.rubric_signals;

    if (!isNonEmptyString(rubric.rubric_version)) {
      errors.push('rubric_signals.rubric_version must be a non-empty string');
    }

    if (!isNonNegativeFiniteNumber(rubric.criterion_count)) {
      errors.push('rubric_signals.criterion_count must be a non-negative number');
    }

    if (!isNonNegativeFiniteNumber(rubric.mean_score)) {
      errors.push('rubric_signals.mean_score must be a non-negative number');
    }

    const criteriaScores = rubric.criteria_scores;
    const criteriaScoreKeys = [
      'completeness',
      'correctness',
      'code_quality',
      'intervention_impact',
      'autonomy',
    ] as const;

    for (const key of criteriaScoreKeys) {
      if (!isBoundedFiniteNumber(criteriaScores?.[key])) {
        errors.push(`rubric_signals.criteria_scores.${key} must be a number between 0 and 1`);
      }
    }
  }

  if (submission.route_prediction) {
    if (
      submission.route_prediction.expectedSuccess !== undefined
      && !isBoundedFiniteNumber(submission.route_prediction.expectedSuccess)
    ) {
      errors.push('route_prediction.expectedSuccess must be a number between 0 and 1');
    }
    if (
      submission.route_prediction.expectedCostUsd !== undefined
      && !isNonNegativeFiniteNumber(submission.route_prediction.expectedCostUsd)
    ) {
      errors.push('route_prediction.expectedCostUsd must be a non-negative number');
    }
    if (
      submission.route_prediction.confidence !== undefined
      && !isBoundedFiniteNumber(submission.route_prediction.confidence)
    ) {
      errors.push('route_prediction.confidence must be a number between 0 and 1');
    }
    if (
      submission.route_prediction.riskScore !== undefined
      && !isNonNegativeFiniteNumber(submission.route_prediction.riskScore)
    ) {
      errors.push('route_prediction.riskScore must be a non-negative number');
    }
  }

  if (submission.route_calibration) {
    if (
      submission.route_calibration.predictedSuccess !== undefined
      && !isBoundedFiniteNumber(submission.route_calibration.predictedSuccess)
    ) {
      errors.push('route_calibration.predictedSuccess must be a number between 0 and 1');
    }
    if (
      submission.route_calibration.predictedCostUsd !== undefined
      && !isNonNegativeFiniteNumber(submission.route_calibration.predictedCostUsd)
    ) {
      errors.push('route_calibration.predictedCostUsd must be a non-negative number');
    }
    if (
      submission.route_calibration.actualCostUsd !== undefined
      && !isNonNegativeFiniteNumber(submission.route_calibration.actualCostUsd)
    ) {
      errors.push('route_calibration.actualCostUsd must be a non-negative number');
    }
    if (
      submission.route_calibration.durationMs !== undefined
      && !isNonNegativeFiniteNumber(submission.route_calibration.durationMs)
    ) {
      errors.push('route_calibration.durationMs must be a non-negative number');
    }
    if (
      submission.route_calibration.interventionCount !== undefined
      && (
        !Number.isInteger(submission.route_calibration.interventionCount)
        || submission.route_calibration.interventionCount < 0
      )
    ) {
      errors.push('route_calibration.interventionCount must be a non-negative integer');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Converts wavemill TaskDescriptor + RepoContext to Hokusai model input schema.
 *
 * @param descriptor - Partial wavemill task descriptor with heuristic and learned signals
 * @param repoContext - Optional repository context (size, primary language)
 * @param overrides - Optional constraint/model overrides (max_cost_usd, available_models)
 * @param taskId - Task identifier, defaults to 'unknown'
 * @returns Complete HokusaiInput object with all required fields populated
 */
export function toHokusaiInput(
  descriptor?: Partial<TaskDescriptor>,
  repoContext?: RepoContext,
  overrides?: HokusaiInputOverrides,
  taskId = 'unknown',
): HokusaiInput {
  const heuristic = descriptor?.signals?.heuristic;
  const learned = descriptor?.signals?.learned;
  const riskBooleans = riskFlagsToBooleans(learned?.risk_flags);
  const effectiveRepoContext = repoContext;
  const isMigration = Boolean(heuristic?.has_migration ?? riskBooleans.is_migration);

  return {
    schema_version: '1.0',
    task_id: taskId,
    task_descriptor: {
      task_type: mapTaskType(heuristic?.task_type, { hasMigration: isMigration }),
      language: mapLanguage(heuristic?.languages, effectiveRepoContext?.primaryLanguage),
      domain: mapDomain(learned?.domain),
      complexity: complexityToHokusaiScore(learned?.complexity),
      repo_size_bucket: repoSizeToBucket(
        heuristic?.repo_size_loc ?? effectiveRepoContext?.repoSize?.loc,
      ),
      files_touched_bucket: filesTouchedToBucket(heuristic?.files_touched),
      description_length_bucket: descriptionLengthToBucket(heuristic?.description_tokens),
      is_greenfield: Boolean(heuristic?.is_greenfield ?? riskBooleans.is_greenfield),
      is_migration: isMigration,
      requires_tests: Boolean(heuristic?.has_tests ?? riskBooleans.requires_tests),
      cross_service: Boolean(heuristic?.cross_service ?? riskBooleans.cross_service),
      ui_heavy: Boolean(heuristic?.has_ui ?? riskBooleans.ui_heavy),
      risk_level: riskFlagsToLevel(learned?.risk_flags),
    },
    constraints: {
      max_cost_usd:
        overrides?.max_cost_usd
        ?? overrides?.maxCostUsd
        ?? descriptor?.constraints?.max_cost_usd
        ?? 0,
    },
    available_models: pickAvailableModels(descriptor, overrides),
  };
}

export function toHokusaiModel30Request(
  descriptor?: Partial<TaskDescriptor>,
  repoContext?: RepoContext,
  options: HokusaiModel30RequestOptions = {},
): HokusaiModel30Request {
  const heuristic = descriptor?.signals?.heuristic;
  const learned = descriptor?.signals?.learned;
  const riskFlags = learned?.risk_flags;
  const description = resolveHokusaiDescription(descriptor, options.description);
  const isMigration = Boolean(heuristic?.has_migration || riskFlagsToBooleans(riskFlags).is_migration);
  const sharedModels = pickNonEmptyStrings(
    options.availableModels
    ?? options.modelsAvailable
    ?? descriptor?.constraints?.models_available,
  );
  const plannerModels = pickNonEmptyStrings(options.plannerModels) ?? sharedModels;
  const coderModels = pickNonEmptyStrings(options.coderModels) ?? sharedModels;
  const reviewerModels = pickNonEmptyStrings(options.reviewerModels) ?? sharedModels;
  const routing: HokusaiModel30Routing = {};
  const workflowStages = normalizeWorkflowStages(options.workflowStages);
  const domain = mapDomain(learned?.domain);
  const effectiveFileCount = heuristic?.files_touched;
  const context: HokusaiModel30Context = {};
  const metadata: HokusaiModel30Metadata = {};

  if (sharedModels) {
    routing.available_models = sharedModels;
  }
  if (plannerModels) {
    routing.available_planner_models = plannerModels;
  }
  if (coderModels) {
    routing.available_coder_models = coderModels;
  }
  if (reviewerModels) {
    routing.available_reviewer_models = reviewerModels;
  }

  const maxCostUsd = options.maxCostUsd ?? options.max_cost_usd ?? descriptor?.constraints?.max_cost_usd;
  if (typeof maxCostUsd === 'number' && Number.isFinite(maxCostUsd) && maxCostUsd >= 0) {
    routing.max_cost_usd = maxCostUsd;
  }

  if (isModel30Objective(options.objective)) {
    routing.objective = options.objective;
  }

  if (domain !== 'unknown') {
    context.domain = domain;
  }

  const repoSizeBucket = repoSizeToBucket(heuristic?.repo_size_loc ?? repoContext?.repoSize?.loc);
  if (repoSizeBucket) {
    context.repo_size_bucket = repoSizeBucket;
  }

  if (typeof (heuristic?.has_tests) === 'boolean') {
    context.requires_tests = heuristic.has_tests;
  }

  context.risk_level = riskFlagsToLevel(riskFlags);

  if (typeof effectiveFileCount === 'number' && Number.isFinite(effectiveFileCount) && effectiveFileCount >= 0) {
    context.file_count = effectiveFileCount;
  } else if (typeof repoContext?.repoSize?.fileCount === 'number' && Number.isFinite(repoContext.repoSize.fileCount) && repoContext.repoSize.fileCount >= 0) {
    context.file_count = repoContext.repoSize.fileCount;
  }

  const estimatedComplexity = mapEstimatedComplexity(learned?.complexity);
  if (estimatedComplexity) {
    context.estimated_complexity = estimatedComplexity;
  }

  const securitySensitive = inferSecuritySensitive(description, riskFlags);
  if (typeof securitySensitive === 'boolean') {
    context.security_sensitive = securitySensitive;
  }

  if (options.externalTaskId?.trim()) {
    metadata.external_task_id = options.externalTaskId.trim();
  }
  if (options.runId?.trim()) {
    metadata.run_id = options.runId.trim();
  }
  if (options.integrationVersion?.trim()) {
    metadata.integration_version = options.integrationVersion.trim();
  }
  if (options.idempotencyKey?.trim()) {
    metadata.idempotency_key = options.idempotencyKey.trim();
  }

  return {
    inputs: {
      task: {
        description,
        task_type: mapTaskTypeToModel30(heuristic?.task_type, { hasMigration: isMigration, description }),
      },
      ...(Object.keys(routing).length > 0 ? { routing } : {}),
      ...(Object.keys(context).length > 0 ? { context } : {}),
      ...(workflowStages ? { workflow: { stages: workflowStages } } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}
