/**
 * Shared CLI error classifier (HOK-3248, HOK-3460).
 *
 * Each CLI adapter maps a transport error message to an `AdapterError` the
 * caller consumes. The regex set is identical across CLIs (both wrap the
 * same provider APIs under the hood) except for the codex-only
 * `input-too-large` char-cap sentinel.
 *
 * `retryPolicyFor` is the one translation from that typed error to the
 * `callLLM` ladder/retry policy, replacing `llm-cli`'s private
 * `classifyLLMError`. Its outcomes are pinned to the historic `llm-cli`
 * policy; the two known drift cases are documented and tested:
 *
 * - adapter-only quota wording (`402`, "payment required", "credits") stays
 *   `other`, as the old policy classified it;
 * - a context-window message that also names a rate limit (`429`) stays
 *   `quota`, because the old policy checked quota wording first.
 */
import type { AdapterError, AdapterErrorKind } from './transport-adapter.ts';
import { policyKindFor } from './transport-adapter.ts';

const CHAR_CAP_PATTERNS: RegExp[] = [
  /input exceeds the maximum length of \d+ characters?/i,
  /exceeds the maximum length/i,
];
const CONTEXT_PATTERNS: RegExp[] = [
  /context[_ -]?length|context window|maximum context length|reduce the length|prompt.*too long|input.*too long/i,
];
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b|rate[_ -]?limit|too many requests|resource_exhausted/i,
];
const QUOTA_PATTERNS: RegExp[] = [
  /quota|insufficient.*credits?|credit[_ -]?exhausted|payment required|\b402\b/i,
];
const AUTH_PATTERNS: RegExp[] = [
  /\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication|permission denied|forbidden/i,
];
const TRANSIENT_PATTERNS: RegExp[] = [
  /etimedout|timed out|timeout|econnreset|econnrefused|enotfound|socket hang up|temporar(?:y|ily)|overloaded|unavailable|server_error|\b5\d\d\b/i,
];

/** Quota wording the historic `llm-cli` policy treated as quota exhaustion. */
const LEGACY_QUOTA_WORDING =
  /\b(429|rate[_ -]?limit(?:[_ -]?(?:exceeded|error))?|quota|resource_exhausted|insufficient_quota|too many requests)\b/i;
const LEGACY_AUTH_WORDING =
  /\b(401|403|authentication(?:_error)?|unauthorized|forbidden|invalid[_ ]api[_ ]key|permission denied)\b/i;
const TIMEOUT_WORDING = /\b(etimedout|timed out|timeout|inactivity)\b/i;

/** Extract a `retry-after`/`reset_at` instant from a transport message. */
export function extractResetAt(message: string): string | null {
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

function toAdapterError(message: string, kind: AdapterErrorKind): AdapterError {
  return {
    kind,
    message,
    policyKind: policyKindFor(kind),
    rawExcerpt: message.slice(0, 500),
    resetAt: extractResetAt(message),
  };
}

/**
 * Classify a CLI stdout/stderr message into an `AdapterError`.
 *
 * `includeCharCap` enables the codex-only "Input exceeds the maximum length"
 * sentinel that maps to `input-too-large`.
 */
export function classifyCliMessage(
  message: string,
  options: { includeCharCap?: boolean } = {},
): AdapterError {
  if (options.includeCharCap) {
    for (const re of CHAR_CAP_PATTERNS) {
      if (re.test(message)) return toAdapterError(message, 'input-too-large');
    }
  }
  for (const re of CONTEXT_PATTERNS) {
    if (re.test(message)) return toAdapterError(message, 'context-exceeded');
  }
  for (const re of RATE_LIMIT_PATTERNS) {
    if (re.test(message)) return toAdapterError(message, 'rate-limit');
  }
  for (const re of QUOTA_PATTERNS) {
    if (re.test(message)) return toAdapterError(message, 'quota');
  }
  for (const re of AUTH_PATTERNS) {
    if (re.test(message)) return toAdapterError(message, 'auth');
  }
  for (const re of TRANSIENT_PATTERNS) {
    if (re.test(message)) return toAdapterError(message, 'transient');
  }
  return toAdapterError(message, 'unknown');
}

/** The `callLLM` retry/fallback policy derived from one transport error. */
export interface RetryPolicy {
  kind: 'quota' | 'auth' | 'timeout' | 'transient' | 'other';
  /** Reason recorded in the fallback chain and logs; equals `kind`. */
  reason: string;
  resetAt: string | null;
  /** Whether the ladder may advance past this candidate. */
  retryable: boolean;
}

/**
 * Translate `AdapterError` to the ladder/retry policy.
 *
 * Reproduces the historic `llm-cli` outcomes: quota wording wins over a
 * co-occurring context message; auth fails fast; a timeout-classified
 * transient retries on the same model; adapter-only quota wording falls back
 * to `other` (today's outcome) rather than changing error classes here.
 */
export function retryPolicyFor(error: AdapterError): RetryPolicy {
  const message = error.message;
  const resetAt = error.resetAt ?? extractResetAt(message) ?? null;
  const policy = (
    kind: RetryPolicy['kind'],
    retryable: boolean,
  ): RetryPolicy => ({ kind, reason: kind, resetAt, retryable });

  // HOK-3460 pin: the old classifier checked quota, then auth, then timeout
  // wording before it looked at anything else. Keep that order so a message
  // that names several conditions lands on the same policy rung it did before
  // (e.g. `context window ... 429` is quota, not context-exceeded; a context
  // message that also says `timed out` is timeout, not other).
  if (LEGACY_QUOTA_WORDING.test(message)) return policy('quota', true);
  if (LEGACY_AUTH_WORDING.test(message)) return policy('auth', false);
  if (TIMEOUT_WORDING.test(message)) return policy('timeout', true);

  switch (error.kind) {
    case 'rate-limit':
    case 'quota':
      // Only adapter-only wording reaches here (402/payment required/credits).
      // The old policy called those `other`; keep that until error classes are
      // revisited (out of scope for HOK-3460).
      return policy('other', true);
    case 'transient':
      return policy('transient', true);
    case 'auth':
      return policy('auth', false);
    case 'context-exceeded':
    case 'input-too-large':
    case 'unknown':
    default:
      return policy('other', true);
  }
}

/**
 * Retry a CLI invocation on transient/timeout failures, with the historic
 * 2s, 4s… backoff (HOK-3460).
 *
 * `callLLM` passes no `maxRetries` — its own retry/fallback policy owns the
 * ladder — so the adapter path stays fail-closed by default. Callers that ask
 * for retries (`review-engine`) get the same resend behaviour they had when
 * the adapter delegated to `callLLM`.
 */
export async function withTransientRetry<T extends { error?: AdapterError }>(
  maxRetries: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const attempts = Math.max(0, Math.floor(maxRetries ?? 0)) + 1;
  let result = await run();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (!result.error) return result;
    const policy = retryPolicyFor(result.error);
    if (policy.kind !== 'transient' && policy.kind !== 'timeout') return result;
    await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    result = await run();
  }
  return result;
}
