/**
 * Hokusai-backed workflow router integration.
 *
 * @module hokusai-router
 */

import { getHokusaiRouterConfig } from './config.ts';
import {
  getDescriptorStagePool,
  type DescriptorStagePool,
} from './descriptor-stage-pool.ts';
import { resolveEnvValue } from './env-file.ts';
import { errorMessage } from './error-utils.ts';
import { fromHokusaiModel30Response } from './hokusai-adapter.ts';
import type { RouterCertificationRejection, RouterRole } from './native-agent/certification/router-filter.ts';
import { upgradeRouteModelSuccessors } from './route-model-successors.ts';
import {
  toHokusaiModel30Request,
  type HokusaiModel30Objective,
  type HokusaiModel30Response,
  type HokusaiRecommendedStrategy,
} from './hokusai-schema.ts';
import {
  getConfiguredModelsForDescriptor,
  getConfiguredModelsForDescriptorStage,
} from './model-registry.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';
import type { BudgetSource } from './budget-source.ts';

export const DEFAULT_HOKUSAI_MODEL30_ENDPOINT = 'https://api.hokus.ai/api/v1/models/30/predict';
export const DEFAULT_HOKUSAI_TIMEOUT_MS = 5000;

export type HokusaiFailureClassification =
  | 'missing_auth'
  | 'timeout'
  | 'network_error'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_payload'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'invalid_response';

export interface HokusaiRouterOptions {
  repoDir?: string;
  modelsAvailable?: string[];
  plannerModels?: string[];
  coderModels?: string[];
  reviewerModels?: string[];
  maxCostUsd?: number;
  /** Provenance of `maxCostUsd`; defaults to `request` (HOK-3390). */
  budgetSource?: BudgetSource;
  workflowStages?: string[];
  /**
   * Routing objective for this request. Set by router escalation's re-ask
   * (`highest_reliability`, HOK-3363); omitted otherwise so Hokusai applies
   * its default.
   */
  objective?: HokusaiModel30Objective;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecommendedStrategy(value: unknown): value is HokusaiRecommendedStrategy {
  return Boolean(
    value &&
    typeof value === 'object' &&
    isNonEmptyString((value as HokusaiRecommendedStrategy).planner_model) &&
    isNonEmptyString((value as HokusaiRecommendedStrategy).coder_model) &&
    isNonEmptyString((value as HokusaiRecommendedStrategy).reviewer_model)
  );
}

export function isHokusaiModel30Response(value: unknown): value is HokusaiModel30Response {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HokusaiModel30Response).predictions === 'object' &&
    (value as HokusaiModel30Response).predictions !== null &&
    isRecommendedStrategy((value as HokusaiModel30Response).predictions.recommended_strategy)
  );
}

function resolveConfiguredAuthToken(repoDir?: string): string | undefined {
  const config = getHokusaiRouterConfig(repoDir);
  const envVarName = config.apiKeyEnv || 'HOKUSAI_API_TOKEN';
  const envToken = resolveEnvValue([envVarName, 'HOKUSAI_API_KEY'], repoDir);
  if (envToken) {
    return envToken;
  }
  return config.apiKey?.trim() || undefined;
}

export function classifyHokusaiFailure(
  error: unknown,
  response?: Pick<Response, 'status'>,
): HokusaiFailureClassification {
  if (response) {
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (response.status === 404) return 'not_found';
    if (response.status === 422) return 'invalid_payload';
    if (response.status === 429) return 'rate_limited';
    if (response.status >= 500) return 'server_error';
    return 'http_error';
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'timeout';
  }

  const message = errorMessage(error).toLowerCase();
  if (message.includes('abort')) {
    return 'timeout';
  }
  if (message.includes('invalid hokusai response shape') || message.includes('invalid json')) {
    return 'invalid_response';
  }

  return 'network_error';
}

