/**
 * task-recovery-controller — the one task-recovery control path (HOK-3277).
 *
 * "This attempt is stuck / its stage exited / its result is waiting — what
 * happens next?" has one answer. Before this module the answer was composed
 * independently at every site: the monitor's per-stage `failed` branches each
 * wired `classifyFailure` → `bounded-retry` → quarantine/escalate by hand, the
 * incident-replay harness carried its own inline copy of that ladder, and the
 * Ready path had a third. Each copy could rank the same evidence differently.
 *
 * {@link decideTaskRecovery} is the single, pure, named-and-versioned decision.
 * It composes the existing authorities rather than re-deriving anything:
 *
 *   - attempt identity / settlement (`attempt-identity.ts`, `task-settlement.ts`)
 *     decide current-vs-stale control and late evidence;
 *   - `stage-agent-disposition.ts` decides in-flight / settled / advanced;
 *   - `failure-policy.ts` (`classifyFailure`) is the failure authority;
 *   - `bounded-retry.ts` owns the budget and backoff (the caller gates and
 *     passes the verdict in; the controller never counts attempts itself);
 *   - `execution-contract.ts` is replayed for a coding retry — the controller
 *     requires a persisted contract and never picks a different model;
 *   - `operator-escalation.ts` is the one escalation step.
 *
 * The controller owns only: snapshot ordering, deterministic action selection,
 * and the atomic claim ({@link claimRecoveryAction}) that makes concurrent
 * Monitor / Tend / Observer notifications collapse to exactly one dispatch. It
 * adds no new retry counter, fault class, terminal cause, deadline outcome, or
 * model-routing choice.
 *
 * Ownership boundary: `docs/invariants/task-recovery-ownership.md`, guarded by
 * `tools/check-task-recovery-ownership.ts`.
 *
 * @module task-recovery-controller
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { isSameRunId } from './attempt-identity.ts';
import type { EscalationBasis } from './operator-escalation.ts';
import type { BoundedRetryDecision } from './bounded-retry.ts';
import type { FailureDecision, FailureStage } from './failure-policy.ts';
import type { StageAgentDisposition } from './stage-agent-disposition.ts';
import { mutateJsonStateSync } from './state-mutex.ts';

/** The deterministic policy identity recorded on every decision and claim. */
export const RECOVERY_POLICY = Object.freeze({ name: 'task-recovery-controller', version: 1 } as const);

/** `task-recovery-controller@1` — the audited policy id. */
export const RECOVERY_POLICY_ID = `${RECOVERY_POLICY.name}@${RECOVERY_POLICY.version}` as const;

// ── Snapshot contract ────────────────────────────────────────────────────────

/**
 * Who owns a legitimate wait and the event that ends it. A deadline is NOT a
 * termination, ownership theft, or model-fault attribution (HOK-3277 rule 5):
 * it only schedules reassessment. `human` holds survive restart/retry.
 */
export interface RecoveryWait {
  owner: 'dependency' | 'ci' | 'tool' | 'backoff' | 'human';
  /** The event this wait wakes on (e.g. `ci-complete`, `operator-release`). */
  wake: string;
  detail?: string;
}

/**
 * Run identity of the attempt this decision is about. `currentRunId` is the
 * row's run id (`null` for legacy rows from before HOK-3373); `controlRunId`
 * is the run the triggering evidence/control was produced for (`null` when the
 * trigger carries no identity). The missing/unknown distinction is preserved:
 * both `null` is a legacy row (grandfathered), a known mismatch is stale
 * control, and a known current row with an unidentified trigger fails safe.
 */
export interface RecoveryAttempt {
  currentRunId: string | null;
  controlRunId: string | null;
}

/**
 * The stage-result state. `missing` and `invalid` are kept distinct from a
 * clean `failed` verdict so missing/contradictory evidence is never read as
 * success (HOK-3277 rule 3 / acceptance).
 */
export type RecoveryStageResult =
  | { kind: 'missing' }
  | { kind: 'running' }
  | { kind: 'valid'; status: 'completed' | 'awaiting_user' }
  | { kind: 'failed' }
  | { kind: 'invalid'; detail: string };

/**
 * An external effect whose acknowledgement is uncertain after a restart
 * (HOK-3274 intent → apply → acknowledge). `acknowledged: false` means the
 * controller must verify observed state before doing anything else, so the
 * effect is reconciled, never duplicated.
 */
export interface RecoveryOutstandingEffect {
  kind: string;
  acknowledged: boolean;
  detail?: string;
}

/**
 * A caller-supplied failure classification plus the bounded-retry verdict for
 * its bucket. The controller does not classify or count: `decision` comes from
 * `classifyFailure` and `retry` from `bounded_retry_gate`.
 */
export interface RecoveryFailure {
  decision: FailureDecision;
  retry: BoundedRetryDecision;
}

/** Disposition fields the controller reads; the rest of the shape is irrelevant here. */
export type RecoveryDisposition = Pick<
  StageAgentDisposition,
  'kind' | 'reason' | 'evidenceConfidence' | 'waitingOn' | 'blockingPrompt'
>;

