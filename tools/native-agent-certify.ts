#!/usr/bin/env -S npx tsx

/**
 * native-agent-certify — run the certification scenario harness for a
 * specific provider/model/phase combination.
 *
 * On success (non-dry-run, live-certifiable), persists a
 * NativeCertificationArtifact to disk.
 *
 * Exit codes:
 *   0 — harness passed (dry-run or live certification written)
 *   1 — harness failed or model unsupported
 *   2 — invalid input (unknown phase, provider, or missing required flags)
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  PHASE_ORDER,
  CERTIFICATION_SCHEMA_VERSION,
  evaluateLiveCodingCanaryEligibility,
  phaseSatisfies,
  type CertificationSubject,
  type CertificationPhase,
  type LiveCodingCanaryFailureReason,
  type LiveCodingCanaryLimitKind,
  type LiveCodingCanaryLimits,
  type LiveCodingCanaryResult,
  type LiveCodingCanaryStatus,
  type LiveSmokeEvidence,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/schema.ts';
import { runLiveCodingCanary } from '../shared/lib/native-agent/certification/live-coding-canary.ts';
import { loadGlobalCertification } from '../shared/lib/native-agent/certification/loader.ts';
import { isRevisionAwareArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import {
  getDefaultScenarios,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
} from '../shared/lib/native-agent/certification/scenarios.ts';
import {
  runScenarios,
  toArtifactScenario,
  type RunScenariosOptions,
} from '../shared/lib/native-agent/certification/scenario-runner.ts';
import { resolveCertificationSubject } from '../shared/lib/native-agent/certification/identity.ts';
import { writeGlobalCertification } from '../shared/lib/native-agent/certification/store.ts';
import {
  refreshCanaryCohort,
  renderCanaryCohortHealth,
} from '../shared/lib/native-agent/certification/canary-cohort.ts';
import { getEffectiveRegistry, type ModelRegistry, type NativeProviderName } from '../shared/lib/model-registry.ts';
import { resolveWavemillAliasFromOpenRouterId } from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterSmoke, type SmokeReport } from '../shared/lib/openrouter-smoke.ts';

const NATIVE_PROVIDERS: NativeProviderName[] = ['openai', 'openrouter'];

export interface CertifyOptions {
  provider: NativeProviderName;
  model: string;
  phase: CertificationPhase;
  repoDir: string;
  dryRun?: boolean;
  /**
   * Opt into the credentialed live coding canary. Never runs during dry-run.
   * Without it, patch/workflow certification still publishes deterministic
   * evidence, but coding eligibility stays false until a canary pass exists.
   */
  liveCodingCanary?: boolean;
  /** Budget overrides for the live coding canary run. */
  canaryLimits?: Partial<LiveCodingCanaryLimits>;
  registry?: ModelRegistry;
  runScenariosFn?: typeof runScenarios;
  runOpenRouterSmokeFn?: typeof runOpenRouterSmoke;
  /** Test seam for the live canary. Production certification uses the real runner. */
  runLiveCanaryFn?: typeof runLiveCodingCanary;
  /** Test seam for reading the previously published artifact (canary carry-forward). */
  loadPreviousArtifactFn?: (provider: string, model: string, suiteVersion: string) => NativeCertificationArtifact | undefined;
  writeCertificationFn?: typeof writeGlobalCertification | ((repoDir: string, record: NativeCertificationArtifact) => string);
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** Compact, redacted canary summary for command output — never raw prompt/output text. */
export interface CertifyLiveCanarySummary {
  status: LiveCodingCanaryStatus;
  isLive: boolean;
  ranAt: string;
  reason?: LiveCodingCanaryFailureReason;
  limitExceeded?: LiveCodingCanaryLimitKind;
  detail?: string;
  attempts?: number;
  /** True when this summary reflects preserved earlier evidence rather than this run. */
  carriedForward?: boolean;
}

export interface CertifyResult {
  provider: string;
  model: string;
  phase: CertificationPhase;
  suiteVersion: string;
  dryRun: boolean;
  harnessPassed: boolean;
  liveCertifiable: boolean;
  artifactPath?: string;
  artifactScope?: 'global';
  subject?: CertificationSubject;
  liveSmokeEvidence?: LiveSmokeEvidence;
  /** Canary state persisted with the artifact (or summary of why it is absent). */
  liveCanary?: CertifyLiveCanarySummary;
  /** True only when the published artifact grants coding eligibility right now. */
  codingEligible: boolean;
  scenarios: Array<{ scenarioId: string; status: string; detail?: string }>;
  knownLimitations: string[];
}

