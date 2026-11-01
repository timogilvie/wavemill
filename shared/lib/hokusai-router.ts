/**
 * Hokusai-backed workflow router integration.
 *
 * @module hokusai-router
 */

import { getHokusaiRouterConfig } from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import { errorMessage } from './error-utils.ts';
import { fromHokusaiModel30Response } from './hokusai-adapter.ts';
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
  const requestBody = toHokusaiModel30Request(
    descriptor,
    descriptor.repoContext,
    {
      description: prompt,
      externalTaskId: 'workflow-route',
      modelsAvailable: options.modelsAvailable,
      plannerModels: options.plannerModels ?? (options.modelsAvailable
        ? undefined
        : getConfiguredModelsForDescriptorStage(repoDir, 'planner')),
      coderModels: options.coderModels ?? (options.modelsAvailable
        ? undefined
        : getConfiguredModelsForDescriptorStage(repoDir, 'coder')),
      reviewerModels: options.reviewerModels ?? (options.modelsAvailable
        ? undefined
        : getConfiguredModelsForDescriptorStage(repoDir, 'reviewer')),
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
    if (typeof options.maxCostUsd === 'number') {
      decision.constraints = { maxCostUsd: options.maxCostUsd };
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