export interface RecoverySnapshot {
  issue: string;
  stage: FailureStage;
  attempt: RecoveryAttempt;
  /** Live in-flight/settled evidence; `null` when no probe ran (unknown). */
  disposition: RecoveryDisposition | null;
  stageResult: RecoveryStageResult;
  /**
   * For a coding retry: whether the persisted execution contract is available
   * for replay. `null` when the stage is not a model-replay stage (planning /
   * review use their phase handoff, not a contract). `false` holds the retry —
   * the controller never substitutes a different model (HOK-3277 rule 8).
   */
  contractAvailable: boolean | null;
  outstandingEffect: RecoveryOutstandingEffect | null;
  /** A legitimate wait owner + wake condition, when one is known. */
  wait: RecoveryWait | null;
  /** Present once a failure has been classified and its retry bucket gated. */
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
  /**
   * `true` when the action carries control over the current attempt (advance /
   * retry / escalate / consume). A `claimRecoveryAction` is only meaningful for
   * a control-bearing action.
   */
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

/**
 * The one recovery decision. Pure and total: it never throws and never
 * fabricates success. Order (conservative first):
 *
 *  1. **Stale control** — the trigger names a run that differs from the row's
 *     current run: reject control, retain the late evidence/cost (never
 *     advance or abort the newer attempt).
 *  2. **Unverifiable identity** — the row has a current run but the trigger
 *     carries no identity: a control-bearing step would act on evidence that
 *     cannot be tied to the current attempt, so it holds (fail safe). Legacy
 *     rows (no current run id) are grandfathered and proceed.
 *  3. **Explicit human hold** — preserved across restart/retry; a deadline
 *     only reassesses.
 *  4. **In-flight / background / advanced / task-terminal** — healthy work and
 *     legitimate waits are left alone.
 *  5. **Legitimate wait condition** — dependency / CI / tool / backoff.
 *  6. **Valid current completion** — consumed through the normal transition;
 *     a completed stage is never rerun because its result was not consumed.
 *  7. **Uncertain external effect** — verify observed state before acting.
 *  8. **Classified failure** — delegated: terminal → escalate, code-failure →
 *     remediate, retryable → retry (proceed) / wait (backoff) / escalate
 *     (exhausted).
 *  9. **Missing / invalid / unclassified** — hold and reassess; never success.
 */
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

/** The on-disk recovery claim. One per task state dir; see {@link claimRecoveryAction}. */
export interface RecoveryClaim {
  policy: typeof RECOVERY_POLICY_ID;
  action: RecoveryActionKind;
  stage: FailureStage;
  /** The run the claim controls; `null` for a legacy row with no run id. */
  runId: string | null;
  /** Evidence identity so a replayed notification claims idempotently. */
  evidenceId: string;
  claimedAt: string;
  /** A unique id for this claim instance (the winner's token). */
  claimId: string;
}

export interface ClaimRecoveryArgs {
  stateDir: string;
  decision: RecoveryDecision;
  runId: string | null;
  evidenceId: string;
  now?: () => Date;
  /** Override the claim file path (tests); defaults to `<stateDir>/.recovery-claim.json`. */
  claimPath?: string;
}

export type ClaimResult =
  | { claimed: true; claim: RecoveryClaim }
  | { claimed: false; reason: 'already-claimed' | 'not-control-bearing'; existing?: RecoveryClaim };

/** Basename of the claim file written next to a task's state. */
export const RECOVERY_CLAIM_BASENAME = '.recovery-claim.json';
/** Basename of the recovery action audit log (one JSON line per claimed dispatch). */
export const RECOVERY_ACTIONS_BASENAME = '.recovery-actions.jsonl';

export function recoveryClaimPath(stateDir: string): string {
  return join(stateDir, RECOVERY_CLAIM_BASENAME);
}

function sameClaimIdentity(a: RecoveryClaim, action: RecoveryActionKind, stage: FailureStage, runId: string | null, evidenceId: string): boolean {
  return a.action === action && a.stage === stage && a.evidenceId === evidenceId && (a.runId ?? null) === (runId ?? null);
}

/**
 * Atomically claim a control-bearing recovery action for the current attempt.
 *
 * Concurrent Monitor / Tend / Observer notifications that compute the same
 * decision collapse to exactly one claim: the `mutateJsonStateSync` lock
 * serialises them, the first writes the claim, and every later caller observing
 * an identical claim (same policy/action/stage/run/evidence) declines with
 * `already-claimed`. A claim for a stale run is superseded by one for the
 * current run (a newer attempt replaces it). A non-control-bearing action
 * (`no-action` / `wait` / `verify-effect` / `reject-stale-control`) is never
 * claimed.
 */
export function claimRecoveryAction(args: ClaimRecoveryArgs): ClaimResult {
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
      // Either no claim, a claim for a stale run, or a different action/evidence
      // for the current run — this caller writes the claim for the current run.
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

/** Read the current recovery claim, or `null` when none / unreadable. */
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
  /** Set when a `verify-effect` found the effect already applied (duplicate prevented). */
  duplicateEffectPrevented?: boolean;
}

/**
 * Append one recovery action to the audit log for reporting (time stuck,
 * duplicate effects prevented, attribution coverage). Best-effort; never
 * throws. Cost stays SDK-owned — this records the action, not a price.
 */
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
