/**
 * Stage-aware workflow router.
 *
 * Uses nearest-neighbor lookup over historical eval records to recommend
 * per-stage models without making any LLM calls in the routing path.
 *
 * @module stage-aware-router
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalRecord, TaskDescriptor, StageOutcomes } from './eval-schema.ts';
import { buildTaskDescriptor, type TaskDescriptorInput } from './task-descriptor-builder.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { computeModelCost, loadPricingTable } from './pricing/model-pricing.ts';
import type { WorkflowRouteDecision, PlanDepth, CodeDepth, ReviewMode } from './workflow-router.ts';
import { getRouterConfig } from './config.ts';
import { listEffectiveModelsForStage } from './effective-models.ts';
import { filterDeepSeekModels } from './deepseek-provider.ts';
import { filterOpenRouterModels } from './openrouter-provider.ts';
import {
  evaluateCapabilityConstraints,
  getConfiguredModelsForDescriptor,
  getConfiguredModelsForDescriptorStage,
  getEffectiveRegistry,
  hasCapabilityConstraints,
  isCodexChatgptLaunchEligible,
  resolveModelIdentity,
  type CapabilityConstraints,
  type RegistryTaskType,
} from './model-registry.ts';
import { resolveGlobalAggregatedEvalsPath } from './evals-paths.ts';
import { filterDisabledModels, isDisabledModel } from './disabled-models.ts';
import {
  blendWithPrior,
  formatExplorationReasoning,
  recencyMultiplier,
  resolveExplorationConfig,
  sampleCandidateIndex,
  ucbBonus,
  type ExplorationAttribution,
  type ResolvedExplorationConfig,
} from './router-exploration.ts';
import { formatEvidenceExclusionSummary, partitionEvidence } from './model-evidence-policy.ts';

export interface StageAwareConstraints {
  modelsAvailable?: string[];
  plannerModelsAvailable?: string[];
  coderModelsAvailable?: string[];
  reviewerModelsAvailable?: string[];
  capabilityConstraints?: CapabilityConstraints;
  plannerCapabilityConstraints?: CapabilityConstraints;
  coderCapabilityConstraints?: CapabilityConstraints;
  reviewerCapabilityConstraints?: CapabilityConstraints;
  maxCostUsd?: number;
}

export interface StageAwareOptions extends StageAwareConstraints {
  repoDir?: string;
  kNeighbors?: number;
  minRecords?: number;
  minModels?: number;
  backfilledEvalsPath?: string;
  aggregatedEvalsPath?: string;
  additionalEvalsPaths?: string[];
  stageBlendWeight?: number;
  queryInput?: Partial<TaskDescriptorInput>;
  randomFn?: () => number;
  /** Optional clock injection for deterministic exploration/recency evaluation. */
  nowMs?: number;
}

export interface StageAwareDecision extends WorkflowRouteDecision {
  routingMode: 'stage-aware' | 'stage-aware-partial' | 'heuristic-fallback' | 'hokusai' | 'policy';
  neighborCount: number;
  neighborSimilarityRange: [number, number];
  expectedCost: number;
  shadowDecision?: StageAwareDecision | null;
  exploration?: ExplorationAttribution;
}

export interface StageAwareRouterContext {
  repoDir: string;
  routerConfig: ReturnType<typeof getRouterConfig>;
  records: EvalRecord[];
}

export interface ScoredNeighbor {
  record: EvalRecord;
  descriptor: TaskDescriptor;
  similarity: number;
}

interface ModelStageStats {
  modelId: string;
  score: number;
  cost: number;
  support: number;
  /**
   * Ranking/sampling key: the (possibly prior-blended) score plus the UCB
   * uncertainty bonus. Equals `score` when priors and UCB are disabled.
   * Never reported as expected success — only used to order and pick.
   */
  selectionScore: number;
}

interface RoleRanking {
  role: 'planner' | 'coder' | 'reviewer';
  stageKey: 'plan' | 'implementation' | 'review';
  candidates: ModelStageStats[];
  capabilityFallbackUsed?: boolean;
}

interface CombinationDecision {
  planner: ModelStageStats;
  coder: ModelStageStats;
  reviewer: ModelStageStats;
  expectedCost: number;
  expectedSuccess: number;
}

interface HistoricalEvalSource {
  path: string;
  kind: 'local' | 'backfilled' | 'aggregated';
  priority: number;
}

const TASK_TYPE_DIMENSIONS = ['bugfix', 'feature', 'refactor', 'chore', 'docs', 'test', 'infra'] as const;
const LANGUAGE_DIMENSIONS = ['ts', 'js', 'py', 'go', 'rs', 'sh', 'sql', 'other'] as const;
const DOMAIN_DIMENSIONS = ['frontend', 'backend', 'data-pipeline', 'infrastructure', 'devtools', 'full-stack'] as const;
const DEFAULT_BACKFILLED_EVALS_PATH = '.wavemill/evals/aggregated-evals.backfilled.jsonl';
const DEFAULT_AGGREGATED_EVALS_PATH = '.wavemill/evals/aggregated-evals.jsonl';
const DEFAULT_K_NEIGHBORS = 20;
const DEFAULT_MIN_RECORDS = 20;
const DEFAULT_MIN_MODELS = 2;
const DEFAULT_STAGE_BLEND_WEIGHT = 0.3;
const DEFAULT_RUBRIC_AWARE_MIN_COVERAGE = 0.3;
const DEFAULT_RUBRIC_AWARE_WEIGHT = 0.3;
const stageAwareRouterDebugState = {
  evalLoadCount: 0,
};

export function resetStageAwareRouterDebugState(): void {
  stageAwareRouterDebugState.evalLoadCount = 0;
}

