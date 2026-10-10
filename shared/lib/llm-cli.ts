/**
 * Shared LLM CLI integration
 *
 * Provides a unified interface for calling LLM CLIs (Claude, Codex, etc.) with:
 * - Multi-provider support (Claude CLI, Codex CLI, OpenAI API)
 * - Both sync (execSync) and stream (spawn) modes
 * - Temp file management for large prompts
 * - Configurable timeout, buffer limits, model
 * - JSON envelope unwrapping (data.result, usage extraction)
 * - Optional retry with exponential backoff
 * - Task-specific cross-model fallback for hard quota errors
 * - Tool-call/XML tag stripping
 * - Provider-specific env injection
 *
 * @module llm-cli
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { attachFallbackEvent } from './eval-record-builder.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { loadTraceContext, appendTraceEvent } from './trace-event.ts';
import { SCHEMA_VERSION, getScoreBand, type DifficultyBand, type EvalRecord, type FallbackEventMetadata, type FallbackOutcome } from './eval-schema.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { getEffectiveRegistry, getLadder, getModel, rankCandidates, type RegistryTaskType } from './model-registry.ts';
import { getModelStatus, markExhausted, readQuotaSnapshot, recordSuccess } from './quota-state.ts';
import { filterDisabledModels } from './disabled-models.ts';
import { fallbackLog } from './router-log.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { resolveEnvValue } from './env-file.ts';
import { DEEPSEEK_BASE_URL } from './deepseek-provider.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Supported LLM providers
 */
export type LLMProvider = 'claude' | 'codex' | 'openai';

export interface LLMCallOptions {
  /** LLM provider to use (default: 'claude') */
  provider?: LLMProvider;
  /** Execution mode: 'sync' uses execSync (blocking), 'stream' uses spawn */
  mode?: 'sync' | 'stream';
  /** Model to use (e.g., 'claude-opus-4-6', 'gpt-4', 'codex-latest') */
  model?: string;
  /** Timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number;
  /**
   * Cap on the model's output tokens (HOK-3179). Passed to the Claude Code CLI
   * via `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (the documented env knob); other
   * providers currently ignore it. Best-effort — the hard budget is still
   * timeout/deadline.
   */
  maxOutputTokens?: number;
  /**
   * Activity-based timeout in milliseconds.
   * When set, the timeout resets whenever stdout/stderr receives data.
   * The `timeout` option becomes a hard wall-clock cap.
   * Use this to tolerate gaps between output while still catching stuck processes.
   * Example: activityTimeout=120_000, timeout=600_000 tolerates 2-min gaps but caps at 10 min total.
   */
  activityTimeout?: number;
  /** Max buffer size for stdout/stderr in bytes (default: 10MB) */
  maxBuffer?: number;
  /** Enable retry with exponential backoff (default: false) */
  retry?: boolean;
  /** Max retry attempts when retry is enabled (default: 2) */
  maxRetries?: number;
  /** Strip tool calls and XML tags from output (default: true) */
  stripToolCalls?: boolean;
  /** Additional CLI flags to pass to LLM command */
  cliFlags?: string[];
  /** Working directory for command execution */
  cwd?: string;
  /** Repo root used for registry/quota-state resolution */
  repoDir?: string;
  /** Override CLI command (e.g., 'claude', 'codex', 'openai') */
  cliCmd?: string;
  /** Task type used to select a task-specific fallback ladder */
  taskType?: RegistryTaskType;
  /** Difficulty classification for downstream eval attribution */
  difficulty?: DifficultyBand;
  /** Override fallback candidates instead of consulting the registry */
  fallbackModels?: string[];
  /** Absolute epoch-millisecond deadline for fallback ladders. */
  fallbackDeadlineMs?: number;
  /** Per-candidate timeout cap for fallback ladders. */
  fallbackPerAttemptTimeoutMs?: number;
  /** Grace reserved before the absolute fallback deadline. */
  fallbackDeadlineGraceMs?: number;
  /** Disable best-effort eval emission for fallback events */
  logFallbackEvents?: boolean;
  /** Feature directory for trace event emission (HOK-2259) */
  featureDir?: string;
  /** Lifecycle hooks for progress reporting */
  observer?: LLMCallObserver;
  /** Optional abort signal to terminate the spawned CLI process. */
  signal?: AbortSignal;
}

export interface LLMCallResult {
  /** Cleaned output text */
  text: string;
  /** Token usage (if available from JSON envelope) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Cost in USD (if available from JSON envelope) */
  costUsd?: number;
  /** Raw output before cleaning */
  rawOutput: string;
  /** Provider that was used */
  provider: LLMProvider;
  /** Model that actually produced the response */
  model: string;
  /** Models skipped due to quota exhaustion before success */
  fallbackChain?: Array<{ model: string; reason: string }>;
}

export interface CliHealthCheck {
  /** Whether CLI is available and working */
  available: boolean;
  /** CLI command that was checked */
  command: string;
  /** Version string if available */
  version?: string;
  /** Error message if check failed */
  error?: string;
  /** Detailed diagnostics */
  diagnostics?: {
    inPath: boolean;
    executable: boolean;
    authWorking?: boolean;
  };
}

export interface LLMCallObserverEvent {
  provider: LLMProvider;
  model?: string;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  error?: string;
  delayMs?: number;
  nextAttempt?: number;
  willRetry?: boolean;
}

export interface LLMCallObserver {
  onAttemptStart?: (event: LLMCallObserverEvent) => void | Promise<void>;
  onAttemptSlow?: (event: LLMCallObserverEvent) => void | Promise<void>;
  onAttemptComplete?: (event: LLMCallObserverEvent) => void | Promise<void>;
  onAttemptError?: (event: LLMCallObserverEvent) => void | Promise<void>;
  onRetry?: (event: LLMCallObserverEvent) => void | Promise<void>;
  onQuotaFallback?: (
    event: { failedModel: string; nextModel?: string; reason: string; resetAt?: string | null }
  ) => void | Promise<void>;
}

interface ObservedError extends Error {
  elapsedMs?: number;
}

export class LLMQuotaError extends Error {
  readonly modelId: string;
  readonly reason: string;
  readonly resetAt?: string | null;

  constructor(message: string, details: { modelId: string; reason: string; resetAt?: string | null }) {
    super(message);
    this.name = 'LLMQuotaError';
    this.modelId = details.modelId;
    this.reason = details.reason;
    this.resetAt = details.resetAt;
  }
}

type LLMErrorKind = 'quota' | 'auth' | 'timeout' | 'transient' | 'other';

