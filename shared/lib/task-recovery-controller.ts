
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { isSameRunId } from './attempt-identity.ts';
import type { EscalationBasis } from './operator-escalation.ts';
import type { BoundedRetryDecision } from './bounded-retry.ts';
import type { FailureDecision, FailureStage } from './failure-policy.ts';
import type { StageAgentDisposition } from './stage-agent-disposition.ts';
import { mutateJsonStateSync } from './state-mutex.ts';
import { acquireStateLockSync, releaseStateLock } from './state-lock.ts';
import { readWorkflowState } from './workflow-state.ts';
import { readStageResult } from './stage-result.ts';
import { isSettled } from './task-settlement.ts';

export const RECOVERY_POLICY = Object.freeze({ name: 'task-recovery-controller', version: 1 } as const);

export const RECOVERY_POLICY_ID = `${RECOVERY_POLICY.name}@${RECOVERY_POLICY.version}` as const;

// ── Snapshot contract ────────────────────────────────────────────────────────

export interface RecoveryWait {
  owner: 'dependency' | 'ci' | 'tool' | 'backoff' | 'human';
    wake: string;
  detail?: string;
}

export interface RecoveryAttempt {
  currentRunId: string | null;
  controlRunId: string | null;
}

export type RecoveryStageResult =
  | { kind: 'missing' }
  | { kind: 'running' }
  | { kind: 'valid'; status: 'completed' | 'awaiting_user' }
  | { kind: 'failed' }
  | { kind: 'invalid'; detail: string };

export interface RecoveryOutstandingEffect {
  kind: string;
  acknowledged: boolean;
  detail?: string;
}

export interface RecoveryFailure {
  decision: FailureDecision;
  retry: BoundedRetryDecision;
}

export type RecoveryDisposition = Pick<
  StageAgentDisposition,
  'kind' | 'reason' | 'evidenceConfidence' | 'waitingOn' | 'blockingPrompt'
>;

export interface RecoverySnapshot {
  issue: string;
  stage: FailureStage;
  attempt: RecoveryAttempt;
    disposition: RecoveryDisposition | null;
  stageResult: RecoveryStageResult;
    contractAvailable: boolean | null;
  outstandingEffect: RecoveryOutstandingEffect | null;
    wait: RecoveryWait | null;
    failure: RecoveryFailure | null;
}

// ── Decision ─────────────────────────────────────────────────────────────────

export type RecoveryActionKind =
  | 'no-action'
  | 'wait'
  | 'consume-advance'
  | 'verify-effect'
  | 'retry-stage'
  | 'remediate'
  | 'escalate'
  | 'reject-stale-control';

export interface RecoveryDecision {
  action: RecoveryActionKind;
  rationale: string;
  policy: typeof RECOVERY_POLICY_ID;
  stage: FailureStage;
  wait?: RecoveryWait;
  failureKind?: string;
  nextAction?: string;
  retryBucket?: string;
  escalationBasis?: EscalationBasis;
    controlBearing: boolean;
}

const WAIT_ACTIONS: ReadonlySet<RecoveryActionKind> = new Set(['no-action', 'wait', 'verify-effect', 'reject-stale-control']);

function decision(stage: FailureStage, action: RecoveryActionKind, rationale: string, extra: Partial<RecoveryDecision> = {}): RecoveryDecision {
  return {
    action,
    rationale,
    policy: RECOVERY_POLICY_ID,
    stage,
    controlBearing: !WAIT_ACTIONS.has(action),
    ...extra,
  };
}

