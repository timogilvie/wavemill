/**
 * Claude CLI transport adapter (HOK-3248, HOK-3448, HOK-3460).
 *
 * Owns the facts about the claude CLI transport: registry context window,
 * 30k harness overhead, JSON-heavy bytes/token calibration (2.4; HOK-2804),
 * the argv/env/ownership of a `claude -p --output-format json` invocation,
 * fail-closed execution, the single stdout interpreter
 * (`claude-cli-output.ts`), and which registry vendors the CLI can serve.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEffectiveRegistry, getModel } from '../model-registry.ts';
import { DEEPSEEK_BASE_URL } from '../deepseek-provider.ts';
import { escapeShellArg } from '../shell-utils.ts';
import { helperKind, newSessionRef, recordLaunch } from '../session-ownership.ts';
import {
  claudeCliErrorFromStdout,
  parseClaudeCliOutput,
} from './claude-cli-output.ts';
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

/**
 * JSON-heavy worst-case bytes-per-token for the claude CLI, derived from a
 * HOK-2804 review prompt (~2.4 B/tok on a 1MB JSON-heavy payload). Can be
 * overridden with `WAVEMILL_TOKEN_BYTES_CLAUDE` for a hot-fix.
 */
export const BYTES_PER_TOKEN_CLAUDE_DEFAULT = 2.4;

/**
 * Tokens the claude CLI harness adds on top of the user prompt (system prompt
 * and tool declarations). Measured on a one-word prompt: claude CLI 2.1.x
 * reported ~28.6k input tokens.
 */
export const CLAUDE_CLI_HARNESS_OVERHEAD_TOKENS = 30_000;

/** Default argv for a non-interactive JSON round-trip. */
export const CLAUDE_CLI_DEFAULT_ARGS: readonly string[] = ['-p', '--output-format', 'json'];

/**
 * Flags that isolate a classifier spawn from the interactive agent harness
 * (HOK-3202): no tools, no MCP config, no session persistence, no slash
 * commands. Inserted before caller flags so callers can override.
 */
export const CLAUDE_CLI_ISOLATION_FLAGS: readonly string[] = [
  '--tools',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--disable-slash-commands',
];

function bytesPerToken(): number {
  const override = Number.parseFloat(process.env.WAVEMILL_TOKEN_BYTES_CLAUDE ?? '');
  return Number.isFinite(override) && override > 0 ? override : BYTES_PER_TOKEN_CLAUDE_DEFAULT;
}

/** Resolve the claude executable: explicit override → `CLAUDE_CMD` → `claude`. */
export function claudeCliCommand(override?: string): string {
  return override || process.env.CLAUDE_CMD || 'claude';
}

/** Environment for a claude CLI invocation (inherits the process env). */
export function claudeCliEnv(options: { maxOutputTokens?: number; isolate?: boolean } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Never run as a nested claude-code child; the CLI drops its output format.
  delete env.CLAUDECODE;
  if (typeof options.maxOutputTokens === 'number' && Number.isFinite(options.maxOutputTokens) && options.maxOutputTokens > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(options.maxOutputTokens));
  }
  // Disable extended thinking for isolated classifier spawns (HOK-3202).
  if (options.isolate) {
    env.MAX_THINKING_TOKENS = '0';
  }
  return env;
}