export function getStageAwareRouterDebugState(): { evalLoadCount: number } {
  return { ...stageAwareRouterDebugState };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLogValue(value: number): number {
  return clamp(Math.log1p(Math.max(0, value)) / 10, 0, 1);
}

function normalizeLanguage(language: string): string {
  const lower = language.toLowerCase();
  if (lower === 'typescript' || lower === 'tsx' || lower === 'ts') return 'ts';
  if (lower === 'javascript' || lower === 'jsx' || lower === 'js') return 'js';
  if (lower === 'python' || lower === 'py') return 'py';
  if (lower === 'golang' || lower === 'go') return 'go';
  if (lower === 'rust' || lower === 'rs') return 'rs';
  if (lower === 'shell' || lower === 'bash' || lower === 'zsh' || lower === 'sh') return 'sh';
  if (lower === 'postgresql' || lower === 'mysql' || lower === 'sqlite' || lower === 'sql') return 'sql';
  return 'other';
}

function normalizeDomain(domain: string | undefined): string {
  return DOMAIN_DIMENSIONS.includes((domain || '') as typeof DOMAIN_DIMENSIONS[number])
    ? (domain as typeof DOMAIN_DIMENSIONS[number])
    : 'backend';
}

export function vectorizeDescriptor(descriptor: TaskDescriptor): number[] {
  const heuristic = descriptor.signals.heuristic;
  const learned = descriptor.signals.learned;
  const taskType = heuristic.task_type;
  const languages = new Set(heuristic.languages.map(normalizeLanguage));
  const domain = normalizeDomain(learned.domain);

  return [
    ...TASK_TYPE_DIMENSIONS.map((candidate) => Number(taskType === candidate)),
    ...LANGUAGE_DIMENSIONS.map((candidate) => Number(languages.has(candidate))),
    ...DOMAIN_DIMENSIONS.map((candidate) => Number(domain === candidate)),
    clamp((learned.complexity || 3) / 5, 0, 1),
    normalizeLogValue(heuristic.files_touched),
    normalizeLogValue(heuristic.repo_size_loc),
    normalizeLogValue(heuristic.description_tokens),
    Number(Boolean(heuristic.is_greenfield)),
    Number(Boolean(heuristic.has_migration)),
    Number(Boolean(heuristic.has_ui)),
    Number(Boolean(heuristic.has_tests)),
    Number(Boolean(heuristic.cross_service)),
    clamp((learned.risk_flags?.length || 0) / 6, 0, 1),
  ];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), 0, 1);
}

const descriptorCache = new Map<string, TaskDescriptor>();

function isTaskDescriptor(value: unknown): value is TaskDescriptor {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as TaskDescriptor).schema_version === '1.0' &&
    (value as TaskDescriptor).signals?.heuristic &&
    (value as TaskDescriptor).signals?.learned
  );
}

export function descriptorFromEvalRecord(record: EvalRecord): TaskDescriptor {
  const cached = descriptorCache.get(record.id);
  if (cached) {
    return cached;
  }

  const descriptor = isTaskDescriptor(record.taskDescriptor)
    ? record.taskDescriptor
    : buildTaskDescriptor({
        originalPrompt: record.originalPrompt,
        taskContext: record.taskContext,
        repoContext: record.repoContext,
        difficultySignals: record.difficultySignals,
        routingDecision: record.routingDecision,
        stageOutcomes: record.stageOutcomes,
        workflowCost: record.workflowCost,
        workflowTokenUsage: record.workflowTokenUsage,
        score: record.score,
        timeSeconds: record.timeSeconds,
        interventionCount: record.interventionCount,
        interventions: record.interventions,
        rubricEval: record.rubricEval,
      });

  descriptorCache.set(record.id, descriptor);
  return descriptor;
}

export function findKNearest(
  queryDescriptor: TaskDescriptor,
  records: EvalRecord[],
  k: number,
): ScoredNeighbor[] {
  if (records.length === 0 || k <= 0) {
    return [];
  }

  const queryVector = vectorizeDescriptor(queryDescriptor);

  return records
    .map((record) => {
      const descriptor = descriptorFromEvalRecord(record);
      return {
        record,
        descriptor,
        similarity: cosineSimilarity(queryVector, vectorizeDescriptor(descriptor)),
      } satisfies ScoredNeighbor;
    })
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.min(k, records.length));
}

function getHistoricalSources(repoDir: string, options: StageAwareOptions): HistoricalEvalSource[] {
  const sources: HistoricalEvalSource[] = [
    {
      path: resolve(repoDir, '.wavemill/evals/evals.jsonl'),
      kind: 'local',
      priority: 3,
    },
    {
      path: resolveFromMainRepo(options.backfilledEvalsPath || DEFAULT_BACKFILLED_EVALS_PATH, repoDir),
      kind: 'backfilled',
      priority: 2,
    },
    {
      path: resolveFromMainRepo(options.aggregatedEvalsPath || DEFAULT_AGGREGATED_EVALS_PATH, repoDir),
      kind: 'aggregated',
      priority: 1,
    },
    {
      path: resolveGlobalAggregatedEvalsPath(),
      kind: 'aggregated',
      priority: 1,
    },
  ];

  if (options.additionalEvalsPaths) {
    for (const additionalPath of options.additionalEvalsPaths) {
      sources.push({
        path: additionalPath,
        kind: 'aggregated',
        priority: 1,
      });
    }
  }

  return sources;
}

function historicalRecordKey(record: EvalRecord): string {
  if (typeof record.id === 'string' && record.id.length > 0) {
    return `id:${record.id}`;
  }

  return [
    record.issueId || 'no-issue',
    record.prUrl || 'no-pr',
    record.timestamp || 'no-timestamp',
    record.modelId || 'no-model',
    record.originalPrompt || 'no-prompt',
  ].join('|');
}

