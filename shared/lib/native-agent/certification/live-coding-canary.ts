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
import { createHash } from 'node:crypto';
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
import type { ModelRegistry, NativeProviderName } from '../../model-registry.ts';
import type { ModelPricing } from '../../workflow-cost.ts';
import { getNativeAgentConfig } from '../../config.ts';
import { resolveEnvValue } from '../../env-file.ts';
import { runWavemillLoop, type LoopResult, type WavemillLoopConfig } from '../loop.ts';
import { createNativeModelsCollection } from '../models.ts';
import type { AgentContext, LoopStopReason } from '../loop.ts';
import type { AgentMessage, AgentTurn, Message } from '../messages.ts';
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
  const isLive = !options.runLoopFn && !options.modelOverride;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

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
  while (attempt < maxAttempts) {
    attempt += 1;
    last = await runSingleCanaryAttempt({
      options,
      model: model.model,
      authEnv: model.authEnv,
      limits,
      now,
    });
    const transient = last.status === 'inconclusive' && last.reason === 'provider_transient_error';
    if (!transient) {
      break;
    }
  }

  return finalizeResult({
    ...last!,
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

  try {
    let workspace: CanaryWorkspace;
    try {
      workspace = createCanaryWorkspace(options.tmpRootOverride);
      tmpRoot = workspace.tmpRoot;
    } catch (error) {
      return {
        status: 'inconclusive',
        reason: 'internal_error',
        detail: sanitizeDetail(`canary workspace setup failed: ${(error as Error).message}`, tmpRoot),
      };
    }

    const evidenceRecorder = createEvidenceRecorder();
    const descriptors: ToolDescriptor[] = [
      ...createReadOnlyTools(workspace.repoDir),
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
        content: buildCanaryUserPrompt(),
        timestamp: 0,
      }],
      tools: descriptors.map((descriptor) => toPiAgentTool(descriptor) as AgentTool<unknown, unknown>),
    };

    const pricing = resolveModelPricing(options);
    let result: LoopResult;
    try {
      result = await runLoopFn({
        model: input.model,
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
        budget: {
          maxTurns: limits.maxTurns,
          maxToolCalls: limits.maxToolCalls,
          maxWallClockMs: limits.maxWallClockMs,
          maxTotalTokens: limits.maxTotalTokens,
          ...(limits.maxCostUsd !== undefined && pricing ? { maxCostUsd: limits.maxCostUsd } : {}),
        },
        ...(pricing ? { modelPricing: pricing } : {}),
        maxTokens: 4096,
        signal: options.signal,
        providerErrorRetry: { maxAttempts: 2 },
        onEvent: evidenceRecorder.onEvent,
      });
    } catch (error) {
      const classification = classifyProviderError((error as Error).message ?? String(error));
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

    const providerOutcome = classifyProviderOutcome(result);
    if (providerOutcome) {
      return { ...providerOutcome, detail: sanitizeDetail(providerOutcome.detail, tmpRoot), usage };
    }

    const budgetOutcome = classifyBudgetOutcome(result.stopReason);
    if (budgetOutcome) {
      return { ...budgetOutcome, usage };
    }

    const verification = verifyCanaryRepository(workspace, evidenceRecorder.snapshot());
    return { ...verification, usage };
  } finally {
    process.removeListener('exit', removeOnExit);
    removeOnExit();
  }
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

interface CanaryWorkspace {
  /** mkdtemp root owning all attempt state. */
  tmpRoot: string;
  /** Disposable git repository the model mutates. */
  repoDir: string;
  /** update_status sink outside the git repository. */
  statusPath: string;
}

function createCanaryWorkspace(tmpRootOverride?: string): CanaryWorkspace {
  const base = tmpRootOverride ?? realpathSync(tmpdir());
  const tmpRoot = mkdtempSync(join(base, CANARY_TMP_PREFIX));
  const repoDir = join(tmpRoot, 'repo');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, CANARY_SENTINEL_PATH), CANARY_SENTINEL_INITIAL, 'utf-8');

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

  return { tmpRoot, repoDir, statusPath: join(tmpRoot, 'status.json') };
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

function buildCanaryUserPrompt(): string {
  return [
    'Certification canary task. Perform exactly these two steps, then stop:',
    '',
    `1. Use the apply_patch tool to edit ${CANARY_SENTINEL_PATH} so its full content becomes exactly:`,
    '',
    CANARY_SENTINEL_EXPECTED.trimEnd(),
    '',
    `   (The file currently contains: ${CANARY_SENTINEL_INITIAL.trimEnd()})`,
    '',
    `2. Use the create_marker tool to create ${CANARY_COMPLETION_PATH} with this exact content:`,
    '',
    '{"stage":"coding","confidence":"high"}',
    '',
    'Do not create, modify, or delete any other file. Do not run any other commands.',
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
    : buildOpenRouterModel({ modelId: options.registryModelId, ...(baseUrl ? { baseUrl } : {}), headers });

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
  structuredMutationToolCalls: number;
  applyPatchCalls: number;
  mutationToolNames: string[];
}

function createEvidenceRecorder(): {
  onEvent: (event: unknown) => void;
  snapshot: () => EvidenceSnapshot;
} {
  let structuredMutationToolCalls = 0;
  let applyPatchCalls = 0;
  const mutationToolNames = new Set<string>();

  return {
    onEvent: (event: unknown) => {
      const e = event as { type?: string; toolName?: string; isError?: boolean };
      if (e?.type !== 'tool_execution_end' || typeof e.toolName !== 'string' || e.isError) {
        return;
      }
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
      structuredMutationToolCalls,
      applyPatchCalls,
      mutationToolNames: [...mutationToolNames].sort(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

function classifyProviderOutcome(result: LoopResult): AttemptOutcome | undefined {
  const errorMessage = result.providerError?.errorMessage ?? findFinalAssistantErrorMessage(result.messages);
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

function classifyBudgetOutcome(stopReason: LoopStopReason): AttemptOutcome | undefined {
  switch (stopReason) {
    case 'wall_clock_limit':
      // Wall-clock expiry can be provider slowness — inconclusive, retryable.
      return {
        status: 'inconclusive',
        reason: 'budget_exceeded',
        limitExceeded: 'wall_clock',
        detail: 'canary wall-clock limit fired before completion',
      };
    case 'turn_limit':
      return { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'turns', detail: 'canary turn limit fired before completion' };
    case 'token_limit':
      return { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'tokens', detail: 'canary token limit fired before completion' };
    case 'tool_call_limit':
    case 'tool_stagnation':
      return { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'tool_calls', detail: `canary tool-call budget fired (${stopReason})` };
    case 'cost_limit':
      return { status: 'fail', reason: 'budget_exceeded', limitExceeded: 'cost', detail: 'canary cost limit fired before completion' };
    case 'aborted':
      return { status: 'inconclusive', reason: 'internal_error', detail: 'canary run was aborted' };
    default:
      return undefined;
  }
}

function findFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') continue;
    const errorMessage = (message as AgentTurn).errorMessage?.trim();
    if (errorMessage) return errorMessage;
  }
  return '';
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
    (path) => path !== CANARY_SENTINEL_PATH && path !== CANARY_COMPLETION_PATH,
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
