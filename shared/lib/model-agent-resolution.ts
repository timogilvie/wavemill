import {
  DEFAULT_MODEL_REGISTRY,
  evaluateRegistryPhaseEligibility,
  explainModelSupportExclusion,
  getStageContextWindowFloor,
  getModel,
  isCodexChatgptLaunchEligible,
  resolveCodexChatgptSuccessor,
  resolveModelSuccessor,
  type AgentType,
  type ModelRegistry,
  type NativeProviderName,
  type SupportedModelStage,
} from './model-registry.ts';
import type { CertificationPhase } from './native-agent/certification/schema.ts';
import { evaluateNativeProviderGate } from './native-agent/certification/eligibility-gate.ts';
import { resolveLaunchPriorityModel, type RoleEligibility } from './openrouter-catalog.ts';

export type AgentResolutionPhase = 'planning' | 'coding' | 'review';

export type UnroutableReason =
  | 'invalid-model-id'
  | 'unknown-model'
  | 'no-native-capability'
  | 'native-unsupported'
  | 'lifecycle-blocked'
  | 'tool-support-insufficient'
  | 'context-window-insufficient'
  | 'role-ineligible'
  | 'uncertified'
  | 'codex-chatgpt-ineligible';

export type AgentResolution =
  | { ok: true; agent: AgentType }
  | { ok: false; reason: UnroutableReason; diagnostic: string; certifyCommand?: string };

export type LaunchPreflightFailureReason =
  | 'retired-model-no-successor'
  | 'successor-ineligible'
  | UnroutableReason;

export type LaunchPreflight =
  | {
    ok: true;
    requestedModel: string;
    resolvedModel: string;
    agent: AgentType;
    phase: AgentResolutionPhase;
  }
  | {
    ok: false;
    requestedModel: string;
    resolvedModel: string | null;
    phase: AgentResolutionPhase;
    reason: LaunchPreflightFailureReason;
    diagnostic: string;
    remediation?: string;
    certifyCommand?: string;
  };

interface ResolveModelAgentOptions {
  model: string;
  phase: AgentResolutionPhase;
  repoDir?: string;
  registry?: ModelRegistry;
  now?: Date;
  certificationRoot?: string;
}

const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._/-]+(?:\[[A-Za-z0-9._-]+\])?$/;

const CERTIFICATION_PHASE_BY_AGENT_PHASE: Record<AgentResolutionPhase, CertificationPhase> = {
  planning: 'workflow',
  coding: 'patch',
  review: 'read-only',
};
const SUPPORTED_STAGE_BY_AGENT_PHASE: Record<AgentResolutionPhase, SupportedModelStage> = {
  planning: 'planning',
  coding: 'coding',
  review: 'review',
};

function certificationPhaseForAgentPhase(phase: AgentResolutionPhase): CertificationPhase {
  return CERTIFICATION_PHASE_BY_AGENT_PHASE[phase];
}

function inferHostedAgent(vendor: string | undefined): Extract<AgentType, 'claude' | 'codex'> | undefined {
  if (vendor === 'anthropic' || vendor === 'deepseek') {
    return 'claude';
  }
  if (vendor === 'openai') {
    return 'codex';
  }
  return undefined;
}

function certifyCommandFor(modelId: string, provider: NativeProviderName, phase: AgentResolutionPhase): string {
  return `npx tsx tools/native-agent-certify.ts --provider ${provider} --model ${modelId} --phase ${certificationPhaseForAgentPhase(phase)}`;
}

function launchPriorityRoleEligibility(modelId: string, phase: AgentResolutionPhase): {
  eligible: boolean;
  eligibleRoles?: readonly RoleEligibility[];
} {
  const launchPriorityModel = resolveLaunchPriorityModel(modelId);
  if (!launchPriorityModel) {
    return { eligible: true };
  }
  return {
    eligible: launchPriorityModel.roleEligibility.includes(phase),
    eligibleRoles: launchPriorityModel.roleEligibility,
  };
}

function buildDiagnostic(input: {
  modelId: string;
  phase: AgentResolutionPhase;
  provider?: NativeProviderName;
  reason: UnroutableReason;
  certificationStatus: string;
  certifyCommand?: string;
}): string {
  const provider = input.provider ?? 'unknown';
  const command = input.certifyCommand ?? 'unavailable';
  return `[agent-resolution] model=${input.modelId} phase=${input.phase} provider=${provider} reason=${input.reason} certification=${input.certificationStatus} certify="${command}"`;
}

