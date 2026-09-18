/**
 * Workflow router — recommends planner/coder/reviewer models plus stage depth,
 * review mode, expected success, and heuristic cost estimates for a task.
 *
 * Extends the single-model router with stage-aware workflow decisions.
 *
 * @module workflow-router
 */

import { readFileSync } from 'node:fs';
import { buildEvalSummary, evaluateChallenge, type ChallengeRecommendation } from './challenge-scheduler.ts';
import { getBudgetConfig, getChallengeSchedulerConfig, getDifficultyClassifierConfig, getHokusaiRouterConfig, getRouterConfig, isRouterCapabilityFilteringEnabled, loadWavemillConfig } from './config.ts';
import { filterDeepSeekModels, type DeepSeekPoolFilterResult } from './deepseek-provider.ts';
import { filterOpenRouterModels, type OpenRouterPoolFilterResult } from './openrouter-provider.ts';
import { routeViaHokusai } from './hokusai-router.ts';
import { analyzePrompt, loadRouterConfig, recommendModel, resolveAgent, type PromptCharacteristics, type TaskType } from './model-router.ts';
import { CLASS_RANK, compareLatencyTier, getEffectiveRegistry, getLadder, hasCapabilityConstraints, isCodexChatgptLaunchEligible, isModelEnabled, type CapabilityConstraints, type LatencyTier, type RegistryTaskType } from './model-registry.ts';
import { readQuotaSnapshot, type QuotaSnapshot } from './quota-state.ts';
import {
  formatExplorationReasoning,
  recencyMultiplier,
  resolveExplorationConfig,
  sampleCandidateIndex,
  type ExplorationAttribution,
} from './router-exploration.ts';
import { resolveModel, viableCandidatesInPool } from './routing-policy.ts';
import { classifyTaskDifficulty, getAllowedModelFloor, type DifficultyFloor, type RoutingDifficulty } from './task-difficulty-classifier.ts';
import { loadPricingTable, computeModelCost } from './workflow-cost.ts';
import { loadConfiguredPricingTable } from './workflow-cost.ts';
import {
  routeStageAware,
  routeStageAwareWithContext,
  type StageAwareDecision,
  type StageAwareRouterContext,
} from './stage-aware-router.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import type { ModelClass } from './model-registry.ts';
import { policyAdjustmentLog, routerLog } from './router-log.ts';
import { registerAgentConfig } from './resource-adapters/agent-config-adapter.ts';
import { getHarnessId, recordUse } from './resource-manifest.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';
import type { RouteEscalationProvenance, RouteEscalationTrigger, RouteProvenance } from './route-artifact.ts';
import { filterDisabledModels, isDisabledModel } from './disabled-models.ts';
import { filterNativeModels, type RouterCertificationRejection } from './native-agent/certification/router-filter.ts';
import { applyModelExclusions, type ModelExclusionDiagnostic } from './model-exclusions.ts';
import { getGlobalModelRegistry, listEffectiveModelsForStage, resolveEffectiveAgent } from './effective-models.ts';
import { classifyTaskPacket, type TaskPacketClassification } from './task-packet-classifier.ts';

export type { RouterCertificationRejection } from './native-agent/certification/router-filter.ts';
export { STAGE_PHASE_REQUIREMENT } from './native-agent/certification/router-filter.ts';

const FILE_TYPE_PATTERN = /\.\b(ts|tsx|js|jsx|py|sh|json|yaml|yml|md|css|html|sql|go|rs|rb)\b/gi;

export type PlanDepth = 'light' | 'medium' | 'deep';
export type CodeDepth = 'light' | 'medium' | 'deep';
export type ReviewMode = 'none' | 'static' | 'llm' | 'static+llm';

export interface BudgetViolation {
  requestedCost: number;
  maxCostUsd: number;
  operatingMode: OperatingMode;
  attemptedDowngrade: boolean;
  cheapestViableOption: {
    planner: string;
    coder: string;
    reviewer: string;
    totalCost: number;
  } | null;
}

export interface WorkflowRouteDecision {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: PlanDepth;
  codeDepth: CodeDepth;
  reviewRecommended: ReviewMode;
  expectedSuccess: number;
  expectedCostPlan: number;
  expectedCostCode: number;
  expectedCostReview: number;
  confidence: number;
  reasoning: string[];
  signals: {
    taskType: TaskType;
    promptLength: PromptCharacteristics['length'];
    complexityScore: number;
    complexityBand?: string;
    riskFlags?: string[];
    suspiciousZero?: boolean;
    suspiciousZeroReason?: string;
    fileTypes: string[];
    riskScore: number;
    taskDifficulty?: RoutingDifficulty;
  };
  challengeRecommendation?: ChallengeRecommendation;
  constraints?: {
    maxCostUsd?: number;
  };
  maxCostUsd?: number | null;
  budgetViolation?: BudgetViolation;
  resourceSelections?: RuntimeResourceSelection[];
  provenance?: RouteProvenance;
  routingMode?: string;
  nativeCertificationRejections?: RouterCertificationRejection[];
  modelExclusions?: ModelExclusionDiagnostic[];
  harnessId?: string;
}

export interface RouteWorkflowOptions {
  repoDir?: string;
  modelsAvailable?: string[];
  plannerModelsAvailable?: string[];
  coderModelsAvailable?: string[];
  reviewerModelsAvailable?: string[];
  capabilityConstraints?: CapabilityConstraints;
  plannerCapabilityConstraints?: CapabilityConstraints;
  coderCapabilityConstraints?: CapabilityConstraints;
  reviewerCapabilityConstraints?: CapabilityConstraints;
  maxCostUsd?: number;
  maxTimeMinutes?: number;
  taskDifficulty?: RoutingDifficulty;
  taskTitle?: string;
  taskDescription?: string;
  packetContent?: string;
  skipDifficultyClassification?: boolean;
  additionalEvalsPaths?: string[];
  randomFn?: () => number;
}

function withSignals(
  decision: WorkflowRouteDecision,
  prompt: string,
  taskDifficulty?: RoutingDifficulty,
): WorkflowRouteDecision {
  const signalContext = buildRoutingSignalContext(prompt, taskDifficulty);

  return attachSignalProvenance({
    ...decision,
    signals: signalContext.signals,
  }, signalContext.classification);
}

function withChallengeRecommendation<T extends WorkflowRouteDecision>(decision: T, repoDir?: string): T {
  const challengeConfig = getChallengeSchedulerConfig(repoDir);
  if (challengeConfig.enabled === false) {
    return decision;
  }

  const recommendation = evaluateChallenge({
    routingDecision: decision,
    evalSummary: buildEvalSummary(repoDir),
    config: challengeConfig,
    repoDir,
  });

  if (!recommendation.shouldChallenge) {
    return decision;
  }

  return {
    ...decision,
    challengeRecommendation: recommendation,
  };
}

const STAGE_ROLE_TASK_TYPE: Record<'planner' | 'coder' | 'reviewer', RegistryTaskType> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

function registryModelPool(repoDir?: string): string[] {
  return Object.entries(getGlobalModelRegistry().models)
    .filter(([, capabilities]) => isModelEnabled(capabilities))
    .map(([modelId]) => modelId);
}

function registryStageModelPool(role: 'planner' | 'coder' | 'reviewer', repoDir?: string): string[] {
  const registry = getGlobalModelRegistry();
  return listEffectiveModelsForStage(role, { repoDir, registry }).models
    .filter((modelId) => isModelEnabled(registry.models[modelId]));
}

function buildRoutingSignalContext(
  prompt: string,
  taskDifficulty?: RoutingDifficulty,
): {
  characteristics: PromptCharacteristics;
  classification: TaskPacketClassification;
  riskScore: number;
  signals: WorkflowRouteDecision['signals'];
} {
  const classification = classifyTaskPacket(prompt);
  const fileTypeMatches = prompt.match(FILE_TYPE_PATTERN) || [];
  const fileTypes = [...new Set(fileTypeMatches.map((m) => m.toLowerCase()))];
  const characteristics: PromptCharacteristics = {
    length: classification.evidence.promptLength,
    charCount: classification.evidence.charCount,
    complexityScore: classification.complexityScore,
    complexityBand: classification.complexityBand,
    riskFlags: classification.riskFlags,
    fileTypes: fileTypes.length > 0 ? fileTypes : classification.evidence.fileTypes,
    taskType: classification.taskType,
  };
  const riskScore = Math.max(computeRiskScore(prompt, characteristics), classification.riskScore);

  return {
    characteristics,
    classification,
    riskScore,
    signals: {
      taskType: classification.taskType,
      promptLength: characteristics.length,
      complexityScore: classification.complexityScore,
      complexityBand: classification.complexityBand,
      riskFlags: classification.riskFlags,
      ...(classification.suspiciousZero ? {
        suspiciousZero: true,
        suspiciousZeroReason: classification.suspiciousZeroReason,
      } : {}),
      fileTypes: characteristics.fileTypes,
      riskScore,
      ...(taskDifficulty ? { taskDifficulty } : {}),
    },
  };
}

function signalVectorForProvenance(classification: TaskPacketClassification): Record<string, unknown> {
  return {
    taskType: classification.taskType,
    complexity: classification.complexity,
    complexityScore: classification.complexityScore,
    complexityBand: classification.complexityBand,
    riskFlags: classification.riskFlags,
    riskScore: classification.riskScore,
    suspiciousZero: classification.suspiciousZero,
    evidence: classification.evidence,
  };
}

function attachSignalProvenance<T extends WorkflowRouteDecision>(
  decision: T,
  classification: TaskPacketClassification,
): T {
  return {
    ...decision,
    provenance: {
      ...(decision.provenance ?? {}),
      signalVector: signalVectorForProvenance(classification),
    } as T['provenance'],
  };
}

function logRoutingSignalVector(decision: WorkflowRouteDecision): void {
  const flags = decision.signals.riskFlags?.length ? decision.signals.riskFlags.join('|') : 'none';
  const zero = decision.signals.suspiciousZero ? ` suspiciousZero=${decision.signals.suspiciousZeroReason ?? 'true'}` : '';
  routerLog(
    `signals task=${decision.signals.taskType} complexity=${decision.signals.complexityScore}` +
      ` band=${decision.signals.complexityBand ?? 'unknown'} risk=${decision.signals.riskScore}` +
      ` flags=${flags}${zero}`,
    'debug',
  );
}

