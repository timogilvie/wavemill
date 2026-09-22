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

test('agent_interactive_prompt_blocked round-trips and canonicalizes from legacy slugs', () => {
  assert.equal(canonicalizeRootCauseClass('agent_interactive_prompt_blocked'), 'agent_interactive_prompt_blocked');
  assert.equal(canonicalizeRootCauseClass('agent-interactive-prompt-blocked'), 'agent_interactive_prompt_blocked');
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
