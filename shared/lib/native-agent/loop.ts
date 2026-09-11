import { createHash, randomUUID } from 'node:crypto';
import {
  runAgentLoopContinue,
  type AfterToolCallResult,
  type AgentContext,
  type AgentEventSink,
  type AgentLoopConfig,
  type AgentMessage,
  type AfterToolCallContext,
  type BeforeToolCallContext,
  type ShouldStopAfterTurnContext,
} from '@earendil-works/pi-agent-core';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { SessionStreamWriter, type SessionStreamWriterOptions, storeArtifact } from './session-stream.ts';

// Re-export the Pi agent context type through the loop seam so loop callers can
// construct an AgentContext without importing Pi vendor packages directly.
export type { AgentContext, AgentMessage } from '@earendil-works/pi-agent-core';
import { computeModelCost, type ModelPricing } from '../workflow-cost.ts';
import type { ModelRegistry } from '../model-registry.ts';
import { appendPromptSizeSample, type PromptSizeSample } from './prompt-size-log.ts';
import { assertToolCompat } from './tool-compat-validator.ts';
import {
  assertPromptFitsContextWindow,
  ContextExhaustedError,
  evaluateContextWindow,
  estimatePromptTokens,
  resolveContextWindowLimit,
  ContextWindowUnverifiableError,
  type ContextWindowLimit,
} from './context-window-guard.ts';
import {
  transformContext,
  type ReplayCompactionEvent,
  type ReplayCompactionOptions,
} from './compaction.ts';
import { buildTrustMetadata } from './provenance.ts';
import { computeDynamicMaxTokens, DEFAULT_MAX_OUTPUT_TOKENS } from './output-limits.ts';
import { compactTranscript } from './transcript-compactor.ts';
import { toProviderRequestModelId, type ProviderModelConfig } from './provider.ts';
import {
  classifyProviderError,
  type ProviderErrorClassification,
  type ProviderErrorKind,
} from './provider-error-classifier.ts';
import { evaluateBeforeToolCallPolicy, type ToolPolicyConfig } from './tools/policies.ts';
import { redactSecrets, redactSecretsInValue } from './tools/redaction.ts';
import { ToolStagnationTracker, type ToolStagnationPolicy } from './planning-guards.ts';
import type {
  OutputCapPolicy,
  ToolMetadata,
  ToolOutputCapMetadata,
  ToolPhase,
  ToolProvenanceMetadata,
  ToolRedactionMetadata,
  ToolResultMetadata,
} from './tools/types.ts';

const EMPTY_ASSISTANT_CONTINUATION_LIMIT = 1;
const EMPTY_ASSISTANT_CONTINUATION_PROMPT = [
  'Your previous response contained internal reasoning only and no actionable text or tool calls.',
  'Continue from that reasoning now: use the available tools or provide the required user-facing result. Do not stop until you have taken the next concrete step.',
].join('\n');
const EMPTY_MODEL_TURN_ERROR_MESSAGE =
  'empty-model-turn: model returned reasoning-only or otherwise empty assistant turns after a continuation prompt';
const DEFAULT_PROVIDER_ERROR_RETRY_DELAYS_MS = [1000, 4000, 16000] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoopBudget {
  maxTurns?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
  stagnation?: ToolStagnationPolicy;
}

export type LoopStopReason =
  | 'stop'
  | 'turn_limit'
  | 'token_limit'
  | 'tool_call_limit'
  | 'tool_stagnation'
  | 'wall_clock_limit'
  | 'cost_limit'
  | 'aborted'
  | 'error';

/**
 * Heartbeat event shape compatible with `wavemill_hook_write`.
 * Emitted via `onHeartbeat` to keep the dashboard alive during long turns.
 */
export interface HeartbeatEvent {
  state: 'working';
  event: string;
  detail?: string;
  agent: string;
}

export const HEARTBEAT_AGENT = 'native-agent';

/**
 * Session event stream configuration.
 * When provided, canonical provenance events are recorded for the session.
 */
export interface SessionStreamConfig {
  /** Session identifier. */
  sessionId: string;
  /** Request trace ID. */
  traceId: string;
  /** Phase (planning, coding, review, etc.). */
  phase: string;
  /** Absolute path to the event stream file. */
  eventStreamPath: string;
  /** Repository directory for artifact storage. */
  repoDir?: string;
  /** Optional manifest ID for this session's resources. */
  manifestId?: string;
  /** Optional initial config digest. */
  initialConfigDigest?: string;
  /** Optional prompt resource references. */
  promptRefs?: Array<{ resourceId: string; contentHash: string; version?: string }>;
  /** Optional injected context references. */
  injectedContextRefs?: Array<{ resourceId: string; contentHash: string; version?: string }>;
  /** Optional policy config digest. */
  policyConfigDigest?: string;
  /** When true, external code (launch-level) manages session start/end events. */
  externalWriterManagesSessionBoundaries?: boolean;
  /** Optional pre-created SessionStreamWriter instance to reuse (prevents duplicate seq counters). */
  writerInstance?: SessionStreamWriter;
}

