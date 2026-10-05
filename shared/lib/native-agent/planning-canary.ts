import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { explainEffectiveModelAvailability } from '../effective-models.ts';
import { getEffectiveRegistry } from '../model-registry.ts';
import { resolveModelAgent } from '../model-agent-resolution.ts';
import { diagnoseOpenRouter } from '../openrouter-doctor.ts';
import {
  equivalentOpenRouterModelIds,
  resolveOpenRouterModelIdentity,
} from '../openrouter-catalog.ts';
import { closeManifest, openManifest, resolveManifestPath } from '../resource-manifest.ts';
import { filterNativeModels } from './certification/router-filter.ts';
import { launchNativePlanning, type LaunchNativePlanningOptions } from './launch-planning.ts';
import {
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';

export interface PlanningCanaryPreflightInput {
  repoDir: string;
  agent: 'native-openrouter';
  phase: 'planning';
  model: string;
}

export type PlanningCanaryPreflightResult =
  | { ok: true; launcher?: string; command?: { wavemillAlias?: string; openrouterId?: string } }
  | { ok: false; code?: string; reason: string };

export interface PlanningGateRow {
  surface: 'preflight' | 'router' | 'projection' | 'challenge';
  eligible: boolean;
  reason?: string;
  detail?: string;
}

export interface PlanningGateAgreement {
  modelId: string;
  alias: string;
  openrouterId: string;
  agree: boolean;
  eligible: boolean;
  rows: PlanningGateRow[];
}

export interface BuildPlanningGateAgreementOptions {
  modelId: string;
  repoDir?: string;
  apiKeyEnv?: string;
  apiKeyPresent?: boolean;
  now?: Date;
  preflight: (input: PlanningCanaryPreflightInput) => PlanningCanaryPreflightResult;
}

export interface NativePlanningCanaryEvidence {
  schemaVersion: '1';
  generatedAt: string;
  issue: string;
  model: {
    alias: string;
    openrouterId: string;
  };
  gates: PlanningGateAgreement;
  status: 'gates-eligible' | 'gates-rejected' | 'launch-succeeded' | 'launch-failed';
  launch?: {
    session: string;
    stopReason?: string;
    planPath?: string;
    planBytes?: number;
    planHead?: string[];
    planningResultPath?: string;
    planningResult?: {
      status?: string;
      model?: string;
      artifacts?: unknown;
    };
    hookPath?: string;
    hook?: {
      state?: string;
      event?: string;
      detail?: string;
    };
    transcriptPath?: string;
    transcriptBytes?: number;
    manifestPath?: string;
    manifestBytes?: number;
    error?: string;
  };
  summary: string;
}

export interface RunNativePlanningCanaryOptions extends Omit<BuildPlanningGateAgreementOptions, 'preflight'> {
  issue?: string;
  out?: string;
  dryRun?: boolean;
  preflight: (input: PlanningCanaryPreflightInput) => PlanningCanaryPreflightResult;
  launcher?: typeof launchNativePlanning;
}

const TASK_PACKET = [
  '# Task Packet',
  '',
  '## Objective',
  'Plan a small safe change for a native OpenRouter planning canary.',
  '',
  '## Context',
  'Verification-only planning exercise. Do not edit source files during planning.',
  '',
  '## Requirements',
  '- Inspect the repository only if useful.',
  '- Return an implementation plan with verification steps.',
  '- Start the final answer with a level-one markdown title, for example "# Native Planning Canary Plan".',
  '- Include a ## Release Readiness section.',
  '- In Release Readiness, include bullets exactly named **database_change_risk**:, **env_changes**:, **config_changes**:, and **manual_steps**:.',
  '',
  '## Required Final Shape',
  '# Native Planning Canary Plan',
  '',
  '## Implementation Plan',
  '- Describe the safe read-only planning steps.',
  '',
  '## Verification',
  '- Describe the checks to run.',
  '',
  '## Release Readiness',
  '- **database_change_risk**: none',
  '- **env_changes**: none',
  '- **config_changes**: none',
  '- **manual_steps**: none',
].join('\n');

const CANARY_MAX_OUTPUT_TOKENS = 4096;

function segment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'native-planning';
}

function reasonFromPreflight(result: PlanningCanaryPreflightResult): string | undefined {
  if (result.ok) return undefined;
  return result.code ?? result.reason;
}

