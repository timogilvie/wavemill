import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage, Message } from './messages.ts';
import type { AgentContext, LoopStopReason, WavemillLoopConfig } from './loop.ts';
import { runWavemillLoop } from './loop.ts';
import {
  ContextExhaustedError,
  ContextWindowExceededError,
  ContextWindowUnverifiableError,
} from './context-window-guard.ts';
import { REVIEW_MAX_OUTPUT_TOKENS } from './output-limits.ts';
import { classifyProviderError, type ProviderErrorKind } from './provider-error-classifier.ts';
import {
  assertOpenRouterBalanceSufficient,
  capOpenRouterMaxTokensForBalance,
} from './openrouter-credits-guard.ts';
import { TranscriptWriter, type TranscriptEvent, type TranscriptToolResult } from './transcript.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createGitTools, gitAfterToolCall, gitToolPolicyConfig } from './tools/git.ts';
import { createToolRegistry } from './tools/registry.ts';
import type { ToolDescriptor } from './tools/types.ts';
import {
  createLaunchMenuProvider,
  formatMenuDenials,
} from './tools/menu-resolver.ts';
import { inferCertificationSnapshotForPhase } from './tools/certification-snapshot.ts';
import { loadWavemillConfig } from '../config.ts';
import { renderNativePhasePrompt, type NativePhasePromptOptions } from './prompts.ts';
import type { ReviewContext } from '../review-context-gatherer.ts';
import { logPromptUsage } from '../prompt-registry.ts';
import { recordUse } from '../resource-manifest.ts';
import { registerNativeRuntime } from '../resource-adapters/native-runtime-adapter.ts';
import type { ReviewEngineOptions, ReviewFinding, ReviewResult } from '../review-engine.ts';
import {
  fillReviewPromptTemplate,
  parseNativeReviewResponse,
} from '../review-engine.ts';
import { loadPromptResourceSync } from '../resource-retrieval.ts';
import { createCleanupTracker, runCleanup, type CleanupReason } from './cleanup.ts';
import {
  STAGE_FAILURE_ENVELOPE_SCHEMA_VERSION,
  deleteStageFailureEnvelope,
  writeStageFailureEnvelope,
  type StageFailureCause,
  type StageFailureEnvelope,
} from './stage-failure-envelope.ts';
import {
  NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
  NATIVE_REVIEW_TIMEOUT_CATEGORY,
  PROVIDER_CREDIT_EXHAUSTED_CATEGORY,
  updateStageResult,
} from '../stage-result.ts';
import { getNativeContextManagementConfig, getNativeReviewTimeoutConfig } from '../config.ts';
import type { NormalizedPricing } from '../openrouter-catalog.ts';
import {
  buildExecutedIdentity,
  type ExecutedIdentity,
} from '../challenge-execution-contract.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_REVIEW_PHASE_PROMPT_PATH = resolve(
  __dirname,
  '../../../tools/prompts/native-read-only-phase.md',
);
const REVIEW_ANALYSIS_TURN_LIMIT = 10;
const REVIEW_TOOL_CALL_LIMIT = 30;
const REVIEW_FINAL_SYNTHESIS_PROMPT = [
  'Stop investigating. This is your reserved terminal synthesis turn.',
  'Using only the evidence already gathered, return the required review JSON now.',
  'Do not call tools, narrate your process, or wrap the JSON in Markdown.',
].join(' ');

export interface DeniedToolRecord {
  tool: string;
  reason: string;
  message: string;
}

interface SelectedProviderSuccess {
  ok: true;
  entry: ReadyNativeProviderEntry;
  /** Populated only when a specific analysis model was requested (challenge pinning). */
  requestedModel?: string;
  /** Set when the requested model could not be selected and a fallback ran instead. */
  fallbackReason?: string;
}

interface SelectedProviderFailure {
  ok: false;
  message: string;
}

type SelectedProvider = SelectedProviderSuccess | SelectedProviderFailure;

/**
 * Normalize a requested model selector down to the bare model id and an
 * optional provider hint, tolerating the `provider/model`,
 * `native-provider/model`, and bare `model` forms observed across challenge
 * routing and agent-identifier strings.
 */