export interface WavemillLoopConfig {
  model: ProviderModelConfig;
  /** Pi agent context (systemPrompt, messages, tools) for this run. */
  context: AgentContext;
  /**
   * Converts Pi AgentMessage[] to LLM-compatible Message[] before each turn.
   * Must not throw; return a safe fallback on errors.
   */
  convertToLlm: AgentLoopConfig['convertToLlm'];
  /**
   * Called after each tool call finishes. May override content/details/isError/terminate.
   * Receives the agent abort signal; must honour it.
   */
  afterToolCall?: AgentLoopConfig['afterToolCall'];
  /**
   * Called before each tool call. Return `{ block: true }` to prevent execution.
   * Epic 2 wires in real phase policy here; stub it out or omit in Epic 1.
   */
  beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  toolPolicy?: {
    phase: ToolPhase;
    config?: ToolPolicyConfig;
    worktreePath: string;
    registry: readonly ToolMetadata[];
  };
  /** Optional prior-session state; passed as AgentContext messages and is sufficient
   *  for continuation via replayed thinkingSignature / responseId metadata. */
  priorState?: { messages: AgentMessage[] };
  budget?: LoopBudget;
  /**
   * Reserve the final turn for a tool-free synthesis response. When an
   * in-progress tool turn reaches the turn or tool-call boundary, the loop
   * injects this prompt, removes all tools, and permits one last provider
   * request to produce the caller's terminal artifact.
   */
  terminalSynthesis?: {
    prompt: string;
  };
  signal?: AbortSignal;
  /**
   * Optional prompt size logging configuration. When provided, prompt sizes will be logged.
   * This is used to gather data for determining context window floors.
   */
  promptSizeLog?: {
    repoDir: string;
    stage: string;
    session?: string;
    issue?: string;
  };
  /** Invoked on Pi progress events so the dashboard sees a live agent. */
  onHeartbeat?: (event: HeartbeatEvent) => void;
  /** Optional sink for all Pi AgentEvents. Used for transcript writing and monitoring. */
  onEvent?: (event: AgentEvent) => void;
  /** Optional replay-history compaction applied only to provider context. */
  compaction?: ReplayCompactionOptions;
  /** Receives metadata for replay compaction events emitted by transformContext. */
  onCompactionEvents?: (events: ReplayCompactionEvent[]) => void;
  contextManagement?: NativeContextManagementConfig;
  /** Required when `budget.maxCostUsd` is set; used to compute turn cost. */
  modelPricing?: ModelPricing;
  /** Optional registry override for tool compatibility validation. */
  compatRegistry?: ModelRegistry;
  temperature?: number;
  /** Per-turn output ceiling. Falls back to `model.maxTokens`, then
   *  DEFAULT_MAX_OUTPUT_TOKENS; it is never sent as undefined. */
  maxTokens?: number;
  /** Optional session event stream configuration. When provided, session provenance
   *  events are recorded alongside the transcript. */
  sessionStreamConfig?: SessionStreamConfig;
  providerErrorRetry?: {
    maxAttempts?: number;
    backoffDelaysMs?: number[];
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

export interface NativeContextManagementConfig {
  compactionThreshold?: number;
  safetyMarginPct?: number;
  minRetainedToolResults?: number;
  minOutputTokens?: number;
}

interface ResolvedNativeContextManagementConfig {
  compactionThreshold: number;
  safetyMarginPct: number;
  minRetainedToolResults: number;
  minOutputTokens: number;
}

export interface LoopResult {
  messages: AgentMessage[];
  stopReason: LoopStopReason;
  turnsCompleted: number;
  toolCallsExecuted: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  wallClockMs: number;
  providerError?: {
    kind: ProviderErrorKind;
    retryable: boolean;
    attempts: number;
    errorMessage: string;
    turnsAtFailure: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + (value as unknown[]).map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const pairs = sorted.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return '{' + pairs.join(',') + '}';
}

function computeArgsFingerprint(args: unknown): string {
  const stable = stableStringify(args ?? {});
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function finalAssistantStopReason(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && typeof message.stopReason === 'string') {
      return message.stopReason;
    }
  }
  return null;
}

function finalAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

function assistantMessageCount(messages: AgentMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

function hasActionableAssistantContent(message: AssistantMessage | undefined): boolean {
  if (!message) return false;
  return message.content.some((block) => {
    if (block.type === 'text') {
      return block.text.trim().length > 0;
    }
    return block.type === 'toolCall';
  });
}

function shouldContinueEmptyAssistantTurn(messages: AgentMessage[]): boolean {
  const message = finalAssistantMessage(messages);
  return Boolean(
    message
    && message.stopReason === 'stop'
    && !hasActionableAssistantContent(message),
  );
}

function finalAssistantProviderError(messages: AgentMessage[]): {
  message: AssistantMessage;
  errorMessage: string;
  classification: ProviderErrorClassification;
} | undefined {
  const message = finalAssistantMessage(messages);
  if (!message || message.stopReason !== 'error') {
    return undefined;
  }
  const errorMessage = message.errorMessage?.trim() || 'Provider returned stopReason "error" without an errorMessage.';
  return {
    message,
    errorMessage,
    classification: classifyProviderError(errorMessage),
  };
}

function stripTrailingAssistantErrorTurn(messages: AgentMessage[], errorMessage: AssistantMessage): AgentMessage[] {
  const index = messages.lastIndexOf(errorMessage as AgentMessage);
  if (index === -1) {
    return messages.filter((message) => message !== (errorMessage as AgentMessage));
  }
  return [
    ...messages.slice(0, index),
    ...messages.slice(index + 1),
  ];
}

function providerRetryDelayMs(delays: readonly number[], attemptIndex: number): number {
  const raw = delays[Math.min(attemptIndex, Math.max(0, delays.length - 1))] ?? 0;
  if (raw <= 0) {
    return 0;
  }
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(raw * jitter);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, ms);
    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cleanup);
      resolve();
    }
    signal?.addEventListener('abort', cleanup, { once: true });
  });
}

function buildEmptyAssistantContinuationMessage(): AgentMessage {
  return {
    role: 'user',
    content: EMPTY_ASSISTANT_CONTINUATION_PROMPT,
    timestamp: Date.now(),
  } as AgentMessage;
}

function markEmptyModelTurnExhausted(messages: AgentMessage[]): void {
  const message = finalAssistantMessage(messages);
  if (!message) return;
  message.stopReason = 'error' as AssistantMessage['stopReason'];
  message.errorMessage = EMPTY_MODEL_TURN_ERROR_MESSAGE;
}

