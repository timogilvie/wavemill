import { budgetExhaustionFromLoop } from '../budget-exhaustion.ts';
import { resolveNativeStageTimeSplit } from '../stage-time-split.ts';
import { ProviderIdentityMismatchError } from '../provider-identity.ts';
import { createRunTestsTool } from '../tools/command-tools.ts';
import { recordLaunch } from '../../session-ownership.ts';
import { meterWorkflowCost } from '../../sdk-task-cost/meter.ts';
import { redactProviderExecutions, redactStageTaskCost, redactSessionIds } from '../../hokusai-redaction.ts';
import { buildTechnicalTaskRouterRowV4 } from '../../hokusai-contribution-builder.ts';
import { classifyArmFault, type ArmFaultClass } from '../../arm-failure-taxonomy.ts';
import { TranscriptWriter } from '../transcript.ts';
import { endpointRouting } from './identity.ts';
import type { ExactPricingOptions } from '../../pricing/openrouter-exact-pricing.ts';
/**
 * Live coding canary runner (HOK-2943).
 *
 * Proves that a native provider/model can drive the PRODUCTION coding
 * mutation tool path: one structured `apply_patch` call that mutates a
 * sentinel file to exact expected bytes, plus the standard `.coding-complete`
 * completion artifact — inside a disposable, isolated git repository with
 * strict wall-clock/turn/tool-call/token/cost budgets.
 *
 * ## Verdict taxonomy
 *
 * - `pass`         — structured mutation observed, sentinel exactly matches,
 *                    no out-of-scope repository changes, valid completion artifact
 * - `fail`         — definitive protocol/mutation/artifact/budget failure
 * - `inconclusive` — transient provider error, wall-clock expiry, or harness
 *                    fault; safe to retry, never grants eligibility
 * - `skipped`      — canary could not start (e.g. missing credentials);
 *                    never grants eligibility
 *
 * ## Liveness contract
 *
 * `isLive` is true only when the runner invoked the real provider adapter —
 * any injected loop runner or model override (test seams) forces
 * `isLive: false`, so mocked runs can never satisfy the live coding gate.
 *
 * ## Isolation contract
 *
 * The canary never touches the user's repository. All state lives under a
 * `mkdtemp` directory inside the OS temp root; cleanup verifies the directory
 * prefix before recursive removal and also runs on process exit.
 *
 * @module native-agent/certification/live-coding-canary
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { getOpenRouterRouting, type ModelRegistry, type NativeProviderName } from '../../model-registry.ts';
import type { ModelPricing } from '../../pricing/model-pricing.ts';
import { getNativeAgentConfig } from '../../config.ts';
import { resolveEnvValue } from '../../env-file.ts';
import { runWavemillLoop, type LoopResult, type WavemillLoopConfig } from '../loop.ts';
import { createNativeModelsCollection } from '../models.ts';
import type { AgentContext, LoopStopReason } from '../loop.ts';
import type { Message } from '../messages.ts';
import { budgetKindForStopReason, finalProviderErrorMessage, type BudgetKind } from '../budget-exhaustion.ts';
import { classifyProviderError } from '../provider-error-classifier.ts';
import { buildNativePatchGuidance } from '../patch-contract.ts';
import { normalizeCodingCompleteContent } from '../completion-normalizer.ts';
import {
  buildOpenAiResponsesModel,
  buildOpenRouterModel,
  OPENAI_DEFAULT_API_KEY_ENV,
  OPENROUTER_DEFAULT_API_KEY_ENV,
} from '../providers.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from '../tools/read-only.ts';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
} from '../tools/mutation-tools.ts';
import { redactSecrets } from '../tools/redaction.ts';
import { toPiAgentTool, type AgentTool } from '../tools/pi-adapter.ts';
import type { ToolDescriptor } from '../tools/types.ts';
import {
  LIVE_CODING_CANARY_SCENARIO_ID,
  endpointObservationsMatch,
  type CertificationSubject,
  type LiveCodingCanaryEvidence,
  type LiveCodingCanaryFailureReason,
  type LiveCodingCanaryLimitKind,
  type LiveCodingCanaryLimits,
  type LiveCodingCanaryResult,
  type LiveCodingCanaryStatus,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Canary fixture contract
// ---------------------------------------------------------------------------

/** Repo-relative sentinel path the model must mutate. */
export const CANARY_SENTINEL_PATH = 'src/canary.ts';
/** Sentinel content committed at baseline. */
export const CANARY_SENTINEL_INITIAL = "export const CANARY_STATE = 'pending';\n";
/** Exact bytes the sentinel must contain after the run. */
export const CANARY_SENTINEL_EXPECTED = "export const CANARY_STATE = 'mutated';\n";
/** Repo-relative completion artifact path the model must create. */
export const CANARY_COMPLETION_PATH = 'features/live-canary/.coding-complete';
/** Temp-directory prefix; cleanup refuses to remove anything else. */
export const CANARY_TMP_PREFIX = 'wavemill-canary-';

