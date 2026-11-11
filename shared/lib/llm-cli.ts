/**
 * `callLLM` policy layer (HOK-3460).
 *
 * Owns the candidate ladder, credential-free quota state, retry and backoff,
 * fallback events, the observer bridge, tool-call stripping and the
 * `LLMCallResult` shape. The model transports themselves — spawn, argv, env,
 * ownership, stdout/JSONL parse, error classification and vendor
 * compatibility — live in `model-adapters/`; every attempt calls that
 * transport's adapter (see `adapterForProvider`).
 *
 * - Both sync (execSync) and stream (spawn) modes are adapter runner modes.
 * - Optional retry with exponential backoff.
 * - Task-specific cross-model fallback for hard quota errors.
 * - Provider availability/health probes.
 *
 * @module llm-cli
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { attachFallbackEvent } from './eval-record-builder.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { loadTraceContext, appendTraceEvent } from './trace-event.ts';
import { SCHEMA_VERSION, getScoreBand, type DifficultyBand, type EvalRecord, type FallbackEventMetadata, type FallbackOutcome } from './eval-schema.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { getEffectiveRegistry, getLadder, rankCandidates, type RegistryTaskType } from './model-registry.ts';
import { getModelStatus, markExhausted, readQuotaSnapshot, recordSuccess } from './quota-state.ts';
import { filterDisabledModels } from './disabled-models.ts';
import { fallbackLog } from './router-log.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { adapterForProvider } from './model-adapters/resolve-adapter.ts';
import {
  classifyCliMessage,
  retryPolicyFor,
  type RetryPolicy,
} from './model-adapters/cli-error-classifier.ts';
import {
  claudeCliCommand,
  claudeCliEnv,
  claudeCliAvailabilityCommand,
} from './model-adapters/claude-cli-adapter.ts';
import {
  codexCliCommand,
  codexCliEnv,
  codexCliAvailabilityCommand,
} from './model-adapters/codex-cli-adapter.ts';
import type { AdapterError } from './model-adapters/transport-adapter.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Supported LLM CLI providers. Each maps to one transport in
 * `model-adapters/` (HOK-3460).
 */
export type LLMProvider = 'claude' | 'codex';

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
  /**
   * Feature directory for trace event emission (HOK-2259). When set, the call
   * also records its Claude Code / Codex session in the task's
   * `.session-ownership.jsonl` as `helper:<helperPurpose>` (HOK-3328), so its
   * cost is the task's and it is never mislabelled as a stage session.
   */
  featureDir?: string;
  /** Helper purpose for the ownership row; defaults to `taskType`, else `llm-call`. */
  helperPurpose?: string;
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
  /**
   * Model id the CLI itself reported in its output (HOK-3247), when it reports
   * one. The claude CLI's `--output-format json` envelope carries a
   * `modelUsage` map keyed by the model(s) that served the turn; `codex exec
   * --json` reports no model, so this stays undefined for codex. Unlike
   * `model` (the id the CLI was *asked* for), this is execution evidence.
   */
  reportedModel?: string;
  /** Models skipped due to quota exhaustion before success */
  fallbackChain?: Array<{ model: string; reason: string }>;
  /**
   * Owned claude CLI session id minted for this call (HOK-3328, HOK-3448).
   * Present when the call was launched with a featureDir and no session
   * selection flags. The adapter uses this to bind a verbose tool report.
   */
  sessionRef?: string;
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

/** A thrown call error that carries the adapter's typed classification. */
interface AdapterBackedError extends ObservedError {
  adapterError?: AdapterError;
}

/**
 * The retry/fallback policy for a thrown call error. Adapter-produced errors
 * carry their `AdapterError`; anything else (deadline, retry exhaustion) is
 * classified by the shared message classifier, never a private copy.
 */