export interface CertifyAllOptions {
  provider?: NativeProviderName;
  phase: CertificationPhase;
  repoDir: string;
  dryRun?: boolean;
  liveCodingCanary?: boolean;
  canaryLimits?: Partial<LiveCodingCanaryLimits>;
  registry?: ModelRegistry;
  runScenariosFn?: typeof runScenarios;
  runOpenRouterSmokeFn?: typeof runOpenRouterSmoke;
  runLiveCanaryFn?: typeof runLiveCodingCanary;
  loadPreviousArtifactFn?: CertifyOptions['loadPreviousArtifactFn'];
  writeCertificationFn?: typeof writeGlobalCertification | ((repoDir: string, record: NativeCertificationArtifact) => string);
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface CertifySelectedTarget {
  provider: NativeProviderName;
  model: string;
}

export interface CertifySelectedOptions extends Omit<CertifyAllOptions, 'provider'> {
  targets: CertifySelectedTarget[];
}

export interface CertifyAllEntry {
  provider: string;
  model: string;
  reason?: string;
  artifactPath?: string;
}

export interface CertifyAllResult {
  phase: CertificationPhase;
  suiteVersion: string;
  dryRun: boolean;
  published: CertifyAllEntry[];
  skipped: CertifyAllEntry[];
  failed: CertifyAllEntry[];
}

export async function certifyNativeAgent(opts: CertifyOptions): Promise<CertifyResult> {
  const runScenariosFn = opts.runScenariosFn ?? runScenarios;
  const runOpenRouterSmokeFn = opts.runOpenRouterSmokeFn ?? runOpenRouterSmoke;
  const writeCertificationFn = opts.writeCertificationFn ?? writeGlobalCertification;
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun ?? false;

  const baseRegistry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  let registry = baseRegistry;
  const registryModelId = resolveRegistryModelId(opts.provider, opts.model, registry);
  if (registryModelId !== opts.model && baseRegistry.models[registryModelId]) {
    registry = {
      ...baseRegistry,
      models: {
        ...baseRegistry.models,
        [opts.model]: baseRegistry.models[registryModelId]!,
      },
    };
  }

  const modelEntry = registry.models[registryModelId];
  const nativeCapability = modelEntry?.nativeCapability;

  if (!nativeCapability || nativeCapability.readOnlyNative === 'unsupported') {
    throw Object.assign(
      new Error(`Model "${opts.model}" with provider "${opts.provider}" is not supported for native certification (readOnlyNative: ${nativeCapability?.readOnlyNative ?? 'unregistered'}).`),
      { exitCode: 1 },
    );
  }

  if (nativeCapability.nativeProvider !== opts.provider) {
    throw Object.assign(
      new Error(`Model "${opts.model}" is registered with provider "${nativeCapability.nativeProvider}", not "${opts.provider}".`),
      { exitCode: 1 },
    );
  }

  const transport = nativeCapability.piTransportKind;
  const suiteVersion = DEFAULT_CERTIFICATION_SUITE_VERSION;
  const resolvedSubject = resolveCertificationSubject({
    provider: opts.provider,
    model: registryModelId,
    registry: baseRegistry,
  });

  // Filter scenarios to those whose phase is satisfied by the requested phase
  const allScenarios = getDefaultScenarios();
  const phaseScenarios = allScenarios.filter(s => opts.phase === s.phase || PHASE_ORDER.indexOf(s.phase) <= PHASE_ORDER.indexOf(opts.phase));
  const hasRequestedPhaseScenario = phaseScenarios.some(s => s.phase === opts.phase);

  const runOpts: RunScenariosOptions = {
    provider: opts.provider,
    model: opts.model,
    transport,
    scenarios: phaseScenarios,
    registry,
    dryRun,
  };

  const report = await runScenariosFn(runOpts);
  const phaseCoverageLimitation = hasRequestedPhaseScenario
    ? undefined
    : `Certification suite ${suiteVersion} has no ${opts.phase} scenarios; lower-phase results cannot certify ${opts.phase}.`;
  const knownLimitations = phaseCoverageLimitation
    ? [...report.knownLimitations, phaseCoverageLimitation]
    : report.knownLimitations;
  const liveCertifiable = report.liveCertifiable && hasRequestedPhaseScenario;

  let artifactPath: string | undefined;
  let liveSmokeEvidence: LiveSmokeEvidence | undefined;
  let liveCanary: LiveCodingCanaryResult | undefined;
  let canarySummary: CertifyLiveCanarySummary | undefined;
  let codingEligible = false;

  // The live coding canary applies whenever the certified phase can satisfy
  // coding (`patch` or `workflow`). It never runs during dry-run.
  const canaryApplicable = phaseSatisfies(opts.phase, 'patch');

  if (liveCertifiable && !dryRun) {
    if (opts.provider === 'openrouter' && modelEntry?.identity?.status === 'provisional') {
      liveSmokeEvidence = await requireFreshOpenRouterSmokeEvidence({
        subject: resolvedSubject.subject,
        registryKey: registryModelId,
        registry,
        env,
        now,
        runOpenRouterSmokeFn,
      });
    }

    if (canaryApplicable) {
      const previousCanary = loadPreviousEligibleCanary({
        loadPreviousArtifactFn: opts.loadPreviousArtifactFn,
        provider: resolvedSubject.storageIdentity.provider,
        model: resolvedSubject.storageIdentity.model,
        suiteVersion,
        subject: resolvedSubject.subject,
        now,
      });

      if (opts.liveCodingCanary) {
        const runLiveCanaryFn = opts.runLiveCanaryFn ?? runLiveCodingCanary;
        const run = await runLiveCanaryFn({
          provider: opts.provider,
          registryModelId,
          subject: resolvedSubject.subject,
          suiteVersion,
          registry,
          repoDir: opts.repoDir,
          env,
          now,
          ...(opts.canaryLimits ? { limits: opts.canaryLimits } : {}),
        });
        if (run.status === 'inconclusive' && previousCanary) {
          // A transient attempt never overwrites a fresh identity-matching
          // pass; it is recorded as non-authoritative attempt evidence.
          liveCanary = {
            ...previousCanary,
            lastInconclusiveAttempt: {
              ranAt: run.ranAt,
              status: 'inconclusive',
              reason: run.reason ?? 'provider_transient_error',
              ...(run.detail ? { detail: run.detail } : {}),
            },
          };
          canarySummary = summarizeCanary(liveCanary, true);
        } else if (run.status === 'skipped' && previousCanary) {
          // A canary that could not start (e.g. missing credentials) carries
          // no evidence either way; the existing valid pass stays authoritative.
          liveCanary = previousCanary;
          canarySummary = summarizeCanary(previousCanary, true);
        } else {
          // Pass and definitive failure are both authoritative: a definitive
          // failure revokes any previously recorded pass for this identity.
          liveCanary = run;
          canarySummary = summarizeCanary(run, false);
        }
      } else if (previousCanary) {
        // Deterministic-only re-certification preserves existing valid canary
        // evidence so routine renewals do not silently revoke coding eligibility.
        liveCanary = previousCanary;
        canarySummary = summarizeCanary(previousCanary, true);
      }
    }

    const artifact: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      subject: resolvedSubject.subject,
      provider: resolvedSubject.storageIdentity.provider,
      model: resolvedSubject.storageIdentity.model,
      phase: opts.phase,
      suiteVersion,
      certifiedAt: now().toISOString(),
      scenarios: report.results
        .filter((result) => result.status !== 'not-run')
        .map(toArtifactScenario),
      ...(knownLimitations.length > 0 ? { knownLimitations } : {}),
      ...(liveSmokeEvidence ? { liveSmokeEvidence } : {}),
      ...(liveCanary ? { liveCanary } : {}),
    };
    artifactPath = writeCertificationFn.length >= 2
      ? (writeCertificationFn as (repoDir: string, record: NativeCertificationArtifact) => string)(opts.repoDir, artifact)
      : (writeCertificationFn as typeof writeGlobalCertification)(artifact);

    codingEligible = canaryApplicable
      && evaluateLiveCodingCanaryEligibility(artifact, suiteVersion, now(), resolvedSubject.subject).eligible;
  }

