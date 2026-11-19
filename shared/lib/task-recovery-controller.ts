
import { processStartTime, processHost } from './process-identity.ts';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { isSameRunId } from './attempt-identity.ts';
import type { EscalationBasis } from './operator-escalation.ts';
import type { BoundedRetryDecision } from './bounded-retry.ts';
import {
  classifyFailure,
  nextActionFor,
  retryBucketFor,
  settledWithoutResultDetail,
  type FailureDecision,
  type FailureStage,
} from './failure-policy.ts';
import type { StageAgentDisposition } from './stage-agent-disposition.ts';
import { resolveNativeSessionPath } from './task-progress.ts';
import {
  openHarnessToolCall,
  readNativeTranscriptEvents,
  resolveNativeTranscriptPath,
  type OpenHarnessToolCall,
} from './native-agent/stage-time-split.ts';
import { mutateJsonStateSync } from './state-mutex.ts';
import { acquireStateLockSync, releaseStateLock, isOwnerReclaimable } from './state-lock.ts';
import { readWorkflowState } from './workflow-state.ts';
import { readStageResult, stageResultRunIdentity, type StageResult } from './stage-result.ts';
import { readOwnershipRows } from './session-ownership.ts';
import { archiveLateStageEvidence } from './task-evidence-archive.ts';
import { isSettled } from './task-settlement.ts';
import type { readValidatedContract } from './execution-contract.ts';

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
  source?: 'ci' | 'transition';
  decision: FailureDecision;
  retry: BoundedRetryDecision;
}

/**
 * The saved-route validator result (`validateContractLaunchable`, HOK-3326),
 * carried intact (HOK-3512) — reason, detail and the persisted contract —
 * so a refusal reaches the decision and the inbox with its cause.
 */
export interface RecoveryContractValidation {
  ok: boolean;
  reason?: string | null;
  detail?: string | null;
  contract?: { model?: string | null; agent?: string | null; provider?: string | null } | null;
}

/** The failure kind a refused saved route is classified under (`failure-policy.ts`). */
export const RECOVERY_CONTRACT_UNAVAILABLE = 'recovery_contract_unavailable';

export type RecoveryDisposition = Pick<
  StageAgentDisposition,
  'kind' | 'reason' | 'evidenceConfidence' | 'waitingOn' | 'blockingPrompt'
>;

/**
 * Why reassessment of a live stage is due (HOK-3277 / HOK-3382). `due` comes
 * from the shared stall clock (`TaskProgress.stalled`); per HOK-3277 a
 * deadline means "reassess", never automatic termination. `harnessHold` names
 * an open native harness tool call when the transcript proves one — that is
 * what makes the stall a *harness* hang rather than the model/provider holding
 * the loop.
 */
export interface RecoveryReassessment {
  due: boolean;
  basis: 'no-progress';
  /** ISO time of the newest agent-written progress, or null when the launch anchor is all there is. */
  lastProgressAt: string | null;
  /** The harness tool call holding the loop, or null when the loop is not waiting on one. */
  harnessHold: { toolName: string; toolCallId: string; startedAt: string } | null;
}

export interface RecoverySnapshot {
  /** Original notifier evidence, retained on stale control without re-metering. */
  evidence?: { stageResult?: StageResult | null };
  baseDrift?: boolean;
  issue: string;
  stage: FailureStage;
  attempt: RecoveryAttempt;
    disposition: RecoveryDisposition | null;
  stageResult: RecoveryStageResult;
  /** HOK-3512: the saved route's launch validation, when the caller replays one. */
  contract?: RecoveryContractValidation | null;
  executionContract: ReturnType<typeof readValidatedContract>
    | {ok: false; reason: 'contract_read_failed'; detail: string} | null;
  outstandingEffect: RecoveryOutstandingEffect | null;
    wait: RecoveryWait | null;
    failure: RecoveryFailure | null;
  /** HOK-3382: the shared stall clock plus any open harness tool call. */
  reassessment?: RecoveryReassessment | null;
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
  /** Policy-classified route evidence, forwarded intact to the existing executor. */
  failure?: FailureDecision & {detail: string};
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

