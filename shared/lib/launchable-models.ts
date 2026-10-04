import { resolve } from 'node:path';
import { getOpenRouterProviderConfig } from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import { listEffectiveModelsForStage } from './effective-models.ts';
import {
  isLiveCanaryCertificationStatus,
  resolveModelAgent,
  type AgentResolution,
  type AgentResolutionPhase,
} from './model-agent-resolution.ts';
import { isDisabledModel } from './disabled-models.ts';
import {
  DEFAULT_MODEL_REGISTRY,
  explainModelSupportExclusion,
  getModel,
  isModelEnabled,
  type AgentType,
  type ModelRegistry,
} from './model-registry.ts';
import {
  filterNativeModels,
  ROUTER_ROLE_LAUNCH_PHASE,
  type RouterCertificationRejection,
  type RouterRole,
} from './native-agent/certification/router-filter.ts';
import {
  loadLaunchPriorityList,
  resolveOpenRouterModelIdentity,
  type LaunchPriorityModel,
  type RoleEligibility,
} from './openrouter-catalog.ts';
import { filterOpenRouterModels } from './openrouter-provider.ts';

export const LAUNCHABILITY_STAGES = ['planner', 'coder', 'reviewer'] as const;
export type LaunchabilityStage = typeof LAUNCHABILITY_STAGES[number];

export type LaunchabilityBlocker =
  | 'missing-registry'
  | 'provider'
  | 'credential'
  | 'certification'
  | 'role-ineligible'
  | 'disabled-deprecated'
  | 'retired'
  | 'context-window'
  | 'unsupported-launch-path';

export interface LaunchabilityCell {
  modelId: string;
  stage: LaunchabilityStage;
  launchPhase: RoleEligibility;
  catalog: LaunchPriorityModel;
  registryModelId: string | null;
  providerNativeId: string;
  agent: AgentType | null;
  stageEligible: boolean;
  providerAvailable: boolean;
  certificationRejection: RouterCertificationRejection | null;
  resolution: AgentResolution;
  launchable: boolean;
  blocker: LaunchabilityBlocker | null;
  diagnostic: string | null;
}

export interface LaunchabilityMatrix {
  repoDir: string;
  generatedAt: string;
  cells: LaunchabilityCell[];
  advertisedModels: Record<LaunchabilityStage, string[]>;
  blockers: Record<LaunchabilityBlocker, LaunchabilityCell[]>;
}

export interface BuildLaunchabilityMatrixOptions {
  repoDir?: string;
  registry?: ModelRegistry;
  now?: Date;
  catalog?: readonly LaunchPriorityModel[];
  certificationRoot?: string;
}

function inferBlocker(input: {
  catalog: LaunchPriorityModel;
  registryModelId: string | null;
  enabled: boolean;
  stageEligible: boolean;
  providerAvailable: boolean;
  providerWarnings: readonly string[];
  certificationRejection: RouterCertificationRejection | null;
  resolution: AgentResolution;
}): LaunchabilityBlocker | null {
  if (!input.registryModelId) return 'missing-registry';
  if (input.resolution.ok === false && (
    input.resolution.reason === 'lifecycle-blocked'
    || input.resolution.reason === 'tool-support-insufficient'
    || input.resolution.reason === 'context-window-insufficient'
  )) {
    return input.resolution.reason === 'context-window-insufficient' ? 'context-window' : 'retired';
  }
  if (input.catalog.status === 'deprecated' || !input.enabled) return 'disabled-deprecated';
  if (!input.stageEligible) return 'role-ineligible';
  if (!input.providerAvailable) {
    return input.providerWarnings.some((warning) => warning.includes('not set')) ? 'credential' : 'provider';
  }
  if (input.certificationRejection) return 'certification';
  if (!input.resolution.ok) {
    if (input.resolution.reason === 'role-ineligible') return 'role-ineligible';
    if (input.resolution.reason === 'uncertified') return 'certification';
    if (input.resolution.reason === 'unknown-model') return 'missing-registry';
    if (input.resolution.reason === 'lifecycle-blocked' || input.resolution.reason === 'tool-support-insufficient' || input.resolution.reason === 'context-window-insufficient') return input.resolution.reason === 'context-window-insufficient' ? 'context-window' : 'retired';
    return 'unsupported-launch-path';
  }
  return null;
}

function buildDiagnostic(input: {
  blocker: LaunchabilityBlocker | null;
  providerWarnings: readonly string[];
  certificationRejection: RouterCertificationRejection | null;
  resolution: AgentResolution;
}): string | null {
  if (!input.blocker) return null;
  if (input.providerWarnings.length > 0) return input.providerWarnings.join(' ');
  if (input.blocker === 'retired') return input.resolution.ok ? input.blocker : input.resolution.diagnostic;
  if (input.certificationRejection) {
    return `certification rejected reason=${input.certificationRejection.reason} requiredPhase=${input.certificationRejection.requestedPhase}`;
  }
  return input.resolution.ok ? input.blocker : input.resolution.diagnostic;
}

