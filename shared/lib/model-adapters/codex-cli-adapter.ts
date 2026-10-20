/**
 * Codex CLI transport adapter (HOK-3248).
 *
 * Declares the 1,048,576-character input cap that `codex exec` imposes (HOK-
 * 3248 problem 2) alongside the usual context-window check, parses the JSONL
 * event stream the CLI emits on success, and classifies codex-specific error
 * strings (char-cap rejection, rate limits) at parse time.
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

const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;

function bytesPerToken(): number {
  const override = Number.parseFloat(process.env.WAVEMILL_TOKEN_BYTES_CODEX ?? '');
  return Number.isFinite(override) && override > 0 ? override : BYTES_PER_TOKEN_CODEX_DEFAULT;
}

export interface CodexCliAdapterOptions {
  model: string;
  repoDir?: string;
  reservedOutputTokens?: number;
  failClosed?: boolean;
}

function classifyCodexMessage(message: string): AdapterError {
  return classifyCliMessage(message, { includeCharCap: true });
}

export class CodexCliAdapter implements TransportAdapter {
  readonly kind = 'codex-cli' as const;
  readonly model: string;
  readonly limits: AdapterLimits;
  private readonly reservedOutputTokens: number;
  private readonly failClosed: boolean;

  constructor(opts: CodexCliAdapterOptions) {
    this.model = opts.model;
    const registry = getEffectiveRegistry(opts.repoDir);
    const capabilities = getModel(registry, opts.model);
    this.reservedOutputTokens = opts.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    this.failClosed = opts.failClosed ?? true;
    this.limits = {
      ...(typeof capabilities?.contextWindowTokens === 'number'
        ? { contextWindowTokens: capabilities.contextWindowTokens }
        : {}),
      maxInputChars: CODEX_CLI_MAX_INPUT_CHARS,
      cliHarnessOverheadTokens: CODEX_CLI_HARNESS_OVERHEAD_TOKENS,
      maxOutputTokens: this.reservedOutputTokens,
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

  async invoke(prompt: string, opts: AdapterInvokeOptions = {}): Promise<AdapterInvokeResult> {
    const refusal = this.preflight(prompt);
    if (refusal) {
      return { text: '', reportedModel: 'unverified', error: refusal };
    }
    try {
      // Note: maxOutputTokens is not passed to Codex because Codex `exec`
      // does not support output token limiting (see llm-cli.ts comment on maxOutputTokens).
      // The option is still accepted for API consistency.
      const result = await callLLM(prompt, {
        provider: 'codex',
        mode: 'stream',
        model: this.model,
        timeout: opts.timeout,
        signal: opts.signal,
        cwd: opts.cwd,
        retry: (opts.maxRetries ?? 0) > 0,
        maxRetries: opts.maxRetries,
        ...(this.failClosed ? { fallbackModels: [] } : { taskType: 'review' as const }),
      });
      const invokeResult: AdapterInvokeResult = {
        text: result.text,
        // Codex `exec --json` reports no model id — never trust the wire id.
        reportedModel: 'unverified',
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
      const adapterError = classifyCodexMessage(message);
      return { text: '', reportedModel: 'unverified', error: adapterError };
    }
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AdapterParseResult {
    // Scan stderr first — codex writes its char-cap rejection there.
    if (exitCode !== 0) {
      const combined = [
        stdout ? `stdout: ${stdout.slice(0, 2000)}` : '',
        stderr ? `stderr: ${stderr.slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const message = combined || `codex CLI exited with code ${exitCode}`;
      const adapterError = classifyCodexMessage(message);
      return {
        text: '',
        reportedModel: 'unverified',
        error: adapterError,
      };
    }

    // Success — parse the JSONL event stream.
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
