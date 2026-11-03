/**
 * Tests for review-gate remediation disposition (HOK-2890).
 *
 * Fixtures are hand-authored to cover the categorical switch and the
 * artifact-signal fallback. Each test's `protects` comment names the specific
 * regression it would catch — the empty-findings fallback regression that
 * made the pre-HOK-2890 pre-Ready path silently misclassify failing verdicts
 * as retryable is covered by the artifact-signal tests below.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type {
  ReviewArtifactSignals,
  ReviewGateEvidence,
} from './review-gate-remediation.ts';
import {
  decideReviewGateRemediation,
  dispositionFromReviewArtifactSignals,
} from './review-gate-remediation.ts';

// protects: a caller invoking the categorical switch without typed findings
// previously silently returned retryable (reaching the shell CLI with a wrong
// disposition). The function now throws so the fallback must be used.
test('review-gate remediation: empty findings throws (callers must use artifact-signal fallback)', () => {
  const evidence: ReviewGateEvidence = {
    stage: 'review',
    stateDir: '/tmp/test-state',
    headSha: 'abc1234',
    findings: [],
    artifact: { kind: 'review-result', identity: 'review-1' },
  };

  assert.throws(() => decideReviewGateRemediation(evidence), /at least one typed finding/);
});

// protects: a pre-HOK-2890 review artifact with no typed findings[] and a
// failing verdict (not_ready) with no infra category was previously parked
// via write_ready_attention_file (terminal). The empty-findings fallback must
// preserve that — classifying as retryable would burn the stage-failure-review
// budget on a genuine agent fault.
test('review-gate artifact signals: failing verdict without infra category → terminal', () => {
  const artifact: ReviewArtifactSignals = {
    artifacts: {
      type: 'review',
      verdict: 'not_ready',
      failureCategory: '',
    },
  };
  assert.strictEqual(dispositionFromReviewArtifactSignals(artifact), 'terminal');
});

// protects: HOK-3247 — a routed reviewer that cannot run is retryable infra,
// which must still produce retryable even when typed findings are absent.
test('review-gate artifact signals: review-model-unlaunchable (non-not_ready) → retryable', () => {
  const artifact: ReviewArtifactSignals = {
    artifacts: {
      type: 'review',
      failureCategory: 'review-model-unlaunchable',
      verdict: 'error',
    },
  };
  assert.strictEqual(dispositionFromReviewArtifactSignals(artifact), 'retryable');
});

// protects: HOK-3247 — a review-model-unlaunchable with verdict=not_ready is
// a challenge-pinned harness-fault, not retryable infra.
test('review-gate artifact signals: review-model-unlaunchable with not_ready → terminal', () => {
  const artifact: ReviewArtifactSignals = {
    artifacts: {
      type: 'review',
      failureCategory: 'review-model-unlaunchable',
      verdict: 'not_ready',
    },
  };
  assert.strictEqual(dispositionFromReviewArtifactSignals(artifact), 'terminal');
});

// protects: review_result_infra_failure parity — each infra category must
// map to retryable.
test('review-gate artifact signals: each infra category → retryable', () => {
  const infraCategories = [
    'native-runtime-unavailable',
    'native-review-prompt-missing',
    'review-scope-unverifiable',
    'review-scope-mismatch',
    'review-scope-empty',
    'native-context-window-exceeded',
    'provider-credit-exhausted',
    'native-review-timeout',
    'native-review-malformed-response',
  ];
  for (const cat of infraCategories) {
    const artifact: ReviewArtifactSignals = {
      artifacts: { type: 'review', failureCategory: cat, verdict: 'error' },
    };
    assert.strictEqual(
      dispositionFromReviewArtifactSignals(artifact),
      'retryable',
      `category ${cat} must be retryable`,
    );
  }
});

// protects: artifact shape unwrapping — review artifacts stored at
// .artifacts.review.* must be read the same way as .artifacts.* with type=review.
test('review-gate artifact signals: unwrapped artifacts.review shape', () => {
  const artifact: ReviewArtifactSignals = {
    artifacts: {
      review: {
        failureCategory: 'provider-credit-exhausted',
        verdict: 'error',
      },
    },
  };
  assert.strictEqual(dispositionFromReviewArtifactSignals(artifact), 'retryable');
});

// protects: error-with-tool-error signal is retryable (tool crashed, not a
// change-fault).
test('review-gate artifact signals: verdict=error + reviewToolError → retryable', () => {
  const artifact: ReviewArtifactSignals = {
    verdict: 'error',
    reviewToolError: 'ENOENT: tool not found',
  };
  assert.strictEqual(dispositionFromReviewArtifactSignals(artifact), 'retryable');
});

test('review-gate remediation: scope violation → code-failure with revert suggestion', () => {
  const evidence: ReviewGateEvidence = {
    stage: 'review',
    stateDir: '/tmp/test-state',
    headSha: 'abc1234',
    reviewerModel: 'claude-opus-4-7-20250514',
    verdict: 'changes-requested',
    findings: [
      {
        category: 'scope-violation',
        offendingPath: 'src/other-module.ts',
        message: 'File is outside the declared feature scope',
      },
    ],
    artifact: { kind: 'review-result', identity: 'review-1' },
  };

  const decision = decideReviewGateRemediation(evidence);

  assert.strictEqual(decision.disposition, 'code-failure');
  assert.strictEqual(decision.deliverTo, 'agent');
  assert(decision.deliveryPayload);
  assert(
    decision.deliveryPayload.suggestions.some((s) => s.action === 'revert'),
  );
});

test('review-gate remediation: infra failure → retryable', () => {
  const evidence: ReviewGateEvidence = {
    stage: 'review',
    stateDir: '/tmp/test-state',
    headSha: 'abc1234',
    verdict: 'error',
    findings: [
      {
        category: 'review-infra',
        message: 'Review service timed out',
      },
    ],
    artifact: { kind: 'review-result', identity: 'review-1' },
  };

  const decision = decideReviewGateRemediation(evidence);

  assert.strictEqual(decision.disposition, 'retryable');
  assert.strictEqual(decision.deliverTo, 'infra-recovery');
});

test('review-gate remediation: config error → terminal', () => {
  const evidence: ReviewGateEvidence = {
    stage: 'pre-pr-verification',
    stateDir: '/tmp/test-state',
    headSha: 'abc1234',
    findings: [
      {
        category: 'config-error',
        message: 'Feature directory cannot be resolved from branch',
      },
    ],
    artifact: { kind: 'pre-pr-gate', identity: 'gate-1' },
  };

  const decision = decideReviewGateRemediation(evidence);

  assert.strictEqual(decision.disposition, 'terminal');
  assert.strictEqual(decision.deliverTo, 'operator');
});

test('review-gate remediation: scope in plan allowlist → refresh-baseline suggestion', () => {
  const evidence: ReviewGateEvidence = {
    stage: 'review',
    stateDir: '/tmp/test-state',
    headSha: 'abc1234',
    findings: [
      {
        category: 'scope-violation',
        offendingPath: '.github/workflows/ci.yml',
        message: 'File is outside declared scope but plan allows it',
      },
    ],
    artifact: { kind: 'review-result', identity: 'review-1' },
    planScopeAllowlist: [
      {
        path: '.github/workflows/ci.yml',
        reason: 'Journey registration required',
        source: 'plan.md',
      },
    ],
  };

  const decision = decideReviewGateRemediation(evidence);

  assert.strictEqual(decision.disposition, 'code-failure');
  assert.strictEqual(decision.deliverTo, 'agent');
  assert(decision.deliveryPayload);
  assert(
    decision.deliveryPayload.suggestions.some(
      (s) => s.action === 'refresh-baseline',
    ),
  );
  assert(
    decision.deliveryPayload.suggestions.some(
      (s) =>
        s.path === '.github/workflows/ci.yml' &&
        s.reason.includes('plan'),
    ),
  );
});