function deriveOutputCapMetadata(
  policy: OutputCapPolicy | undefined,
  redactedDetails: unknown,
): ToolOutputCapMetadata {
  const d: Record<string, unknown> =
    redactedDetails !== null &&
    redactedDetails !== undefined &&
    typeof redactedDetails === 'object' &&
    !Array.isArray(redactedDetails)
      ? (redactedDetails as Record<string, unknown>)
      : {};

  const capped = d.truncated === true;
  const result: ToolOutputCapMetadata = { capped };

  if (policy && policy.strategy !== 'none') {
    result.strategy = policy.strategy;
    if (policy.maxBytes !== undefined) {
      result.limit = policy.maxBytes;
      result.limitKind = 'bytes';
      if (typeof d.originalBytes === 'number') result.originalLength = d.originalBytes;
      if (typeof d.retainedBytes === 'number') result.retainedLength = d.retainedBytes;
    } else if (policy.maxItems !== undefined) {
      result.limit = policy.maxItems;
      result.limitKind = 'items';
      if (typeof d.totalLines === 'number') result.originalLength = d.totalLines;
      if (typeof d.returnedLines === 'number') result.retainedLength = d.returnedLines;
    }
  }

  return result;
}

/**
 * Resolve the per-turn output ceiling for a loop run. Never returns undefined:
 * an unset ceiling makes Pi omit `max_tokens`, which inflates the provider-side
 * credit reservation to the endpoint maximum. See ./output-limits.ts.
 */