interface ClassifiedLLMError {
  kind: LLMErrorKind;
  reason: string;
  resetAt: string | null;
  retryable: boolean;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_RETRIES = 2;
const SLOW_CALL_WARNING_MS = 30_000;
const SLOW_CALL_REPEAT_MS = 15_000;
const FALLBACK_DEFAULT_TASK_TYPE: RegistryTaskType = 'classify';
const FALLBACK_EVENT_SCHEMA_VERSION = '1.0';
const FALLBACK_MIN_ATTEMPT_TIMEOUT_MS = 500;
const warnedMissingTaskType = new Set<string>();

function withElapsed(error: Error, elapsedMs: number): ObservedError {
  const observed = error as ObservedError;
  observed.elapsedMs = elapsedMs;
  return observed;
}

function getElapsed(error: unknown): number {
  return typeof (error as ObservedError)?.elapsedMs === 'number'
    ? (error as ObservedError).elapsedMs!
    : 0;
}

function extractResetAt(message: string): string | null {
  const retryAfterMatch = message.match(/retry-after[:=]\s*(\d+)/i);
  if (retryAfterMatch) {
    const seconds = Number.parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(seconds)) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  const resetAtMatch = message.match(/(?:reset[_ -]?at|retry[_ -]?at)[:=]\s*([0-9TZ:.\-+]+)/i);
  if (resetAtMatch) {
    const parsed = Date.parse(resetAtMatch[1]);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return null;
}

function classifyLLMError(error: unknown): ClassifiedLLMError {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  const resetAt = extractResetAt(message);

  if (
    /\b(429|rate[_ -]?limit(?:[_ -]?(?:exceeded|error))?|quota|resource_exhausted|insufficient_quota|too many requests)\b/i.test(message)
    || /exited with code 429/i.test(message)
  ) {
    return { kind: 'quota', reason: 'quota', resetAt, retryable: true };
  }

  if (/\b(401|403|authentication(?:_error)?|unauthorized|forbidden|invalid[_ ]api[_ ]key|permission denied)\b/i.test(lowered)) {
    return { kind: 'auth', reason: 'auth', resetAt, retryable: false };
  }

  if (/\b(etimedout|timed out|timeout|inactivity)\b/i.test(lowered)) {
    return { kind: 'timeout', reason: 'timeout', resetAt, retryable: true };
  }

  if (/\b(econnreset|econnrefused|enotfound|socket hang up|temporar(?:y|ily)|overloaded|unavailable|server_error|5\d\d)\b/i.test(lowered)) {
    return { kind: 'transient', reason: 'transient', resetAt, retryable: true };
  }

  return { kind: 'other', reason: 'other', resetAt, retryable: true };
}

function repoDirForOptions(options: LLMCallOptions): string {
  return options.repoDir ?? options.cwd ?? process.cwd();
}

function warnMissingTaskType(provider: LLMProvider): void {
  if (warnedMissingTaskType.has(provider)) {
    return;
  }
  warnedMissingTaskType.add(provider);
  console.warn(
    `[llm-cli] missing taskType for provider=${provider}; defaulting quota fallback ladder to ${FALLBACK_DEFAULT_TASK_TYPE}`,
  );
}

function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const model of models) {
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    deduped.push(model);
  }
  return deduped;
}

function hasFallbackDeadline(options: LLMCallOptions): boolean {
  return typeof options.fallbackDeadlineMs === 'number' && Number.isFinite(options.fallbackDeadlineMs);
}

function shouldEnforceClassifierProviderCredentials(options: LLMCallOptions): boolean {
  return options.taskType === 'classify' && hasFallbackDeadline(options);
}

/**
 * Credential env var a fallback candidate needs before it is worth attempting
 * under a classifier budget.
 *
 * The `claude` provider spawns the Claude CLI, which owns its own auth (the
 * operator's subscription login or whatever key the CLI itself is configured
 * with). Requiring `ANTHROPIC_API_KEY` here skipped every Anthropic candidate
 * in the mill, where no such key exists (HOK-3130), so the claude transport
 * never gates on a credential. Transport/vendor mismatches are handled by
 * {@link transportIncompatibilityReason} instead.
 */
function credentialEnvForCandidate(provider: LLMProvider): string | null {
  if (provider === 'openai') {
    return 'OPENAI_API_KEY';
  }

  return null;
}

function filterCandidatesWithCredentials(
  candidates: string[],
  provider: LLMProvider,
  options: LLMCallOptions,
  taskType: RegistryTaskType,
): string[] {
  if (!shouldEnforceClassifierProviderCredentials(options)) {
    return candidates;
  }

  const repoDir = repoDirForOptions(options);
  const eligible: string[] = [];

  for (const candidate of candidates) {
    const envVar = credentialEnvForCandidate(provider);
    if (!envVar || resolveEnvValue([envVar], repoDir)) {
      eligible.push(candidate);
      continue;
    }

    console.warn(`[${fallbackLogLabel(taskType)}] ${candidate} skipped (missing ${envVar})`);
  }

  return eligible;
}

function fallbackLogLabel(taskType: RegistryTaskType): string {
  return taskType === 'classify' ? 'classifier' : taskType;
}

function fallbackAttemptTimeout(options: LLMCallOptions): number | null | undefined {
  if (!hasFallbackDeadline(options)) {
    return undefined;
  }

  const graceMs = Math.max(0, Math.floor(options.fallbackDeadlineGraceMs ?? 1_500));
  const usableRemainingMs = Math.floor(options.fallbackDeadlineMs! - Date.now() - graceMs);
  if (usableRemainingMs < FALLBACK_MIN_ATTEMPT_TIMEOUT_MS) {
    return null;
  }

  const caps = [usableRemainingMs];
  if (typeof options.fallbackPerAttemptTimeoutMs === 'number' && Number.isFinite(options.fallbackPerAttemptTimeoutMs)) {
    caps.push(Math.max(1, Math.floor(options.fallbackPerAttemptTimeoutMs)));
  }
  if (typeof options.timeout === 'number' && Number.isFinite(options.timeout)) {
    caps.push(Math.max(1, Math.floor(options.timeout)));
  }

  return Math.max(1, Math.min(...caps));
}

function summarizePrompt(prompt: string, maxLength = 200): string {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}...`;
}

function safeQuotaSnapshot(repoDir: string): FallbackEventMetadata['quota_snapshot'] {
  try {
    const snapshot = readQuotaSnapshot(repoDir);
    return {
      snapshotAt: snapshot.snapshotAt,
      models: Object.fromEntries(
        Object.entries(snapshot.models).map(([modelId, entry]) => [
          modelId,
          {
            status: entry.status,
            resetAt: entry.resetAt,
            remainingEstimate: entry.remainingEstimate,
            confidence: entry.confidence,
          },
        ]),
      ),
    };
  } catch {
    return {
      snapshotAt: new Date().toISOString(),
      models: {},
    };
  }
}

function buildFallbackEventRecord(input: {
  prompt: string;
  preferredModel: string;
  fallbackModel: string | null;
  taskType: RegistryTaskType | null;
  difficulty?: DifficultyBand;
  repoDir: string;
  outcome: FallbackOutcome;
  fallbackChain: Array<{ model: string; reason: string }>;
  startedAt: number;
  endedAt: number;
  costUsd: number | null;
}): EvalRecord {
  const score = input.outcome === 'success' ? 1.0 : 0.0;
  const modelsAvailable = Array.from(
    new Set(
      [input.preferredModel, input.fallbackModel, ...input.fallbackChain.map((entry) => entry.model)]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    ),
  );
  const fallbackEvent: FallbackEventMetadata = {
    schema_version: FALLBACK_EVENT_SCHEMA_VERSION,
    preferred_model: input.preferredModel,
    fallback_model: input.fallbackModel,
    task_type: input.taskType,
    difficulty: input.difficulty ?? null,
    quota_snapshot: safeQuotaSnapshot(input.repoDir),
    human_intervention: false,
    outcome: input.outcome,
    latency_ms: Math.max(0, input.endedAt - input.startedAt),
    cost_usd: typeof input.costUsd === 'number' ? input.costUsd : null,
    fallback_chain: [...input.fallbackChain],
  };

  const record: EvalRecord = {
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: summarizePrompt(input.prompt),
    modelId: input.fallbackModel ?? input.preferredModel,
    modelVersion: '',
    score,
    scoreBand: getScoreBand(score).label,
    timeSeconds: Math.max(0, input.endedAt - input.startedAt) / 1000,
    timestamp: new Date(input.endedAt).toISOString(),
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: `Cross-model fallback: ${input.preferredModel} -> ${input.fallbackModel ?? 'none'} (${input.outcome})`,
    agentType: 'llm-cli',
    taskDescriptor: buildTaskDescriptor({
      originalPrompt: summarizePrompt(input.prompt),
      score,
      timeSeconds: Math.max(0, input.endedAt - input.startedAt) / 1000,
      interventionCount: 0,
      modelsAvailable,
      objective: 'balanced',
      workflowCost: typeof input.costUsd === 'number' ? input.costUsd : undefined,
    }),
  };

  attachFallbackEvent(record, fallbackEvent);
  return record;
}

function emitFallbackEvent(
  input: Parameters<typeof buildFallbackEventRecord>[0],
  featureDir?: string,
): void {
  try {
    const record = buildFallbackEventRecord(input);
    const evalsDir = resolveEvalsDir(undefined, input.repoDir).dir;
    appendEvalRecord(record, { dir: evalsDir, repoDir: input.repoDir });
  } catch (error) {
    console.warn(
      `[llm-cli] failed to persist fallback eval: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Emit fallback_used trace event (HOK-2259) — best-effort
  if (featureDir) {
    const traceCtx = loadTraceContext(featureDir);
    if (traceCtx) {
      appendTraceEvent(traceCtx, {
        phase: 'coding',
        event: 'fallback_used',
        status: input.outcome === 'success' ? 'ok' : 'failed',
        model: input.fallbackModel ?? undefined,
        meta: {
          preferredModel: input.preferredModel,
          fallbackModel: input.fallbackModel,
          outcome: input.outcome,
          fallbackChain: input.fallbackChain,
        },
      }).catch(() => undefined);
    }
  }
}