function parseRequestedNativeModel(requested: string): { providerName?: string; modelId: string } {
  const trimmed = requested.trim();
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0) {
    return { modelId: trimmed };
  }
  const rawProvider = trimmed.slice(0, separatorIndex);
  const modelId = trimmed.slice(separatorIndex + 1);
  const providerName = rawProvider.startsWith('native-') ? rawProvider.slice('native-'.length) : rawProvider;
  return { providerName: providerName || undefined, modelId };
}

function matchesRequestedModel(
  entry: ReadyNativeProviderEntry,
  requested: { providerName?: string; modelId: string },
): boolean {
  if (entry.modelId !== requested.modelId) return false;
  if (requested.providerName && requested.providerName !== entry.providerName) return false;
  return true;
}

function nativeReviewFailure(
  context: ReviewContext,
  category: string,
  description: string,
  deniedTools: DeniedToolRecord[] = [],
  substantiveAnalysisIdentity?: ExecutedIdentity,
): ReviewResult {
  const blocker: ReviewFinding = {
    severity: 'blocker',
    location: 'native-runtime',
    category,
    description,
  };

  return {
    verdict: 'not_ready',
    codeReviewFindings: [blocker],
    failureCategory: category,
    ...(substantiveAnalysisIdentity ? { substantiveAnalysisIdentity } : {}),
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: false,
      deniedTools,
    },
  };
}

function nativeReviewNoEvidenceFailure(
  context: ReviewContext,
  category: string,
  description: string,
  deniedTools: DeniedToolRecord[] = [],
  substantiveAnalysisIdentity?: ExecutedIdentity,
  metadata: Partial<NonNullable<ReviewResult['metadata']>> = {},
): ReviewResult {
  return {
    verdict: 'error',
    codeReviewFindings: [],
    failureCategory: category,
    reviewToolError: description,
    ...(substantiveAnalysisIdentity ? { substantiveAnalysisIdentity } : {}),
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: false,
      deniedTools,
      ...metadata,
    },
  };
}

function buildReviewToolRegistry(worktreePath: string) {
  const descriptors: ToolDescriptor[] = [
    ...createReadOnlyTools(worktreePath),
    ...createGitTools(worktreePath),
  ];
  const registry = createToolRegistry(descriptors);
  const phase = 'review' as const;
  const phaseTools = registry.getTools({ phase });
  return {
    registry,
    descriptors,
    phaseTools,
    phaseMetadata: registry.list({ phase }),
  };
}

function loadNativeReviewPrompt(
  repoDir: string,
  options: NativePhasePromptOptions = {},
): { content: string; promptRef: ReturnType<typeof logPromptUsage> } {
  const template = readFileSync(NATIVE_REVIEW_PHASE_PROMPT_PATH, 'utf-8');
  // Log the unrendered template so the prompt hash tracks the template version
  // rather than the per-phase tool list rendered into it.
  const promptRef = logPromptUsage(NATIVE_REVIEW_PHASE_PROMPT_PATH, template, { dir: repoDir });
  return { content: renderNativePhasePrompt(template, options), promptRef };
}

function makeTranscriptPath(repoDir: string, sessionId: string): string {
  const runId = process.env.WAVEMILL_SESSION || 'manual-review';
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(repoDir, '.wavemill', 'runs', runId, 'native-sessions');
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `${sessionId}.jsonl`);
}

