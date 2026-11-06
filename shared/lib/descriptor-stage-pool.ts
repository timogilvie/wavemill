/**
 * Per-stage candidate pool for the Hokusai (Model 30) router.
 *
 * Model 30 can only recommend a model Wavemill offers it. Historically the
 * stage pools came straight from the registry ladders, and every native
 * OpenRouter model (`qwen-*`, `kimi-*`, `glm-*`) has
 * `defaultLadderEligible: false`, so no native model ever reached Model 30.
 *
 * This module composes the two membership rules the issue defines:
 *
 * 1. the existing router certification gate
 *    (`filterNativeModels`, HOK certification suite), and
 * 2. launch readiness (`filterOpenRouterModels`: provider enabled + API key
 *    present, plus the registry's disabled-model flag).
 *
 * It deliberately lives outside `model-registry.ts`: `model-registry` cannot
 * import the certification filter without creating a runtime import cycle
 * (`router-filter` -> `eligibility-gate` -> `getModel` from `model-registry`).
 *
 * @module descriptor-stage-pool
 */

import {
  getConfiguredModelsForDescriptorStage,
  getEffectiveRegistry,
  isModelEnabled,
} from './model-registry.ts';
import {
  filterNativeModels,
  type RouterCertificationRejection,
  type RouterRole,
} from './native-agent/certification/router-filter.ts';
import { filterOpenRouterModels } from './openrouter-provider.ts';

export interface DescriptorStagePool {
  /**
   * Ladder ∪ certified, launch-ready native models. Ladder order first, then
   * native models in registry order. Deduped.
   */
  models: string[];
  /**
   * The native models that passed both gates, in registry order. Callers that
   * already hold a policy-filtered or explicit pool union this in rather than
   * re-adding the whole ladder.
   */
  nativeModels: string[];
  /** Structured certification-gate rejections (modelId + reason, e.g. `stale-live-canary`). */
  nativeRejections: RouterCertificationRejection[];
  /** Launch-readiness drops (provider disabled / API key missing / model disabled). */
  providerWarnings: string[];
}

export interface DescriptorStagePoolOptions {
  /** Override "now" for deterministic certification TTL / canary freshness in tests. */
  now?: Date;
  /** Override the global certification store root (test isolation). */
  certificationRoot?: string;
}

function dedupe(models: readonly string[]): string[] {
  return [...new Set(models)];
}

/**
 * Build the candidate pool for one router stage.
 *
 * When `repoDir` is absent we return the ladder unchanged: native models only
 * appear in a repo-scoped context (mirrors `resolveStagePool`'s convention),
 * and the certification store needs a repo root to read config from.
 */
export function getDescriptorStagePool(
  repoDir: string | undefined,
  stage: RouterRole,
  opts: DescriptorStagePoolOptions = {},
): DescriptorStagePool {
  const ladder = getConfiguredModelsForDescriptorStage(repoDir, stage);

  if (!repoDir) {
    return {
      models: ladder,
      nativeModels: [],
      nativeRejections: [],
      providerWarnings: [],
    };
  }

  const registry = getEffectiveRegistry(repoDir);
  const nativeCandidates = Object.entries(registry.models)
    .filter(([, capabilities]) => Boolean(capabilities.nativeCapability?.nativeProvider))
    .map(([modelId]) => modelId);

  // Rule 1: the existing certification gate (artifact + phase + live canary +
  // identity + role eligibility + nativeAgent.allowedPhases). It reads the API
  // key as present by default so that launch readiness (rule 2) stays the only
  // place that decides whether a provider can actually run the model.
  const { eligible, rejected } = filterNativeModels(
    nativeCandidates,
    stage,
    registry,
    repoDir,
    {
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.certificationRoot ? { certificationRoot: opts.certificationRoot } : {}),
    },
  );

  // Rule 2: launch readiness. A registry-disabled model is never launchable,
  // so it is dropped with the rest of the provider-readiness decisions.
  const disabled = eligible.filter((modelId) => !isModelEnabled(registry.models[modelId]));
  const candidates = eligible.filter((modelId) => isModelEnabled(registry.models[modelId]));
  const provider = filterOpenRouterModels(candidates, repoDir, stage);
  const launchable = new Set(provider.models);

  const providerWarnings = dedupe([
    ...provider.warnings,
    ...disabled.map((modelId) => `Native model ${modelId} is disabled in the model registry, so it is not launch-ready for the ${stage} role.`),
    ...candidates
      .filter((modelId) => !launchable.has(modelId))
      .map(
        (modelId) =>
          `Native model ${modelId} is certified but not launch-ready for the ${stage} role: ` +
          `the OpenRouter provider is not enabled or its API key is missing.`,
      ),
  ]);

  const nativeModels = provider.models;

  return {
    models: dedupe([...ladder, ...nativeModels]),
    nativeModels,
    nativeRejections: rejected,
    providerWarnings,
  };
}
