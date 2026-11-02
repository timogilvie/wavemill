import type {
  HokusaiModel30Predictions,
  HokusaiModel30Response,
  HokusaiOutput,
  HokusaiRecommendedStrategy,
} from './hokusai-schema.ts';
import {
  CODE_TOKENS,
  PLAN_TOKENS,
  REVIEW_TOKENS,
  estimateStageCost,
  type CodeDepth,
  type PlanDepth,
  type ReviewMode,
  type WorkflowRouteDecision,
} from './workflow-router.ts';

const PLAN_DEPTH_MAP: Record<'low' | 'medium' | 'high', PlanDepth> = {
  low: 'light',
  medium: 'medium',
  high: 'deep',
};

const CODE_DEPTH_MAP: Record<'low' | 'medium' | 'high', CodeDepth> = {
  low: 'light',
  medium: 'medium',
  high: 'deep',
};

const REVIEW_MODE_MAP: Record<'light' | 'standard' | 'deep', Exclude<ReviewMode, 'none'>> = {
  light: 'static',
  standard: 'llm',
  deep: 'static+llm',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function allocateStageCosts(
  expectedTotalCost: number | undefined,
  fallbackCosts: [number, number, number],
): [number, number, number] {
  const fallbackTotal = fallbackCosts.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(expectedTotalCost) || (expectedTotalCost as number) < 0) {
    return fallbackCosts;
  }

  if (expectedTotalCost === 0) {
    return [0, 0, 0];
  }

  if (fallbackTotal <= 0) {
    const equalShare = roundMoney(expectedTotalCost / 3);
    return [equalShare, equalShare, roundMoney(expectedTotalCost - equalShare * 2)];
  }

  const allocated = fallbackCosts.map((value) => roundMoney((value / fallbackTotal) * expectedTotalCost)) as [number, number, number];
  return [
    allocated[0],
    allocated[1],
    roundMoney(expectedTotalCost - allocated[0] - allocated[1]),
  ];
}

function derivePlanDepth(strategy: HokusaiRecommendedStrategy): PlanDepth {
  if (strategy.plan_depth) {
    return PLAN_DEPTH_MAP[strategy.plan_depth];
  }
  return strategy.stages?.includes('plan') ? 'medium' : 'light';
}

function deriveCodeDepth(strategy: HokusaiRecommendedStrategy): CodeDepth {
  if (strategy.code_depth) {
    return CODE_DEPTH_MAP[strategy.code_depth];
  }
  return strategy.stages?.includes('code') ? 'medium' : 'light';
}

function deriveReviewMode(strategy: HokusaiRecommendedStrategy): Exclude<ReviewMode, 'none'> {
  if (strategy.review_mode) {
    return REVIEW_MODE_MAP[strategy.review_mode];
  }
  return strategy.stages?.includes('review') ? 'llm' : 'static';
}

function firstFiniteNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function parseHokusaiNeighborEvidence(rationale: string | undefined): {
  nearestNeighborCount?: number;
  exactRouteMatchCount?: number;
} {
  if (!rationale) return {};

  const nearestMatch = rationale.match(/\bacross\s+(\d+)\s+nearest\b/i);
  const exactMatch = rationale.match(/\bfrom\s+(\d+)\s+exact route match/i);

  return {
    ...(nearestMatch ? { nearestNeighborCount: Number(nearestMatch[1]) } : {}),
    ...(exactMatch ? { exactRouteMatchCount: Number(exactMatch[1]) } : {}),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Hokusai's join key for a prediction (HOK-3363). The predict endpoint
 * returns `inference_log_id` at the top level and the same UUID as
 * `metadata.request_id`; older servers nested it under `metadata`.
 */
export function resolveHokusaiInferenceLogId(
  response: Pick<HokusaiModel30Response, 'inference_log_id' | 'metadata'>,
): string | undefined {
  return nonEmptyString(response.inference_log_id)
    ?? nonEmptyString(response.metadata?.inference_log_id)
    ?? nonEmptyString(response.metadata?.request_id);
}

function deriveNearestNeighborCount(
  predictions: HokusaiModel30Predictions,
): number | undefined {
  if (Array.isArray(predictions.nearest_neighbors)) {
    return predictions.nearest_neighbors.length;
  }

  const raw = predictions as Record<string, unknown>;
  return firstFiniteNonNegativeInteger(
    raw.nearest_neighbor_count,
    raw.neighbor_count,
    raw.neighbors_count,
    parseHokusaiNeighborEvidence(predictions.recommended_strategy.rationale).nearestNeighborCount,
  );
}

export function fromHokusaiRecommendedStrategy(
  strategy: HokusaiRecommendedStrategy,
  options: {
    repoDir?: string;
    metadata?: HokusaiModel30Response['metadata'];
    /** Hokusai's join key; see {@link resolveHokusaiInferenceLogId}. */
    inferenceLogId?: string;
    alternatives?: unknown;
    tradeoffs?: unknown;
    nearestNeighbors?: unknown;
    nearestNeighborCount?: number;
    exactRouteMatchCount?: number;
  } = {},
): WorkflowRouteDecision {
  const planDepth = derivePlanDepth(strategy);
  const codeDepth = deriveCodeDepth(strategy);
  const reviewRecommended = deriveReviewMode(strategy);
  const fallbackCosts: [number, number, number] = [
    estimateStageCost(strategy.planner_model, PLAN_TOKENS[planDepth], options.repoDir),
    estimateStageCost(strategy.coder_model, CODE_TOKENS[codeDepth], options.repoDir),
    estimateStageCost(strategy.reviewer_model, REVIEW_TOKENS[reviewRecommended], options.repoDir),
  ];
  const [expectedCostPlan, expectedCostCode, expectedCostReview] = allocateStageCosts(
    strategy.estimated_cost_usd,
    fallbackCosts,
  );

  const hokusaiEvidence = {
    ...parseHokusaiNeighborEvidence(strategy.rationale),
    ...(typeof options.nearestNeighborCount === 'number' ? { nearestNeighborCount: options.nearestNeighborCount } : {}),
    ...(typeof options.exactRouteMatchCount === 'number' ? { exactRouteMatchCount: options.exactRouteMatchCount } : {}),
  };
  const hokusaiMetadata = {
    ...(typeof options.metadata?.api_version === 'string' ? { apiVersion: options.metadata.api_version } : {}),
    ...(typeof options.metadata?.inference_method === 'string' ? { inferenceMethod: options.metadata.inference_method } : {}),
    ...(typeof options.metadata?.model_uri === 'string' ? { modelUri: options.metadata.model_uri } : {}),
    ...(typeof options.metadata?.model_version === 'string' ? { modelVersion: options.metadata.model_version } : {}),
    ...(typeof options.metadata?.schema === 'string' ? { schema: options.metadata.schema } : {}),
    ...(strategy.objective ? { objective: String(strategy.objective) } : {}),
    ...(strategy.rationale ? { rationale: strategy.rationale } : {}),
    ...hokusaiEvidence,
  };

  return {
    planner: strategy.planner_model,
    coder: strategy.coder_model,
    reviewer: strategy.reviewer_model,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess: clamp(strategy.estimated_success_under_budget ?? 0.5, 0, 1),
    expectedCostPlan,
    expectedCostCode,
    expectedCostReview,
    confidence: clamp(strategy.confidence ?? 0.5, 0, 1),
    reasoning: [
      'Adapted from Hokusai Model 30 recommended_strategy.',
      'Stage costs are apportioned from Hokusai estimated_cost_usd using router token heuristics.',
    ],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 0,
      fileTypes: [],
      riskScore: 0,
    },
    provenance: {
      source: 'live',
      inputKind: 'issue',
      inputPath: '',
      inputHash: '',
      routedAt: new Date().toISOString(),
      routerMode: 'normal',
      ...(options.metadata?.request_id ? { requestId: String(options.metadata.request_id) } : {}),
      ...(options.inferenceLogId ? { inferenceLogId: options.inferenceLogId } : {}),
      ...(typeof strategy.estimated_duration_seconds === 'number' && Number.isFinite(strategy.estimated_duration_seconds)
        ? { estimatedDurationSeconds: strategy.estimated_duration_seconds }
        : {}),
      ...(options.alternatives ? { alternatives: options.alternatives } : {}),
      ...(options.tradeoffs ? { tradeoffs: options.tradeoffs } : {}),
      ...(options.nearestNeighbors ? { nearestNeighbors: options.nearestNeighbors } : {}),
      ...(Object.keys(hokusaiMetadata).length > 0 ? { hokusai: hokusaiMetadata } : {}),
    },
  };
}

export function fromHokusaiModel30Response(
  response: HokusaiModel30Response,
  options?: { repoDir?: string },
): WorkflowRouteDecision {
  const parsedEvidence = parseHokusaiNeighborEvidence(response.predictions.recommended_strategy.rationale);
  return fromHokusaiRecommendedStrategy(response.predictions.recommended_strategy, {
    repoDir: options?.repoDir,
    metadata: response.metadata,
    inferenceLogId: resolveHokusaiInferenceLogId(response),
    alternatives: response.predictions.alternatives,
    tradeoffs: response.predictions.tradeoffs,
    nearestNeighbors: response.predictions.nearest_neighbors,
    nearestNeighborCount: deriveNearestNeighborCount(response.predictions),
    exactRouteMatchCount: parsedEvidence.exactRouteMatchCount,
  });
}

export function fromHokusaiOutput(
  output: HokusaiOutput,
  options?: { repoDir?: string },
): WorkflowRouteDecision {
  return fromHokusaiRecommendedStrategy({
    planner_model: output.route.planner_model,
    coder_model: output.route.coder_model,
    reviewer_model: output.route.reviewer_model,
    plan_depth: output.route.plan_depth,
    code_depth: output.route.code_depth,
    review_mode: output.route.review_mode,
    estimated_success_under_budget: output.predictions.expected_success_probability,
    estimated_cost_usd: output.predictions.expected_cost_usd,
    confidence: output.predictions.confidence,
    stages: ['plan', 'code', 'review'],
  }, options);
}