function countRecordSignals(record: EvalRecord): number {
  return Number(isTaskDescriptor(record.taskDescriptor))
    + Number(Boolean(record.stageOutcomes))
    + Number(Boolean(record.metadata?.stageScores))
    + Number(Boolean(record.workflowTokenUsage))
    + Number(typeof record.workflowCost === 'number')
    + Number(typeof record.score === 'number');
}

function shouldReplaceHistoricalRecord(
  current: { record: EvalRecord; source: HistoricalEvalSource },
  candidate: { record: EvalRecord; source: HistoricalEvalSource },
): boolean {
  const candidateSignals = countRecordSignals(candidate.record);
  const currentSignals = countRecordSignals(current.record);

  if (candidateSignals !== currentSignals) {
    return candidateSignals > currentSignals;
  }

  if (candidate.source.priority !== current.source.priority) {
    return candidate.source.priority > current.source.priority;
  }

  return candidate.record.timestamp > current.record.timestamp;
}

/**
 * Load and merge eval records from multiple sources (local, backfilled, aggregated).
 *
 * This function implements the core feedback loop: it merges records from all sources,
 * preferring richer/newer records when duplicates exist. Local records (highest priority)
 * win over aggregated data, ensuring newly completed work influences routing immediately.
 *
 * Deduplication uses historical record keys (repo+task+workflow), and replacement logic
 * prefers records with more signals, then higher-priority sources, then newer timestamps.
 */
export function loadStageAwareEvalRecords(options: StageAwareOptions = {}): EvalRecord[] {
  stageAwareRouterDebugState.evalLoadCount += 1;
  const repoDir = options.repoDir || process.cwd();
  const recordsByKey = new Map<string, { record: EvalRecord; source: HistoricalEvalSource }>();

  // Iterate through ALL sources and merge records (not first-wins)
  for (const source of getHistoricalSources(repoDir, options)) {
    if (!existsSync(source.path)) {
      continue;
    }

    const records = readJsonlFile<EvalRecord>(source.path);
    for (const record of records) {
      const key = historicalRecordKey(record);
      const existing = recordsByKey.get(key);

      // Use priority-based replacement to prefer richer/newer records
      if (!existing || shouldReplaceHistoricalRecord(existing, { record, source })) {
        recordsByKey.set(key, { record, source });
      }
    }
  }

  return [...recordsByKey.values()].map(({ record }) => record);
}

export function loadStageAwareRouterContext(options: StageAwareOptions = {}): StageAwareRouterContext {
  const repoDir = options.repoDir || process.cwd();
  const partition = partitionEvidence(loadStageAwareEvalRecords({
    ...options,
    repoDir,
  }), 'router_history');
  if (partition.excluded.length > 0) {
    console.error(
      `Stage-aware router: excluded ${partition.excluded.length} held evidence record(s): ` +
      formatEvidenceExclusionSummary(partition.reasonCounts),
    );
  }

  return {
    repoDir,
    routerConfig: getRouterConfig(repoDir),
    records: partition.eligible,
  };
}

function stageScoreFromRecord(
  record: EvalRecord,
  stageKey: 'plan' | 'implementation' | 'review',
  stageBlendWeight: number,
): number {
  const metadataStageScores = record.metadata?.stageScores as Record<string, { score?: number }> | undefined;
  const metadataScore = metadataStageScores?.[stageKey]?.score;
  const outcomeScore = (record.stageOutcomes?.[stageKey] as StageOutcomes[keyof StageOutcomes] | undefined)?.score;
  const primary = typeof metadataScore === 'number'
    ? metadataScore
    : typeof outcomeScore === 'number'
      ? outcomeScore
      : undefined;

  if (typeof primary === 'number' && typeof record.score === 'number') {
    return clamp(primary * (1 - stageBlendWeight) + record.score * stageBlendWeight, 0, 1);
  }
  if (typeof primary === 'number') {
    return clamp(primary, 0, 1);
  }
  return clamp(typeof record.score === 'number' ? record.score : 0, 0, 1);
}

export function extractRubricScore(descriptor: TaskDescriptor): number | null {
  const rubric = descriptor.rubric;
  if (
    !rubric?.has_rubric ||
    rubric.criterion_count <= 0 ||
    typeof rubric.mean_score !== 'number' ||
    !Number.isFinite(rubric.mean_score)
  ) {
    return null;
  }

  return clamp(rubric.mean_score, 0, 1);
}

export function computeRubricCoverage(neighbors: ScoredNeighbor[]): number {
  if (neighbors.length === 0) {
    return 0;
  }

  const rubricCount = neighbors.filter((neighbor) => extractRubricScore(neighbor.descriptor) !== null).length;
  return rubricCount / neighbors.length;
}

function stageScoreFromRecordRubricAware(
  record: EvalRecord,
  stageKey: 'plan' | 'implementation' | 'review',
  stageBlendWeight: number,
  rubricWeight: number,
): number {
  const scalarScore = stageScoreFromRecord(record, stageKey, stageBlendWeight);
  const rubricScore = extractRubricScore(descriptorFromEvalRecord(record));

  if (rubricScore === null || rubricWeight <= 0) {
    return scalarScore;
  }

  return clamp(scalarScore * (1 - rubricWeight) + rubricScore * rubricWeight, 0, 1);
}

/**
 * Resolve the model that actually handled the given stage on this record.
 *
 * Returns `null` when the record has no real per-stage attribution. We do NOT
 * fall back to `record.modelId` here: that field is the solution/coder model,
 * and using it as the planner model pollutes plan-quality rankings by pinning
 * every legacy record's plan score to whoever coded. Callers that need
 * per-stage rankings should skip records that return null.
 */