function retryPolicyForThrown(error: unknown): RetryPolicy {
  const adapterError = (error as AdapterBackedError)?.adapterError;
  if (adapterError) return retryPolicyFor(adapterError);
  return retryPolicyFor(classifyCliMessage(error instanceof Error ? error.message : String(error)));
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
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
  const skipped: SkippedCandidate[] = [];
  const isServable = (modelId: string): boolean => {
    // The transport adapter owns vendor compatibility (HOK-3460).
    const reason = adapterForProvider(provider, { model: modelId, repoDir, failClosed: false })
      .incompatibilityReason(modelId);
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
// Claude CLI stdout interpretation
// ────────────────────────────────────────────────────────────────

// Re-exported for existing tests; the implementation lives in the single
// claude-cli-output boundary (HOK-3448).
export { reportedModelFromEnvelope } from './model-adapters/claude-cli-output.ts';
// The codex JSONL event-stream reader lives in the codex adapter (HOK-3460).
export { codexThreadIdFromJsonl } from './model-adapters/codex-cli-adapter.ts';
export { claudeCliServableVendor } from './model-adapters/claude-cli-adapter.ts';

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
  /** Resolve the CLI executable (`<PROVIDER>_CMD` → binary name). */
  command: () => string;
  /** Environment for the probe call, owned by the transport adapter. */
  env: () => NodeJS.ProcessEnv;
  /** Build the headless test-call command (a single trivial round-trip). */
  buildTestCommand: (cliCmd: string, tmpFile: string) => string;
}

/**
 * Per-transport probe knobs. The test command and env both come from the
 * transport's adapter (HOK-3460), so a probe cannot drift from a real call.
 */
const CLI_AVAILABILITY_SPECS: Record<LLMProvider, CliAvailabilitySpec> = {
  claude: {
    label: 'Claude',
    command: claudeCliCommand,
    env: () => claudeCliEnv(),
    buildTestCommand: claudeCliAvailabilityCommand,
  },
  codex: {
    label: 'Codex',
    command: codexCliCommand,
    env: () => codexCliEnv(),
    buildTestCommand: codexCliAvailabilityCommand,
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
  const { label, command, env, buildTestCommand } = CLI_AVAILABILITY_SPECS[provider];
  const cliCmd = command();

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
        env: env(),
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
 * - Two CLI transports (Claude, Codex); spawn/argv/parse live in `model-adapters/`
 * - Both sync (blocking) and stream (spawn) adapter modes
 * - Configurable timeout, buffer limits, model
 * - Optional retry with exponential backoff
 * - Task-specific cross-model fallback on quota errors
 * - Tool-call/XML tag stripping
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
 *
 * The transport (argv, env, spawn, ownership, stdout parse, error classify)
 * belongs to the provider's adapter; this function owns the policy around it —
 * attempt observers, tool-call stripping and the `LLMCallResult` shape.
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

  // Isolate classifier spawns from the interactive agent harness (HOK-3202).
  const isolate = provider === 'claude' && options.taskType === 'classify';

  const adapter = adapterForProvider(provider, {
    model: options.model ?? '',
    repoDir: repoDirForOptions(options),
  });

  await options.observer?.onAttemptStart?.({
    provider,
    model: options.model,
    attempt,
    maxAttempts,
    elapsedMs: 0,
  });

  let result;
  try {
    result = await adapter.invoke(prompt, {
      mode,
      timeout: options.timeout,
      maxOutputTokens: options.maxOutputTokens,
      signal: options.signal,
      cwd: options.cwd,
      activityTimeout: options.activityTimeout,
      maxBuffer: options.maxBuffer,
      cliCmd: options.cliCmd,
      cliFlags: options.cliFlags,
      isolate,
      // The ladder has never refused a call on token projection; preflight is
      // the adapters' own (HOK-3460).
      skipPreflight: true,
      ownership: options.featureDir
        ? {
            featureDir: options.featureDir,
            helperPurpose: options.helperPurpose ?? options.taskType ?? 'llm-call',
          }
        : undefined,
      onSlow: (elapsedMs) => {
        void options.observer?.onAttemptSlow?.({
          provider,
          model: options.model,
          attempt,
          maxAttempts,
          elapsedMs,
        });
      },
    });
  } catch (error) {
    throw withElapsed(error as Error, getElapsed(error) || Date.now() - startedAt);
  }

  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    throw withElapsed(
      Object.assign(new Error(result.error.message), { adapterError: result.error }),
      elapsedMs,
    );
  }

  await options.observer?.onAttemptComplete?.({
    provider,
    model: options.model,
    attempt,
    maxAttempts,
    elapsedMs,
  });

  // Strip tool calls if enabled
  const cleanedText = stripCalls ? stripToolCalls(result.text) : result.text;

  return {
    text: cleanedText,
    ...(result.usage
      ? {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          },
        }
      : {}),
    ...((result.costUsd ?? result.usage?.costUsd) !== undefined
      ? { costUsd: (result.costUsd ?? result.usage?.costUsd)! }
      : {}),
    rawOutput: result.rawOutput ?? '',
    provider,
    model: options.model || '(default)',
    ...(result.reportedModel && result.reportedModel !== 'unverified'
      ? { reportedModel: result.reportedModel }
      : {}),
    ...(result.sessionRef ? { sessionRef: result.sessionRef } : {}),
  };
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
      const classified = retryPolicyForThrown(lastError);
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
  // Both CLI transports own their own auth; no candidate is gated on a
  // credential env var (the legacy openai gate went with that provider).
  const candidates = resolved.candidates;
  const retry = options.retry ?? false;
  const shouldLogFallbackEvents = options.logFallbackEvents !== false;
  const preferredModel = candidates[0] ?? options.model ?? '(unknown)';

  if (candidates.length === 0) {
    // A budgeted call fails loudly rather than making one unbudgeted attempt.
    if (hasFallbackDeadline(options)) {
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
      const classified = retryPolicyForThrown(error);
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
