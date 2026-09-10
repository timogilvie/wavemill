/**
 * Challenge scheduling policy for exploration-driven routing.
 *
 * Produces advisory recommendations only. It does not launch challenges or
 * mutate any persisted state.
 *
 * @module challenge-scheduler
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { getRouterConfig } from './config.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import { listEffectiveModelsForStage } from './effective-models.ts';
import { isWithinRecencyWindow, resolveExplorationConfig } from './router-exploration.ts';
import { getLaunchPriorityByAlias } from './challenge-coverage-selector.ts';
import { loadConfiguredPricingTable } from './workflow-cost.ts';
import type { StageAwareDecision } from './stage-aware-router.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';
import { filterDisabledModels } from './disabled-models.ts';
import { partitionEvidence } from './model-evidence-policy.ts';
import { isStageAttributionEligibleForCoverage } from './challenge-execution-contract.ts';

export type ChallengeReason = 'low-confidence' | 'new-model' | 'low-data-stage' | 'disabled';
export type ChallengeStage = 'plan' | 'implementation' | 'review';

export interface ChallengeRecommendation {
  shouldChallenge: boolean;
  reason: ChallengeReason;
  challengerModel?: string;
  defaultModel?: string;
  stage?: ChallengeStage;
  priority: number;
}

export interface ChallengeSchedulerConfig {
  enabled?: boolean;
  confidenceThreshold?: number;
  newModelChallengeCount?: number;
  minEvalRecordsPerStage?: number;
  maxConcurrentChallenges?: number;
}

export interface EvalSummary {
  totalRecords: number;
  excludedRecords?: number;
  exclusionReasonCounts?: Record<string, number>;
  recordsByModel: Record<string, number>;
  recordsByStage: Record<string, number>;
  /**
   * Cross product of model x stage record counts, attributed from
   * `taskDescriptor.stages.*.model`. Optional for hand-built summaries;
   * `buildEvalSummary` always fills it. Missing cells count as zero.
   */
  recordsByModelStage?: Record<string, Partial<Record<ChallengeStage, number>>>;
}

export function modelStageCount(
  summary: EvalSummary,
  model: string,
  stage: ChallengeStage,
): number {
  return summary.recordsByModelStage?.[model]?.[stage] ?? 0;
}

export interface ChallengeSchedulerInput {
  routingDecision: WorkflowRouteDecision | StageAwareDecision;
  evalSummary: EvalSummary;
  config: ChallengeSchedulerConfig;
  /**
   * Explicit challenger pool. When supplied, recommendations must stay in
   * this pool rather than drawing from every priced routing model.
   */
  challengeModels?: string[] | null;
  repoDir?: string;
  forceModel?: string;
}

const DEFAULT_CHALLENGE_SCHEDULER_CONFIG: Required<ChallengeSchedulerConfig> = {
  enabled: true,
  confidenceThreshold: 0.7,
  newModelChallengeCount: 5,
  minEvalRecordsPerStage: 10,
  maxConcurrentChallenges: 2,
};

const PRIORITY = {
  'new-model': 300,
  'low-data-stage': 200,
  'low-confidence': 100,
  disabled: 0,
} as const satisfies Record<ChallengeReason, number>;

const STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];
const evalSummaryCache = new Map<string, EvalSummary>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfig(config: ChallengeSchedulerConfig): Required<ChallengeSchedulerConfig> {
  return {
    enabled: config.enabled ?? DEFAULT_CHALLENGE_SCHEDULER_CONFIG.enabled,
    confidenceThreshold: Number.isFinite(config.confidenceThreshold)
      ? clamp(config.confidenceThreshold as number, 0, 1)
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.confidenceThreshold,
    newModelChallengeCount: Number.isInteger(config.newModelChallengeCount) && (config.newModelChallengeCount as number) > 0
      ? config.newModelChallengeCount as number
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.newModelChallengeCount,
    minEvalRecordsPerStage: Number.isInteger(config.minEvalRecordsPerStage) && (config.minEvalRecordsPerStage as number) > 0
      ? config.minEvalRecordsPerStage as number
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.minEvalRecordsPerStage,
    maxConcurrentChallenges: Number.isInteger(config.maxConcurrentChallenges) && (config.maxConcurrentChallenges as number) > 0
      ? config.maxConcurrentChallenges as number
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.maxConcurrentChallenges,
  };
}