/** A ladder candidate removed before any attempt, with a human-readable reason. */
interface SkippedCandidate {
  model: string;
  reason: string;
}

function resolveCandidateModels(
  provider: LLMProvider,
  options: LLMCallOptions,
): { taskType: RegistryTaskType; candidates: string[]; skipped: SkippedCandidate[] } {
  const repoDir = repoDirForOptions(options);
  const registry = getEffectiveRegistry(repoDir);
  const servableVendor = provider === 'claude' ? claudeCliServableVendor() : null;
  const skipped: SkippedCandidate[] = [];
  const isServable = (modelId: string): boolean => {
    const reason = transportIncompatibilityReason(provider, registry, modelId, servableVendor);
    if (reason) {
      skipped.push({ model: modelId, reason });
      return false;
    }
    return true;
  };

  let taskType: RegistryTaskType;
  let initial: string[];
  if (options.fallbackModels && options.fallbackModels.length > 0) {
    taskType = options.taskType ?? FALLBACK_DEFAULT_TASK_TYPE;
    initial = options.model ? [options.model, ...options.fallbackModels] : options.fallbackModels;
  } else {
    taskType = options.taskType ?? FALLBACK_DEFAULT_TASK_TYPE;
    if (!options.taskType) {
      warnMissingTaskType(provider);
    }

    let ladder = getLadder(registry, taskType);
    if (ladder.length === 0) {
      ladder = rankCandidates(registry, taskType);
    }
    initial = options.model ? [options.model, ...ladder] : ladder;
  }

  // Exclude globally disabled models (e.g. access-restricted upstream) — same
  // lever every other routing path honors via filterDisabledModels.
  const deduped = filterDisabledModels(uniqueModels(initial).filter(isServable));
  const available = deduped.filter((modelId) => getModelStatus(modelId, repoDir) !== 'exhausted');
  return {
    taskType,
    candidates: available.length > 0 ? available : deduped,
    skipped,
  };
}