function resolveRegistryBackedNativeAgent(input: {
  modelId: string;
  phase: AgentResolutionPhase;
  repoDir?: string;
  registry: ModelRegistry;
  now?: Date;
  certificationRoot?: string;
  nativeAgent: Extract<AgentType, 'native-openai' | 'native-openrouter'>;
}): AgentResolution {
  const capabilities = getModel(input.registry, input.modelId);
  const nativeCapability = capabilities?.nativeCapability;
  const provider = nativeCapability?.nativeProvider;
  const expectedProvider = input.nativeAgent === 'native-openai' ? 'openai' : 'openrouter';
  if (!nativeCapability || !provider) {
    const certifyCommand = certifyCommandFor(input.modelId, expectedProvider, input.phase);
    const diagnostic = buildDiagnostic({
      modelId: input.modelId,
      phase: input.phase,
      provider: expectedProvider,
      reason: 'no-native-capability',
      certificationStatus: 'missing-native-capability',
      certifyCommand,
    });
    return { ok: false, reason: 'no-native-capability', diagnostic, certifyCommand };
  }

  if (provider !== expectedProvider) {
    const diagnostic = buildDiagnostic({
      modelId: input.modelId,
      phase: input.phase,
      provider,
      reason: 'no-native-capability',
      certificationStatus: `provider-mismatch:${provider}->${expectedProvider}`,
      certifyCommand: provider ? certifyCommandFor(input.modelId, provider, input.phase) : undefined,
    });
    return {
      ok: false,
      reason: 'no-native-capability',
      diagnostic,
      ...(provider ? { certifyCommand: certifyCommandFor(input.modelId, provider, input.phase) } : {}),
    };
  }

  if (nativeCapability.readOnlyNative === 'unsupported') {
    const diagnostic = buildDiagnostic({
      modelId: input.modelId,
      phase: input.phase,
      provider,
      reason: 'native-unsupported',
      certificationStatus: 'native-unsupported',
      certifyCommand: certifyCommandFor(input.modelId, provider, input.phase),
    });
    return {
      ok: false,
      reason: 'native-unsupported',
      diagnostic,
      certifyCommand: certifyCommandFor(input.modelId, provider, input.phase),
    };
  }

  const supportReason = explainModelSupportExclusion(
    input.modelId,
    SUPPORTED_STAGE_BY_AGENT_PHASE[input.phase],
    input.registry,
  );
  if (supportReason === 'blocked-lifecycle' || supportReason === 'tool-support-insufficient' || supportReason === 'context-window-insufficient') {
    const reason = supportReason === 'blocked-lifecycle' 
      ? 'lifecycle-blocked' 
      : supportReason === 'tool-support-insufficient' 
        ? 'tool-support-insufficient' 
        : 'context-window-insufficient';
    const certificationStatus = supportReason === 'blocked-lifecycle' 
      ? 'retired' 
      : supportReason === 'tool-support-insufficient' 
        ? 'tool-support:none' 
        : `context-window:${capabilities?.contextWindowTokens}<${getStageContextWindowFloor(SUPPORTED_STAGE_BY_AGENT_PHASE[input.phase])}`;
    const diagnostic = buildDiagnostic({
      modelId: input.modelId,
      phase: input.phase,
      provider,
      reason,
      certificationStatus,
    });
    return { ok: false, reason, diagnostic };
  }

  const roleEligibility = launchPriorityRoleEligibility(input.modelId, input.phase);
  if (!roleEligibility.eligible) {
    const eligibleRoles = roleEligibility.eligibleRoles?.join(',') || 'none';
    const diagnostic = buildDiagnostic({
      modelId: input.modelId,
      phase: input.phase,
      provider,
      reason: 'role-ineligible',
      certificationStatus: `eligible-roles:${eligibleRoles}`,
    });
    return { ok: false, reason: 'role-ineligible', diagnostic };
  }

  const requiredPhase = certificationPhaseForAgentPhase(input.phase);

  if (input.repoDir) {
    const gate = evaluateNativeProviderGate({
      modelId: input.modelId,
      mode: 'task',
      requiredPhase,
      launchPhase: input.phase,
      registry: input.registry,
      repoDir: input.repoDir,
      apiKeyPresent: true,
      apiKeyEnv: 'AGENT_RESOLUTION_UNUSED',
      now: input.now,
      certificationRoot: input.certificationRoot,
    });
    if (!gate.ok) {
      const certifyCommand = certifyCommandFor(input.modelId, provider, input.phase);
      const diagnostic = buildDiagnostic({
        modelId: input.modelId,
        phase: input.phase,
        provider,
        reason: gate.reason === 'unregistered_model' ? 'no-native-capability' : 'uncertified',
        certificationStatus: gate.reason,
        certifyCommand,
      });
      return {
        ok: false,
        reason: gate.reason === 'unregistered_model' ? 'no-native-capability' : 'uncertified',
        diagnostic,
        certifyCommand,
      };
    }
    return { ok: true, agent: input.nativeAgent };
  }

  const eligibility = evaluateRegistryPhaseEligibility({
    modelId: input.modelId,
    phase: requiredPhase,
    registry: input.registry,
    now: input.now,
  });

  if (!eligibility.eligible) {
    const certifyCommand = certifyCommandFor(input.modelId, provider, input.phase);
    const diagnostic = buildDiagnostic({
      modelId: input.modelId,
      phase: input.phase,
      provider,
      reason: 'uncertified',
      certificationStatus: eligibility.reason,
      certifyCommand,
    });
    return { ok: false, reason: 'uncertified', diagnostic, certifyCommand };
  }

  return { ok: true, agent: input.nativeAgent };
}