function stageModelFromRecord(
  record: EvalRecord,
  role: 'planner' | 'coder' | 'reviewer',
): string | null {
  const descriptor = isTaskDescriptor(record.taskDescriptor) ? record.taskDescriptor : undefined;
  const stageModel = descriptor?.stages?.[role]?.model;
  if (typeof stageModel === 'string' && stageModel.length > 0) {
    return stageModel;
  }
  return null;
}

/**
 * Whether a record can contribute to all three per-stage rankings.
 *
 * Legacy records without stage attribution are valid KNN matches but get
 * skipped by aggregateRoleRanking, so letting them occupy the neighbor
 * window starves stage selection. Their pre-task-style descriptors (empty
 * languages, zero file counts) also make them spuriously similar to fresh
 * query descriptors, which are built before the task runs — so without
 * filtering they systematically crowd out every usable neighbor.
 */
export function hasFullStageAttribution(record: EvalRecord): boolean {
  return stageModelFromRecord(record, 'planner') !== null
    && stageModelFromRecord(record, 'coder') !== null
    && stageModelFromRecord(record, 'reviewer') !== null;
}

function stageCostFromRecord(
  record: EvalRecord,
  role: 'planner' | 'coder' | 'reviewer',
  modelId: string,
): number {
  const descriptor = isTaskDescriptor(record.taskDescriptor) ? record.taskDescriptor : undefined;
  const stageCost = descriptor?.stages?.[role]?.cost_usd;
  if (typeof stageCost === 'number') {
    return Math.max(0, stageCost);
  }

  const tokenUsage = record.workflowTokenUsage?.[modelId];
  if (tokenUsage) {
    return Math.max(0, tokenUsage.costUsd);
  }

  if (typeof record.workflowCost === 'number') {
    return Math.max(0, record.workflowCost);
  }

  return 0;
}

function resolveModelsForRole(
  constraints: StageAwareConstraints,
  role: 'planner' | 'coder' | 'reviewer',
): Set<string> | null {
  // Preserve historical behavior for runtime/API allowlist overrides:
  // a flat `modelsAvailable` constraint applies to every stage and wins
  // over repo-configured per-stage defaults.
  if (constraints.modelsAvailable && constraints.modelsAvailable.length > 0) {
    return new Set(constraints.modelsAvailable);
  }

  const stageModels = role === 'planner'
    ? constraints.plannerModelsAvailable
    : role === 'coder'
      ? constraints.coderModelsAvailable
      : constraints.reviewerModelsAvailable;

  if (stageModels && stageModels.length > 0) {
    return new Set(stageModels);
  }

  return null;
}

function resolveCapabilityConstraintsForRole(
  constraints: StageAwareConstraints,
  role: 'planner' | 'coder' | 'reviewer',
): CapabilityConstraints | undefined {
  const roleConstraints = role === 'planner'
    ? constraints.plannerCapabilityConstraints
    : role === 'coder'
      ? constraints.coderCapabilityConstraints
      : constraints.reviewerCapabilityConstraints;

  const merged = {
    ...constraints.capabilityConstraints,
    ...roleConstraints,
  };

  return hasCapabilityConstraints(merged) ? merged : undefined;
}

const STAGE_KEY_TO_TASK_TYPE: Record<'plan' | 'implementation' | 'review', RegistryTaskType> = {
  plan: 'planning',
  implementation: 'coding',
  review: 'review',
};

const STAGE_KEY_TO_COST_STAGE: Record<'plan' | 'implementation' | 'review', 'plan' | 'code' | 'review'> = {
  plan: 'plan',
  implementation: 'code',
  review: 'review',
};

function filterProviderModels(
  models: string[],
  repoDir?: string,
  stage?: 'planner' | 'coder' | 'reviewer',
): string[] {
  const deepSeekFiltered = filterDeepSeekModels(filterDisabledModels(models), repoDir, stage);
  const providerModels = filterOpenRouterModels(deepSeekFiltered.models, repoDir, stage).models;
  const registry = getEffectiveRegistry(repoDir);
  return providerModels.filter((modelId) => {
    const capabilities = registry.models[modelId];
    const identity = resolveModelIdentity(registry, modelId);
    if (identity.status === 'provisional' || identity.evidencePolicy === 'held') {
      return false;
    }
    return capabilities?.agent !== 'codex' || isCodexChatgptLaunchEligible(capabilities);
  });
}

function resolveSeedModelsForRole(
  allowedModels: Set<string> | null,
  role: 'planner' | 'coder' | 'reviewer',
  repoDir?: string,
): string[] {
  if (allowedModels) {
    // Upstream stage pools are already provider filtered.
    return [...allowedModels];
  }

  return filterProviderModels(getConfiguredModelsForDescriptorStage(repoDir, role), repoDir, role);
}

