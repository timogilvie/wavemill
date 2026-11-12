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
import type { ReportFindingsSource } from './claude-cli-output.ts';

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

/** Shared input-preflight reservation. Runtime output limits belong to each transport. */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;

export interface AdapterLimits {
  /** Context window in tokens from the registry; undefined if the registry is silent. */
  contextWindowTokens?: number;
  /** Hard character cap the transport imposes before any model call (codex: 1_048_576). */
  maxInputChars?: number;
  /** Output space reserved by input preflight; never an invocation cap. */
  reservedOutputTokens?: number;
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
  /** Parsed `retry-after`/`reset_at` from the transport message, when present (HOK-3460). */
  resetAt?: string | null;
}

/** One finding emitted by the claude CLI's `ReportFindings` tool. */
export interface ReportedReviewFinding {
  file: string;
  line?: number;
  severity: 'blocker' | 'warning';
  category: string;
  short_summary?: string;
  summary: string;
  failure_scenario: string;
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
}

/** A validated, session-bound `ReportFindings` report from a claude CLI call. */
export interface ReviewToolReport {
  source: ReportFindingsSource;
  sessionId?: string;
  toolUseId: string;
  findings: ReportedReviewFinding[];
}

export interface AdapterInvokeResult {
  text: string;
  /**
   * Transport-reported identity (claude `modelUsage`; codex reports none →
   * `'unverified'`). Never trust the requested wire id as executed (HOK-3143).
   */
  reportedModel: string;
  usage?: AdapterUsage;
  /**
   * Transport-reported cost, when it reports one independently of usage (the
   * claude CLI envelope can carry `total_cost_usd` without a token block).
   * Also mirrored on `usage.costUsd` when usage is present.
   */
  costUsd?: number;
  error?: AdapterError;
  /**
   * Validated `ReportFindings` report, when the claude CLI verbose output
   * carried one and it passed session binding + schema checks (HOK-3448).
   */
  structuredReport?: ReviewToolReport;
  /**
   * A report was delivered but is unusable (foreign session, malformed, etc).
   * Fail-closed: consumers must reject the response.
   */
  structuredReportError?: string;
  /** Owned claude CLI session id, when one was minted for this call. */
  sessionId?: string;
  /** Raw stdout of the CLI invocation (HOK-3460: `LLMCallResult.rawOutput`). */
  rawOutput?: string;
  /**
   * Owned session reference for this invocation: the minted claude
   * `--session-id` when ownership recorded one. Codex reports none.
   */
  sessionRef?: string;
}

export type AdapterParseResult = AdapterInvokeResult;

/**
 * CLI flags that already pin or resume a session. Helper ownership never
 * overrides an explicit caller choice (HOK-3328).
 */
export const CLI_SESSION_SELECTION_FLAGS: ReadonlySet<string> = new Set([
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--no-session-persistence',
]);

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
  /**
   * Slow-call notification from the CLI process runner (stream mode). The
   * caller owns attempt counters, so it receives only the elapsed time.
   */
  onSlow?: (elapsedMs: number) => void;
  /** Execution mode for CLI transports: blocking `execSync` or `spawn`. */
  mode?: 'sync' | 'stream';
  /** Inactivity timeout in ms (stream mode). */
  activityTimeout?: number;
  /** stdout/stderr buffer cap in bytes (sync mode). */
  maxBuffer?: number;
  /** Override CLI executable (defaults to `CLAUDE_CMD`/`CODEX_CMD`, then the binary name). */
  cliCmd?: string;
  /** Extra CLI flags supplied by the caller, appended before ownership flags. */
  cliFlags?: string[];
  /**
   * Isolate the spawn from the interactive agent harness (HOK-3202):
   * `--tools '' --strict-mcp-config --no-session-persistence
   * --disable-slash-commands`, a temp cwd and `MAX_THINKING_TOKENS=0`.
   */
  isolate?: boolean;
  /**
   * Skip the adapter's input preflight. `callLLM` sets this: its ladder has
   * never refused a call on token projection (HOK-3460).
   */
  skipPreflight?: boolean;
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
   *
   * `expectedSessionId` (claude only) binds a verbose `ReportFindings` report
   * to the session the invocation owns (HOK-3448).
   */
  parseResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    expectedSessionId?: string,
  ): AdapterParseResult;
}

/**
 * A transport that runs a model CLI. Beyond the shared executor contract, it
 * owns which registry vendors its CLI can actually serve (HOK-3460).
 */
export interface CliTransportAdapter extends TransportAdapter {
  /**
   * Why this transport cannot serve `modelId`, or `null` when it can. Owns
   * the `transport <kind> cannot serve vendor <vendor>` skip reason.
   */
  incompatibilityReason(modelId: string): string | null;
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
