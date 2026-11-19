/**
 * HOK-3406 integration check: the shared recovery controller, driven the way
 * the Monitor drives it, deduplicates repeated repair evidence and refuses to
 * bypass an explicit human hold or a settled attempt.
 *
 * Runs inside the observer-independent-recovery golden journey against the
 * real controller module (not a stub). Writes only under mkdtemp.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkflowState } from '../../../lib/task-builder.ts';
import { classifyFailure } from '../../../../shared/lib/failure-policy.ts';
import {
  claimRecoveryAction,
  decideTaskRecovery,
  readRecoveryClaim,
  type RecoverySnapshot,
} from '../../../../shared/lib/task-recovery-controller.ts';

function baseDriftSnapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    issue: 'JRN-HOLD',
    stage: 'ready',
    attempt: { currentRunId: 'run', controlRunId: 'run' },
    evidence: undefined,
    baseDrift: true,
    disposition: null,
    stageResult: { kind: 'failed' },
    recoveryContract: null,
    outstandingEffect: null,
    wait: null,
    failure: { decision: classifyFailure({ stage: 'ready', detail: 'some novel ready error' }), retry: 'proceed' },
    ...overrides,
  };
}

function main(): void {
  const decision = decideTaskRecovery(baseDriftSnapshot());
  assert.equal(decision.action, 'remediate');
  assert.equal(decision.nextAction, 'update-base');

  // REQ-F4: five repeated findings for one attempt collapse to one claim.
  const dedupDir = mkdtempSync(join(tmpdir(), 'observer-independent-dedup-'));
  try {
    const outcomes = Array.from({ length: 5 }, (_, tick) =>
      claimRecoveryAction({ stateDir: dedupDir, decision, runId: 'run', evidenceId: `finding-${tick}` }));
    assert.equal(outcomes.filter((outcome) => outcome.claimed).length, 1, 'exactly one claimed execution');
    assert.equal(outcomes.filter((outcome) => !outcome.claimed && outcome.reason === 'already-claimed').length, 4);
  } finally {
    rmSync(dedupDir, { recursive: true, force: true });
  }

  // REQ-F6: an explicit human hold is a wait, never a control-bearing claim.
  const holdDecision = decideTaskRecovery(baseDriftSnapshot({ wait: { owner: 'human', wake: 'operator-release' } }));
  assert.equal(holdDecision.action, 'wait');
  const holdDir = mkdtempSync(join(tmpdir(), 'observer-independent-hold-'));
  try {
    assert.deepEqual(
      claimRecoveryAction({ stateDir: holdDir, decision: holdDecision, runId: 'run', evidenceId: 'hold' }),
      { claimed: false, reason: 'not-control-bearing' },
    );
    assert.equal(readRecoveryClaim(holdDir), null);
  } finally {
    rmSync(holdDir, { recursive: true, force: true });
  }

  // REQ-F6: a settled attempt bypasses automated recovery.
  const settledDir = mkdtempSync(join(tmpdir(), 'observer-independent-settled-'));
  try {
    const stateFile = join(settledDir, 'workflow-state.json');
    writeFileSync(stateFile, JSON.stringify(buildWorkflowState({
      'JRN-HOLD': {
        runId: 'run',
        phase: 'ready',
        lifecycle: { schemaVersion: 1, workflowOutcome: 'aborted', resourceDisposition: 'released' },
      },
    })));
    assert.deepEqual(
      claimRecoveryAction({ stateDir: settledDir, stateFile, issue: 'JRN-HOLD', decision, runId: 'run', evidenceId: 'settled' }),
      { claimed: false, reason: 'settled-attempt' },
    );
    assert.equal(readRecoveryClaim(settledDir), null);
  } finally {
    rmSync(settledDir, { recursive: true, force: true });
  }

  process.stdout.write('controller-check: ok\n');
}

main();