/** Transport label used in skip reasons (`transport claude-cli cannot serve vendor deepseek`). */
function transportLabel(provider: LLMProvider): string {
  return provider === 'claude' ? 'claude-cli' : `${provider}-cli`;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Which registry vendor the Claude CLI transport can actually serve from the
 * current environment.
 *
 * `llm-cli` spawns `claude -p` with the inherited env and injects no endpoint
 * of its own. By default that reaches Anthropic, so only `vendor: anthropic`
 * models answer; a DeepSeek id such as `deepseek-v4-flash` is rejected as an
 * unrecognized model and hangs until the attempt timeout (HOK-3130). Only
 * when the process already runs inside a claude-deepseek agent env
 * (`ANTHROPIC_BASE_URL` pointing at the DeepSeek Anthropic-compatible
 * endpoint) is the relationship inverted.
 */
export function claudeCliServableVendor(env: NodeJS.ProcessEnv = process.env): 'anthropic' | 'deepseek' {
  const baseUrl = normalizeBaseUrl(env.ANTHROPIC_BASE_URL);
  return baseUrl !== '' && baseUrl === normalizeBaseUrl(DEEPSEEK_BASE_URL) ? 'deepseek' : 'anthropic';
}

/**
 * Explain why `provider`'s transport cannot serve `modelId`, or return `null`
 * when it can. Unknown ids and `vendor: custom` models are always permitted
 * (the operator opted into them explicitly).
 *
 * @param servableVendor - For the `claude` provider, the vendor the CLI can
 *   reach (see {@link claudeCliServableVendor}); ignored for other providers.
 */
function transportIncompatibilityReason(
  provider: LLMProvider,
  registry: ReturnType<typeof getEffectiveRegistry>,
  modelId: string,
  servableVendor: 'anthropic' | 'deepseek' | null,
): string | null {
  const model = getModel(registry, modelId);
  if (!model || model.vendor === 'custom') {
    return null;
  }

  if (provider === 'claude') {
    const vendor = servableVendor ?? 'anthropic';
    return model.vendor === vendor
      ? null
      : `transport ${transportLabel(provider)} cannot serve vendor ${model.vendor}`;
  }

  if (provider === 'codex' || provider === 'openai') {
    return model.vendor === 'openai'
      ? null
      : `transport ${transportLabel(provider)} cannot serve vendor ${model.vendor}`;
  }

  return null;
}

/**
 * Resolve which CLI/provider should run a given model id, based on the model
 * registry. Codex runs OpenAI/`gpt-*` models (or anything tagged `agent: 'codex'`);
 * Claude runs everything else (anthropic, plus deepseek ids when the caller
 * already runs inside a claude-deepseek env — see {@link claudeCliServableVendor}).
 *
 * This is the seam that lets headless utility call sites follow their configured
 * model to the right CLI instead of hardcoding `provider: 'claude'`. An unknown
 * or undefined model falls back to 'claude' (with a `gpt-*`/`o<n>` name heuristic
 * for ids not present in the registry).
 */
export function resolveProviderForModel(model?: string, repoDir?: string): LLMProvider {
  if (!model) {
    return 'claude';
  }
  const registry = getEffectiveRegistry(repoDir);
  const entry = getModel(registry, model);
  if (entry?.agent === 'codex' || entry?.vendor === 'openai') {
    return 'codex';
  }
  if (entry) {
    return 'claude';
  }
  // Not in the registry — fall back to a name heuristic.
  return /^(gpt-|o\d|codex)/i.test(model) ? 'codex' : 'claude';
}

// ────────────────────────────────────────────────────────────────
// Text Cleaning Utilities
// ────────────────────────────────────────────────────────────────

/**
 * Strip tool call XML tags and conversational preamble from Claude output.
 *
 * Removes:
 * - <tool_call>...</tool_call> blocks
 * - <tool_name>, <parameters>, and other XML-style tags
 * - Conversational text before the first markdown heading
 */
function stripToolCalls(text: string): string {
  // Remove <tool_call>...</tool_call> blocks (including multiline)
  let cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

  // Remove XML-style tags that Claude sometimes emits
  // Common tags: tool_name, parameters, prompt, command, subagent_type, pattern, file_path, etc.
  cleaned = cleaned.replace(
    /<\/?(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)[^>]*>[\s\S]*?(?:<\/(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)>)?/g,
    ''
  );

  // Strip conversational preamble before the first markdown heading or JSON
  const firstHeading = cleaned.search(/^#\s/m);
  const firstJson = cleaned.search(/\{[\s\n]/);

  if (firstHeading > 0 && (firstJson < 0 || firstHeading < firstJson)) {
    // Markdown content - strip preamble before first heading
    cleaned = cleaned.substring(firstHeading);
  } else if (firstJson > 0 && (firstHeading < 0 || firstJson < firstHeading)) {
    // JSON content - strip preamble before first {
    cleaned = cleaned.substring(firstJson);
  }

  // Collapse runs of 3+ blank lines into 2
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

  return cleaned.trim();
}

// ────────────────────────────────────────────────────────────────
// JSON Envelope Unwrapping
// ────────────────────────────────────────────────────────────────

interface JsonEnvelope {
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * Unwrap JSON envelope from LLM CLI --output-format json.
 *
 * Extracts:
 * - data.result (the actual response text)
 * - data.usage (token counts)
 * - data.total_cost_usd (cost in USD)
 *
 * Falls back to raw output if not valid JSON envelope.
 */
function unwrapJsonEnvelope(raw: string): {
  text: string;
  usage?: LLMCallResult['usage'];
  costUsd?: number;
} {
  try {
    const data: JsonEnvelope = JSON.parse(raw);

    // Extract text from data.result if present
    const text = (data.result || raw).trim();

    // Extract usage if present
    let usage: LLMCallResult['usage'] | undefined;
    if (data.usage) {
      const u = data.usage;
      const inputTokens =
        (u.input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.cache_read_input_tokens || 0);
      const outputTokens = u.output_tokens || 0;
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }

    // Extract cost if present
    const costUsd = data.total_cost_usd;

    return { text, usage, costUsd };
  } catch {
    // If JSON parse fails, treat the entire output as text (fallback)
    return { text: raw.trim() };
  }
}

/**
 * Unwrap Codex `codex exec --json` output.
 *
 * Codex emits a JSONL event stream (one JSON object per line), unlike Claude's
 * single JSON envelope. The shape (codex-cli 0.139.0):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *                                     "output_tokens":N,"reasoning_output_tokens":N}}
 *
 * Extracts:
 * - text: concatenation of all `agent_message` item texts in order (final answer)
 * - usage: from the last `turn.completed` event (codex does not report cost)
 *
 * Falls back to the raw text if no agent_message events are present.
 */
function unwrapCodexJsonl(raw: string): {
  text: string;
  usage?: LLMCallResult['usage'];
  costUsd?: number;
} {
  const messages: string[] = [];
  let usage: LLMCallResult['usage'] | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (e.g. a stray log); skip it.
      continue;
    }

    if (
      event?.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      messages.push(event.item.text);
    } else if (event?.type === 'turn.completed' && event.usage) {
      const u = event.usage;
      // `input_tokens` already includes cached input; `cached_input_tokens` is a
      // subset, so it is not added again. Reasoning tokens are billed as output.
      const inputTokens = u.input_tokens || 0;
      const outputTokens = (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  if (messages.length === 0) {
    // No structured agent message found — fall back to raw output.
    return { text: raw.trim(), usage };
  }

  return { text: messages.join('\n').trim(), usage };
}

// ────────────────────────────────────────────────────────────────
// Provider Configuration
// ────────────────────────────────────────────────────────────────

interface ProviderConfig {
  defaultCmd: string;
  /** Env var to set (or unset if envVarValue is undefined) */
  envVarName: string;
  /** Value to set, or undefined to delete the var from the environment */
  envVarValue: string | undefined;
  defaultArgs: string[];
}

/** Build an env object from process.env with provider-specific overrides */
function buildProviderEnv(config: ProviderConfig, options: LLMCallOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.envVarValue === undefined) {
    delete env[config.envVarName];
  } else {
    env[config.envVarName] = config.envVarValue;
  }
  if (typeof options.maxOutputTokens === 'number' && Number.isFinite(options.maxOutputTokens) && options.maxOutputTokens > 0) {
    // The Claude Code CLI reads this env knob; other providers currently
    // ignore it (setting it is harmless there).
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(options.maxOutputTokens));
  }
  return env;
}

const PROVIDER_CONFIGS: Record<LLMProvider, ProviderConfig> = {
  claude: {
    defaultCmd: 'claude',
    envVarName: 'CLAUDECODE',
    envVarValue: undefined,
    defaultArgs: ['-p', '--output-format', 'json'],
  },
  codex: {
    defaultCmd: 'codex',
    // Unset any inherited CODEX_API_KEY-style recursion guard is unnecessary here;
    // codex exec reads auth from its own config. We only ensure no stray output
    // override leaks in from a parent codex process.
    envVarName: 'CODEX_OUTPUT',
    envVarValue: undefined,
    // `codex exec --json` runs non-interactively and prints JSONL events to stdout.
    // Prompt is read from stdin (we pipe it via `< tmpfile`). read-only sandbox
    // keeps single-shot utility calls from executing model-generated commands.
    defaultArgs: ['exec', '--json', '--sandbox', 'read-only'],
  },
  openai: {
    defaultCmd: 'openai',
    envVarName: 'OPENAI_OUTPUT',
    envVarValue: 'json',
    defaultArgs: ['--format', 'json'],
  },
};

/**
 * Get provider configuration
 */
function getProviderConfig(provider: LLMProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}

/**
 * Get CLI command for provider
 */
function getCliCommand(provider: LLMProvider, options: LLMCallOptions): string {
  if (options.cliCmd) {
    return options.cliCmd;
  }

  const config = getProviderConfig(provider);
  const envVarMap: Record<LLMProvider, string | undefined> = {
    claude: process.env.CLAUDE_CMD,
    codex: process.env.CODEX_CMD,
    openai: process.env.OPENAI_CMD,
  };

  return envVarMap[provider] || config.defaultCmd;
}

// ────────────────────────────────────────────────────────────────
// Execution Modes
// ────────────────────────────────────────────────────────────────

/**
 * Execute LLM CLI in synchronous mode using execSync.
 */
function executeSync(
  tmpFile: string,
  cliArgs: string[],
  options: LLMCallOptions,
  provider: LLMProvider
): string {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const cwd = options.cwd || process.cwd();

  const cliCmd = getCliCommand(provider, options);
  const command = `${escapeShellArg(cliCmd)} ${cliArgs.join(' ')} < ${escapeShellArg(tmpFile)}`;

  const config = getProviderConfig(provider);
  const env = buildProviderEnv(config, options);

  try {
    const raw = execShellCommand(command, {
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      cwd,
      env,
    });

    return raw;
  } catch (error) {
    // Enhanced error handling with specific diagnostics
    const errorMsg = (error as Error).message;
    const promptSize = existsSync(tmpFile) ? readFileSync(tmpFile, 'utf-8').length : 0;
    const classified = classifyLLMError(error);

    // ENOENT - command not found
    if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
      throw new Error(
        `${provider} CLI command not found: ${cliCmd}\n\n` +
        `Command attempted: ${command}\n` +
        `Working directory: ${cwd}\n` +
        `PATH: ${process.env.PATH}\n\n` +
        `Troubleshooting:\n` +
        `  - Install Claude CLI: npm install -g @anthropic-ai/claude-cli\n` +
        `  - Verify installation: which ${cliCmd}\n` +
        `  - Check PATH includes: $(npm bin -g)\n` +
        `  - Run health check: npm run check:review\n`
      );
    }

    // ETIMEDOUT or timeout in message - timeout error
    if (classified.kind === 'timeout') {
      throw new Error(
        `${provider} CLI timed out after ${timeout}ms\n\n` +
        `Command: ${command}\n` +
        `Prompt size: ${promptSize} chars\n\n` +
        `Possible causes:\n` +
        `  - Network connectivity issues\n` +
        `  - Prompt too large for processing\n` +
        `  - Model overloaded or rate limited\n\n` +
        `Troubleshooting:\n` +
        `  - Increase timeout: REVIEW_TIMEOUT=300000 (5 min)\n` +
        `  - Check network: curl -I https://api.anthropic.com\n` +
        `  - Reduce diff size: review in smaller PRs\n` +
        `  - Try again in a few minutes\n`
      );
    }

    // 401 or authentication - auth failure
    if (classified.kind === 'auth') {
      throw new Error(
        `${provider} CLI authentication failed\n\n` +
        `Troubleshooting:\n` +
        `  - Run: ${cliCmd} login\n` +
        `  - Verify auth: echo "test" | ${cliCmd} -p --model claude-haiku-4-5-20251001\n` +
        `  - Check API key: echo $ANTHROPIC_API_KEY\n` +
        `  - Run health check: npm run check:review\n`
      );
    }

    // Rate limit or quota exceeded
    if (classified.kind === 'quota') {
      throw new Error(
        `${provider} CLI rate limit or quota exceeded\n\n` +
        `Troubleshooting:\n` +
        `  - Wait a few minutes and try again\n` +
        `  - Check usage at: https://console.anthropic.com/settings/usage\n` +
        `  - Contact support if issue persists\n`
      );
    }

    // Buffer exceeded
    if (errorMsg.includes('maxBuffer') || errorMsg.includes('stdout maxBuffer')) {
      throw new Error(
        `${provider} CLI output exceeded buffer limit (${maxBuffer} bytes)\n\n` +
        `Possible causes:\n` +
        `  - Diff is very large\n` +
        `  - LLM returned excessive output\n\n` +
        `Troubleshooting:\n` +
        `  - Review diff in smaller PRs\n` +
        `  - Increase buffer: REVIEW_MAX_BUFFER=${maxBuffer * 2}\n`
      );
    }

    // Generic error with full context
    throw new Error(
      `${provider} CLI command failed\n\n` +
      `Command: ${command}\n` +
      `Working directory: ${cwd}\n` +
      `Timeout: ${timeout}ms\n` +
      `Max buffer: ${maxBuffer} bytes\n` +
      `Model: ${options.model || '(default)'}\n` +
      `Prompt size: ${promptSize} chars\n\n` +
      `Error: ${errorMsg}\n\n` +
      `Troubleshooting:\n` +
      `  - Run health check: npm run check:review\n` +
      `  - Enable verbose mode: npx tsx tools/review-changes.ts main --verbose\n` +
      `  - Check system logs for more details\n`
    );
  }
}

/**
 * Execute LLM CLI in streaming mode using spawn.
 */
async function executeStream(
  tmpFile: string,
  cliArgs: string[],
  options: LLMCallOptions,
  provider: LLMProvider,
  attempt: number,
  maxAttempts: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const cwd = options.cwd || process.cwd();
    const cliCmd = getCliCommand(provider, options);

    if (options.signal?.aborted) {
      reject(withElapsed(new Error('LLM call aborted'), 0));
      return;
    }

    const config = getProviderConfig(provider);
    const env = buildProviderEnv(config, options);

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
    };

    const llmProcess = spawn(cliCmd, cliArgs, spawnOptions);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastActivityAt = startedAt; // Track last output activity for diagnostics

    const cleanup = (
      timeoutId?: NodeJS.Timeout,
      slowInterval?: NodeJS.Timeout,
      activityTimeoutId?: NodeJS.Timeout
    ) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (slowInterval) {
        clearInterval(slowInterval);
      }
      if (activityTimeoutId) {
        clearTimeout(activityTimeoutId);
      }
      if (abortListener) {
        options.signal?.removeEventListener('abort', abortListener);
      }
    };

    const abortListener = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(timeoutId, slowInterval, activityTimeoutId);
      llmProcess.kill('SIGTERM');
      reject(withElapsed(new Error('LLM call aborted'), Date.now() - startedAt));
    };

    void options.observer?.onAttemptStart?.({
      provider,
      model: options.model,
      attempt,
      maxAttempts,
      elapsedMs: 0,
    });

    const slowInterval = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < SLOW_CALL_WARNING_MS) {
        return;
      }

      void options.observer?.onAttemptSlow?.({
        provider,
        model: options.model,
        attempt,
        maxAttempts,
        elapsedMs,
      });
    }, SLOW_CALL_REPEAT_MS);

    // Hard timeout (wall-clock cap)
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(timeoutId, slowInterval, activityTimeoutId);
      llmProcess.kill('SIGTERM');
      const elapsedMs = Date.now() - startedAt;
      const timeSinceLastActivity = Date.now() - lastActivityAt;
      const stdoutBytes = Buffer.byteLength(stdout, 'utf-8');
      const wasIdle = timeSinceLastActivity > 30_000; // >30s since last output

      reject(
        withElapsed(new Error(
          `${provider} CLI timed out after ${timeout}ms (hard wall-clock cap)\n\n` +
          `Command: ${cliCmd} ${cliArgs.join(' ')}\n` +
          `Working directory: ${cwd}\n` +
          `Elapsed: ${elapsedMs}ms\n` +
          `Stdout collected: ${stdoutBytes} bytes\n` +
          `Last activity: ${timeSinceLastActivity}ms ago\n` +
          `Process state: ${wasIdle ? 'IDLE (no output for >30s)' : 'ACTIVE (recently producing output)'}\n`
        ), elapsedMs)
      );
    }, timeout);

    // Activity-based timeout (resets on each output)
    let activityTimeoutId: NodeJS.Timeout | undefined;
    const activityTimeout = options.activityTimeout;

    const resetActivityTimeout = () => {
      if (!activityTimeout) {
        return;
      }
      if (activityTimeoutId) {
        clearTimeout(activityTimeoutId);
      }
      activityTimeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(timeoutId, slowInterval, activityTimeoutId);
        llmProcess.kill('SIGTERM');
        const elapsedMs = Date.now() - startedAt;
        const timeSinceLastActivity = Date.now() - lastActivityAt;
        const stdoutBytes = Buffer.byteLength(stdout, 'utf-8');

        reject(
          withElapsed(new Error(
            `${provider} CLI timed out due to inactivity (no output for ${activityTimeout}ms)\n\n` +
            `Command: ${cliCmd} ${cliArgs.join(' ')}\n` +
            `Working directory: ${cwd}\n` +
            `Elapsed: ${elapsedMs}ms\n` +
            `Stdout collected: ${stdoutBytes} bytes\n` +
            `Last activity: ${timeSinceLastActivity}ms ago\n` +
            `Hard timeout cap: ${timeout}ms\n`
          ), elapsedMs)
        );
      }, activityTimeout);
    };

    // Start activity timeout if configured
    if (activityTimeout) {
      resetActivityTimeout();
    }

    options.signal?.addEventListener('abort', abortListener, { once: true });

    llmProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
      lastActivityAt = Date.now(); // Track activity for diagnostics
      resetActivityTimeout(); // Reset activity timeout on output
    });

    llmProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
      lastActivityAt = Date.now(); // Track activity for diagnostics
      resetActivityTimeout(); // Reset activity timeout on output
    });

    llmProcess.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(timeoutId, slowInterval, activityTimeoutId);
      const elapsedMs = Date.now() - startedAt;
      if (code !== 0) {
        reject(withElapsed(new Error(`${provider} CLI exited with code ${code}: ${stderr}`), elapsedMs));
      } else {
        void options.observer?.onAttemptComplete?.({
          provider,
          model: options.model,
          attempt,
          maxAttempts,
          elapsedMs,
        });
        resolve(stdout);
      }
    });

    llmProcess.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(timeoutId, slowInterval, activityTimeoutId);
      const elapsedMs = Date.now() - startedAt;
      reject(withElapsed(new Error(`Failed to spawn ${provider} CLI: ${error.message}`), elapsedMs));
    });

    // Read prompt from temp file and send to stdin
    try {
      const prompt = readFileSync(tmpFile, 'utf-8');
      llmProcess.stdin?.write(prompt);
      llmProcess.stdin?.end();
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(timeoutId, slowInterval, activityTimeoutId);
      reject(withElapsed(new Error(`Failed to read temp file: ${(error as Error).message}`), Date.now() - startedAt));
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Health Check
// ────────────────────────────────────────────────────────────────

/**
 * Check if Claude CLI is available and working.
 *
 * Performs three checks:
 * 1. Is 'claude' command in PATH?
 * 2. Can we get version info?
 * 3. Can we make a simple test call?
 *
 * @param options - Check options
 * @returns Health check result with diagnostics
 *
 * @example
 * ```typescript
 * const health = await checkClaudeAvailability({ verbose: true });
 * if (!health.available) {
 *   console.error('Claude CLI not available:', health.error);
 *   console.error('Diagnostics:', health.diagnostics);
 * }
 * ```
 */
/**
 * Provider-specific knobs for the generic availability check.
 */
interface CliAvailabilitySpec {
  /** Human-facing label, e.g. "Claude" or "Codex" */
  label: string;
  /** Build the headless test-call command (a single trivial round-trip). */
  buildTestCommand: (cliCmd: string, tmpFile: string) => string;
}

const CLI_AVAILABILITY_SPECS: Record<LLMProvider, CliAvailabilitySpec> = {
  claude: {
    label: 'Claude',
    buildTestCommand: (cliCmd, tmpFile) =>
      `${escapeShellArg(cliCmd)} -p --output-format json --model claude-haiku-4-5-20251001 < ${escapeShellArg(tmpFile)}`,
  },
  codex: {
    label: 'Codex',
    buildTestCommand: (cliCmd, tmpFile) =>
      `${escapeShellArg(cliCmd)} exec --json --sandbox read-only --model gpt-5.6-terra < ${escapeShellArg(tmpFile)}`,
  },
  openai: {
    label: 'OpenAI',
    buildTestCommand: (cliCmd, tmpFile) =>
      `${escapeShellArg(cliCmd)} --format json < ${escapeShellArg(tmpFile)}`,
  },
};

/**
 * Ceiling for the availability probe's live test call. A trivial `claude -p`
 * takes 20–40s on a loaded host (API latency plus project hooks in a task
 * worktree), so a fixed 30s ceiling failed every review there as
 * `review-tool-error` even though the CLI worked. Override with
 * `WAVEMILL_CLI_PREFLIGHT_TIMEOUT_MS`.
 */
export const DEFAULT_CLI_PREFLIGHT_TIMEOUT_MS = 90_000;

export function resolveCliPreflightTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.WAVEMILL_CLI_PREFLIGHT_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CLI_PREFLIGHT_TIMEOUT_MS;
}