export function resolveModelAgent(opts: ResolveModelAgentOptions): AgentResolution {
  const modelId = opts.model.trim();
  if (!modelId || !SAFE_MODEL_ID_PATTERN.test(modelId)) {
    return {
      ok: false,
      reason: 'invalid-model-id',
      diagnostic: buildDiagnostic({
        modelId: modelId || '(empty)',
        phase: opts.phase,
        reason: 'invalid-model-id',
        certificationStatus: 'invalid-model-id',
      }),
    };
  }

  const registry = opts.registry ?? DEFAULT_MODEL_REGISTRY;
  const capabilities = getModel(registry, modelId);
  // Keep hosted-provider boundaries authoritative even if a future registry
  // entry accidentally declares a first-party model as a native/OpenRouter
  // agent. Claude Code and ChatGPT-authenticated Codex use distinct account
  // surfaces from their API counterparts, so silently falling through to an
  // API-backed runtime would spend the wrong quota and bypass that surface.
  if (capabilities?.vendor === 'anthropic') {
    return { ok: true, agent: 'claude' };
  }
  const resolvedAgent = capabilities?.vendor === 'openai'
    ? 'codex'
    : capabilities?.agent
    ?? (capabilities?.nativeCapability?.nativeProvider
      ? (capabilities.nativeCapability.nativeProvider === 'openai' ? 'native-openai' : 'native-openrouter')
      : undefined)
    ?? inferHostedAgent(capabilities?.vendor);
  if (!resolvedAgent) {
    return {
      ok: false,
      reason: 'unknown-model',
      diagnostic: buildDiagnostic({
        modelId,
        phase: opts.phase,
        reason: 'unknown-model',
        certificationStatus: 'unknown-model',
      }),
    };
  }

  if (resolvedAgent === 'codex' || resolvedAgent === 'claude') {
    if (capabilities?.supportedModel?.launchEligible === false) {
      const lifecycle = capabilities.supportedModel.lifecycle || 'unknown';
      return {
        ok: false,
        reason: 'lifecycle-blocked',
        diagnostic: `[agent-resolution] model=${modelId} phase=${opts.phase} provider=${capabilities?.vendor} reason=lifecycle-blocked certification=${lifecycle} detail="Model is not eligible for launch"`,
      };
    }
    if (resolvedAgent === 'codex' && !isCodexChatgptLaunchEligible(capabilities)) {
      const reason = capabilities?.codexChatgptCapability?.reason
        ?? 'No explicit ChatGPT/Codex launch capability is declared.';
      return {
        ok: false,
        reason: 'codex-chatgpt-ineligible',
        diagnostic: `[agent-resolution] model=${modelId} phase=${opts.phase} surface=codex-chatgpt reason=codex-chatgpt-ineligible source=globalModelRegistry.models.${modelId}.codexChatgptCapability detail="${reason}"`,
      };
    }
    return { ok: true, agent: resolvedAgent };
  }

  if (resolvedAgent === 'native-openai' || resolvedAgent === 'native-openrouter') {
    return resolveRegistryBackedNativeAgent({
      modelId,
      phase: opts.phase,
      repoDir: opts.repoDir,
      registry,
      now: opts.now,
      certificationRoot: opts.certificationRoot,
      nativeAgent: resolvedAgent,
    });
  }

  if (resolvedAgent === 'claude-openrouter') {
    return resolveRegistryBackedNativeAgent({
      modelId,
      phase: opts.phase,
      repoDir: opts.repoDir,
      registry,
      now: opts.now,
      certificationRoot: opts.certificationRoot,
      nativeAgent: 'native-openrouter',
    });
  }

  return {
    ok: false,
    reason: 'unknown-model',
    diagnostic: buildDiagnostic({
      modelId,
      phase: opts.phase,
      reason: 'unknown-model',
      certificationStatus: 'unsupported-agent',
    }),
  };
}