function aggregateRoleRanking(
  neighbors: ScoredNeighbor[],
  role: 'planner' | 'coder' | 'reviewer',
  stageKey: 'plan' | 'implementation' | 'review',
  constraints: StageAwareConstraints,
  stageBlendWeight: number,
  rubricWeight: number,
  repoDir?: string,
  explorationConfig?: ResolvedExplorationConfig,
): RoleRanking {
  const allowedModels = resolveModelsForRole(constraints, role);
  const byModel = new Map<string, { scoreWeight: number; weightedScore: number; costWeight: number; weightedCost: number; support: number }>();

  for (const neighbor of neighbors) {
    const modelId = stageModelFromRecord(neighbor.record, role);
    if (modelId === null) {
      // Record has no real per-stage attribution. Skipping here prevents
      // legacy records from mis-attributing plan/code/review scores to their
      // solution/coder model.
      continue;
    }
    // Historical records can reference since-disabled models; configured
    // pools are filtered upstream, but record-derived candidates are not.
    if (isDisabledModel(modelId)) {
      continue;
    }
    if (allowedModels && !allowedModels.has(modelId)) {
      continue;
    }

    const bucket = byModel.get(modelId) || {
      scoreWeight: 0,
      weightedScore: 0,
      costWeight: 0,
      weightedCost: 0,
      support: 0,
    };
    const similarityWeight = Math.max(neighbor.similarity, 0.001);
    const stageScore = rubricWeight > 0
      ? stageScoreFromRecordRubricAware(neighbor.record, stageKey, stageBlendWeight, rubricWeight)
      : stageScoreFromRecord(neighbor.record, stageKey, stageBlendWeight);
    const stageCost = stageCostFromRecord(neighbor.record, role, modelId);

    bucket.scoreWeight += similarityWeight;
    bucket.weightedScore += similarityWeight * stageScore;
    bucket.costWeight += similarityWeight;
    bucket.weightedCost += similarityWeight * stageCost;
    bucket.support += 1;
    byModel.set(modelId, bucket);
  }

  const priorsEnabled = explorationConfig?.priorsEnabled === true;
  const ucbConstant = explorationConfig?.ucbConstant ?? 0;

  // Seed every eligible model into the candidate set so zero-record models
  // can rank via their registry prior instead of being invisible to the KNN.
  if (priorsEnabled) {
    for (const modelId of resolveSeedModelsForRole(allowedModels, role, repoDir)) {
      if (!byModel.has(modelId)) {
        byModel.set(modelId, { scoreWeight: 0, weightedScore: 0, costWeight: 0, weightedCost: 0, support: 0 });
      }
    }
  }

  const priorRegistry = priorsEnabled ? getEffectiveRegistry(repoDir) : null;
  const taskType = STAGE_KEY_TO_TASK_TYPE[stageKey];
  const totalObservations = neighbors.length;

  const candidates = [...byModel.entries()]
    .map(([modelId, aggregate]) => {
      const empirical = aggregate.scoreWeight > 0 ? aggregate.weightedScore / aggregate.scoreWeight : 0;
      const score = priorRegistry
        ? blendWithPrior(
            empirical,
            clamp((priorRegistry.models[modelId]?.qualityScores[taskType] ?? 0) / 100, 0, 1),
            aggregate.support,
            explorationConfig?.priorBlendSamples ?? 1,
          )
        : empirical;
      const observedCost = aggregate.costWeight > 0 ? aggregate.weightedCost / aggregate.costWeight : 0;
      const cost = aggregate.support === 0 && observedCost === 0
        ? estimateFallbackStageCost(modelId, STAGE_KEY_TO_COST_STAGE[stageKey], repoDir)
        : observedCost;

      return {
        modelId,
        score,
        cost,
        support: aggregate.support,
        selectionScore: score + ucbBonus(ucbConstant, totalObservations, aggregate.support),
      };
    })
    .sort((left, right) => {
      if (right.selectionScore !== left.selectionScore) return right.selectionScore - left.selectionScore;
      if (left.cost !== right.cost) return left.cost - right.cost;
      return right.support - left.support;
    });

  const capabilityConstraints = resolveCapabilityConstraintsForRole(constraints, role);
  if (!capabilityConstraints || candidates.length === 0) {
    return { role, stageKey, candidates };
  }

  const registry = getEffectiveRegistry(repoDir);
  const constrainedCandidates = candidates.filter((candidate) => {
    const capabilities = registry.models[candidate.modelId];
    return capabilities && evaluateCapabilityConstraints(capabilities, capabilityConstraints).satisfied;
  });

  if (constrainedCandidates.length > 0) {
    return { role, stageKey, candidates: constrainedCandidates };
  }

  return {
    role,
    stageKey,
    candidates,
    capabilityFallbackUsed: true,
  };
}

function pickBestCombination(rankings: RoleRanking[], maxCostUsd?: number): CombinationDecision | null {
  if (rankings.some((ranking) => ranking.candidates.length === 0)) {
    return null;
  }

  // Combinations are ranked by selectionScore (prior-blended score plus UCB
  // bonus) so undersampled models can win, while expectedSuccess reports the
  // bonus-free score. The two are identical when priors and UCB are disabled.
  let best: CombinationDecision | null = null;
  let bestSelection = -Infinity;
  for (const planner of rankings[0].candidates) {
    for (const coder of rankings[1].candidates) {
      for (const reviewer of rankings[2].candidates) {
        const expectedCost = planner.cost + coder.cost + reviewer.cost;
        if (typeof maxCostUsd === 'number' && expectedCost > maxCostUsd) {
          continue;
        }

        const selectionValue = (planner.selectionScore + coder.selectionScore + reviewer.selectionScore) / 3;
        const expectedSuccess = clamp((planner.score + coder.score + reviewer.score) / 3, 0, 1);
        if (
          !best ||
          selectionValue > bestSelection ||
          (selectionValue === bestSelection && expectedCost < best.expectedCost)
        ) {
          best = { planner, coder, reviewer, expectedCost, expectedSuccess };
          bestSelection = selectionValue;
        }
      }
    }
  }

  return best;
}

/**
 * Apply exploration sampling to the exploit (argmax) combination.
 *
 * Each role samples independently from its already-filtered candidate
 * ranking. A sampled combination that violates maxCostUsd reverts to the
 * exploit selection so exploration can never break the budget contract.
 */
