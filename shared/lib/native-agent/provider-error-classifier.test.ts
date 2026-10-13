import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProviderError } from './provider-error-classifier.ts';

test('classifies observed provider error signatures', () => {
  const cases = [
    ['Provider finish_reason: error', 'provider-transient-error', true],
    ['upstream idle timeout waiting for response', 'provider-transient-error', true],
    ['Stream ended without finish_reason', 'provider-transient-error', true],
    ['HTTP 502 Bad Gateway from upstream', 'provider-transient-error', true],
    ['429 Too Many Requests', 'provider-transient-error', true],
    ['HTTP 402 Payment Required: can only afford 213 tokens', 'provider-credit-exhausted', false],
    ['requires more credits to complete this request', 'provider-credit-exhausted', false],
    ['401 Unauthorized: invalid API key', 'provider-config-error', false],
    ['openrouter/qwen is not a valid model ID', 'provider-config-error', false],
    ['404 No endpoints found that support tool use', 'provider-config-error', false],
    ['400 maximum context length is 131072 tokens', 'context-window-exceeded', false],
    ['Response incomplete: content_filter', 'provider-response-incomplete', false],
    ['Response incomplete: max_tool_calls', 'provider-response-incomplete', false],
    ['Response incomplete without a provider reason', 'provider-unknown-error', true],
    ['Provider returned error: strange opaque failure', 'provider-unknown-error', true],
  ] as const;

  for (const [message, kind, retryable] of cases) {
    const result = classifyProviderError(message);
    assert.equal(result.kind, kind, message);
    assert.equal(result.retryable, retryable, message);
  }
});