export function buildLaunchabilityMatrix(options: BuildLaunchabilityMatrixOptions = {}): LaunchabilityMatrix {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
  const now = options.now;
  const catalog = options.catalog ?? loadLaunchPriorityList();
  const providerConfig = getOpenRouterProviderConfig(repoDir);
  const providerHasKey = Boolean(resolveEnvValue([providerConfig.apiKeyEnv], repoDir));
  const cells: LaunchabilityCell[] = [];

  for (const entry of catalog) {
    const identity = resolveOpenRouterModelIdentity(entry.wavemillAlias);
    const providerNativeId = identity?.openrouterId ?? entry.openrouterId;
    const registryModelId = registry.models[entry.wavemillAlias] ? entry.wavemillAlias : null;
    const capabilities = registryModelId ? getModel(registry, registryModelId) : undefined;
    const enabled = isModelEnabled(capabilities);

    for (const stage of LAUNCHABILITY_STAGES) {
      const launchPhase = ROUTER_ROLE_LAUNCH_PHASE[stage];
      const stageEligible = entry.roleEligibility.includes(launchPhase);
      const providerFilter = filterOpenRouterModels([entry.wavemillAlias], repoDir, stage);
      const providerAvailable = providerFilter.models.includes(entry.wavemillAlias)
        || (capabilities?.nativeCapability?.nativeProvider === 'openrouter' && providerHasKey);
      const nativeFilter = registryModelId
        ? filterNativeModels([registryModelId], stage as RouterRole, registry, repoDir, {
          now,
          certificationRoot: options.certificationRoot,
        })
        : { eligible: [], rejected: [] };
      const certificationRejection = nativeFilter.rejected[0] ?? null;
      const resolution = resolveModelAgent({
        model: entry.wavemillAlias,
        phase: launchPhase as AgentResolutionPhase,
        registry,
        repoDir,
        now,
        certificationRoot: options.certificationRoot,
      });
      const blocker = inferBlocker({
        catalog: entry,
        registryModelId,
        enabled,
        stageEligible,
        providerAvailable,
        providerWarnings: providerFilter.warnings,
        certificationRejection,
        resolution,
      });

      cells.push({
        modelId: entry.wavemillAlias,
        stage,
        launchPhase,
        catalog: entry,
        registryModelId,
        providerNativeId,
        agent: resolution.ok ? resolution.agent : null,
        stageEligible,
        providerAvailable,
        certificationRejection,
        resolution,
        launchable: blocker === null,
        blocker,
        diagnostic: buildDiagnostic({
          blocker,
          providerWarnings: providerFilter.warnings,
          certificationRejection,
          resolution,
        }),
      });
    }
  }

  const advertisedModels = Object.fromEntries(
    LAUNCHABILITY_STAGES.map((stage) => [
      stage,
      cells.filter((cell) => cell.stage === stage && cell.launchable).map((cell) => cell.modelId),
    ]),
  ) as Record<LaunchabilityStage, string[]>;
  const blockers = Object.create(null) as Record<LaunchabilityBlocker, LaunchabilityCell[]>;
  for (const cell of cells) {
    if (!cell.blocker) continue;
    blockers[cell.blocker] = blockers[cell.blocker] ?? [];
    blockers[cell.blocker].push(cell);
  }

  return {
    repoDir,
    generatedAt: (now ?? new Date()).toISOString(),
    cells,
    advertisedModels,
    blockers,
  };
}

export interface CoderCanaryGap {
  modelId: string;
  /** Canary gate reason, e.g. `missing_live_canary` or `stale_live_canary`. */
  certification: string;
  certifyCommand?: string;
}

/**
 * Router-eligible native coders the coding launch gate refuses for a live
 * canary reason (HOK-3142). The router's launchability guard already keeps
 * these out of routes; this advisory tells the operator which models are
 * silently unavailable as coders and how to certify them. HOK-3062's cohort
 * refresh only covers the configured cohort, so models outside it surface here.
 *
 * Candidates: the registry's coder stage pool ∪ launch-priority catalog
 * entries eligible for coding, restricted to native models whose provider is
 * configured for the coder stage. Models routing would never pick anyway —
 * `DISABLED_MODEL_IDS` and registry support exclusions such as a blocked or
 * retired lifecycle (HOK-3159) — are left out so the advisory is not noise.
 */
export function listCoderCanaryGaps(options: BuildLaunchabilityMatrixOptions = {}): CoderCanaryGap[] {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
  const catalog = options.catalog ?? loadLaunchPriorityList();
  const candidates = [...new Set([
    ...listEffectiveModelsForStage('coder', { repoDir, registry }).models,
    ...catalog
      .filter((entry) => entry.roleEligibility.includes('coding'))
      .map((entry) => entry.wavemillAlias),
  ])].filter((modelId) => {
    const capabilities = getModel(registry, modelId);
    return Boolean(capabilities?.nativeCapability?.nativeProvider)
      && isModelEnabled(capabilities)
      && !isDisabledModel(modelId)
      && explainModelSupportExclusion(modelId, 'coding', registry) === undefined;
  });
  const providerAvailable = new Set(filterOpenRouterModels(candidates, repoDir, 'coder').models);

  const gaps: CoderCanaryGap[] = [];
  for (const modelId of candidates) {
    const nativeProvider = getModel(registry, modelId)?.nativeCapability?.nativeProvider;
    if (nativeProvider === 'openrouter' && !providerAvailable.has(modelId)) continue;
    const resolution = resolveModelAgent({
      model: modelId,
      phase: 'coding',
      registry,
      repoDir,
      now: options.now,
      certificationRoot: options.certificationRoot,
    });
    if (resolution.ok !== false) continue;
    const refusal = resolution as Extract<AgentResolution, { ok: false }>;
    if (!isLiveCanaryCertificationStatus(refusal.certificationStatus)) continue;
    gaps.push({
      modelId,
      certification: refusal.certificationStatus as string,
      ...(refusal.certifyCommand ? { certifyCommand: refusal.certifyCommand } : {}),
    });
  }
  return gaps.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
