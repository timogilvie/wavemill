import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';
import {
  incidentChainEvidenceLines,
  projectRemediationProposals,
  supersedeGenericFindings,
} from './wavemill-incident-projection.ts';

const validProposal = {
  schemaVersion: '1.2' as const,
  kind: 'rereview_failed_challenge_arm' as const,
  recommendationId: 'rerun_failed_arm_review',
  prerequisites: [],
  retryKey: 'k',
  safetyLevel: 'operator_only' as const,
  evidenceRefs: [],
  allowedActions: ['rerun_review' as const],
  forbiddenActions: ['add_ready_label' as const, 'merge' as const, 'synthesize_winner' as const],
};

function pairIncident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    ...createIncidentDraft({
      taskId: 'HOK-2934_c',
      category: 'model_task_harness_outcome',
      severity: 'high',
      confidence: 'medium',
      lifecycle: 'observed',
      rootCauseClass: 'challenge_arm_review_failed_blocking_pair',
      summary: 's',
      operatorAction: 'Rerun review on HOK-2934_c.',
      evidence: [],
      metadata: {
        proposal: validProposal,
        failedIssueId: 'HOK-2934_c',
        blockedIssueId: 'HOK-2934',
        pairState: 'blocked_on_rereview',
        causalChain: [{ cause: 'review_not_ready(native-review-failed)', evidenceIndex: 0 }, { cause: 'no_comparison', evidenceIndex: 0 }],
      },
    }),
    fingerprint: 'fp-pair',
    ...overrides,
  };
}

test('projectRemediationProposals keeps valid open proposals and counts invalid ones', () => {
  const invalid = pairIncident({ fingerprint: 'fp-bad', metadata: { proposal: { ...validProposal, forbiddenActions: ['add_ready_label'] } } });
  const resolved = pairIncident({ fingerprint: 'fp-resolved', lifecycle: 'resolved' });
  const noProposal = pairIncident({ fingerprint: 'fp-none', metadata: {} });
  const { proposals, errors } = projectRemediationProposals([pairIncident(), invalid, resolved, noProposal]);
  assert.deepEqual(proposals.map((item) => item.incidentFingerprint), ['fp-pair']);
  assert.equal(proposals[0].issue, 'HOK-2934_c');
  assert.equal(errors, 1);
});

test('supersedeGenericFindings groups both pair arms and leaves unrelated findings untouched', () => {
  const findings = [
    { id: 'stale-active-task-live-process-wavemill-HOK-2934', issue: 'HOK-2934', evidence: [], recommendation: 'parked prompt' },
    { id: 'stale-active-task-no-live-process-wavemill-HOK-2934_c', issue: 'HOK-2934_c', evidence: [], recommendation: 'parked prompt' },
    { id: 'stale-active-task-live-process-wavemill-HOK-9', issue: 'HOK-9', evidence: [], recommendation: 'parked prompt' },
    { id: 'log-error-x', issue: 'HOK-2934', evidence: [], recommendation: 'other' },
  ];
  const rewritten = supersedeGenericFindings(findings, [pairIncident()]);
  assert.equal(rewritten[0].groupedUnder, 'incident-fp-pair');
  assert.equal(rewritten[1].groupedUnder, 'incident-fp-pair');
  assert.equal(rewritten[0].recommendation, 'Rerun review on HOK-2934_c.');
  assert.deepEqual(rewritten[1].evidence, ['supersededBy=challenge_arm_review_failed_blocking_pair']);
  assert.equal(rewritten[2], findings[2]);
  assert.equal(rewritten[3], findings[3]);
  // Inputs are not mutated.
  assert.equal(findings[0].recommendation, 'parked prompt');
  // Inspection or resolved incidents never supersede.
  const inspection = pairIncident({ rootCauseClass: 'inspection_required' });
  assert.equal(supersedeGenericFindings(findings, [inspection]), findings);
  assert.equal(supersedeGenericFindings(findings, [pairIncident({ lifecycle: 'resolved' })]), findings);
});

test('incidentChainEvidenceLines renders chain, state, next action and proposal version', () => {
  assert.deepEqual(incidentChainEvidenceLines(pairIncident()), [
    'causalChain=review_not_ready(native-review-failed) → no_comparison',
    'pairState=blocked_on_rereview',
    'nextAction=rerun_failed_arm_review',
    'proposal=rereview_failed_challenge_arm@1.2',
  ]);
  assert.deepEqual(incidentChainEvidenceLines(pairIncident({ metadata: {} })), []);
});