function exploreSelection(
  rankings: RoleRanking[],
  exploit: CombinationDecision,
  config: ResolvedExplorationConfig,
  maxCostUsd: number | undefined,
  randomFn: () => number,
  boostFor: (modelId: string) => number = () => 1,
): { selection: CombinationDecision; attribution: ExplorationAttribution } {
  const sampled: Record<'planner' | 'coder' | 'reviewer', ModelStageStats> = {
    planner: exploit.planner,
    coder: exploit.coder,
    reviewer: exploit.reviewer,
  };
  const explored: ExplorationAttribution['explored'] = [];

  for (const ranking of rankings) {
    const pick = sampleCandidateIndex(
      ranking.candidates.map((candidate) => candidate.selectionScore),
      config,
      randomFn,
      ranking.candidates.map((candidate) => boostFor(candidate.modelId)),
    );
    const candidate = ranking.candidates[pick.index];
    const exploitModel = sampled[ranking.role].modelId;
    if (!pick.explored || !candidate || candidate.modelId === exploitModel) {
      continue;
    }
    sampled[ranking.role] = candidate;
    explored.push({
      role: ranking.role,
      sampled: candidate.modelId,
      argmax: exploitModel,
      ...(boostFor(candidate.modelId) > 1 ? { recencyBoosted: true } : {}),
    });
  }

  if (explored.length === 0) {
    return { selection: exploit, attribution: { mode: config.mode, explored } };
  }

  const expectedCost = sampled.planner.cost + sampled.coder.cost + sampled.reviewer.cost;
  if (typeof maxCostUsd === 'number' && expectedCost > maxCostUsd) {
    return {
      selection: exploit,
      attribution: { mode: config.mode, explored: [], costGuardReverted: true },
    };
  }

  return {
    selection: {
      planner: sampled.planner,
      coder: sampled.coder,
      reviewer: sampled.reviewer,
      expectedCost,
      expectedSuccess: clamp((sampled.planner.score + sampled.coder.score + sampled.reviewer.score) / 3, 0, 1),
    },
    attribution: { mode: config.mode, explored },
  };
}

function choosePlanDepthFromSuccess(expectedSuccess: number): PlanDepth {
  return expectedSuccess >= 0.85 ? 'deep' : 'light';
}

function chooseCodeDepthFromSuccess(expectedSuccess: number): CodeDepth {
  if (expectedSuccess >= 0.88) return 'deep';
  if (expectedSuccess >= 0.72) return 'medium';
  return 'light';
}

function chooseReviewModeFromSuccess(expectedSuccess: number): ReviewMode {
  if (expectedSuccess >= 0.85) return 'static+llm';
  if (expectedSuccess >= 0.65) return 'llm';
  return 'static';
}

export function rankModelsPerStage(
  neighbors: ScoredNeighbor[],
  constraints: StageAwareConstraints = {},
  stageBlendWeight = DEFAULT_STAGE_BLEND_WEIGHT,
  rubricWeight = 0,
  repoDir?: string,
  explorationConfig?: ResolvedExplorationConfig,
): {
  rankings: RoleRanking[];
  selection: CombinationDecision | null;
} {
  const boundedRubricWeight = clamp(rubricWeight, 0, 1);
  const rankings = [
    aggregateRoleRanking(neighbors, 'planner', 'plan', constraints, stageBlendWeight, boundedRubricWeight, repoDir, explorationConfig),
    aggregateRoleRanking(neighbors, 'coder', 'implementation', constraints, stageBlendWeight, boundedRubricWeight, repoDir, explorationConfig),
    aggregateRoleRanking(neighbors, 'reviewer', 'review', constraints, stageBlendWeight, boundedRubricWeight, repoDir, explorationConfig),
  ];

  return {
    rankings,
    selection: pickBestCombination(rankings, constraints.maxCostUsd),
  };
}

function estimateFallbackStageCost(
  modelId: string,
  stage: 'plan' | 'code' | 'review',
  repoDir?: string,
): number {
  const pricing = loadPricingTable(repoDir)[modelId];
  if (!pricing) {
    return 0;
  }

  const profiles = {
    plan: { inputTokens: 35_000, cacheCreationTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 5_000 },
    code: { inputTokens: 850_000, cacheCreationTokens: 260_000, cacheReadTokens: 700_000, outputTokens: 35_000 },
    review: { inputTokens: 95_000, cacheCreationTokens: 25_000, cacheReadTokens: 80_000, outputTokens: 8_000 },
  } as const;

  return computeModelCost(profiles[stage], pricing);
}

