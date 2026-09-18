import { createHash } from 'node:crypto';
import { getContextWindowFloorsConfig } from './config.ts';
import { filterDisabledModels } from './disabled-models.ts';
import {
  CERTIFICATION_TTL_DAYS,
  PHASE_ORDER,
  phaseSatisfies,
  type CertificationPhase,
} from './native-agent/certification/schema.ts';
import { loadDefaultModelRegistry } from './model-registry-loader.ts';
import { resolveWavemillAliasFromOpenRouterId, type ModelFamily } from './openrouter-catalog.ts';

export type ModelClass = 'frontier' | 'strong_generalist' | 'fast_economy';
export type RegistryTaskType = 'routing' | 'planning' | 'coding' | 'review' | 'classify';
export type DescriptorModelStage = 'planner' | 'coder' | 'reviewer';
export type ToolSupport = 'none' | 'basic' | 'full';
export type LatencyTier = 'fast' | 'standard' | 'slow';
export type ReasoningTier = 'basic' | 'standard' | 'advanced';
export type Channel = 'stable' | 'preview' | 'experimental';
export const CHANNELS: readonly Channel[] = Object.freeze(['stable', 'preview', 'experimental'] as const);
export type NativeProviderName = 'openai' | 'openrouter';
export type PiTransportKind = 'openai-responses' | 'openai-completions';
export type ReadOnlyNativeCapability = 'certified' | 'unsupported' | 'partial';
export type ModelLifecycleStatus = 'supported' | 'deprecated' | 'blocked';
export type SupportedModelStage = 'expansion' | 'planning' | 'coding' | 'review';
export type ModelIdentityStatus = 'provisional' | 'verified';
export type ModelEvidencePolicy = 'held' | 'eligible';
export type ModelSupportExclusionReason =
  | 'unknown-model'
  | 'blocked-lifecycle'
  | 'provisional-identity'
  | 'disabled'
  | 'stage-incompatible'
  | 'tool-support-insufficient'
  | 'context-window-insufficient'
  | 'routing-ineligible';
export type AgentType =
  | 'claude'
  | 'codex'
  | 'claude-openrouter'
  | 'native-openai'
  | 'native-openrouter';
export type CapabilityConstraintName =
  | 'minContextWindow'
  | 'requiresTools'
  | 'requiresMultimodal'
  | 'maxLatencyTier';
export type AdmissionViolationReason =
  | 'context-window-below-minimum'
  | 'tool-support-insufficient';

export interface AdmissionViolation {
  stage: SupportedModelStage;
  reason: AdmissionViolationReason;
  detail: string;
}

export interface MultimodalSupport {
  text: boolean;
  image: boolean;
  audio?: boolean;
  video?: boolean;
}

export interface PiCompatFlags {
  thinkingFormat?: 'openrouter';
  [key: string]: unknown;
}

export interface NativeCertificationMetadata {
  maxCertifiedPhase: CertificationPhase;
  certifiedAt: string;
  certificationSuiteVersion: string;
  knownLimitations?: string[];
}

/**
 * Registry-native metadata for Pi-backed providers.
 *
 * Mapping table:
 * - `openai` + `openai-responses` => `certified`
 * - `openrouter` + `openai-completions` + `thinkingFormat=openrouter` => `certified`
 * - `openrouter` + `openai-completions` without that compat flag => `partial`
 * - all other combinations => `unsupported`
 */
export interface NativeCapability {
  nativeProvider: NativeProviderName;
  piTransportKind: PiTransportKind;
  readOnlyNative: ReadOnlyNativeCapability;
  compatFlags?: PiCompatFlags;
  limitations?: string[];
  certification?: NativeCertificationMetadata;
}

export interface SupportedModelMetadata {
  wavemillAlias?: string;
  providerNativeId?: string;
  provider?: NativeProviderName;
  transport?: PiTransportKind;
  stages?: SupportedModelStage[];
  requiredCertificationPhaseByStage?: Partial<Record<SupportedModelStage, CertificationPhase>>;
  certificationSuiteVersion?: string;
  certificationFreshnessDays?: number;
  canonicalArtifactIdentity?: {
    provider: string;
    model: string;
    suiteVersion: string;
  };
  lifecycle?: ModelLifecycleStatus;
  compatibilityFlags?: PiCompatFlags;
  limitations?: string[];
  launchEligible?: boolean;
  routingEligible?: boolean;
}

/** Account/surface capability for hosted Codex launches (not native OpenAI). */
export interface CodexChatgptCapability {
  supported: boolean;
  reason?: string;
}

export interface ModelIdentityMetadata {
  status: ModelIdentityStatus;
  revision: number;
  fingerprint: string;
  displayName: string;
  family: ModelFamily | 'unknown';
  evidencePolicy: ModelEvidencePolicy;
  verification?: {
    source: string;
    observedAt: string;
    catalogHash: string;
  };
  lineage?: {
    predecessors?: string[];
    successor?: string;
    formerIds?: string[];
    disclosedAt?: string;
    disclosureSource?: string;
  };
}

export interface ModelCapabilities {
  vendor: string;
  class: ModelClass;
  strengths: string[];
  weaknesses: string[];
  disabled?: boolean;
  qualityScores: Record<RegistryTaskType, number>;
  pricing?: {
    inputCostPerMTok: number;
    outputCostPerMTok: number;
    cacheWriteCostPerMTok?: number;
    cacheReadCostPerMTok?: number;
  };
  defaultLadderEligible?: boolean;
  contextWindowTokens: number;
  toolSupport: ToolSupport;
  multimodal: MultimodalSupport;
  latencyTier: LatencyTier;
  reasoningTier: ReasoningTier;
  costPerMillionInputTokensUsd: number;
  costPerMillionOutputTokensUsd: number;
  agent?: AgentType;
  codexChatgptCapability?: CodexChatgptCapability;
  nativeCapability?: NativeCapability;
  supportedModel?: SupportedModelMetadata;
  identity?: ModelIdentityMetadata;
  /**
   * ISO date the model became generally available. Drives the recency-aware
   * exploration boost (router.exploration.newModelBoost) and challenge
   * scheduler prioritization. Unset means no recency treatment.
   */
  releasedAt?: string;
}

export interface ModelRegistry {
  models: Record<string, ModelCapabilities>;
  ladders: Partial<Record<RegistryTaskType, string[]>>;
}

export interface CapabilityConstraints {
  minContextWindow?: number;
  requiresTools?: boolean;
  requiresMultimodal?: boolean;
  maxLatencyTier?: LatencyTier;
}

export interface CapabilityFilterResult {
  satisfied: boolean;
  failedConstraints: CapabilityConstraintName[];
}

const TASK_TYPES: RegistryTaskType[] = ['routing', 'planning', 'coding', 'review', 'classify'];
export const CLASS_RANK: Record<ModelClass, number> = {
  frontier: 3,
  strong_generalist: 2,
  fast_economy: 1,
};
const LATENCY_TIER_RANK: Record<LatencyTier, number> = {
  fast: 0,
  standard: 1,
  slow: 2,
};
const warnedUnknownLadders = new Set<string>();
const DESCRIPTOR_STAGE_TO_TASK_TYPE: Record<DescriptorModelStage, RegistryTaskType> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};
const READ_ONLY_NATIVE_CAPABILITIES: readonly ReadOnlyNativeCapability[] = ['certified', 'unsupported', 'partial'];
const PI_TRANSPORT_KINDS: readonly PiTransportKind[] = ['openai-responses', 'openai-completions'];
const CERTIFICATION_PHASES: readonly CertificationPhase[] = PHASE_ORDER;
const MODEL_LIFECYCLE_STATUSES: readonly ModelLifecycleStatus[] = ['supported', 'deprecated', 'blocked'];
const SUPPORTED_MODEL_STAGES: readonly SupportedModelStage[] = ['expansion', 'planning', 'coding', 'review'];
const STAGE_REQUIRES_TOOLS: Record<SupportedModelStage, boolean> = {
  expansion: true,
  planning: true,
  coding: true,
  review: true,
};
export const STAGE_MIN_CONTEXT_WINDOW_TOKENS: Readonly<Record<SupportedModelStage, number>> = Object.freeze({
  expansion: 65_536,
  planning: 65_536,
  coding: 65_536,
  review: 65_536,
});
const INSUFFICIENT_TOOL_SUPPORT: ReadonlySet<ToolSupport> = new Set(['none']);

/**
 * Minimum context window size requirements per stage, derived from measured prompt sizes.
 * 
 * For coding stage: 144,384 tokens derived from the 2026-08-17 kimi-k2 incident (~131,182 tokens)
 * with 10% headroom (matching CONTEXT_WINDOW_SAFETY_MARGIN) = 144,300.2, rounded up to nearest 1024.
 * 
 * Other stages have no floor initially as we have no measured prompt-size data.
 * 
 * Relationship to evaluateCapabilityConstraints: That function implements heuristic,
 * config-gated constraints based on cost-profile estimates. This gate is unconditional
 * and based on actual measured prompt sizes. They are complementary, not duplicates.
 */
export interface StageContextWindowFloor {
  floorTokens: number;
  derivation: {
    observedMaxPromptTokens: number;
    sampleCount: number;
    observationWindow: string;   // e.g. '2026-08-17 incident' or '2026-07-01..2026-08-19 transcripts'
    headroomFraction: number;    // e.g. 0.10
    derivedAt: string;           // ISO date
    method: string;              // human-readable formula
  };
}