function applySuspiciousZeroEscalation<T extends WorkflowRouteDecision>(
  decision: T,
  pools: {
    plannerPool?: string[];
    coderPool?: string[];
    reviewerPool?: string[];
  } = {},
  repoDir?: string,
): T {
  if (!decision.signals.suspiciousZero) {
    return decision;
  }

  const fallbackPool = getModelPool(repoDir).models;
  const floor: DifficultyFloor = {
    allowHaiku: false,
    preferSonnet: true,
    preferOpus: false,
    neverHaikuAlone: true,
  };
  const planner = applyDifficultyFloor(decision.planner, floor, pools.plannerPool ?? fallbackPool, 'planner', repoDir);
  const coder = applyDifficultyFloor(decision.coder, floor, pools.coderPool ?? fallbackPool, 'coder', repoDir);
  const reviewer = applyDifficultyFloor(decision.reviewer, floor, pools.reviewerPool ?? fallbackPool, 'reviewer', repoDir);

  if (planner === decision.planner && coder === decision.coder && reviewer === decision.reviewer) {
    return decision;
  }

  return {
    ...decision,
    planner,
    coder,
    reviewer,
    expectedCostPlan: estimateStageCost(planner, PLAN_TOKENS[decision.planDepth], repoDir),
    expectedCostCode: estimateStageCost(coder, CODE_TOKENS[decision.codeDepth], repoDir),
    expectedCostReview: decision.reviewRecommended === 'none'
      ? 0
      : estimateStageCost(reviewer, REVIEW_TOKENS[decision.reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir),
    reasoning: [
      ...decision.reasoning,
      `Suspicious zero complexity (${decision.signals.suspiciousZeroReason ?? 'structural evidence'}); fast-economy models rejected for routing safety.`,
    ],
  };
}

/**
 * Task-type ladder grouped by model class, preserving ladder order within
 * each class. Encodes tier-shaped preferences (e.g. "frontier first, then
 * strong generalists") without hardcoding model IDs, so registry or config
 * changes propagate to heuristic routing automatically.
 */
function ladderByClass(
  taskType: RegistryTaskType,
  classes: ModelClass[],
  repoDir?: string,
): string[] {
  const registry = getEffectiveRegistry(repoDir);
  const ladder = getLadder(registry, taskType);
  return classes.flatMap((modelClass) =>
    ladder.filter((modelId) => registry.models[modelId]?.class === modelClass)
  );
}

const REPO_RISK_PATTERNS = [
  /\bauth(entication|orization)?\b/i,
  /\bpayment\b/i,
  /\bsecurity\b/i,
  /\bpermission(s)?\b/i,
  /\bmigration\b/i,
  /\bdatabase\b/i,
  /\brouter\b/i,
  /\bcli\b/i,
  /\bworkflow\b/i,
  /\bconfig\b/i,
  /\breview\b/i,
  /\beval\b/i,
];

const BREADTH_PATTERNS = [
  /\bplanning\b/i,
  /\bplanner\b/i,
  /\bcoder\b/i,
  /\breviewer\b/i,
  /\bstdout\b/i,
  /\bjson\b/i,
  /\bmodel(s)?\b/i,
  /\boutput(s)?\b/i,
  /\bcommand\b/i,
  /\bcli\b/i,
  /\btool\b/i,
  /\bextend\b/i,
  /\broute\b/i,
];

interface ResolvedModelPool {
  models: string[];
  warnings: string[];
  nativeCertificationRejections?: RouterCertificationRejection[];
  modelExclusions?: ModelExclusionDiagnostic[];
  routingFailure?: string;
}

export interface StageTokenProfile {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export const PLAN_TOKENS: Record<PlanDepth, StageTokenProfile> = {
  light: { inputTokens: 35_000, cacheCreationTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 5_000 },
  medium: { inputTokens: 90_000, cacheCreationTokens: 30_000, cacheReadTokens: 70_000, outputTokens: 10_000 },
  deep: { inputTokens: 180_000, cacheCreationTokens: 60_000, cacheReadTokens: 140_000, outputTokens: 18_000 },
};

export const CODE_TOKENS: Record<CodeDepth, StageTokenProfile> = {
  light: { inputTokens: 220_000, cacheCreationTokens: 80_000, cacheReadTokens: 180_000, outputTokens: 12_000 },
  medium: { inputTokens: 850_000, cacheCreationTokens: 260_000, cacheReadTokens: 700_000, outputTokens: 35_000 },
  deep: { inputTokens: 2_800_000, cacheCreationTokens: 950_000, cacheReadTokens: 2_300_000, outputTokens: 110_000 },
};

export const REVIEW_TOKENS: Record<Exclude<ReviewMode, 'none'>, StageTokenProfile> = {
  static: { inputTokens: 18_000, cacheCreationTokens: 4_000, cacheReadTokens: 10_000, outputTokens: 1_500 },
  llm: { inputTokens: 95_000, cacheCreationTokens: 25_000, cacheReadTokens: 80_000, outputTokens: 8_000 },
  'static+llm': { inputTokens: 180_000, cacheCreationTokens: 40_000, cacheReadTokens: 160_000, outputTokens: 12_000 },
};

interface StageCapabilityConstraintSet {
  planner?: CapabilityConstraints;
  coder?: CapabilityConstraints;
  reviewer?: CapabilityConstraints;
}

interface ResolvedEscalationConfig {
  enabled: boolean;
  expectedSuccessFloor: number;
  confidenceFloor: number;
  minCoderClassRankIncrease: number;
}

interface EscalationRetryContext {
  stageAwareContext?: StageAwareRouterContext;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToHundredths(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeDecisionConfidence(confidence: number | undefined, fallback = 0.5): number {
  return roundToHundredths(
    clamp(Number.isFinite(confidence) ? confidence as number : fallback, 0.1, 0.95),
  );
}

function computeHeuristicConfidence(
  categoricalConfidence: 'high' | 'medium' | 'low',
  riskScore: number,
): number {
  const baseConfidence =
    categoricalConfidence === 'high' ? 0.85 :
    categoricalConfidence === 'medium' ? 0.65 :
    0.45;

  return roundToHundredths(clamp(baseConfidence - riskScore * 0.02, 0.1, 0.95));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function totalExpectedCost(decision: Pick<WorkflowRouteDecision, 'expectedCostPlan' | 'expectedCostCode' | 'expectedCostReview'>): number {
  return roundMoney(decision.expectedCostPlan + decision.expectedCostCode + decision.expectedCostReview);
}

function normalizeEscalationConfig(repoDir?: string): ResolvedEscalationConfig {
  const config = getRouterConfig(repoDir).escalation;
  const bounded = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? clamp(value, 0, 1)
      : fallback;

  return {
    enabled: config?.enabled !== false,
    expectedSuccessFloor: bounded(config?.expectedSuccessFloor, 0.5),
    confidenceFloor: bounded(config?.confidenceFloor, 0.4),
    minCoderClassRankIncrease: typeof config?.minCoderClassRankIncrease === 'number' && Number.isFinite(config.minCoderClassRankIncrease)
      ? Math.max(0, Math.floor(config.minCoderClassRankIncrease))
      : 1,
  };
}

function routeEscalationTriggers(
  decision: WorkflowRouteDecision,
  config: ResolvedEscalationConfig,
): RouteEscalationTrigger[] {
  const triggers: RouteEscalationTrigger[] = [];
  if (decision.expectedSuccess < config.expectedSuccessFloor) {
    triggers.push({
      metric: 'expectedSuccess',
      value: decision.expectedSuccess,
      threshold: config.expectedSuccessFloor,
    });
  }
  if (decision.confidence < config.confidenceFloor) {
    triggers.push({
      metric: 'confidence',
      value: decision.confidence,
      threshold: config.confidenceFloor,
    });
  }
  return triggers;
}

function routeSummary(decision: WorkflowRouteDecision): RouteEscalationProvenance['initialRoute'] {
  return {
    planner: decision.planner,
    coder: decision.coder,
    reviewer: decision.reviewer,
    cost: totalExpectedCost(decision),
    expectedSuccess: decision.expectedSuccess,
    confidence: decision.confidence,
  };
}

function modelClassRank(modelId: string, repoDir?: string): number {
  const modelClass = getEffectiveRegistry(repoDir).models[modelId]?.class ?? 'strong_generalist';
  return CLASS_RANK[modelClass];
}

function codingLadderPosition(modelId: string, repoDir?: string): number {
  const index = getLadder(getEffectiveRegistry(repoDir), 'coding').indexOf(modelId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function codingQualityScore(modelId: string, repoDir?: string): number {
  return getEffectiveRegistry(repoDir).models[modelId]?.qualityScores.coding ?? 0;
}

function isStrongerCoder(candidate: string, current: string, repoDir?: string): boolean {
  if (!candidate || candidate === current) {
    return false;
  }

  const candidateRank = modelClassRank(candidate, repoDir);
  const currentRank = modelClassRank(current, repoDir);
  if (candidateRank > currentRank) {
    return true;
  }
  if (candidateRank < currentRank) {
    return false;
  }

  const candidatePosition = codingLadderPosition(candidate, repoDir);
  const currentPosition = codingLadderPosition(current, repoDir);
  if (candidatePosition !== currentPosition) {
    return candidatePosition < currentPosition;
  }

  return codingQualityScore(candidate, repoDir) > codingQualityScore(current, repoDir);
}

function isEscalationEligibleCoder(
  candidate: string,
  current: string,
  config: Pick<ResolvedEscalationConfig, 'minCoderClassRankIncrease'>,
  repoDir?: string,
): boolean {
  if (!candidate || candidate === current) {
    return false;
  }
  const candidateRank = modelClassRank(candidate, repoDir);
  const currentRank = modelClassRank(current, repoDir);
  if (candidateRank > currentRank) {
    return candidateRank - currentRank >= config.minCoderClassRankIncrease;
  }
  if (candidateRank < currentRank) {
    return false;
  }
  return isStrongerCoder(candidate, current, repoDir);
}

function resolveEscalationBudget(
  decision: WorkflowRouteDecision,
  options: RouteWorkflowOptions | undefined,
  operatingMode?: OperatingMode,
): number | null {
  const finiteBudget = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

  if (finiteBudget(options?.maxCostUsd)) {
    return options.maxCostUsd;
  }
  if (finiteBudget(decision.constraints?.maxCostUsd)) {
    return decision.constraints.maxCostUsd;
  }
  if (finiteBudget(decision.maxCostUsd)) {
    return decision.maxCostUsd;
  }

  const budget = getBudgetConfig(options?.repoDir);
  const mode = operatingMode ?? getCurrentOperatingMode(options?.repoDir);
  return mode === 'survival'
    ? budget.survivalMode
    : mode === 'constrained'
      ? budget.constrainedMode
      : budget.normalMode;
}

function routeWithEscalationProvenance<T extends WorkflowRouteDecision>(
  decision: T,
  escalation: RouteEscalationProvenance,
  repoDir?: string,
): T {
  const mode = getCurrentOperatingMode(repoDir);
  return {
    ...decision,
    provenance: {
      source: 'live',
      inputKind: 'issue',
      inputPath: '',
      inputHash: '',
      routedAt: new Date().toISOString(),
      routerMode: mode === 'constrained' || mode === 'survival' ? mode : 'normal',
      ...(decision.provenance ?? {}),
      escalation,
    },
  };
}

function reasonedDecision<T extends WorkflowRouteDecision>(decision: T, reason: string): T {
  return {
    ...decision,
    reasoning: [...decision.reasoning, reason],
  };
}

function routeLikeAlternativeValue(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function routeLikeString(source: Record<string, unknown>, keys: string[], fallback: string): string {
  const value = routeLikeAlternativeValue(source, keys);
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function routeLikeNumber(source: Record<string, unknown>, keys: string[], fallback: number): number {
  const value = routeLikeAlternativeValue(source, keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function routeLikePlanDepth(source: Record<string, unknown>, fallback: PlanDepth): PlanDepth {
  const value = routeLikeAlternativeValue(source, ['planDepth', 'plan_depth']);
  if (value === 'light' || value === 'medium' || value === 'deep') return value;
  if (value === 'low') return 'light';
  if (value === 'high') return 'deep';
  return fallback;
}

function routeLikeCodeDepth(source: Record<string, unknown>, fallback: CodeDepth): CodeDepth {
  const value = routeLikeAlternativeValue(source, ['codeDepth', 'code_depth']);
  if (value === 'light' || value === 'medium' || value === 'deep') return value;
  if (value === 'low') return 'light';
  if (value === 'high') return 'deep';
  return fallback;
}

function routeLikeReviewMode(source: Record<string, unknown>, fallback: ReviewMode): ReviewMode {
  const value = routeLikeAlternativeValue(source, ['reviewRecommended', 'review_mode', 'reviewMode']);
  if (value === 'none' || value === 'static' || value === 'llm' || value === 'static+llm') return value;
  if (value === 'light') return 'static';
  if (value === 'standard') return 'llm';
  if (value === 'deep') return 'static+llm';
  return fallback;
}

function decisionFromRouteLikeAlternative(
  initial: StageAwareDecision,
  alternative: unknown,
  config: Pick<ResolvedEscalationConfig, 'minCoderClassRankIncrease'>,
  repoDir?: string,
): StageAwareDecision | null {
  if (!alternative || typeof alternative !== 'object' || Array.isArray(alternative)) {
    return null;
  }
  const source = alternative as Record<string, unknown>;
  const coder = routeLikeString(source, ['coder', 'coder_model', 'coderModel'], initial.coder);
  if (!isEscalationEligibleCoder(coder, initial.coder, config, repoDir)) {
    return null;
  }

  const planner = routeLikeString(source, ['planner', 'planner_model', 'plannerModel'], initial.planner);
  const reviewer = routeLikeString(source, ['reviewer', 'reviewer_model', 'reviewerModel'], initial.reviewer);
  const planDepth = routeLikePlanDepth(source, initial.planDepth);
  const codeDepth = routeLikeCodeDepth(source, initial.codeDepth);
  const reviewRecommended = routeLikeReviewMode(source, initial.reviewRecommended);
  const fallbackPlan = estimateStageCost(planner, PLAN_TOKENS[planDepth], repoDir);
  const fallbackCode = estimateStageCost(coder, CODE_TOKENS[codeDepth], repoDir);
  const fallbackReview = reviewRecommended === 'none'
    ? 0
    : estimateStageCost(reviewer, REVIEW_TOKENS[reviewRecommended], repoDir);
  const totalCost = routeLikeNumber(source, ['expectedCost', 'expected_cost_usd', 'estimated_cost_usd', 'cost'], fallbackPlan + fallbackCode + fallbackReview);
  const fallbackTotal = fallbackPlan + fallbackCode + fallbackReview;
  const costScale = fallbackTotal > 0 ? totalCost / fallbackTotal : 1;
  const expectedCostPlan = roundMoney(fallbackPlan * costScale);
  const expectedCostCode = roundMoney(fallbackCode * costScale);

  return {
    ...initial,
    planner,
    coder,
    reviewer,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess: clamp(routeLikeNumber(source, ['expectedSuccess', 'expected_success', 'estimated_success_under_budget'], initial.expectedSuccess), 0, 1),
    confidence: clamp(routeLikeNumber(source, ['confidence'], initial.confidence), 0, 1),
    expectedCostPlan,
    expectedCostCode,
    expectedCostReview: roundMoney(totalCost - expectedCostPlan - expectedCostCode),
    expectedCost: roundMoney(totalCost),
    reasoning: [
      ...initial.reasoning,
      `Router escalation selected stronger Hokusai alternative coder ${coder}.`,
    ],
  };
}

function bestAffordableRouteLikeAlternative(
  initial: StageAwareDecision,
  config: Pick<ResolvedEscalationConfig, 'minCoderClassRankIncrease'>,
  budget: number | null,
  repoDir?: string,
): StageAwareDecision | null {
  const candidates = [
    ...(Array.isArray(initial.provenance?.alternatives) ? initial.provenance.alternatives : []),
    ...(Array.isArray(initial.provenance?.tradeoffs) ? initial.provenance.tradeoffs : []),
  ]
    .map((candidate) => decisionFromRouteLikeAlternative(initial, candidate, config, repoDir))
    .filter((candidate): candidate is StageAwareDecision => {
      if (!candidate) return false;
      return budget === null || totalExpectedCost(candidate) <= budget;
    });

  candidates.sort((left, right) => {
    if (right.expectedSuccess !== left.expectedSuccess) return right.expectedSuccess - left.expectedSuccess;
    return totalExpectedCost(left) - totalExpectedCost(right);
  });
  return candidates[0] ?? null;
}

function strictStagePool(policyPool: string[] | undefined, explicitPool: string[] | undefined): string[] | undefined {
  if (explicitPool && explicitPool.length > 0) {
    if (policyPool && policyPool.length > 0) {
      const explicit = new Set(explicitPool);
      const intersection = policyPool.filter((modelId) => explicit.has(modelId));
      return intersection.length > 0 ? intersection : explicitPool;
    }
    return explicitPool;
  }
  return policyPool;
}

function strongerCoderCandidates(
  prompt: string,
  initialCoder: string,
  config: Pick<ResolvedEscalationConfig, 'minCoderClassRankIncrease'>,
  options?: RouteWorkflowOptions,
): string[] {
  const repoDir = options?.repoDir;
  const policyResolution = resolvePolicyStagePools(prompt, options ?? {});
  const poolResolution = getEffectiveModelPool(options);
  const routerConfig = getRouterConfig(repoDir);
  const coderPool = resolveStagePool(
    'coder',
    poolResolution.models,
    routerConfig,
    options,
    policyResolution?.policyStagePools.coderModels,
  ).models;

  return coderPool
    .filter((modelId) => isEscalationEligibleCoder(modelId, initialCoder, config, repoDir))
    .sort((left, right) => {
      const rankDelta = modelClassRank(right, repoDir) - modelClassRank(left, repoDir);
      if (rankDelta !== 0) return rankDelta;
      const qualityDelta = codingQualityScore(right, repoDir) - codingQualityScore(left, repoDir);
      if (qualityDelta !== 0) return qualityDelta;
      return codingLadderPosition(left, repoDir) - codingLadderPosition(right, repoDir);
    });
}

function canCandidateFitBudget(
  candidateCoder: string,
  initial: WorkflowRouteDecision,
  budget: number | null,
  repoDir?: string,
): boolean {
  if (budget === null) {
    return true;
  }
  const cost =
    initial.expectedCostPlan +
    estimateStageCost(candidateCoder, CODE_TOKENS[initial.codeDepth], repoDir) +
    initial.expectedCostReview;
  return cost <= budget;
}

function buildRetryOptions(
  options: RouteWorkflowOptions | undefined,
  initial: WorkflowRouteDecision,
  strongerCoders: string[],
): RouteWorkflowOptions {
  return {
    ...(options ?? {}),
    modelsAvailable: undefined,
    plannerModelsAvailable: initial.planner ? [initial.planner] : (options?.plannerModelsAvailable ?? options?.modelsAvailable),
    coderModelsAvailable: strongerCoders,
    reviewerModelsAvailable: initial.reviewer ? [initial.reviewer] : (options?.reviewerModelsAvailable ?? options?.modelsAvailable),
    skipDifficultyClassification: true,
  };
}

function applyRouteEscalation(
  prompt: string,
  initial: StageAwareDecision,
  options?: RouteWorkflowOptions,
  retryContext: EscalationRetryContext = {},
): StageAwareDecision {
  const repoDir = options?.repoDir;
  const config = normalizeEscalationConfig(repoDir);
  if (!config.enabled) {
    return initial;
  }

  const triggers = routeEscalationTriggers(initial, config);
  if (triggers.length === 0) {
    return initial;
  }

  const budget = resolveEscalationBudget(initial, options);
  const candidates = strongerCoderCandidates(prompt, initial.coder, config, options);
  const baseEscalation = (
    finalDecision: WorkflowRouteDecision,
    outcome: RouteEscalationProvenance['outcome'],
    reason?: string,
  ): RouteEscalationProvenance => ({
    enabled: true,
    triggered: true,
    triggers,
    outcome,
    initialRoute: routeSummary(initial),
    finalRoute: routeSummary(finalDecision),
    candidateCount: candidates.length,
    thresholds: {
      expectedSuccessFloor: config.expectedSuccessFloor,
      confidenceFloor: config.confidenceFloor,
      minCoderClassRankIncrease: config.minCoderClassRankIncrease,
    },
    budget,
    ...(reason ? { reason } : {}),
  });

  const alternative = bestAffordableRouteLikeAlternative(initial, config, budget, repoDir);
  if (alternative) {
    const escalation = baseEscalation(alternative, 'escalated', 'selected_affordable_hokusai_alternative');
    return routeWithEscalationProvenance(alternative, escalation, repoDir);
  }

  if (candidates.length === 0) {
    const reason = 'no eligible coder candidate is stronger than the initial route';
    const escalation = baseEscalation(initial, 'no_stronger_candidate', reason);
    return routeWithEscalationProvenance(reasonedDecision(initial, `Router escalation retained ${initial.coder}: ${reason}.`), escalation, repoDir);
  }

  const anyAffordable = candidates.some((candidate) => canCandidateFitBudget(candidate, initial, budget, repoDir));
  if (!anyAffordable) {
    const reason = 'all stronger coder candidates exceed the route budget';
    const escalation = baseEscalation(initial, 'no_affordable_stronger_candidate', reason);
    return routeWithEscalationProvenance(reasonedDecision(initial, `Router escalation retained ${initial.coder}: ${reason}.`), escalation, repoDir);
  }

  const retry = routeWorkflowStageAwareInternal(
    prompt,
    buildRetryOptions(options, initial, candidates),
    retryContext.stageAwareContext,
    true,
  );
  if (
    retry &&
    isEscalationEligibleCoder(retry.coder, initial.coder, config, repoDir) &&
    (budget === null || totalExpectedCost(retry) <= budget)
  ) {
    const finalDecision = reasonedDecision(
      retry,
      `Router escalation selected stronger coder ${retry.coder} after ${triggers.map((trigger) => trigger.metric).join(' and ')} trigger.`,
    );
    const escalation = baseEscalation(finalDecision, 'escalated', 'selected_affordable_retry_route');
    return routeWithEscalationProvenance(finalDecision, escalation, repoDir);
  }

  const outcome = retry && !isEscalationEligibleCoder(retry.coder, initial.coder, config, repoDir)
    ? 'no_stronger_candidate'
    : 'retry_failed';
  const reason = retry
    ? 'retry did not return a qualifying stronger coder route'
    : 'retry could not produce a route from stronger coder candidates';
  const escalation = baseEscalation(initial, outcome, reason);
  return routeWithEscalationProvenance(reasonedDecision(initial, `Router escalation retained ${initial.coder}: ${reason}.`), escalation, repoDir);
}

function countMatches(prompt: string, patterns: RegExp[]): number {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(prompt) ? 1 : 0), 0);
}

function mergeCapabilityConstraints(
  base?: CapabilityConstraints,
  override?: CapabilityConstraints,
): CapabilityConstraints | undefined {
  const merged: CapabilityConstraints = {};

  const minContextWindow = [base?.minContextWindow, override?.minContextWindow]
    .filter((value): value is number => value !== undefined)
    .reduce<number | undefined>((max, value) => max === undefined ? value : Math.max(max, value), undefined);
  if (minContextWindow !== undefined) {
    merged.minContextWindow = minContextWindow;
  }

  if (base?.requiresTools === true || override?.requiresTools === true) {
    merged.requiresTools = true;
  }

  if (base?.requiresMultimodal === true || override?.requiresMultimodal === true) {
    merged.requiresMultimodal = true;
  }

  const latencyTiers = [base?.maxLatencyTier, override?.maxLatencyTier]
    .filter((value): value is LatencyTier => value !== undefined);
  if (latencyTiers.length > 0) {
    merged.maxLatencyTier = latencyTiers.reduce((strictest, tier) =>
      compareLatencyTier(tier, strictest) < 0 ? tier : strictest
    );
  }

  return hasCapabilityConstraints(merged) ? merged : undefined;
}

function combineStageCapabilityConstraints(
  constraints: StageCapabilityConstraintSet,
): CapabilityConstraints | undefined {
  const all = [constraints.planner, constraints.coder, constraints.reviewer].filter(hasCapabilityConstraints);
  if (all.length === 0) {
    return undefined;
  }

  let maxLatencyTier: LatencyTier | undefined;
  for (const entry of all) {
    if (!entry.maxLatencyTier) {
      continue;
    }

    if (!maxLatencyTier || compareLatencyTier(entry.maxLatencyTier, maxLatencyTier) < 0) {
      maxLatencyTier = entry.maxLatencyTier;
    }
  }

  const minContextWindow = all.reduce<number | undefined>((max, entry) => {
    if (entry.minContextWindow === undefined) {
      return max;
    }
    return max === undefined ? entry.minContextWindow : Math.max(max, entry.minContextWindow);
  }, undefined);

  return {
    ...(minContextWindow !== undefined ? { minContextWindow } : {}),
    ...(all.some((entry) => entry.requiresTools === true) ? { requiresTools: true } : {}),
    ...(all.some((entry) => entry.requiresMultimodal === true) ? { requiresMultimodal: true } : {}),
    ...(maxLatencyTier !== undefined ? { maxLatencyTier } : {}),
  };
}

function getStageContextWindowRequirement(profile: StageTokenProfile): number | undefined {
  if (profile.inputTokens >= 1_000_000) {
    return 1_000_000;
  }
  if (profile.inputTokens >= 250_000) {
    return 400_000;
  }
  if (profile.inputTokens >= 150_000) {
    return 200_000;
  }

  return undefined;
}

function buildCapabilityPromptText(prompt: string, options?: RouteWorkflowOptions): string {
  return [
    prompt,
    options?.taskTitle,
    options?.taskDescription,
    options?.packetContent,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function promptSuggestsTooling(promptText: string): boolean {
  return /\b(test|tool|shell|command|terminal|cli|run|execute|lint|build|compile|apply_patch|edit|code change)\b/i.test(promptText);
}

function promptSuggestsMultimodal(promptText: string): boolean {
  return /\b(image|images|screenshot|screenshots|figma|mockup|visual|diagram|photo|pdf)\b/i.test(promptText);
}

function deriveLatencyConstraint(
  role: 'planner' | 'coder' | 'reviewer',
  options: RouteWorkflowOptions | undefined,
  promptText: string,
): LatencyTier | undefined {
  const explicitFast = /\b(urgent|asap|immediately|fast|quick|low latency|latency budget)\b/i.test(promptText);
  if (explicitFast || (typeof options?.maxTimeMinutes === 'number' && options.maxTimeMinutes <= 15)) {
    return role === 'reviewer' ? 'fast' : 'standard';
  }
  if (typeof options?.maxTimeMinutes === 'number' && options.maxTimeMinutes <= 30) {
    return 'standard';
  }

  return undefined;
}

function buildStageCapabilityConstraints(
  prompt: string,
  options: RouteWorkflowOptions | undefined,
  planDepth: PlanDepth,
  codeDepth: CodeDepth,
  reviewRecommended: ReviewMode,
): StageCapabilityConstraintSet {
  if (!isRouterCapabilityFilteringEnabled(options?.repoDir)) {
    return {};
  }

  const promptText = buildCapabilityPromptText(prompt, options);
  const needsMultimodal = promptSuggestsMultimodal(promptText);
  const toolingSignal = promptSuggestsTooling(promptText);

  const planner = mergeCapabilityConstraints(options?.capabilityConstraints, {
    minContextWindow: getStageContextWindowRequirement(PLAN_TOKENS[planDepth]),
    ...(toolingSignal ? { requiresTools: true } : {}),
    ...(needsMultimodal ? { requiresMultimodal: true } : {}),
    ...(deriveLatencyConstraint('planner', options, promptText) ? { maxLatencyTier: deriveLatencyConstraint('planner', options, promptText) } : {}),
  });
  const coder = mergeCapabilityConstraints(options?.capabilityConstraints, {
    minContextWindow: getStageContextWindowRequirement(CODE_TOKENS[codeDepth]),
    requiresTools: true,
    ...(needsMultimodal ? { requiresMultimodal: true } : {}),
    ...(deriveLatencyConstraint('coder', options, promptText) ? { maxLatencyTier: deriveLatencyConstraint('coder', options, promptText) } : {}),
  });
  const reviewer = mergeCapabilityConstraints(options?.capabilityConstraints, {
    minContextWindow: reviewRecommended === 'none'
      ? undefined
      : getStageContextWindowRequirement(REVIEW_TOKENS[reviewRecommended]),
    ...(toolingSignal ? { requiresTools: true } : {}),
    ...(needsMultimodal ? { requiresMultimodal: true } : {}),
    ...(deriveLatencyConstraint('reviewer', options, promptText) ? { maxLatencyTier: deriveLatencyConstraint('reviewer', options, promptText) } : {}),
  });

  return {
    planner: mergeCapabilityConstraints(planner, options?.plannerCapabilityConstraints),
    coder: mergeCapabilityConstraints(coder, options?.coderCapabilityConstraints),
    reviewer: mergeCapabilityConstraints(reviewer, options?.reviewerCapabilityConstraints),
  };
}

function mergePoolWarnings(...results: Array<DeepSeekPoolFilterResult | OpenRouterPoolFilterResult>): string[] {
  return [...new Set(results.flatMap((result) => result.warnings))];
}

function filterProviderPool(
  models: string[],
  repoDir?: string,
  stage?: 'planner' | 'coder' | 'reviewer',
): ResolvedModelPool {
  const deepSeekFiltered = filterDeepSeekModels(filterDisabledModels(models), repoDir, stage);
  const openRouterFiltered = filterOpenRouterModels(deepSeekFiltered.models, repoDir, stage);
  const registry = getEffectiveRegistry(repoDir);
  const routingRejected = openRouterFiltered.models.filter((modelId) =>
    registry.models[modelId]?.supportedModel?.routingEligible === false
  );
  const codexRejected = openRouterFiltered.models.filter((modelId) => {
    const capabilities = registry.models[modelId];
    return capabilities?.agent === 'codex' && !isCodexChatgptLaunchEligible(capabilities);
  });
  return {
    models: openRouterFiltered.models.filter((modelId) =>
      !routingRejected.includes(modelId) && !codexRejected.includes(modelId)
    ),
    warnings: [
      ...mergePoolWarnings(deepSeekFiltered, openRouterFiltered),
      ...routingRejected.map((modelId) => `Excluded ${modelId}: global model projection declares it ineligible for routing.`),
      ...codexRejected.map((modelId) => `Excluded ${modelId}: global model projection declares it ineligible for the codex-chatgpt launch surface.`),
    ],
  };
}

function getModelPool(repoDir?: string): ResolvedModelPool {
  const pricingModels = Object.keys(loadConfiguredPricingTable(repoDir));
  return filterProviderPool([...new Set([
    ...pricingModels,
    ...registryModelPool(repoDir),
  ])], repoDir);
}

function getEffectiveModelPool(options?: RouteWorkflowOptions): ResolvedModelPool {
  if (options?.modelsAvailable && options.modelsAvailable.length > 0) {
    return filterProviderPool([...new Set(options.modelsAvailable)], options.repoDir);
  }

  return getModelPool(options?.repoDir);
}

function intersectPools(basePool: string[], preferredPool?: string[]): string[] {
  if (!preferredPool || preferredPool.length === 0) {
    return [...new Set(basePool)];
  }

  const intersected = preferredPool.filter((modelId) => basePool.includes(modelId));
  if (intersected.length > 0) {
    return [...new Set(intersected)];
  }

  return [...new Set(preferredPool)];
}

function resolveStagePool(
  role: 'planner' | 'coder' | 'reviewer',
  basePool: string[],
  routerConfig: ReturnType<typeof getRouterConfig>,
  options?: RouteWorkflowOptions,
  policyPool?: string[],
): ResolvedModelPool {
  const explicitPool = options?.modelsAvailable && options.modelsAvailable.length > 0
    ? options.modelsAvailable
    : role === 'planner'
      ? options?.plannerModelsAvailable
      : role === 'coder'
        ? options?.coderModelsAvailable
        : options?.reviewerModelsAvailable;

  const configuredPool = intersectPools(basePool, explicitPool);
  const stageDefaultPool = explicitPool && explicitPool.length > 0
    ? configuredPool
    : intersectPools(registryStageModelPool(role, options?.repoDir), configuredPool);
  const exclusionFiltered = applyModelExclusions(
    intersectPools(stageDefaultPool, policyPool),
    role,
    options?.repoDir,
  );
  const providerFiltered = filterProviderPool(exclusionFiltered.models, options?.repoDir, role);

  // Apply native certification filter when we have a repo directory.
  // Native models only appear in repo-specific registry configs, so this is
  // always a no-op when repoDir is absent.
  if (options?.repoDir) {
    const registry = explicitPool && explicitPool.length > 0 && options.repoDir
      ? getEffectiveRegistry(options.repoDir)
      : getGlobalModelRegistry();
    const nativeFiltered = filterNativeModels(
      providerFiltered.models,
      role,
      registry,
      options.repoDir,
    );
    return {
      models: nativeFiltered.eligible,
      warnings: providerFiltered.warnings,
      ...(providerFiltered.models.length > 0 && nativeFiltered.eligible.length === 0
        ? { routingFailure: `No eligible ${role} models remain after native certification filtering.` }
        : {}),
      ...(nativeFiltered.rejected.length > 0
        ? { nativeCertificationRejections: nativeFiltered.rejected }
        : {}),
      ...(exclusionFiltered.exclusions.length > 0
        ? { modelExclusions: exclusionFiltered.exclusions }
        : {}),
    };
  }

  return {
    ...providerFiltered,
    ...(exclusionFiltered.exclusions.length > 0
      ? { modelExclusions: exclusionFiltered.exclusions }
      : {}),
  };
}

function pickAvailableModel(pool: string[], preferred: string[], fallback: string): string {
  for (const model of preferred) {
    if (pool.includes(model)) return model;
  }
  return pool[0] || fallback;
}

function computeRiskScore(prompt: string, characteristics: PromptCharacteristics): number {
  let score = characteristics.complexityScore;
  const breadthMatches = countMatches(prompt, BREADTH_PATTERNS);

  if (characteristics.length === 'long') score += 2;
  if (characteristics.fileTypes.length >= 3) score += 1;
  if (characteristics.taskType === 'bugfix' || characteristics.taskType === 'infrastructure') score += 2;
  if (characteristics.taskType === 'refactor') score += 1;

  score += countMatches(prompt, REPO_RISK_PATTERNS);
  if (breadthMatches >= 3) {
    score += 2;
  } else if (breadthMatches >= 2) {
    score += 1;
  }

  return score;
}

function choosePlanDepth(characteristics: PromptCharacteristics, riskScore: number): PlanDepth {
  if (
    riskScore >= 4 ||
    characteristics.taskType === 'infrastructure' ||
    characteristics.length === 'long'
  ) {
    return 'deep';
  }
  return 'light';
}

function chooseCodeDepth(characteristics: PromptCharacteristics, riskScore: number): CodeDepth {
  if (riskScore >= 7 || characteristics.taskType === 'infrastructure') {
    return 'deep';
  }
  if (riskScore >= 4 || characteristics.length !== 'short') {
    return 'medium';
  }
  return 'light';
}

function chooseReviewMode(characteristics: PromptCharacteristics, riskScore: number): ReviewMode {
  if (characteristics.taskType === 'documentation') return 'static';
  if (riskScore >= 6 || characteristics.taskType === 'bugfix' || characteristics.taskType === 'infrastructure') {
    return 'static+llm';
  }
  if (riskScore >= 3 || characteristics.taskType === 'feature' || characteristics.taskType === 'refactor') {
    return 'llm';
  }
  return 'static';
}

function readRoutingQuotaState(repoDir?: string): QuotaSnapshot | null {
  try {
    return readQuotaSnapshot(repoDir);
  } catch {
    console.warn('[workflow-router] Could not read quota snapshot; skipping policy resolution');
    return null;
  }
}

function resolvePolicyStagePools(
  prompt: string,
  options: RouteWorkflowOptions,
): {
  taskDifficulty: RoutingDifficulty;
  quotaState: QuotaSnapshot;
  policyStagePools: ReturnType<typeof buildPolicyStagePools>;
  stageCapabilityConstraints: StageCapabilityConstraintSet;
} | null {
  const repoDir = options.repoDir;
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  if (!taskDifficulty) {
    return null;
  }

  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return null;
  }

  const pool = getModelPool(repoDir).models;
  const signalContext = buildRoutingSignalContext(prompt, taskDifficulty);
  const characteristics = signalContext.characteristics;
  const riskScore = signalContext.riskScore;
  const stageCapabilityConstraints = buildStageCapabilityConstraints(
    prompt,
    options,
    choosePlanDepth(characteristics, riskScore),
    chooseCodeDepth(characteristics, riskScore),
    chooseReviewMode(characteristics, riskScore),
  );
  const policyStagePools = buildPolicyStagePools({
    difficulty: taskDifficulty,
    quotaState,
    pool,
    repoDir,
    capabilityConstraints: stageCapabilityConstraints,
  });

  return { taskDifficulty, quotaState, policyStagePools, stageCapabilityConstraints };
}

function buildPolicyStagePools(params: {
  difficulty: RoutingDifficulty;
  pool: string[];
  quotaState: QuotaSnapshot;
  repoDir?: string;
  capabilityConstraints?: StageCapabilityConstraintSet;
}): { plannerModels: string[]; coderModels: string[]; reviewerModels: string[] } {
  const basePolicy = {
    difficulty: params.difficulty,
    quotaState: params.quotaState,
    repoDir: params.repoDir,
  } as const;
  const poolSet = new Set(params.pool);

  // Pools inherit the healthy frontier sibling substitution rule from resolveModel:
  // when top-of-ladder frontier is degrading/exhausted and a healthy frontier sibling exists,
  // non-frontier models are excluded from viable candidates
  const toPoolModels = (taskType: 'planning' | 'coding' | 'review'): string[] =>
    viableCandidatesInPool({
      ...basePolicy,
      taskType,
      capabilityConstraints: taskType === 'planning'
        ? params.capabilityConstraints?.planner
        : taskType === 'coding'
          ? params.capabilityConstraints?.coder
          : params.capabilityConstraints?.reviewer,
    }, [...poolSet]).modelIds;

  return {
    plannerModels: toPoolModels('planning'),
    coderModels: toPoolModels('coding'),
    reviewerModels: toPoolModels('review'),
  };
}

function highestPriorityFrontierWithStatus(
  quotaState: QuotaSnapshot,
  status: 'degrading' | 'exhausted',
  repoDir?: string,
): string | null {
  const registry = getEffectiveRegistry(repoDir);
  const ladder = getLadder(registry, 'planning');
  return (
    ladder.find((modelId) => {
      const caps = registry.models[modelId];
      return caps && caps.class === 'frontier' && quotaState.models[modelId]?.status === status;
    }) ?? null
  );
}


function logDegradedRoutingDecision(
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  repoDir?: string,
): void {
  const quotaState = readRoutingQuotaState(repoDir);
  const degradedFrontier = quotaState
    ? highestPriorityFrontierWithStatus(quotaState, mode === 'survival' ? 'exhausted' : 'degrading', repoDir)
    : null;
  const subject = degradedFrontier ?? 'frontier capacity';
  const status = mode === 'survival' ? 'exhausted' : 'degrading';
  const rationale = mode === 'survival'
    ? 'restricting routing to fast-economy models'
    : 'reserving it for high-complexity steps';

  routerLog(`${mode} mode: ${subject} quota is ${status}; ${rationale}`);
}

function logPolicyAdjustment(
  taskType: 'planning' | 'coding' | 'review',
  chosenModel: string,
  pool: string[],
  quotaState: QuotaSnapshot,
  repoDir?: string,
): void {
  const registry = getEffectiveRegistry(repoDir);
  const chosenCapabilities = registry.models[chosenModel];

  // Frontier substitution path: if chosen is healthy frontier and top-of-ladder frontier is degraded/exhausted
  if (chosenCapabilities && chosenCapabilities.class === 'frontier') {
    const chosenStatus = quotaState.models[chosenModel]?.status ?? 'healthy';
    if (chosenStatus === 'healthy') {
      const ladder = getLadder(registry, taskType);
      const topLadderFrontier = ladder.find((modelId) => {
        const caps = registry.models[modelId];
        return caps && caps.class === 'frontier';
      });

      if (topLadderFrontier && topLadderFrontier !== chosenModel) {
        const topStatus = quotaState.models[topLadderFrontier]?.status ?? 'healthy';
        if (topStatus === 'degrading' || topStatus === 'exhausted') {
          policyAdjustmentLog({
            taskType,
            fromModel: topLadderFrontier,
            toModel: chosenModel,
            metadata: [['quota', topStatus], ['same-class', 'frontier']],
          });
          return;
        }
      }
    }
  }

  // Existing path: ladder-first-in-pool logic
  const preferredModel = getLadder(registry, taskType).find((modelId) => pool.includes(modelId));
  if (!preferredModel || preferredModel === chosenModel) {
    return;
  }

  const quotaStatus = quotaState.models[preferredModel]?.status ?? 'healthy';
  if (quotaStatus === 'healthy') {
    return;
  }

  policyAdjustmentLog({
    taskType,
    fromModel: preferredModel,
    toModel: chosenModel,
    metadata: [['quota', quotaStatus]],
  });
}

function logFinalFrontierSubstitution(
  decision: Pick<WorkflowRouteDecision, 'planner' | 'coder' | 'reviewer'>,
  repoDir?: string,
): void {
  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return;
  }

  const registry = getEffectiveRegistry(repoDir);
  const stages: Array<{ taskType: 'planning' | 'coding' | 'review'; modelId: string }> = [
    { taskType: 'planning', modelId: decision.planner },
    { taskType: 'coding', modelId: decision.coder },
    { taskType: 'review', modelId: decision.reviewer },
  ];

  for (const { taskType, modelId } of stages) {
    const chosenCapabilities = registry.models[modelId];
    if (!chosenCapabilities || chosenCapabilities.class !== 'frontier') {
      continue;
    }

    const chosenStatus = quotaState.models[modelId]?.status ?? 'healthy';
    if (chosenStatus !== 'healthy') {
      continue;
    }

    const topLadderFrontier = getLadder(registry, taskType).find((candidateId) => {
      const candidateCapabilities = registry.models[candidateId];
      return candidateCapabilities && candidateCapabilities.class === 'frontier';
    });

    if (!topLadderFrontier || topLadderFrontier === modelId) {
      continue;
    }

    const topStatus = quotaState.models[topLadderFrontier]?.status ?? 'healthy';
    if (topStatus !== 'degrading' && topStatus !== 'exhausted') {
      continue;
    }

    policyAdjustmentLog({
      taskType,
      fromModel: topLadderFrontier,
      toModel: modelId,
      metadata: [['quota', topStatus], ['same-class', 'frontier']],
    });
  }
}

export function estimateStageCost(
  modelId: string,
  profile: StageTokenProfile | null,
  repoDir?: string,
): number {
  if (!profile) return 0;
  const pricing = loadPricingTable(repoDir)[modelId];
  if (!pricing) return 0;
  return roundMoney(computeModelCost(profile, pricing));
}

/**
 * Compute the absolute cheapest viable model combination from the available pool.
 * Returns null if the pool doesn't contain a fast-economy model.
 */
function getCheapestOption(
  pool: string[],
  planDepth: PlanDepth,
  codeDepth: CodeDepth,
  reviewMode: ReviewMode,
  repoDir?: string,
): { planner: string; coder: string; reviewer: string; totalCost: number } | null {
  const economy = ladderByClass('coding', ['fast_economy'], repoDir)
    .find((modelId) => pool.includes(modelId));
  if (!economy) {
    return null;
  }

  const planCost = estimateStageCost(economy, PLAN_TOKENS[planDepth], repoDir);
  const codeCost = estimateStageCost(economy, CODE_TOKENS[codeDepth], repoDir);
  const reviewCost = reviewMode === 'none'
    ? 0
    : estimateStageCost(economy, REVIEW_TOKENS[reviewMode as Exclude<ReviewMode, 'none'>], repoDir);

  return {
    planner: economy,
    coder: economy,
    reviewer: economy,
    totalCost: planCost + codeCost + reviewCost,
  };
}

function downgradeModelsForBudget(params: {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: PlanDepth;
  codeDepth: CodeDepth;
  reviewMode: ReviewMode;
  plannerPool: string[];
  coderPool: string[];
  reviewerPool: string[];
  maxCostUsd: number;
  repoDir?: string;
}): { planner: string; coder: string; reviewer: string } | null {
  const { planner, coder, reviewer, planDepth, codeDepth, reviewMode, plannerPool, coderPool, reviewerPool, maxCostUsd, repoDir } = params;

  // Downgrade tiers per role, from highest model class to cheapest
  const coderTiers = [
    ladderByClass('coding', ['frontier'], repoDir),
    ladderByClass('coding', ['strong_generalist'], repoDir),
    ladderByClass('coding', ['fast_economy'], repoDir),
  ];

  const plannerTiers = [
    ladderByClass('planning', ['frontier'], repoDir),
    ladderByClass('planning', ['strong_generalist'], repoDir),
    ladderByClass('planning', ['fast_economy'], repoDir),
  ];

  const reviewerTiers = [
    ladderByClass('review', ['frontier', 'strong_generalist'], repoDir),
    ladderByClass('review', ['fast_economy'], repoDir),
  ];

  // Try all combinations, starting with minimal downgrades
  for (const coderTier of coderTiers) {
    const downgradedCoder = pickAvailableModel(coderPool, coderTier, coder);
    for (const plannerTier of plannerTiers) {
      const downgradedPlanner = pickAvailableModel(plannerPool, plannerTier, planner);
      for (const reviewerTier of reviewerTiers) {
        const downgradedReviewer = pickAvailableModel(reviewerPool, reviewerTier, reviewer);

        const totalCost =
          estimateStageCost(downgradedPlanner, PLAN_TOKENS[planDepth], repoDir) +
          estimateStageCost(downgradedCoder, CODE_TOKENS[codeDepth], repoDir) +
          (reviewMode === 'none'
            ? 0
            : estimateStageCost(downgradedReviewer, REVIEW_TOKENS[reviewMode as Exclude<ReviewMode, 'none'>], repoDir));

        if (totalCost <= maxCostUsd) {
          return {
            planner: downgradedPlanner,
            coder: downgradedCoder,
            reviewer: downgradedReviewer,
          };
        }
      }
    }
  }

  // Could not find a combination within budget
  return null;
}

/**
 * Enforce a difficulty floor on a selected model.
 *
 * If the floor disallows the fast-economy class, upgrades to a frontier or
 * strong-generalist model from the pool, following the role's registry ladder.
 * If the floor prefers frontier ("opus"), upgrades when one is available.
 * Models unknown to the registry are treated as strong generalists.
 */
export function applyDifficultyFloor(
  model: string,
  floor: DifficultyFloor,
  pool: string[],
  role: 'planner' | 'coder' | 'reviewer',
  repoDir?: string,
): string {
  const registry = getEffectiveRegistry(repoDir);
  const taskType = STAGE_ROLE_TASK_TYPE[role];
  const modelClass = registry.models[model]?.class ?? 'strong_generalist';

  if (!floor.allowHaiku && modelClass === 'fast_economy') {
    // When frontier is preferred (e.g. critical), try frontier before generalist
    if (floor.preferOpus) {
      const frontier = pickAvailableModel(pool, ladderByClass(taskType, ['frontier'], repoDir), model);
      if (registry.models[frontier]?.class === 'frontier') {
        console.warn(
          `[workflow-router] ${model} rejected for ${role} (difficulty floor). Upgraded to ${frontier}.`,
        );
        return frontier;
      }
    }

    // Fall back to strong-generalist upgrade
    const upgraded = pickAvailableModel(pool, ladderByClass(taskType, ['strong_generalist'], repoDir), model);
    console.warn(
      `[workflow-router] ${model} rejected for ${role} (difficulty floor). Upgraded to ${upgraded}.`,
    );
    return upgraded;
  }

  if (floor.preferOpus && modelClass !== 'frontier') {
    const frontier = pickAvailableModel(pool, ladderByClass(taskType, ['frontier'], repoDir), model);
    // Only upgrade if a frontier model is actually in the pool
    if (registry.models[frontier]?.class === 'frontier') {
      return frontier;
    }
  }

  return model;
}

/**
 * Resolve task difficulty for routing, using pre-classified, auto-classified, or skipped value.
 */
function resolveTaskDifficulty(options: RouteWorkflowOptions, repoDir?: string): RoutingDifficulty | undefined {
  if (options.taskDifficulty) {
    return options.taskDifficulty;
  }

  if (options.skipDifficultyClassification) {
    return undefined;
  }

  const hasClassificationInput =
    options.taskTitle || options.taskDescription || options.packetContent;

  if (!hasClassificationInput) {
    return undefined;
  }

  const difficultyConfig = getDifficultyClassifierConfig(repoDir);

  if (difficultyConfig.enabled === false) {
    return undefined;
  }

  try {
    const result = classifyTaskDifficulty({
      title: options.taskTitle,
      description: options.taskDescription,
      packetContent: options.packetContent,
      repoDir,
      model: difficultyConfig.classifierModel,
      skipLlm: difficultyConfig.skipLlm,
      cacheTtlDays: difficultyConfig.cacheTtlDays,
    });
    return result.difficulty;
  } catch {
    console.warn('[workflow-router] Difficulty classification failed, routing without floor');
    return undefined;
  }
}

function computePolicyExpectedSuccess(params: {
  plannerModel: string;
  coderModel: string;
  reviewerModel: string;
  reviewRecommended: ReviewMode;
  riskScore: number;
  repoDir?: string;
}): number {
  const registry = getEffectiveRegistry(params.repoDir);
  const qualityScores = [
    registry.models[params.plannerModel]?.qualityScores.planning ?? 0,
    registry.models[params.coderModel]?.qualityScores.coding ?? 0,
    registry.models[params.reviewerModel]?.qualityScores.review ?? 0,
  ];
  const averageScore = qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length;
  const reviewBoost = params.reviewRecommended === 'static+llm'
    ? 0.04
    : params.reviewRecommended === 'llm'
      ? 0.02
      : 0;

  return roundToHundredths(
    clamp(0.45 + averageScore / 200 + reviewBoost - params.riskScore * 0.02, 0.35, 0.97),
  );
}

function computePolicyConfidence(params: {
  plannerModel: string;
  coderModel: string;
  reviewerModel: string;
  difficulty: RoutingDifficulty;
  quotaState: QuotaSnapshot;
  riskScore: number;
}): number {
  const degradedCount = [params.plannerModel, params.coderModel, params.reviewerModel]
    .filter((modelId) => params.quotaState.models[modelId]?.status === 'degrading')
    .length;
  const difficultyPenalty =
    params.difficulty === 'critical' ? 0.12 :
    params.difficulty === 'hard' ? 0.08 :
    params.difficulty === 'moderate' ? 0.04 :
    0;

  return roundToHundredths(
    clamp(0.82 - difficultyPenalty - params.riskScore * 0.015 - degradedCount * 0.05, 0.1, 0.95),
  );
}

export function readTaskPromptFromFile(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    const data = JSON.parse(content);
    return `${data.title || ''}\n\n${data.description || ''}`.trim();
  }
  return content.trim();
}

export function routeWorkflow(prompt: string, options?: RouteWorkflowOptions): WorkflowRouteDecision {
  const repoDir = options?.repoDir;
  const poolResolution = getEffectiveModelPool(options);
  const pool = poolResolution.models;
  const initialSignalContext = buildRoutingSignalContext(prompt);
  const characteristics = initialSignalContext.characteristics;
  const riskScore = initialSignalContext.riskScore;
  const planDepth = choosePlanDepth(characteristics, riskScore);
  const codeDepth = chooseCodeDepth(characteristics, riskScore);
  const reviewRecommended = chooseReviewMode(characteristics, riskScore);

  const routerConfig = getRouterConfig(repoDir);
  const modelRouterConfig = loadRouterConfig(repoDir);
  const policyResolution = resolvePolicyStagePools(prompt, options || {});
  const plannerPoolResolution = resolveStagePool('planner', pool, routerConfig, options, policyResolution?.policyStagePools.plannerModels);
  const coderPoolResolution = resolveStagePool('coder', pool, routerConfig, options, policyResolution?.policyStagePools.coderModels);
  const reviewerPoolResolution = resolveStagePool('reviewer', pool, routerConfig, options, policyResolution?.policyStagePools.reviewerModels);
  const plannerPool = plannerPoolResolution.models;
  const coderPool = coderPoolResolution.models;
  const reviewerPool = reviewerPoolResolution.models;
  const coderRecommendation = recommendModel(prompt, {
    ...modelRouterConfig,
    repoDir,
    mode: 'heuristic',
    models: coderPool,
  });

  const planner = planDepth === 'deep'
    ? pickAvailableModel(plannerPool, [...ladderByClass('planning', ['frontier', 'strong_generalist'], repoDir), coderRecommendation.recommendedModel], coderRecommendation.recommendedModel)
    : pickAvailableModel(plannerPool, [...ladderByClass('planning', ['strong_generalist', 'fast_economy'], repoDir), coderRecommendation.recommendedModel], coderRecommendation.recommendedModel);

  const coder = codeDepth === 'deep'
    ? pickAvailableModel(coderPool, [coderRecommendation.recommendedModel, ...ladderByClass('coding', ['frontier'], repoDir)], coderRecommendation.recommendedModel)
    : codeDepth === 'medium'
      ? pickAvailableModel(coderPool, [coderRecommendation.recommendedModel, ...ladderByClass('coding', ['strong_generalist'], repoDir)], coderRecommendation.recommendedModel)
      : pickAvailableModel(coderPool, [coderRecommendation.recommendedModel, ...ladderByClass('coding', ['fast_economy'], repoDir)], coderRecommendation.recommendedModel);

  const reviewer = reviewRecommended === 'static+llm'
    ? pickAvailableModel(reviewerPool, [...ladderByClass('review', ['strong_generalist', 'frontier'], repoDir), planner], planner)
    : reviewRecommended === 'llm'
      ? pickAvailableModel(reviewerPool, [...ladderByClass('review', ['strong_generalist', 'fast_economy'], repoDir), planner], planner)
      : pickAvailableModel(reviewerPool, [...ladderByClass('review', ['fast_economy', 'strong_generalist'], repoDir), planner], planner);

  // Enforce difficulty floor
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  const signalContext = buildRoutingSignalContext(prompt, taskDifficulty);
  let finalPlanner = planner;
  let finalCoder = coder;
  let finalReviewer = reviewer;
  let difficultyFloorApplied = false;

  if (taskDifficulty) {
    const floor = getAllowedModelFloor(taskDifficulty);
    const newPlanner = applyDifficultyFloor(planner, floor, plannerPool, 'planner', repoDir);
    const newCoder = applyDifficultyFloor(coder, floor, coderPool, 'coder', repoDir);
    const newReviewer = applyDifficultyFloor(reviewer, floor, reviewerPool, 'reviewer', repoDir);

    if (newPlanner !== planner || newCoder !== coder || newReviewer !== reviewer) {
      difficultyFloorApplied = true;
    }

    finalPlanner = newPlanner;
    finalCoder = newCoder;
    finalReviewer = newReviewer;
  }

  // Enforce budget constraint (use mode-specific budget if not explicitly provided)
  let budgetAdjustmentApplied = false;
  let budgetViolation: BudgetViolation | undefined;

  const mode = getCurrentOperatingMode(repoDir);
  const budgetConfig = getBudgetConfig(repoDir);
  const effectiveBudget = options?.maxCostUsd ?? (
    mode === 'survival' ? budgetConfig.survivalMode :
    mode === 'constrained' ? budgetConfig.constrainedMode :
    budgetConfig.normalMode
  );

  const initialCost =
    estimateStageCost(finalPlanner, PLAN_TOKENS[planDepth], repoDir) +
    estimateStageCost(finalCoder, CODE_TOKENS[codeDepth], repoDir) +
    (reviewRecommended === 'none'
      ? 0
      : estimateStageCost(finalReviewer, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir));

  if (initialCost > effectiveBudget) {
    // Try downgrading models to fit within budget
    const downgradedModels = downgradeModelsForBudget({
      planner: finalPlanner,
      coder: finalCoder,
      reviewer: finalReviewer,
      planDepth,
      codeDepth,
      reviewMode: reviewRecommended,
      plannerPool,
      coderPool,
      reviewerPool,
      maxCostUsd: effectiveBudget,
      repoDir,
    });

    if (downgradedModels) {
      finalPlanner = downgradedModels.planner;
      finalCoder = downgradedModels.coder;
      finalReviewer = downgradedModels.reviewer;
      budgetAdjustmentApplied = true;
    } else {
      // Cannot fit budget - record violation
      const cheapestOption = getCheapestOption(pool, planDepth, codeDepth, reviewRecommended, repoDir);
      budgetViolation = {
        requestedCost: initialCost,
        maxCostUsd: effectiveBudget,
        operatingMode: mode,
        attemptedDowngrade: true,
        cheapestViableOption: cheapestOption,
      };
    }
  }

  const confidenceBoost =
    coderRecommendation.confidence === 'high' ? 0.08 :
    coderRecommendation.confidence === 'medium' ? 0.03 : -0.04;

  const expectedSuccess = Number(
    clamp(
      0.84
      + confidenceBoost
      - riskScore * 0.035
      + (reviewRecommended === 'static+llm' ? 0.05 : reviewRecommended === 'llm' ? 0.02 : 0)
      + (planDepth === 'deep' ? 0.03 : 0),
      0.35,
      0.97,
    ).toFixed(2)
  );
  const confidence = computeHeuristicConfidence(coderRecommendation.confidence, riskScore);

  const reasoning = [
    `Task classified as ${characteristics.taskType} with ${characteristics.length} prompt length.`,
    `Risk score ${riskScore} from complexity, scope, and repo-surface keywords.`,
    `Coder baseline uses ${coderRecommendation.recommendedModel} from heuristic eval routing.`,
    `Review mode ${reviewRecommended} chosen to match expected change risk.`,
  ];

  if (taskDifficulty) {
    const floor = getAllowedModelFloor(taskDifficulty);
    const floorSummary = floor.preferOpus
      ? 'opus preferred, never haiku alone'
      : floor.allowHaiku
        ? `sonnet preferred${floor.preferSonnet ? ', haiku allowed' : ''}`
        : 'sonnet floor, haiku rejected';
    reasoning.push(`Task classified as ${taskDifficulty} — model floor applied: ${floorSummary}.`);
  }

  if (budgetAdjustmentApplied) {
    reasoning.push(`Models downgraded to fit within $${effectiveBudget.toFixed(2)} budget constraint (${mode} mode).`);
  }

  if (budgetViolation) {
    reasoning.push(
      `⚠️ BUDGET VIOLATION: Estimated cost $${budgetViolation.requestedCost.toFixed(2)} exceeds ${mode} mode budget $${effectiveBudget.toFixed(2)}. ` +
      `No cheaper model combination available. Task routing may fail.`
    );
  }

  reasoning.push(...mergePoolWarnings(
    poolResolution,
    plannerPoolResolution,
    coderPoolResolution,
    reviewerPoolResolution,
  ));

  // Collect native certification rejections from all stage pools
  const nativeCertificationRejections: RouterCertificationRejection[] = [
    ...(plannerPoolResolution.nativeCertificationRejections ?? []),
    ...(coderPoolResolution.nativeCertificationRejections ?? []),
    ...(reviewerPoolResolution.nativeCertificationRejections ?? []),
  ];
  for (const rejection of nativeCertificationRejections) {
    const details = [
      `launchPhase=${rejection.requestedLaunchPhase}`,
      `certPhase=${rejection.requestedPhase}`,
      `reason=${rejection.reason}`,
      `provider=${rejection.nativeProvider ?? 'unknown'}`,
    ];
    if (rejection.eligibleRoles) {
      details.push(`eligibleRoles=${rejection.eligibleRoles.join(',') || 'none'}`);
    }
    if (rejection.allowedNativeAgentPhases) {
      details.push(`allowedNativeAgentPhases=${rejection.allowedNativeAgentPhases.join(',') || 'none'}`);
    }
    reasoning.push(
      `Native model ${rejection.modelId} rejected for ${rejection.role} role (${details.join(', ')}).`,
    );
  }

  const modelExclusions: ModelExclusionDiagnostic[] = [
    ...(plannerPoolResolution.modelExclusions ?? []),
    ...(coderPoolResolution.modelExclusions ?? []),
    ...(reviewerPoolResolution.modelExclusions ?? []),
  ];
  for (const exclusion of modelExclusions) {
    reasoning.push(
      `Model ${exclusion.modelId} excluded for ${exclusion.stage} by ${exclusion.source} config${exclusion.reason ? `: ${exclusion.reason}` : ''}.`,
    );
  }

  const routingFailures = [
    plannerPoolResolution.routingFailure,
    coderPoolResolution.routingFailure,
    reviewerPoolResolution.routingFailure,
  ].filter((value): value is string => Boolean(value));
  reasoning.push(...routingFailures);

  if (plannerPool.length === 0) {
    finalPlanner = '';
  }
  if (coderPool.length === 0) {
    finalCoder = '';
  }
  if (reviewerPool.length === 0) {
    finalReviewer = '';
  }

  const decision: WorkflowRouteDecision = applySuspiciousZeroEscalation(attachSignalProvenance({
    planner: finalPlanner,
    coder: finalCoder,
    reviewer: finalReviewer,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess,
    confidence,
    expectedCostPlan: estimateStageCost(finalPlanner, PLAN_TOKENS[planDepth], repoDir),
    expectedCostCode: estimateStageCost(finalCoder, CODE_TOKENS[codeDepth], repoDir),
    expectedCostReview: reviewRecommended === 'none'
      ? 0
      : estimateStageCost(finalReviewer, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir),
    reasoning,
    signals: signalContext.signals,
    constraints: { maxCostUsd: effectiveBudget },
    routingMode: 'heuristic',
    ...(budgetViolation ? { budgetViolation } : {}),
    ...(coderRecommendation.resourceSelections?.length
      ? { resourceSelections: coderRecommendation.resourceSelections }
      : {}),
    ...(nativeCertificationRejections.length > 0 ? { nativeCertificationRejections } : {}),
    ...(modelExclusions.length > 0 ? { modelExclusions } : {}),
  }, signalContext.classification), { plannerPool, coderPool, reviewerPool }, repoDir);
  logRoutingSignalVector(decision);
  registerWorkflowDecisionResources(decision, repoDir);
  return decision;
}

function routeWorkflowStageAwareInternal(
  prompt: string,
  options?: RouteWorkflowOptions,
  stageAwareContext?: StageAwareRouterContext,
  skipEscalation = false,
): StageAwareDecision {
  const repoDir = options?.repoDir;
  const initialSignalContext = buildRoutingSignalContext(prompt);
  const characteristics = initialSignalContext.characteristics;
  const riskScore = initialSignalContext.riskScore;

  // Resolve difficulty and policy pools before stage-aware routing
  // so both KNN selection and difficulty floor application respect frontier substitution
  const policyResolution = resolvePolicyStagePools(prompt, options || {});
  const taskDifficulty = policyResolution?.taskDifficulty || resolveTaskDifficulty(options || {}, repoDir);
  const signalContext = buildRoutingSignalContext(prompt, taskDifficulty);

  let stageAwareDecision;
  try {
    const stageAwareOptions = {
      repoDir,
      modelsAvailable: options?.modelsAvailable,
      plannerModelsAvailable: strictStagePool(
        policyResolution?.policyStagePools.plannerModels,
        options?.plannerModelsAvailable,
      ),
      coderModelsAvailable: strictStagePool(
        policyResolution?.policyStagePools.coderModels,
        options?.coderModelsAvailable,
      ),
      reviewerModelsAvailable: strictStagePool(
        policyResolution?.policyStagePools.reviewerModels,
        options?.reviewerModelsAvailable,
      ),
      plannerCapabilityConstraints: policyResolution?.stageCapabilityConstraints.planner,
      coderCapabilityConstraints: policyResolution?.stageCapabilityConstraints.coder,
      reviewerCapabilityConstraints: policyResolution?.stageCapabilityConstraints.reviewer,
      maxCostUsd: options?.maxCostUsd,
      additionalEvalsPaths: options?.additionalEvalsPaths,
      randomFn: options?.randomFn,
      queryInput: {
        capabilityConstraints: combineStageCapabilityConstraints(policyResolution?.stageCapabilityConstraints || {}),
      },
    };
    stageAwareDecision = stageAwareContext
      ? routeStageAwareWithContext(prompt, stageAwareContext, stageAwareOptions)
      : routeStageAware(prompt, stageAwareOptions);
  } catch (error) {
    console.warn('[workflow-router] Stage-aware routing failed, falling back to heuristic:', error);
    stageAwareDecision = null;
  }

  const baseSignals = signalContext.signals;

  let decision: StageAwareDecision;
  if (!stageAwareDecision) {
    const fallback = routeWorkflow(prompt, options);
    decision = {
      ...fallback,
      confidence: roundToHundredths(Math.max(0.1, fallback.confidence - 0.1)),
      routingMode: 'heuristic-fallback',
      neighborCount: 0,
      neighborSimilarityRange: [0, 0],
      expectedCost: Number(
        (fallback.expectedCostPlan + fallback.expectedCostCode + fallback.expectedCostReview).toFixed(2)
      ),
    };
  } else if (stageAwareDecision.routingMode === 'stage-aware-partial') {
    // Neighbors lacked model diversity — use neighbor-calibrated stage depths
    // and cost estimates, but overlay heuristic model selection.
    const fallback = routeWorkflow(prompt, options);

    // Apply difficulty floors to stage-aware partial models, using substitution-aware pool
    let finalPlanner = fallback.planner;
    let finalCoder = fallback.coder;
    let finalReviewer = fallback.reviewer;
    if (taskDifficulty) {
      const floor = getAllowedModelFloor(taskDifficulty);
      // Use policy-filtered pool if available, otherwise full pool
      const floorPool = policyResolution?.policyStagePools
        ? filterProviderPool([
            ...new Set([
              ...policyResolution.policyStagePools.plannerModels,
              ...policyResolution.policyStagePools.coderModels,
              ...policyResolution.policyStagePools.reviewerModels,
            ]),
          ], repoDir).models
        : getModelPool(repoDir).models;
      finalPlanner = applyDifficultyFloor(fallback.planner, floor, floorPool, 'planner', repoDir);
      finalCoder = applyDifficultyFloor(fallback.coder, floor, floorPool, 'coder', repoDir);
      finalReviewer = applyDifficultyFloor(fallback.reviewer, floor, floorPool, 'reviewer', repoDir);
    }

    decision = {
      ...stageAwareDecision,
      planner: finalPlanner,
      coder: finalCoder,
      reviewer: finalReviewer,
      confidence: normalizeDecisionConfidence(stageAwareDecision.confidence),
      signals: baseSignals,
    };
  } else {
    // Apply difficulty floors to fully stage-aware models, using substitution-aware pool
    let saPlanner = stageAwareDecision.planner;
    let saCoder = stageAwareDecision.coder;
    let saReviewer = stageAwareDecision.reviewer;
    if (taskDifficulty) {
      const floor = getAllowedModelFloor(taskDifficulty);
      // Use policy-filtered pool if available, otherwise full pool
      const floorPool = policyResolution?.policyStagePools
        ? filterProviderPool([
            ...new Set([
              ...policyResolution.policyStagePools.plannerModels,
              ...policyResolution.policyStagePools.coderModels,
              ...policyResolution.policyStagePools.reviewerModels,
            ]),
          ], repoDir).models
        : getModelPool(repoDir).models;
      saPlanner = applyDifficultyFloor(stageAwareDecision.planner, floor, floorPool, 'planner', repoDir);
      saCoder = applyDifficultyFloor(stageAwareDecision.coder, floor, floorPool, 'coder', repoDir);
      saReviewer = applyDifficultyFloor(stageAwareDecision.reviewer, floor, floorPool, 'reviewer', repoDir);
    }

    decision = {
      ...stageAwareDecision,
      planner: saPlanner,
      coder: saCoder,
      reviewer: saReviewer,
      confidence: normalizeDecisionConfidence(stageAwareDecision.confidence),
      signals: baseSignals,
    };
  }

  const signalFloorPool = policyResolution?.policyStagePools
    ? filterProviderPool([
        ...new Set([
          ...policyResolution.policyStagePools.plannerModels,
          ...policyResolution.policyStagePools.coderModels,
          ...policyResolution.policyStagePools.reviewerModels,
        ]),
      ], repoDir).models
    : getModelPool(repoDir).models;
  const signalDecision = applySuspiciousZeroEscalation(
    attachSignalProvenance(decision, signalContext.classification),
    { plannerPool: signalFloorPool, coderPool: signalFloorPool, reviewerPool: signalFloorPool },
    repoDir,
  );
  const escalatedDecision = skipEscalation
    ? signalDecision
    : applyRouteEscalation(prompt, signalDecision, options, { stageAwareContext });
  const finalDecision = withChallengeRecommendation(escalatedDecision, repoDir);
  logRoutingSignalVector(finalDecision);
  registerWorkflowDecisionResources(finalDecision, repoDir);
  return finalDecision;
}

export function routeWorkflowStageAware(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision {
  return routeWorkflowStageAwareInternal(prompt, options);
}

export function routeWorkflowStageAwareWithContext(
  prompt: string,
  options: RouteWorkflowOptions | undefined,
  stageAwareContext: StageAwareRouterContext,
): StageAwareDecision {
  return routeWorkflowStageAwareInternal(prompt, options, stageAwareContext);
}

function buildDegradedModelPool(
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  repoDir?: string,
): string[] {
  const registry = getEffectiveRegistry(repoDir);
  const allowedClasses: ModelClass[] = mode === 'survival'
    ? ['fast_economy']
    : ['strong_generalist', 'fast_economy'];

  const pool = Object.entries(registry.models)
    .filter(([, capabilities]) => allowedClasses.includes(capabilities.class))
    .map(([modelId]) => modelId);
  const filteredPool = filterProviderPool(pool, repoDir).models;

  if (filteredPool.length > 0) {
    return filteredPool;
  }

  console.warn(
    `[workflow-router] No degraded model pool available for ${mode} mode; falling back to full routing pool.`,
  );
  return getModelPool(repoDir).models;
}

function prependReasoning(
  decision: StageAwareDecision,
  rationale: string,
): StageAwareDecision {
  return {
    ...decision,
    reasoning: [rationale, ...decision.reasoning],
  };
}

function registerWorkflowDecisionResources(
  decision: WorkflowRouteDecision,
  repoDir?: string,
): void {
  const sessionId = process.env.WAVEMILL_SESSION;
  if (!sessionId) {
    return;
  }
  const routerConfig = loadRouterConfig(repoDir);
  const defaultAgent = routerConfig.defaultAgent || 'claude';

  for (const [phase, model] of [
    ['planning', decision.planner],
    ['coding', decision.coder],
    ['review', decision.reviewer],
  ] as const) {
    if (!model) {
      continue;
    }
    const agent = resolveEffectiveAgent(model, phase, { registry: getGlobalModelRegistry() });
    const ref = registerAgentConfig({
      phase,
      model,
      cliCmd: agent.ok ? agent.agent : defaultAgent,
      repoDir,
    });
    if (ref) {
      recordUse(sessionId, phase, ref, repoDir);
    }
  }

  for (const selection of decision.resourceSelections || []) {
    if (selection.resourceRef) {
      const resourcePhase =
        selection.surface === 'router' ? 'planning' :
        selection.surface === 'planner' ? 'planning' :
        selection.surface === 'reviewer' ? 'review' :
        'coding';
      recordUse(sessionId, resourcePhase, selection.resourceRef, repoDir);
    }
  }

  const harnessId = getHarnessId(sessionId, repoDir);
  if (harnessId) {
    decision.harnessId = harnessId;
  }
}

function routeWorkflowDegradedInternal(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  stageAwareContext?: StageAwareRouterContext,
): StageAwareDecision {
  logDegradedRoutingDecision(mode, options.repoDir);
  const degradedPool = buildDegradedModelPool(mode, options.repoDir);

  // Apply mode-specific budget if not explicitly provided
  const budgetConfig = getBudgetConfig(options.repoDir);
  const modeBudget = mode === 'survival'
    ? budgetConfig.survivalMode
    : budgetConfig.constrainedMode;

  const degradedOptions: RouteWorkflowOptions = {
    ...options,
    modelsAvailable: degradedPool,
    skipDifficultyClassification: true,
    maxCostUsd: options.maxCostUsd ?? modeBudget,
  };
  const rationale = mode === 'survival'
    ? 'Survival mode: frontier models exhausted. Restricted to haiku. KNN signal used without LLM reasoning.'
    : 'Constrained mode: frontier models degrading. Restricted to sonnet/haiku and KNN signal. LLM difficulty classification skipped.';

  return prependReasoning(
    stageAwareContext
      ? routeWorkflowStageAwareWithContext(prompt, degradedOptions, stageAwareContext)
      : routeWorkflowStageAware(prompt, degradedOptions),
    rationale,
  );
}

export function routeWorkflowDegraded(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
): StageAwareDecision {
  return routeWorkflowDegradedInternal(prompt, options, mode);
}

export function routeWorkflowDegradedWithContext(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  stageAwareContext: StageAwareRouterContext,
): StageAwareDecision {
  return routeWorkflowDegradedInternal(prompt, options, mode, stageAwareContext);
}

export function tryPolicyResolution(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision | null {
  const repoDir = options?.repoDir;
  const routerConfig = loadRouterConfig(repoDir);
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  if (!taskDifficulty) {
    return null;
  }

  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return null;
  }

  const pool = getModelPool(repoDir).models;
  const signalContext = buildRoutingSignalContext(prompt, taskDifficulty);
  const characteristics = signalContext.characteristics;
  const riskScore = signalContext.riskScore;
  const planDepth = choosePlanDepth(characteristics, riskScore);
  const codeDepth = chooseCodeDepth(characteristics, riskScore);
  const reviewRecommended = chooseReviewMode(characteristics, riskScore);
  const basePolicy = {
    difficulty: taskDifficulty,
    quotaState,
    repoDir,
  } as const;
  const stageCapabilityConstraints = buildStageCapabilityConstraints(
    prompt,
    options,
    planDepth,
    codeDepth,
    reviewRecommended,
  );
  const plannerCandidates = viableCandidatesInPool({
    ...basePolicy,
    taskType: 'planning',
    capabilityConstraints: stageCapabilityConstraints.planner,
  }, pool);
  const coderCandidates = viableCandidatesInPool({
    ...basePolicy,
    taskType: 'coding',
    capabilityConstraints: stageCapabilityConstraints.coder,
  }, pool);
  const reviewerCandidates = viableCandidatesInPool({
    ...basePolicy,
    taskType: 'review',
    capabilityConstraints: stageCapabilityConstraints.reviewer,
  }, pool);
  // Exploration sampling: pick from the ranked viable candidates instead of
  // always taking the argmax. Scores come from registry quality for the task
  // type, matching the ordering produced by the policy resolver.
  const explorationConfig = resolveExplorationConfig(getRouterConfig(repoDir).exploration);
  const randomFn = options?.randomFn || Math.random;
  const registry = getEffectiveRegistry(repoDir);
  const explorationEntries: ExplorationAttribution['explored'] = [];
  const boostFor = (modelId: string): number => explorationConfig.boostMultiplier > 1
    ? recencyMultiplier(registry.models[modelId]?.releasedAt, explorationConfig)
    : 1;
  const samplePolicyModel = (
    candidates: string[],
    role: 'planner' | 'coder' | 'reviewer',
    taskType: 'planning' | 'coding' | 'review',
  ): string | null => {
    const argmax = candidates[0] ?? null;
    if (!explorationConfig.enabled || !argmax || candidates.length <= 1) {
      return argmax;
    }
    const scores = candidates.map((modelId) => (registry.models[modelId]?.qualityScores[taskType] ?? 0) / 100);
    const pick = sampleCandidateIndex(scores, explorationConfig, randomFn, candidates.map(boostFor));
    const sampled = candidates[pick.index] ?? argmax;
    if (pick.explored && sampled !== argmax) {
      explorationEntries.push({
        role,
        sampled,
        argmax,
        ...(boostFor(sampled) > 1 ? { recencyBoosted: true } : {}),
      });
    }
    return sampled;
  };

  const plannerModel = samplePolicyModel(plannerCandidates.modelIds, 'planner', 'planning');
  const coderModel = samplePolicyModel(coderCandidates.modelIds, 'coder', 'coding');
  const reviewerModel = samplePolicyModel(reviewerCandidates.modelIds, 'reviewer', 'review');

  if (!plannerModel || !coderModel || !reviewerModel) {
    console.warn(
      '[workflow-router] Policy resolver found no viable candidate for one or more roles; falling through to stage-aware',
    );
    return null;
  }

  const explorationAttribution: ExplorationAttribution | undefined = explorationConfig.enabled
    ? { mode: explorationConfig.mode, explored: explorationEntries }
    : undefined;

  logPolicyAdjustment('planning', plannerModel, pool, quotaState, repoDir);
  logPolicyAdjustment('coding', coderModel, pool, quotaState, repoDir);
  logPolicyAdjustment('review', reviewerModel, pool, quotaState, repoDir);

  const expectedCostPlan = estimateStageCost(plannerModel, PLAN_TOKENS[planDepth], repoDir);
  const expectedCostCode = estimateStageCost(coderModel, CODE_TOKENS[codeDepth], repoDir);
  const expectedCostReview = reviewRecommended === 'none'
    ? 0
    : estimateStageCost(reviewerModel, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir);
  const expectedSuccess = computePolicyExpectedSuccess({
    plannerModel,
    coderModel,
    reviewerModel,
    reviewRecommended,
    riskScore,
    repoDir,
  });
  const confidence = computePolicyConfidence({
    plannerModel,
    coderModel,
    reviewerModel,
    difficulty: taskDifficulty,
    quotaState,
    riskScore,
  });

  const decision: StageAwareDecision = applySuspiciousZeroEscalation(attachSignalProvenance({
    planner: plannerModel,
    coder: coderModel,
    reviewer: reviewerModel,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess,
    confidence,
    expectedCostPlan,
    expectedCostCode,
    expectedCostReview,
    reasoning: [
      ...(explorationAttribution && explorationAttribution.explored.length > 0
        ? [formatExplorationReasoning(explorationAttribution, explorationConfig)]
        : []),
      'Policy resolver selected models using registry capability scores and quota state.',
      `Task difficulty ${taskDifficulty} applied the routing floor before ranking candidates.`,
      `Planner=${plannerModel}, coder=${coderModel}, reviewer=${reviewerModel} are the top viable in-pool candidates.`,
      ...(plannerCandidates.capabilityFallbackUsed || coderCandidates.capabilityFallbackUsed || reviewerCandidates.capabilityFallbackUsed
        ? ['Capability constraints filtered every in-pool policy candidate for at least one stage, so Layer 3 fell back to the unfiltered viable pool.']
        : []),
      `Risk score ${riskScore} from complexity, scope, and repo-surface keywords.`,
    ],
    signals: signalContext.signals,
    routingMode: 'policy',
    neighborCount: 0,
    neighborSimilarityRange: [0, 0],
    expectedCost: Number((expectedCostPlan + expectedCostCode + expectedCostReview).toFixed(2)),
    constraints: options?.maxCostUsd === undefined
      ? undefined
      : { maxCostUsd: options.maxCostUsd },
    ...(explorationAttribution ? { exploration: explorationAttribution } : {}),
  }, signalContext.classification), { plannerPool: pool, coderPool: pool, reviewerPool: pool }, repoDir);
  logRoutingSignalVector(decision);
  return decision;
}

export async function routeWorkflowHokusai(
  prompt: string,
  options?: RouteWorkflowOptions,
): Promise<StageAwareDecision> {
  const repoDir = options?.repoDir;
  const policyResolution = resolvePolicyStagePools(prompt, options || {});
  const taskDifficulty = policyResolution?.taskDifficulty || resolveTaskDifficulty(options || {}, repoDir);
  const decision = await routeViaHokusai(prompt, {
    ...options,
    plannerModels: policyResolution?.policyStagePools.plannerModels,
    coderModels: policyResolution?.policyStagePools.coderModels,
    reviewerModels: policyResolution?.policyStagePools.reviewerModels,
  });
  if (!decision) {
    return routeWorkflowStageAware(prompt, options);
  }
  if (isDisabledModel(decision.planner) || isDisabledModel(decision.coder) || isDisabledModel(decision.reviewer)) {
    routerLog(`hokusai routing returned disabled model; falling back to local routing: planner=${decision.planner} coder=${decision.coder} reviewer=${decision.reviewer}`);
    return routeWorkflowStageAware(prompt, options);
  }

  const enriched = withSignals(decision, prompt, taskDifficulty);
  const baseDecision: StageAwareDecision = {
    ...enriched,
    reasoning: policyResolution
      ? [
          ...enriched.reasoning,
          `Hokusai input used policy-filtered candidate pools for ${taskDifficulty} difficulty.`,
        ]
      : enriched.reasoning,
    routingMode: 'hokusai',
    neighborCount: typeof enriched.provenance?.hokusai?.nearestNeighborCount === 'number'
      ? enriched.provenance.hokusai.nearestNeighborCount
      : Array.isArray(enriched.provenance?.nearestNeighbors)
        ? enriched.provenance.nearestNeighbors.length
        : 0,
    neighborSimilarityRange: [0, 0],
    expectedCost: Number(
      (enriched.expectedCostPlan + enriched.expectedCostCode + enriched.expectedCostReview).toFixed(2)
    ),
  };
  const floorPool = policyResolution?.policyStagePools
    ? filterProviderPool([
        ...new Set([
          ...policyResolution.policyStagePools.plannerModels,
          ...policyResolution.policyStagePools.coderModels,
          ...policyResolution.policyStagePools.reviewerModels,
        ]),
      ], repoDir).models
    : getModelPool(repoDir).models;
  const signalDecision = applySuspiciousZeroEscalation(
    baseDecision,
    { plannerPool: floorPool, coderPool: floorPool, reviewerPool: floorPool },
    repoDir,
  );
  const escalatedDecision = applyRouteEscalation(prompt, signalDecision, options);
  const finalDecision = withChallengeRecommendation(escalatedDecision, repoDir);
  logRoutingSignalVector(finalDecision);
  registerWorkflowDecisionResources(finalDecision, repoDir);
  return finalDecision;
}

export async function routeWorkflowAuto(
  prompt: string,
  options?: RouteWorkflowOptions,
): Promise<StageAwareDecision> {
  return routeWorkflowAutoWithContext(prompt, options);
}

export async function routeWorkflowAutoWithContext(
  prompt: string,
  options?: RouteWorkflowOptions,
  context?: {
    operatingMode?: OperatingMode;
    stageAwareContext?: StageAwareRouterContext;
  },
): Promise<StageAwareDecision> {
  const operatingMode = context?.operatingMode ?? getCurrentOperatingMode(options?.repoDir);
  if (operatingMode === 'constrained' || operatingMode === 'survival') {
    return context?.stageAwareContext
      ? routeWorkflowDegradedWithContext(prompt, options, operatingMode, context.stageAwareContext)
      : routeWorkflowDegraded(prompt, options, operatingMode);
  }

  const hokusaiConfig = getHokusaiRouterConfig(options?.repoDir);
  if (hokusaiConfig.endpoint) {
    const decision = await routeWorkflowHokusai(prompt, options);
    if (decision.routingMode === 'hokusai') {
      routerLog(`hokusai routing active: planner=${decision.planner} coder=${decision.coder} reviewer=${decision.reviewer}`);
    }
    if (decision.routingMode !== 'policy') {
      logFinalFrontierSubstitution(decision, options?.repoDir);
    }
    return decision;
  }

  const policyDecision = tryPolicyResolution(prompt, options);
  if (policyDecision) {
    const escalatedDecision = applyRouteEscalation(prompt, policyDecision, options, context);
    const finalDecision = withChallengeRecommendation(escalatedDecision, options?.repoDir);
    registerWorkflowDecisionResources(finalDecision, options?.repoDir);
    return finalDecision;
  }

  const decision = context?.stageAwareContext
    ? routeWorkflowStageAwareWithContext(prompt, options, context.stageAwareContext)
    : routeWorkflowStageAware(prompt, options);
  logFinalFrontierSubstitution(decision, options?.repoDir);
  return decision;
}

export function summarizeWorkflowRoute(decision: WorkflowRouteDecision, repoDir?: string): string {
  const routerConfig = loadRouterConfig(repoDir);
  const defaultAgent = routerConfig.defaultAgent || 'claude';
  const plannerResolution = decision.planner ? resolveEffectiveAgent(decision.planner, 'planning') : undefined;
  const coderResolution = decision.coder ? resolveEffectiveAgent(decision.coder, 'coding') : undefined;
  const reviewerResolution = decision.reviewer ? resolveEffectiveAgent(decision.reviewer, 'review') : undefined;
  const plannerAgent = plannerResolution?.ok ? plannerResolution.agent : 'unresolved';
  const coderAgent = coderResolution?.ok ? coderResolution.agent : 'unresolved';
  const reviewerAgent = reviewerResolution?.ok ? reviewerResolution.agent : 'unresolved';

  const difficultySuffix = decision.signals.taskDifficulty
    ? `  difficulty=${decision.signals.taskDifficulty}`
    : '';

  const lines = [
    `Planner:  ${decision.planner} (${plannerAgent})  depth=${decision.planDepth}  cost=$${decision.expectedCostPlan.toFixed(2)}`,
    `Coder:    ${decision.coder} (${coderAgent})  depth=${decision.codeDepth}  cost=$${decision.expectedCostCode.toFixed(2)}`,
    `Reviewer: ${decision.reviewer} (${reviewerAgent})  mode=${decision.reviewRecommended}  cost=$${decision.expectedCostReview.toFixed(2)}`,
    `Success:  ${(decision.expectedSuccess * 100).toFixed(0)}%  confidence=${decision.confidence.toFixed(2)}  task=${decision.signals.taskType}  risk=${decision.signals.riskScore}${difficultySuffix}`,
    `Signals:  ${decision.reasoning[0]} ${decision.reasoning[1]}`,
  ];

  if (
    'routingMode' in decision
    && typeof (decision as { neighborCount?: unknown }).neighborCount === 'number'
    && Array.isArray((decision as { neighborSimilarityRange?: unknown }).neighborSimilarityRange)
  ) {
    lines.push(
      `Router:   ${decision.routingMode}  neighbors=${decision.neighborCount}  similarity=${decision.neighborSimilarityRange[0].toFixed(2)}-${decision.neighborSimilarityRange[1].toFixed(2)}`
    );
  }

  if (decision.challengeRecommendation?.shouldChallenge) {
    const recommendation = decision.challengeRecommendation;
    const stageSuffix = recommendation.stage ? `  stage=${recommendation.stage}` : '';
    lines.push(
      `Challenge: ${recommendation.reason}  ${recommendation.defaultModel || 'unknown'} vs ${recommendation.challengerModel || 'unknown'}${stageSuffix}`
    );
  }

  return lines.join('\n');
}
