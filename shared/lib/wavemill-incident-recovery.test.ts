import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReviewResultDiagnostic } from './artifact-diagnostics.ts';
import { createIncidentDraft, type IncidentRecord, type RemediationProposal } from './wavemill-incident-model.ts';
import { evaluateRecoveryPredicate, type RecoveryReaders } from './wavemill-incident-recovery.ts';

function recordWith(predicate: RemediationProposal['recoveryPredicate']): IncidentRecord {
  return createIncidentDraft({
    taskId: 'HOK-1324',
    category: 'stale_orphaned_state',
    severity: 'high',
    confidence: 'high',
    lifecycle: 'active',
    rootCauseClass: 'review_context_overflow_stale_base',
    summary: 's',
    operatorAction: 'a',
    evidence: [],
    metadata: {
      proposal: {
        schemaVersion: '1.2',
        kind: 'refresh_base_and_rereview',
        prerequisites: [],
        retryKey: 'k',
        safetyLevel: 'operator_only',
        evidenceRefs: [],
        forbiddenActions: ['add_ready_label', 'merge'],
        ...(predicate ? { recoveryPredicate: predicate } : {}),
      },
    },
  });
}

const reviewDetails = {
  pr: '1324',
  head: 'a'.repeat(40),
  reviewResultPath: '/repo/features/hok-1324/.review-result.json',
  reviewHead: 'a'.repeat(40),
  reviewFinishedAt: '2026-09-04T09:30:00.000Z',
};

function reviewReader(review: Partial<ReviewResultDiagnostic> | null): Partial<RecoveryReaders> {
  return {
    readReview: (taskDir) => {
      assert.equal(taskDir, '/repo/features/hok-1324');
      return review ? { source: `${taskDir}/.review-result.json`, ...review } : null;
    },
  };
}

test('review_now_ready: the same failed attempt is not recovery', () => {
  const result = evaluateRecoveryPredicate(recordWith({ kind: 'review_now_ready', details: reviewDetails }), '/repo', reviewReader({
    verdict: 'not_ready', reviewedHead: 'a'.repeat(40), finishedAt: '2026-09-04T09:30:00.000Z',
  }));
  assert.deepEqual(result, { satisfied: false });
});

test('review_now_ready: a ready verdict or a new attempt resolves', () => {
  const record = recordWith({ kind: 'review_now_ready', details: reviewDetails });
  const ready = evaluateRecoveryPredicate(record, '/repo', reviewReader({ verdict: 'ready', reviewedHead: 'a'.repeat(40) }));
  assert.equal(ready.satisfied, true);
  assert.equal(ready.reason, 'recovery_predicate:review_now_ready');

  const newHead = evaluateRecoveryPredicate(record, '/repo', reviewReader({ verdict: 'not_ready', reviewedHead: 'b'.repeat(40), finishedAt: '2026-09-04T09:30:00.000Z' }));
  assert.equal(newHead.satisfied, true);
  assert.match(newHead.evidence ?? '', /new review attempt at head bbbbbbbbbbbb/);

  const newFinish = evaluateRecoveryPredicate(record, '/repo', reviewReader({ verdict: 'not_ready', reviewedHead: 'a'.repeat(40), finishedAt: '2026-09-04T11:00:00.000Z' }));
  assert.equal(newFinish.satisfied, true);
});

test('missing or unreadable evidence never resolves', () => {
  assert.equal(evaluateRecoveryPredicate(recordWith({ kind: 'review_now_ready', details: reviewDetails }), '/repo', reviewReader(null)).satisfied, false);
  assert.equal(evaluateRecoveryPredicate(recordWith({ kind: 'review_now_ready', details: { ...reviewDetails, reviewResultPath: 'unknown' } }), '/repo').satisfied, false);
  assert.equal(evaluateRecoveryPredicate(recordWith(undefined), '/repo').satisfied, false);
  assert.equal(evaluateRecoveryPredicate(recordWith({ kind: 'head_changed', details: { pr: '1324', head: 'unknown' } }), '/repo').satisfied, false);
  const unknownKind = recordWith({ kind: 'mystery' as never, details: {} });
  assert.equal(evaluateRecoveryPredicate(unknownKind, '/repo').satisfied, false);
  // A record without any proposal metadata at all.
  const bare = { ...recordWith(undefined), metadata: {} };
  assert.equal(evaluateRecoveryPredicate(bare, '/repo').satisfied, false);
  // A running review is not a ready review.
  assert.equal(evaluateRecoveryPredicate(recordWith({ kind: 'review_now_ready', details: reviewDetails }), '/repo', reviewReader({ stageStatus: 'running' })).satisfied, false);
});

test('review_attempt_progressed: a running or new review attempt on the failed arm resolves', () => {
  const record = recordWith({ kind: 'review_attempt_progressed', details: { ...reviewDetails, issue: 'HOK-2934_c' } });
  assert.equal(evaluateRecoveryPredicate(record, '/repo', reviewReader({ stageStatus: 'running' })).satisfied, true);
  assert.equal(evaluateRecoveryPredicate(record, '/repo', reviewReader({ stageStatus: 'failed', verdict: 'error', reviewedHead: 'a'.repeat(40), finishedAt: '2026-09-04T09:30:00.000Z' })).satisfied, false);
  assert.equal(evaluateRecoveryPredicate(record, '/repo', reviewReader({ stageStatus: 'failed', verdict: 'error', reviewedHead: 'a'.repeat(40), finishedAt: '2026-09-05T09:30:00.000Z' })).reason, 'recovery_predicate:review_attempt_progressed');
});

test('head_changed, current_head_eval_present and comparison_present use their readers', () => {
  const headChanged = recordWith({ kind: 'head_changed', details: { pr: '1324', head: 'a'.repeat(40) } });
  assert.equal(evaluateRecoveryPredicate(headChanged, '/repo', {
    readPr: () => ({ number: 1324, headSha: 'c'.repeat(40), labels: [], latestCheckRollup: [], source: 'fixture' }),
  }).satisfied, true);
  assert.equal(evaluateRecoveryPredicate(headChanged, '/repo', {
    readPr: () => ({ number: 1324, headSha: 'a'.repeat(40), labels: [], latestCheckRollup: [], source: 'fixture' }),
  }).satisfied, false);
  assert.equal(evaluateRecoveryPredicate(headChanged, '/repo', { readPr: () => null }).satisfied, false);

  const evalPresent = recordWith({ kind: 'current_head_eval_present', details: { pairId: 'HOK-2934', head: 'h', issue: 'HOK-2934_c' } });
  assert.equal(evaluateRecoveryPredicate(evalPresent, '/repo', { currentHeadEval: (_r, issue, pair, head) => issue === 'HOK-2934_c' && pair === 'HOK-2934' && head === 'h' }).satisfied, true);

  const comparison = recordWith({ kind: 'comparison_present', details: { pairId: 'HOK-2934' } });
  assert.equal(evaluateRecoveryPredicate(comparison, '/repo', { comparisonSucceeded: () => true }).satisfied, true);
  assert.equal(evaluateRecoveryPredicate(comparison, '/repo', { comparisonSucceeded: () => false }).satisfied, false);
});