function getDecisionModel(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  stage?: ChallengeStage,
): string {
  if (stage === 'plan') return routingDecision.planner;
  if (stage === 'review') return routingDecision.reviewer;
  return routingDecision.coder;
}

function getDefaultModel(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  repoDir?: string,
): string {
  const registry = getEffectiveRegistry(repoDir);
  return registry.ladders.coding?.[0] || routingDecision.coder;
}

function getAvailableModels(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  repoDir?: string,
  challengeModels?: string[] | null,
): string[] {
  if (challengeModels && challengeModels.length > 0) {
    return filterDisabledModels([...new Set(challengeModels)]);
  }

  const pricingModels = Object.keys(loadConfiguredPricingTable(repoDir));
  return filterDisabledModels([...new Set([
    ...listEffectiveModelsForStage('coding', { repoDir }).models,
    routingDecision.planner,
    routingDecision.coder,
    routingDecision.reviewer,
  ].filter(Boolean))]);
}

/**
 * Restrict exploration candidates to non-incumbent launch-priority families
 * whenever any are available, mirroring `selectLeastUsedChallenger`.
 *
 * Exploration exists to buy coverage for models that do not already dominate
 * the corpus, so a `claude`/`gpt` candidate should only win when nothing else
 * is eligible. Without this the count and name tiebreaks below hand every
 * zero-coverage cell to a `claude-*` model on alphabetical order alone.
 */
function preferNonIncumbents(models: string[]): string[] {
  const launchPriority = getLaunchPriorityByAlias();
  const preferred = models.filter((model) => launchPriority.get(model)?.isIncumbent === false);
  return preferred.length > 0 ? preferred : models;
}

/**
 * Launch-priority tier for a model, with unlisted models sorting last.
 */
function priorityTier(model: string): number {
  return getLaunchPriorityByAlias().get(model)?.priorityTier ?? Number.POSITIVE_INFINITY;
}

/**
 * Compare two equally-covered candidates: lower launch-priority tier first,
 * then model name for a stable, reproducible result.
 */
function compareByPriority(left: string, right: string): number {
  const tierDelta = priorityTier(left) - priorityTier(right);
  if (tierDelta !== 0) {
    return tierDelta;
  }
  return left.localeCompare(right);
}

function chooseLeastTestedModel(
  models: string[],
  recordsByModel: Record<string, number>,
  excludedModels: string[],
): string | undefined {
  const excluded = new Set(excludedModels.filter(Boolean));
  const candidates = preferNonIncumbents([...new Set(models.filter((model) => !excluded.has(model)))]);
  return candidates
    .sort((left, right) => {
      const leftCount = recordsByModel[left] ?? 0;
      const rightCount = recordsByModel[right] ?? 0;
      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }
      return compareByPriority(left, right);
    })[0];
}

function chooseLeastTestedModelForStage(
  models: string[],
  summary: EvalSummary,
  stage: ChallengeStage,
  excludedModels: string[],
): string | undefined {
  const excluded = new Set(excludedModels.filter(Boolean));
  const candidates = preferNonIncumbents([...new Set(models.filter((model) => !excluded.has(model)))]);
  return candidates
    .sort((left, right) => {
      const leftCount = modelStageCount(summary, left, stage);
      const rightCount = modelStageCount(summary, right, stage);
      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }
      // Stage-blind counts as a secondary signal, then launch priority
      const leftTotal = summary.recordsByModel[left] ?? 0;
      const rightTotal = summary.recordsByModel[right] ?? 0;
      if (leftTotal !== rightTotal) {
        return leftTotal - rightTotal;
      }
      return compareByPriority(left, right);
    })[0];
}

/**
 * Find the least-covered (model, stage) cell among the available models,
 * considering only cells below `maxRecords`.
 *
 * Candidates are narrowed to non-incumbent launch-priority families whenever
 * any are available, so a zero-coverage `claude-*` cell cannot outrank an
 * equally uncovered `glm`/`qwen`/`kimi` one on name order alone. Within that
 * pool, recently released models (releasedAt inside the recency window) take
 * priority over older under-covered models regardless of count — an old,
 * deliberately unused model should not dominate exploration. Remaining ties
 * break by lower count, then launch-priority tier, then model name, then stage
 * order — deterministic for tests and idempotent runs.
 *
 * `isStageEligible` keeps a cell out of the running when the model cannot
 * actually serve that stage's role; without it the scheduler can recommend a
 * coder-only model as a planner, which downstream filters then discard.
 */