export const STAGE_CONTEXT_WINDOW_FLOORS: Partial<Record<SupportedModelStage, StageContextWindowFloor>> = {
  coding: {
    floorTokens: 144_384,
    derivation: {
      observedMaxPromptTokens: 131_182,
      sampleCount: 1,
      observationWindow: '2026-08-17 incident',
      headroomFraction: 0.10,
      derivedAt: '2026-08-18',
      method: 'observedMaxPromptTokens * (1 + headroomFraction), rounded up to nearest 1024',
    },
  },
  // No floor for planning, review, expansion stages initially - no measured data yet
};

/**
 * Resolve the effective context window floor for a stage.
 *
 * Precedence:
 *   1. `contextWindowFloors.<stage>` from `.wavemill-config.json` (per REQ-F2).
 *   2. Built-in derived floor in `STAGE_CONTEXT_WINDOW_FLOORS`.
 *   3. Fail-open (undefined) when neither is set.
 *
 * `repoDir` is optional; when omitted, `loadWavemillConfig` uses the current
 * working directory (matches the rest of the codebase's config-lookup pattern).
 */
export function getStageContextWindowFloor(
  stage: SupportedModelStage,
  repoDir?: string,
): number | undefined {
  const configured = getContextWindowFloorsConfig(repoDir)[stage];
  if (typeof configured === 'number' && configured > 0) {
    return configured;
  }
  return STAGE_CONTEXT_WINDOW_FLOORS[stage]?.floorTokens;
}

export function hasSufficientContextWindow(
  capabilities: Pick<ModelCapabilities, 'contextWindowTokens'>,
  stage: SupportedModelStage,
  repoDir?: string,
): boolean {
  const floor = getStageContextWindowFloor(stage, repoDir);
  // Fail-open: if no floor is defined for the stage, all models are considered sufficient
  if (floor === undefined) {
    return true;
  }
  return capabilities.contextWindowTokens >= floor;
}
const UNSAFE_CERTIFICATION_SEGMENT = /[/\\.\0]/;
const OPENROUTER_CERTIFICATION_SEED = Object.freeze({
  maxCertifiedPhase: 'workflow' as const,
  certifiedAt: '2026-07-15T00:00:00.000Z',
  certificationSuiteVersion: 'v3',
});

const OPENROUTER_NATIVE_CAPABILITY: NativeCapability = Object.freeze({
  nativeProvider: 'openrouter',
  piTransportKind: 'openai-completions',
  readOnlyNative: 'certified',
  compatFlags: Object.freeze({ thinkingFormat: 'openrouter' }),
  certification: OPENROUTER_CERTIFICATION_SEED,
});

const PROVISIONAL_OPENROUTER_NATIVE_CAPABILITY: NativeCapability = Object.freeze({
  nativeProvider: 'openrouter',
  piTransportKind: 'openai-completions',
  readOnlyNative: 'certified',
  compatFlags: Object.freeze({ thinkingFormat: 'openrouter' }),
});

interface CodexChatgptCapabilityOverride {
  supported?: boolean;
  reason?: string;
}

interface NativeCapabilityOverride {
  nativeProvider?: NativeProviderName;
  piTransportKind?: PiTransportKind;
  readOnlyNative?: ReadOnlyNativeCapability;
  compatFlags?: PiCompatFlags;
  limitations?: string[];
  certification?: Partial<NativeCertificationMetadata>;
}

interface ModelCapabilitiesOverride {
  vendor?: string;
  class?: ModelClass;
  strengths?: string[];
  weaknesses?: string[];
  disabled?: boolean;
  qualityScores?: Partial<Record<RegistryTaskType, number>>;
  pricing?: ModelCapabilities['pricing'];
  defaultLadderEligible?: boolean;
  contextWindowTokens?: number;
  toolSupport?: ToolSupport;
  multimodal?: MultimodalSupport;
  latencyTier?: LatencyTier;
  reasoningTier?: ReasoningTier;
  costPerMillionInputTokensUsd?: number;
  costPerMillionOutputTokensUsd?: number;
  agent?: AgentType;
  codexChatgptCapability?: CodexChatgptCapabilityOverride;
  nativeCapability?: NativeCapabilityOverride;
  supportedModel?: Partial<SupportedModelMetadata>;
  identity?: ModelIdentityMetadata;
  releasedAt?: string;
}

function openRouterSupportedModel(input: {
  alias: string;
  providerNativeId: string;
  stages: SupportedModelStage[];
  lifecycle?: ModelLifecycleStatus;
  routingEligible?: boolean;
}): SupportedModelMetadata {
  const [provider, model] = input.providerNativeId.split('/');
  return {
    wavemillAlias: input.alias,
    providerNativeId: input.providerNativeId,
    provider: 'openrouter',
    transport: 'openai-completions',
    stages: input.stages,
    requiredCertificationPhaseByStage: {
      planning: 'workflow',
      coding: 'patch',
      review: 'read-only',
    },
    certificationSuiteVersion: OPENROUTER_CERTIFICATION_SEED.certificationSuiteVersion,
    certificationFreshnessDays: CERTIFICATION_TTL_DAYS,
    canonicalArtifactIdentity: provider && model
      ? { provider, model, suiteVersion: OPENROUTER_CERTIFICATION_SEED.certificationSuiteVersion }
      : undefined,
    lifecycle: input.lifecycle ?? 'supported',
    compatibilityFlags: { thinkingFormat: 'openrouter' },
    launchEligible: true,
    routingEligible: input.routingEligible ?? true,
  };
}

function cloneCompatFlags(compatFlags: PiCompatFlags | undefined): PiCompatFlags | undefined {
  return compatFlags ? { ...compatFlags } : undefined;
}

function cloneCertificationMetadata(
  certification: NativeCertificationMetadata | undefined,
): NativeCertificationMetadata | undefined {
  if (!certification) {
    return undefined;
  }

  return {
    maxCertifiedPhase: certification.maxCertifiedPhase,
    certifiedAt: certification.certifiedAt,
    certificationSuiteVersion: certification.certificationSuiteVersion,
    knownLimitations: certification.knownLimitations ? [...certification.knownLimitations] : undefined,
  };
}

function cloneNativeCapability(
  capability: NativeCapability | undefined,
): NativeCapability | undefined {
  if (!capability) {
    return undefined;
  }

  return {
    nativeProvider: capability.nativeProvider,
    piTransportKind: capability.piTransportKind,
    readOnlyNative: capability.readOnlyNative,
    compatFlags: cloneCompatFlags(capability.compatFlags),
    limitations: capability.limitations ? [...capability.limitations] : undefined,
    certification: cloneCertificationMetadata(capability.certification),
  };
}

function cloneCodexChatgptCapability(
  capability: CodexChatgptCapability | undefined,
): CodexChatgptCapability | undefined {
  return capability ? { ...capability } : undefined;
}

function mergeCodexChatgptCapability(
  seed: CodexChatgptCapability | undefined,
  override: CodexChatgptCapabilityOverride | undefined,
): CodexChatgptCapability | undefined {
  if (!override) return cloneCodexChatgptCapability(seed);
  return { supported: override.supported ?? seed?.supported ?? false, reason: override.reason ?? seed?.reason };
}

function mergeNativeCapability(
  seed: NativeCapability | undefined,
  override: NativeCapabilityOverride,
): NativeCapability {
  const merged: Partial<NativeCapability> = {
    nativeProvider: override.nativeProvider ?? seed?.nativeProvider,
    piTransportKind: override.piTransportKind ?? seed?.piTransportKind,
    readOnlyNative: override.readOnlyNative ?? seed?.readOnlyNative,
    compatFlags: override.compatFlags
      ? cloneCompatFlags(override.compatFlags)
      : cloneCompatFlags(seed?.compatFlags),
    limitations: override.limitations
      ? [...override.limitations]
      : seed?.limitations
      ? [...seed.limitations]
      : undefined,
    certification: override.certification
      ? {
        maxCertifiedPhase: override.certification.maxCertifiedPhase ?? seed?.certification?.maxCertifiedPhase,
        certifiedAt: override.certification.certifiedAt ?? seed?.certification?.certifiedAt,
        certificationSuiteVersion:
          override.certification.certificationSuiteVersion ?? seed?.certification?.certificationSuiteVersion,
        knownLimitations: override.certification.knownLimitations
          ? [...override.certification.knownLimitations]
          : seed?.certification?.knownLimitations
          ? [...seed.certification.knownLimitations]
          : undefined,
      }
      : cloneCertificationMetadata(seed?.certification),
  };

  return merged as NativeCapability;
}

