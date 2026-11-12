/**
 * Codex CLI transport adapter (HOK-3248, HOK-3460).
 *
 * Declares the 1,048,576-character input cap that `codex exec` imposes (HOK-
 * 3248 problem 2) alongside the usual context-window check, owns the
 * `codex exec --json` argv/env/ownership, parses the JSONL event stream the
 * CLI emits on success, and classifies codex-specific error strings (char-cap
 * rejection, rate limits) at parse time.
 */
import { getEffectiveRegistry, getModel } from '../model-registry.ts';
import { escapeShellArg } from '../shell-utils.ts';
import {
  appendSessionRefResolution,
  helperKind,
  newSessionRef,
  pendingSessionRef,
  recordLaunch,
} from '../session-ownership.ts';
import {
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  policyKindFor,
  CLI_SESSION_SELECTION_FLAGS,
  type AdapterError,
  type AdapterInvokeOptions,
  type AdapterInvokeResult,
  type AdapterLimits,
  type AdapterParseResult,
  type AdapterUsage,
  type CliTransportAdapter,
} from './transport-adapter.ts';
import { estimateTokensWithBytesPerToken } from './token-estimator.ts';
import { estimatePromptTokens, evaluateContextWindow } from '../native-agent/context-window-guard.ts';
import { classifyCliMessage, withTransientRetry } from './cli-error-classifier.ts';
import { runCliProcess } from './cli-process.ts';

/** Hard character cap `codex exec` imposes on its input (observed in production). */
export const CODEX_CLI_MAX_INPUT_CHARS = 1_048_576;

/**
 * Codex-side bytes-per-token (conservative default). Codex `turn.completed`
 * does not report `model` to calibrate against, so 3.0 is the sane fallback.
 * Overridable with `WAVEMILL_TOKEN_BYTES_CODEX`.
 */
export const BYTES_PER_TOKEN_CODEX_DEFAULT = 3.0;

/** Tokens the codex CLI harness adds on top of the user prompt. */
export const CODEX_CLI_HARNESS_OVERHEAD_TOKENS = 20_000;

/**
 * Default argv for a single-shot JSON run. `codex exec --json` prints JSONL
 * events to stdout and reads the prompt from stdin; `--sandbox read-only`
 * keeps utility calls from executing model-generated commands.
 */
export const CODEX_CLI_DEFAULT_ARGS: readonly string[] = [
  'exec',
  '--json',
  '--sandbox',
  'read-only',
];

function bytesPerToken(): number {
  const override = Number.parseFloat(process.env.WAVEMILL_TOKEN_BYTES_CODEX ?? '');
  return Number.isFinite(override) && override > 0 ? override : BYTES_PER_TOKEN_CODEX_DEFAULT;
}

/** Resolve the codex executable: explicit override → `CODEX_CMD` → `codex`. */
export function codexCliCommand(override?: string): string {
  return override || process.env.CODEX_CMD || 'codex';
}

/** Environment for a codex CLI invocation (inherits the process env). */
export function codexCliEnv(options: { maxOutputTokens?: number } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A parent codex process can leak an output-format override.
  delete env.CODEX_OUTPUT;
  if (typeof options.maxOutputTokens === 'number' && Number.isFinite(options.maxOutputTokens) && options.maxOutputTokens > 0) {
    // Codex ignores this knob; set it exactly as the pre-HOK-3460 env did.
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(options.maxOutputTokens));
  }
  return env;
}

/** The trivial round-trip command the availability probe runs. */
export function codexCliAvailabilityCommand(cliCmd: string, tmpFile: string): string {
  return `${escapeShellArg(cliCmd)} exec --json --sandbox read-only --model gpt-5.6-terra < ${escapeShellArg(tmpFile)}`;
}

/**
 * Codex thread id from the `codex exec --json` stream (`thread.started`).
 * The first event wins: later sub-thread ids are not the helper's session.
 */
export function codexThreadIdFromJsonl(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
        return event.thread_id;
      }
    } catch {
      // Non-JSON line; keep looking.
    }
  }
  return undefined;
}

export interface CodexCliAdapterOptions {
  model: string;
  repoDir?: string;
  reservedOutputTokens?: number;
  /** Accepted for API compatibility; every adapter invocation is fail-closed (HOK-3460). */
  failClosed?: boolean;
}

