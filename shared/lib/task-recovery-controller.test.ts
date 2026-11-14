import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';

import { classifyFailure, type FailureDecision } from './failure-policy.ts';
import {
  RECOVERY_POLICY_ID,
  acknowledgeRecoveryAction,
  reconcileAndRecover,
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

test('distinct notifications cannot replace a current attempt claim', () => {
  const dir = freshDir();
  try {
    // Use the canonical schema fixture builder: this is the task-row run id
    // the controller controls, rather than an ad-hoc workflow-state shape.
    const state = buildWorkflowState({ 'HOK-1': { runId: 'HOK-1:9:200' } });
    const runId = state.tasks['HOK-1']?.runId;
    assert.equal(runId, 'HOK-1:9:200');
    const d = decideTaskRecovery(snapshot({
      attempt: { currentRunId: runId ?? null, controlRunId: runId ?? null },
      stageResult: { kind: 'failed' },
      failure: retryableFailure('proceed'),
    }));
    const first = claimRecoveryAction({ stateDir: dir, decision: d, runId: runId ?? null, evidenceId: 'monitor-event' });
    const second = claimRecoveryAction({ stateDir: dir, decision: d, runId: runId ?? null, evidenceId: 'observer-event' });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(readRecoveryClaim(dir)?.evidenceId, 'monitor-event');
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


test('claim fences the authoritative run and settled outcome at dispatch time', () => {
  const dir = freshDir();
  try {
    const stateFile = join(dir, 'workflow-state.json');
    const current = buildWorkflowState({ 'HOK-1': { runId: 'new-run' } });
    writeFileSync(stateFile, JSON.stringify(current));
    const dec = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: retryableFailure('proceed') }));
    const args = { stateDir: dir, decision: dec, issue: 'HOK-1', stateFile, runId: 'old-run', evidenceId: 'late' };
    assert.deepEqual(claimRecoveryAction(args), { claimed: false, reason: 'stale-run' });
    assert.equal(readRecoveryClaim(dir), null);
    assert.equal(claimRecoveryAction({ ...args, runId: 'new-run' }).claimed, true);
    const settled = buildWorkflowState({ 'HOK-1': { runId: 'new-run', lifecycle: { schemaVersion: 1, workflowOutcome: 'aborted', resourceDisposition: 'released' } } });
    writeFileSync(stateFile, JSON.stringify(settled));
    assert.deepEqual(claimRecoveryAction({ ...args, runId: 'new-run', evidenceId: 'after-abort' }), { claimed: false, reason: 'settled-attempt' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acknowledged actions allow the next obligation but not duplicate evidence or stale acknowledgements', () => {
  const dir = freshDir();
  try {
    const dec = decideTaskRecovery(snapshot({ stageResult: { kind: 'failed' }, failure: retryableFailure('proceed') }));
    const args = { stateDir: dir, decision: dec, runId: 'run', evidenceId: 'coding-1' };
    const first = claimRecoveryAction(args);
    assert.equal(first.claimed, true);
    if (!first.claimed) return;
    assert.equal(acknowledgeRecoveryAction(dir, first.claim.claimId), true);
    assert.equal(claimRecoveryAction(args).claimed, false);
    const next = claimRecoveryAction({ ...args, evidenceId: 'review-1', decision: { ...dec, stage: 'review' } });
    assert.equal(next.claimed, true);
    assert.equal(acknowledgeRecoveryAction(dir, first.claim.claimId), false);
    assert.equal(claimRecoveryAction({ ...args, evidenceId: 'other-notification' }).claimed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completed result and unacknowledged effects precede a stale live disposition', () => {
  const disp: RecoveryDisposition = { kind: 'in-flight', reason: 'agent-working', evidenceConfidence: 'high', waitingOn: null, blockingPrompt: null };
  assert.equal(decideTaskRecovery(snapshot({ disposition: disp, stageResult: { kind: 'valid', status: 'completed' } })).action, 'consume-advance');
  assert.equal(decideTaskRecovery(snapshot({ disposition: disp, outstandingEffect: { kind: 'push', acknowledged: false } })).action, 'verify-effect');
});


test('a dead controller claim is reconciled from observed stage state before replay', async () => {
  const dir = freshDir();
  try {
    const stateFile = join(dir, 'workflow-state.json');
    writeFileSync(stateFile, JSON.stringify(buildWorkflowState({ 'HOK-1': { runId: 'run' } })));
    const snap = snapshot({ attempt: { currentRunId: 'run', controlRunId: 'run' }, stageResult: { kind: 'failed' }, failure: retryableFailure('proceed') });
    const args = { stateDir: dir, stateFile, issue: 'HOK-1', snapshot: snap, decision: decideTaskRecovery(snap), runId: 'run', evidenceId: 'before-dispatch' };
    const first = claimRecoveryAction(args);
    assert.equal(first.claimed, true);
    if (!first.claimed) return;
    const claimPath = recoveryClaimPath(dir);
    const abandoned = { ...first.claim, owner: { ...first.claim.owner!, startTime: 'replaced-process-identity' } };
    writeFileSync(claimPath, JSON.stringify({ claim: abandoned }));
    // Missing/running output is uncertain: verify instead of repeating a launch.
    assert.equal((await reconcileAndRecover(args)).decision.action, 'verify-effect');
    // A terminal result written after effect application is consumed, never rerun.
    const result = { stage: 'coding', status: 'completed', agent: 'claude', startedAt: '2026-11-13T00:00:00Z', finishedAt: '2026-11-13T00:01:00Z' };
    writeFileSync(join(dir, '.coding-result.json'), JSON.stringify(result));
    const recovered = await reconcileAndRecover(args);
    assert.equal(recovered.decision.action, 'consume-advance');
    assert.equal(recovered.claim.claimed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// protects: remediation shares the relaunch budget instead of bypassing exhaustion.
test('code remediation respects backoff, exhaustion, and the persisted coding contract', () => {
  const decision = classifyFailure({ stage: 'coding', detail: 'CONFLICT (content): merge conflict in foo.ts' });
  for (const [retry, action] of [['backoff', 'wait'], ['exhausted', 'escalate'], ['exhausted-quiet', 'escalate']] as const) {
    assert.equal(decideTaskRecovery(snapshot({stageResult:{kind:'failed'}, failure:{decision,retry}})).action, action);
  }
  assert.equal(decideTaskRecovery(snapshot({contractAvailable:false, stageResult:{kind:'failed'}, failure:{decision,retry:'proceed'}})).action, 'wait');
});

test('Ready transition code faults and base drift select claimed operator or update actions', () => {
  const decision = classifyFailure({ stage: 'ready', detail: 'CONFLICT (content): merge conflict in foo.ts' });
  const input = snapshot({stage:'ready',stageResult:{kind:'failed'},failure:{decision,retry:'proceed',source:'transition'}});
  assert.equal(decideTaskRecovery(input).escalationBasis?.kind, 'operator-decision');
  assert.equal(decideTaskRecovery({...input,baseDrift:true}).nextAction, 'update-base');
});

// protects: task replacement cannot interleave between run validation and claim creation.
test('authoritative workflow lock remains held while creating a recovery claim', () => {
  const dir = freshDir();
  try {
    const stateFile = join(dir, 'workflow-state.json');
    writeFileSync(stateFile, JSON.stringify(buildWorkflowState({'HOK-1':{runId:'run'}})));
    const selected = decideTaskRecovery(snapshot({stageResult:{kind:'failed'},failure:retryableFailure('proceed')}));
    const result = claimRecoveryAction({stateDir:dir,stateFile,issue:'HOK-1',runId:'run',evidenceId:'locked',decision:selected,
      now: () => { assert.equal(existsSync(`${stateFile}.lock`), true); return new Date(); }});
    assert.equal(result.claimed, true);
    assert.equal(existsSync(`${stateFile}.lock`), false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
