import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { classifyFailure, type FailureDecision } from './failure-policy.ts';
import {
  RECOVERY_POLICY_ID,
  claimRecoveryAction,
  decideTaskRecovery,
  readRecoveryClaim,
  recoveryClaimPath,
  type RecoveryDisposition,
  type RecoveryFailure,
  type RecoverySnapshot,
} from './task-recovery-controller.ts';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'wm-recovery-'));
}

/** A minimal healthy snapshot; individual tests override the relevant fields. */
function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    issue: 'HOK-1',
    stage: 'coding',
    attempt: { currentRunId: null, controlRunId: null },
    disposition: null,
    stageResult: { kind: 'missing' },
    contractAvailable: null,
    outstandingEffect: null,
    wait: null,
    failure: null,
    ...overrides,
  };
}

function retryableFailure(retry: RecoveryFailure['retry'], stage: RecoverySnapshot['stage'] = 'coding'): RecoveryFailure {
  const decision = classifyFailure({ stage, detail: 'some novel error nobody has a signature for' });
  assert.equal(decision.class, 'retryable');
  return { decision, retry };
}

// ── decision ordering ─────────────────────────────────────────────────────────

test('stale attempt control is rejected while late evidence is retained', () => {
  const d = decideTaskRecovery(snapshot({
    attempt: { currentRunId: 'HOK-1:9:200', controlRunId: 'HOK-1:9:100' },
    stageResult: { kind: 'valid', status: 'completed' },
  }));
  assert.equal(d.action, 'reject-stale-control');
  assert.equal(d.controlBearing, false);
  assert.equal(d.policy, RECOVERY_POLICY_ID);
});

test('missing attempt identity fails safe: a valid completion with an anonymous trigger holds', () => {
  const d = decideTaskRecovery(snapshot({
    attempt: { currentRunId: 'HOK-1:9:200', controlRunId: null },
    stageResult: { kind: 'valid', status: 'completed' },
  }));
  assert.equal(d.action, 'wait');
  assert.equal(d.controlBearing, false);
});

test('a valid current completion advances without dispatching a retry', () => {
  const d = decideTaskRecovery(snapshot({
    attempt: { currentRunId: 'HOK-1:9:200', controlRunId: 'HOK-1:9:200' },
    stageResult: { kind: 'valid', status: 'completed' },
  }));
  assert.equal(d.action, 'consume-advance');
  assert.equal(d.controlBearing, true);
});

test('legacy rows (no run ids) advance a valid completion (grandfathered)', () => {
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'valid', status: 'awaiting_user' } }));
  assert.equal(d.action, 'consume-advance');
});

test('an in-flight agent is left alone', () => {
  const disposition: RecoveryDisposition = {
    kind: 'in-flight', reason: 'agent-working', evidenceConfidence: 'high', waitingOn: null, blockingPrompt: null,
  };
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'running' }, disposition }));
  assert.equal(d.action, 'no-action');
});

test('legitimate background work continues as a wait, not a relaunch', () => {
  const disposition: RecoveryDisposition = {
    kind: 'in-flight', reason: 'background-work', evidenceConfidence: 'low',
    waitingOn: { kind: 'background' }, blockingPrompt: null,
  };
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'running' }, disposition }));
  assert.equal(d.action, 'wait');
  assert.equal(d.wait?.owner, 'tool');
});

test('an explicit human hold is preserved (wait), not overridden', () => {
  const d = decideTaskRecovery(snapshot({
    wait: { owner: 'human', wake: 'operator-release' },
    stageResult: { kind: 'failed' },
    failure: retryableFailure('proceed'),
  }));
  assert.equal(d.action, 'wait');
  assert.equal(d.wait?.owner, 'human');
});

test('an uncertain external effect is verified, not duplicated', () => {
  const d = decideTaskRecovery(snapshot({
    stageResult: { kind: 'missing' },
    outstandingEffect: { kind: 'label-write', acknowledged: false },
  }));
  assert.equal(d.action, 'verify-effect');
});

test('a retryable failure with budget left retries the stage', () => {
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: retryableFailure('proceed') }));
  assert.equal(d.action, 'retry-stage');
  assert.equal(d.retryBucket, 'stage-failure-coding');
});

test('a retryable failure in backoff waits', () => {
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: retryableFailure('backoff') }));
  assert.equal(d.action, 'wait');
  assert.equal(d.wait?.owner, 'backoff');
});

test('an exhausted retry budget escalates once, with an exhausted basis', () => {
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: retryableFailure('exhausted') }));
  assert.equal(d.action, 'escalate');
  assert.equal(d.escalationBasis?.kind, 'exhausted');
});