function makeSessionId(branch: string): string {
  const session = process.env.WAVEMILL_SESSION || 'manual-review';
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${session}-review-${safeBranch}`;
}

function registerNativeReviewRuntime(input: {
  repoDir: string;
  provider: ReadyNativeProviderEntry;
  tools: readonly { name: string; class: string }[];
  promptRef: ReturnType<typeof logPromptUsage>;
}): void {
  const refs = registerNativeRuntime({
    phase: 'review',
    provider: input.provider.providerName,
    model: input.provider.modelId,
    api: String(input.provider.model.api),
    tools: input.tools,
    promptRef: input.promptRef ?? undefined,
    repoDir: input.repoDir,
  });

  const sessionId = process.env.WAVEMILL_SESSION;
  if (!sessionId) {
    return;
  }

  if (input.promptRef) {
    recordUse(sessionId, 'review', input.promptRef, input.repoDir);
  }
  if (refs.runtime) {
    recordUse(sessionId, 'review', refs.runtime, input.repoDir);
  }
  if (refs.toolSet) {
    recordUse(sessionId, 'review', refs.toolSet, input.repoDir);
  }
}

function normalizedPricingFromModel(model: WavemillLoopConfig['model']): NormalizedPricing {
  const cost = (model as { cost?: { input?: unknown; output?: unknown } }).cost;
  const inputPerMTok = typeof cost?.input === 'number' && Number.isFinite(cost.input) && cost.input > 0
    ? cost.input
    : null;
  const outputPerMTok = typeof cost?.output === 'number' && Number.isFinite(cost.output) && cost.output > 0
    ? cost.output
    : null;
  return { inputPerMTok, outputPerMTok };
}

/**
 * Select the native provider entry that performs substantive review
 * analysis.
 *
 * When `requestedModel` is given (a reviewer-stage challenge pins the exact
 * analysis model under test), the exact ready entry matching it is selected.
 * If that model is not among the ready entries, this falls back to the first
 * ready entry as before — availability must not regress — but the caller
 * records the fallback so the executed identity comes back unpinned rather
 * than silently normalized (HOK-2969): a challenge cannot prove which model
 * analyzed the diff when the wrong model ran instead.
 */
function selectReviewProvider(
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env,
  requestedModel?: string,
): SelectedProvider {
  const providers = resolveNativeAgentProviders(repoDir, { env, phase: 'review' });
  const readyEntries = providers.filter(
    (entry): entry is ReadyNativeProviderEntry => entry.status === 'ready',
  );

  if (requestedModel) {
    const parsed = parseRequestedNativeModel(requestedModel);
    const exactMatch = readyEntries.find((entry) => matchesRequestedModel(entry, parsed));
    if (exactMatch) {
      return { ok: true, entry: exactMatch, requestedModel };
    }
  }

  const readyEntry = readyEntries[0];
  if (readyEntry) {
    return {
      ok: true,
      entry: readyEntry,
      ...(requestedModel ? { requestedModel, fallbackReason: 'requested_model_unavailable' } : {}),
    };
  }

  return {
    ok: false,
    message: buildNativeProviderResolutionFailureMessage('review', providers),
  };
}

function extractFinalAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    return message.content
      .filter((block): block is Extract<typeof message.content[number], { type: 'text'; text: string }> => (
        typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string'
      ))
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function extractFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }
    const errorMessage = (message as { errorMessage?: string }).errorMessage?.trim();
    if (errorMessage) {
      return errorMessage;
    }
  }
  return '';
}

function extractDeniedTools(events: TranscriptEvent[]): DeniedToolRecord[] {
  return events
    .filter((event): event is TranscriptToolResult => event.type === 'tool_result')
    .filter((event) => event.isError && typeof event.content === 'string')
    .map((event) => {
      if (event.content.startsWith('phase_denied:')) {
        return {
          tool: event.toolName,
          reason: 'phase_denied',
          message: event.content,
        };
      }
      if (event.content.startsWith('path_denied:')) {
        return {
          tool: event.toolName,
          reason: 'path_denied',
          message: event.content,
        };
      }
      return null;
    })
    .filter((entry): entry is DeniedToolRecord => entry !== null);
}

function stopReasonDescription(stopReason: LoopStopReason): string {
  switch (stopReason) {
    case 'turn_limit':
      return 'Native review hit its iteration limit before producing a final JSON result.';
    case 'token_limit':
      return 'Native review exhausted its token budget before producing a final JSON result.';
    case 'tool_call_limit':
      return 'Native review exhausted its tool-call budget before producing a final JSON result.';
    case 'wall_clock_limit':
      return 'Native review exceeded its wall-clock budget before producing a final JSON result.';
    case 'aborted':
      return 'Native review was aborted before producing a final JSON result.';
    case 'error':
      return 'Native review failed before producing a final JSON result.';
    default:
      return `Native review stopped with "${stopReason}" before producing a final JSON result.`;
  }
}

/**
 * Map a classified provider error to the canonical review failure taxonomy
 * (HOK-2964). Only typed context-window and billing/credit conditions get a
 * dedicated infrastructure category; every other provider error kind keeps
 * the generic `native-review-failed` category so it is not mistaken for a
 * bounded-recoverable condition.
 */
function reviewFailureCategoryForProviderErrorKind(kind: ProviderErrorKind | undefined): string {
  switch (kind) {
    case 'context-window-exceeded':
      return NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY;
    case 'provider-credit-exhausted':
      return PROVIDER_CREDIT_EXHAUSTED_CATEGORY;
    default:
      return 'native-review-failed';
  }
}

function reviewFailureCategoryForStopReason(stopReason: LoopStopReason): string {
  switch (stopReason) {
    case 'wall_clock_limit':
    case 'turn_limit':
    case 'tool_call_limit':
    case 'token_limit':
      return NATIVE_REVIEW_TIMEOUT_CATEGORY;
    default:
      return 'native-review-failed';
  }
}

/**
 * Map a terminal loop stop reason (plus any classified provider error kind) to
 * the typed native stage-failure cause (HOK-3064). Budget exhaustion of any
 * kind (wall-clock, turn, tool-call, token) is a `stage-timeout`; an explicit
 * abort is `cancelled`; a provider error carries its classified sub-kind. An
 * `error` stop with no classifiable provider kind stays `unknown` so it is
 * excluded from quality signals while remaining visible via bounded evidence.
 */
function stageFailureCauseForStopReason(
  stopReason: LoopStopReason,
  providerErrorKind: ProviderErrorKind | undefined,
): StageFailureCause {
  switch (stopReason) {
    case 'wall_clock_limit':
    case 'turn_limit':
    case 'tool_call_limit':
    case 'token_limit':
      return 'stage-timeout';
    case 'aborted':
      return 'cancelled';
    default:
      break;
  }
  switch (providerErrorKind) {
    case 'provider-transient-error':
      return 'provider-outage';
    case 'provider-credit-exhausted':
      return 'provider-credit-exhausted';
    case 'provider-config-error':
      return 'provider-config-error';
    case 'context-window-exceeded':
      return 'context-window-exceeded';
    default:
      return 'unknown';
  }
}

function cleanupReasonForStopReason(stopReason: LoopStopReason): CleanupReason | null {
  if (stopReason === 'aborted') {
    return 'aborted';
  }
  if (stopReason === 'wall_clock_limit') {
    return 'timeout';
  }
  return null;
}

function readRecoveryTimeout(featureDir?: string): { attempt?: number; timeoutMs?: number } {
  if (!featureDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(featureDir, '.review-infra-recovery.json'), 'utf-8')) as {
      nativeTimeoutAttempt?: unknown;
      attempt?: unknown;
      effectiveNativeTimeoutMs?: unknown;
      timeoutMs?: unknown;
    };
    const raw = parsed.nativeTimeoutAttempt ?? parsed.attempt;
    const timeout = parsed.effectiveNativeTimeoutMs ?? parsed.timeoutMs;
    return {
      ...(Number.isInteger(raw) && (raw as number) >= 0 ? { attempt: raw as number } : {}),
      ...(Number.isInteger(timeout) && (timeout as number) > 0 ? { timeoutMs: timeout as number } : {}),
    };
  } catch {
    return {};
  }
}

function reviewInputMetadata(context: ReviewContext): Pick<NonNullable<ReviewResult['metadata']>,
  'reviewInputDiffBytes' | 'reviewInputTaskPacketBytes' | 'reviewInputFileCount'
> {
  return {
    reviewInputDiffBytes: Buffer.byteLength(context.diff ?? '', 'utf8'),
    reviewInputTaskPacketBytes: Buffer.byteLength(context.taskPacket ?? '', 'utf8'),
    reviewInputFileCount: context.metadata.files.length,
  };
}

const nativeReviewDeps = {
  extractDeniedTools,
  extractFinalAssistantText,
  getNativeProviderApiKey,
  loadNativeReviewPrompt,
  registerNativeReviewRuntime,
  runWavemillLoop,
  selectReviewProvider,
};

export async function runNativeReview(
  context: ReviewContext,
  repoDir: string,
  options: ReviewEngineOptions = {},
): Promise<ReviewResult> {
  const requestedAnalysisModel = options.model?.trim() || undefined;
  const provider = nativeReviewDeps.selectReviewProvider(repoDir, process.env, requestedAnalysisModel);
  if (!provider.ok) {
    return nativeReviewFailure(context, 'native-runtime-unavailable', provider.message);
  }

  // `resolvedModel` must stay in the same bare-model-id namespace as
  // `requestedModel` (challenge routing emits bare ids like "glm-5.3", never
  // the "provider/model" canonical form) — comparing against the canonical
  // form would report a mismatch on every exact match (HOK-2969).
  const resolvedModelId = provider.entry.modelId;
  const recoveryTimeout = readRecoveryTimeout(options.featureDir);
  const timeoutAttempt = options.nativeTimeoutAttempt ?? recoveryTimeout.attempt;
  const timeoutConfig = getNativeReviewTimeoutConfig(
    repoDir,
    requestedAnalysisModel ?? resolvedModelId,
    timeoutAttempt ?? 0,
  );
  const effectiveNativeTimeoutMs = options.timeout ?? recoveryTimeout.timeoutMs ?? timeoutConfig.timeoutMs;
  // Canonical execution identity (HOK-3064): one OpenRouter review must not
  // split between `native` and `native-openrouter` across intent, stage result,
  // eval, abort marker, and health state. The stage result's top-level `agent`
  // stays `native` for backward compatibility with recovery readers; the
  // canonical identity travels on the artifacts + the failure envelope, which
  // is what challenge selection-health consumes.
  const canonicalProvider = provider.entry.providerName;
  const canonicalModel = provider.entry.modelId;
  const canonicalAgent = `native-${provider.entry.providerName}`;
  const nativeReviewMetadata = {
    effectiveNativeTimeoutMs,
    nativeTimeoutAttempt: timeoutConfig.attempt,
    nativeTimeoutBaseMs: timeoutConfig.baseTimeoutMs,
    nativeTimeoutMaxMs: timeoutConfig.maxMs,
    nativeTimeoutMultiplier: timeoutConfig.multiplier,
    reviewProvider: canonicalProvider,
    reviewAgent: canonicalAgent,
    ...reviewInputMetadata(context),
  };
  const substantiveAnalysisIdentity = buildExecutedIdentity({
    role: 'substantive_analysis',
    requestedModel: provider.requestedModel,
    resolvedModel: resolvedModelId,
    agent: `native-${provider.entry.providerName}`,
    source: provider.requestedModel ? 'route' : 'derived',
    fallbackReason: provider.fallbackReason,
  });

  const template = loadPromptResourceSync({
    kind: 'prompt',
    role: 'reviewer',
    persona: 'general',
    operatingMode: options.operatingMode ?? 'normal',
  }).content;
  if (!template) {
    return nativeReviewFailure(
      context,
      'native-review-prompt-missing',
      'Native review could not load the general review prompt template.',
      [],
      substantiveAnalysisIdentity,
    );
  }

  const userPrompt = fillReviewPromptTemplate(template, context, true);
  const { phaseMetadata, registry, descriptors: reviewDescriptors } = buildReviewToolRegistry(repoDir);
  const menuLaunchProvider = createLaunchMenuProvider({
    phase: 'review',
    config: loadWavemillConfig(repoDir),
    certification: inferCertificationSnapshotForPhase({
      phase: 'review',
      readyProviderPresent: true,
      loopModelOverridePresent: false,
    }),
    descriptors: reviewDescriptors,
  });
  if (menuLaunchProvider.initialMenu.denials.length > 0) {
    const formatted = formatMenuDenials(menuLaunchProvider.initialMenu.denials);
    if (formatted) {
      console.warn(`[native-review] menu denials:\n${formatted}`);
    }
  }
  const { content: systemPrompt, promptRef } = nativeReviewDeps.loadNativeReviewPrompt(repoDir, {
    tools: phaseMetadata,
    phase: 'review',
  });
  nativeReviewDeps.registerNativeReviewRuntime({
    repoDir,
    provider: provider.entry,
    tools: phaseMetadata,
    promptRef,
  });

  const apiKey = nativeReviewDeps.getNativeProviderApiKey(provider.entry);
  if (!apiKey) {
    return nativeReviewFailure(
      context,
      'native-runtime-unavailable',
      `${provider.entry.apiKeyEnv} resolved to an empty value for native review.`,
      [],
      substantiveAnalysisIdentity,
    );
  }

  const sessionId = makeSessionId(context.metadata.branch);
  const transcriptPath = makeTranscriptPath(repoDir, sessionId);
  const transcriptWriter = new TranscriptWriter({
    sessionId,
    model: provider.entry.modelId,
    api: String(provider.entry.model.api),
    provider: provider.entry.providerName,
    worktreePath: repoDir,
    gitBranch: context.metadata.branch,
    path: transcriptPath,
  });
  const transcriptEvents: TranscriptEvent[] = [];

  // Record the typed native stage-failure envelope for a terminal review
  // attempt (HOK-3064) as soon as the cause is known and BEFORE cleanup can
  // erase process/session context. Gated on `featureDir` (same gate as
  // `updateStageResult`); best-effort so envelope recording never masks the
  // underlying review failure. Identity comes from the already-selected
  // provider entry so the failed model/provider is not left immediately
  // reselectable under a split/unknown health key.
  const recordReviewFailureEnvelope = (
    cause: StageFailureCause,
    detail: string,
    extra: { stopReason?: string; providerErrorKind?: string } = {},
  ): void => {
    if (!options.featureDir) {
      return;
    }
    const envelope: StageFailureEnvelope = {
      schemaVersion: STAGE_FAILURE_ENVELOPE_SCHEMA_VERSION,
      stage: 'review',
      cause,
      ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
      ...(extra.providerErrorKind ? { providerErrorKind: extra.providerErrorKind } : {}),
      ...(Number.isInteger(timeoutConfig.attempt) ? { retryAttempt: timeoutConfig.attempt } : {}),
      ...(Number.isInteger(effectiveNativeTimeoutMs) ? { configuredTimeoutMs: effectiveNativeTimeoutMs } : {}),
      provider: canonicalProvider,
      model: canonicalModel,
      ...(provider.requestedModel ? { requestedModel: provider.requestedModel } : {}),
      agent: canonicalAgent,
      evidence: {
        source: 'native-runtime',
        detail,
        transcriptPath,
      },
      createdAt: new Date().toISOString(),
    };
    try {
      writeStageFailureEnvelope(options.featureDir, envelope);
    } catch {
      // Never let envelope recording fail the review failure it describes.
    }
  };

  const modelConfig: WavemillLoopConfig['model'] = {
    id: provider.entry.model.id,
    name: provider.entry.model.name,
    api: String(provider.entry.model.api),
    provider: String(provider.entry.model.provider),
    baseUrl: provider.entry.model.baseUrl,
    headers: {
      ...(provider.entry.model.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
    // model.compat is provider-specific opaque config; runtime treats it as unknown.
    compat: provider.entry.model.compat as unknown,
  };

  const loopContext: AgentContext = {
    systemPrompt,
    messages: [{
      role: 'user',
      content: userPrompt,
      timestamp: 0,
    }],
    tools: menuLaunchProvider.providerToolsForContext as unknown as AgentContext['tools'],
  };
  const pricing = normalizedPricingFromModel(modelConfig);
  const effectiveMaxTokens = modelConfig.provider === 'openrouter'
    ? capOpenRouterMaxTokensForBalance({
      requestedMaxTokens: REVIEW_MAX_OUTPUT_TOKENS,
      pricing,
      repoDir,
    }) ?? REVIEW_MAX_OUTPUT_TOKENS
    : REVIEW_MAX_OUTPUT_TOKENS;
  if (modelConfig.provider === 'openrouter') {
    assertOpenRouterBalanceSufficient({
      repoDir,
      model: modelConfig.name ?? modelConfig.id,
      pricing,
      reservedOutputTokens: effectiveMaxTokens,
    });
  }

  // Native review needs an evidence-gathering budget independent of transport
  // retry count. Keep larger explicit retry settings backward-compatible while
  // guaranteeing enough analysis turns for repository-scale reviews.
  const analysisTurnLimit = Math.max(REVIEW_ANALYSIS_TURN_LIMIT, (options.maxRetries ?? 1) + 1);
  const cleanupTracker = createCleanupTracker();
  let loopResult;
  try {
    loopResult = await nativeReviewDeps.runWavemillLoop({
      model: modelConfig,
      context: loopContext,
      maxTokens: effectiveMaxTokens,
      contextManagement: getNativeContextManagementConfig(options.repoDir),
      promptSizeLog: options.repoDir ? {
        repoDir: options.repoDir,
        stage: 'review',
        session: options.session,
        issue: options.issue,
      } : undefined,
      // AgentMessage and Message are structurally compatible at runtime; pi-agent-core
      // exports diverged nominal types so a direct cast is required.
      convertToLlm: (messages) => messages as unknown as Message[],
      afterToolCall: gitAfterToolCall,
      toolPolicy: {
        phase: 'review',
        worktreePath: repoDir,
        registry: registry.list(),
        config: {
          pathFieldsByTool: {
            ...READ_ONLY_PATH_FIELDS,
            ...gitToolPolicyConfig.pathFieldsByTool,
          },
        },
      },
      onEvent: (event) => {
        const derived = transcriptWriter.handleEvent(event);
        if (derived) {
          transcriptEvents.push(derived);
        }
      },
      menuProvider: menuLaunchProvider.menuProvider,
      budget: {
        // One additional turn is reserved for tool-free terminal synthesis.
        maxTurns: analysisTurnLimit + 1,
        maxToolCalls: REVIEW_TOOL_CALL_LIMIT,
        maxWallClockMs: effectiveNativeTimeoutMs,
      },
      terminalSynthesis: {
        prompt: REVIEW_FINAL_SYNTHESIS_PROMPT,
      },
    });
  } catch (error) {
    if (error instanceof ContextExhaustedError) {
      recordReviewFailureEnvelope('context-exhausted', error.message);
      return nativeReviewFailure(context, 'native-context-exhausted', error.message, [], substantiveAnalysisIdentity);
    }
    if (error instanceof ContextWindowExceededError || error instanceof ContextWindowUnverifiableError) {
      recordReviewFailureEnvelope('context-window-exceeded', error.message);
      return nativeReviewFailure(context, 'native-context-window-exceeded', error.message, [], substantiveAnalysisIdentity);
    }
    throw error;
  }

  const deniedTools = nativeReviewDeps.extractDeniedTools(transcriptEvents);

  // Classify the terminal cause and record the typed failure envelope BEFORE
  // cleanup runs — cleanup can erase process/session context, so the transcript
  // path and loop state must be captured first (HOK-3064). Ordering:
  // classify → write envelope → cleanup → stage result. The category/description
  // computation is preserved exactly; only the envelope write is added ahead of
  // the existing cleanup + stage-result path.
  let terminalCategory = '';
  let terminalDescription = '';
  if (loopResult.stopReason !== 'stop') {
    const providerErrorMessage = loopResult.stopReason === 'error'
      ? extractFinalAssistantErrorMessage(loopResult.messages)
      : '';
    const providerErrorKind = loopResult.providerError?.kind
      ?? (providerErrorMessage ? classifyProviderError(providerErrorMessage).kind : undefined);
    const providerDescription = providerErrorMessage
      ? `${providerErrorKind ?? 'provider-unknown-error'}: ${providerErrorMessage}`
      : '';
    terminalCategory = providerErrorKind
      ? reviewFailureCategoryForProviderErrorKind(providerErrorKind)
      : reviewFailureCategoryForStopReason(loopResult.stopReason);
    terminalDescription = providerDescription || stopReasonDescription(loopResult.stopReason);
    recordReviewFailureEnvelope(
      stageFailureCauseForStopReason(loopResult.stopReason, providerErrorKind),
      terminalDescription,
      {
        stopReason: loopResult.stopReason,
        ...(providerErrorKind ? { providerErrorKind } : {}),
      },
    );
  }

  const cleanupReason = cleanupReasonForStopReason(loopResult.stopReason);
  if (cleanupReason) {
    const cleanupReport = await runCleanup(cleanupTracker, {
      worktreePath: repoDir,
      reason: cleanupReason,
    });
    transcriptWriter.writeCleanupReport(cleanupReport);
    if (options.featureDir) {
      await updateStageResult(options.featureDir, 'review', {
        status: cleanupReason === 'aborted' ? 'aborted' : 'failed',
        finishedAt: new Date().toISOString(),
        agent: 'native',
        model: modelConfig.name ?? modelConfig.id,
        intendedModel: requestedAnalysisModel ?? modelConfig.name ?? modelConfig.id,
        executedModel: null,
        executionEvidence: {
          status: 'contradicted',
          source: 'native-runtime',
          detail: loopResult.stopReason,
          recordedAt: new Date().toISOString(),
        },
        modelAttributionEligible: false,
        modelAttributionIneligibleReason: 'execution_contradicted',
        notes: `Native review stopped with ${loopResult.stopReason}; cleanup decision ${cleanupReport.cleanupDecision}.`,
        failureReason: loopResult.stopReason,
        artifacts: {
          type: 'review',
          failureCategory: reviewFailureCategoryForStopReason(loopResult.stopReason),
          verdict: 'error',
          reviewToolError: stopReasonDescription(loopResult.stopReason),
          missingReviewEvidence: true,
          evidence: 'missing-review-verdict',
          ...nativeReviewMetadata,
        },
        finalTreeState: cleanupReport.finalTreeState,
        cleanupDecision: cleanupReport.cleanupDecision,
        cleanupReport,
      });
    }
  }

  if (loopResult.stopReason !== 'stop') {
    if (terminalCategory === NATIVE_REVIEW_TIMEOUT_CATEGORY) {
      return nativeReviewNoEvidenceFailure(
        context,
        terminalCategory,
        terminalDescription,
        deniedTools,
        substantiveAnalysisIdentity,
        {
          ...nativeReviewMetadata,
          nativeLoopStopReason: loopResult.stopReason,
        },
      );
    }
    return nativeReviewFailure(context, terminalCategory, terminalDescription, deniedTools, substantiveAnalysisIdentity);
  }

  const responseText = nativeReviewDeps.extractFinalAssistantText(loopResult.messages);
  if (responseText.trim() === '') {
    recordReviewFailureEnvelope(
      'model-protocol',
      'Native review returned an empty final assistant message.',
      { stopReason: loopResult.stopReason },
    );
    return nativeReviewFailure(
      context,
      'native-review-malformed-response',
      'Native review returned an empty final assistant message.',
      deniedTools,
      substantiveAnalysisIdentity,
    );
  }

  try {
    const result = parseNativeReviewResponse(responseText, context, options.operatingMode ?? 'normal');
    // A successful review supersedes any stale envelope from a prior terminal
    // attempt so a later success is never misread as a failure (HOK-3064).
    if (options.featureDir) {
      try {
        deleteStageFailureEnvelope(options.featureDir, 'review');
      } catch {
        // Best-effort cleanup; never fail a successful review on unlink.
      }
    }
    result.metadata = {
      ...result.metadata,
      deniedTools,
      ...nativeReviewMetadata,
    };
    result.substantiveAnalysisIdentity = substantiveAnalysisIdentity;
    return result;
  } catch (error) {
    const description = `Native review returned malformed response: ${(error as Error).message}`;
    recordReviewFailureEnvelope('model-protocol', description, { stopReason: loopResult.stopReason });
    return nativeReviewFailure(
      context,
      'native-review-malformed-response',
      description,
      deniedTools,
      substantiveAnalysisIdentity,
    );
  }
}

export const nativeReviewTestUtils = {
  buildReviewToolRegistry,
  extractDeniedTools,
  extractFinalAssistantText,
  setGetNativeProviderApiKey(fn: typeof nativeReviewDeps.getNativeProviderApiKey) {
    nativeReviewDeps.getNativeProviderApiKey = fn;
  },
  setRunWavemillLoop(fn: typeof nativeReviewDeps.runWavemillLoop) {
    nativeReviewDeps.runWavemillLoop = fn;
  },
  setSelectReviewProvider(fn: typeof nativeReviewDeps.selectReviewProvider) {
    nativeReviewDeps.selectReviewProvider = fn;
  },
  resetDeps() {
    nativeReviewDeps.extractDeniedTools = extractDeniedTools;
    nativeReviewDeps.extractFinalAssistantText = extractFinalAssistantText;
    nativeReviewDeps.getNativeProviderApiKey = getNativeProviderApiKey;
    nativeReviewDeps.loadNativeReviewPrompt = loadNativeReviewPrompt;
    nativeReviewDeps.registerNativeReviewRuntime = registerNativeReviewRuntime;
    nativeReviewDeps.runWavemillLoop = runWavemillLoop;
    nativeReviewDeps.selectReviewProvider = selectReviewProvider;
  },
};