function scores(
  routing: number,
  planning: number,
  coding: number,
  review: number,
  classify: number,
): Record<RegistryTaskType, number> {
  return { routing, planning, coding, review, classify };
}

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    vendor: capabilities.vendor,
    class: capabilities.class,
    strengths: [...capabilities.strengths],
    weaknesses: [...capabilities.weaknesses],
    disabled: capabilities.disabled,
    qualityScores: { ...capabilities.qualityScores },
    pricing: capabilities.pricing ? { ...capabilities.pricing } : undefined,
    defaultLadderEligible: capabilities.defaultLadderEligible,
    contextWindowTokens: capabilities.contextWindowTokens,
    toolSupport: capabilities.toolSupport,
    multimodal: { ...capabilities.multimodal },
    latencyTier: capabilities.latencyTier,
    reasoningTier: capabilities.reasoningTier,
    costPerMillionInputTokensUsd: capabilities.costPerMillionInputTokensUsd,
    costPerMillionOutputTokensUsd: capabilities.costPerMillionOutputTokensUsd,
    agent: capabilities.agent,
    codexChatgptCapability: cloneCodexChatgptCapability(capabilities.codexChatgptCapability),
    nativeCapability: cloneNativeCapability(capabilities.nativeCapability),
    supportedModel: cloneSupportedModelMetadata(capabilities.supportedModel),
    identity: capabilities.identity ? cloneIdentityMetadata(capabilities.identity) : undefined,
    releasedAt: capabilities.releasedAt,
  };
}

function cloneIdentityMetadata(identity: ModelIdentityMetadata): ModelIdentityMetadata {
  return {
    status: identity.status,
    revision: identity.revision,
    fingerprint: identity.fingerprint,
    displayName: identity.displayName,
    family: identity.family,
    evidencePolicy: identity.evidencePolicy,
    verification: identity.verification ? { ...identity.verification } : undefined,
    lineage: identity.lineage
      ? {
        predecessors: identity.lineage.predecessors ? [...identity.lineage.predecessors] : undefined,
        successor: identity.lineage.successor,
        formerIds: identity.lineage.formerIds ? [...identity.lineage.formerIds] : undefined,
        disclosedAt: identity.lineage.disclosedAt,
        disclosureSource: identity.lineage.disclosureSource,
      }
      : undefined,
  };
}

function cloneSupportedModelMetadata(
  metadata: SupportedModelMetadata | undefined,
): SupportedModelMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  return {
    wavemillAlias: metadata.wavemillAlias,
    providerNativeId: metadata.providerNativeId,
    provider: metadata.provider,
    transport: metadata.transport,
    stages: metadata.stages ? [...metadata.stages] : undefined,
    requiredCertificationPhaseByStage: metadata.requiredCertificationPhaseByStage
      ? { ...metadata.requiredCertificationPhaseByStage }
      : undefined,
    certificationSuiteVersion: metadata.certificationSuiteVersion,
    certificationFreshnessDays: metadata.certificationFreshnessDays,
    canonicalArtifactIdentity: metadata.canonicalArtifactIdentity
      ? { ...metadata.canonicalArtifactIdentity }
      : undefined,
    lifecycle: metadata.lifecycle,
    compatibilityFlags: metadata.compatibilityFlags ? { ...metadata.compatibilityFlags } : undefined,
    limitations: metadata.limitations ? [...metadata.limitations] : undefined,
    launchEligible: metadata.launchEligible,
    routingEligible: metadata.routingEligible,
  };
}

function cloneRegistry(registry: ModelRegistry): ModelRegistry {
  return {
    models: Object.fromEntries(
      Object.entries(registry.models).map(([modelId, capabilities]) => [modelId, cloneCapabilities(capabilities)])
    ),
    ladders: Object.fromEntries(
      Object.entries(registry.ladders).map(([taskType, ladder]) => [taskType, [...ladder]])
    ) as Partial<Record<RegistryTaskType, string[]>>,
  };
}

function dedupeModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const modelId of modelIds) {
    if (typeof modelId !== 'string' || modelId.length === 0 || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    deduped.push(modelId);
  }

  return deduped;
}

export function hasCapabilityConstraints(
  constraints?: CapabilityConstraints,
): constraints is CapabilityConstraints {
  if (!constraints) {
    return false;
  }

  return (
    constraints.minContextWindow !== undefined
    || constraints.requiresTools === true
    || constraints.requiresMultimodal === true
    || constraints.maxLatencyTier !== undefined
  );
}

export function compareLatencyTier(left: LatencyTier, right: LatencyTier): number {
  return LATENCY_TIER_RANK[left] - LATENCY_TIER_RANK[right];
}

export function evaluateCapabilityConstraints(
  model: Partial<ModelCapabilities>,
  constraints?: CapabilityConstraints,
): CapabilityFilterResult {
  if (!hasCapabilityConstraints(constraints)) {
    return { satisfied: true, failedConstraints: [] };
  }

  const failedConstraints: CapabilityConstraintName[] = [];

  if (
    constraints.minContextWindow !== undefined
    && (
      typeof model.contextWindowTokens !== 'number'
      || !Number.isFinite(model.contextWindowTokens)
      || model.contextWindowTokens < constraints.minContextWindow
    )
  ) {
    failedConstraints.push('minContextWindow');
  }

  if (
    constraints.requiresTools === true
    && (model.toolSupport === undefined || model.toolSupport === 'none')
  ) {
    failedConstraints.push('requiresTools');
  }

  if (
    constraints.requiresMultimodal === true
    && model.multimodal?.image !== true
  ) {
    failedConstraints.push('requiresMultimodal');
  }

  if (
    constraints.maxLatencyTier !== undefined
    && (
      model.latencyTier === undefined
      || compareLatencyTier(model.latencyTier, constraints.maxLatencyTier) > 0
    )
  ) {
    failedConstraints.push('maxLatencyTier');
  }

  return {
    satisfied: failedConstraints.length === 0,
    failedConstraints,
  };
}

export function satisfiesCapabilities(
  model: Partial<ModelCapabilities>,
  constraints?: CapabilityConstraints,
): boolean {
  return evaluateCapabilityConstraints(model, constraints).satisfied;
}

function makeDefaultCapabilities(override?: ModelCapabilitiesOverride): ModelCapabilities {
  return {
    vendor: override?.vendor ?? 'custom',
    class: override?.class ?? 'strong_generalist',
    strengths: override?.strengths ? [...override.strengths] : [],
    weaknesses: override?.weaknesses ? [...override.weaknesses] : [],
    disabled: override?.disabled,
    qualityScores: {
      routing: 0,
      planning: 0,
      coding: 0,
      review: 0,
      classify: 0,
      ...override?.qualityScores,
    },
    pricing: override?.pricing ? { ...override.pricing } : undefined,
    defaultLadderEligible: override?.defaultLadderEligible ?? true,
    contextWindowTokens: override?.contextWindowTokens ?? 128_000,
    toolSupport: override?.toolSupport ?? 'full',
    multimodal: override?.multimodal ? { ...override.multimodal } : { text: true, image: false },
    latencyTier: override?.latencyTier ?? 'standard',
    reasoningTier: override?.reasoningTier ?? 'standard',
    costPerMillionInputTokensUsd: override?.costPerMillionInputTokensUsd ?? 0,
    costPerMillionOutputTokensUsd: override?.costPerMillionOutputTokensUsd ?? 0,
    agent: override?.agent,
    codexChatgptCapability: override?.codexChatgptCapability
      ? mergeCodexChatgptCapability(undefined, override.codexChatgptCapability)
      : undefined,
    releasedAt: override?.releasedAt,
  };
}

function mergeCapabilities(
  base: ModelCapabilities | undefined,
  override: ModelCapabilitiesOverride,
): ModelCapabilities {
  const seed = base ? cloneCapabilities(base) : makeDefaultCapabilities(override);
  const mergedPricing = override.pricing
    ? { ...override.pricing }
    : seed.pricing
    ? {
      ...seed.pricing,
      inputCostPerMTok: override.costPerMillionInputTokensUsd ?? seed.pricing.inputCostPerMTok,
      outputCostPerMTok: override.costPerMillionOutputTokensUsd ?? seed.pricing.outputCostPerMTok,
    }
    : undefined;

  return {
    vendor: override.vendor ?? seed.vendor,
    class: override.class ?? seed.class,
    strengths: override.strengths ? [...override.strengths] : seed.strengths,
    weaknesses: override.weaknesses ? [...override.weaknesses] : seed.weaknesses,
    disabled: override.disabled ?? seed.disabled,
    qualityScores: {
      ...seed.qualityScores,
      ...override.qualityScores,
    },
    pricing: mergedPricing,
    defaultLadderEligible: override.defaultLadderEligible ?? seed.defaultLadderEligible ?? true,
    contextWindowTokens: override.contextWindowTokens ?? seed.contextWindowTokens,
    toolSupport: override.toolSupport ?? seed.toolSupport,
    multimodal: override.multimodal ? { ...override.multimodal } : { ...seed.multimodal },
    latencyTier: override.latencyTier ?? seed.latencyTier,
    reasoningTier: override.reasoningTier ?? seed.reasoningTier,
    costPerMillionInputTokensUsd:
      override.costPerMillionInputTokensUsd
      ?? override.pricing?.inputCostPerMTok
      ?? seed.costPerMillionInputTokensUsd,
    costPerMillionOutputTokensUsd:
      override.costPerMillionOutputTokensUsd
      ?? override.pricing?.outputCostPerMTok
      ?? seed.costPerMillionOutputTokensUsd,
    agent: override.agent ?? seed.agent,
    codexChatgptCapability: mergeCodexChatgptCapability(seed.codexChatgptCapability, override.codexChatgptCapability),
    nativeCapability: override.nativeCapability
      ? mergeNativeCapability(seed.nativeCapability, override.nativeCapability)
      : cloneNativeCapability(seed.nativeCapability),
    supportedModel: override.supportedModel
      ? {
        ...cloneSupportedModelMetadata(seed.supportedModel),
        ...override.supportedModel,
        stages: override.supportedModel.stages
          ? [...override.supportedModel.stages]
          : seed.supportedModel?.stages
          ? [...seed.supportedModel.stages]
          : undefined,
        requiredCertificationPhaseByStage: override.supportedModel.requiredCertificationPhaseByStage
          ? { ...override.supportedModel.requiredCertificationPhaseByStage }
          : seed.supportedModel?.requiredCertificationPhaseByStage
          ? { ...seed.supportedModel.requiredCertificationPhaseByStage }
          : undefined,
        canonicalArtifactIdentity: override.supportedModel.canonicalArtifactIdentity
          ? { ...override.supportedModel.canonicalArtifactIdentity }
          : seed.supportedModel?.canonicalArtifactIdentity
          ? { ...seed.supportedModel.canonicalArtifactIdentity }
          : undefined,
        compatibilityFlags: override.supportedModel.compatibilityFlags
          ? { ...override.supportedModel.compatibilityFlags }
          : seed.supportedModel?.compatibilityFlags
          ? { ...seed.supportedModel.compatibilityFlags }
          : undefined,
        limitations: override.supportedModel.limitations
          ? [...override.supportedModel.limitations]
          : seed.supportedModel?.limitations
          ? [...seed.supportedModel.limitations]
          : undefined,
      }
      : cloneSupportedModelMetadata(seed.supportedModel),
    identity: override.identity ? cloneIdentityMetadata(override.identity) : seed.identity ? cloneIdentityMetadata(seed.identity) : undefined,
    releasedAt: override.releasedAt ?? seed.releasedAt,
  };
}

