/**
 * Tests for review-gate remediation disposition (HOK-2890).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { ReviewGateEvidence } from './review-gate-remediation.ts';
import { decideReviewGateRemediation } from './review-gate-remediation.ts';

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