function warnHokusaiFailure(classification: HokusaiFailureClassification, detail: string): void {
  console.warn(`[hokusai-router] Hokusai routing failed (${classification}): ${detail}`);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve the candidate pool sent to Model 30 for one stage.
 *
 * The pool is always the ladder plus certified, launch-ready native models:
 * - with an explicit (policy- or caller-supplied) pool we union only the
 *   native models in, so quota filtering of ladder models is preserved;
 * - with a flat `modelsAvailable` we keep the historical "no per-stage pool"
 *   behaviour;
 * - otherwise the enriched descriptor-stage pool is used whole.
 */
function resolveStageModels(
  stage: RouterRole,
  explicitPool: string[] | undefined,
  stagePools: Record<RouterRole, DescriptorStagePool> | undefined,
  repoDir: string | undefined,
  modelsAvailable: string[] | undefined,
): string[] | undefined {
  const enriched = stagePools?.[stage];
  if (explicitPool) {
    return dedupe([...explicitPool, ...(enriched?.nativeModels ?? [])]);
  }
  if (modelsAvailable) {
    return undefined;
  }
  return enriched?.models ?? getConfiguredModelsForDescriptorStage(repoDir, stage);
}

function rejectionReasoningLine(rejection: RouterCertificationRejection): string {
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
  return `Native model ${rejection.modelId} rejected for ${rejection.role} role (${details.join(', ')}).`;
}

/**
 * Record why native models are missing from the pools on the returned
 * decision. `route-task.ts` serializes the decision verbatim into the route
 * artifact, so these entries are how an operator sees a stale canary or a
 * disabled provider in `.post-expansion-route.json` / `.initial-route.json`.
 */
function attachNativePoolDiagnostics(
  decision: WorkflowRouteDecision,
  stagePools: Record<RouterRole, DescriptorStagePool> | undefined,
): void {
  if (!stagePools) {
    return;
  }

  const rejections = [
    ...stagePools.planner.nativeRejections,
    ...stagePools.coder.nativeRejections,
    ...stagePools.reviewer.nativeRejections,
  ];
  const providerWarnings = dedupe([
    ...stagePools.planner.providerWarnings,
    ...stagePools.coder.providerWarnings,
    ...stagePools.reviewer.providerWarnings,
  ]);

  if (rejections.length === 0 && providerWarnings.length === 0) {
    return;
  }

  const reasoning = [
    ...decision.reasoning,
    ...rejections.map(rejectionReasoningLine),
    ...providerWarnings,
  ];
  decision.reasoning = reasoning;
  if (rejections.length > 0) {
    decision.nativeCertificationRejections = rejections;
  }
}

export async function routeViaHokusai(
  prompt: string,
  options: HokusaiRouterOptions = {},
): Promise<WorkflowRouteDecision | null> {
  const repoDir = options.repoDir;
  const config = getHokusaiRouterConfig(repoDir);
  const endpoint = config.endpoint || DEFAULT_HOKUSAI_MODEL30_ENDPOINT;
  const authToken = resolveConfiguredAuthToken(repoDir);

  if (!authToken) {
    warnHokusaiFailure('missing_auth', 'missing bearer token');
    return null;
  }

  const descriptorModelsAvailable = options.modelsAvailable ?? getConfiguredModelsForDescriptor(repoDir);
  const descriptor = buildTaskDescriptor({
    originalPrompt: prompt,
    modelsAvailable: descriptorModelsAvailable,
    maxCostUsd: options.maxCostUsd,
  });
  // Native models are only offered when we can read the repo's config and
  // certification store. One computation per stage feeds both the request
  // pools and the diagnostics attached to the decision below.
  const stagePools: Record<RouterRole, DescriptorStagePool> | undefined = repoDir
    ? {
        planner: getDescriptorStagePool(repoDir, 'planner'),
        coder: getDescriptorStagePool(repoDir, 'coder'),
        reviewer: getDescriptorStagePool(repoDir, 'reviewer'),
      }
    : undefined;
  const requestBody = toHokusaiModel30Request(
    descriptor,
    descriptor.repoContext,
    {
      description: prompt,
      externalTaskId: 'workflow-route',
      modelsAvailable: options.modelsAvailable,
      plannerModels: resolveStageModels('planner', options.plannerModels, stagePools, repoDir, options.modelsAvailable),
      coderModels: resolveStageModels('coder', options.coderModels, stagePools, repoDir, options.modelsAvailable),
      reviewerModels: resolveStageModels('reviewer', options.reviewerModels, stagePools, repoDir, options.modelsAvailable),
      maxCostUsd: options.maxCostUsd,
      ...(options.objective ? { objective: options.objective } : {}),
      workflowStages: options.workflowStages ?? ['plan', 'code', 'review'],
    },
  );

  const controller = new AbortController();
  const timeoutMs = config.timeout ?? DEFAULT_HOKUSAI_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const classification = classifyHokusaiFailure(null, response);
      warnHokusaiFailure(classification, `HTTP ${response.status}`);
      return null;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      warnHokusaiFailure('invalid_response', errorMessage(error));
      return null;
    }

    if (!isHokusaiModel30Response(payload)) {
      warnHokusaiFailure('invalid_response', 'missing predictions.recommended_strategy');
      return null;
    }

    const decision = upgradeRouteModelSuccessors(
      fromHokusaiModel30Response(payload, { repoDir }),
      repoDir,
    );
    attachNativePoolDiagnostics(decision, stagePools);
    if (typeof options.maxCostUsd === 'number') {
      decision.constraints = { maxCostUsd: options.maxCostUsd, budgetSource: options.budgetSource ?? 'request' };
    }
    return decision;
  } catch (error) {
    const classification = classifyHokusaiFailure(error);
    warnHokusaiFailure(classification, errorMessage(error));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