/**
 * Pure derivation for native read-only capability from provider metadata.
 *
 * Mapping table:
 * - `openai` + `openai-responses` => `certified`
 * - `openrouter` + `openai-completions` + `thinkingFormat=openrouter` => `certified`
 * - `openrouter` + `openai-completions` without that compat flag => `partial`
 * - missing provider or transport, or any other combination => `unsupported`
 */
export function deriveReadOnlyNativeCapability(input: {
  nativeProvider?: NativeProviderName;
  piTransportKind?: PiTransportKind;
  compatFlags?: PiCompatFlags;
}): { capability: ReadOnlyNativeCapability; limitations: string[] } {
  if (!input.nativeProvider) {
    return { capability: 'unsupported', limitations: ['missing nativeProvider'] };
  }

  if (!input.piTransportKind) {
    return { capability: 'unsupported', limitations: ['missing piTransportKind'] };
  }

  if (input.nativeProvider === 'openai' && input.piTransportKind === 'openai-responses') {
    return { capability: 'certified', limitations: [] };
  }

  if (input.nativeProvider === 'openrouter' && input.piTransportKind === 'openai-completions') {
    if (input.compatFlags?.thinkingFormat === 'openrouter') {
      return { capability: 'certified', limitations: [] };
    }

    return {
      capability: 'partial',
      limitations: ['missing thinkingFormat=openrouter compat flag'],
    };
  }

  return {
    capability: 'unsupported',
    limitations: [
      `unsupported native provider/transport combination: ${input.nativeProvider}/${input.piTransportKind}`,
    ],
  };
}

function warnUnknownModel(taskType: RegistryTaskType, modelId: string): void {
  const key = `${taskType}:${modelId}`;
  if (warnedUnknownLadders.has(key)) {
    return;
  }
  warnedUnknownLadders.add(key);
  console.warn(
    `Ignoring unknown model "${modelId}" in the global ${taskType} model ladder`
  );
}

function compareModels(
  taskType: RegistryTaskType,
  [leftId, left]: [string, ModelCapabilities],
  [rightId, right]: [string, ModelCapabilities],
): number {
  const scoreDelta = right.qualityScores[taskType] - left.qualityScores[taskType];
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const classDelta = CLASS_RANK[right.class] - CLASS_RANK[left.class];
  if (classDelta !== 0) {
    return classDelta;
  }

  return leftId.localeCompare(rightId);
}

export class ModelValidationError extends Error {
  readonly modelId: string;

  constructor(modelId: string, message: string) {
    super(message);
    this.name = 'ModelValidationError';
    this.modelId = modelId;
  }
}

function canonicalIdentityPayload(input: {
  alias: string;
  providerNativeId: string;
  provider?: string;
  revision: number;
}): string {
  return JSON.stringify({
    alias: input.alias,
    providerNativeId: input.providerNativeId,
    provider: input.provider ?? null,
    revision: input.revision,
  });
}

export function computeIdentityFingerprint(input: {
  alias: string;
  providerNativeId: string;
  provider?: string;
  revision: number;
}): string {
  return createHash('sha256').update(canonicalIdentityPayload(input)).digest('hex');
}

function inferLegacyIdentityFamily(capabilities: Partial<ModelCapabilities>): ModelFamily | 'unknown' {
  const vendor = capabilities.vendor?.toLowerCase() ?? '';
  if (vendor.includes('anthropic')) return 'claude';
  if (vendor.includes('openai')) return 'gpt';
  if (vendor.includes('deepseek')) return 'deepseek';
  if (vendor.includes('qwen')) return 'qwen';
  if (vendor.includes('moonshot') || vendor.includes('kimi')) return 'kimi';
  if (vendor.includes('google') || vendor.includes('gemini')) return 'gemini';
  if (vendor.includes('meta') || vendor.includes('llama')) return 'llama';
  if (vendor.includes('mistral')) return 'mistral';
  if (vendor.includes('x-ai') || vendor.includes('grok')) return 'grok';
  return 'unknown';
}

export function resolveModelIdentity(
  registry: ModelRegistry,
  modelId: string,
): ModelIdentityMetadata {
  const registryKey = resolveModelRegistryKey(registry, modelId);
  const capabilities = registry.models[registryKey];
  if (!capabilities) {
    const alias = modelId;
    return {
      status: 'verified',
      revision: 1,
      fingerprint: computeIdentityFingerprint({ alias, providerNativeId: alias, revision: 1 }),
      displayName: alias,
      family: 'unknown',
      evidencePolicy: 'eligible',
    };
  }
  if (capabilities.identity) {
    return cloneIdentityMetadata(capabilities.identity);
  }
  const alias = capabilities.supportedModel?.wavemillAlias ?? registryKey;
  const providerNativeId = capabilities.supportedModel?.providerNativeId ?? registryKey;
  const provider = capabilities.supportedModel?.provider ?? capabilities.nativeCapability?.nativeProvider;
  return {
    status: 'verified',
    revision: 1,
    fingerprint: computeIdentityFingerprint({ alias, providerNativeId, provider, revision: 1 }),
    displayName: alias,
    family: inferLegacyIdentityFamily(capabilities),
    evidencePolicy: 'eligible',
  };
}

const MODEL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\[[a-z0-9]+\])?$/;
const PINNED_MODEL_PREFIXES = ['claude-', 'gpt-', 'deepseek-', 'gemini-'] as const;

export type ModelSelector =
  | { kind: 'alias'; family: string; channel?: Channel }
  | { kind: 'pinned'; modelId: string }
  | { kind: 'inherit' };

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
export type FallbackReason = 'quota-exhausted' | 'disabled-by-policy' | 'unavailable';

export interface ResolvedModel {
  requested: ModelSelector;
  resolved: string;
  source: ResolutionSource;
  familyChannel?: Channel;
  parentContextId?: string;
  fallbackReason?: FallbackReason;
}

export interface ResolutionContext {
  parent?: ResolvedModel;
  parentContextId?: string;
}

export type ModelSelectorParseErrorCode =
  | 'empty_input'
  | 'unknown_family'
  | 'malformed_pinned_id'
  | 'unknown_channel';

export class ModelSelectorParseError extends Error {
  readonly code: ModelSelectorParseErrorCode;
  readonly input: string;

  constructor(code: ModelSelectorParseErrorCode, input: string, message: string) {
    super(message);
    this.name = 'ModelSelectorParseError';
    this.code = code;
    this.input = input;
  }
}

export type ParseModelSelectorResult =
  | { ok: true; selector: ModelSelector }
  | { ok: false; error: ModelSelectorParseError };

export type ModelResolutionErrorCode =
  | 'missing_parent'
  | 'invalid_pinned_id'
  | 'unknown_alias'
  | 'channel_unpinned';

export class ModelResolutionError extends Error {
  readonly code: ModelResolutionErrorCode;
  readonly selector: ModelSelector;

  constructor(code: ModelResolutionErrorCode, selector: ModelSelector, message: string) {
    super(message);
    this.name = 'ModelResolutionError';
    this.code = code;
    this.selector = selector;
  }
}