function classifyCodexMessage(message: string): AdapterError {
  return classifyCliMessage(message, { includeCharCap: true });
}

function errorMessageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

export class CodexCliAdapter implements CliTransportAdapter {
  readonly kind = 'codex-cli' as const;
  readonly model: string;
  readonly limits: AdapterLimits;
  private readonly repoDir?: string;
  private readonly reservedOutputTokens: number;

  constructor(opts: CodexCliAdapterOptions) {
    this.model = opts.model;
    this.repoDir = opts.repoDir;
    const registry = getEffectiveRegistry(opts.repoDir);
    const capabilities = getModel(registry, opts.model);
    this.reservedOutputTokens = opts.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    this.limits = {
      ...(typeof capabilities?.contextWindowTokens === 'number'
        ? { contextWindowTokens: capabilities.contextWindowTokens }
        : {}),
      maxInputChars: CODEX_CLI_MAX_INPUT_CHARS,
      cliHarnessOverheadTokens: CODEX_CLI_HARNESS_OVERHEAD_TOKENS,
      reservedOutputTokens: this.reservedOutputTokens,
    };
  }

  countTokens(text: string): number {
    return estimateTokensWithBytesPerToken(text, bytesPerToken());
  }

  preflight(prompt: string): AdapterError | undefined {
    // The char cap is the real gate — codex exec rejects anything longer.
    if (prompt.length > CODEX_CLI_MAX_INPUT_CHARS) {
      const message =
        `Prompt exceeds codex ${CODEX_CLI_MAX_INPUT_CHARS}-char input cap ` +
        `(actual_chars=${prompt.length})`;
      return {
        kind: 'input-too-large',
        message,
        policyKind: policyKindFor('input-too-large'),
        rawExcerpt: message,
      };
    }
    // Secondary context-window check (belt and suspenders).
    const limit = this.limits.contextWindowTokens;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      return undefined;
    }
    const promptEstimate = estimatePromptTokens({
      messages: [{ role: 'user', content: prompt }],
    });
    const overhead = this.limits.cliHarnessOverheadTokens ?? 0;
    const verdict = evaluateContextWindow({
      phase: 'codex-cli',
      model: { id: this.model, provider: 'codex-cli' },
      limit: { limit, source: 'registry', registryModelId: this.model },
      estimate: {
        ...promptEstimate,
        systemPromptTokens: promptEstimate.systemPromptTokens + overhead,
        inputTokens: promptEstimate.inputTokens + overhead,
      },
      reservedOutputTokens: this.reservedOutputTokens,
    });
    if (verdict.ok) return undefined;
    const message = (verdict as { message: string }).message;
    return {
      kind: 'context-exceeded',
      message,
      policyKind: policyKindFor('context-exceeded'),
      rawExcerpt: message.slice(0, 500),
    };
  }

  incompatibilityReason(modelId: string): string | null {
    const model = getModel(getEffectiveRegistry(this.repoDir), modelId);
    if (!model || model.vendor === 'custom') return null;
    return model.vendor === 'openai'
      ? null
      : `transport ${this.kind} cannot serve vendor ${model.vendor}`;
  }

  async invoke(prompt: string, opts: AdapterInvokeOptions = {}): Promise<AdapterInvokeResult> {
    if (!opts.skipPreflight) {
      const refusal = this.preflight(prompt);
      if (refusal) {
        return { text: '', reportedModel: 'unverified', rawOutput: '', error: refusal };
      }
    }
    // Fail-closed by default; `maxRetries` opts into the historic resend.
    return withTransientRetry(opts.maxRetries, () => this.invokeOnce(prompt, opts));
  }

  private async invokeOnce(prompt: string, opts: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const cwd = opts.cwd ?? process.cwd();
    const args = [...CODEX_CLI_DEFAULT_ARGS];
    if (this.model) args.push('--model', this.model);
    if (opts.cliFlags && opts.cliFlags.length > 0) args.push(...opts.cliFlags);

    // Note: maxOutputTokens is not passed to Codex because `codex exec` does
    // not support output token limiting; the option is accepted for API
    // consistency only.
    const pendingRef = this.recordOwnership(opts.ownership, args, cwd);

    try {
      const run = await runCliProcess({
        label: 'codex',
        cmd: codexCliCommand(opts.cliCmd),
        args,
        stdin: prompt,
        env: codexCliEnv({ maxOutputTokens: opts.maxOutputTokens }),
        cwd,
        mode: opts.mode ?? 'stream',
        timeout: opts.timeout,
        activityTimeout: opts.activityTimeout,
        maxBuffer: opts.maxBuffer,
        signal: opts.signal,
        onSlow: opts.onSlow,
      });
      if (run.exitCode === 0) this.resolveOwnership(pendingRef, run.stdout);
      const parsed = this.parseResult(run.stdout, run.stderr, run.exitCode);
      // Sync mode keeps its actionable auth/quota/buffer diagnostics.
      if (parsed.error && run.failureMessage) {
        parsed.error.message = run.failureMessage;
      }
      return { ...parsed, rawOutput: run.stdout };
    } catch (error) {
      return {
        text: '',
        reportedModel: 'unverified',
        rawOutput: '',
        error: classifyCodexMessage(errorMessageOf(error)),
      };
    }
  }

  /** Record a `pending:` helper row; a later `thread.started` resolves it (HOK-3328). */
  private recordOwnership(
    ownership: AdapterInvokeOptions['ownership'],
    args: string[],
    cwd: string,
  ): { stateDir: string; pendingRef: string } | undefined {
    if (!ownership) return undefined;
    if (args.some((arg) => CLI_SESSION_SELECTION_FLAGS.has(arg))) return undefined;
    const pendingRef = pendingSessionRef(newSessionRef());
    const recorded = recordLaunch(ownership.featureDir, {
      kind: helperKind(ownership.helperPurpose),
      model: this.model,
      cwd,
      sessionRef: pendingRef,
      harness: 'codex',
    });
    if (!recorded) return undefined;
    return { stateDir: ownership.featureDir, pendingRef };
  }

  private resolveOwnership(
    pending: { stateDir: string; pendingRef: string } | undefined,
    rawOutput: string,
  ): void {
    if (!pending) return;
    const threadId = codexThreadIdFromJsonl(rawOutput);
    if (!threadId) return;
    try {
      appendSessionRefResolution(pending.stateDir, pending.pendingRef, threadId);
    } catch (error) {
      console.warn(`[session-ownership] codex thread id not recorded: ${(error as Error).message}`);
    }
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AdapterParseResult {
    if (exitCode !== 0) {
      const detail = [
        stdout ? `stdout=${stdout.slice(0, 2000)}` : '',
        stderr ? `stderr=${stderr.slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const message = `codex CLI exited with code ${exitCode}${detail ? `: ${detail}` : ''}`;
      return {
        text: '',
        reportedModel: 'unverified',
        error: classifyCodexMessage(message),
      };
    }

    // Success — parse the JSONL event stream.
    //
    // HOK-3409 seam: this is the one Codex usage mapping in the repo. Today
    // `input_tokens` is inclusive (cached_input_tokens is a subset and is not
    // added), reasoning tokens are billed as output, and cache buckets are
    // dropped. HOK-3409 replaces this with `fromCodexUsage`.
    const messages: string[] = [];
    let usage: AdapterUsage | undefined;
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        event.type === 'item.completed' &&
        event.item &&
        typeof event.item === 'object' &&
        (event.item as Record<string, unknown>).type === 'agent_message' &&
        typeof (event.item as Record<string, unknown>).text === 'string'
      ) {
        messages.push((event.item as Record<string, unknown>).text as string);
      } else if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
        const u = event.usage as Record<string, number | undefined>;
        // `input_tokens` already includes cached input; `cached_input_tokens` is
        // a subset, so it is not added again. Reasoning tokens are billed as
        // output.
        const inputTokens = u.input_tokens ?? 0;
        const outputTokens = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    }
    const text = messages.length > 0 ? messages.join('\n').trim() : stdout.trim();
    const result: AdapterInvokeResult = { text, reportedModel: 'unverified' };
    if (usage) result.usage = usage;
    return result;
  }
}