/** The trivial round-trip command the availability probe runs. */
export function claudeCliAvailabilityCommand(cliCmd: string, tmpFile: string): string {
  return `${escapeShellArg(cliCmd)} -p --output-format json --model claude-haiku-4-5-20251001 < ${escapeShellArg(tmpFile)}`;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Which registry vendor the Claude CLI transport can actually serve from the
 * current environment.
 *
 * The CLI is spawned with the inherited env and no injected endpoint. By
 * default that reaches Anthropic, so only `vendor: anthropic` models answer;
 * a DeepSeek id such as `deepseek-v4-flash` is rejected as an unrecognized
 * model and hangs until the attempt timeout (HOK-3130). Only when the process
 * already runs inside a claude-deepseek agent env (`ANTHROPIC_BASE_URL`
 * pointing at the DeepSeek Anthropic-compatible endpoint) is the
 * relationship inverted.
 */
export function claudeCliServableVendor(env: NodeJS.ProcessEnv = process.env): 'anthropic' | 'deepseek' {
  const baseUrl = normalizeBaseUrl(env.ANTHROPIC_BASE_URL);
  return baseUrl !== '' && baseUrl === normalizeBaseUrl(DEEPSEEK_BASE_URL) ? 'deepseek' : 'anthropic';
}

export interface ClaudeCliAdapterOptions {
  model: string;
  repoDir?: string;
  reservedOutputTokens?: number;
  /** Accepted for API compatibility; every adapter invocation is fail-closed (HOK-3460). */
  failClosed?: boolean;
}

function classifyClaudeMessage(message: string): AdapterError {
  return classifyCliMessage(message);
}

function errorMessageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

export class ClaudeCliAdapter implements CliTransportAdapter {
  readonly kind = 'claude-cli' as const;
  readonly model: string;
  readonly limits: AdapterLimits;
  private readonly repoDir?: string;
  private readonly reservedOutputTokens: number;

  constructor(opts: ClaudeCliAdapterOptions) {
    this.model = opts.model;
    this.repoDir = opts.repoDir;
    const registry = getEffectiveRegistry(opts.repoDir);
    const capabilities = getModel(registry, opts.model);
    this.reservedOutputTokens = opts.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    this.limits = {
      ...(typeof capabilities?.contextWindowTokens === 'number'
        ? { contextWindowTokens: capabilities.contextWindowTokens }
        : {}),
      cliHarnessOverheadTokens: CLAUDE_CLI_HARNESS_OVERHEAD_TOKENS,
      reservedOutputTokens: this.reservedOutputTokens,
    };
  }

  countTokens(text: string): number {
    return estimateTokensWithBytesPerToken(text, bytesPerToken());
  }

  preflight(prompt: string): AdapterError | undefined {
    const limit = this.limits.contextWindowTokens;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      // No registry limit — nothing to check against.
      return undefined;
    }
    const promptEstimate = estimatePromptTokens({
      messages: [{ role: 'user', content: prompt }],
    });
    const overhead = this.limits.cliHarnessOverheadTokens ?? 0;
    const verdict = evaluateContextWindow({
      phase: 'claude-cli',
      model: { id: this.model, provider: 'claude-cli' },
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
    return model.vendor === claudeCliServableVendor()
      ? null
      : `transport ${this.kind} cannot serve vendor ${model.vendor}`;
  }

  /**
   * Record a helper call's session before it spawns (HOK-3328): mint a
   * `--session-id` and append it to the argv. Calls outside a task, or whose
   * flags already select/suppress a session, record nothing.
   */
  private recordOwnership(
    ownership: NonNullable<AdapterInvokeOptions['ownership']>,
    args: string[],
    cwd: string,
  ): string | undefined {
    if (args.some((arg) => CLI_SESSION_SELECTION_FLAGS.has(arg))) return undefined;
    const sessionRef = newSessionRef();
    const recorded = recordLaunch(ownership.featureDir, {
      kind: helperKind(ownership.helperPurpose),
      model: this.model,
      cwd,
      sessionRef,
      harness: 'claude-code',
    });
    if (!recorded) return undefined;
    args.push('--session-id', sessionRef);
    return sessionRef;
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
    const isolatedCwd = opts.isolate && !opts.cwd
      ? mkdtempSync(join(tmpdir(), 'wavemill-llm-cli-'))
      : undefined;
    const cwd = isolatedCwd ?? opts.cwd ?? process.cwd();

    const args = [...CLAUDE_CLI_DEFAULT_ARGS];
    if (opts.isolate) args.push(...CLAUDE_CLI_ISOLATION_FLAGS);
    if (this.model) args.push('--model', this.model);
    if (opts.cliFlags && opts.cliFlags.length > 0) args.push(...opts.cliFlags);

    const sessionRef = opts.ownership ? this.recordOwnership(opts.ownership, args, cwd) : undefined;

    try {
      const run = await runCliProcess({
        label: 'claude',
        cmd: claudeCliCommand(opts.cliCmd),
        args,
        stdin: prompt,
        env: claudeCliEnv({ maxOutputTokens: opts.maxOutputTokens, isolate: opts.isolate }),
        cwd,
        mode: opts.mode ?? 'stream',
        timeout: opts.timeout,
        activityTimeout: opts.activityTimeout,
        maxBuffer: opts.maxBuffer,
        signal: opts.signal,
        onSlow: opts.onSlow,
      });
      const parsed = this.parseResult(run.stdout, run.stderr, run.exitCode, sessionRef);
      // Sync mode keeps its actionable auth/quota/buffer diagnostics; the
      // typed kind stays whatever the parse/classifier decided.
      if (parsed.error && run.failureMessage) {
        parsed.error.message = run.failureMessage;
      }
      return {
        ...parsed,
        rawOutput: run.stdout,
        ...(sessionRef ? { sessionRef } : {}),
      };
    } catch (error) {
      return {
        text: '',
        reportedModel: 'unverified',
        rawOutput: '',
        error: classifyClaudeMessage(errorMessageOf(error)),
      };
    } finally {
      if (isolatedCwd) {
        try {
          rmSync(isolatedCwd, { recursive: true, force: true });
        } catch {
          // Best effort cleanup.
        }
      }
    }
  }

  parseResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    expectedSessionId?: string,
  ): AdapterParseResult {
    const parsed = parseClaudeCliOutput(stdout, { expectedSessionId });

    if (parsed.error) {
      // The single stdout interpreter's message becomes the caller's error
      // text, exactly as `callLLM` reported it before HOK-3460.
      const message = `claude CLI returned is_error: ${parsed.error}`;
      return { text: '', reportedModel: 'unverified', error: classifyClaudeMessage(message) };
    }

    if (exitCode !== 0) {
      const envelopeError = claudeCliErrorFromStdout(stdout);
      const stdoutDetail = stdout
        ? (envelopeError ?? stdout.slice(0, 2000))
        : '';
      const detail = [
        stdoutDetail ? `stdout=${stdoutDetail}` : '',
        stderr ? `stderr=${stderr}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const message = `claude CLI exited with code ${exitCode}${detail ? `: ${detail}` : ''}`;
      return { text: '', reportedModel: 'unverified', error: classifyClaudeMessage(message) };
    }

    const out: AdapterInvokeResult = {
      text: parsed.text,
      reportedModel: parsed.reportedModel ?? 'unverified',
    };
    if (parsed.usage) {
      out.usage = {
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        totalTokens: parsed.usage.totalTokens,
        ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } satisfies Partial<AdapterUsage> : {}),
      };
    }
    // The envelope can report cost without a token block; `LLMCallResult`
    // carried that cost before HOK-3460 too.
    if (parsed.costUsd !== undefined) out.costUsd = parsed.costUsd;
    if (parsed.toolReport) out.structuredReport = parsed.toolReport;
    if (parsed.toolReportError) out.structuredReportError = parsed.toolReportError;
    if (parsed.sessionId) out.sessionId = parsed.sessionId;
    return out;
  }
}

/**
 * Normalize a model id for comparing a CLI-reported id with the id the CLI
 * was invoked with: provider prefix, a bracketed variant suffix (`[1m]`) and
 * a dated snapshot suffix (`-20251001`) name the same model.
 */
export function normalizeClaudeCliModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

/** True when a claude CLI reported id names the same model as the invoked id. */
export function claudeCliReportedModelMatches(reportedModel: string, invokedModel: string): boolean {
  return normalizeClaudeCliModelId(reportedModel) === normalizeClaudeCliModelId(invokedModel);
}