export const FAMILY_ALIASES = Object.freeze({
  fable: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-fable-5',
    }),
    description: 'Stable Anthropic frontier alias for the Fable family.',
  }),
  opus: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-opus-4-8',
    }),
    description: 'Stable Anthropic frontier alias for the Opus family.',
  }),
  sonnet: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-sonnet-5',
    }),
    description: 'Stable Anthropic generalist alias for the Sonnet family.',
  }),
  haiku: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-haiku-4-5-20251001',
    }),
    description: 'Stable Anthropic economy alias for the Haiku family.',
  }),
  'gpt-5.5': Object.freeze({
    channels: Object.freeze({
      stable: 'gpt-5.5',
    }),
    description: 'Stable OpenAI frontier alias for the GPT-5.5 family.',
  }),
  'gpt-5.6': Object.freeze({
    channels: Object.freeze({
      stable: 'gpt-5.6-sol',
    }),
    description: 'OpenAI API alias for the GPT-5.6 family; resolves to Sol.',
  }),
  'gemini-pro': Object.freeze({
    channels: Object.freeze({
      stable: 'gemini-pro',
    }),
    description: 'Selector alias reserved for Gemini Pro integration follow-up work.',
  }),
}) satisfies Readonly<
  Record<string, { channels: Readonly<Partial<Record<Channel, string>>>; description?: string }>
>;

export const REVIEWER_ALIAS_MAP = Object.freeze({
  deep: 'claude-fable-5',
}) satisfies Readonly<Record<string, string>>;

function makeModelSelectorParseError(
  code: ModelSelectorParseErrorCode,
  input: string,
  message: string,
): ModelSelectorParseError {
  return new ModelSelectorParseError(code, input, message);
}

function isKnownFamilyAlias(family: string): boolean {
  return Object.hasOwn(FAMILY_ALIASES, family);
}

function isKnownChannel(channel: string): channel is Channel {
  return (CHANNELS as readonly string[]).includes(channel);
}

function isLikelyPinnedModelId(modelId: string): boolean {
  return PINNED_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix)) || /\d/.test(modelId);
}

function isFamilyLikeSelector(input: string): boolean {
  return /^[A-Za-z][A-Za-z0-9.-]*$/.test(input);
}

export function parseModelSelector(input: string): ParseModelSelectorResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: makeModelSelectorParseError(
        'empty_input',
        input,
        'Model selector input must not be empty.',
      ),
    };
  }

  if (trimmed === 'inherit') {
    return { ok: true, selector: { kind: 'inherit' } };
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex >= 0) {
    const family = trimmed.slice(0, colonIndex);
    const channelPart = trimmed.slice(colonIndex + 1).trim();
    if (isKnownFamilyAlias(family) && channelPart.length > 0) {
      if (!isKnownChannel(channelPart)) {
        return {
          ok: false,
          error: makeModelSelectorParseError(
            'unknown_channel',
            input,
            `Unknown channel "${channelPart}" for family "${family}". Known channels: ${CHANNELS.join(', ')}.`,
          ),
        };
      }

      return {
        ok: true,
        selector: { kind: 'alias', family, channel: channelPart },
      };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'malformed_pinned_id',
        input,
        `Invalid model selector "${trimmed}". Use "family[:channel]", "inherit", or a pinned model ID.`,
      ),
    };
  }

  if (isKnownFamilyAlias(trimmed)) {
    return { ok: true, selector: { kind: 'alias', family: trimmed, channel: 'stable' } };
  }

  // A concrete registered model ID takes precedence over the legacy
  // family-channel shorthand (for example, `gpt-5.6-terra` must not be
  // interpreted as the unsupported `gpt-5.6:terra` channel).
  if (Object.hasOwn(DEFAULT_MODEL_REGISTRY.models, trimmed)) {
    return { ok: true, selector: { kind: 'pinned', modelId: trimmed } };
  }

  for (const family of Object.keys(FAMILY_ALIASES)) {
    if (!trimmed.startsWith(`${family}-`)) {
      continue;
    }

    const channelPart = trimmed.slice(family.length + 1);
    if (isKnownChannel(channelPart)) {
      return {
        ok: true,
        selector: { kind: 'alias', family, channel: channelPart },
      };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_channel',
        input,
        `Unknown channel "${channelPart}" for family "${family}". Known channels: ${CHANNELS.join(', ')}.`,
      ),
    };
  }

  if (MODEL_ID_PATTERN.test(trimmed)) {
    if (isLikelyPinnedModelId(trimmed)) {
      return { ok: true, selector: { kind: 'pinned', modelId: trimmed } };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_family',
        input,
        `Unknown model family "${trimmed}". Add it to FAMILY_ALIASES or use a concrete pinned model ID.`,
      ),
    };
  }

  if (isFamilyLikeSelector(trimmed)) {
    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_family',
        input,
        `Unknown model family "${trimmed}". Add it to FAMILY_ALIASES or use a concrete pinned model ID.`,
      ),
    };
  }

  return {
    ok: false,
    error: makeModelSelectorParseError(
      'malformed_pinned_id',
      input,
      `Invalid pinned model ID "${trimmed}". Model IDs must be lowercase and may include digits, hyphens, dots, and one bracket suffix.`,
    ),
  };
}

export function isDeepSeekLikeModelId(modelId: string): boolean {
  return /^deepseek-/i.test(modelId);
}

export function configuredDeepSeekModelIds(registry: ModelRegistry): string[] {
  return Object.keys(registry.models)
    .filter((modelId) => modelId.startsWith('deepseek-'))
    .sort();
}

export function isKnownModelId(registry: ModelRegistry, modelId: string): boolean {
  return Object.hasOwn(registry.models, modelId);
}

export function normalizeReviewerModelId(
  input: string,
  registry: ModelRegistry,
): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (isKnownModelId(registry, trimmed)) {
    return trimmed;
  }

  const aliased = REVIEWER_ALIAS_MAP[trimmed as keyof typeof REVIEWER_ALIAS_MAP];
  if (aliased && isKnownModelId(registry, aliased)) {
    return aliased;
  }

  return null;
}

export function validateModelId(modelId: string): void {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelValidationError(
      modelId,
      `Error: Invalid model ID "${modelId}"\n\nModel IDs must be lowercase and may include digits, hyphens, dots, and a single bracket suffix like [1m].`,
    );
  }
}

function isReadOnlyNativeCapabilityValue(value: unknown): value is ReadOnlyNativeCapability {
  return typeof value === 'string' && (READ_ONLY_NATIVE_CAPABILITIES as readonly string[]).includes(value);
}

function isPiTransportKindValue(value: unknown): value is PiTransportKind {
  return typeof value === 'string' && (PI_TRANSPORT_KINDS as readonly string[]).includes(value);
}

function isCertificationPhaseValue(value: unknown): value is CertificationPhase {
  return typeof value === 'string' && (CERTIFICATION_PHASES as readonly string[]).includes(value);
}

function isSupportedModelStageValue(value: unknown): value is SupportedModelStage {
  return typeof value === 'string' && (SUPPORTED_MODEL_STAGES as readonly string[]).includes(value);
}

function isModelLifecycleStatusValue(value: unknown): value is ModelLifecycleStatus {
  return typeof value === 'string' && (MODEL_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

function isSafeCertificationSuiteVersion(value: string): boolean {
  return value.length > 0 && !UNSAFE_CERTIFICATION_SEGMENT.test(value);
}

function isSafeArtifactIdentitySegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[/\\\0]/.test(value);
}

export function validateNativeCapability(
  modelId: string,
  capabilities: Pick<ModelCapabilities, 'nativeCapability'>,
): void {
  const nativeCapability = capabilities.nativeCapability;
  if (!nativeCapability) {
    return;
  }

  if (!isReadOnlyNativeCapabilityValue(nativeCapability.readOnlyNative)) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative must be one of ${READ_ONLY_NATIVE_CAPABILITIES.join(', ')}`,
    );
  }

  if (
    (nativeCapability.readOnlyNative === 'certified' || nativeCapability.readOnlyNative === 'partial')
    && !nativeCapability.nativeProvider
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative=${nativeCapability.readOnlyNative} requires nativeProvider`,
    );
  }

  if (
    (nativeCapability.readOnlyNative === 'certified' || nativeCapability.readOnlyNative === 'partial')
    && !nativeCapability.piTransportKind
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative=${nativeCapability.readOnlyNative} requires piTransportKind`,
    );
  }

  if (
    nativeCapability.piTransportKind !== undefined
    && !isPiTransportKindValue(nativeCapability.piTransportKind)
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.piTransportKind must be one of ${PI_TRANSPORT_KINDS.join(', ')}`,
    );
  }

  const derived = deriveReadOnlyNativeCapability({
    nativeProvider: nativeCapability.nativeProvider,
    piTransportKind: nativeCapability.piTransportKind,
    compatFlags: nativeCapability.compatFlags,
  });

  if (nativeCapability.readOnlyNative !== derived.capability) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative=${nativeCapability.readOnlyNative} contradicts compat flags (derived: ${derived.capability})`,
    );
  }

  const certification = nativeCapability.certification;
  if (!certification) {
    return;
  }

  if (!nativeCapability.nativeProvider) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification requires nativeProvider`,
    );
  }

  if (!nativeCapability.piTransportKind) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification requires piTransportKind`,
    );
  }

  if (nativeCapability.readOnlyNative === 'unsupported') {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification contradicts readOnlyNative=unsupported`,
    );
  }

  if (!isCertificationPhaseValue(certification.maxCertifiedPhase)) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.maxCertifiedPhase must be one of ${CERTIFICATION_PHASES.join(', ')}`,
    );
  }

  if (typeof certification.certifiedAt !== 'string' || certification.certifiedAt.length === 0 || Number.isNaN(Date.parse(certification.certifiedAt))) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.certifiedAt must be a valid ISO 8601 datetime`,
    );
  }

  if (
    typeof certification.certificationSuiteVersion !== 'string'
    || !isSafeCertificationSuiteVersion(certification.certificationSuiteVersion)
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.certificationSuiteVersion must be a non-empty safe path segment`,
    );
  }

  if (
    certification.knownLimitations !== undefined
    && (!Array.isArray(certification.knownLimitations) || !certification.knownLimitations.every((value) => typeof value === 'string'))
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.knownLimitations must be an array of strings`,
    );
  }
}

