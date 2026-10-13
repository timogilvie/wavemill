import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INCIDENT_ROOT_CAUSE_CLASSES, canonicalizeRootCauseClass, validateRemediationProposal } from './wavemill-incident-model.ts';

test('every bounded root-cause class round-trips through canonicalization', () => {
  for (const rootCauseClass of INCIDENT_ROOT_CAUSE_CLASSES) {
    assert.equal(canonicalizeRootCauseClass(rootCauseClass), rootCauseClass);
  }
});

test('legacy parked-arm slugs canonicalize to the HOK-2927 classes', () => {
  assert.equal(canonicalizeRootCauseClass('arm-parked-awaiting-operator-commit'), 'arm_parked_awaiting_operator_commit');
  assert.equal(canonicalizeRootCauseClass('arm parked awaiting operator commit'), 'arm_parked_awaiting_operator_commit');
  assert.equal(canonicalizeRootCauseClass('stage-marker-not-advanced'), 'stage_marker_not_advanced');
  assert.equal(canonicalizeRootCauseClass('marker not advanced'), 'stage_marker_not_advanced');
  assert.equal(canonicalizeRootCauseClass('terminal-task-parked'), 'terminal_arm_parked_with_residue');
  assert.equal(canonicalizeRootCauseClass('terminal arm parked'), 'terminal_arm_parked_with_residue');
  assert.equal(canonicalizeRootCauseClass('arm-died-with-unpushed-work'), 'arm_died_with_unpushed_work');
  assert.equal(canonicalizeRootCauseClass('pr-create-failed'), 'pr_create_failed');
  assert.equal(canonicalizeRootCauseClass("pull request create failed: Head sha can't be blank"), 'pr_create_failed');
});

test('parked-arm patterns do not swallow the typed completion-protocol classes', () => {
  assert.equal(canonicalizeRootCauseClass('no_completion_artifact'), 'native_completion_protocol_failure');
  assert.equal(canonicalizeRootCauseClass('blocked-completion refused'), 'harness_liveness_deadlock');
  assert.equal(canonicalizeRootCauseClass('cleanup-unpublished-at-risk'), 'cleanup_unpublished_at_risk');
});

test('interactive-prompt legacy slugs canonicalize to the HOK-3045 class', () => {
  assert.equal(canonicalizeRootCauseClass('agent_interactive_prompt_blocked'), 'agent_interactive_prompt_blocked');
  assert.equal(canonicalizeRootCauseClass('agent-interactive-prompt-blocked'), 'agent_interactive_prompt_blocked');
  assert.equal(canonicalizeRootCauseClass('interactive prompt blocked'), 'agent_interactive_prompt_blocked');
});

test('module-export contract mismatches map to the bounded product-defect class before generic parse-error fallback', () => {
  assert.equal(
    canonicalizeRootCauseClass("SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'"),
    'module_export_contract_mismatch',
  );
  assert.equal(
    canonicalizeRootCauseClass("does not provide an export named 'foo'"),
    'module_export_contract_mismatch',
  );
  assert.equal(
    canonicalizeRootCauseClass('module_export_contract'),
    'module_export_contract_mismatch',
  );
  // Bare SyntaxError without the export-contract signature stays on local_parse_failure.
  assert.equal(
    canonicalizeRootCauseClass('SyntaxError: Unexpected token }'),
    'local_parse_failure',
  );
});

test('validateRemediationProposal accepts v1.1 and v1.2 proposals', () => {
  const v11 = {
    schemaVersion: '1.1',
    kind: 'refresh_base_and_rereview',
    prerequisites: ['x'],
    retryKey: 'k',
    safetyLevel: 'operator_only',
    evidenceRefs: [],
    forbiddenActions: ['add_ready_label', 'merge', 'destructive_git', 'delete_branch'],
    recoveryPredicate: { kind: 'review_now_ready', details: { pr: '1' } },
  };
  assert.equal(validateRemediationProposal(v11).ok, true);
  const v12 = {
    ...v11,
    schemaVersion: '1.2',
    allowedActions: ['refresh_authoritative_base', 'rerun_review'],
    target: { prNumber: 1324, headSha: 'h', baseSha: 'b' },
    recommendationId: 'refresh_base_and_rereview',
    recoveryPredicate: { kind: 'review_attempt_progressed', details: {} },
  };
  assert.equal(validateRemediationProposal(v12).ok, true);
});

test('validateRemediationProposal rejects unsafe or malformed proposals', () => {
  const base = {
    schemaVersion: '1.2',
    kind: 'rereview_failed_challenge_arm',
    prerequisites: [],
    retryKey: 'k',
    safetyLevel: 'operator_only',
    evidenceRefs: [],
    forbiddenActions: ['add_ready_label', 'merge'],
  };
  const missingMerge = validateRemediationProposal({ ...base, forbiddenActions: ['add_ready_label'] });
  assert.equal(missingMerge.ok, false);
  assert.ok(!missingMerge.ok && missingMerge.errors.includes('forbiddenActions must include merge'));

  const overlap = validateRemediationProposal({ ...base, allowedActions: ['rerun_review'], forbiddenActions: ['add_ready_label', 'merge', 'rerun_review'] });
  assert.equal(overlap.ok, false);

  assert.equal(validateRemediationProposal({ ...base, kind: 'merge_now' }).ok, false);
  assert.equal(validateRemediationProposal({ ...base, schemaVersion: '9' }).ok, false);
  assert.equal(validateRemediationProposal({ ...base, allowedActions: ['merge_it'] }).ok, false);
  assert.equal(validateRemediationProposal({ ...base, recoveryPredicate: { kind: 'vibes', details: {} } }).ok, false);
  assert.equal(validateRemediationProposal(null).ok, false);
  assert.equal(validateRemediationProposal('proposal').ok, false);
  // Inspection proposals need forbidden actions but not necessarily ready/merge.
  assert.equal(validateRemediationProposal({ ...base, kind: 'inspection_only', safetyLevel: 'inspect', forbiddenActions: ['destructive_git'] }).ok, true);
});