test('a terminal cause escalates with a policy-terminal basis', () => {
  const decision = classifyFailure({ stage: 'coding', failureKind: 'policy-denied' });
  assert.equal(decision.class, 'terminal');
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: { decision, retry: 'proceed' } }));
  assert.equal(d.action, 'escalate');
  assert.equal(d.escalationBasis?.kind, 'policy-terminal');
});

test('a recognised code failure is sent to remediation', () => {
  const decision = classifyFailure({ stage: 'coding', detail: 'CONFLICT (content): merge conflict in foo.ts' });
  assert.equal(decision.class, 'code-failure');
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: { decision, retry: 'proceed' } }));
  assert.equal(d.action, 'remediate');
});

test('a coding retry holds when no execution contract is available to replay', () => {
  const d = decideTaskRecovery(snapshot({
    stage: 'coding',
    stageResult: { kind: 'failed' },
    contractAvailable: false,
    failure: retryableFailure('proceed'),
  }));
  assert.equal(d.action, 'wait');
  assert.equal(d.wait?.wake, 'execution-contract-available');
});

test('missing/contradictory evidence is never read as success', () => {
  // stage exited (failed) but no classification supplied: hold, do not advance.
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: null }));
  assert.equal(d.action, 'wait');
  assert.notEqual(d.action, 'consume-advance');
});

test('a settled agent at a recognised blocking prompt escalates once', () => {
  const disposition: RecoveryDisposition = {
    kind: 'settled', reason: 'blocking-prompt:trust', evidenceConfidence: 'low', waitingOn: null,
    blockingPrompt: { id: 'trust', detail: 'Do you trust the authors?' } as RecoveryDisposition['blockingPrompt'],
  };
  const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'running' }, disposition }));
  assert.equal(d.action, 'escalate');
  assert.equal(d.escalationBasis?.kind, 'operator-decision');
});

// ── claim seam ─────────────────────────────────────────────────────────────────

test('concurrent notifications for the same condition produce exactly one claim', () => {
  const dir = freshDir();
  try {
    const d = decideTaskRecovery(snapshot({
      attempt: { currentRunId: 'HOK-1:9:200', controlRunId: 'HOK-1:9:200' },
      stageResult: { kind: 'failed' },
      failure: retryableFailure('proceed'),
    }));
    const args = { stateDir: dir, decision: d, runId: 'HOK-1:9:200', evidenceId: 'ev-abc' };
    const first = claimRecoveryAction(args);
    const second = claimRecoveryAction(args);
    const third = claimRecoveryAction(args);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(third.claimed, false);
    if (!second.claimed) assert.equal(second.reason, 'already-claimed');
    // The persisted claim is the one winner's.
    const persisted = readRecoveryClaim(dir);
    assert.ok(persisted);
    assert.equal(persisted?.action, 'retry-stage');
    assert.equal(persisted?.runId, 'HOK-1:9:200');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-control-bearing decision is never claimed', () => {
  const dir = freshDir();
  try {
    const d = decideTaskRecovery(snapshot({ stageResult: { kind: 'running' } }));
    assert.equal(d.action, 'no-action');
    const result = claimRecoveryAction({ stateDir: dir, decision: d, runId: null, evidenceId: 'x' });
    assert.equal(result.claimed, false);
    if (!result.claimed) assert.equal(result.reason, 'not-control-bearing');
    assert.equal(readRecoveryClaim(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim for the current run supersedes a stale-run claim', () => {
  const dir = freshDir();
  try {
    const mkDecision = (): ReturnType<typeof decideTaskRecovery> => decideTaskRecovery(snapshot({
      attempt: { currentRunId: 'run', controlRunId: 'run' },
      stageResult: { kind: 'failed' },
      failure: retryableFailure('proceed'),
    }));
    const stale = claimRecoveryAction({ stateDir: dir, decision: mkDecision(), runId: 'HOK-1:9:100', evidenceId: 'ev-old' });
    assert.equal(stale.claimed, true);
    const current = claimRecoveryAction({ stateDir: dir, decision: mkDecision(), runId: 'HOK-1:9:200', evidenceId: 'ev-new' });
    assert.equal(current.claimed, true);
    assert.equal(readRecoveryClaim(dir)?.runId, 'HOK-1:9:200');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the claim path is under the task state dir', () => {
  assert.ok(recoveryClaimPath('/tmp/x').endsWith('/.recovery-claim.json'));
});

// Keeps FailureDecision import meaningful even if a case above is removed.
const _typecheck: FailureDecision['class'] = 'retryable';
void _typecheck;