export function resolveMaxOutputTokens(config: Pick<WavemillLoopConfig, 'maxTokens' | 'model'>): number {
  return config.maxTokens ?? config.model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

function toPiModel(config: ProviderModelConfig, maxTokens: number, contextWindow?: number): Model<string> {
  const requestModelId = toProviderRequestModelId(config);
  return {
    id: requestModelId,
    name: config.name ?? requestModelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl ?? 'http://localhost:0/mock',
    headers: config.headers ?? {},
    ...(config.compat !== undefined ? { compat: config.compat } : {}),
    reasoning: config.reasoning ?? false,
    input: config.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow ?? config.contextWindow ?? 200_000,
    maxTokens,
  } as unknown as Model<string>;
}

function resolveContextManagementConfig(
  config: NativeContextManagementConfig | undefined,
): ResolvedNativeContextManagementConfig {
  return {
    compactionThreshold: config?.compactionThreshold ?? 0.80,
    safetyMarginPct: config?.safetyMarginPct ?? 5,
    minRetainedToolResults: config?.minRetainedToolResults ?? 4,
    minOutputTokens: config?.minOutputTokens ?? 1_024,
  };
}

interface ComposedSignal {
  signal: AbortSignal;
  cleanup: () => void;
  isWallClockExpiry: () => boolean;
}

function composeAbortSignal(
  callerSignal: AbortSignal | undefined,
  maxWallClockMs: number | undefined,
): ComposedSignal {
  const controller = new AbortController();
  let wallClockExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function abort() {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }

  function cleanup() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  if (callerSignal?.aborted) {
    abort();
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', abort, { once: true });
  }

  if (maxWallClockMs !== undefined) {
    timer = setTimeout(() => {
      wallClockExpired = true;
      abort();
    }, maxWallClockMs);
  }

  return { signal: controller.signal, cleanup, isWallClockExpiry: () => wallClockExpired };
}

// ---------------------------------------------------------------------------
// Main loop function
// ---------------------------------------------------------------------------

/**
 * Drive Pi's agentLoop with Wavemill-owned budget accounting, abort composition,
 * heartbeat emission, and deterministic fail-fast batch semantics.
 */
export async function runWavemillLoop(config: WavemillLoopConfig): Promise<LoopResult> {
  const { context, convertToLlm, budget, signal: callerSignal, onHeartbeat, modelPricing, temperature } = config;
  const phaseMaxTokens = resolveMaxOutputTokens(config);
  let currentMaxTokens = phaseMaxTokens;
  const contextManagement = resolveContextManagementConfig(config.contextManagement);

  const startTime = Date.now();
  const composed = composeAbortSignal(callerSignal, budget?.maxWallClockMs);
  const stagnationTracker =
    budget?.stagnation?.maxRepeatedSignatureCalls !== undefined &&
    budget.stagnation.maxNoNovelProgressCalls !== undefined
      ? new ToolStagnationTracker({
        maxRepeatedSignatureCalls: budget.stagnation.maxRepeatedSignatureCalls,
        maxNoNovelProgressCalls: budget.stagnation.maxNoNovelProgressCalls,
      })
      : undefined;

  // Initialize optional session event stream writer
  // Session boundary events (started/ended) are only written if not provided externally
  let sessionStreamWriter: SessionStreamWriter | undefined;
  let skipSessionBoundaryEvents = false;
  try {
    if (config.sessionStreamConfig) {
      const streamConfig = config.sessionStreamConfig;
      // Use provided writer instance if available to avoid duplicate seq counters
      sessionStreamWriter = streamConfig.writerInstance ?? new SessionStreamWriter(
        {
          sessionId: streamConfig.sessionId,
          traceId: streamConfig.traceId,
          phase: streamConfig.phase,
          path: streamConfig.eventStreamPath,
        },
        streamConfig.repoDir,
      );
      // Only write session_started if no external writer flag is set
      // This allows launch-level code to control session boundaries for recovery/retry
      if (!streamConfig.externalWriterManagesSessionBoundaries) {
        sessionStreamWriter.writeSessionStarted({
          initialConfigDigest: streamConfig.initialConfigDigest ?? computeArgsFingerprint(config.model),
          manifestId: streamConfig.manifestId,
        });
      } else {
        skipSessionBoundaryEvents = true;
      }
    }
  } catch (error) {
    console.warn(`Failed to initialize session event stream: ${(error as Error).message}`);
    sessionStreamWriter = undefined;
  }

  // Build a name→metadata map for quick lookup inside afterToolCall.
  const toolMetadataByName = new Map<string, ToolMetadata>(
    (config.toolPolicy?.registry ?? []).map((m) => [m.name, m]),
  );

  if (composed.signal.aborted) {
    composed.cleanup();
    return {
      messages: [],
      stopReason: 'aborted',
      turnsCompleted: 0,
      toolCallsExecuted: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      wallClockMs: 0,
    };
  }

  let turnsCompleted = 0;
  let toolCallsExecuted = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let budgetStopReason: LoopStopReason | undefined;
  let terminalSynthesisActive = false;
  let terminalSynthesisPromptPending = false;
  let finalProviderError: LoopResult['providerError'] | undefined;
  let providerErrorRetryAttempts = 0;
  const providerErrorRetryMaxAttempts = config.providerErrorRetry?.maxAttempts ?? 3;
  const providerErrorRetryDelays = config.providerErrorRetry?.backoffDelaysMs ?? DEFAULT_PROVIDER_ERROR_RETRY_DELAYS_MS;
  const providerErrorSleep = config.providerErrorRetry?.sleep ?? sleepAbortable;
  // Track peak tokens for prompt size logging
  let peakInputTokens = 0;

  // Per-turn batch failure tracking for fail-fast semantics.
  // Key: the Pi AssistantMessage object for the current turn.
  const batchFailed = new WeakMap<AssistantMessage, boolean>();
  // Tool call ids that were skipped by beforeToolCall (not real failures).
  const skippedCallIds = new Set<string>();
  // Track current turn's model request event ID and callId for linking response
  let currentTurnRequestEventId: string | undefined;
  let currentTurnRequestCallId: string | undefined;

  const toolsForCompat = config.toolPolicy?.registry.length
    ? config.toolPolicy.registry
    : (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      executionMode: tool.executionMode ?? 'sequential',
    }));

  let contextWindowLimit: ContextWindowLimit | undefined;
  try {
    if (toolsForCompat.length > 0 && isNativeCompatProvider(config.model.provider)) {
      // Native providers must always be validated. Unknown transports throw via
      // `assertToolCompat`'s transport-capability lookup, so adding a new transport
      // to `ProviderModelConfig` cannot silently bypass the fail-fast gate.
      assertToolCompat({
        model: resolveRegistryModelId(config.model),
        provider: config.model.provider as 'openai' | 'openrouter',
        transport: config.model.api,
        tools: toolsForCompat,
        registry: config.compatRegistry,
      });
    }

    contextWindowLimit = resolveContextWindowLimit(config.model, config.compatRegistry);
    if (contextWindowLimit) {
      const preflightEstimate = estimatePromptTokens({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        tools: context.tools,
      });
      currentMaxTokens = computeDynamicMaxTokens({
        inputTokens: preflightEstimate.inputTokens,
        contextWindowTokens: contextWindowLimit.limit,
        phaseCeiling: phaseMaxTokens,
        minOutputTokens: contextManagement.minOutputTokens,
        safetyMarginPct: contextManagement.safetyMarginPct,
      });
      // When replay compaction is configured, this checks the untransformed
      // history, so it is conservative relative to the provider request.
      const estimateResult = assertPromptFitsContextWindow({
        phase: config.toolPolicy?.phase,
        model: config.model,
        context,
        reservedOutputTokens: currentMaxTokens,
        registry: config.compatRegistry,
        limit: contextWindowLimit,
        safetyMargin: contextManagement.safetyMarginPct / 100,
      });
      
      // Log the preflight estimate if prompt size logging is configured
      if (config.promptSizeLog && !Array.isArray(estimateResult) && estimateResult.diagnostic?.estimate) {
        const estimate = estimateResult.diagnostic.estimate;
        const sample: PromptSizeSample = {
          recordedAt: new Date().toISOString(),
          stage: config.promptSizeLog.stage,
          model: config.model.id,
          provider: config.model.provider,
          source: 'preflight-estimate',
          promptTokens: estimate.inputTokens,
          contextWindowLimit: contextWindowLimit.limit,
          session: config.promptSizeLog.session,
          issue: config.promptSizeLog.issue,
        };
        appendPromptSizeSample(config.promptSizeLog.repoDir, sample).catch(() => {
          // Ignore errors - logging should never break a run
        });
      }
    } else if (isNativeCompatProvider(config.model.provider)) {
      throw new ContextWindowUnverifiableError(config.toolPolicy?.phase ?? 'native', config.model);
    }
  } catch (error) {
    composed.cleanup();
    throw error;
  }

  const piConfig: AgentLoopConfig = {
    model: toPiModel(config.model, currentMaxTokens, contextWindowLimit?.limit),
    convertToLlm,
    temperature,
    maxTokens: currentMaxTokens,

    shouldStopAfterTurn: async (ctx: ShouldStopAfterTurnContext) => {
      const msg = ctx.message as AssistantMessage;
      const usage = msg.usage;
      if (usage) {
        const input = usage.input ?? 0;
        const output = usage.output ?? 0;
        const cacheWrite = usage.cacheWrite ?? 0;
        const cacheRead = usage.cacheRead ?? 0;
        totalInputTokens += input;
        totalOutputTokens += output;
        if (modelPricing) {
          totalCostUsd += computeModelCost(
            { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheWrite, cacheReadTokens: cacheRead },
            modelPricing,
          );
        }
        
        // Track peak input tokens (what must fit in context window)
        const totalTokens = input + cacheRead + cacheWrite;
        if (totalTokens > peakInputTokens) {
          peakInputTokens = totalTokens;
        }
      }
      turnsCompleted++;

      // Evaluate budget limits in deterministic order.
      // A pending terminal synthesis is the single graceful exception to the
      // analysis turn/tool limits. Token, cost, abort, and wall-clock limits
      // remain hard safety boundaries.
      if (
        !terminalSynthesisPromptPending
        && budget?.maxTurns !== undefined
        && turnsCompleted >= budget.maxTurns
      ) {
        budgetStopReason = 'turn_limit';
        return true;
      }
      if (budget?.maxInputTokens !== undefined && totalInputTokens >= budget.maxInputTokens) {
        budgetStopReason = 'token_limit';
        return true;
      }
      if (budget?.maxOutputTokens !== undefined && totalOutputTokens >= budget.maxOutputTokens) {
        budgetStopReason = 'token_limit';
        return true;
      }
      if (
        budget?.maxTotalTokens !== undefined &&
        totalInputTokens + totalOutputTokens >= budget.maxTotalTokens
      ) {
        budgetStopReason = 'token_limit';
        return true;
      }
      const terminalSynthesisCompleted = terminalSynthesisActive
        && !terminalSynthesisPromptPending
        && msg.stopReason === 'stop';
      if (
        !terminalSynthesisPromptPending
        && !terminalSynthesisCompleted
        && budget?.maxToolCalls !== undefined
        && toolCallsExecuted >= budget.maxToolCalls
      ) {
        budgetStopReason = 'tool_call_limit';
        return true;
      }
      if (budget?.maxCostUsd !== undefined && totalCostUsd >= budget.maxCostUsd) {
        budgetStopReason = 'cost_limit';
        return true;
      }
      // Gracefully exit if the abort signal fired during this turn (e.g. wall-clock or caller cancel).
      if (composed.signal.aborted) {
        return true;
      }
      return false;
    },

    beforeToolCall: async (ctx: BeforeToolCallContext, signal?: AbortSignal) => {
      // Fail-fast: skip subsequent calls once the batch has a failure.
      if (batchFailed.get(ctx.assistantMessage)) {
        skippedCallIds.add(ctx.toolCall.id);
        return { block: true, reason: 'skipped_after_failure' };
      }
      if (config.toolPolicy) {
        const decision = evaluateBeforeToolCallPolicy({
          ...config.toolPolicy,
          toolCall: {
            name: ctx.toolCall.name,
            arguments: ctx.args as Record<string, unknown>,
          },
        });
        // Log tool policy decision event
        if (sessionStreamWriter) {
          try {
            sessionStreamWriter.writeToolPolicyDecision({
              callId: ctx.toolCall.id,
              toolName: ctx.toolCall.name,
              decision: decision.kind === 'deny' ? 'deny' : 'allow',
              denialReason: decision.kind === 'deny' ? decision.message : undefined,
            });
          } catch (error) {
            console.warn(`Failed to log tool policy decision event: ${(error as Error).message}`);
          }
        }
        if (decision.kind === 'deny') {
          return { block: true, reason: decision.message };
        }
      }
      // Caller-supplied policy (Epic 2). Pass-through stub in Epic 1.
      if (config.beforeToolCall) {
        return config.beforeToolCall(ctx, signal);
      }
      return undefined;
    },

    afterToolCall: async (ctx: AfterToolCallContext, signal?: AbortSignal) => {
      const isSkipped = skippedCallIds.has(ctx.toolCall.id);
      skippedCallIds.delete(ctx.toolCall.id);

      if (!isSkipped) {
        toolCallsExecuted++;
        // A real failure marks the batch so subsequent calls are skipped.
        if (ctx.isError) {
          batchFailed.set(ctx.assistantMessage, true);
        }
      }

      // Run caller override first so gitAfterToolCall etc. can adjust isError/details.
      let callerOverride: AfterToolCallResult | undefined;
      if (config.afterToolCall) {
        callerOverride = await config.afterToolCall(ctx, signal);
      }
      const stagnationDecision = !isSkipped
        ? stagnationTracker?.record(ctx, callerOverride)
        : undefined;
      if (stagnationDecision?.stagnant) {
        budgetStopReason = 'tool_stagnation';
      }

      // Compute effective content and details after caller override.
      type ContentBlock = { type: string; text: string };
      const baseResult = ctx.result as { content?: ContentBlock[]; details?: unknown } | null | undefined;
      const existingMetadata = (
        ctx.result &&
        typeof ctx.result === 'object' &&
        'metadata' in ctx.result
      )
        ? (ctx.result as { metadata?: ToolResultMetadata }).metadata
        : undefined;
      const effectiveContent = ((callerOverride?.content ?? baseResult?.content ?? []) as ContentBlock[]);
      const effectiveDetails: unknown =
        callerOverride?.details !== undefined ? callerOverride.details : baseResult?.details;

      // Redact content text blocks before Pi appends them to replay context.
      let contentMatchCount = 0;
      let contentRedacted = false;
      const contentCategories: string[] = [];
      const redactedContent = effectiveContent.map((block) => {
        if (block.type === 'text') {
          const r = redactSecrets(block.text);
          if (r.redacted) {
            contentRedacted = true;
            contentMatchCount += r.matchCount;
            for (const c of r.categories) contentCategories.push(c);
          }
          return { type: 'text' as const, text: r.text };
        }
        return block;
      });

      // Redact details value tree.
      const detailsResult =
        effectiveDetails !== undefined && effectiveDetails !== null
          ? redactSecretsInValue(effectiveDetails)
          : { value: effectiveDetails, redacted: false, matchCount: 0, categories: [] as string[] };

      // Build provenance fingerprint.
      const provenance: ToolProvenanceMetadata = {
        tool: ctx.toolCall.name,
        argsFingerprint: computeArgsFingerprint(ctx.args),
      };

      // Derive output cap metadata from policy + actual truncation fields.
      const toolMeta = toolMetadataByName.get(ctx.toolCall.name);
      const outputCap = deriveOutputCapMetadata(toolMeta?.outputCapPolicy, detailsResult.value);

      // Aggregate redaction status.
      const allCategories = [...new Set([...contentCategories, ...detailsResult.categories])];
      const redaction: ToolRedactionMetadata = {
        redacted: contentRedacted || detailsResult.redacted,
        matchCount: contentMatchCount + detailsResult.matchCount,
        categories: allCategories,
      };

      const trust = buildTrustMetadata({
        sourceKind: existingMetadata?.trust?.sourceKind,
        content: redactedContent,
        details: detailsResult.value,
      });

      const metadata: ToolResultMetadata = {
        ...existingMetadata,
        provenance,
        outputCap,
        redaction,
        trust,
      };

      // Embed __wavemill metadata in details (plain-object only; transcript extracts it).
      const baseDetails = detailsResult.value;
      const enrichedDetails: unknown =
        baseDetails !== null &&
        baseDetails !== undefined &&
        typeof baseDetails === 'object' &&
        !Array.isArray(baseDetails)
          ? { ...(baseDetails as Record<string, unknown>), __wavemill: metadata }
          : baseDetails === undefined
            ? { __wavemill: metadata }
            : baseDetails;

      const override: AfterToolCallResult = {
        ...(callerOverride?.isError !== undefined ? { isError: callerOverride.isError } : {}),
        ...(callerOverride?.terminate !== undefined ? { terminate: callerOverride.terminate } : {}),
        ...(stagnationDecision?.stagnant ? { terminate: true } : {}),
        content: redactedContent as AfterToolCallResult['content'],
        details: enrichedDetails,
      };
      (override as AfterToolCallResult & { metadata?: ToolResultMetadata }).metadata = metadata;

      // Log tool result event
      if (sessionStreamWriter) {
        try {
          const contentSummary = redactedContent
            .filter((block) => block.type === 'text')
            .map((block) => (block as { type: string; text: string }).text)
            .join('\n');

          // Store large or truncated results as artifacts
          let artifactRef = undefined;
          if (outputCap.capped || (contentSummary?.length ?? 0) > 10000) {
            try {
              artifactRef = storeArtifact(
                contentSummary || JSON.stringify(enrichedDetails),
                config.sessionStreamConfig?.repoDir,
                outputCap.capped,
                typeof enrichedDetails === 'string' ? enrichedDetails.length : undefined,
              );
            } catch (artifactError) {
              console.warn(`Failed to store tool result artifact: ${(artifactError as Error).message}`);
            }
          }

          sessionStreamWriter.writeToolResult({
            callId: ctx.toolCall.id,
            toolName: ctx.toolCall.name,
            isError: override.isError ?? false,
            contentSummary: contentSummary ? contentSummary.slice(0, 500) : undefined,
            byteSize: contentSummary?.length,
            artifactRef,
            redaction: redaction.redacted
              ? {
                  redacted: true,
                  matchCount: redaction.matchCount,
                  categories: redaction.categories,
                }
              : undefined,
          });
        } catch (error) {
          console.warn(`Failed to log tool result event: ${(error as Error).message}`);
        }
      }

      return override;
    },
  };

  if (contextWindowLimit || config.terminalSynthesis) {
    piConfig.prepareNextTurn = async (ctx) => {
      let nextModel: Model<any> | undefined;
      if (contextWindowLimit) {
        const inputTokens = estimatePromptTokens({
          systemPrompt: context.systemPrompt,
          messages: ctx.context.messages,
          tools: ctx.context.tools,
        }).inputTokens;
        const nextMaxTokens = computeDynamicMaxTokens({
          inputTokens,
          contextWindowTokens: contextWindowLimit.limit,
          phaseCeiling: phaseMaxTokens,
          minOutputTokens: contextManagement.minOutputTokens,
          safetyMarginPct: contextManagement.safetyMarginPct,
        });
        if (nextMaxTokens !== currentMaxTokens) {
          currentMaxTokens = nextMaxTokens;
          piConfig.maxTokens = nextMaxTokens;
          nextModel = toPiModel(config.model, nextMaxTokens, contextWindowLimit.limit);
        }
      }

      const currentTurn = turnsCompleted + 1;
      const requestedTools = ctx.message.content.some((block) => block.type === 'toolCall');
      const reachedTurnBoundary = budget?.maxTurns !== undefined
        && currentTurn >= budget.maxTurns - 1;
      const reachedToolBoundary = budget?.maxToolCalls !== undefined
        && toolCallsExecuted >= budget.maxToolCalls;
      if (
        config.terminalSynthesis
        && !terminalSynthesisActive
        && requestedTools
        && (reachedTurnBoundary || reachedToolBoundary)
      ) {
        terminalSynthesisActive = true;
        terminalSynthesisPromptPending = true;
        return {
          ...(nextModel ? { model: nextModel } : {}),
          context: {
            ...ctx.context,
            tools: [],
          },
        };
      }

      if (!nextModel) {
        return undefined;
      }
      return {
        model: nextModel,
      };
    };
  }

  if (config.terminalSynthesis) {
    piConfig.getSteeringMessages = async () => {
      if (!terminalSynthesisPromptPending) {
        return [];
      }
      terminalSynthesisPromptPending = false;
      return [{
        role: 'user',
        content: config.terminalSynthesis!.prompt,
        timestamp: Date.now(),
      }];
    };
  }

  piConfig.transformContext = async (messages: AgentMessage[]) => {
    let nextMessages = messages;
    if (contextWindowLimit) {
      const beforeEstimate = estimatePromptTokens({
        systemPrompt: context.systemPrompt,
        messages: nextMessages,
        tools: context.tools,
      });
      const compactionTrigger = Math.floor(contextWindowLimit.limit * contextManagement.compactionThreshold);
      if (beforeEstimate.inputTokens + currentMaxTokens > compactionTrigger) {
        const result = compactTranscript(nextMessages, {
          targetTokens: Math.max(0, compactionTrigger - currentMaxTokens),
          minRetainedToolResults: contextManagement.minRetainedToolResults,
          systemPrompt: context.systemPrompt,
          tools: context.tools,
        });
        nextMessages = result.messages;
        if (result.droppedCount > 0 && sessionStreamWriter) {
          try {
            sessionStreamWriter.writeCompaction({
              strategy: result.strategy,
              affectedEventCount: result.droppedCount,
              beforeContextDigest: computeArgsFingerprint(messages),
              afterContextDigest: computeArgsFingerprint(nextMessages),
            });
          } catch (error) {
            console.warn(`Failed to log compaction event: ${(error as Error).message}`);
          }
        }

        const afterEstimate = estimatePromptTokens({
          systemPrompt: context.systemPrompt,
          messages: nextMessages,
          tools: context.tools,
        });
        const verdict = evaluateContextWindow({
          phase: config.toolPolicy?.phase,
          model: config.model,
          limit: contextWindowLimit,
          estimate: afterEstimate,
          reservedOutputTokens: currentMaxTokens,
          safetyMargin: contextManagement.safetyMarginPct / 100,
        });
        if (!verdict.ok) {
          throw new ContextExhaustedError(
            `context-exhausted: compacted native ${config.toolPolicy?.phase ?? 'session'} context to the floor and still exceeded the model context window`,
            {
              ...verdict.diagnostic,
              droppedCount: result.droppedCount,
              droppedTokensEstimate: result.droppedTokensEstimate,
              handoff: {
                transcriptPath: config.sessionStreamConfig?.eventStreamPath,
                lastCompactionStrategy: result.strategy,
                stopAfterTurn: turnsCompleted,
              },
            },
          );
        }
      }
    }

    if (config.compaction) {
      const result = transformContext(nextMessages, config.compaction);
      if (result.events.length > 0) {
        try {
          config.onCompactionEvents?.(result.events);
        } catch {
          // Compaction event sinks are diagnostic; replay compaction should not
          // fail an otherwise valid provider request.
        }
      }
      return result.messages;
    }
    return nextMessages;
  };

  let finalMessages: AgentMessage[] = [];
  let loopError: unknown;

  const handleAgentEvent = (event: AgentEvent, exposeToCaller = true) => {
    if (exposeToCaller) {
      config.onEvent?.(event);
    }
    switch (event.type) {
      case 'turn_start':
        onHeartbeat?.({ state: 'working', event: 'turn_start', agent: HEARTBEAT_AGENT });
        // Log model request event when turn starts
        if (sessionStreamWriter) {
          try {
            currentTurnRequestCallId = randomUUID();
            const modelRequestEvent = sessionStreamWriter.writeModelRequest({
              callId: currentTurnRequestCallId,
              turnIndex: turnsCompleted,
              provider: config.model.provider,
              modelId: toProviderRequestModelId(config.model),
              config: {
                temperature,
                maxTokens: currentMaxTokens,
              },
              contextDigest: computeArgsFingerprint(context),
              promptRefs: config.sessionStreamConfig?.promptRefs ?? [],
              injectedContextRefs: config.sessionStreamConfig?.injectedContextRefs,
            });
            currentTurnRequestEventId = modelRequestEvent.eventId;
          } catch (error) {
            console.warn(`Failed to log model request event: ${(error as Error).message}`);
          }
        }
        break;
      case 'message_update':
        onHeartbeat?.({ state: 'working', event: 'message_update', agent: HEARTBEAT_AGENT });
        break;
      case 'tool_execution_start':
        onHeartbeat?.({
          state: 'working',
          event: 'tool_execution_start',
          detail: event.toolName,
          agent: HEARTBEAT_AGENT,
        });
        // Log tool call event when tool execution starts
        if (sessionStreamWriter) {
          try {
            sessionStreamWriter.writeToolCall({
              callId: event.callId ?? randomUUID(),
              toolName: event.toolName,
            });
          } catch (error) {
            console.warn(`Failed to log tool call event: ${(error as Error).message}`);
          }
        }
        break;
      case 'agent_end':
        finalMessages = event.messages;
        // Log model response event when agent ends this turn
        if (sessionStreamWriter && currentTurnRequestEventId) {
          try {
            const finalMsg = event.messages[event.messages.length - 1] as AssistantMessage;
            if (finalMsg && finalMsg.role === 'assistant') {
              sessionStreamWriter.writeModelResponse({
                requestEventId: currentTurnRequestEventId,
                callId: currentTurnRequestCallId ?? currentTurnRequestEventId,
                stopReason: finalMsg.stopReason ?? 'unknown',
                usage: finalMsg.usage as Record<string, unknown> | undefined,
              });
            }
          } catch (error) {
            console.warn(`Failed to log model response event: ${(error as Error).message}`);
          }
        }
        break;
      default:
        break;
    }
  };

  try {
    let loopContext = context;
    let emptyAssistantContinuations = 0;
    let continuationRunIndex = 0;

    while (true) {
      let bufferedAgentEnd: AgentEvent | undefined;
      const emit: AgentEventSink = (event) => {
        if (event.type === 'agent_end') {
          bufferedAgentEnd = event;
          return;
        }
        handleAgentEvent(event, !(continuationRunIndex > 0 && event.type === 'agent_start'));
      };

      const runMessages = await runAgentLoopContinue(loopContext, piConfig, emit, composed.signal);
      finalMessages = continuationRunIndex > 0
        ? [...loopContext.messages, ...runMessages]
        : runMessages;
      const emptyAssistantTurn =
        !budgetStopReason
        && !composed.signal.aborted
        && shouldContinueEmptyAssistantTurn(finalMessages);
      const providerError = !budgetStopReason && !composed.signal.aborted
        ? finalAssistantProviderError(finalMessages)
        : undefined;

      if (
        providerError
        && providerError.classification.retryable
        && providerErrorRetryAttempts < providerErrorRetryMaxAttempts
      ) {
        if (bufferedAgentEnd) {
          handleAgentEvent(bufferedAgentEnd, false);
        }
        providerErrorRetryAttempts += 1;
        const detail = providerError.classification.kind;
        onHeartbeat?.({ state: 'working', event: 'provider_retry', detail, agent: HEARTBEAT_AGENT });
        try {
          sessionStreamWriter?.writeRetry({
            failedEventId: currentTurnRequestEventId ?? currentTurnRequestCallId ?? randomUUID(),
            reason: `${detail}: ${providerError.errorMessage}`,
            retryCount: providerErrorRetryAttempts,
          });
        } catch (error) {
          console.warn(`Failed to log provider retry event: ${(error as Error).message}`);
        }
        const retainedMessages = stripTrailingAssistantErrorTurn(finalMessages, providerError.message);
        const delayMs = providerRetryDelayMs(providerErrorRetryDelays, providerErrorRetryAttempts - 1);
        await providerErrorSleep(delayMs, composed.signal);
        if (composed.signal.aborted) {
          break;
        }
        continuationRunIndex += 1;
        loopContext = {
          ...context,
          messages: retainedMessages,
        };
        continue;
      }

      if (providerError) {
        finalProviderError = {
          kind: providerError.classification.kind,
          retryable: providerError.classification.retryable,
          attempts: providerErrorRetryAttempts,
          errorMessage: providerError.errorMessage,
          turnsAtFailure: Math.max(turnsCompleted, assistantMessageCount(finalMessages)),
        };
      }

      if (emptyAssistantTurn && emptyAssistantContinuations < EMPTY_ASSISTANT_CONTINUATION_LIMIT) {
        if (bufferedAgentEnd) {
          handleAgentEvent(bufferedAgentEnd, false);
        }
        emptyAssistantContinuations += 1;
        continuationRunIndex += 1;
        loopContext = {
          ...context,
          messages: [
            ...finalMessages,
            buildEmptyAssistantContinuationMessage(),
          ],
        };
        continue;
      }

      if (emptyAssistantTurn) {
        markEmptyModelTurnExhausted(finalMessages);
      }
      if (bufferedAgentEnd) {
        const exposedAgentEnd = bufferedAgentEnd.type === 'agent_end'
          ? { ...bufferedAgentEnd, messages: finalMessages }
          : bufferedAgentEnd;
        handleAgentEvent(exposedAgentEnd, true);
      }
      break;
    }
  } catch (err) {
    loopError = err;
  } finally {
    // Log the run peak if prompt size logging is configured
    if (config.promptSizeLog && peakInputTokens > 0) {
      const sample: PromptSizeSample = {
        recordedAt: new Date().toISOString(),
        stage: config.promptSizeLog.stage,
        model: config.model.id,
        provider: config.model.provider,
        source: 'run-peak',
        promptTokens: peakInputTokens,
        contextWindowLimit: contextWindowLimit?.limit,
        session: config.promptSizeLog.session,
        issue: config.promptSizeLog.issue,
      };
      appendPromptSizeSample(config.promptSizeLog.repoDir, sample).catch(() => {
        // Ignore errors - logging should never break a run
      });
    }
    composed.cleanup();
  }

  const wallClockMs = Date.now() - startTime;
  if (!finalProviderError) {
    const providerError = finalAssistantProviderError(finalMessages);
    if (providerError) {
      finalProviderError = {
        kind: providerError.classification.kind,
        retryable: providerError.classification.retryable,
        attempts: providerErrorRetryAttempts,
        errorMessage: providerError.errorMessage,
        turnsAtFailure: Math.max(turnsCompleted, assistantMessageCount(finalMessages)),
      };
    }
  }

  let stopReason: LoopStopReason;
  const finalStopReason = finalAssistantStopReason(finalMessages);
  if (composed.signal.aborted && (loopError || !budgetStopReason)) {
    // Abort takes precedence over a loop error since the error may be caused by the abort.
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else if (loopError) {
    stopReason = 'error';
  } else if (finalStopReason === 'error') {
    stopReason = 'error';
  } else if (finalStopReason === 'aborted') {
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else if (finalStopReason === 'stop' && budgetStopReason === 'turn_limit') {
    stopReason = 'stop';
  } else if (budgetStopReason) {
    stopReason = budgetStopReason;
  } else if (composed.signal.aborted) {
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else {
    stopReason = 'stop';
  }

  // Write session_ended event if session stream is enabled and not externally managed
  try {
    if (sessionStreamWriter && !skipSessionBoundaryEvents) {
      sessionStreamWriter.writeSessionEnded({
        stopReason,
        totalTurns: turnsCompleted,
        totalToolCalls: toolCallsExecuted,
        totalTokens: totalInputTokens + totalOutputTokens,
      });
    }
  } catch (error) {
    console.warn(`Failed to write session_ended event: ${(error as Error).message}`);
  }

  if (loopError instanceof ContextExhaustedError) {
    throw loopError;
  }

  return {
    messages: finalMessages,
    stopReason,
    turnsCompleted,
    toolCallsExecuted,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    wallClockMs,
    ...(finalProviderError ? { providerError: finalProviderError } : {}),
  };
}

function resolveRegistryModelId(model: ProviderModelConfig): string {
  if (model.name && model.name.trim().length > 0) {
    return model.name.trim();
  }

  const separator = model.id.indexOf(':');
  return separator === -1 ? model.id : model.id.slice(separator + 1);
}

function isNativeCompatProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'openrouter';
}
