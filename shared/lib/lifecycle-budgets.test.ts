/**
 * Tests for the lifecycle certification budget checker (HOK-2957).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCertificationBudgets, formatVerdict } from './lifecycle-budgets.ts';

test('an empty report with no timing passes', () => {
  const verdict = checkCertificationBudgets({ scenarios: [] }, null);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.scenariosChecked, 0);
});

test('pane still alive beyond limit is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', paneReleaseExpected: true, paneAgeTicks: 3 }] },
    null,
  );
  assert.equal(verdict.passed, false);
  assert.ok(verdict.violations.find((v) => v.budget === 'pane_age'));
});

test('cleanup attempt before nextRetryAt is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', cleanupAttemptsBeforeNextRetry: 2 }] },
    null,
  );
  assert.equal(verdict.passed, false);
  assert.ok(verdict.violations.find((v) => v.budget === 'cleanup_dedup'));
});

test('deletion without authority is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', branchDeletionCount: 1, branchDeletionAuthorized: false }] },
    null,
  );
  assert.equal(verdict.passed, false);
  assert.ok(verdict.violations.find((v) => v.budget === 'deletion_authority'));
});

test('deletion while shadow mode active is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', branchDeletionCount: 1, branchDeletionAuthorized: true, finalHeadMatches: true, shadowMode: 'shadow' }] },
    null,
  );
  assert.equal(verdict.passed, false);
  assert.ok(verdict.violations.find((v) => v.budget === 'deletion_shadow_mode'));
});

test('monitor p95 exceeding pollSeconds*1000 is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [] },
    { p95Ms: 12000, pollSeconds: 10 },
  );
  assert.equal(verdict.passed, false);
  assert.ok(verdict.violations.find((v) => v.budget === 'monitor_p95'));
});

test('monitor p95 under budget passes', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [] },
    { p95Ms: 2500, pollSeconds: 10 },
  );
  assert.equal(verdict.passed, true);
});

test('controller/observer/dashboard disagreement is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', agreement: false }] },
    null,
  );
  assert.equal(verdict.passed, false);
  assert.ok(verdict.violations.find((v) => v.budget === 'agreement'));
});

test('formatVerdict lists each violation', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', agreement: false }] },
    { p95Ms: 100, pollSeconds: 10 },
  );
  const text = formatVerdict(verdict);
  assert.match(text, /Verdict\s+: FAIL/);
  assert.match(text, /agreement:/);
});

test('iteration_ms above budget is flagged', () => {
  const verdict = checkCertificationBudgets(
    { scenarios: [{ id: 's1', iterationMs: 20000 }] },
    null,
  );
  assert.ok(verdict.violations.find((v) => v.budget === 'iteration_ms'));
});
