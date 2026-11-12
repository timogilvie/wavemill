/**
 * Classifier policy fixtures (HOK-3460).
 *
 * `retryPolicyFor` reproduces the historic `llm-cli` ladder/retry outcomes
 * from the adapter's typed error. The two drift cases are pinned here so a
 * future classifier change cannot silently move a fallback decision.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCliMessage, retryPolicyFor } from './cli-error-classifier.ts';

interface Case {
  message: string;
  kind: ReturnType<typeof retryPolicyFor>['kind'];
  retryable: boolean;
  includeCharCap?: boolean;
}

const CASES: Case[] = [
  // Quota wording wins over everything, exactly as the old policy checked it first.
  { message: 'Error: 429 rate_limit_exceeded', kind: 'quota', retryable: true },
  { message: '429 rate limit exceeded', kind: 'quota', retryable: true },
  { message: 'quota exceeded for this billing period', kind: 'quota', retryable: true },
  { message: 'resource_exhausted', kind: 'quota', retryable: true },
  { message: 'too many requests', kind: 'quota', retryable: true },
  // Drift case 1 (decision 4): adapter-only quota wording stays `other`.
  { message: '402 Payment Required', kind: 'other', retryable: true },
  { message: 'insufficient credits', kind: 'other', retryable: true },
  // Drift case 2 (decision 4): a context message that also names 429 is quota.
  { message: 'prompt is too long: maximum context length exceeded; 429 rate_limit_exceeded', kind: 'quota', retryable: true },
  // Auth fails fast.
  { message: '401 Unauthorized', kind: 'auth', retryable: false },
  { message: 'invalid api key', kind: 'auth', retryable: false },
  { message: 'permission denied', kind: 'auth', retryable: false },
  // Timeouts retry on the same model; other transients stay transient.
  { message: 'claude CLI timed out after 120000ms', kind: 'timeout', retryable: true },
  { message: 'claude CLI timed out due to inactivity after 60000ms', kind: 'timeout', retryable: true },
  // Legacy order: timeout wording was checked before context/unknown, so a
  // context message that also timed out keeps the same-model retry.
  { message: 'context length exceeded; claude CLI timed out after 120000ms', kind: 'timeout', retryable: true },
  { message: 'read ECONNRESET', kind: 'transient', retryable: true },
  { message: '503 Service Unavailable', kind: 'transient', retryable: true },
  // Context and unknown stay ladder-retryable `other`.
  { message: 'context length exceeded', kind: 'other', retryable: true },
  { message: 'syntax explosion', kind: 'other', retryable: true },
  { message: 'Input exceeds the maximum length of 1048576 characters', kind: 'other', retryable: true, includeCharCap: true },
];

describe('retryPolicyFor (HOK-3460)', () => {
  for (const item of CASES) {
    it(`maps ${JSON.stringify(item.message)} to ${item.kind}`, () => {
      const error = classifyCliMessage(item.message, { includeCharCap: item.includeCharCap });
      const policy = retryPolicyFor(error);
      assert.equal(policy.kind, item.kind);
      assert.equal(policy.reason, item.kind);
      assert.equal(policy.retryable, item.retryable);
    });
  }

  // protects: the codex char-cap sentinel is typed as input-too-large, not quota.
  it('keeps the codex char-cap kind while the ladder policy is other', () => {
    const error = classifyCliMessage(
      'Error: Input exceeds the maximum length of 1048576 characters',
      { includeCharCap: true },
    );
    assert.equal(error.kind, 'input-too-large');
    assert.equal(retryPolicyFor(error).kind, 'other');
  });

  // protects: a retry-after hint becomes a resetAt instant the quota state uses.
  it('extracts retry-after into resetAt', () => {
    const before = Date.now();
    const error = classifyCliMessage('429 rate_limit_exceeded retry-after: 30');
    const policy = retryPolicyFor(error);
    assert.equal(policy.kind, 'quota');
    assert.ok(policy.resetAt, 'expected a resetAt');
    const resetAtMs = Date.parse(policy.resetAt!);
    const expected = before + 30_000;
    assert.ok(Math.abs(resetAtMs - expected) < 5_000, `resetAt ${policy.resetAt} not ~30s ahead`);
  });

  // protects: an absolute reset instant is carried through unchanged.
  it('extracts an absolute reset_at instant', () => {
    const error = classifyCliMessage('quota exceeded reset_at: 2026-07-15T00:00:00.000Z');
    assert.equal(retryPolicyFor(error).resetAt, '2026-07-15T00:00:00.000Z');
  });

  // protects: no hint means no synthetic reset time.
  it('leaves resetAt null when the message carries no hint', () => {
    assert.equal(retryPolicyFor(classifyCliMessage('quota exceeded')).resetAt, null);
  });
});