  // 4a. HOK-3382: reassessment is due (HOK-3277). The shared stall clock says
  //     the agent has written no progress for its stall window and the
  //     disposition still reports it in flight. A due deadline means
  //     "reassess", never terminate: the evidence decides whose time the
  //     stall is.
  //       - An open native harness tool call is proved by the transcript, so
  //         the harness — not the model — is holding the loop. Settle the
  //         stage and route it through its own retry bucket; the failure kind
  //         comes from failure-policy, never a literal here.
  //       - With no hold the model/provider is still working; the model-time
  //         budget and provider timeouts own that case, so there is nothing
  //         for the controller to do.
  //     Stale control, human hold, valid completion and outstanding effects
  //     all rank earlier and still win.
  const reassessment = snapshot.reassessment;
  if (reassessment?.due && snapshot.disposition?.kind === 'in-flight') {
    if (unverifiableIdentity) {
      return decision(stage, 'wait', 'reassessment due but the attempt identity is unverifiable; holding for reassessment', {
        wait: { owner: 'tool', wake: 'attempt-identity-resolved' },
      });
    }
    const since = reassessment.lastProgressAt ?? 'launch';
    const hold = reassessment.harnessHold;
    if (!hold) {
      return decision(stage, 'no-action',
        `reassessment due: no agent progress since ${since}; the model/provider holds the loop — the model-time budget owns it`);
    }
    const failureKind = classifyFailure({
      stage,
      detail: settledWithoutResultDetail(stage, 'harness-hung'),
    }).failureKind;
    const bucket = retryBucketFor(stage);
    return decision(stage, 'retry-stage',
      `reassessment due: no progress since ${since}; harness tool ${hold.toolName} (${hold.toolCallId}) has held the loop since ${hold.startedAt}; settle and route through ${bucket}`,
      { failureKind, retryBucket: bucket, nextAction: nextActionFor(failureKind) });
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

  // 4b. HOK-3512: the saved route cannot launch. This is the one refusal
  //     outcome for the failed-stage, window-lost and launch-surface paths:
  //     failure-policy classifies it and the escalation step pages, so a
  //     refusal is never a wait on a wake nothing produces.
  //     The shell adapter replays the saved route as `executionContract`; a
  //     positive validator refusal there is the same outcome. A read failure
  //     is not a refusal and keeps its bounded retry in decideFromFailure.
  const executionRefusal = snapshot.executionContract?.ok === false
    && snapshot.executionContract.reason !== 'contract_read_failed' ? snapshot.executionContract : null;
  const routeRefusal = snapshot.contract?.ok === false ? snapshot.contract : executionRefusal;
  if (routeRefusal) {
    if (unverifiableIdentity) {
      return decision(stage, 'wait', 'saved route refused but the attempt identity is unverifiable; holding for reassessment', {
        wait: { owner: 'tool', wake: 'attempt-identity-resolved' },
      });
    }
    return decideFromContractRefusal(snapshot, routeRefusal);
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
  const { retry } = failure;
  const contract = snapshot.executionContract;
  // Failed reads must not downgrade an already terminal observation (for
  // example, a task whose recorded spend budget is exhausted).
  const refusal = contract?.ok === false
    && !(contract.reason === 'contract_read_failed' && failure.decision.class === 'terminal') ? contract : null;
  const detail = refusal ? `Saved ${stage} route refused (${refusal.reason}): ${refusal.detail}` : '';
  const fd = refusal ? classifyFailure({stage,
    // A CLI/read failure is not a positive validator refusal. It retains the
    // existing bounded retry, never an invented wake or a model substitution.
    failureKind: refusal.reason === 'contract_read_failed' ? 'native-unclassified' : 'recovery_contract_unavailable',
    detail,
  }) : failure.decision;
  const base: Partial<RecoveryDecision> = { failureKind: fd.failureKind, nextAction: fd.nextAction,
    ...(refusal ? {failure: {...fd, detail}} : {}) };

  if (snapshot.baseDrift && !refusal) {
    return decision(stage, 'remediate', 'update from the observed base before reevaluating Ready', { ...base, nextAction: 'update-base' });
  }
  if (stage === 'ready' && fd.class === 'code-failure' && failure.source === 'transition') {
    return decision(stage, 'escalate', 'a transition-tool code failure requires operator repair', {
      ...base, escalationBasis: { kind: 'operator-decision', code: 'transition-code-failure' },
    });
  }
  if (fd.class === 'terminal') {
    return decision(stage, 'escalate', `allowlisted terminal cause ${fd.failureKind}: ${refusal ? detail : fd.cause?.reason ?? fd.rationale}`, {
      ...base,
      escalationBasis: { kind: 'policy-terminal', decisionClass: 'terminal' },
    });
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
  if (fd.class === 'code-failure') {
    return decision(stage, 'remediate', `recognised code failure (${fd.failureKind}); hand the excerpt to remediation`, base);
  }

  return decision(stage, 'retry-stage', `${fd.failureKind} is retryable; relaunch ${stage} under ${bucket}`, {
    ...base,
    retryBucket: bucket,
  });
}

/**
 * A refused saved route becomes failure evidence under one stable kind; the
 * class comes from `classifyFailure`, never a controller-local verdict. The
 * rationale names the stage, the route's model and the validator reason, so
 * the inbox item and Hokusai see the same fault.
 */
function decideFromContractRefusal(snapshot: RecoverySnapshot, refusal: RecoveryContractValidation): RecoveryDecision {
  const { stage } = snapshot;
  const reason = refusal.reason?.trim() || 'contract_unavailable';
  const detail = refusal.detail?.trim() || 'the persisted recovery contract is unavailable';
  const model = refusal.contract?.model?.trim() || 'unknown';
  const fd = classifyFailure({ stage, failureKind: RECOVERY_CONTRACT_UNAVAILABLE, detail: `${reason}: ${detail}` });
  const selected = decideFromFailure({ ...snapshot, baseDrift: false }, {
    decision: fd,
    retry: snapshot.failure?.retry ?? 'proceed',
  });
  return {
    ...selected,
    rationale: `saved ${stage} route (model ${model}) refused by launch validation: ${reason}: ${detail}`,
  };
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
  outcome?: 'applied' | 'reassess';
  condition?: { phase: string | null; startedAt: string | null; resultStage?: FailureStage };
  owner?: { pid: number; startTime: string; host: string };
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
  ownerPid?: number;
  condition?: RecoveryClaim['condition'];
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
    if (args.condition?.phase && args.condition.phase !== task.phase) return { claimed: false, reason: 'stale-run' };
    if (isSettled(task)) return { claimed: false, reason: 'settled-attempt' };
    // This synchronous call completes its claim-file mutation before finally
    // releases the authoritative workflow lock. Task replacement/settlement
    // writers use that same lock; no validation-to-claim gap exists.
    return claimCurrentRecoveryAction({ ...args, condition: args.condition ?? { phase: task.phase ?? null, startedAt: null } });
  } finally {
    releaseStateLock(lock);
  }
}

// Claims use the same proof of dead ownership as workflow locks. A PID on
// another host is unverifiable here; time alone never authorizes stealing it.
function recoveryOwnerReclaimable(claim: RecoveryClaim): boolean {
  const owner = claim.owner;
  return isOwnerReclaimable(owner ? {pid:owner.pid,processStartTime:owner.startTime,host:owner.host,
    acquiredAt:claim.claimedAt,purpose:'task-recovery'} : null);
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
      const abandoned = existing && recoveryOwnerReclaimable(existing);
      if (existing && (existing.acknowledgedAt || !abandoned) && existing.outcome !== 'reassess'
          && sameClaimIdentity(existing, dec.action, dec.stage, runId, evidenceId)) {
        // An identical claim already exists: another notifier won. Keep it.
        outcome = { claimed: false, reason: 'already-claimed', existing };
        return current;
      }
      // Only a newer attempt may supersede an existing claim.  Evidence is a
      // notification identity, not a new unit of control: accepting a
      // different evidence id for this same run would let two concurrent
      // notifiers dispatch two recovery-bearing actions.
      if (existing && !abandoned && !existing.acknowledgedAt && (existing.runId ?? null) === (runId ?? null)) {
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
        ...(args.condition ? { condition: args.condition } : {}),
        claimedAt: now.toISOString(),
        claimId,
        owner: { pid: args.ownerPid ?? process.pid, startTime: processStartTime(args.ownerPid ?? process.pid), host: processHost() },
      };
      outcome = { claimed: true, claim };
      return { ...current, claim };
    },
    { createIfMissing: true, initial: {} },
  );
  return outcome;
}

