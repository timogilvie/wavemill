/**
 * Shared CLI error classifier (HOK-3248).
 *
 * Each CLI adapter maps a transport error message to an `AdapterError` the
 * caller consumes. The regex set is identical across CLIs (both wrap the
 * same provider APIs under the hood) except for the codex-only
 * `input-too-large` char-cap sentinel.
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

function toAdapterError(message: string, kind: AdapterErrorKind): AdapterError {
  return {
    kind,
    message,
    policyKind: policyKindFor(kind),
    rawExcerpt: message.slice(0, 500),
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