  return {
    provider: opts.provider,
    model: opts.model,
    phase: opts.phase,
    suiteVersion,
    dryRun,
    harnessPassed: report.harnessPassed,
    liveCertifiable,
    artifactPath,
    ...(artifactPath ? { artifactScope: 'global' as const } : {}),
    subject: resolvedSubject.subject,
    ...(liveSmokeEvidence ? { liveSmokeEvidence } : {}),
    ...(canarySummary ? { liveCanary: canarySummary } : {}),
    codingEligible,
    scenarios: report.results.map(r => ({
      scenarioId: r.scenarioId,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    })),
    knownLimitations,
  };
}

function summarizeCanary(canary: LiveCodingCanaryResult, carriedForward: boolean): CertifyLiveCanarySummary {
  return {
    status: canary.status,
    isLive: canary.isLive,
    ranAt: canary.ranAt,
    ...(canary.reason ? { reason: canary.reason } : {}),
    ...(canary.limitExceeded ? { limitExceeded: canary.limitExceeded } : {}),
    ...(canary.detail ? { detail: canary.detail } : {}),
    ...(canary.attempts !== undefined ? { attempts: canary.attempts } : {}),
    ...(carriedForward ? { carriedForward: true } : {}),
  };
}

/**
 * Load the previously published artifact's canary when — and only when — it
 * still grants coding eligibility for the current subject and suite (fresh,
 * live, identity-matching pass). Anything else returns undefined so stale or
 * mismatched evidence is dropped rather than carried forward.
 */