export function validateSupportedModelMetadata(
  modelId: string,
  capabilities: Pick<ModelCapabilities, 'supportedModel' | 'nativeCapability'>,
): void {
  const metadata = capabilities.supportedModel;
  if (!metadata) {
    return;
  }

  if (metadata.lifecycle !== undefined && !isModelLifecycleStatusValue(metadata.lifecycle)) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: supportedModel.lifecycle must be one of ${MODEL_LIFECYCLE_STATUSES.join(', ')}`,
    );
  }

  if (metadata.stages !== undefined) {
    if (!Array.isArray(metadata.stages) || !metadata.stages.every(isSupportedModelStageValue)) {
      throw new ModelValidationError(
        modelId,
        `model ${modelId}: supportedModel.stages must contain only ${SUPPORTED_MODEL_STAGES.join(', ')}`,
      );
    }
  }

  for (const [stage, phase] of Object.entries(metadata.requiredCertificationPhaseByStage ?? {})) {
    if (!isSupportedModelStageValue(stage) || !isCertificationPhaseValue(phase)) {
      throw new ModelValidationError(
        modelId,
        `model ${modelId}: supportedModel.requiredCertificationPhaseByStage has an invalid stage or phase`,
      );
    }
  }

  const identity = metadata.canonicalArtifactIdentity;
  if (identity) {
    for (const [name, value] of Object.entries(identity)) {
      if (typeof value !== 'string' || !isSafeArtifactIdentitySegment(value)) {
        throw new ModelValidationError(
          modelId,
          `model ${modelId}: supportedModel.canonicalArtifactIdentity.${name} must be a non-empty safe path segment`,
        );
      }
    }
  }
}

function assertPricingConsistency(modelId: string, capabilities: ModelCapabilities): void {
  if (!capabilities.pricing) {
    return;
  }
  if (capabilities.pricing.inputCostPerMTok !== capabilities.costPerMillionInputTokensUsd) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: pricing.inputCostPerMTok must equal costPerMillionInputTokensUsd`,
    );
  }
  if (capabilities.pricing.outputCostPerMTok !== capabilities.costPerMillionOutputTokensUsd) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: pricing.outputCostPerMTok must equal costPerMillionOutputTokensUsd`,
    );
  }
}

function assertIdentityInvariants(registry: ModelRegistry): void {
  const providerNativeIds = new Map<string, string>();
  const aliases = new Map<string, string>();

  for (const [modelId, capabilities] of Object.entries(registry.models)) {
    const alias = capabilities.supportedModel?.wavemillAlias ?? modelId;
    const providerNativeId = capabilities.supportedModel?.providerNativeId;
    const provider = capabilities.supportedModel?.provider ?? capabilities.nativeCapability?.nativeProvider;
    const identity = capabilities.identity;

    const previousAlias = aliases.get(alias);
    if (previousAlias && previousAlias !== modelId) {
      throw new ModelValidationError(modelId, `model ${modelId}: duplicate wavemill alias ${alias} also used by ${previousAlias}`);
    }
    aliases.set(alias, modelId);

    // Deprecated aliases may retain a historical providerNativeId; every
    // other alias must map to a distinct provider-native model.
    if (providerNativeId && (capabilities.identity || capabilities.supportedModel?.lifecycle !== 'deprecated')) {
      const previousProviderId = providerNativeIds.get(providerNativeId);
      if (previousProviderId && previousProviderId !== modelId) {
        throw new ModelValidationError(
          modelId,
          `model ${modelId}: duplicate providerNativeId ${providerNativeId} also used by ${previousProviderId}`,
        );
      }
      providerNativeIds.set(providerNativeId, modelId);
    }

    if (!identity) {
      continue;
    }

    if (identity.status !== 'provisional' && identity.status !== 'verified') {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.status must be provisional or verified`);
    }
    if (identity.evidencePolicy !== 'held' && identity.evidencePolicy !== 'eligible') {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.evidencePolicy must be held or eligible`);
    }
    if (!Number.isInteger(identity.revision) || identity.revision < 1) {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.revision must be an integer >= 1`);
    }
    if (typeof identity.displayName !== 'string' || identity.displayName.trim().length === 0) {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.displayName must be non-empty`);
    }
    const expectedFingerprint = computeIdentityFingerprint({
      alias,
      providerNativeId: providerNativeId ?? alias,
      provider,
      revision: identity.revision,
    });
    if (identity.fingerprint !== expectedFingerprint) {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.fingerprint does not match alias/provider/revision`);
    }

    if (identity.status === 'provisional') {
      if ((capabilities.supportedModel?.routingEligible ?? true) !== false) {
        throw new ModelValidationError(modelId, `model ${modelId}: provisional identity must set supportedModel.routingEligible=false`);
      }
      if (capabilities.defaultLadderEligible !== false) {
        throw new ModelValidationError(modelId, `model ${modelId}: provisional identity must set defaultLadderEligible=false`);
      }
      if (!Object.values(capabilities.qualityScores).every((score) => score === 0)) {
        throw new ModelValidationError(modelId, `model ${modelId}: provisional identity must keep qualityScores at 0`);
      }
      if (identity.evidencePolicy !== 'held') {
        throw new ModelValidationError(modelId, `model ${modelId}: provisional identity must set evidencePolicy=held`);
      }
      if (identity.family !== 'unknown' && !identity.verification) {
        throw new ModelValidationError(modelId, `model ${modelId}: provisional identity family must remain unknown without verification`);
      }
      if (identity.lineage?.successor) {
        throw new ModelValidationError(modelId, `model ${modelId}: provisional identity cannot declare a successor before promotion`);
      }
      for (const [taskType, ladder] of Object.entries(registry.ladders)) {
        if (ladder?.includes(modelId)) {
          throw new ModelValidationError(modelId, `model ${modelId}: provisional identity cannot appear in ${taskType} ladder`);
        }
      }
    }

    if (identity.status === 'verified') {
      if (identity.family === 'unknown') {
        throw new ModelValidationError(modelId, `model ${modelId}: verified identity cannot use unknown family`);
      }
      if (capabilities.nativeCapability && !providerNativeId) {
        throw new ModelValidationError(modelId, `model ${modelId}: verified native identity must declare providerNativeId`);
      }
    }
  }

  for (const [modelId, capabilities] of Object.entries(registry.models)) {
    const successor = capabilities.identity?.lineage?.successor;
    if (!successor) {
      continue;
    }
    const successorCapabilities = registry.models[successor];
    if (!successorCapabilities) {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.lineage.successor ${successor} does not exist`);
    }
    const successorIdentity = resolveModelIdentity(registry, successor);
    if (successorIdentity.status !== 'verified') {
      throw new ModelValidationError(modelId, `model ${modelId}: identity.lineage.successor ${successor} must be verified`);
    }
    const seen = new Set<string>([modelId]);
    let cursor: string | undefined = successor;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new ModelValidationError(modelId, `model ${modelId}: identity.lineage contains a cycle through ${cursor}`);
      }
      seen.add(cursor);
      cursor = registry.models[cursor]?.identity?.lineage?.successor;
    }
  }
}

export function assertRegistryConsistency(registry: ModelRegistry): void {
  for (const [modelId, capabilities] of Object.entries(registry.models)) {
    validateNativeCapability(modelId, capabilities);
    validateSupportedModelMetadata(modelId, capabilities);
    assertPricingConsistency(modelId, capabilities);
  }
  assertIdentityInvariants(registry);
  assertRegistryAdmissionCriteria(registry);
}

export function claimedStagesForModel(
  capabilities: Pick<ModelCapabilities, 'supportedModel' | 'qualityScores'>,
): SupportedModelStage[] {
  if (capabilities.supportedModel?.stages !== undefined) {
    return [...capabilities.supportedModel.stages];
  }

  return SUPPORTED_MODEL_STAGES.filter((stage) => {
    if (stage === 'expansion') return false;
    return (capabilities.qualityScores[stage] ?? 0) > 0;
  });
}

export function explainAdmissionViolations(
  modelId: string,
  capabilities: Pick<ModelCapabilities, 'contextWindowTokens' | 'disabled' | 'qualityScores' | 'supportedModel' | 'toolSupport'>,
): AdmissionViolation[] {
  void modelId;
  if (capabilities.disabled === true || capabilities.supportedModel?.lifecycle === 'blocked') {
    return [];
  }

  const violations: AdmissionViolation[] = [];
  for (const stage of claimedStagesForModel(capabilities)) {
    const minimumContextWindow = STAGE_MIN_CONTEXT_WINDOW_TOKENS[stage];
    if (capabilities.contextWindowTokens < minimumContextWindow) {
      violations.push({
        stage,
        reason: 'context-window-below-minimum',
        detail: `declares contextWindowTokens=${capabilities.contextWindowTokens}, below ${stage} minimum ${minimumContextWindow}`,
      });
    }

    if (!hasSufficientToolSupport(capabilities, stage)) {
      violations.push({
        stage,
        reason: 'tool-support-insufficient',
        detail: `declares toolSupport=${capabilities.toolSupport}, insufficient for ${stage}`,
      });
    }
  }

  return violations;
}

export function assertRegistryAdmissionCriteria(registry: ModelRegistry): void {
  const failures = Object.entries(registry.models)
    .flatMap(([modelId, capabilities]) => explainAdmissionViolations(modelId, capabilities)
      .map((violation) => ({ modelId, violation })));
  if (failures.length === 0) {
    return;
  }

  const [first] = failures;
  const details = failures
    .map(({ modelId, violation }) => `model ${modelId} stage ${violation.stage}: ${violation.detail}`)
    .join('; ');
  throw new ModelValidationError(
    first?.modelId ?? 'registry',
    `${details}. Narrow supportedModel.stages to stages the model can run, raise declared capabilities, set disabled=true, or set supportedModel.lifecycle='blocked' for retained historical entries.`,
  );
}

export function resolveSelector(selector: ModelSelector, context?: ResolutionContext): ResolvedModel {
  switch (selector.kind) {
    case 'alias': {
      const entry = FAMILY_ALIASES[selector.family as keyof typeof FAMILY_ALIASES];
      if (!entry) {
        throw new ModelResolutionError(
          'unknown_alias',
          selector,
          `Unknown model family alias "${selector.family}". Known aliases: ${Object.keys(FAMILY_ALIASES).join(', ')}.`,
        );
      }
      const channel: Channel = selector.channel ?? 'stable';
      const resolvedModelId = entry.channels[channel];
      if (resolvedModelId === undefined) {
        throw new ModelResolutionError(
          'channel_unpinned',
          selector,
          `No pin registered for family "${selector.family}" channel "${channel}". Add one to FAMILY_ALIASES or choose a different channel.`,
        );
      }

      const result: ResolvedModel = {
        requested: selector,
        resolved: resolvedModelId,
        source: 'alias',
        familyChannel: channel,
      };
      return result;
    }
    case 'pinned': {
      validateModelId(selector.modelId);
      return {
        requested: selector,
        resolved: selector.modelId,
        source: 'pinned',
      };
    }
    case 'inherit': {
      if (!context?.parent) {
        throw new ModelResolutionError(
          'missing_parent',
          selector,
          'Cannot resolve "inherit" selector without a parent resolution in context.parent.',
        );
      }
      const result: ResolvedModel = {
        requested: selector,
        resolved: context.parent.resolved,
        source: 'inherited',
      };
      if (context.parentContextId !== undefined) {
        result.parentContextId = context.parentContextId;
      }
      return result;
    }
    default: {
      const _exhaustive: never = selector;
      throw new Error(`Unhandled ModelSelector kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export const DEFAULT_MODEL_REGISTRY: ModelRegistry = loadDefaultModelRegistry();

export function isModelEnabled(capabilities: ModelCapabilities | undefined): boolean {
  return capabilities !== undefined && capabilities.disabled !== true;
}

export function resolveModelRegistryKey(registry: ModelRegistry, modelId: string): string {
  if (registry.models[modelId]) {
    return modelId;
  }

  const alias = resolveWavemillAliasFromOpenRouterId(modelId);
  return alias && registry.models[alias] ? alias : modelId;
}

export function getModel(registry: ModelRegistry, modelId: string): ModelCapabilities | undefined {
  if (!modelId) {
    return undefined;
  }
  return registry.models[resolveModelRegistryKey(registry, modelId)];
}

export function getLadder(registry: ModelRegistry, taskType: RegistryTaskType): string[] {
  const configured = registry.ladders[taskType];
  if (configured) {
    return configured.filter((modelId) => {
      if (isModelEnabled(registry.models[modelId])) {
        return true;
      }
      if (registry.models[modelId]) {
        return false;
      }
      warnUnknownModel(taskType, modelId);
      return false;
    });
  }

  return Object.entries(registry.models)
    .filter(([, capabilities]) => isModelEnabled(capabilities))
    .filter(([, capabilities]) => capabilities.defaultLadderEligible !== false)
    .filter(([, capabilities]) => Number.isFinite(capabilities.qualityScores[taskType]))
    .sort((left, right) => compareModels(taskType, left, right))
    .filter(([, capabilities]) => capabilities.qualityScores[taskType] > 0)
    .map(([modelId]) => modelId);
}

export function rankCandidates(
  registry: ModelRegistry,
  taskType: RegistryTaskType,
  opts?: { excluded?: string[] },
): string[] {
  const excluded = new Set(opts?.excluded ?? []);
  return getLadder(registry, taskType).filter((modelId) => !excluded.has(modelId));
}

export function mergeModelRegistry(
  defaults: ModelRegistry,
  overrides?: { models?: Record<string, ModelCapabilitiesOverride>; ladders?: Partial<Record<RegistryTaskType, string[]>> },
): ModelRegistry {
  const merged = cloneRegistry(defaults);
  if (!overrides) {
    return merged;
  }

  for (const [modelId, override] of Object.entries(overrides.models ?? {})) {
    merged.models[modelId] = mergeCapabilities(merged.models[modelId], override);
  }

  for (const taskType of TASK_TYPES) {
    const overrideLadder = overrides.ladders?.[taskType];
    if (overrideLadder) {
      merged.ladders[taskType] = [...overrideLadder];
    }
  }

  assertRegistryConsistency(merged);
  return merged;
}

export function getEffectiveRegistry(repoDir?: string): ModelRegistry {
  void repoDir;
  return DEFAULT_MODEL_REGISTRY;
}

export function normalizeSupportedModelStage(stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType): SupportedModelStage {
  if (stage === 'planner') return 'planning';
  if (stage === 'coder') return 'coding';
  if (stage === 'reviewer') return 'review';
  if (stage === 'routing' || stage === 'classify') return 'planning';
  return stage;
}

export function getRequiredCertificationPhaseForStage(
  modelId: string,
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  registry: ModelRegistry = getEffectiveRegistry(),
): CertificationPhase | undefined {
  const normalized = normalizeSupportedModelStage(stage);
  const capabilities = getModel(registry, modelId);
  const explicit = capabilities?.supportedModel?.requiredCertificationPhaseByStage?.[normalized];
  if (explicit) {
    return explicit;
  }
  if (!capabilities?.nativeCapability) {
    return undefined;
  }
  if (normalized === 'coding') return 'patch';
  if (normalized === 'planning') return 'workflow';
  return 'read-only';
}

export function resolveProviderNativeModelId(
  modelId: string,
  registry: ModelRegistry = getEffectiveRegistry(),
): { wavemillAlias: string; providerNativeId: string; provider?: NativeProviderName; transport?: PiTransportKind } | undefined {
  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return undefined;
  }
  return {
    wavemillAlias: capabilities.supportedModel?.wavemillAlias ?? modelId,
    providerNativeId: capabilities.supportedModel?.providerNativeId ?? modelId,
    provider: capabilities.supportedModel?.provider ?? capabilities.nativeCapability?.nativeProvider,
    transport: capabilities.supportedModel?.transport ?? capabilities.nativeCapability?.piTransportKind,
  };
}

export function explainModelSupportExclusion(
  modelId: string,
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  registry: ModelRegistry = getEffectiveRegistry(),
): ModelSupportExclusionReason | undefined {
  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return 'unknown-model';
  }
  const lifecycle = capabilities.supportedModel?.lifecycle ?? 'supported';
  if (lifecycle === 'blocked') return 'blocked-lifecycle';
  if (resolveModelIdentity(registry, modelId).status === 'provisional') return 'provisional-identity';
  if (capabilities.disabled === true) return 'disabled';
  const normalized = normalizeSupportedModelStage(stage);
  const configuredStages = capabilities.supportedModel?.stages;
  if (configuredStages && !configuredStages.includes(normalized)) {
    return 'stage-incompatible';
  }
  if (stageRequiresTools(normalized) && !hasSufficientToolSupport(capabilities, normalized)) {
    return 'tool-support-insufficient';
  }
  if (!hasSufficientContextWindow(capabilities, normalized)) {
    return 'context-window-insufficient';
  }
  if ((capabilities.supportedModel?.routingEligible ?? true) === false) {
    return 'routing-ineligible';
  }
  return undefined;
}