function buildStageAwareDecision(
  selection: CombinationDecision,
  neighbors: ScoredNeighbor[],
  kNeighbors: number,
  repoDir?: string,
): StageAwareDecision {
  const similarities = neighbors.map((neighbor) => neighbor.similarity);
  const similarityRange: [number, number] = similarities.length > 0
    ? [Math.min(...similarities), Math.max(...similarities)]
    : [0, 0];
  const meanSimilarity = similarities.length > 0
    ? similarities.reduce((sum, similarity) => sum + similarity, 0) / similarities.length
    : 0.5;
  const neighborFactor = kNeighbors > 0
    ? clamp(neighbors.length / kNeighbors, 0, 1)
    : 0.5;
  const confidence = clamp(neighborFactor * 0.4 + meanSimilarity * 0.6, 0.1, 0.95);

  const expectedCostPlan = selection.planner.cost || estimateFallbackStageCost(selection.planner.modelId, 'plan', repoDir);
  const expectedCostCode = selection.coder.cost || estimateFallbackStageCost(selection.coder.modelId, 'code', repoDir);
  const expectedCostReview = selection.reviewer.cost || estimateFallbackStageCost(selection.reviewer.modelId, 'review', repoDir);

  return {
    planner: selection.planner.modelId,
    coder: selection.coder.modelId,
    reviewer: selection.reviewer.modelId,
    planDepth: choosePlanDepthFromSuccess(selection.planner.score),
    codeDepth: chooseCodeDepthFromSuccess(selection.coder.score),
    reviewRecommended: chooseReviewModeFromSuccess(selection.reviewer.score),
    expectedSuccess: Number(selection.expectedSuccess.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    expectedCostPlan: Number(expectedCostPlan.toFixed(2)),
    expectedCostCode: Number(expectedCostCode.toFixed(2)),
    expectedCostReview: Number(expectedCostReview.toFixed(2)),
    expectedCost: Number((expectedCostPlan + expectedCostCode + expectedCostReview).toFixed(2)),
    reasoning: [
      `Stage-aware routing used ${neighbors.length} similar historical tasks.`,
      `Similarity range ${similarityRange[0].toFixed(2)}-${similarityRange[1].toFixed(2)} across nearest neighbors.`,
      `Planner=${selection.planner.modelId}, coder=${selection.coder.modelId}, reviewer=${selection.reviewer.modelId} maximize weighted per-stage scores.`,
      `Expected success ${(selection.expectedSuccess * 100).toFixed(0)}% with estimated workflow cost $${(expectedCostPlan + expectedCostCode + expectedCostReview).toFixed(2)}.`,
    ],
    signals: {
      taskType: 'unknown',
      promptLength: 'medium',
      complexityScore: 0,
      fileTypes: [],
      riskScore: 0,
    },
    routingMode: 'stage-aware',
    neighborCount: neighbors.length,
    neighborSimilarityRange: [
      Number(similarityRange[0].toFixed(2)),
      Number(similarityRange[1].toFixed(2)),
    ],
  };
}

function prependRubricReasoning(decision: StageAwareDecision, message: string): StageAwareDecision {
  decision.reasoning = [message, ...decision.reasoning];
  return decision;
}

function prependCapabilityFallbackReasoning(
  decision: StageAwareDecision,
  rankings: RoleRanking[],
): StageAwareDecision {
  const fallbackRoles = rankings
    .filter((ranking) => ranking.capabilityFallbackUsed)
    .map((ranking) => ranking.role);
  if (fallbackRoles.length === 0) {
    return decision;
  }

  decision.reasoning = [
    `capability-filter-empty-fallback: ${fallbackRoles.join(', ')} reverted to the unfiltered stage-aware ranking.`,
    ...decision.reasoning,
  ];
  return decision;
}

export function routeStageAware(
  prompt: string,
  options: StageAwareOptions = {},
): StageAwareDecision | null {
  const context = loadStageAwareRouterContext(options);
  return routeStageAwareWithContext(prompt, context, options);
}

export function routeStageAwareWithContext(
  prompt: string,
  context: StageAwareRouterContext,
  options: StageAwareOptions = {},
): StageAwareDecision | null {
  const { repoDir, routerConfig, records } = context;
  const plannerModels = filterProviderModels(listEffectiveModelsForStage('planner', { repoDir }).models, repoDir, 'planner');
  const coderModels = filterProviderModels(listEffectiveModelsForStage('coder', { repoDir }).models, repoDir, 'coder');
  const reviewerModels = filterProviderModels(listEffectiveModelsForStage('reviewer', { repoDir }).models, repoDir, 'reviewer');
  const filteredModelsAvailable = filterProviderModels(options.modelsAvailable || [], repoDir);
  const filteredPlannerOptions = filterProviderModels(options.plannerModelsAvailable || [], repoDir, 'planner');
  const filteredCoderOptions = filterProviderModels(options.coderModelsAvailable || [], repoDir, 'coder');
  const filteredReviewerOptions = filterProviderModels(options.reviewerModelsAvailable || [], repoDir, 'reviewer');
  const kNeighbors = options.kNeighbors || routerConfig.kNeighbors || DEFAULT_K_NEIGHBORS;
  const minRecords = options.minRecords || routerConfig.minRecords || DEFAULT_MIN_RECORDS;
  const minModels = options.minModels || routerConfig.minModels || DEFAULT_MIN_MODELS;
  const stageBlendWeight = clamp(
    options.stageBlendWeight ?? routerConfig.stageBlendWeight ?? DEFAULT_STAGE_BLEND_WEIGHT,
    0,
    1,
  );
  const rubricAwareMode = routerConfig.rubricAware?.mode || 'off';
  const rubricAwareMinCoverage = clamp(
    routerConfig.rubricAware?.minCoverage ?? DEFAULT_RUBRIC_AWARE_MIN_COVERAGE,
    0,
    1,
  );
  const rubricAwareWeight = clamp(
    routerConfig.rubricAware?.weight ?? DEFAULT_RUBRIC_AWARE_WEIGHT,
    0,
    1,
  );
  const descriptorModelsAvailable = options.modelsAvailable ?? getConfiguredModelsForDescriptor(repoDir);
  const queryDescriptor = buildTaskDescriptor({
    originalPrompt: prompt,
    modelsAvailable: descriptorModelsAvailable,
    maxCostUsd: options.maxCostUsd,
    ...options.queryInput,
  });

  if (records.length < minRecords) {
    return null;
  }

  // Restrict the KNN pool to records that can actually feed per-stage
  // rankings. Fall back to the full corpus only when too few attributed
  // records exist (young repos keep their previous behavior).
  const rankableRecords = records.filter(hasFullStageAttribution);
  const knnRecords = rankableRecords.length >= minRecords ? rankableRecords : records;

  const neighbors = findKNearest(queryDescriptor, knnRecords, kNeighbors);
  if (neighbors.length === 0) {
    return null;
  }

  const distinctNeighborModels = new Set(neighbors.map((neighbor) => neighbor.record.modelId));
  const hasModelDiversity = distinctNeighborModels.size >= minModels;
  const rubricCoverage = computeRubricCoverage(neighbors);
  const rubricCoverageLabel = rubricCoverage.toFixed(2);
  const rubricWeightLabel = Number(rubricAwareWeight.toFixed(2)).toString();
  const rubricFallbackReason = `rubric-aware fallback: coverage ${rubricCoverageLabel} < minCoverage ${rubricAwareMinCoverage.toFixed(2)}`;
  const rubricActiveReason = `rubric-aware (mode=${rubricAwareMode}, coverage=${rubricCoverageLabel}, weight=${rubricWeightLabel})`;
  const rubricHasSufficientCoverage = rubricCoverage >= rubricAwareMinCoverage;
  const rubricScoringWeight = rubricAwareMode === 'on' && rubricHasSufficientCoverage ? rubricAwareWeight : 0;
  const explorationConfig = resolveExplorationConfig(routerConfig.exploration);

  const constrainedRanking = rankModelsPerStage(neighbors, {
    modelsAvailable: filteredModelsAvailable,
    plannerModelsAvailable: filteredPlannerOptions.length > 0 ? filteredPlannerOptions : plannerModels,
    coderModelsAvailable: filteredCoderOptions.length > 0 ? filteredCoderOptions : coderModels,
    reviewerModelsAvailable: filteredReviewerOptions.length > 0 ? filteredReviewerOptions : reviewerModels,
    capabilityConstraints: options.capabilityConstraints,
    plannerCapabilityConstraints: options.plannerCapabilityConstraints,
    coderCapabilityConstraints: options.coderCapabilityConstraints,
    reviewerCapabilityConstraints: options.reviewerCapabilityConstraints,
    maxCostUsd: options.maxCostUsd,
  }, stageBlendWeight, rubricScoringWeight, repoDir, explorationConfig);
  const { rankings, selection } = constrainedRanking;

  if (!selection) {
    const hasModelConstraints =
      filteredModelsAvailable.length > 0 ||
      filteredPlannerOptions.length > 0 ||
      filteredCoderOptions.length > 0 ||
      filteredReviewerOptions.length > 0 ||
      plannerModels.length > 0 ||
      coderModels.length > 0 ||
      reviewerModels.length > 0;
    if (!hasModelConstraints) {
      return null;
    }

    // Preserve stage/depth calibration from similar tasks even when the active
    // model allowlist filters every neighbor out of stage selection. Priors
    // are deliberately omitted here: this ranking only calibrates depth/cost.
    const { selection: unconstrainedSelection } = rankModelsPerStage(neighbors, {
      maxCostUsd: options.maxCostUsd,
    }, stageBlendWeight, rubricScoringWeight, repoDir);
    if (!unconstrainedSelection) {
      return null;
    }

    const partialDecision = buildStageAwareDecision(
      unconstrainedSelection,
      neighbors,
      kNeighbors,
      repoDir,
    );
    if (options.maxCostUsd !== undefined) {
      partialDecision.constraints = { maxCostUsd: options.maxCostUsd };
    }
    partialDecision.routingMode = 'stage-aware-partial';
    partialDecision.confidence = Number((clamp(partialDecision.confidence * 0.8, 0.1, 0.95)).toFixed(2));
    prependCapabilityFallbackReasoning(partialDecision, rankings);
    if (rubricAwareMode === 'on') {
      prependRubricReasoning(
        partialDecision,
        rubricHasSufficientCoverage ? rubricActiveReason : rubricFallbackReason,
      );
    }
    return partialDecision;
  }

  // Exploration only applies to full stage-aware decisions: partial decisions
  // get their models overlaid by heuristic selection downstream, so sampling
  // here would be discarded.
  let finalSelection = selection;
  let explorationAttribution: ExplorationAttribution | undefined;
  if (explorationConfig.enabled && hasModelDiversity) {
    const boostRegistry = explorationConfig.boostMultiplier > 1 ? getEffectiveRegistry(repoDir) : null;
    const explorationResult = exploreSelection(
      rankings,
      selection,
      explorationConfig,
      options.maxCostUsd,
      options.randomFn || Math.random,
      (modelId) => boostRegistry
        ? recencyMultiplier(boostRegistry.models[modelId]?.releasedAt, explorationConfig, options.nowMs)
        : 1,
    );
    finalSelection = explorationResult.selection;
    explorationAttribution = explorationResult.attribution;
  }

  const decision = buildStageAwareDecision(finalSelection, neighbors, kNeighbors, repoDir);
  if (explorationAttribution) {
    decision.exploration = explorationAttribution;
    if (explorationAttribution.explored.length > 0 || explorationAttribution.costGuardReverted) {
      decision.reasoning = [
        formatExplorationReasoning(explorationAttribution, explorationConfig),
        ...decision.reasoning,
      ];
    }
  }
  if (options.maxCostUsd !== undefined) {
    decision.constraints = { maxCostUsd: options.maxCostUsd };
  }
  prependCapabilityFallbackReasoning(decision, rankings);

  // When neighbors lack model diversity, use neighbor data for stage calibration
  // (depth, review mode, cost estimates) but mark the decision as partial so the
  // caller can overlay heuristic model selection.
  if (!hasModelDiversity) {
    decision.routingMode = 'stage-aware-partial';
    decision.confidence = Number((clamp(decision.confidence * 0.8, 0.1, 0.95)).toFixed(2));
  }

  if (rubricAwareMode === 'on') {
    prependRubricReasoning(
      decision,
      rubricHasSufficientCoverage ? rubricActiveReason : rubricFallbackReason,
    );
  }

  return decision;
}