export function decideTaskRecovery(snapshot: RecoverySnapshot): RecoveryDecision {
  const { stage, attempt } = snapshot;

  // 1. Stale attempt control (HOK-3373). A known mismatch rejects control; the
  //    late evidence and cost are retained by the evidence seam, not here.
  if (
    attempt.currentRunId !== null
    && attempt.controlRunId !== null
    && !isSameRunId(attempt.currentRunId, attempt.controlRunId)
  ) {
    return decision(stage, 'reject-stale-control',
      `trigger run ${attempt.controlRunId} is not the current run ${attempt.currentRunId}; retaining late evidence without controlling the current attempt`);
  }

  // 2. Unverifiable identity: a current run exists but the trigger is anonymous.
  //    Only a control-bearing outcome is unsafe; a plain wait is fine.
  const unverifiableIdentity = attempt.currentRunId !== null && attempt.controlRunId === null;

  // 3. Explicit human hold survives restart/retry.
  if (snapshot.wait?.owner === 'human') {
    return decision(stage, 'wait', `explicit human hold (${snapshot.wait.wake})`, { wait: snapshot.wait });
  }

  // 6. A valid current completion is consumed, not rerun.
  if (snapshot.stageResult.kind === 'valid') {
    if (unverifiableIdentity) {
      return decision(stage, 'wait', 'valid completion present but its attempt identity is unverifiable; holding for reassessment', {
        wait: { owner: 'tool', wake: 'attempt-identity-resolved' },
      });
    }
    return decision(stage, 'consume-advance', `consume the ${snapshot.stageResult.status} result through the normal transition (no rerun)`);
  }

  // 7. Uncertain external effect: verify, never duplicate.
  if (snapshot.outstandingEffect && !snapshot.outstandingEffect.acknowledged) {
    return decision(stage, 'verify-effect',
      `effect ${snapshot.outstandingEffect.kind} applied but acknowledgement is uncertain; verify observed state before acting`);
  }

  // 4. Live disposition: healthy / in-flight / advanced / terminal.
  const disp = snapshot.disposition;
  if (disp) {
    if (disp.kind === 'in-flight') {
      const waiting = disp.waitingOn;
      if (waiting && (waiting.kind === 'background' || waiting.kind === 'approval' || waiting.kind === 'operator')) {
        return decision(stage, 'wait', `agent in-flight, ${disp.reason}`, {
          wait: {
            owner: waiting.kind === 'background' ? 'tool' : 'human',
            wake: waiting.kind === 'background' ? 'background-work-complete' : 'operator-release',
            ...(waiting.detail ? { detail: waiting.detail } : {}),
          },
        });
      }
      return decision(stage, 'no-action', `agent in-flight (${disp.reason})`);
    }
    if (disp.kind === 'advanced') {
      return decision(stage, 'no-action', `head advanced (${disp.reason}); CI remediation owns it`);
    }
    if (disp.kind === 'inactive' && disp.reason === 'task-terminal') {
      return decision(stage, 'no-action', 'task already terminal');
    }
    // A settled agent parked at a recognised blocking prompt is a single
    // operator-decision escalation (the one escalation seam owns it).
    if (disp.kind === 'settled' && disp.blockingPrompt) {
      return decision(stage, 'escalate', `agent parked at prompt ${disp.blockingPrompt.id}`, {
        escalationBasis: { kind: 'operator-decision', code: 'stage-blocking-prompt' },
      });
    }
  }

  // 5. Legitimate non-human wait.
  if (snapshot.wait && snapshot.failure === null) {
    return decision(stage, 'wait', `legitimate wait owned by ${snapshot.wait.owner} (${snapshot.wait.wake})`, { wait: snapshot.wait });
  }

  // 8. Classified failure → delegate to the failure authorities.
  if (snapshot.failure) {
    if (unverifiableIdentity) {
      return decision(stage, 'wait', 'failure evidence cannot be tied to the current attempt; holding for reassessment', {
        wait: { owner: 'tool', wake: 'attempt-identity-resolved' },
      });
    }
    return decideFromFailure(snapshot, snapshot.failure);
  }

  // 9. A stage that exited without a usable result, but no classification was
  //    supplied, is incomplete evidence — hold and reassess, never success.
  if (snapshot.stageResult.kind === 'failed' || snapshot.stageResult.kind === 'invalid') {
    return decision(stage, 'wait', 'stage exited without a classified result; awaiting failure classification', {
      wait: { owner: 'tool', wake: 'failure-classified' },
    });
  }

  if (snapshot.stageResult.kind === 'running') {
    return decision(stage, 'no-action', 'stage still running');
  }

  // No evidence of trouble and nothing to consume.
  return decision(stage, 'no-action', 'no outstanding recovery obligation');
}