function pickDoctorReason(modelId: string, repoDir: string): string | undefined {
  const report = diagnoseOpenRouter({ repoDir, stage: 'planner' });
  const equivalentIds = new Set([modelId, ...equivalentOpenRouterModelIds(modelId)]);
  const model = report.models.find((entry) =>
    equivalentIds.has(entry.id)
    || (entry.alias ? equivalentIds.has(entry.alias) : false)
    || (entry.nativeProviderId ? equivalentIds.has(entry.nativeProviderId) : false)
    || (entry.registryModelId ? equivalentIds.has(entry.registryModelId) : false));
  const cell = model?.cells.find((candidate) => candidate.stage === 'planner');
  return cell?.eligible ? undefined : cell?.primaryReason?.reason;
}

function assertIdentity(modelId: string): { alias: string; openrouterId: string } {
  const identity = resolveOpenRouterModelIdentity(modelId);
  if (!identity) {
    throw new Error(`Unknown native OpenRouter launch-priority model: ${modelId}`);
  }
  return {
    alias: identity.wavemillAlias,
    openrouterId: identity.openrouterId,
  };
}

export function buildPlanningGateAgreement(options: BuildPlanningGateAgreementOptions): PlanningGateAgreement {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const identity = assertIdentity(options.modelId);
  const registry = getEffectiveRegistry(repoDir);
  const apiKeyEnv = options.apiKeyEnv ?? 'OPENROUTER_API_KEY';
  const apiKeyPresent = options.apiKeyPresent ?? true;

  const preflight = options.preflight({
    repoDir,
    agent: 'native-openrouter',
    phase: 'planning',
    model: identity.alias,
  });
  const router = filterNativeModels([identity.alias], 'planner', registry, repoDir, {
    apiKeyPresent,
    apiKeyEnv,
    now: options.now,
  });
  const projection = explainEffectiveModelAvailability(identity.alias, 'planning', {
    repoDir,
    registry,
    requireRuntimeReady: true,
    apiKeyPresent,
    apiKeyEnv,
    now: options.now,
  });
  const agent = resolveModelAgent({
    model: identity.alias,
    phase: 'planning',
    repoDir,
    registry,
    now: options.now,
  });
  const doctorReason = pickDoctorReason(identity.alias, repoDir);
  const challengeEligible = agent.ok && doctorReason === undefined;

  const rows: PlanningGateRow[] = [
    {
      surface: 'preflight',
      eligible: preflight.ok,
      ...(reasonFromPreflight(preflight) ? { reason: reasonFromPreflight(preflight) } : {}),
      ...(preflight.ok ? { detail: preflight.launcher } : { detail: preflight.reason }),
    },
    {
      surface: 'router',
      eligible: router.eligible.includes(identity.alias),
      ...(router.rejected[0]?.reason ? { reason: router.rejected[0].reason } : {}),
    },
    {
      surface: 'projection',
      eligible: projection.available,
      ...(projection.available ? {} : { reason: projection.nativeGate?.reason ?? projection.reason }),
    },
    {
      surface: 'challenge',
      eligible: challengeEligible,
      ...(challengeEligible ? {} : { reason: doctorReason ?? (agent.ok ? 'unknown' : agent.reason) }),
    },
  ];
  const first = rows[0]?.eligible ?? false;
  return {
    modelId: options.modelId,
    alias: identity.alias,
    openrouterId: identity.openrouterId,
    agree: rows.every((row) => row.eligible === first),
    eligible: first && rows.every((row) => row.eligible),
    rows,
  };
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function collectLaunchEvidence(
  session: string,
  result: Awaited<ReturnType<typeof launchNativePlanning>>,
  repoDir: string,
): NonNullable<NativePlanningCanaryEvidence['launch']> {
  const planText = existsSync(result.planPath) ? readFileSync(result.planPath, 'utf8') : '';
  const planningResultPath = join(dirname(result.planPath), '.planning-result.json');
  const planningResult = readJsonObject(planningResultPath);
  const hook = readJsonObject(result.hookPath);
  const manifestPath = resolveManifestPath(session, repoDir);

  return {
    session,
    stopReason: result.stopReason,
    planPath: result.planPath,
    planBytes: planText.length,
    planHead: planText.split('\n').slice(0, 8),
    planningResultPath,
    planningResult: planningResult
      ? {
        status: typeof planningResult.status === 'string' ? planningResult.status : undefined,
        model: typeof planningResult.model === 'string' ? planningResult.model : undefined,
        artifacts: planningResult.artifacts,
      }
      : undefined,
    hookPath: result.hookPath,
    hook: hook
      ? {
        state: typeof hook.state === 'string' ? hook.state : undefined,
        event: typeof hook.event === 'string' ? hook.event : undefined,
        detail: typeof hook.detail === 'string' ? hook.detail : undefined,
      }
      : undefined,
    transcriptPath: result.transcriptPath,
    transcriptBytes: existsSync(result.transcriptPath) ? readFileSync(result.transcriptPath, 'utf8').length : 0,
    manifestPath,
    manifestBytes: existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8').length : 0,
  };
}

export async function runNativePlanningCanary(
  options: RunNativePlanningCanaryOptions,
): Promise<NativePlanningCanaryEvidence> {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const issue = options.issue ?? 'native-planning-canary';
  const generatedAt = (options.now ?? new Date()).toISOString();
  const identity = assertIdentity(options.modelId);
  const gates = buildPlanningGateAgreement({ ...options, repoDir, modelId: identity.alias });
  const out = options.out ?? join(repoDir, '.wavemill', 'audits', 'canaries', `${identity.alias}-native-planning.json`);

  let evidence: NativePlanningCanaryEvidence = {
    schemaVersion: '1',
    generatedAt,
    issue,
    model: identity,
    gates,
    status: gates.eligible && gates.agree ? 'gates-eligible' : 'gates-rejected',
    summary: gates.eligible && gates.agree ? 'gates eligible' : 'one or more gates rejected the model',
  };

  if (gates.agree && gates.eligible && !options.dryRun) {
    const slug = `${segment(identity.alias)}-native-planning-canary`;
    const session = `${segment(issue)}-${segment(identity.alias)}-${Date.now()}`;
    const wtDir = mkdtempSync(join(tmpdir(), `${slug}-`));
    const featureDir = join(wtDir, 'features', slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'task-packet.md'), `${TASK_PACKET}\n`, 'utf8');
    const providerEntries = resolveNativeAgentProviders(repoDir, { phase: 'planning' })
      .filter((entry): entry is ReadyNativeProviderEntry =>
        entry.status === 'ready' && equivalentOpenRouterModelIds(identity.alias).includes(entry.modelId))
      .map((entry): ReadyNativeProviderEntry => ({
        ...entry,
        model: {
          ...entry.model,
          maxTokens: CANARY_MAX_OUTPUT_TOKENS,
        },
      }));
    const runTsxCommand: NonNullable<LaunchNativePlanningOptions['runTsxCommand']> = (args) => {
      const outputIndex = args.indexOf('--output');
      if (outputIndex < 0) return '';
      const outputPath = args[outputIndex + 1];
      if (!outputPath) return '';
      if (basename(args[0]) === 'route-task.ts') {
        writeFileSync(outputPath, `${JSON.stringify({
          planner: identity.alias,
          coder: 'codex',
          reviewer: 'claude',
          planDepth: 'light',
          source: 'native-planning-canary',
        }, null, 2)}\n`, 'utf8');
      } else {
        writeFileSync(outputPath, `${TASK_PACKET}\n`, 'utf8');
      }
      return '';
    };

    openManifest(session, { workflowType: 'verification', repoDir });
    try {
      const result = await (options.launcher ?? launchNativePlanning)({
        session,
        issue,
        slug,
        wtDir,
        repoDir,
        title: 'Native OpenRouter planning canary',
        planDepth: 'light',
        operatingMode: 'normal',
        providerEntries,
        runTsxCommand,
        resolvedModel: identity.alias,
      });
      closeManifest(session, { status: 'completed', repoDir });
      const launch = collectLaunchEvidence(session, result, repoDir);
      const planningStatus = launch.planningResult?.status;
      evidence = {
        ...evidence,
        status: planningStatus === 'awaiting_user' && (launch.planBytes ?? 0) > 0 ? 'launch-succeeded' : 'launch-failed',
        launch,
        summary: planningStatus === 'awaiting_user' && (launch.planBytes ?? 0) > 0
          ? 'native planning reached awaiting_user with a non-empty plan'
          : 'native planning did not produce an awaiting_user plan',
      };
    } catch (error) {
      closeManifest(session, { status: 'failed', repoDir });
      evidence = {
        ...evidence,
        status: 'launch-failed',
        launch: { session, error: error instanceof Error ? error.message : String(error) },
        summary: 'native planning launch failed',
      };
    } finally {
      rmSync(wtDir, { recursive: true, force: true });
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}