function leastCoveredModelStage(
  models: string[],
  summary: EvalSummary,
  maxRecords: number,
  excludedModels: string[],
  isRecent: (model: string) => boolean = () => false,
  isStageEligible: (model: string, stage: ChallengeStage) => boolean = () => true,
): { model: string; stage: ChallengeStage; count: number; recent: boolean } | null {
  const excluded = new Set(excludedModels.filter(Boolean));
  const candidates = preferNonIncumbents(
    [...new Set(models)].filter((model) => !excluded.has(model)),
  ).sort(compareByPriority);
  let best: { model: string; stage: ChallengeStage; count: number; recent: boolean } | null = null;

  for (const model of candidates) {
    const recent = isRecent(model);
    for (const stage of STAGES) {
      if (!isStageEligible(model, stage)) {
        continue;
      }
      const count = modelStageCount(summary, model, stage);
      if (count >= maxRecords) {
        continue;
      }
      if (
        !best
        || (recent && !best.recent)
        || (recent === best.recent && count < best.count)
      ) {
        best = { model, stage, count, recent };
      }
    }
  }

  return best;
}

function makeRecencyChecker(repoDir?: string): (model: string) => boolean {
  const explorationConfig = resolveExplorationConfig(getRouterConfig(repoDir).exploration);
  const registry = getEffectiveRegistry(repoDir);
  return (model: string) => isWithinRecencyWindow(
    registry.models[model]?.releasedAt,
    explorationConfig.boostWindowDays,
  );
}

const CHALLENGE_STAGE_TO_MODEL_STAGE: Record<ChallengeStage, 'planning' | 'coding' | 'review'> = {
  plan: 'planning',
  implementation: 'coding',
  review: 'review',
};

/**
 * Build a `(model, stage)` eligibility predicate from the effective per-stage
 * model lists, computed once per call rather than per cell.
 */
function makeStageEligibilityChecker(
  repoDir?: string,
): (model: string, stage: ChallengeStage) => boolean {
  const byStage = new Map<ChallengeStage, Set<string>>();
  for (const stage of STAGES) {
    byStage.set(
      stage,
      new Set(listEffectiveModelsForStage(CHALLENGE_STAGE_TO_MODEL_STAGE[stage], { repoDir }).models),
    );
  }
  return (model, stage) => byStage.get(stage)?.has(model) ?? false;
}

function checkLowConfidence(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  recordsByModel: Record<string, number>,
  threshold: number,
  availableModels: string[],
  repoDir?: string,
): ChallengeRecommendation | null {
  const confidence = Number.isFinite(routingDecision.confidence)
    ? clamp(routingDecision.confidence, 0, 1)
    : 0.5;

  if (confidence >= threshold) {
    return null;
  }

  const primaryModel = routingDecision.coder;
  const defaultModel = getDefaultModel(routingDecision, repoDir);
  const challengerModel = defaultModel !== primaryModel
    ? defaultModel
    : chooseLeastTestedModel(availableModels, recordsByModel, [primaryModel]);

  if (!challengerModel || challengerModel === primaryModel) {
    return null;
  }

  return {
    shouldChallenge: true,
    reason: 'low-confidence',
    defaultModel: primaryModel,
    challengerModel,
    priority: PRIORITY['low-confidence'],
  };
}

function checkNewModel(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  summary: EvalSummary,
  maxRecords: number,
  availableModels: string[],
  repoDir?: string,
): ChallengeRecommendation | null {
  const defaultModel = getDefaultModel(routingDecision, repoDir);

  // Prefer the truly least-covered (model, stage) cell when per-stage counts
  // are available; a model with 30 coder records but zero review records is
  // still uncovered for review. Recently released models take priority.
  if (summary.recordsByModelStage) {
    const cell = leastCoveredModelStage(
      availableModels,
      summary,
      maxRecords,
      [defaultModel],
      makeRecencyChecker(repoDir),
      makeStageEligibilityChecker(repoDir),
    );
    if (!cell) {
      return null;
    }
    return {
      shouldChallenge: true,
      reason: 'new-model',
      defaultModel,
      challengerModel: cell.model,
      stage: cell.stage,
      priority: PRIORITY['new-model'],
    };
  }

  const recordsByModel = summary.recordsByModel;
  const challengerModel = [...new Set(availableModels)]
    .filter((model) => model !== defaultModel && (recordsByModel[model] ?? 0) < maxRecords)
    .sort((left, right) => {
      const leftCount = recordsByModel[left] ?? 0;
      const rightCount = recordsByModel[right] ?? 0;
      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }
      return left.localeCompare(right);
    })[0];

  if (!challengerModel) {
    return null;
  }

  return {
    shouldChallenge: true,
    reason: 'new-model',
    defaultModel,
    challengerModel,
    priority: PRIORITY['new-model'],
  };
}

