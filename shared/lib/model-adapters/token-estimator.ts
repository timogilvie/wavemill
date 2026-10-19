/**
 * Shared token estimator for callers that do not have a transport-specific
 * one (HOK-3248).
 *
 * The historical ad-hoc `length / 4` estimators (candidate-features,
 * task-descriptor-builder, hokusai-schema) all route through this helper now;
 * CLI adapters tune their own bytes-per-token (claude JSON-heavy: 2.4; codex:
 * 3.0) against this default.
 *
 * The default is 3.0 bytes/token — deliberately conservative. Measured on the
 * HOK-2804 review prompt, the claude CLI reported ~2.4 bytes/token on JSON-
 * heavy text; most prose is closer to 4. 3.0 keeps the router's feature
 * bucketing consistent with the codex adapter.
 *
 * @module model-adapters/token-estimator
 */

export const BYTES_PER_TOKEN_DEFAULT = 3.0;

/**
 * Transport-neutral token estimate. Byte-length based (UTF-8), rounded up,
 * calibrated at {@link BYTES_PER_TOKEN_DEFAULT}.
 */
export function estimateTokensDefault(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN_DEFAULT);
}

/**
 * Byte-length based token count calibrated to a specific bytes-per-token.
 * Shared by the adapter `countTokens` implementations.
 */
export function estimateTokensWithBytesPerToken(text: string, bytesPerToken: number): number {
  if (!text) return 0;
  if (!(bytesPerToken > 0) || !Number.isFinite(bytesPerToken)) {
    throw new Error(`estimateTokensWithBytesPerToken: bytesPerToken must be a positive finite number (got ${bytesPerToken})`);
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / bytesPerToken);
}