/** Tools whose successful structured invocation counts as mutation evidence. */
const MUTATION_EVIDENCE_TOOLS = new Set(['apply_patch', 'write_artifact', 'create_marker']);
const MAX_EVIDENCE_PATHS = 20;
const MAX_DETAIL_LENGTH = 300;

export const DEFAULT_CANARY_MAX_ATTEMPTS = 2;

export const DEFAULT_CANARY_LIMITS: LiveCodingCanaryLimits = {
  maxWallClockMs: 240_000,
  maxTurns: 6,
  maxToolCalls: 10,
  maxTotalTokens: 60_000,
  maxCostUsd: 0.5,
};

// ---------------------------------------------------------------------------
// Options and outcome types
// ---------------------------------------------------------------------------

export interface RunLiveCodingCanaryOptions {
  provider: NativeProviderName;
  /** Registry key for the model under certification. */
  registryModelId: string;
  /** Resolved immutable certification subject for identity stamping. */
  subject: CertificationSubject;
  suiteVersion: string;
  registry: ModelRegistry;
  repoDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Partial overrides for the run budgets; unset fields keep defaults. */
  limits?: Partial<LiveCodingCanaryLimits>;
  /** Total canary attempts for transient provider errors. Default 2. */
  maxAttempts?: number;
  /**
   * Test seam: injected loop runner. Setting this forces `isLive: false` —
   * injected results can never satisfy the live coding gate.
   */
  runLoopFn?: typeof runWavemillLoop;
  /**
   * Test seam: model config override. Setting this forces `isLive: false`.
   */
  modelOverride?: WavemillLoopConfig['model'];
  /** Test seam: temp root override (must exist). */
  tmpRootOverride?: string;
  signal?: AbortSignal;
  /** Explicit operator evidence root, outside disposable repositories; never exported. */
  evidenceRoot?: string;
  profile?: 'standard' | 'workflow' | 'cache-heavy';
  endpointPricing?: ModelPricing;
  exactPricing?: ExactPricingOptions;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the live coding canary for one provider/model/suite identity.
 *
 * Never throws for expected outcomes — provider failures, verification
 * failures, and harness faults are all folded into the returned
 * {@link LiveCodingCanaryResult}. Transient provider errors are retried in a
 * fresh disposable repository up to `maxAttempts` times.
 */
export async function runLiveCodingCanary(
  options: RunLiveCodingCanaryOptions,
): Promise<LiveCodingCanaryResult> {
  const now = options.now ?? (() => new Date());
  const limits: LiveCodingCanaryLimits = {
    ...DEFAULT_CANARY_LIMITS,
    ...(options.limits ?? {}),
  };
  const isLive = !options.runLoopFn && !options.modelOverride && !options.exactPricing?.fetchGenerationCost;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_CANARY_MAX_ATTEMPTS);

  const model = resolveCanaryModel(options);
  if (!model.ok) {
    return finalizeResult({
      status: 'skipped',
      reason: 'provider_config_error',
      detail: model.detail,
      isLive,
      limits,
      options,
      now,
      attempts: 0,
    });
  }

  let attempt = 0;
  let last: AttemptOutcome | undefined;
  const attemptEvidence: NonNullable<LiveCodingCanaryResult['attemptEvidence']> = [];
  while (attempt < maxAttempts) {
    attempt += 1;
    last = await runSingleCanaryAttempt({
      options,
      model: model.model,
      authEnv: model.authEnv,
      limits,
      now,
    });
    if (last.attemptEvidence) attemptEvidence.push(...last.attemptEvidence);
    const transient = last.status === 'inconclusive' && last.reason === 'provider_transient_error';
    if (!transient) {
      break;
    }
  }

  return finalizeResult({
    ...last!,
    attemptEvidence,
    isLive,
    limits,
    options,
    now,
    attempts: attempt,
  });
}

// ---------------------------------------------------------------------------
// Single attempt
// ---------------------------------------------------------------------------

interface AttemptOutcome {
  attemptEvidence?: LiveCodingCanaryResult['attemptEvidence'];
  status: LiveCodingCanaryStatus;
  reason?: LiveCodingCanaryFailureReason;
  limitExceeded?: LiveCodingCanaryLimitKind;
  detail?: string;
  evidence?: LiveCodingCanaryEvidence;
  usage?: LiveCodingCanaryResult['usage'];
}