function checkLowDataStage(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  summary: EvalSummary,
  minEvalRecordsPerStage: number,
  availableModels: string[],
  repoDir?: string,
): ChallengeRecommendation | null {
  const lowStage = STAGES
    .map((stage) => ({ stage, count: summary.recordsByStage[stage] ?? 0 }))
    .filter(({ count }) => count < minEvalRecordsPerStage)
    .sort((left, right) => {
      if (left.count !== right.count) {
        return left.count - right.count;
      }
      return STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage);
    })[0];

  if (!lowStage) {
    return null;
  }

  const defaultModel = getDecisionModel(routingDecision, lowStage.stage);
  // Only models that can actually serve the starved stage's role are viable
  // challengers for it.
  const isStageEligible = makeStageEligibilityChecker(repoDir);
  const stageModels = availableModels.filter((model) => isStageEligible(model, lowStage.stage));
  // Pick the least-tested model for the starved stage specifically, falling
  // back to overall counts when per-stage attribution is unavailable.
  const challengerModel = summary.recordsByModelStage
    ? chooseLeastTestedModelForStage(stageModels, summary, lowStage.stage, [defaultModel])
    : chooseLeastTestedModel(stageModels, summary.recordsByModel, [defaultModel]);
  if (!challengerModel) {
    return null;
  }

  return {
    shouldChallenge: true,
    reason: 'low-data-stage',
    defaultModel,
    challengerModel,
    stage: lowStage.stage,
    priority: PRIORITY['low-data-stage'],
  };
}

/**
 * Evaluate whether routing context should trigger an exploration challenge.
 */
export function evaluateChallenge(input: ChallengeSchedulerInput): ChallengeRecommendation {
  if ((input.forceModel || '').trim()) {
    return {
      shouldChallenge: false,
      reason: 'disabled',
      priority: PRIORITY.disabled,
    };
  }

  const config = normalizeConfig(input.config);
  if (!config.enabled) {
    return {
      shouldChallenge: false,
      reason: 'disabled',
      priority: PRIORITY.disabled,
    };
  }

  const availableModels = getAvailableModels(input.routingDecision, input.repoDir, input.challengeModels);
  const recommendations = [
    checkLowConfidence(
      input.routingDecision,
      input.evalSummary.recordsByModel,
      config.confidenceThreshold,
      availableModels,
      input.repoDir,
    ),
    checkNewModel(
      input.routingDecision,
      input.evalSummary,
      config.newModelChallengeCount,
      availableModels,
      input.repoDir,
    ),
    checkLowDataStage(
      input.routingDecision,
      input.evalSummary,
      config.minEvalRecordsPerStage,
      availableModels,
      input.repoDir,
    ),
  ].filter((recommendation): recommendation is ChallengeRecommendation => recommendation !== null);

  return recommendations.sort((left, right) => right.priority - left.priority)[0] || {
    shouldChallenge: false,
    reason: 'disabled',
    priority: PRIORITY.disabled,
  };
}

function recordStagePresence(record: EvalRecord, stage: ChallengeStage): boolean {
  const taskDescriptorStages = record.taskDescriptor?.stages;
  if (stage === 'plan' && taskDescriptorStages?.planner?.model) {
    return true;
  }
  if (stage === 'implementation' && taskDescriptorStages?.coder?.model) {
    return true;
  }
  if (stage === 'review' && taskDescriptorStages?.reviewer?.model) {
    return true;
  }
  if (record.stageOutcomes?.[stage]) {
    return true;
  }
  const metadataStageScores = record.metadata?.stageScores as Record<string, unknown> | undefined;
  return Boolean(metadataStageScores?.[stage]);
}

function recordModelIds(record: EvalRecord): string[] {
  const models = [
    record.taskDescriptor?.stages?.planner?.model,
    record.taskDescriptor?.stages?.coder?.model,
    record.taskDescriptor?.stages?.reviewer?.model,
    record.modelId,
  ].filter((model): model is string => Boolean(model));
  return [...new Set(models)];
}