export function acknowledgeRecoveryAction(stateDir: string, claimId: string, now = new Date(), outcome: 'applied' | 'reassess' = 'applied'): boolean {
  let acknowledged = false;
  mutateJsonStateSync<{ claim?: RecoveryClaim }>(recoveryClaimPath(stateDir), current => {
    if (current.claim?.claimId !== claimId) return current;
    acknowledged = true;
    return { ...current, claim: { ...current.claim, acknowledgedAt: now.toISOString(), outcome } };
  }, { createIfMissing: true, initial: {} });
  return acknowledged;
}

/** Validate a continuation against authoritative stage state after any wait.
 * Binding is restricted to the running result this claim just prepared. */
export async function validateRecoveryAction(args: { stateDir: string; stateFile: string; issue: string; claimId: string; bindResult?: boolean; resultStage?: FailureStage }): Promise<boolean> {
  const lock = acquireStateLockSync(args.stateFile, { purpose: 'validate-recovery-continuation' });
  try {
    const task = readWorkflowState(args.stateFile)?.tasks?.[args.issue];
    const claim = readRecoveryClaim(args.stateDir);
    if (!task || !claim || claim.claimId !== args.claimId || claim.acknowledgedAt || isSettled(task)) return false;
    if ((task.runId || claim.runId) && !isSameRunId(task.runId, claim.runId)) return false;
    if (claim.condition?.phase && task.phase !== claim.condition.phase) return false;
    const result = await readStageResult(args.stateDir, args.resultStage ?? claim.condition?.resultStage ?? claim.stage);
    if (result?.status === 'completed' || result?.status === 'awaiting_user') return false;
    if (args.bindResult) {
      if (result?.status !== 'running') return false;
      mutateJsonStateSync<{claim?: RecoveryClaim}>(recoveryClaimPath(args.stateDir), state => {
        if (state.claim?.claimId === args.claimId) state.claim.condition = { phase: task.phase ?? null, startedAt: result.startedAt ?? null, resultStage: args.resultStage ?? claim.stage };
        return state;
      });
    } else if (claim.condition?.startedAt && result?.startedAt !== claim.condition.startedAt) return false;
    return true;
  } finally { releaseStateLock(lock); }
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
  evidence?: { snapshot: RecoverySnapshot; stageResult: StageResult | null; ownership: ReturnType<typeof readOwnershipRows> };
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

export async function reconcileAndRecover(args: Omit<ClaimRecoveryArgs, 'decision'> & { snapshot: RecoverySnapshot }): Promise<{ decision: RecoveryDecision; claim: ClaimResult }> {
  let snapshot = args.snapshot;
  let observedPhase: string | null = null;
  if (args.stateFile) {
    const current = readWorkflowState(args.stateFile)?.tasks?.[args.issue ?? snapshot.issue];
    observedPhase = current?.phase ?? null;
    snapshot = { ...snapshot, attempt: { ...snapshot.attempt, currentRunId: current?.runId ?? null } };
    if (snapshot.attempt.currentRunId && snapshot.attempt.controlRunId
        && !isSameRunId(snapshot.attempt.currentRunId, snapshot.attempt.controlRunId)) {
      const selected = decideTaskRecovery(snapshot);
      // Keep the original provider/model/cost fields intact; this is evidence,
      // never another charge or a control write to the replacement task.
      if (snapshot.evidence?.stageResult && args.runId) {
        archiveLateStageEvidence({ issueId: snapshot.issue, slug: basename(args.stateDir),
          repoDir: dirname(dirname(args.stateFile)), worktreeDir: dirname(dirname(args.stateDir)),
          runId: snapshot.evidence.stageResult.runId ?? args.runId, result: snapshot.evidence.stageResult });
      }
      recordRecoveryAction(args.stateDir, { at: new Date().toISOString(), issue: snapshot.issue,
        stage: snapshot.stage, action: selected.action, runId: args.runId, evidenceId: args.evidenceId,
        rationale: selected.rationale, evidence: { snapshot, stageResult: snapshot.evidence?.stageResult ?? null, ownership: readOwnershipRows(args.stateDir) } });
      return { decision: selected, claim: { claimed: false, reason: 'stale-run' } };
    }
    if (current?.phase && ['planning','coding','review','ready'].includes(current.phase) && current.phase !== snapshot.stage) {
      return { decision: decision(snapshot.stage, 'reject-stale-control', 'task advanced beyond the notified stage'), claim: { claimed: false, reason: 'stale-run' } };
    }
    const result = await readStageResult(args.stateDir, snapshot.stage);
    let claim = readRecoveryClaim(args.stateDir);
    // Only the current run's owner can block its reconciliation. The atomic
    // claim writer supersedes an earlier run without stealing that run's PID.
    if (claim && (claim.runId || snapshot.attempt.currentRunId)
        && !isSameRunId(claim.runId, snapshot.attempt.currentRunId)) claim = null;
    if (result?.status === 'completed' || result?.status === 'awaiting_user') {
      const identity = stageResultRunIdentity(result, snapshot.attempt.currentRunId);
      if (identity === 'stale' || identity === 'unverifiable') {
        if (identity === 'stale' && args.runId) {
          archiveLateStageEvidence({ issueId: snapshot.issue, slug: basename(args.stateDir),
            repoDir: dirname(dirname(args.stateFile)), worktreeDir: dirname(dirname(args.stateDir)),
            runId: result.runId ?? `before:${args.runId}`, result });
        }
        return { decision: decision(snapshot.stage, identity === 'stale' ? 'reject-stale-control' : 'wait',
          `stage result ${identity} for the current task run; retaining evidence without advancing`,
          identity === 'unverifiable' ? {wait:{owner:'tool',wake:'stage-identity-resolved'}} : {}),
          claim: { claimed: false, reason: 'stale-run' } };
      }
      snapshot = { ...snapshot, stageResult: { kind: 'valid', status: result.status }, failure: null,
        wait: result.status === 'awaiting_user' ? { owner: 'human', wake: 'operator-release' } : snapshot.wait };
    } else if (result?.status === 'running' && snapshot.disposition?.kind !== 'settled') {
      // A missing-window notification may prove the agent settled even though
      // its last result still says running. Keep that classified obligation.
      snapshot = { ...snapshot, stageResult: { kind: 'running' }, failure: null };
    }
    if (claim && !claim.acknowledgedAt && result?.status === 'completed') {
      acknowledgeRecoveryAction(args.stateDir, claim.claimId);
    }
    if (claim && !claim.acknowledgedAt && snapshot.disposition?.kind === 'in-flight'
        && snapshot.disposition.evidenceConfidence === 'high' && claim.owner
        && recoveryOwnerReclaimable(claim)) {
      // Fresh ownership/liveness proves the dispatched launch took effect.
      // A dead notifier is not a reason to repeat a live agent's work.
      acknowledgeRecoveryAction(args.stateDir, claim.claimId);
      claim = readRecoveryClaim(args.stateDir);
    }
    if (claim && !claim.acknowledgedAt && claim.stage === snapshot.stage && claim.owner
        && !recoveryOwnerReclaimable(claim) && result?.status !== 'completed' && result?.status !== 'awaiting_user') {
      return { decision: decision(snapshot.stage, 'verify-effect', 'the current recovery executor still owns dispatch'), claim: { claimed: false, reason: 'already-claimed', existing: claim } };
    }
    if (claim && !claim.acknowledgedAt && claim.owner && recoveryOwnerReclaimable(claim)) {
      if (result?.status === 'completed' || result?.status === 'awaiting_user') {
        snapshot = { ...snapshot, stageResult: { kind: 'valid', status: result.status }, failure: null };
      } else if ((result?.status === 'running' || !result) && snapshot.disposition?.kind !== 'settled') {
        snapshot = { ...snapshot, stageResult: { kind: 'running' }, failure: null,
          outstandingEffect: { kind: claim.action, acknowledged: false } };
      }
      // A still-failed result means the launch did not publish its running
      // result; replay uses the same bounded retry, never another model.
    }
  }
  const selected = decideTaskRecovery(snapshot);
  return { decision: selected, claim: claimRecoveryAction({ ...args, decision: selected, condition: args.stateFile ? {phase: observedPhase, startedAt: snapshot.evidence?.stageResult?.startedAt ?? null} : args.condition }) };
}

/**
 * The subset of `TaskProgress` the monitor forwards on `--progress`
 * (`tools/stage-agent-disposition.ts` adds it to the disposition JSON). The
 * controller never re-derives progress; it consumes this shared fact.
 */
export interface RecoveryProgressFlag {
  stalled?: boolean;
  lastProgressAt?: string | null;
  stallMinutes?: number;
}

/**
 * Turn the shared stall fact into a reassessment, resolving the stage
 * transcript only when the stall is due. The transcript path comes from the
 * existing `resolveNativeSessionPath`/`resolveNativeTranscriptPath` rules —
 * there is no second path rule here. Fail-soft: no transcript means no hold,
 * which is `no-action`, never a false harness fault.
 */
export function buildReassessment(args: {
  stage: FailureStage;
  issue: string;
  stateDir: string;
  progress: RecoveryProgressFlag | null | undefined;
  /** The stage's launch time (session-ownership `launchedAt`), when known. */
  launchedAt?: string | null;
  /** Fallback attempt anchor when no launch row exists. */
  fallbackStartedAt?: string | null;
  nowMs?: number;
  session?: string;
  repoDir?: string;
}): RecoveryReassessment | null {
  const progress = args.progress;
  if (!progress) return null;
  const lastProgressAt = progress.lastProgressAt ?? null;
  if (!progress.stalled) return { due: false, basis: 'no-progress', lastProgressAt, harnessHold: null };

  const nowMs = args.nowMs ?? Date.now();
  const anchorIso = args.launchedAt ?? args.fallbackStartedAt ?? null;
  const anchorMs = anchorIso ? Date.parse(anchorIso) : Number.NaN;
  const featureDir = args.stateDir;
  const repoDir = args.repoDir ?? dirname(dirname(args.stateDir));
  const session = args.session ?? process.env.WAVEMILL_SESSION ?? 'wavemill';
  const livePath = resolveNativeSessionPath({ issue: args.issue, phase: args.stage, repoDir, featureDir }, session);
  const events = livePath
    ? readNativeTranscriptEvents(resolveNativeTranscriptPath(livePath, { featureDir, repoDir }))
    : [];
  const hold: OpenHarnessToolCall | null = openHarnessToolCall(
    events,
    Number.isFinite(anchorMs) ? { fromMs: anchorMs, toMs: nowMs } : { fromMs: 0, toMs: nowMs },
  );
  return {
    due: true,
    basis: 'no-progress',
    lastProgressAt,
    harnessHold: hold
      ? { toolName: hold.toolName, toolCallId: hold.toolCallId, startedAt: new Date(hold.startedAtMs).toISOString() }
      : null,
  };
}

export async function runControllerCli(): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const stateDir = flag('--state-dir');
  const evidenceId = flag('--evidence-id');
  const snapshotPath = flag('--snapshot');
  if (!stateDir || (!flag('--ack') && !flag('--validate') && !flag('--disposition') && (!evidenceId || !snapshotPath))) {
    process.stderr.write('task-recovery-controller: usage: --state-dir DIR --evidence-id ID --snapshot FILE\n');
    process.exitCode = 2;
    return;
  }
  if (flag('--validate')) {
    const valid = await validateRecoveryAction({stateDir, stateFile: flag('--state-file') ?? '', issue: flag('--issue') ?? '', claimId: flag('--validate')!, bindResult: process.argv.includes('--bind-result'), resultStage: flag('--stage') as FailureStage | undefined});
    process.stdout.write(`${JSON.stringify({valid})}\n`);
    if (!valid) process.exitCode = 3;
    return;
  }
  const dispositionJson = flag('--disposition');
  if (dispositionJson) {
    const issue = flag('--issue') ?? '';
    const stage = flag('--stage') as FailureStage;
    const state = readWorkflowState(flag('--state-file') ?? '');
    const task = state?.tasks?.[issue];
    const result = await readStageResult(stateDir, stage);
    let dispositionPayload: (RecoveryDisposition & { launch?: { launchedAt?: string | null } }) | null = null;
    try {
      dispositionPayload = JSON.parse(dispositionJson) as RecoveryDisposition & { launch?: { launchedAt?: string | null } };
    } catch {
      dispositionPayload = null;
    }
    let progressFlag: RecoveryProgressFlag | null = null;
    const progressJson = flag('--progress');
    if (progressJson) {
      try {
        progressFlag = JSON.parse(progressJson) as RecoveryProgressFlag;
      } catch {
        progressFlag = null;
      }
    }
    const reassessment = buildReassessment({
      stage, issue, stateDir,
      progress: progressFlag,
      launchedAt: dispositionPayload?.launch?.launchedAt ?? null,
      fallbackStartedAt: result?.startedAt ?? null,
    });
    const snapshot: RecoverySnapshot = {
      issue, stage, attempt: { currentRunId: task?.runId ?? null, controlRunId: flag('--run-id') ?? task?.runId ?? null },
      evidence: { stageResult: result },
      disposition: dispositionPayload,
      stageResult: result?.status === 'completed' || result?.status === 'awaiting_user'
        ? { kind: 'valid', status: result.status } : { kind: 'running' },
      executionContract: null, outstandingEffect: null,
      wait: result?.status === 'awaiting_user' ? { owner: 'human', wake: 'operator-release' } : null, failure: null,
      reassessment,
    };
    // The hold is part of the evidence id, so one hang gives exactly one claim
    // (two notifiers observing the same open tool call collapse).
    const evidenceId = `${stage}:${task?.runId ?? 'legacy'}:${result?.startedAt ?? 'unknown-launch'}:${JSON.stringify(snapshot.disposition?.blockingPrompt ?? snapshot.stageResult)}${reassessment?.harnessHold ? `:hung:${reassessment.harnessHold.toolCallId}` : ''}`;
    const outcome = await reconcileAndRecover({ stateDir, snapshot, issue, stateFile: flag('--state-file'),
      runId: snapshot.attempt.controlRunId, ownerPid: Number(flag('--owner-pid')) || process.ppid,
      evidenceId });
    // Audit the dispatched action the same way the snapshot path does.
    if (outcome.claim.claimed || outcome.decision.action === 'verify-effect') {
      recordRecoveryAction(stateDir, {
        at: outcome.claim.claimed ? outcome.claim.claim.claimedAt : new Date().toISOString(),
        issue, stage, action: outcome.decision.action,
        runId: snapshot.attempt.currentRunId, evidenceId,
        rationale: outcome.decision.rationale,
      });
    }
    process.stdout.write(`${JSON.stringify({ ...outcome, reassessment })}\n`);
    return;
  }
  const ack = flag('--ack');
  if (ack) {
    process.stdout.write(`${JSON.stringify({ acknowledged: acknowledgeRecoveryAction(stateDir, ack, new Date(), flag('--outcome') === 'reassess' ? 'reassess' : 'applied') })}\n`);
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
  const { decision: selected, claim } = await reconcileAndRecover({ stateDir, snapshot,
    runId: snapshot.attempt.controlRunId, evidenceId,
    stateFile: flag('--state-file'), issue: snapshot.issue, ownerPid: Number(flag('--owner-pid')) || process.ppid });
  if (claim.claimed || selected.action === 'verify-effect') {
    recordRecoveryAction(stateDir, {
      at: claim.claimed ? claim.claim.claimedAt : new Date().toISOString(),
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
