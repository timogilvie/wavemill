import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INCIDENT_ROOT_CAUSE_CLASSES, canonicalizeRootCauseClass } from './wavemill-incident-model.ts';

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