function getEvalFiles(repoDir: string): string[] {
  const evalsDir = resolve(repoDir, '.wavemill', 'evals');
  if (!existsSync(evalsDir)) {
    return [];
  }

  return readdirSync(evalsDir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => resolve(evalsDir, entry))
    .sort();
}

/**
 * Resolve the model that handled the given stage on this record. Plan and
 * review attribution requires real per-stage descriptor data; the
 * implementation stage falls back to `record.modelId`, which is the
 * solution/coder model by definition.
 */
export function recordStageModel(record: EvalRecord, stage: ChallengeStage): string | undefined {
  const stages = record.taskDescriptor?.stages;
  if (stage === 'plan') {
    return stages?.planner?.model || undefined;
  }
  if (stage === 'review') {
    return stages?.reviewer?.model || undefined;
  }
  return stages?.coder?.model || record.modelId || undefined;
}

export function recordStageInherited(record: EvalRecord, stage: ChallengeStage): boolean {
  const sideInherited = record.challengeSide === 'challenger'
    ? record.challengeIntent?.challenger?.inheritedStages
    : record.challengeSide === 'primary'
      ? record.challengeIntent?.primary?.inheritedStages
      : undefined;
  if (sideInherited?.includes(stage)) {
    return true;
  }
  if (record.challengeSide === 'primary') {
    return record.forkIdentity?.primaryInheritedStages?.includes(stage) === true;
  }
  if (record.challengeSide === 'challenger') {
    return record.forkIdentity?.challengerInheritedStages?.includes(stage) === true;
  }
  return record.forkIdentity?.primaryInheritedStages?.includes(stage) === true
    || record.forkIdentity?.challengerInheritedStages?.includes(stage) === true;
}

export function recordStageCountsForCoverage(record: EvalRecord, stage: ChallengeStage): boolean {
  if (recordStageInherited(record, stage)) {
    return false;
  }
  if (record.stageAttribution?.stage === stage && !isStageAttributionEligibleForCoverage(record.stageAttribution)) {
    return false;
  }
  return true;
}

/**
 * Build a lightweight summary of historical eval coverage for challenge policy.
 *
 * Results are cached per repo for the lifetime of the process.
 */
export function buildEvalSummary(repoDir?: string): EvalSummary {
  const cacheKey = resolve(repoDir || process.cwd());
  const cached = evalSummaryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const summary: EvalSummary = {
    totalRecords: 0,
    excludedRecords: 0,
    exclusionReasonCounts: {},
    recordsByModel: {},
    recordsByStage: {
      plan: 0,
      implementation: 0,
      review: 0,
    },
    recordsByModelStage: {},
  };

  const seenRecordIds = new Set<string>();
  const records: EvalRecord[] = [];
  for (const filePath of getEvalFiles(cacheKey)) {
    for (const record of readJsonlFile<EvalRecord>(filePath)) {
      const recordKey = record.id || `${record.modelId}:${record.timestamp || ''}:${record.originalPrompt || ''}`;
      if (seenRecordIds.has(recordKey)) {
        continue;
      }
      seenRecordIds.add(recordKey);
      records.push(record);
    }
  }

  const partition = partitionEvidence(records, 'challenge_coverage');
  summary.excludedRecords = partition.excluded.length;
  summary.exclusionReasonCounts = partition.reasonCounts;

  for (const record of partition.eligible) {
      summary.totalRecords += 1;

      for (const modelId of recordModelIds(record)) {
        summary.recordsByModel[modelId] = (summary.recordsByModel[modelId] ?? 0) + 1;
      }

      for (const stage of STAGES) {
        if (!recordStageCountsForCoverage(record, stage)) {
          continue;
        }

        if (recordStagePresence(record, stage)) {
          summary.recordsByStage[stage] = (summary.recordsByStage[stage] ?? 0) + 1;
        }

        const stageModel = recordStageModel(record, stage);
        if (stageModel) {
          const cells = summary.recordsByModelStage![stageModel] ?? {};
          cells[stage] = (cells[stage] ?? 0) + 1;
          summary.recordsByModelStage![stageModel] = cells;
        }
      }
  }

  evalSummaryCache.set(cacheKey, summary);
  return summary;
}

/**
 * Clear the cached eval summaries.
 *
 * Intended for tests and long-lived processes that need fresh filesystem data.
 */
export function clearChallengeSchedulerCache(repoDir?: string): void {
  if (repoDir) {
    evalSummaryCache.delete(resolve(repoDir));
    return;
  }
  evalSummaryCache.clear();
}
