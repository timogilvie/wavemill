/**
 * Claude CLI transport adapter (HOK-3248, HOK-3448).
 *
 * Owns the facts about the claude CLI transport: registry context window,
 * 30k harness overhead, JSON-heavy bytes/token calibration (2.4; HOK-2804),
 * fail-closed invocation via `callLLM`, and the single stdout interpreter
 * (`claude-cli-output.ts`) that reads the object envelope, the verbose array,
 * and the `ReportFindings` tool report.
 */
import { getEffectiveRegistry, getModel } from '../model-registry.ts';
import { callLLM } from '../llm-cli.ts';
import {
  claudeCliErrorFromStdout,
  parseClaudeCliOutput,
} from './claude-cli-output.ts';
import {
  DEFAULT_RESERVED_OUTPUT_TOKENS,
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
        // A preflight reservation is not a generated-output cap. Claude CLI
        // owns its model-aware reasoning + answer limit unless the caller
        // explicitly supplies a cap. Native JSON ceilings can starve
        // adaptive reasoning of any answer tokens (2026-11-06 incident).
        maxOutputTokens: opts.maxOutputTokens,
        signal: opts.signal,
        cwd: opts.cwd,
        retry: (opts.maxRetries ?? 0) > 0,
        maxRetries: opts.maxRetries,
        // HOK-3448: ask the CLI for the verbose array so the single stdout
        // interpreter can recover the ReportFindings tool report.
        cliFlags: ['--verbose'],
        ...(opts.ownership ? { featureDir: opts.ownership.featureDir, helperPurpose: opts.ownership.helperPurpose } : {}),
        // Fail-closed by default: no ladder.
        ...(this.failClosed ? { fallbackModels: [] } : { taskType: 'review' as const }),
      });
      const parsed = parseClaudeCliOutput(result.rawOutput, {
        expectedSessionId: result.sessionRef,
      });
      // HOK-3448: a result element bound to another session (or none) must not
      // supply this invocation's identity, usage or cost — fail closed.
      if (parsed.error) {
        return { text: '', reportedModel: 'unverified', error: classifyClaudeMessage(parsed.error) };
      }
      const invokeResult: AdapterInvokeResult = {
        text: parsed.text,
        reportedModel: parsed.reportedModel ?? result.reportedModel ?? 'unverified',
        ...(parsed.usage
          ? {
              usage: {
                inputTokens: parsed.usage.inputTokens,
                outputTokens: parsed.usage.outputTokens,
                totalTokens: parsed.usage.totalTokens,
                ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
              } satisfies AdapterUsage,
            }
          : {}),
        ...(parsed.toolReport ? { structuredReport: parsed.toolReport } : {}),
        ...(parsed.toolReportError ? { structuredReportError: parsed.toolReportError } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      };
      return invokeResult;
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const adapterError = classifyClaudeMessage(message);
      return { text: '', reportedModel: 'unverified', error: adapterError };
    }
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AdapterParseResult {
    const parsed = parseClaudeCliOutput(stdout);

    if (parsed.error) {
      const message = parsed.error;
      const adapterError = classifyClaudeMessage(message);
      return { text: '', reportedModel: 'unverified', error: adapterError };
    }

    if (exitCode !== 0) {
      const envelopeError = claudeCliErrorFromStdout(stdout);
      const combined = [
        envelopeError ? `stdout: ${envelopeError}` : (stdout ? `stdout: ${stdout.slice(0, 2000)}` : ''),
        stderr ? `stderr: ${stderr.slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const message = combined || `claude CLI exited with code ${exitCode}`;
      const adapterError = classifyClaudeMessage(message);
      return { text: '', reportedModel: 'unverified', error: adapterError };
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
        ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
      };
    }
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
