import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { filterDisabledModels, isDisabledModel } from './disabled-models.ts';
import {
  getEffectiveRegistry,
  getModel,
  type ModelRegistry,
} from './model-registry.ts';
import {
  resolveModelAgent,
  resolveStageExecutor,
  type AgentResolutionPhase,
  type StageExecutorResolution,
} from './model-agent-resolution.ts';
import { mutateJsonState } from './state-mutex.ts';
import { evaluateNativeProviderGate } from './native-agent/certification/eligibility-gate.ts';
import type { CertificationPhase } from './native-agent/certification/schema.ts';
import { resolveNativeAgentProviders } from './native-agent/providers.ts';
import { appendRouteOverrideToFeatureDir } from './route-artifact.ts';
import type { RouteOverrideInput, RouteStageRole } from './route-override-record.ts';

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

/**
 * The challenge intent carries models only (HOK-3511). A review-stage
 * challenger's sealed reviewer model still wins over the (possibly inherited)
 * phase-config block, but the executor is derived from the model at
 * validation time, never copied from the intent.
 */
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
      const reviewer = side?.reviewer as Record<string, unknown> | undefined;
      const model = clean(reviewer?.model)
        || (clean(parsed.challengeStage) === 'review' ? clean(side?.expectedStageModel) : '');
      if (!model) continue;
      return {
        model,
        provider: '',
        agent: '',
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

  // HOK-3511: the persisted contract names the model; agent and provider are
  // derived from it at read-validation time. A stored agent/provider pair is
  // carried through for audit output only — it is never trusted for a launch.
  if (!model || !selectedAt) {
    return {
      ok: false,
      reason: 'contract_missing',
      detail: `${input.stageRole} contract must include model and selectedAt`,
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

const ROUTE_ROLE_BY_STAGE: Record<StageRole, RouteStageRole> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

export interface StageContractSpec {
  stageRole: StageRole;
  model: string;
  challengeSide?: ChallengeSide;
  /** Extra stage-block fields written alongside the contract (depth, mode, launchSubstitution). */
  extra?: Record<string, unknown>;
  /** `'keep'` preserves the block's existing selectedAt; a string pins it; default is now. */
  selectedAt?: 'keep' | string;
  /** Drop the block's existing fields instead of merging over them. */
  reset?: boolean;
}

export interface StageWriteOutcome {
  model: string;
  agent?: string;
  provider?: string;
  selectedAt: string;
  refusal?: { reason: string; diagnostic: string };
}

/**
 * The one writer of `.phase-config.json` stage blocks (HOK-3511). It takes
 * models, and derives agent and provider itself through
 * {@link resolveStageExecutor} with the repo's effective registry — a caller
 * can no longer persist an executor carried over from another source. A model
 * that does not resolve keeps its block (model, metadata) and loses any stale
 * agent/provider; the refusal is returned for logging, recovery re-derives,
 * and the launch gate owns the outcome (HOK-3512).
 *
 * With `routeOverride`, each stage whose decided model this write replaces is
 * appended to the route record first (HOK-3363), before the stage block (and
 * any top-level route fields the caller rewrites afterwards) move.
 */
export async function writePersistedContract(input: {
  featureDir: string;
  repoDir?: string;
  registry?: ModelRegistry;
  stages: readonly StageContractSpec[];
  /** Start from a fresh file: all three stage blocks plus resolvedAt/forceModel. */
  replace?: boolean;
  forceModel?: string | null;
  routeOverride?: RouteOverrideInput;
}): Promise<{ stages: Partial<Record<StageRole, StageWriteOutcome>> }> {
  const registry = input.registry ?? getEffectiveRegistry(input.repoDir);
  const now = new Date().toISOString();
  await mkdir(input.featureDir, { recursive: true });
  const configFile = phaseConfigPath(input.featureDir);

  const resolutions = new Map<StageRole, StageExecutorResolution>();
  for (const stage of input.stages) {
    resolutions.set(stage.stageRole, resolveStageExecutor({
      model: stage.model,
      stage: stage.stageRole,
      repoDir: input.repoDir,
      registry,
    }));
  }

  if (input.routeOverride) {
    for (const stage of input.stages) {
      await appendRouteOverrideToFeatureDir(
        input.featureDir,
        ROUTE_ROLE_BY_STAGE[stage.stageRole],
        stage.model,
        input.routeOverride,
      );
    }
  }

  const outcomes: Partial<Record<StageRole, StageWriteOutcome>> = {};
  await mutateJsonState<PhaseConfig>(
    configFile,
    (current) => {
      const base: PhaseConfig = input.replace
        ? { resolvedAt: now, forceModel: input.forceModel ?? null }
        : {
          ...current,
          resolvedAt: typeof current.resolvedAt === 'string' ? current.resolvedAt : now,
          ...(input.forceModel !== undefined
            ? { forceModel: input.forceModel }
            : { forceModel: current.forceModel ?? null }),
        };
      for (const stage of input.stages) {
        const resolution = resolutions.get(stage.stageRole)!;
        const existing = (input.replace || stage.reset)
          ? {}
          : ((current[stage.stageRole] as Record<string, unknown> | undefined) ?? {});
        const existingBlock = (current[stage.stageRole] as PhaseStageConfig | undefined) ?? {};
        const selectedAt = stage.selectedAt === 'keep'
          ? (clean(existingBlock.selectedAt) || clean(current.resolvedAt) || now)
          : (stage.selectedAt ?? now);
        const block: Record<string, unknown> = {
          ...existing,
          ...(stage.extra ?? {}),
          model: stage.model,
          stageRole: stage.stageRole,
          challengeSide: stage.challengeSide
            ?? (normalizeChallengeSide(existingBlock.challengeSide) ?? null),
          selectedAt,
        };
        if (resolution.ok) {
          block.agent = resolution.agent;
          block.provider = resolution.provider;
        } else {
          delete block.agent;
          delete block.provider;
        }
        base[stage.stageRole] = block;
        outcomes[stage.stageRole] = {
          model: stage.model,
          selectedAt,
          ...(resolution.ok
            ? { agent: resolution.agent, provider: resolution.provider }
            : { refusal: { reason: resolution.reason, diagnostic: resolution.diagnostic } }),
        };
      }
      return base;
    },
    { createIfMissing: true, initial: {} },
  );

  const side = input.stages.find((stage) => stage.challengeSide)?.challengeSide;
  if (side) {
    await writeFile(
      challengeSidePath(input.featureDir),
      `${JSON.stringify({ side, selectedAt: now }, null, 2)}\n`,
      'utf-8',
    );
  }

  return { stages: outcomes };
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

function validateNativeProvider(contract: ExecutionContract, repoDir: string | undefined, registry: ModelRegistry): ContractValidateResult {
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

/**
 * HOK-3511: validation asks only whether the model can launch for the stage.
 * The contract's agent/provider are expected to be the derived executor (see
 * {@link readValidatedContract}); a persisted agent is never compared against
 * the resolver, so the `agent_unsupported_for_model` mismatch class is
 * unrepresentable for a contract whose model is launchable.
 */
export function validateContractLaunchable(input: {
  contract: ExecutionContract;
  repoDir?: string;
  registry?: ModelRegistry;
}): ContractValidateResult {
  const registry = input.registry ?? getEffectiveRegistry(input.repoDir);
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

/**
 * Canonical read/validate seam used by every recovery caller and future ledger
 * scheduling. HOK-3511: the returned contract carries the agent and provider
 * *derived* from the persisted model through {@link resolveStageExecutor} with
 * the repo's effective registry — the same resolution the launcher uses — so a
 * stale persisted executor (or a legacy block without one) can never refuse a
 * relaunch whose model is launchable. This is not a reroute: the model is
 * unchanged and nothing is written.
 */
export function readValidatedContract(input: {
  featureDir: string;
  stageRole: StageRole;
  challengeSide?: ChallengeSide;
  repoDir?: string;
  registry?: ModelRegistry;
}): { ok: true; contract: ExecutionContract } | { ok: false; reason: RecoveryUnavailableReason; detail: string; contract?: ExecutionContract } {
  const read = readPersistedContract(input);
  if (!read.ok) return read;
  if (read.contract.stageRole !== input.stageRole) {
    return { ok: false, reason: 'contract_malformed', detail: `Persisted ${input.stageRole} contract names stage ${read.contract.stageRole}`, contract: read.contract };
  }
  const registry = input.registry ?? getEffectiveRegistry(input.repoDir);
  const executor = resolveStageExecutor({
    model: read.contract.model,
    stage: input.stageRole,
    repoDir: input.repoDir,
    registry,
  });
  const contract = executor.ok
    ? { ...read.contract, agent: executor.agent, provider: executor.provider }
    : read.contract;
  const validation = validateContractLaunchable({ contract, repoDir: input.repoDir, registry });
  return validation.ok ? { ok: true, contract } : { ...validation, contract };
}
