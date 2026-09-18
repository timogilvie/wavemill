import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { filterDisabledModels, isDisabledModel } from './disabled-models.ts';
import {
  DEFAULT_MODEL_REGISTRY,
  getModel,
  type AgentType,
  type ModelRegistry,
} from './model-registry.ts';
import { resolveModelAgent, type AgentResolutionPhase } from './model-agent-resolution.ts';
import { mutateJsonState } from './state-mutex.ts';
import { evaluateNativeProviderGate } from './native-agent/certification/eligibility-gate.ts';
import type { CertificationPhase } from './native-agent/certification/schema.ts';
import { resolveNativeAgentProviders } from './native-agent/providers.ts';

export type StageRole = 'planning' | 'coding' | 'review';
export type ChallengeSide = 'primary' | 'challenger' | null;

export interface ExecutionContract {
  model: string;
  provider: string;
  agent: string;
  stageRole: StageRole;
  challengeSide: ChallengeSide;
  certificationRef?: string;
  selectedAt: string;
}

export type RecoveryUnavailableReason =
  | 'contract_missing'
  | 'contract_malformed'
  | 'model_disabled'
  | 'model_not_launchable'
  | 'provider_unavailable'
  | 'agent_unsupported_for_model'
  | 'certification_invalid_for_role';

export type ContractReadResult =
  | { ok: true; contract: ExecutionContract }
  | { ok: false; reason: 'contract_missing' | 'contract_malformed'; detail: string };

export type ContractValidateResult =
  | { ok: true }
  | { ok: false; reason: RecoveryUnavailableReason; detail: string };

interface PhaseConfig {
  resolvedAt?: unknown;
  [stage: string]: unknown;
}

interface PhaseStageConfig {
  model?: unknown;
  provider?: unknown;
  agent?: unknown;
  stageRole?: unknown;
  challengeSide?: unknown;
  certificationRef?: unknown;
  selectedAt?: unknown;
}

const VALID_STAGES = new Set<StageRole>(['planning', 'coding', 'review']);
const VALID_SIDES = new Set(['primary', 'challenger']);
const NATIVE_PROVIDER_BY_AGENT: Record<string, 'openai' | 'openrouter' | undefined> = {
  'native-openai': 'openai',
  'native-openrouter': 'openrouter',
};

const CERT_PHASE_BY_STAGE: Record<StageRole, CertificationPhase> = {
  planning: 'workflow',
  coding: 'patch',
  review: 'read-only',
};

function isStageRole(value: string): value is StageRole {
  return VALID_STAGES.has(value as StageRole);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChallengeSide(value: unknown): ChallengeSide | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && VALID_SIDES.has(value)) return value as 'primary' | 'challenger';
  return undefined;
}

function phaseConfigPath(featureDir: string): string {
  return path.join(featureDir, '.phase-config.json');
}

function challengeSidePath(featureDir: string): string {
  return path.join(featureDir, '.challenge-side.json');
}

function challengeIntentCandidates(featureDir: string): string[] {
  return [
    path.join(featureDir, 'challenge-intent.json'),
    path.join(featureDir, '.challenge-intent.json'),
  ];
}

function unavailableDetail(model: string, reason: string): string {
  return `Recovery contract for model ${model || '(unknown)'} is unavailable: ${reason}. Run wavemill reroute <task-id> --phase <planning|coding|review> to choose an audited replacement.`;
}

function parseJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function challengeIntentReviewContract(input: {
  featureDir: string;
  stageRole: StageRole;
  challengeSide?: ChallengeSide;
  fallbackSelectedAt?: string;
}): ExecutionContract | null {
  if (input.stageRole !== 'review' || !input.challengeSide) return null;
  for (const candidate of challengeIntentCandidates(input.featureDir)) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = parseJsonFile(candidate) as Record<string, unknown>;
      const side = parsed[input.challengeSide] as Record<string, unknown> | undefined;
      const model = clean(side?.expectedStageModel)
        || clean((side?.reviewer as Record<string, unknown> | undefined)?.model);
      if (!model) continue;
      const resolved = resolveModelAgent({ model, phase: 'review' });
      const agent = clean(side?.expectedStageAgent)
        || clean((side?.reviewer as Record<string, unknown> | undefined)?.agent)
        || (resolved.ok ? resolved.agent : '');
      if (!agent) continue;
      return {
        model,
        provider: providerForModel(model),
        agent,
        stageRole: 'review',
        challengeSide: input.challengeSide,
        selectedAt: clean(parsed.createdAt) || input.fallbackSelectedAt || new Date(0).toISOString(),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function providerForModel(modelId: string, registry: ModelRegistry = DEFAULT_MODEL_REGISTRY): string {
  const capabilities = getModel(registry, modelId);
  const nativeProvider = capabilities?.nativeCapability?.nativeProvider;
  if (nativeProvider) return `native-${nativeProvider}`;
  if (capabilities?.agent === 'claude') return 'anthropic';
  if (capabilities?.agent === 'codex') return 'openai';
  if (capabilities?.vendor === 'anthropic' || capabilities?.vendor === 'deepseek') return 'anthropic';
  if (capabilities?.vendor === 'openai') return 'openai';
  return capabilities?.agent ?? capabilities?.vendor ?? '';
}

export function serializeContract(contract: ExecutionContract): string {
  return JSON.stringify({
    model: contract.model,
    provider: contract.provider,
    agent: contract.agent,
    stageRole: contract.stageRole,
    challengeSide: contract.challengeSide,
    ...(contract.certificationRef ? { certificationRef: contract.certificationRef } : {}),
    selectedAt: contract.selectedAt,
  });
}

export function readPersistedContract(input: {
  featureDir: string;
  stageRole: StageRole;
  challengeSide?: ChallengeSide;
}): ContractReadResult {
  const configFile = phaseConfigPath(input.featureDir);
  if (!existsSync(configFile)) {
    return { ok: false, reason: 'contract_missing', detail: `.phase-config.json is missing in ${input.featureDir}` };
  }

  let parsed: PhaseConfig;
  try {
    parsed = parseJsonFile(configFile) as PhaseConfig;
  } catch (error) {
    return { ok: false, reason: 'contract_malformed', detail: `Failed to parse ${configFile}: ${String(error)}` };
  }

  const stageData = parsed[input.stageRole] as PhaseStageConfig | undefined;
  if (!stageData || typeof stageData !== 'object') {
    return { ok: false, reason: 'contract_missing', detail: `No ${input.stageRole} contract in ${configFile}` };
  }

  let siblingSide: ChallengeSide | undefined;
  const sideFile = challengeSidePath(input.featureDir);
  if (existsSync(sideFile)) {
    try {
      const sideData = parseJsonFile(sideFile) as { side?: unknown; challengeSide?: unknown };
      siblingSide = normalizeChallengeSide(sideData.side ?? sideData.challengeSide);
      if (siblingSide === undefined) {
        return { ok: false, reason: 'contract_malformed', detail: `${sideFile} has an invalid challenge side` };
      }
    } catch (error) {
      return { ok: false, reason: 'contract_malformed', detail: `Failed to parse ${sideFile}: ${String(error)}` };
    }
  }

  const model = clean(stageData.model);
  const provider = clean(stageData.provider);
  const agent = clean(stageData.agent);
  const selectedAt = clean(stageData.selectedAt) || clean(parsed.resolvedAt);
  const stageRole = clean(stageData.stageRole) || input.stageRole;
  const challengeSide = input.challengeSide ?? siblingSide ?? normalizeChallengeSide(stageData.challengeSide);
  const certificationRef = clean(stageData.certificationRef) || undefined;

  const challengeContract = challengeIntentReviewContract({
    featureDir: input.featureDir,
    stageRole: input.stageRole,
    challengeSide,
    fallbackSelectedAt: selectedAt,
  });
  if (challengeContract) {
    return { ok: true, contract: challengeContract };
  }

  if (!model || !provider || !agent || !selectedAt) {
    return {
      ok: false,
      reason: 'contract_missing',
      detail: `${input.stageRole} contract must include model, provider, agent, and selectedAt`,
    };
  }
  if (!isStageRole(stageRole)) {
    return { ok: false, reason: 'contract_malformed', detail: `${input.stageRole} contract has invalid stageRole ${stageRole}` };
  }
  if (challengeSide === undefined) {
    return { ok: false, reason: 'contract_malformed', detail: `${input.stageRole} contract has invalid challengeSide` };
  }

  return {
    ok: true,
    contract: {
      model,
      provider,
      agent,
      stageRole,
      challengeSide,
      ...(certificationRef ? { certificationRef } : {}),
      selectedAt,
    },
  };
}

export async function writePersistedContract(input: {
  featureDir: string;
  contract: ExecutionContract;
}): Promise<void> {
  await mkdir(input.featureDir, { recursive: true });
  const configFile = phaseConfigPath(input.featureDir);
  await mutateJsonState<PhaseConfig>(
    configFile,
    (current) => ({
      ...current,
      [input.contract.stageRole]: {
        ...((current[input.contract.stageRole] as Record<string, unknown> | undefined) ?? {}),
        model: input.contract.model,
        provider: input.contract.provider,
        agent: input.contract.agent,
        stageRole: input.contract.stageRole,
        challengeSide: input.contract.challengeSide,
        ...(input.contract.certificationRef ? { certificationRef: input.contract.certificationRef } : {}),
        selectedAt: input.contract.selectedAt,
      },
      resolvedAt: typeof current.resolvedAt === 'string' ? current.resolvedAt : input.contract.selectedAt,
    }),
    { createIfMissing: true, initial: {} },
  );

  if (input.contract.challengeSide) {
    await writeFile(
      challengeSidePath(input.featureDir),
      `${JSON.stringify({ side: input.contract.challengeSide, selectedAt: input.contract.selectedAt }, null, 2)}\n`,
      'utf-8',
    );
  }
}

function isLaunchableByRegistry(model: string, stageRole: StageRole, registry: ModelRegistry, repoDir?: string): ContractValidateResult {
  const resolution = resolveModelAgent({ model, phase: stageRole as AgentResolutionPhase, registry, repoDir });
  if (!resolution.ok) {
    return {
      ok: false,
      reason: 'model_not_launchable',
      detail: unavailableDetail(model, resolution.diagnostic),
    };
  }
  return { ok: true };
}

function validateNativeProvider(contract: ExecutionContract, repoDir?: string, registry: ModelRegistry = DEFAULT_MODEL_REGISTRY): ContractValidateResult {
  const nativeProvider = NATIVE_PROVIDER_BY_AGENT[contract.agent];
  if (!nativeProvider) return { ok: true };

  const modelProvider = getModel(registry, contract.model)?.nativeCapability?.nativeProvider;
  if (modelProvider !== nativeProvider || contract.provider !== `native-${nativeProvider}`) {
    return {
      ok: false,
      reason: 'provider_unavailable',
      detail: unavailableDetail(contract.model, `expected native provider ${nativeProvider}, persisted provider is ${contract.provider}`),
    };
  }

  const entries = resolveNativeAgentProviders(repoDir, {
    phase: contract.stageRole,
    mode: 'certification',
    registry,
  });
  const entry = entries.find((item) => item.providerName === nativeProvider && item.modelId === contract.model);
  if (!entry || entry.status !== 'ready') {
    return {
      ok: false,
      reason: 'provider_unavailable',
      detail: unavailableDetail(contract.model, entry?.reason ?? `native provider ${nativeProvider} is not configured for this model`),
    };
  }

  const gate = evaluateNativeProviderGate({
    modelId: contract.model,
    mode: 'task',
    requiredPhase: CERT_PHASE_BY_STAGE[contract.stageRole],
    ...(contract.stageRole === 'coding' ? { launchPhase: 'coding' as const } : {}),
    registry,
    repoDir,
    apiKeyPresent: true,
    apiKeyEnv: entry.apiKeyEnv,
  });
  if (!gate.ok) {
    return {
      ok: false,
      reason: 'certification_invalid_for_role',
      detail: unavailableDetail(contract.model, gate.message),
    };
  }
  return { ok: true };
}

export function validateContractLaunchable(input: {
  contract: ExecutionContract;
  repoDir?: string;
  registry?: ModelRegistry;
}): ContractValidateResult {
  const registry = input.registry ?? DEFAULT_MODEL_REGISTRY;
  const { contract } = input;
  if (isDisabledModel(contract.model) || !filterDisabledModels([contract.model]).includes(contract.model)) {
    return {
      ok: false,
      reason: 'model_disabled',
      detail: unavailableDetail(contract.model, 'the model is disabled'),
    };
  }

  const registryLaunchable = isLaunchableByRegistry(contract.model, contract.stageRole, registry, input.repoDir);
  if (!registryLaunchable.ok) return registryLaunchable;

  const resolved = resolveModelAgent({
    model: contract.model,
    phase: contract.stageRole,
    registry,
    repoDir: input.repoDir,
  });
  if (!resolved.ok || resolved.agent !== (contract.agent as AgentType)) {
    return {
      ok: false,
      reason: 'agent_unsupported_for_model',
      detail: unavailableDetail(
        contract.model,
        resolved.ok ? `current resolver supports agent ${resolved.agent}, not persisted agent ${contract.agent}` : resolved.diagnostic,
      ),
    };
  }

  return validateNativeProvider(contract, input.repoDir, registry);
}

export async function appendRerouteAudit(input: {
  featureDir: string;
  before: ExecutionContract | null;
  after: ExecutionContract;
  operator?: string;
  noop?: boolean;
}): Promise<void> {
  await mkdir(input.featureDir, { recursive: true });
  await appendFile(
    path.join(input.featureDir, '.reroute-audit.jsonl'),
    `${JSON.stringify({
      before: input.before,
      after: input.after,
      operator: input.operator ?? process.env.USER ?? 'unknown',
      at: new Date().toISOString(),
      ...(input.noop ? { noop: true } : {}),
    })}\n`,
    'utf-8',
  );
}

export async function writeChallengeEvidenceInvalid(featureDir: string, reason = 'operator_reroute'): Promise<void> {
  await writeFile(
    path.join(featureDir, '.challenge-evidence-invalid.json'),
    `${JSON.stringify({ reason, invalidatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf-8',
  );
}

export async function readChallengeEvidenceInvalid(featureDir: string): Promise<{ reason: string; detail?: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(featureDir, '.challenge-evidence-invalid.json'), 'utf-8')) as {
      reason?: unknown;
      detail?: unknown;
    };
    const reason = clean(parsed.reason);
    return reason ? { reason, ...(clean(parsed.detail) ? { detail: clean(parsed.detail) } : {}) } : null;
  } catch {
    return null;
  }
}