async function runSingleCanaryAttempt(input: {
  options: RunLiveCodingCanaryOptions;
  model: WavemillLoopConfig['model'];
  authEnv?: { apiKey: string; apiKeyEnv: string };
  limits: LiveCodingCanaryLimits;
  now: () => Date;
}): Promise<AttemptOutcome> {
  const { options, limits, authEnv } = input;
  const runLoopFn = options.runLoopFn ?? runWavemillLoop;
  // When run live (no modelOverride), build a Models collection whose
  // AuthContext injects the resolved api key under the canonical variable
  // each built-in factory reads. Scripted tests (modelOverride set) fall
  // back to the active-models pointer. HOK-3162.
  const nativeModels = authEnv
    ? createNativeModelsCollection({
      env: {
        [authEnv.apiKeyEnv]: authEnv.apiKey,
        OPENAI_API_KEY: options.provider === 'openai' ? authEnv.apiKey : process.env.OPENAI_API_KEY,
        OPENROUTER_API_KEY: options.provider === 'openrouter' ? authEnv.apiKey : process.env.OPENROUTER_API_KEY,
      },
      repoDir: options.repoDir,
    })
    : undefined;

  let tmpRoot: string | undefined;
  const removeOnExit = () => {
    if (tmpRoot) safeRemoveCanaryDir(tmpRoot, options.tmpRootOverride);
  };
  process.once('exit', removeOnExit);
  let workspace: CanaryWorkspace | undefined;
  let transcript: TranscriptWriter | undefined;
  let evidenceDir: string | undefined;
  const sessionId = randomUUID();
  let faultClass: ArmFaultClass = 'unknown-fault';
  try {
    const execute = async (): Promise<AttemptOutcome> => {
      try {
        workspace = createCanaryWorkspace(options.tmpRootOverride, options.profile ?? 'standard');
        tmpRoot = workspace.tmpRoot;
      } catch (error) {
        return {
          status: 'inconclusive',
          reason: 'internal_error',
          detail: sanitizeDetail(`canary workspace setup failed: ${(error as Error).message}`, tmpRoot),
        };
      }

      evidenceDir = options.evidenceRoot ? join(options.evidenceRoot, sessionId) : join(workspace.tmpRoot, 'evidence');
      recordLaunch(evidenceDir, { sessionRef: sessionId, harness: 'native', kind: 'coding', model: options.registryModelId,
        attemptId: sessionId, launchedAt: input.now(), cwd: workspace.repoDir });
      transcript = new TranscriptWriter({ sessionId, model: options.registryModelId, provider: options.provider,
        api: input.model.api, worktreePath: workspace.repoDir, path: join(evidenceDir, 'native-sessions', `${sessionId}.jsonl`) });
      const evidenceRecorder = createEvidenceRecorder();
      const descriptors: ToolDescriptor[] = [
        ...createReadOnlyTools(workspace.repoDir),
        createRunTestsTool(workspace.repoDir),
        ...createCodingMutationTools(workspace.repoDir, {
          phase: 'coding',
          statusPath: workspace.statusPath,
        }),
      ];
      const registryMetadata = descriptors.map((descriptor) => descriptor.metadata);

      const context: AgentContext = {
        systemPrompt: buildCanarySystemPrompt(),
        messages: [{
          role: 'user',
          content: buildCanaryUserPrompt(workspace.profile),
          timestamp: 0,
        }],
        tools: descriptors.map((descriptor) => toPiAgentTool(descriptor) as AgentTool<unknown, unknown>),
      };

      const pricing = options.endpointPricing ?? resolveModelPricing(options);
      const budget = {
        maxTurns: limits.maxTurns,
        maxToolCalls: limits.maxToolCalls,
        // Certification artifact limits are identity-hashed and keep their
        // `maxWallClockMs` name; the loop budget is the renamed model-time one (HOK-3382).
        maxModelTimeMs: limits.maxWallClockMs,
        maxTotalTokens: limits.maxTotalTokens,
        ...(limits.maxCostUsd !== undefined && pricing ? { maxCostUsd: limits.maxCostUsd } : {}),
      };
      let result: LoopResult;
      try {
        result = await runLoopFn({
          model: input.model,
          ...(options.subject.endpoint ? { providerIdentity: { expectation: { requestedWireId: options.subject.providerNativeId,
            expectedModel: options.subject.providerNativeId, isAlias: false, registryKey: options.registryModelId } } } : {}),
          ...(nativeModels ? { models: nativeModels } : {}),
          context,
          convertToLlm: (messages) => messages as unknown as Message[],
          afterToolCall: async (toolContext) => codingMutationAfterToolCall(toolContext),
          toolPolicy: {
            phase: 'coding',
            worktreePath: workspace.repoDir,
            registry: registryMetadata,
            config: {
              pathFieldsByTool: {
                ...READ_ONLY_PATH_FIELDS,
                ...codingMutationPolicyConfig.pathFieldsByTool,
              },
            },
          },
          budget,
          ...(pricing ? { modelPricing: pricing, modelPricingScope: options.endpointPricing ? 'endpoint' as const : 'model' as const } : {}),
          maxTokens: 4096,
          signal: options.signal,
          providerErrorRetry: { maxAttempts: 2 },
          onEvent(event) { transcript!.handleEvent(event); evidenceRecorder.onEvent(event); },
        });
      } catch (error) {
        if (error instanceof ProviderIdentityMismatchError) return { status: 'fail', reason: 'identity_mismatch', detail: sanitizeDetail(error.message, tmpRoot) };
        const classification = classifyProviderError((error as Error).message ?? String(error));
        faultClass = classifyArmFault({ failureKind: classification.kind });
        return {
          status: 'inconclusive',
          reason: classification.kind === 'provider-config-error' || classification.kind === 'provider-credit-exhausted'
            ? 'provider_config_error'
            : 'provider_transient_error',
          detail: sanitizeDetail((error as Error).message, tmpRoot),
        };
      }

      const usage: LiveCodingCanaryResult['usage'] = {
        turns: result.turnsCompleted,
        toolCalls: result.toolCallsExecuted,
        inputTokens: result.totalInputTokens,
        outputTokens: result.totalOutputTokens,
        wallClockMs: result.wallClockMs,
        ...(pricing && Number.isFinite(result.totalCostUsd) ? { costUsd: result.totalCostUsd } : {}),
      };

      // Stop reason before error text (HOK-3362): a budget stop is the canary's
      // budget outcome, never the abort message our own budget left behind.
      const verification = verifyCanaryRepository(workspace, evidenceRecorder.snapshot());
      const budgetOutcome = classifyBudgetOutcome(result.stopReason);
      if (budgetOutcome) {
        const fact = budgetExhaustionFromLoop(result, budget, { transcriptPath: join(evidenceDir, 'native-sessions', `${sessionId}.jsonl`) });
        faultClass = classifyArmFault({ failureKind: 'native-stage-timeout', budgetExhausted: fact, timeSplit: resolveNativeStageTimeSplit(fact) });
        return { ...budgetOutcome, usage, evidence: verification.evidence };
      }

      if (result.providerError) faultClass = classifyArmFault({ failureKind: result.providerError.kind });
      const providerOutcome = classifyProviderOutcome(result);
      if (providerOutcome) {
        return { ...providerOutcome, detail: sanitizeDetail(providerOutcome.detail, tmpRoot), usage, evidence: verification.evidence };
      }

      const stopOutcome = classifyNonBudgetStopOutcome(result.stopReason);
      if (stopOutcome) {
        return { ...stopOutcome, usage, evidence: verification.evidence };
      }

      if (verification.status === 'fail') faultClass = classifyArmFault({ failureKind: 'completion-protocol' });
      return { ...verification, usage };
    };
    const outcome = await execute();
    const attempt = { attemptId: sessionId, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) } as NonNullable<LiveCodingCanaryResult['attemptEvidence']>[number];
    try {
      if (workspace && transcript && evidenceDir) {
        const metered = await meterWorkflowCost({ repoDir: options.repoDir, worktreePath: workspace.repoDir, featureDir: evidenceDir,
          branchName: '', issueId: sessionId, slug: 'live-canary', label: 'Certification canary',
          ...(options.endpointPricing ? { pricingTable: { [options.registryModelId]: options.endpointPricing } } : {}),
          ownership: [ { sessionRef: sessionId, harness: 'native', kind: 'coding', stage: 'coding', model: options.registryModelId, attemptId: sessionId, launchedAt: input.now().toISOString(), cwd: workspace.repoDir } ],
          exactPricing: { ...(authEnv && options.provider === 'openrouter' ? { apiKey: authEnv.apiKey } : {}), ...options.exactPricing }, logger: { log() {}, warn() {} } });
        if (metered.outcome.status === 'success' && metered.summaries?.length) {
          const providers = metered.outcome.nativeProviderExecutions ?? [];
          if (options.subject.endpoint && outcome.status === 'pass' && !endpointObservationsMatch(options.subject.endpoint, providers)) {
            const contradicted = providers.some(row => row.generation?.providerName && row.generation.providerName.trim().toLowerCase() !== options.subject.endpoint!.providerName.trim().toLowerCase());
            outcome.status = attempt.status = contradicted ? 'fail' : 'inconclusive';
            outcome.reason = attempt.reason = 'identity_mismatch';
            outcome.detail = 'Requested endpoint host could not be corroborated; deployment and quantization remain unverified.';
          }
          const executed = providers.find(row => row.responseModel)?.responseModel ?? options.registryModelId;
          const salt = sessionId;
          const taskId = redactSessionIds([sessionId], { salt })[0]!;
          attempt.contribution = buildTechnicalTaskRouterRowV4({ taskId, runId: taskId, harness: 'wavemill-certification', observedAt: input.now().toISOString(),
            observedSuccess: outcome.status === 'pass', budgetCompliant: outcome.status === 'pass', actualCostUsd: metered.outcome.totalCostUsd,
            wallClockSeconds: outcome.usage ? outcome.usage.wallClockMs / 1000 : undefined,
            taskDescriptor: { task_type: 'bugfix', language: 'typescript', complexity: 1 }, allowedModels: [executed], selectedModels: { coder: executed, reviewer: executed },
            stageExecutions: [{ stage: 'coding', executedModel: executed, modelEvidence: providers.some(row => row.responseModel) ? 'provider_response' : 'requested_only', harness: 'native',
              providerExecutions: redactProviderExecutions(providers, { salt }),
              ...(outcome.status === 'pass' ? {} : { failure: { fault_class: faultClass } }),
              cost: { summaries: metered.summaries.map(summary => redactStageTaskCost(summary, { taskId, salt })) } }],
          });
        } else if (options.subject.endpoint && outcome.status === 'pass') {
          outcome.status = attempt.status = 'inconclusive';
          outcome.reason = attempt.reason = 'identity_mismatch';
          outcome.detail = 'Endpoint qualification requires metered provider observations.';
        }
      }
    } catch (error) {
      outcome.status = attempt.status = 'inconclusive';
      outcome.reason = attempt.reason = 'internal_error';
      outcome.detail = sanitizeDetail(`Canary feedback unavailable: ${(error as Error).message}`, tmpRoot);
      delete attempt.contribution;
    }
    return { ...outcome, attemptEvidence: [attempt] };
  } finally {
    process.removeListener('exit', removeOnExit);
    removeOnExit();
  }
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

