/**
 * Claude CLI transport adapter (HOK-3248).
 *
 * Owns the facts about the claude CLI transport (claude Code `-p
 * --output-format json`): registry context window, 30k harness overhead,
 * JSON-heavy bytes/token calibration (2.4; HOK-2804 measurement), fail-closed
 * invocation via `callLLM`, and the stdout-first parse that recovers the
 * CLI's real error text when `--output-format json` writes
 * `{"is_error":true,"error":"..."}` on a non-zero exit (fixes "exited with
 * code 1:" with empty stderr).
 */
import { getEffectiveRegistry, getModel } from '../model-registry.ts';
import { callLLM } from '../llm-cli.ts';
import {
  policyKindFor,
  type AdapterError,
  type AdapterInvokeOptions,
  type AdapterInvokeResult,
  type AdapterLimits,
  type AdapterParseResult,
  type AdapterUsage,
  type TransportAdapter,
} from './transport-adapter.ts';
import { estimateTokensWithBytesPerToken } from './token-estimator.ts';
import { estimatePromptTokens, evaluateContextWindow } from '../native-agent/context-window-guard.ts';
import { classifyCliMessage } from './cli-error-classifier.ts';

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

const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;

function bytesPerToken(): number {
  const override = Number.parseFloat(process.env.WAVEMILL_TOKEN_BYTES_CLAUDE ?? '');
  return Number.isFinite(override) && override > 0 ? override : BYTES_PER_TOKEN_CLAUDE_DEFAULT;
}

export interface ClaudeCliAdapterOptions {
  model: string;
  repoDir?: string;
  reservedOutputTokens?: number;
  failClosed?: boolean;
}

interface ClaudeEnvelope {
  is_error?: boolean;
  error?: string;
  result?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
}

/** Pick the first id from `modelUsage` — same rule used in llm-cli.ts. */
function reportedModelFromEnvelope(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const ids = Object.keys(modelUsage as Record<string, unknown>);
  return ids.length === 1
    ? ids[0]
    : ids.find((id) => typeof id === 'string' && id.includes('-')) ?? ids[0];
}

function classifyClaudeMessage(message: string): AdapterError {
  return classifyCliMessage(message);
}

export class ClaudeCliAdapter implements TransportAdapter {
  readonly kind = 'claude-cli' as const;
  readonly model: string;
  readonly limits: AdapterLimits;
  private readonly reservedOutputTokens: number;
  private readonly failClosed: boolean;

  constructor(opts: ClaudeCliAdapterOptions) {
    this.model = opts.model;
    const registry = getEffectiveRegistry(opts.repoDir);
    const capabilities = getModel(registry, opts.model);
    this.reservedOutputTokens = opts.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    this.failClosed = opts.failClosed ?? true;
    this.limits = {
      ...(typeof capabilities?.contextWindowTokens === 'number'
        ? { contextWindowTokens: capabilities.contextWindowTokens }
        : {}),
      cliHarnessOverheadTokens: CLAUDE_CLI_HARNESS_OVERHEAD_TOKENS,
      maxOutputTokens: this.reservedOutputTokens,
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

  async invoke(prompt: string, opts: AdapterInvokeOptions = {}): Promise<AdapterInvokeResult> {
    const refusal = this.preflight(prompt);
    if (refusal) {
      return { text: '', reportedModel: 'unverified', error: refusal };
    }
    try {
      const result = await callLLM(prompt, {
        provider: 'claude',
        mode: 'stream',
        model: this.model,
        timeout: opts.timeout,
        maxOutputTokens: opts.maxOutputTokens ?? this.reservedOutputTokens,
        signal: opts.signal,
        cwd: opts.cwd,
        retry: (opts.maxRetries ?? 0) > 0,
        maxRetries: opts.maxRetries,
        // Fail-closed by default: no ladder.
        ...(this.failClosed ? { fallbackModels: [] } : { taskType: 'review' as const }),
      });
      const invokeResult: AdapterInvokeResult = {
        text: result.text,
        reportedModel: result.reportedModel ?? 'unverified',
        ...(result.usage
          ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens,
                ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
              } satisfies AdapterUsage,
            }
          : {}),
      };
      return invokeResult;
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const adapterError = classifyClaudeMessage(message);
      return { text: '', reportedModel: 'unverified', error: adapterError };
    }
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AdapterParseResult {
    // Try to parse stdout as a claude JSON envelope regardless of exit code.
    // The claude CLI's `--output-format json` writes {"is_error":true,"error":...}
    // on stdout on failure, which the previous stderr-only error builder
    // discarded (HOK-3248 problem 3).
    let envelope: ClaudeEnvelope | undefined;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (parsed && typeof parsed === 'object') {
        envelope = parsed as ClaudeEnvelope;
      }
    } catch {
      envelope = undefined;
    }

    if (envelope?.is_error === true) {
      const message = envelope.error ?? 'claude CLI returned is_error with no message';
      const adapterError = classifyClaudeMessage(message);
      return {
        text: '',
        reportedModel: 'unverified',
        error: adapterError,
      };
    }

    if (exitCode !== 0) {
      // Build the message from both stdout and stderr so the real reason is
      // never lost even if the CLI did not emit an is_error envelope.
      const combined = [
        stdout ? `stdout: ${stdout.slice(0, 2000)}` : '',
        stderr ? `stderr: ${stderr.slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const message = combined || `claude CLI exited with code ${exitCode}`;
      const adapterError = classifyClaudeMessage(message);
      return {
        text: '',
        reportedModel: 'unverified',
        error: adapterError,
      };
    }

    // Success path
    if (!envelope) {
      return { text: stdout.trim(), reportedModel: 'unverified' };
    }
    const text = (envelope.result ?? stdout).trim();
    const reportedModel = reportedModelFromEnvelope(envelope.modelUsage) ?? 'unverified';
    const usage = envelope.usage
      ? ({
          inputTokens:
            (envelope.usage.input_tokens ?? 0) +
            (envelope.usage.cache_creation_input_tokens ?? 0) +
            (envelope.usage.cache_read_input_tokens ?? 0),
          outputTokens: envelope.usage.output_tokens ?? 0,
          totalTokens:
            (envelope.usage.input_tokens ?? 0) +
            (envelope.usage.cache_creation_input_tokens ?? 0) +
            (envelope.usage.cache_read_input_tokens ?? 0) +
            (envelope.usage.output_tokens ?? 0),
          ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
        } satisfies AdapterUsage)
      : undefined;
    const out: AdapterInvokeResult = { text, reportedModel };
    if (usage) out.usage = usage;
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
