/**
 * One executor contract per model transport (HOK-3248).
 *
 * Every model call goes through a `TransportAdapter` whose single
 * responsibility is to own the facts about how its transport runs: the
 * context-window limits (plus any hard character cap), a transport-calibrated
 * token count, invocation (fail-closed by default), the stdout/stderr/exit-
 * code → `{text, reportedModel, usage, error?}` mapping, and the
 * `error.kind` → `classifyFailure` policy translation.
 *
 * Four adapters exist today: `claude-cli`, `codex-cli`, `native-openai`,
 * `native-openrouter`. Callers get limits, budget and typed errors from the
 * adapter and never branch on the transport.
 *
 * @module model-adapters/transport-adapter
 */
import type { ProviderErrorKind } from '../native-agent/provider-error-classifier.ts';

export type AdapterKind =
  | 'claude-cli'
  | 'codex-cli'
  | 'native-openai'
  | 'native-openrouter';

export type AdapterErrorKind =
  | 'input-too-large'
  | 'context-exceeded'
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'transient'
  | 'unknown';

export interface AdapterLimits {
  /** Context window in tokens from the registry; undefined if the registry is silent. */
  contextWindowTokens?: number;
  /** Hard character cap the transport imposes before any model call (codex: 1_048_576). */
  maxInputChars?: number;
  /** Max output tokens the adapter allows per call. */
  maxOutputTokens?: number;
  /**
   * Fixed overhead the transport adds on top of the user prompt (claude CLI
   * harness and tool declarations: 30k; codex: 20k; native: 0). Already
   * folded into `preflight`; exposed for callers that want to project a
   * budget before building the prompt.
   */
  cliHarnessOverheadTokens?: number;
}

export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface AdapterError {
  kind: AdapterErrorKind;
  /** Human-readable message. For CLI parses, carries the stdout and stderr text. */
  message: string;
  /** Policy-aligned kind — fed directly into `classifyFailure` (HOK-3176). */
  policyKind: ProviderErrorKind;
  /** The transport's own text excerpt the classifier matched against. */
  rawExcerpt?: string;
}

export interface AdapterInvokeResult {
  text: string;
  /**
   * Transport-reported identity (claude `modelUsage`; codex reports none →
   * `'unverified'`). Never trust the requested wire id as executed (HOK-3143).
   */
  reportedModel: string;
  usage?: AdapterUsage;
  error?: AdapterError;
}

export type AdapterParseResult = AdapterInvokeResult;

export interface AdapterObserverEvent {
  provider: AdapterKind;
  model?: string;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  error?: string;
}

export interface AdapterObserver {
  onAttemptStart?: (event: AdapterObserverEvent) => void | Promise<void>;
  onAttemptComplete?: (event: AdapterObserverEvent) => void | Promise<void>;
  onAttemptError?: (
    event: AdapterObserverEvent & { willRetry: boolean },
  ) => void | Promise<void>;
  onAttemptSlow?: (event: AdapterObserverEvent) => void | Promise<void>;
}

export interface AdapterInvokeOptions {
  /** Hard wall-clock timeout ms. */
  timeout?: number;
  /** Max output tokens — passed through to the transport when it supports a cap. */
  maxOutputTokens?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** cwd for CLI spawn or native agent base dir. */
  cwd?: string;
  /** Observer hooks for progress reporting. */
  observer?: AdapterObserver;
  /** Max retries on transient failures (default: 0 — fail-closed). */
  maxRetries?: number;
  /**
   * The task this call works for (HOK-3328): CLI transports record the
   * session in `<featureDir>/.session-ownership.jsonl` as `helper:<purpose>`.
   */
  ownership?: { featureDir: string; helperPurpose: string };
}

export interface TransportAdapter {
  readonly kind: AdapterKind;
  readonly model: string;
  readonly limits: AdapterLimits;
  /**
   * Transport-calibrated token count for the given text. Deterministic and
   * local — no network, no WASM load. The native adapters forward to the
   * same estimator the native loop uses; CLI adapters apply a transport-
   * tuned bytes-per-token.
   */
  countTokens(text: string): number;
  /**
   * Pre-invocation refusal. Returns an `AdapterError` when the prompt cannot
   * fit the transport's limits (char cap, projected tokens vs. context
   * window), or `undefined` when the call should proceed.
   */
  preflight(prompt: string): AdapterError | undefined;
  /**
   * Fail-closed invocation. No model ladder, no retry on terminal errors.
   * Ladders become an explicit caller choice.
   */
  invoke(prompt: string, opts?: AdapterInvokeOptions): Promise<AdapterInvokeResult>;
  /**
   * CLI adapters only: pure parse of (stdout, stderr, exitCode) → typed
   * result. Exposed for direct testing and for callers that need to re-parse
   * a captured CLI run. Native adapters throw.
   */
  parseResult(stdout: string, stderr: string, exitCode: number): AdapterParseResult;
}

/**
 * Map AdapterError.kind → ProviderErrorKind (HOK-3176). Called once by each
 * adapter's parse path so downstream `classifyFailure` consumes a single
 * spelling.
 */
export function policyKindFor(kind: AdapterErrorKind): ProviderErrorKind {
  switch (kind) {
    case 'input-too-large':
    case 'context-exceeded':
      return 'context-window-exceeded';
    case 'auth':
      return 'provider-config-error';
    case 'rate-limit':
    case 'transient':
      return 'provider-transient-error';
    case 'quota':
      return 'provider-credit-exhausted';
    case 'unknown':
    default:
      return 'provider-unknown-error';
  }
}