function decideFromFailure(snapshot: RecoverySnapshot, failure: RecoveryFailure): RecoveryDecision {
  const { stage } = snapshot;
  const { decision: fd, retry } = failure;
  const base: Partial<RecoveryDecision> = { failureKind: fd.failureKind, nextAction: fd.nextAction };

  if (fd.class === 'terminal') {
    return decision(stage, 'escalate', `allowlisted terminal cause ${fd.failureKind}: ${fd.cause?.reason ?? fd.rationale}`, {
      ...base,
      escalationBasis: { kind: 'policy-terminal', decisionClass: 'terminal' },
    });
  }

  if (fd.class === 'code-failure') {
    return decision(stage, 'remediate', `recognised code failure (${fd.failureKind}); hand the excerpt to remediation`, base);
  }

  // retryable
  const bucket = fd.retryBucket ?? `stage-failure-${stage}`;
  if (retry === 'backoff') {
    return decision(stage, 'wait', `${fd.failureKind} retryable; backing off before the next ${stage} relaunch`, {
      ...base,
      retryBucket: bucket,
      wait: { owner: 'backoff', wake: 'backoff-elapsed' },
    });
  }
  if (retry === 'exhausted' || retry === 'exhausted-quiet') {
    return decision(stage, 'escalate', `${bucket} exhausted after retries for ${fd.failureKind}`, {
      ...base,
      retryBucket: bucket,
      escalationBasis: { kind: 'exhausted', bucket },
    });
  }
  // proceed: a coding replay requires a persisted execution contract; an
  // unavailable contract holds under the same budget (never a model swap).
  if (stage === 'coding' && snapshot.contractAvailable === false) {
    return decision(stage, 'wait', 'coding retry requires a persisted execution contract to replay; holding until one is available', {
      ...base,
      retryBucket: bucket,
      wait: { owner: 'tool', wake: 'execution-contract-available' },
    });
  }
  return decision(stage, 'retry-stage', `${fd.failureKind} is retryable; relaunch ${stage} under ${bucket}`, {
    ...base,
    retryBucket: bucket,
  });
}

// ── Claim seam ───────────────────────────────────────────────────────────────

export interface RecoveryClaim {
  policy: typeof RECOVERY_POLICY_ID;
  action: RecoveryActionKind;
  stage: FailureStage;
    runId: string | null;
    evidenceId: string;
  claimedAt: string;
    claimId: string;
  acknowledgedAt?: string;
}

export interface ClaimRecoveryArgs {
  stateDir: string;
  decision: RecoveryDecision;
  runId: string | null;
  evidenceId: string;
  now?: () => Date;
    claimPath?: string;
    stateFile?: string;
  issue?: string;
}

export type ClaimResult =
  | { claimed: true; claim: RecoveryClaim }
  | { claimed: false; reason: 'already-claimed' | 'not-control-bearing' | 'stale-run' | 'settled-attempt'; existing?: RecoveryClaim };

export const RECOVERY_CLAIM_BASENAME = '.recovery-claim.json';
export const RECOVERY_ACTIONS_BASENAME = '.recovery-actions.jsonl';

export function recoveryClaimPath(stateDir: string): string {
  return join(stateDir, RECOVERY_CLAIM_BASENAME);
}

function sameClaimIdentity(a: RecoveryClaim, action: RecoveryActionKind, stage: FailureStage, runId: string | null, evidenceId: string): boolean {
  return a.action === action && a.stage === stage && a.evidenceId === evidenceId && (a.runId ?? null) === (runId ?? null);
}

export function claimRecoveryAction(args: ClaimRecoveryArgs): ClaimResult {
  if (!args.stateFile) return claimCurrentRecoveryAction(args);
  const lock = acquireStateLockSync(args.stateFile, { purpose: 'claim-task-recovery' });
  try {
    const task = readWorkflowState(args.stateFile)?.tasks?.[args.issue ?? ''];
    if (!task || ((task.runId != null || args.runId != null) && !isSameRunId(task.runId, args.runId))) return { claimed: false, reason: 'stale-run' };
    if (isSettled(task)) return { claimed: false, reason: 'settled-attempt' };
    return claimCurrentRecoveryAction(args);
  } finally {
    releaseStateLock(lock);
  }
}

function claimCurrentRecoveryAction(args: ClaimRecoveryArgs): ClaimResult {
  const { decision: dec, runId, evidenceId } = args;
  if (!dec.controlBearing) {
    return { claimed: false, reason: 'not-control-bearing' };
  }
  const now = (args.now ?? (() => new Date()))();
  const claimPath = args.claimPath ?? recoveryClaimPath(args.stateDir);
  const claimId = randomUUID();

  let outcome: ClaimResult = { claimed: false, reason: 'already-claimed' };
  mutateJsonStateSync<{ claim?: RecoveryClaim }>(
    claimPath,
    (current) => {
      const existing = current.claim;
      if (existing && sameClaimIdentity(existing, dec.action, dec.stage, runId, evidenceId)) {
        // An identical claim already exists: another notifier won. Keep it.
        outcome = { claimed: false, reason: 'already-claimed', existing };
        return current;
      }
      // Only a newer attempt may supersede an existing claim.  Evidence is a
      // notification identity, not a new unit of control: accepting a
      // different evidence id for this same run would let two concurrent
      // notifiers dispatch two recovery-bearing actions.
      if (existing && !existing.acknowledgedAt && (existing.runId ?? null) === (runId ?? null)) {
        outcome = { claimed: false, reason: 'already-claimed', existing };
        return current;
      }
      // There is no claim, or the claim belongs to a superseded run.
      const claim: RecoveryClaim = {
        policy: RECOVERY_POLICY_ID,
        action: dec.action,
        stage: dec.stage,
        runId: runId ?? null,
        evidenceId,
        claimedAt: now.toISOString(),
        claimId,
      };
      outcome = { claimed: true, claim };
      return { ...current, claim };
    },
    { createIfMissing: true, initial: {} },
  );
  return outcome;
}