/**
 * Generic CLI availability probe: PATH → version → trivial round-trip.
 * Provider-agnostic; see {@link checkClaudeAvailability} / {@link checkCodexAvailability}.
 */
async function checkCliAvailability(
  provider: LLMProvider,
  options: { verbose?: boolean } = {}
): Promise<CliHealthCheck> {
  const verbose = options.verbose ?? false;
  const cliCmd = getCliCommand(provider, {});
  const { label, buildTestCommand } = CLI_AVAILABILITY_SPECS[provider];

  if (verbose) {
    console.error(`Checking ${label} CLI availability (command: ${cliCmd})...`);
  }

  // Check 1: Is command in PATH?
  let inPath = false;
  try {
    const whichResult = execShellCommand(`which ${escapeShellArg(cliCmd)}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    inPath = whichResult.toString().trim().length > 0;
    if (verbose) {
      console.error(`  ✓ Command found in PATH: ${whichResult.toString().trim()}`);
    }
  } catch (error) {
    if (verbose) {
      console.error(`  ✗ Command not found in PATH`);
    }
    return {
      available: false,
      command: cliCmd,
      error: `${label} CLI command '${cliCmd}' not found in PATH`,
      diagnostics: {
        inPath: false,
        executable: false,
      },
    };
  }

  // Check 2: Can we get version?
  let version: string | undefined;
  let executable = false;
  try {
    const versionResult = execShellCommand(`${escapeShellArg(cliCmd)} --version`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    version = versionResult.toString().trim();
    executable = true;
    if (verbose) {
      console.error(`  ✓ Version: ${version}`);
    }
  } catch (error) {
    if (verbose) {
      console.error(`  ✗ Could not get version: ${(error as Error).message}`);
    }
    return {
      available: false,
      command: cliCmd,
      error: `${label} CLI found but not executable: ${(error as Error).message}`,
      diagnostics: {
        inPath,
        executable: false,
      },
    };
  }

  // Check 3: Can we make a simple test call?
  let authWorking = false;
  try {
    const testPrompt = 'test';
    const tmpFile = join(tmpdir(), `wavemill-health-${Date.now()}.txt`);

    try {
      writeFileSync(tmpFile, testPrompt, 'utf-8');

      execShellCommand(buildTestCommand(cliCmd, tmpFile), {
        encoding: 'utf-8',
        timeout: resolveCliPreflightTimeoutMs(),
        maxBuffer: 1024 * 1024,
        env: buildProviderEnv(getProviderConfig(provider)),
      });

      // If we got here, the test call succeeded
      authWorking = true;
      if (verbose) {
        console.error(`  ✓ Test call succeeded (auth working)`);
      }
    } finally {
      if (existsSync(tmpFile)) {
        try {
          unlinkSync(tmpFile);
        } catch {
          // Best effort cleanup
        }
      }
    }
  } catch (error) {
    const errorMsg = (error as Error).message;
    if (verbose) {
      console.error(`  ✗ Test call failed: ${errorMsg}`);
    }

    // Check if it's an auth error
    if (errorMsg.includes('401') || errorMsg.includes('authentication') || errorMsg.includes('unauthorized')) {
      return {
        available: false,
        command: cliCmd,
        version,
        error: `${label} CLI authentication failed. Run '${cliCmd} login' to authenticate.`,
        diagnostics: {
          inPath,
          executable,
          authWorking: false,
        },
      };
    }

    // Other error
    return {
      available: false,
      command: cliCmd,
      version,
      error: `${label} CLI test call failed: ${errorMsg}`,
      diagnostics: {
        inPath,
        executable,
        authWorking: false,
      },
    };
  }

  // All checks passed
  if (verbose) {
    console.error(`\n✓ ${label} CLI is available and working`);
  }

  return {
    available: true,
    command: cliCmd,
    version,
    diagnostics: {
      inPath,
      executable,
      authWorking,
    },
  };
}

export async function checkClaudeAvailability(
  options: { verbose?: boolean } = {}
): Promise<CliHealthCheck> {
  return checkCliAvailability('claude', options);
}

export async function checkCodexAvailability(
  options: { verbose?: boolean } = {}
): Promise<CliHealthCheck> {
  return checkCliAvailability('codex', options);
}

interface PreflightReporter {
  emit(event: { event: string; message: string; level?: 'info' | 'warn' | 'error'; details?: Record<string, unknown> }): Promise<void>;
}

const PREFLIGHT_TROUBLESHOOTING: Record<LLMProvider, string[]> = {
  claude: [
    '  1. Install Claude CLI: npm install -g @anthropic-ai/claude-cli',
    '  2. Authenticate: claude login',
    '  3. Test: echo "hello" | claude -p --model claude-haiku-4-5-20251001',
    '  4. Check PATH: which claude',
  ],
  codex: [
    '  1. Install Codex CLI: brew install codex (or npm install -g @openai/codex)',
    '  2. Authenticate: codex login',
    '  3. Test: echo "hello" | codex exec --json --sandbox read-only',
    '  4. Check PATH: which codex',
  ],
  openai: [
    '  1. Install the OpenAI CLI',
    '  2. Authenticate per provider instructions',
    '  3. Check PATH: which openai',
  ],
};

/**
 * Provider-agnostic preflight: throws with actionable diagnostics if the CLI is
 * not available/working. See {@link ensureClaudeAvailable} / {@link ensureCodexAvailable}.
 */
async function ensureCliAvailable(
  provider: LLMProvider,
  options: { verbose?: boolean; reporter?: PreflightReporter } = {}
): Promise<void> {
  const reporter = options.reporter;
  const { label } = CLI_AVAILABILITY_SPECS[provider];

  await reporter?.emit({
    event: 'preflight_start',
    message: `Checking ${label} CLI availability`,
  });

  const healthCheck = await checkCliAvailability(provider, { verbose: options.verbose });

  if (!healthCheck.available) {
    const errorLines = [
      `${label} CLI is not available or not working properly.`,
      '',
      `Error: ${healthCheck.error}`,
      '',
      'Diagnostics:',
      `  - Command: ${healthCheck.command}`,
      `  - In PATH: ${healthCheck.diagnostics?.inPath ? 'Yes' : 'No'}`,
      `  - Executable: ${healthCheck.diagnostics?.executable ? 'Yes' : 'No'}`,
      `  - Auth working: ${healthCheck.diagnostics?.authWorking ? 'Yes' : 'No'}`,
    ];

    if (healthCheck.version) {
      errorLines.push(`  - Version: ${healthCheck.version}`);
    }

    errorLines.push(
      '',
      'Troubleshooting:',
      ...PREFLIGHT_TROUBLESHOOTING[provider],
      '',
      'To skip this check (not recommended): SKIP_PREFLIGHT_CHECK=1'
    );

    await reporter?.emit({
      event: 'error',
      level: 'error',
      message: `${label} CLI preflight failed`,
      details: { command: healthCheck.command },
    });

    throw new Error(errorLines.join('\n'));
  }

  await reporter?.emit({
    event: 'preflight_ok',
    message: `${label} CLI is available`,
    details: {
      command: healthCheck.command,
      version: healthCheck.version,
    },
  });
}

export async function ensureClaudeAvailable(
  options: { verbose?: boolean; reporter?: PreflightReporter } = {}
): Promise<void> {
  return ensureCliAvailable('claude', options);
}

export async function ensureCodexAvailable(
  options: { verbose?: boolean; reporter?: PreflightReporter } = {}
): Promise<void> {
  return ensureCliAvailable('codex', options);
}

// ────────────────────────────────────────────────────────────────
// Main API
// ────────────────────────────────────────────────────────────────

/**
 * Call LLM CLI with the given prompt.
 *
 * Features:
 * - Multi-provider support (Claude, Codex, OpenAI)
 * - Supports both sync (execSync) and stream (spawn) modes
 * - Temp file management for large prompts
 * - Configurable timeout, buffer limits, model
 * - JSON envelope unwrapping (data.result, usage extraction)
 * - Optional retry with exponential backoff
 * - Tool-call/XML tag stripping
 * - Provider-specific env injection
 *
 * @param prompt - The prompt to send to the LLM
 * @param options - Configuration options
 * @returns Result with cleaned text, usage, cost, and the model that actually answered
 *
 * @example
 * ```typescript
 * // Claude (default provider)
 * const result = await callLLM('Explain quantum computing', {
 *   mode: 'sync',
 *   model: 'claude-opus-4-6',
 *   timeout: 30000,
 *   retry: true,
 * });
 * console.log(result.text);
 * ```
 *
 * @example
 * ```typescript
 * // Codex provider (codex exec --json, JSONL output)
 * const result = await callLLM(prompt, {
 *   provider: 'codex',
 *   mode: 'sync',
 *   model: 'gpt-5.5',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Custom CLI flags
 * const result = await callLLM(prompt, {
 *   provider: 'claude',
 *   cliFlags: ['--tools', '', '--append-system-prompt', 'Be concise.'],
 * });
 * ```
 */
export async function callLLM(
  prompt: string,
  options: LLMCallOptions = {}
): Promise<LLMCallResult> {
  const provider = options.provider || 'claude';
  const retry = options.retry ?? false;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const useFallback = Boolean(options.taskType || options.fallbackModels?.length);

  if (useFallback) {
    return callLLMWithFallback(prompt, options, provider, maxRetries);
  }

  if (retry) {
    return callLLMWithRetry(prompt, options, provider, maxRetries);
  }

  return callLLMOnce(prompt, options, provider);
}

/**
 * Backward compatibility: callClaude() is an alias for callLLM() with provider='claude'
 */
export async function callClaude(
  prompt: string,
  options: Omit<LLMCallOptions, 'provider'> = {}
): Promise<LLMCallResult> {
  return callLLM(prompt, { ...options, provider: 'claude' });
}

/**
 * Internal: Single LLM CLI call without retry.
 */
async function callLLMOnce(
  prompt: string,
  options: LLMCallOptions,
  provider: LLMProvider,
  attempt: number = 1,
  maxAttempts: number = 1
): Promise<LLMCallResult> {
  const mode = options.mode || 'sync';
  const stripCalls = options.stripToolCalls ?? true;
  const startedAt = Date.now();

  // Create temp file for prompt
  const tmpFile = join(tmpdir(), `wavemill-${provider}-${Date.now()}-${randomUUID()}.txt`);

  try {
    writeFileSync(tmpFile, prompt, 'utf-8');

    // Build CLI arguments
    const config = getProviderConfig(provider);
    const cliArgs = [...config.defaultArgs];

    // Add model if specified
    if (options.model) {
      cliArgs.push('--model', options.model);
    }

    // Add custom CLI flags
    if (options.cliFlags && options.cliFlags.length > 0) {
      cliArgs.push(...options.cliFlags);
    }

    // Execute based on mode
    let rawOutput: string;
    if (mode === 'sync') {
      await options.observer?.onAttemptStart?.({
        provider,
        model: options.model,
        attempt,
        maxAttempts,
        elapsedMs: 0,
      });
      rawOutput = executeSync(tmpFile, cliArgs, options, provider);
      await options.observer?.onAttemptComplete?.({
        provider,
        model: options.model,
        attempt,
        maxAttempts,
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      rawOutput = await executeStream(tmpFile, cliArgs, options, provider, attempt, maxAttempts);
    }

    // Unwrap provider output: Claude/OpenAI emit a single JSON envelope; Codex
    // emits a JSONL event stream.
    const { text: unwrappedText, usage, costUsd } =
      provider === 'codex' ? unwrapCodexJsonl(rawOutput) : unwrapJsonEnvelope(rawOutput);

    // Strip tool calls if enabled
    const cleanedText = stripCalls ? stripToolCalls(unwrappedText) : unwrappedText;

    return {
      text: cleanedText,
      usage,
      costUsd,
      rawOutput,
      provider,
      model: options.model || '(default)',
    };
  } catch (error) {
    throw withElapsed(error as Error, getElapsed(error) || Date.now() - startedAt);
  } finally {
    // Clean up temp file
    if (existsSync(tmpFile)) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/**
 * Internal: LLM CLI call with retry logic and exponential backoff.
 */
async function callLLMWithRetry(
  prompt: string,
  options: LLMCallOptions,
  provider: LLMProvider,
  maxRetries: number
): Promise<LLMCallResult> {
  let lastError: Error | null = null;
  const totalAttempts = maxRetries + 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLMOnce(prompt, options, provider, attempt + 1, totalAttempts);
    } catch (error) {
      lastError = error as Error;
      const classified = classifyLLMError(lastError);
      const willRetry = attempt < maxRetries && (classified.kind === 'transient' || classified.kind === 'timeout');
      await options.observer?.onAttemptError?.({
        provider,
        model: options.model,
        attempt: attempt + 1,
        maxAttempts: totalAttempts,
        elapsedMs: getElapsed(lastError),
        error: lastError.message.split('\n')[0],
        willRetry,
      });

      if (classified.kind === 'quota') {
        throw lastError;
      }

      if (willRetry) {
        // Exponential backoff: 2s, 4s, 8s, ...
        const delay = Math.pow(2, attempt + 1) * 1000;
        await options.observer?.onRetry?.({
          provider,
          model: options.model,
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: totalAttempts,
          elapsedMs: 0,
          delayMs: delay,
          error: lastError.message.split('\n')[0],
          willRetry: true,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        break;
      }
    }
  }

  throw new Error(
    `${provider} CLI call failed after ${maxRetries + 1} attempts\n\n` +
    `Last error: ${lastError?.message}\n\n` +
    `Troubleshooting:\n` +
    `  - Run health check: npm run check:review\n` +
    `  - Enable verbose mode: npx tsx tools/review-changes.ts main --verbose\n` +
    `  - Check if service is experiencing issues: https://status.anthropic.com\n`
  );
}

async function callLLMWithFallback(
  prompt: string,
  options: LLMCallOptions,
  provider: LLMProvider,
  maxRetries: number
): Promise<LLMCallResult> {
  const startedAt = Date.now();
  const repoDir = repoDirForOptions(options);
  const resolved = resolveCandidateModels(provider, options);
  const taskType = resolved.taskType;
  if (hasFallbackDeadline(options)) {
    // Budgeted (classifier) ladders surface every pre-attempt skip so a mill
    // log shows why a candidate never ran. Unbudgeted calls stay quiet: every
    // ordinary claude call would otherwise log that the gpt-* rungs were filtered.
    for (const { model, reason } of resolved.skipped) {
      console.warn(`[${fallbackLogLabel(taskType)}] ${model} skipped (${reason})`);
    }
  }
  const candidates = filterCandidatesWithCredentials(resolved.candidates, provider, options, taskType);
  const retry = options.retry ?? false;
  const shouldLogFallbackEvents = options.logFallbackEvents !== false;
  const preferredModel = candidates[0] ?? options.model ?? '(unknown)';

  if (candidates.length === 0) {
    if (shouldEnforceClassifierProviderCredentials(options) || hasFallbackDeadline(options)) {
      throw new Error(`No eligible ${taskType} fallback candidates remained within the configured classifier budget`);
    }
    return retry
      ? callLLMWithRetry(prompt, options, provider, maxRetries)
      : callLLMOnce(prompt, options, provider);
  }

  const fallbackChain: Array<{ model: string; reason: string }> = [];
  const exhausted: Array<{ model: string; resetAt: string | null }> = [];
  let lastError: unknown;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const attemptTimeout = fallbackAttemptTimeout(options);
    if (attemptTimeout === null) {
      throw new Error(`LLM fallback deadline exhausted before ${candidate}`);
    }
    const candidateOptions: LLMCallOptions = {
      ...options,
      model: candidate,
      repoDir,
      ...(attemptTimeout === undefined ? {} : { timeout: attemptTimeout }),
    };

    try {
      const result = retry
        ? await callLLMWithRetry(prompt, candidateOptions, provider, maxRetries)
        : await callLLMOnce(prompt, candidateOptions, provider);

      recordSuccess({ modelId: candidate }, repoDir);
      if (fallbackChain.length > 0 && shouldLogFallbackEvents) {
        emitFallbackEvent({
          prompt,
          preferredModel,
          fallbackModel: candidate,
          taskType,
          difficulty: options.difficulty,
          repoDir,
          outcome: 'success',
          fallbackChain,
          startedAt,
          endedAt: Date.now(),
          costUsd: result.costUsd ?? null,
        }, options.featureDir);
      }
      return {
        ...result,
        model: candidate,
        fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
      };
    } catch (error) {
      lastError = error;
      const classified = classifyLLMError(error);
      if (!classified.retryable) {
        if (fallbackChain.length > 0 && shouldLogFallbackEvents) {
          emitFallbackEvent({
            prompt,
            preferredModel,
            fallbackModel: null,
            taskType,
            difficulty: options.difficulty,
            repoDir,
            outcome: 'non_quota_error',
            fallbackChain,
            startedAt,
            endedAt: Date.now(),
            costUsd: null,
          }, options.featureDir);
        }
        throw error;
      }

      fallbackChain.push({ model: candidate, reason: classified.reason });
      const nextModel = candidates[index + 1];

      if (classified.kind === 'quota') {
        markExhausted({
          modelId: candidate,
          reason: classified.reason,
          resetAt: classified.resetAt,
        }, repoDir);
        exhausted.push({ model: candidate, resetAt: classified.resetAt });

        await options.observer?.onQuotaFallback?.({
          failedModel: candidate,
          nextModel,
          reason: classified.reason,
          resetAt: classified.resetAt,
        });
      }

      if (!options.observer?.onQuotaFallback || classified.kind !== 'quota') {
        fallbackLog({
          taskType,
          failedModel: candidate,
          nextModel: nextModel ?? null,
          reason: classified.reason,
          resetAt: classified.resetAt,
          exhaustedChain: nextModel ? undefined : fallbackChain.map(({ model }) => model),
        });
      }
    }
  }

  if (fallbackChain.length > 0 && shouldLogFallbackEvents) {
    emitFallbackEvent({
      prompt,
      preferredModel,
      fallbackModel: null,
      taskType,
      difficulty: options.difficulty,
      repoDir,
      outcome: 'all_exhausted',
      fallbackChain,
      startedAt,
      endedAt: Date.now(),
      costUsd: null,
    }, options.featureDir);
  }

  if (!options.observer?.onQuotaFallback && exhausted.length > 0) {
    const lastExhausted = exhausted[exhausted.length - 1];
    fallbackLog({
      taskType,
      failedModel: lastExhausted.model,
      nextModel: null,
      reason: 'quota',
      resetAt: lastExhausted.resetAt,
      exhaustedChain: exhausted.map(({ model }) => model),
    });
  }

  if (fallbackChain.length > 0 && exhausted.length !== fallbackChain.length) {
    const lastErrorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `All fallback candidates failed: ${
        fallbackChain.map(({ model, reason }) => `${model} (${reason})`).join(', ')
      }. Last error: ${lastErrorMessage}`
    );
  }

  throw new LLMQuotaError(
    `All fallback models were quota exhausted: ${
      exhausted.map(({ model, resetAt }) => `${model}${resetAt ? ` (resetAt=${resetAt})` : ''}`).join(', ')
    }`,
    {
      modelId: exhausted[exhausted.length - 1]?.model ?? options.model ?? '(unknown)',
      reason: 'quota',
      resetAt: exhausted[exhausted.length - 1]?.resetAt ?? null,
    },
  );
}

// ────────────────────────────────────────────────────────────────
// JSON Parsing Utilities
// ────────────────────────────────────────────────────────────────

/**
 * Parse JSON from LLM output using a 4-strategy approach.
 *
 * Strategies (in order):
 * 1. Strip markdown code fences (```json...```)
 * 2. Strip tool_call/XML tags
 * 3. Find first complete JSON object using brace-depth tracking
 * 4. Fallback to raw JSON.parse
 *
 * This consolidates all the different JSON extraction patterns found
 * across the codebase into a single, robust implementation.
 *
 * @param text - Raw text output from LLM
 * @returns Parsed JSON object
 * @throws Error if JSON parsing fails after all strategies
 *
 * @example
 * ```typescript
 * const result = parseJsonFromLLM<{ score: number }>(llmOutput);
 * console.log(result.score);
 * ```
 */
export function parseJsonFromLLM<T = any>(text: string): T {
  let cleaned = text.trim();
  let cleanedBeforeJsonExtraction = cleaned;

  // Strategy 1: Strip markdown code fences
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```\s*$/m, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```\s*$/m, '');
  }

  // Strategy 2: Strip tool_call/XML tags
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  cleaned = cleaned.replace(
    /<\/?(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)[^>]*>/g,
    ''
  );
  cleanedBeforeJsonExtraction = cleaned;

  // Strategy 3: Find first complete JSON object using brace-depth tracking
  // This is the most robust approach for extracting JSON from mixed content
  let braceDepth = 0;
  let jsonStart = -1;
  let jsonEnd = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (char === '{') {
      if (braceDepth === 0) {
        jsonStart = i;
      }
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0 && jsonStart >= 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd);
  }

  if (hasJavaScriptAssignmentWrapper(cleanedBeforeJsonExtraction, jsonStart)) {
    throw new Error(
      `LLM returned JavaScript code instead of JSON.\n\nFirst 500 chars:\n${cleaned.substring(0, 500)}`
    );
  }

  // Strategy 4: Fallback to raw JSON.parse
  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    const errorMsg = (error as Error).message;
    const preview = cleaned.substring(0, 500);
    if (looksLikeJavaScriptInsteadOfJson(cleaned, cleanedBeforeJsonExtraction, jsonStart)) {
      throw new Error(
        `LLM returned JavaScript code instead of JSON.\n\nFirst 500 chars:\n${preview}`
      );
    }
    throw new Error(
      `Failed to parse JSON from LLM output: ${errorMsg}\n\nFirst 500 chars:\n${preview}`
    );
  }
}

function looksLikeJavaScriptInsteadOfJson(jsonCandidate: string, originalText: string, jsonStart: number): boolean {
  const identifier = '[a-zA-Z_$][a-zA-Z0-9_$]*';
  const jsObjectPatterns = [
    new RegExp(`\\{\\s*${identifier}\\s*[,}]`),       // { identifier } or { identifier,
    new RegExp(`[{,]\\s*${identifier}\\s*:`),         // { identifier: value
    new RegExp(`[{,]\\s*\\.\\.\\.${identifier}`),     // { ...rest } or , ...rest
    /=>/,                                             // arrow function
  ];

  return (
    jsObjectPatterns.some((pattern) => pattern.test(jsonCandidate)) ||
    hasJavaScriptAssignmentWrapper(originalText, jsonStart)
  );
}

function hasJavaScriptAssignmentWrapper(text: string, jsonStart: number): boolean {
  if (jsonStart === 0) {
    return false;
  }

  const prefix = jsonStart > 0 ? text.substring(0, jsonStart) : text;
  return /\b(?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=/.test(prefix);
}