/**
 * Resolves a model through successor chain before agent selection.
 * If the requested model is retired/blocked/unsupported without a valid successor,
 * returns a terminal failure. Preserves both requested and resolved identities.
 * Used at every execution boundary before pane/process creation.
 */
export function resolveLaunchPreflight(opts: {
  requestedModel: string;
  phase: AgentResolutionPhase;
  repoDir?: string;
  registry?: ModelRegistry;
  now?: Date;
  certificationRoot?: string;
}): LaunchPreflight {
  const requestedModel = opts.requestedModel.trim();
  const registry = opts.registry ?? DEFAULT_MODEL_REGISTRY;

  // First, check if the requested model resolves
  const requested = resolveModelAgent({
    model: requestedModel,
    phase: opts.phase,
    repoDir: opts.repoDir,
    registry,
    now: opts.now,
    certificationRoot: opts.certificationRoot,
  });

  if (requested.ok) {
    // Requested model is valid, return it as both requested and resolved
    return {
      ok: true,
      requestedModel,
      resolvedModel: requestedModel,
      agent: requested.agent,
      phase: opts.phase,
    };
  }

  // Requested model failed. Try to resolve a successor for Codex models
  const capabilities = getModel(registry, requestedModel);
  if (!capabilities) {
    // Unknown model with no successor
    return {
      ok: false,
      requestedModel,
      resolvedModel: null,
      phase: opts.phase,
      reason: 'unknown-model',
      diagnostic: `[launch-preflight] requested_model=${requestedModel} phase=${opts.phase} reason=unknown-model detail="Model not found in registry"`,
    };
  }

  // Try registry-backed successor first (handles lifecycle: deprecated, unsupported, etc.)
  const registrySuccessor = capabilities.agent === 'codex'
    ? resolveCodexChatgptSuccessor(requestedModel, registry)
    : resolveModelSuccessor(requestedModel, registry);

  if (!registrySuccessor) {
    // Requested model failed and has no valid successor
    const reason = capabilities.supportedModel?.lifecycle === 'deprecated'
      ? 'retired-model-no-successor'
      : requested.reason;

    return {
      ok: false,
      requestedModel,
      resolvedModel: null,
      phase: opts.phase,
      reason,
      diagnostic: `[launch-preflight] requested_model=${requestedModel} phase=${opts.phase} reason=${reason} detail="${requested.reason}:${requested.diagnostic}"`,
      remediation: capabilities.supportedModel?.lifecycle === 'deprecated'
        ? `Model ${requestedModel} is retired and has no available successor. Select a different model.`
        : undefined,
    };
  }

  // Try to resolve the successor
  const successorResolution = resolveModelAgent({
    model: registrySuccessor,
    phase: opts.phase,
    repoDir: opts.repoDir,
    registry,
    now: opts.now,
    certificationRoot: opts.certificationRoot,
  });

  if (successorResolution.ok) {
    // Successor is valid
    return {
      ok: true,
      requestedModel,
      resolvedModel: registrySuccessor,
      agent: successorResolution.agent,
      phase: opts.phase,
    };
  }

  // Successor exists but is ineligible (e.g., phase-incompatible, uncertified)
  return {
    ok: false,
    requestedModel,
    resolvedModel: registrySuccessor,
    phase: opts.phase,
    reason: 'successor-ineligible',
    diagnostic: `[launch-preflight] requested_model=${requestedModel} resolved_model=${registrySuccessor} phase=${opts.phase} reason=successor-ineligible detail="${successorResolution.reason}:${successorResolution.diagnostic}"`,
    remediation: `Successor model ${registrySuccessor} for ${requestedModel} is not eligible for this phase.`,
    certifyCommand: successorResolution.certifyCommand,
  };
}