export function acknowledgeRecoveryAction(stateDir: string, claimId: string, now = new Date()): boolean {
  let acknowledged = false;
  mutateJsonStateSync<{ claim?: RecoveryClaim }>(recoveryClaimPath(stateDir), current => {
    if (current.claim?.claimId !== claimId) return current;
    acknowledged = true;
    return { ...current, claim: { ...current.claim, acknowledgedAt: now.toISOString() } };
  }, { createIfMissing: true, initial: {} });
  return acknowledged;
}

export function readRecoveryClaim(stateDir: string, claimPath?: string): RecoveryClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(claimPath ?? recoveryClaimPath(stateDir), 'utf-8')) as { claim?: RecoveryClaim };
    return parsed.claim ?? null;
  } catch {
    return null;
  }
}

export interface RecoveryAuditEntry {
  at: string;
  policy: typeof RECOVERY_POLICY_ID;
  issue: string;
  stage: FailureStage;
  action: RecoveryActionKind;
  runId: string | null;
  evidenceId: string;
  rationale: string;
    duplicateEffectPrevented?: boolean;
}

export function recordRecoveryAction(
  stateDir: string,
  entry: Omit<RecoveryAuditEntry, 'policy'>,
  auditPath?: string,
): void {
  const path = auditPath ?? join(stateDir, RECOVERY_ACTIONS_BASENAME);
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path, `${JSON.stringify({ policy: RECOVERY_POLICY_ID, ...entry })}\n`, 'utf-8');
  } catch {
    // best-effort
  }
}

export async function runControllerCli(): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const stateDir = flag('--state-dir');
  const evidenceId = flag('--evidence-id');
  const snapshotPath = flag('--snapshot');
  if (!stateDir || (!flag('--ack') && !flag('--disposition') && (!evidenceId || !snapshotPath))) {
    process.stderr.write('task-recovery-controller: usage: --state-dir DIR --evidence-id ID --snapshot FILE\n');
    process.exitCode = 2;
    return;
  }
  const dispositionJson = flag('--disposition');
  if (dispositionJson) {
    const issue = flag('--issue') ?? '';
    const stage = flag('--stage') as FailureStage;
    const state = readWorkflowState(flag('--state-file') ?? '');
    const task = state?.tasks?.[issue];
    const result = await readStageResult(stateDir, stage);
    const snapshot: RecoverySnapshot = {
      issue, stage, attempt: { currentRunId: task?.runId ?? null, controlRunId: task?.runId ?? null },
      disposition: JSON.parse(dispositionJson),
      stageResult: result?.status === 'completed' || result?.status === 'awaiting_user'
        ? { kind: 'valid', status: result.status } : { kind: 'running' },
      contractAvailable: null, outstandingEffect: null, wait: null, failure: null,
    };
    process.stdout.write(`${JSON.stringify({ decision: decideTaskRecovery(snapshot) })}\n`);
    return;
  }
  const ack = flag('--ack');
  if (ack) {
    process.stdout.write(`${JSON.stringify({ acknowledged: acknowledgeRecoveryAction(stateDir, ack) })}\n`);
    return;
  }
  if (!snapshotPath || !evidenceId) return;
  let snapshot: RecoverySnapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as RecoverySnapshot;
  } catch (error) {
    process.stderr.write(`task-recovery-controller: cannot read snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const selected = decideTaskRecovery(snapshot);
  const claim = claimRecoveryAction({ stateDir, decision: selected, runId: snapshot.attempt.controlRunId, evidenceId, stateFile: flag('--state-file'), issue: snapshot.issue });
  if (claim.claimed) {
    recordRecoveryAction(stateDir, {
      at: claim.claim.claimedAt,
      issue: snapshot.issue,
      stage: snapshot.stage,
      action: selected.action,
      runId: snapshot.attempt.currentRunId,
      evidenceId,
      rationale: selected.rationale,
    });
  }
  process.stdout.write(`${JSON.stringify({ decision: selected, claim })}\n`);
}