interface CanaryWorkspace {
  profile: 'standard' | 'workflow' | 'cache-heavy';
  /** mkdtemp root owning all attempt state. */
  tmpRoot: string;
  /** Disposable git repository the model mutates. */
  repoDir: string;
  /** update_status sink outside the git repository. */
  statusPath: string;
}

function createCanaryWorkspace(tmpRootOverride?: string, profile: CanaryWorkspace['profile'] = 'standard'): CanaryWorkspace {
  const base = tmpRootOverride ?? realpathSync(tmpdir());
  const tmpRoot = mkdtempSync(join(base, CANARY_TMP_PREFIX));
  const repoDir = join(tmpRoot, 'repo');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, CANARY_SENTINEL_PATH), CANARY_SENTINEL_INITIAL, 'utf-8');

  if (profile !== 'standard') {
    mkdirSync(join(repoDir, 'tests'), { recursive: true });
    writeFileSync(join(repoDir, 'src/payload.ts'), 'export const payload = "pending";\n');
    writeFileSync(join(repoDir, 'tests/canary.test.ts'), `import assert from 'node:assert/strict';\nimport { CANARY_STATE } from '../src/canary.ts';\nimport { payload } from '../src/payload.ts';\nassert.equal(CANARY_STATE, 'mutated');\nassert.equal(payload, ${JSON.stringify('quote " slash \\ newline\nUnicode Ω')});\n`);
  }
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmpRoot, XDG_CONFIG_HOME: tmpRoot },
  });
  git(['init', '-q']);
  git(['add', '-A']);
  git([
    '-c', 'user.email=canary@wavemill.invalid',
    '-c', 'user.name=wavemill-canary',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'canary baseline',
  ]);

  return { tmpRoot, repoDir, profile, statusPath: join(tmpRoot, 'status.json') };
}