export function stageRequiresTools(stage: SupportedModelStage): boolean {
  return STAGE_REQUIRES_TOOLS[stage] === true;
}

export function hasSufficientToolSupport(
  capabilities: Pick<ModelCapabilities, 'toolSupport'>,
  stage: SupportedModelStage,
): boolean {
  return !stageRequiresTools(stage) || !INSUFFICIENT_TOOL_SUPPORT.has(capabilities.toolSupport);
}

export function listSupportedModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  registry: ModelRegistry = getEffectiveRegistry(),
): string[] {
  const normalized = normalizeSupportedModelStage(stage);
  return Object.entries(registry.models)
    .filter(([modelId]) => explainModelSupportExclusion(modelId, normalized, registry) === undefined)
    .filter(([, capabilities]) => {
      const configuredStages = capabilities.supportedModel?.stages;
      if (configuredStages) {
        return configuredStages.includes(normalized);
      }
      return (capabilities.qualityScores[normalized] ?? 0) > 0;
    })
    .map(([modelId]) => modelId);
}

/**
 * Hosted Codex authenticates through a ChatGPT account, whose model inventory
 * is narrower than the OpenAI API. Missing metadata is deliberately ineligible
 * so a new API model cannot accidentally be launched through Codex.
 */
export function isCodexChatgptLaunchEligible(capabilities: ModelCapabilities | undefined): boolean {
  return capabilities?.codexChatgptCapability?.supported === true;
}