function loadPreviousEligibleCanary(input: {
  loadPreviousArtifactFn: CertifyOptions['loadPreviousArtifactFn'];
  provider: string;
  model: string;
  suiteVersion: string;
  subject: CertificationSubject;
  now: () => Date;
}): LiveCodingCanaryResult | undefined {
  const load = input.loadPreviousArtifactFn ?? defaultLoadPreviousArtifact;
  let previous: NativeCertificationArtifact | undefined;
  try {
    previous = load(input.provider, input.model, input.suiteVersion);
  } catch {
    return undefined;
  }
  if (!previous) return undefined;
  const eligibility = evaluateLiveCodingCanaryEligibility(previous, input.suiteVersion, input.now(), input.subject);
  return eligibility.eligible ? eligibility.canary : undefined;
}

function defaultLoadPreviousArtifact(
  provider: string,
  model: string,
  suiteVersion: string,
): NativeCertificationArtifact | undefined {
  const loaded = loadGlobalCertification(provider, model, suiteVersion);
  if (!loaded.ok) return undefined;
  return isRevisionAwareArtifact(loaded.artifact) ? loaded.artifact : undefined;
}

export async function certifyAllNativeAgents(opts: CertifyAllOptions): Promise<CertifyAllResult> {
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const targets = Object.entries(registry.models)
    .filter(([, model]) => {
      const capability = model.nativeCapability;
      if (!capability || capability.readOnlyNative === 'unsupported') return false;
      if (opts.provider && capability.nativeProvider !== opts.provider) return false;
      return true;
    })
    .map(([model, entry]) => ({
      model,
      provider: entry.nativeCapability!.nativeProvider,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  return certifySelectedNativeAgents({ ...opts, registry, targets });
}

export async function certifySelectedNativeAgents(opts: CertifySelectedOptions): Promise<CertifyAllResult> {
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const published: CertifyAllEntry[] = [];
  const skipped: CertifyAllEntry[] = [];
  const failed: CertifyAllEntry[] = [];
  const targets = [...opts.targets]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  for (const target of targets) {
    try {
      const result = await certifyNativeAgent({
        provider: target.provider,
        model: target.model,
        phase: opts.phase,
        repoDir: opts.repoDir,
        dryRun: opts.dryRun,
        liveCodingCanary: opts.liveCodingCanary,
        canaryLimits: opts.canaryLimits,
        registry,
        runScenariosFn: opts.runScenariosFn,
        runOpenRouterSmokeFn: opts.runOpenRouterSmokeFn,
        runLiveCanaryFn: opts.runLiveCanaryFn,
        loadPreviousArtifactFn: opts.loadPreviousArtifactFn,
        writeCertificationFn: opts.writeCertificationFn,
        now: opts.now,
        env: opts.env,
      });
      if (!result.harnessPassed) {
        failed.push({
          provider: result.provider,
          model: result.model,
          reason: 'certification harness failed',
        });
      } else if (result.artifactPath) {
        published.push({
          provider: result.provider,
          model: result.model,
          artifactPath: result.artifactPath,
        });
      } else {
        skipped.push({
          provider: result.provider,
          model: result.model,
          reason: result.dryRun ? 'dry-run' : 'not live-certifiable',
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const entry = { provider: target.provider, model: target.model, reason: message };
      if (isPolicySkip(message)) {
        skipped.push(entry);
      } else {
        failed.push(entry);
      }
    }
  }

  return {
    phase: opts.phase,
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    dryRun: opts.dryRun ?? false,
    published,
    skipped,
    failed,
  };
}

function isPolicySkip(message: string): boolean {
  return message.includes('OPENROUTER_LIVE_SMOKE=1 is required before publishing a provisional OpenRouter certification');
}

async function requireFreshOpenRouterSmokeEvidence(input: {
  subject: CertificationSubject;
  registryKey: string;
  registry: ModelRegistry;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  runOpenRouterSmokeFn: typeof runOpenRouterSmoke;
}): Promise<LiveSmokeEvidence> {
  const consent = input.env.OPENROUTER_LIVE_SMOKE?.trim().toLowerCase();
  if (consent !== '1' && consent !== 'true') {
    throw Object.assign(
      new Error('OPENROUTER_LIVE_SMOKE=1 is required before publishing a provisional OpenRouter certification.'),
      { exitCode: 1 },
    );
  }
  const apiKey = input.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error('OPENROUTER_API_KEY is required before publishing a provisional OpenRouter certification.'),
      { exitCode: 1 },
    );
  }

  const model = input.registry.models[input.registryKey];
  const supported = model?.supportedModel;
  const report = await input.runOpenRouterSmokeFn({
    entries: [{
      wavemillAlias: supported?.wavemillAlias ?? input.registryKey,
      openrouterId: input.subject.providerNativeId,
      family: model?.identity?.family === 'unknown' ? 'unknown' : model?.identity?.family ?? 'unknown',
      contextTokens: model?.contextWindowTokens ?? null,
      pricing: {
        inputPerMTok: model?.pricing?.inputCostPerMTok ?? null,
        outputPerMTok: model?.pricing?.outputCostPerMTok ?? null,
        cacheReadPerMTok: model?.pricing?.cacheReadCostPerMTok ?? null,
        cacheWritePerMTok: model?.pricing?.cacheWriteCostPerMTok ?? null,
      },
      roleEligibility: supported?.stages?.filter((stage): stage is 'planning' | 'coding' | 'review' =>
        stage === 'planning' || stage === 'coding' || stage === 'review') ?? [],
      status: model?.identity?.status === 'provisional' ? 'provisional' : 'active',
      priorityTier: 0,
      resolvedAt: input.now().toISOString(),
    }],
    apiKey,
    now: input.now,
    catalogHash: input.subject.catalogHash,
  });
  const smoke = report[0];
  if (!smoke || smoke.status !== 'ok') {
    throw Object.assign(
      new Error(`OpenRouter live smoke failed for ${input.subject.providerNativeId}: ${formatSmokeFailure(smoke)}`),
      { exitCode: 1 },
    );
  }
  if (smoke.requestedWireId !== input.subject.providerNativeId || smoke.catalogHash !== input.subject.catalogHash) {
    throw Object.assign(
      new Error('OpenRouter live smoke evidence did not match the current certification subject.'),
      { exitCode: 1 },
    );
  }
  return {
    requestedWireId: smoke.requestedWireId,
    ...(smoke.providerReturnedModel ? { providerReturnedModel: smoke.providerReturnedModel } : {}),
    catalogHash: smoke.catalogHash,
    succeededAt: smoke.checkedAt,
  };
}

function formatSmokeFailure(smoke: SmokeReport | undefined): string {
  if (!smoke) return 'no smoke result';
  return smoke.detail ? `${smoke.category ?? 'blocker'}: ${smoke.detail}` : smoke.category ?? 'blocker';
}

function resolveRegistryModelId(
  provider: NativeProviderName,
  modelId: string,
  registry: ModelRegistry,
): string {
  if (registry.models[modelId]) {
    return modelId;
  }

  if (provider !== 'openrouter') {
    return modelId;
  }

  const mappedAlias = resolveWavemillAliasFromOpenRouterId(modelId);
  if (mappedAlias && registry.models[mappedAlias]) {
    return mappedAlias;
  }

  const parts = modelId.split('/');
  if (parts.length === 2 && registry.models[parts[1]!]) {
    return parts[1]!;
  }

  return modelId;
}

export function runCertifyCommand(argv = process.argv.slice(2)): Promise<void> {
return runTool({
  name: 'native-agent-certify',
  description: 'Run the certification scenario harness for a native provider/model/phase and persist the artifact on success.',
  options: {
    provider: {
      type: 'string',
      description: `Provider to certify. One of: ${NATIVE_PROVIDERS.join(', ')}.`,
    },
    model: {
      type: 'string',
      description: 'Model ID to certify (e.g. gpt-4o).',
    },
    phase: {
      type: 'string',
      description: `Certification phase. One of: ${PHASE_ORDER.join(', ')}.`,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Run scenarios without persisting a certification artifact.',
    },
    'live-coding-canary': {
      type: 'boolean',
      description: 'Run the provider-backed live coding canary (credentialed; required for coding eligibility). Never runs with --dry-run.',
    },
    'canary-max-cost-usd': {
      type: 'string',
      description: 'Override the live canary maximum estimated cost in USD (default 0.5).',
    },
    'canary-timeout-ms': {
      type: 'string',
      description: 'Override the live canary wall-clock limit in milliseconds (default 240000).',
    },
    'canary-max-tokens': {
      type: 'string',
      description: 'Override the live canary total token budget (default 60000).',
    },
    'canary-max-tool-calls': {
      type: 'string',
      description: 'Override the live canary tool-call budget (default 10).',
    },
    all: {
      type: 'boolean',
      description: 'Certify every native-capable registry model. --provider filters the batch when set.',
    },
    'refresh-canary-cohort': {
      type: 'boolean',
      description: 'Refresh live coding canaries for the configured bounded cohort (credentialed; targets only missing/stale/renewal-due/identity-invalidated members).',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON.',
    },
    repo: {
      type: 'string',
      description: 'Repository directory. Defaults to current working directory.',
    },
  },
  examples: [
    'npx tsx tools/native-agent-certify.ts --provider openai --model gpt-4o --phase read-only --dry-run',
    'npx tsx tools/native-agent-certify.ts --provider openai --model gpt-4o --phase read-only',
    'npx tsx tools/native-agent-certify.ts --provider openrouter --model openai/gpt-4o --phase read-only --json',
    'npx tsx tools/native-agent-certify.ts --all --phase workflow',
    'npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen-3-coder --phase workflow --live-coding-canary',
    'npx tsx tools/native-agent-certify.ts --refresh-canary-cohort',
  ],
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const rawProvider = args.provider as string | undefined;
    const rawModel = args.model as string | undefined;
    const rawPhase = (args.phase as string | undefined) ?? 'workflow';
    const dryRun = args['dry-run'] === true;
    const all = args.all === true;
    const liveCodingCanary = args['live-coding-canary'] === true;
    const canaryLimits = parseCanaryLimitFlags(args);
    if (!canaryLimits.ok) {
      console.error(`Error: ${canaryLimits.message}`);
      process.exit(2);
    }
    if (liveCodingCanary && dryRun) {
      console.error('Error: --live-coding-canary cannot be combined with --dry-run (the canary is a live provider run).');
      process.exit(2);
    }

    const refreshCohort = args['refresh-canary-cohort'] === true;
    if (refreshCohort) {
      const conflictError = refreshCohortFlagError(args);
      if (conflictError) {
        console.error(`Error: ${conflictError}`);
        process.exit(2);
      }
      const refresh = await refreshCanaryCohort({
        repoDir,
        certifyFn: certifyNativeAgent,
        respectAttemptGuard: false,
        ...(canaryLimits.limits ? { canaryLimits: canaryLimits.limits } : {}),
        log: (line) => console.error(line),
      });
      if (args.json === true) {
        console.log(JSON.stringify(refresh, null, 2));
      } else {
        for (const outcome of refresh.outcomes) {
          console.log(
            `${outcome.provider}/${outcome.model}: ${outcome.action}`
            + (outcome.result ? ` result=${outcome.result}` : ` state=${outcome.state}`)
            + ` eligible=${outcome.codingEligible ? 'yes' : 'no'}`
            + (outcome.reason ? ` - ${outcome.reason}` : ''),
          );
        }
        console.log('');
        console.log(renderCanaryCohortHealth(refresh.health));
      }
      const hadError = refresh.outcomes.some((outcome) => outcome.result === 'error');
      if (hadError || refresh.health.belowMinimum) {
        process.exit(1);
      }
      return;
    }

    // Validate required flags
    if (!all && !rawProvider) {
      console.error('Error: --provider is required');
      process.exit(2);
    }
    if (!all && !rawModel) {
      console.error('Error: --model is required');
      process.exit(2);
    }
    if (all && rawModel) {
      console.error('Error: --all cannot be combined with --model');
      process.exit(2);
    }

    // Validate phase
    if (!(PHASE_ORDER as readonly string[]).includes(rawPhase)) {
      console.error(`Error: invalid --phase "${rawPhase}". Must be one of: ${PHASE_ORDER.join(', ')}`);
      process.exit(2);
    }

    const phase = rawPhase as CertificationPhase;

    if (rawProvider && !(NATIVE_PROVIDERS as readonly string[]).includes(rawProvider)) {
      console.error(`Error: invalid --provider "${rawProvider}". Must be one of: ${NATIVE_PROVIDERS.join(', ')}`);
      process.exit(2);
    }

    const provider = rawProvider as NativeProviderName | undefined;

    if (all) {
      const result = await certifyAllNativeAgents({
        provider,
        phase,
        repoDir,
        dryRun,
        liveCodingCanary,
        ...(canaryLimits.limits ? { canaryLimits: canaryLimits.limits } : {}),
      });
      if (args.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        renderCertifyAllSummary(result);
      }
      if (result.failed.length > 0) {
        process.exit(1);
      }
      return;
    }

    let result: CertifyResult;
    try {
      result = await certifyNativeAgent({
        provider: provider!,
        model: rawModel!,
        phase,
        repoDir,
        dryRun,
        liveCodingCanary,
        ...(canaryLimits.limits ? { canaryLimits: canaryLimits.limits } : {}),
      });
    } catch (err: unknown) {
      const exitCode = (err as { exitCode?: number }).exitCode;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(exitCode === 1 ? 1 : 2);
    }

    if (args.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const prefix = dryRun ? '[dry-run] ' : '';
      console.log(`${prefix}Provider: ${result.provider}`);
      console.log(`${prefix}Model:    ${result.model}`);
      console.log(`${prefix}Phase:    ${result.phase}`);
      console.log(`${prefix}Suite:    ${result.suiteVersion}`);
      console.log('');
      for (const s of result.scenarios) {
        const statusLabel = s.status.toUpperCase().padEnd(12);
        console.log(`  ${statusLabel} ${s.scenarioId}${s.detail ? ` — ${s.detail}` : ''}`);
      }
      if (result.knownLimitations.length > 0) {
        console.log('');
        console.log('Known limitations:');
        for (const lim of result.knownLimitations) {
          console.log(`  - ${lim}`);
        }
      }
      console.log('');
      if (result.harnessPassed) {
        if (dryRun) {
          console.log('Dry-run PASSED. No artifact written.');
      } else if (result.artifactPath) {
          console.log(`CERTIFIED. Artifact (${result.artifactScope ?? 'global'}): ${result.artifactPath}`);
        } else {
          console.log('Passed (not live-certifiable — no artifact written).');
        }
      } else {
        console.log('FAILED. Certification not written.');
      }
      console.log(renderCanaryStatusLine(result, phase));
    }

    if (!result.harnessPassed) {
      process.exit(1);
    }
    if (liveCodingCanary && !result.dryRun && !result.codingEligible) {
      process.exit(1);
    }
  },
}, argv);
}

/**
 * Flag-combination validation for `--refresh-canary-cohort`. The cohort path
 * is exclusively live and exclusively cohort-scoped: dry-run and any explicit
 * target selection are rejected up front.
 */
export function refreshCohortFlagError(args: Record<string, unknown>): string | undefined {
  if (args['dry-run'] === true) {
    return '--refresh-canary-cohort cannot be combined with --dry-run (the canary is a live provider run).';
  }
  if (args.all === true) {
    return '--refresh-canary-cohort cannot be combined with --all (the refresh is bounded to the configured cohort).';
  }
  if (args.model !== undefined || args.provider !== undefined) {
    return '--refresh-canary-cohort targets the configured cohort; --provider/--model cannot be combined with it.';
  }
  if (args['live-coding-canary'] === true) {
    return '--refresh-canary-cohort already implies the live coding canary; drop --live-coding-canary.';
  }
  return undefined;
}

/**
 * One explicit line stating deterministic vs live-canary state and whether
 * coding eligibility is granted — operators should never have to infer it.
 */
export function renderCanaryStatusLine(result: CertifyResult, phase: CertificationPhase): string {
  if (!phaseSatisfies(phase, 'patch')) {
    return `Live coding canary: not applicable for phase ${phase} (coding eligibility requires a patch/workflow certification plus a live canary pass).`;
  }
  if (result.dryRun) {
    return 'Live coding canary: not run (dry-run). Coding eligibility: NOT granted.';
  }
  const canary = result.liveCanary;
  if (!canary) {
    return 'Live coding canary: missing (run with --live-coding-canary). Coding eligibility: NOT granted.';
  }
  const provenance = canary.carriedForward ? 'carried forward from previous artifact' : 'from this run';
  const detail = [
    `status=${canary.status}`,
    `live=${canary.isLive}`,
    canary.reason ? `reason=${canary.reason}` : '',
    canary.limitExceeded ? `limit=${canary.limitExceeded}` : '',
    `ranAt=${canary.ranAt}`,
  ].filter(Boolean).join(' ');
  return `Live coding canary (${provenance}): ${detail}. Coding eligibility: ${result.codingEligible ? 'granted' : 'NOT granted'}.`;
}

function parseCanaryLimitFlags(args: Record<string, unknown>):
  | { ok: true; limits?: { maxCostUsd?: number; maxWallClockMs?: number; maxTotalTokens?: number; maxToolCalls?: number } }
  | { ok: false; message: string } {
  const parse = (flag: string, integer: boolean): number | undefined | null => {
    const raw = args[flag];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
      return null;
    }
    return value;
  };

  const maxCostUsd = parse('canary-max-cost-usd', false);
  if (maxCostUsd === null) return { ok: false, message: '--canary-max-cost-usd must be a positive number' };
  const maxWallClockMs = parse('canary-timeout-ms', true);
  if (maxWallClockMs === null) return { ok: false, message: '--canary-timeout-ms must be a positive integer' };
  const maxTotalTokens = parse('canary-max-tokens', true);
  if (maxTotalTokens === null) return { ok: false, message: '--canary-max-tokens must be a positive integer' };
  const maxToolCalls = parse('canary-max-tool-calls', true);
  if (maxToolCalls === null) return { ok: false, message: '--canary-max-tool-calls must be a positive integer' };

  const limits = {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}),
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
  };
  return { ok: true, ...(Object.keys(limits).length > 0 ? { limits } : {}) };
}

function renderCertifyAllSummary(result: CertifyAllResult): void {
  const prefix = result.dryRun ? '[dry-run] ' : '';
  console.log(`${prefix}Phase: ${result.phase}`);
  console.log(`${prefix}Suite: ${result.suiteVersion}`);
  console.log(`${prefix}Published: ${result.published.length}`);
  console.log(`${prefix}Skipped:   ${result.skipped.length}`);
  console.log(`${prefix}Failed:    ${result.failed.length}`);
  for (const [label, entries] of [
    ['Published', result.published],
    ['Skipped', result.skipped],
    ['Failed', result.failed],
  ] as const) {
    if (entries.length === 0) continue;
    console.log('');
    console.log(`${label}:`);
    for (const entry of entries) {
      console.log(`  ${entry.provider}/${entry.model}${entry.artifactPath ? ` -> ${entry.artifactPath}` : ''}${entry.reason ? ` - ${entry.reason}` : ''}`);
    }
  }
}

if (import.meta.main) {
  await runCertifyCommand();
}