/**
 * Remove a canary temp directory, but only after verifying it lives under the
 * expected temp root and carries the canary prefix — never a broad recursive
 * delete of an arbitrary path.
 */
export function safeRemoveCanaryDir(tmpRoot: string, tmpRootOverride?: string): void {
  try {
    const base = tmpRootOverride ?? realpathSync(tmpdir());
    const normalizedBase = base.endsWith(sep) ? base : `${base}${sep}`;
    if (!tmpRoot.startsWith(normalizedBase)) return;
    const remainder = tmpRoot.slice(normalizedBase.length);
    if (!remainder.startsWith(CANARY_TMP_PREFIX) || remainder.includes(sep) || remainder.includes('..')) return;
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS temp reaper is the final backstop.
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildCanarySystemPrompt(): string {
  return [
    'You are a native coding agent completing a short certification canary task.',
    'You MUST perform file changes exclusively through the provided structured tools.',
    'Writing patch syntax as plain assistant text is a certification failure — only real tool calls count.',
    '',
    '### Native Coding Tool Rules',
    '- Use apply_patch for source edits; do not use whole-file writes for source files.',
    '',
    '#### apply_patch NativePatch Contract',
    buildNativePatchGuidance(),
    '',
    '- Use create_marker or write_artifact only for the completion artifact described in the task.',
    '- Make no repository changes beyond the ones the task asks for.',
  ].join('\n');
}

function buildCanaryUserPrompt(profile: CanaryWorkspace['profile'] = 'standard'): string {
  return [
    profile === 'standard' ? 'Certification canary task. Perform exactly these two steps, then stop:' : 'Certification canary task. Apply both source edits, run the focused test, then create the completion marker last:',
    '',
    `1. Use the apply_patch tool to edit ${CANARY_SENTINEL_PATH} so its full content becomes exactly:`,
    '',
    CANARY_SENTINEL_EXPECTED.trimEnd(),
    '',
    `   (The file currently contains: ${CANARY_SENTINEL_INITIAL.trimEnd()})`,
    '',
    ...(profile === 'standard' ? [] : [
      `2. Update src/payload.ts to export this exact string: ${JSON.stringify('quote \" slash \\ newline\nUnicode Ω')}. Use an additional NativePatch edit operation; preserve escaping.`,
      '3. Run `node --test tests/canary.test.ts` through run_tests and obtain exit code 0 before completing.',
    ]),
    `${profile === 'standard' ? '2' : '4'}. Use the create_marker tool to create ${CANARY_COMPLETION_PATH} with this exact content:`,
    '',
    '{"stage":"coding","confidence":"high"}',
    '',
    profile === 'standard' ? 'Do not create, modify, or delete any other file. Do not run any other commands.' : 'Only src/canary.ts, src/payload.ts and the completion marker may change. Create the marker only after the test passes.',
    ...(profile === 'cache-heavy' ? ['Read-only context fixture (unchanged throughout the run):', 'cached-context-0123456789abcdef\n'.repeat(1100)] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

interface ResolvedCanaryModel {
  model: WavemillLoopConfig['model'];
  /** apiKey + apiKeyEnv for building the per-run Models collection, absent for `modelOverride`. */
  authEnv?: { apiKey: string; apiKeyEnv: string };
}

type CanaryModelResolution =
  | ({ ok: true } & ResolvedCanaryModel)
  | { ok: false; detail: string };

function resolveCanaryModel(options: RunLiveCodingCanaryOptions): CanaryModelResolution {
  if (options.modelOverride) {
    return { ok: true, model: options.modelOverride };
  }

  const env = options.env ?? process.env;
  const providerConfig = getNativeAgentConfig(options.repoDir).providers?.[options.provider];
  const apiKeyEnv = providerConfig?.apiKeyEnv?.trim()
    || (options.provider === 'openai' ? OPENAI_DEFAULT_API_KEY_ENV : OPENROUTER_DEFAULT_API_KEY_ENV);
  const apiKey = env[apiKeyEnv]?.trim() || resolveEnvValue([apiKeyEnv], options.repoDir);
  if (!apiKey) {
    return { ok: false, detail: `${apiKeyEnv} is not set; live coding canary cannot run` };
  }

  const baseUrl = providerConfig?.baseUrl?.trim() || undefined;
  const headers = providerConfig?.headers ?? {};
  const built = options.provider === 'openai'
    ? buildOpenAiResponsesModel({ modelId: options.registryModelId, ...(baseUrl ? { baseUrl } : {}), headers })
    : buildOpenRouterModel({
      modelId: options.registryModelId,
      ...(baseUrl ? { baseUrl } : {}),
      headers,
      routing: options.subject.endpoint ? endpointRouting(options.subject.endpoint) : getOpenRouterRouting(options.registry, options.registryModelId),
    });

  // HOK-3162: Models owns auth injection; keep model.headers for user-provided
  // headers only.
  return {
    ok: true,
    model: { ...built, headers: { ...(built.headers ?? {}) } },
    authEnv: { apiKey, apiKeyEnv },
  };
}

function resolveModelPricing(options: RunLiveCodingCanaryOptions): ModelPricing | undefined {
  const entry = options.registry.models[options.registryModelId];
  if (!entry) return undefined;
  if (entry.pricing) {
    return { ...entry.pricing };
  }
  if (
    Number.isFinite(entry.costPerMillionInputTokensUsd)
    && Number.isFinite(entry.costPerMillionOutputTokensUsd)
    && (entry.costPerMillionInputTokensUsd > 0 || entry.costPerMillionOutputTokensUsd > 0)
  ) {
    return {
      inputCostPerMTok: entry.costPerMillionInputTokensUsd,
      outputCostPerMTok: entry.costPerMillionOutputTokensUsd,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Evidence capture
// ---------------------------------------------------------------------------

interface EvidenceSnapshot {
  failedMutationToolCalls: number;
  testExecutionPassed: boolean;
  structuredMutationToolCalls: number;
  applyPatchCalls: number;
  mutationToolNames: string[];
}

function createEvidenceRecorder(): {
  onEvent: (event: unknown) => void;
  snapshot: () => EvidenceSnapshot;
} {
  let failedMutationToolCalls = 0;
  let structuredMutationToolCalls = 0;
  let testExecutionPassed = false;
  let applyPatchCalls = 0;
  const mutationToolNames = new Set<string>();

  return {
    onEvent: (event: unknown) => {
      const e = event as { type?: string; toolName?: string; isError?: boolean; result?: { details?: { exitCode?: number; command?: string } } };
      if (e?.type === 'tool_execution_end' && e.isError && e.toolName && MUTATION_EVIDENCE_TOOLS.has(e.toolName)) failedMutationToolCalls++;
      if (e?.type !== 'tool_execution_end' || typeof e.toolName !== 'string' || e.isError) {
        return;
      }
      if (e.toolName === 'run_tests' && e.result?.details?.exitCode === 0 && e.result.details.command === 'node --test tests/canary.test.ts') testExecutionPassed = true;
      if (!MUTATION_EVIDENCE_TOOLS.has(e.toolName)) {
        return;
      }
      structuredMutationToolCalls += 1;
      mutationToolNames.add(e.toolName);
      if (e.toolName === 'apply_patch') {
        applyPatchCalls += 1;
      }
    },
    snapshot: () => ({
      failedMutationToolCalls,
      structuredMutationToolCalls,
      testExecutionPassed,
      applyPatchCalls,
      mutationToolNames: [...mutationToolNames].sort(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

function classifyProviderOutcome(result: LoopResult): AttemptOutcome | undefined {
  const errorMessage = result.providerError?.errorMessage ?? finalProviderErrorMessage(result);
  if (!errorMessage && result.stopReason !== 'error') {
    return undefined;
  }
  const message = errorMessage || 'provider returned an error without a message';
  const kind = result.providerError?.kind ?? classifyProviderError(message).kind;
  const reason: LiveCodingCanaryFailureReason =
    kind === 'provider-config-error' || kind === 'provider-credit-exhausted'
      ? 'provider_config_error'
      : 'provider_transient_error';
  return { status: 'inconclusive', reason, detail: message };
}

/**
 * The canary's certification policy per budget kind (keyed on the one budget
 * definition, HOK-3362). Wall-clock expiry can be provider slowness, so it is
 * inconclusive and retryable; every other exhausted budget fails the canary.
 */
const CANARY_BUDGET_OUTCOMES: Readonly<Record<BudgetKind, AttemptOutcome>> = Object.freeze({
  model_time: {
    status: 'inconclusive',
    reason: 'budget_exceeded',
    // The artifact field keeps its identity-hashed `wall_clock` spelling.
    limitExceeded: 'wall_clock',
    detail: 'canary model-time limit fired before completion',
  },
  turn: { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'turns', detail: 'canary turn limit fired before completion' },
  token: { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'tokens', detail: 'canary token limit fired before completion' },
  tool_call: { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'tool_calls', detail: 'canary tool-call budget fired (tool_call_limit)' },
  cost: { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'cost', detail: 'canary cost limit fired before completion' },
});

function classifyBudgetOutcome(stopReason: LoopStopReason): AttemptOutcome | undefined {
  const kind = budgetKindForStopReason(stopReason);
  return kind ? { ...CANARY_BUDGET_OUTCOMES[kind] } : undefined;
}

/** Stagnation and aborts: read after provider errors, as before HOK-3362. */
function classifyNonBudgetStopOutcome(stopReason: LoopStopReason): AttemptOutcome | undefined {
  if (stopReason === 'tool_stagnation') {
    return { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'tool_calls', detail: 'canary tool-call budget fired (tool_stagnation)' };
  }
  if (stopReason === 'aborted') {
    return { status: 'inconclusive', reason: 'internal_error', detail: 'canary run was aborted' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Repository verification
// ---------------------------------------------------------------------------

function verifyCanaryRepository(
  workspace: CanaryWorkspace,
  events: EvidenceSnapshot,
): AttemptOutcome {
  const expectedSentinelHash = sha256(CANARY_SENTINEL_EXPECTED);

  let actualSentinel: string | undefined;
  try {
    actualSentinel = readFileSync(join(workspace.repoDir, CANARY_SENTINEL_PATH), 'utf-8');
  } catch {
    actualSentinel = undefined;
  }

  const changedPaths = collectChangedPaths(workspace.repoDir);
  const completion = inspectCompletionArtifact(workspace.repoDir);

  const evidence: LiveCodingCanaryEvidence = {
    failedMutationToolCalls: events.failedMutationToolCalls,
    structuredMutationToolCalls: events.structuredMutationToolCalls,
    mutationToolNames: events.mutationToolNames,
    expectedSentinelHash,
    ...(actualSentinel !== undefined ? { actualSentinelHash: sha256(actualSentinel) } : {}),
    changedPaths: changedPaths.slice(0, MAX_EVIDENCE_PATHS),
    completionArtifactPresent: completion.present && completion.valid,
    ...(completion.hash ? { completionArtifactHash: completion.hash } : {}),
  };

  // 1. Structured protocol evidence: at least one real apply_patch tool event.
  //    Textual `[apply_patch ...]` prose never produces a tool event, so a
  //    prose-only run lands here regardless of what the text claimed.
  if (events.applyPatchCalls === 0) {
    return {
      status: 'fail',
      reason: 'protocol_failure',
      detail: 'no structured apply_patch tool call was executed (assistant text is not tool use)',
      evidence,
    };
  }

  // 2. Exact mutation: sentinel must equal the expected bytes.
  if (actualSentinel !== CANARY_SENTINEL_EXPECTED) {
    return {
      status: 'fail',
      reason: 'wrong_mutation',
      detail: `sentinel ${CANARY_SENTINEL_PATH} does not match the expected content`,
      evidence,
    };
  }

  // 3. Scope: no repository changes beyond sentinel + completion artifact.
  const unexpected = changedPaths.filter(
    (path) => path !== CANARY_SENTINEL_PATH && path !== CANARY_COMPLETION_PATH && !(workspace.profile !== 'standard' && path === 'src/payload.ts'),
  );
  if (unexpected.length > 0) {
    return {
      status: 'fail',
      reason: 'extra_repository_change',
      detail: `out-of-scope repository changes: ${unexpected.slice(0, 5).join(', ')}`,
      evidence,
    };
  }

  // 4. Completion artifact: present and valid per the production normalizer.
  if (!completion.present || !completion.valid) {
    return {
      status: 'fail',
      reason: 'missing_completion_artifact',
      detail: completion.present
        ? `completion artifact ${CANARY_COMPLETION_PATH} failed completion-normalizer validation`
        : `completion artifact ${CANARY_COMPLETION_PATH} was not created`,
      evidence,
    };
  }

  if (workspace.profile !== 'standard' && (!events.testExecutionPassed || readFileSync(join(workspace.repoDir, 'src/payload.ts'), 'utf8').includes('"pending"'))) {
    return { status: 'fail', reason: 'protocol_failure', detail: 'Paired workflow requires escaped multi-file edits and a passing focused test execution.', evidence };
  }
  return { status: 'pass', evidence };
}

function collectChangedPaths(repoDir: string): string[] {
  const output = execFileSync('git', ['status', '--porcelain', '-uall'], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return output
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      // Porcelain v1: `XY <path>` (renames use `old -> new`; keep the new path).
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      return (arrow >= 0 ? path.slice(arrow + 4) : path).replace(/^"|"$/g, '');
    })
    .sort();
}

function inspectCompletionArtifact(repoDir: string): { present: boolean; valid: boolean; hash?: string } {
  const path = join(repoDir, CANARY_COMPLETION_PATH);
  if (!existsSync(path)) {
    return { present: false, valid: false };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { present: true, valid: false };
  }
  const normalized = normalizeCodingCompleteContent(raw);
  if (!normalized.ok) {
    return { present: true, valid: false, hash: sha256(raw) };
  }
  return { present: true, valid: true, hash: sha256(normalized.canonicalContent) };
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function finalizeResult(input: AttemptOutcome & {
  isLive: boolean;
  limits: LiveCodingCanaryLimits;
  options: RunLiveCodingCanaryOptions;
  now: () => Date;
  attempts: number;
}): LiveCodingCanaryResult {
  const { options } = input;
  return {
    ...(options.subject.endpoint ? { endpoint: options.subject.endpoint } : {}),
    ...(input.attemptEvidence ? { attemptEvidence: input.attemptEvidence } : {}),
    scenarioId: LIVE_CODING_CANARY_SCENARIO_ID,
    status: input.status,
    isLive: input.isLive,
    phase: 'coding',
    provider: options.subject.providerId,
    model: options.subject.providerModelId,
    providerNativeId: options.subject.providerNativeId,
    identityFingerprint: options.subject.identityFingerprint,
    catalogHash: options.subject.catalogHash,
    suiteVersion: options.suiteVersion,
    ranAt: input.now().toISOString(),
    limits: input.limits,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.limitExceeded ? { limitExceeded: input.limitExceeded } : {}),
    ...(input.detail ? { detail: sanitizeDetail(input.detail) } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.attempts > 0 ? { attempts: input.attempts } : {}),
  };
}

/**
 * Content-minimize a diagnostic string for persistence: redact secret-shaped
 * values, strip temp paths, and cap the length. Never carries raw prompts or
 * provider transcripts.
 */
function sanitizeDetail(detail: string | undefined, tmpRoot?: string): string | undefined {
  if (!detail) return undefined;
  let text = redactSecrets(detail).text;
  if (tmpRoot) {
    text = text.split(tmpRoot).join('<canary-tmp>');
  }
  // Drop any residual absolute paths — evidence must stay machine-portable.
  text = text.replace(/(?:\/[\w.-]+){2,}/g, '<path>');
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