/**
 * Explicit migrations for retired model IDs emitted by historical route
 * artifacts or external routers. These are deliberately narrow: an unknown or
 * otherwise ineligible model must still be rejected by agent resolution.
 */
export const CODEX_CHATGPT_SUCCESSOR_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'gpt-5.4': 'gpt-5.6-terra',
  'gpt-5': 'gpt-5.6-terra',
  'gpt-5-mini': 'gpt-5.6-terra',
});

export function resolveModelSuccessor(
  modelId: string,
  registry: ModelRegistry = DEFAULT_MODEL_REGISTRY,
  opts?: { stage?: SupportedModelStage | DescriptorModelStage | RegistryTaskType },
): string | null {
  const capabilities = getModel(registry, modelId);
  const successor = capabilities?.identity?.lineage?.successor;
  if (!successor || successor === modelId) {
    return null;
  }

  const successorCapabilities = getModel(registry, successor);
  if (!successorCapabilities) {
    return null;
  }

  if (successorCapabilities.supportedModel?.launchEligible === false) {
    return null;
  }

  if (opts?.stage && explainModelSupportExclusion(successor, opts.stage, registry) !== undefined) {
    return null;
  }

  return successor;
}

/**
 * Returns a launchable Codex successor for a specifically retired model ID.
 * The target is checked against the effective registry so local configuration
 * cannot turn a migration into an invalid launch.
 */
export function resolveCodexChatgptSuccessor(
  modelId: string,
  registry: ModelRegistry = DEFAULT_MODEL_REGISTRY,
): string | null {
  const successor = resolveModelSuccessor(modelId, registry) ?? CODEX_CHATGPT_SUCCESSOR_MODELS[modelId];
  if (!successor) return null;

  const capabilities = getModel(registry, successor);
  return capabilities?.agent === 'codex' && isCodexChatgptLaunchEligible(capabilities)
    ? successor
    : null;
}

/**
 * Use this guard at any native read-only selection site. Mere model availability
 * does not imply native read-only certification.
 */
export function isReadOnlyNativeCapable(
  modelId: string,
  opts?: { registry?: ModelRegistry; allowPartial?: boolean },
): boolean {
  const registry = opts?.registry ?? getEffectiveRegistry();
  const capability = getModel(registry, modelId)?.nativeCapability?.readOnlyNative;
  if (capability === 'certified') {
    return true;
  }
  return capability === 'partial' && opts?.allowPartial === true;
}

export type RegistryPhaseEligibilityReason = 'no-metadata' | 'stale' | 'phase-insufficient';

export type RegistryPhaseEligibility =
  | {
    eligible: true;
    modelId: string;
    phase: CertificationPhase;
    certifiedAt: string;
    suiteVersion: string;
  }
  | {
    eligible: false;
    modelId: string;
    phase: CertificationPhase;
    reason: RegistryPhaseEligibilityReason;
    certifiedAt?: string;
    suiteVersion?: string;
  };

export function evaluateRegistryPhaseEligibility(input: {
  modelId: string;
  phase: CertificationPhase;
  registry?: ModelRegistry;
  now?: Date;
}): RegistryPhaseEligibility {
  const registry = input.registry ?? getEffectiveRegistry();
  const certification = getModel(registry, input.modelId)?.nativeCapability?.certification;

  if (!certification) {
    return {
      eligible: false,
      modelId: input.modelId,
      phase: input.phase,
      reason: 'no-metadata',
    };
  }

  const now = input.now ?? new Date();
  const expiryMs = Date.parse(certification.certifiedAt) + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() >= expiryMs) {
    return {
      eligible: false,
      modelId: input.modelId,
      phase: input.phase,
      reason: 'stale',
      certifiedAt: certification.certifiedAt,
      suiteVersion: certification.certificationSuiteVersion,
    };
  }

  if (!phaseSatisfies(certification.maxCertifiedPhase, input.phase)) {
    return {
      eligible: false,
      modelId: input.modelId,
      phase: input.phase,
      reason: 'phase-insufficient',
      certifiedAt: certification.certifiedAt,
      suiteVersion: certification.certificationSuiteVersion,
    };
  }

  return {
    eligible: true,
    modelId: input.modelId,
    phase: input.phase,
    certifiedAt: certification.certifiedAt,
    suiteVersion: certification.certificationSuiteVersion,
  };
}

export type NativeReadOnlyRoutingMode = 'task' | 'certification';

export function isNativeAgentType(agent: AgentType | string): agent is Extract<AgentType, `native-${string}`> {
  return agent === 'native-openai' || agent === 'native-openrouter';
}

export function nativeAgentTypeForProvider(provider: NativeProviderName): Extract<AgentType, `native-${string}`> {
  return provider === 'openai' ? 'native-openai' : 'native-openrouter';
}

export interface NativeReadOnlyRoutingDecision {
  routable: boolean;
  certified: boolean;
  mode: NativeReadOnlyRoutingMode;
  phase: string;
  modelId: string;
  capability: ReadOnlyNativeCapability | 'unregistered';
  reason?: string;
}

export class NativeReadOnlyCertificationError extends Error {
  readonly modelId: string;
  readonly phase: string;
  readonly capability: ReadOnlyNativeCapability | 'unregistered';

  constructor(modelId: string, phase: string, capability: ReadOnlyNativeCapability | 'unregistered', message: string) {
    super(message);
    this.name = 'NativeReadOnlyCertificationError';
    this.modelId = modelId;
    this.phase = phase;
    this.capability = capability;
  }
}

export function evaluateNativeReadOnlyRouting(input: {
  modelId: string;
  phase: string;
  mode?: NativeReadOnlyRoutingMode;
  registry?: ModelRegistry;
  allowPartial?: boolean;
}): NativeReadOnlyRoutingDecision {
  const mode = input.mode ?? 'task';
  const registry = input.registry ?? getEffectiveRegistry();
  const nativeCapability = getModel(registry, input.modelId)?.nativeCapability;
  const capability: ReadOnlyNativeCapability | 'unregistered' = nativeCapability?.readOnlyNative ?? 'unregistered';
  const certified = isReadOnlyNativeCapable(input.modelId, { registry, allowPartial: input.allowPartial });

  if (mode === 'certification') {
    return {
      routable: false,
      certified,
      mode,
      phase: input.phase,
      modelId: input.modelId,
      capability,
    };
  }

  if (!certified) {
    const reason = capability === 'unregistered'
      ? `Refusing native read-only routing: model "${input.modelId}" is not registered in the model registry for the "${input.phase}" phase (capability: unregistered; required: certified). Native execution is disabled for this model — certify it via the smoke/certification path before routing.`
      : `Refusing native read-only routing: model "${input.modelId}" is not read-only-native certified for the "${input.phase}" phase (capability: ${capability}; required: certified). Native execution is disabled for this model — certify it via the smoke/certification path before routing.`;

    return {
      routable: false,
      certified: false,
      mode,
      phase: input.phase,
      modelId: input.modelId,
      capability,
      reason,
    };
  }

  return {
    routable: true,
    certified: true,
    mode,
    phase: input.phase,
    modelId: input.modelId,
    capability,
  };
}

export function assertNativeReadOnlyRoutable(input: {
  modelId: string;
  phase: string;
  mode?: NativeReadOnlyRoutingMode;
  registry?: ModelRegistry;
  allowPartial?: boolean;
}): void {
  const decision = evaluateNativeReadOnlyRouting(input);
  if (decision.mode === 'task' && !decision.routable && decision.reason) {
    throw new NativeReadOnlyCertificationError(
      decision.modelId,
      decision.phase,
      decision.capability,
      decision.reason,
    );
  }
}

export function getConfiguredModelsForDescriptorStage(
  repoDir: string | undefined,
  stage: DescriptorModelStage,
): string[] {
  void repoDir;
  const registry = getEffectiveRegistry(repoDir);
  const filterDescriptorModels = (modelIds: string[]): string[] =>
    filterDisabledModels(dedupeModelIds(modelIds))
      .filter((modelId) => {
        const capabilities = registry.models[modelId];
        return capabilities === undefined || isModelEnabled(capabilities);
      });

  return filterDescriptorModels(getLadder(registry, DESCRIPTOR_STAGE_TO_TASK_TYPE[stage]));
}

export function getConfiguredModelsForDescriptor(repoDir?: string): string[] {
  return dedupeModelIds([
    ...getConfiguredModelsForDescriptorStage(repoDir, 'planner'),
    ...getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
    ...getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'),
  ]);
}

export function resetWarningState(): void {
  warnedUnknownLadders.clear();
}
