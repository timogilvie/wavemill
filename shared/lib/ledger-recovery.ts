/**
 * Ledger F — the recovery policy (HOK-3185).
 *
 * {@link decideRecovery} applies the HOK-3176 failure policy to one unsettled
 * step row past its `deadline` with no HOK-3101 progress:
 *
 * | Failure class  | Action                                                       |
 * | -------------- | ------------------------------------------------------------ |
 * | `terminal`     | settle the step `aborted` with the allowlisted cause         |
 * | `code-failure` | request a remediation step carrying the failure excerpt      |
 * | `retryable`    | bounded retry with backoff (HOK-2924), the last attempt is   |
 * |                | a fresh relaunch from the row's inputs, then escalate ONCE   |
 * |                | as a `waiting_on: operator-event` row with evidence          |
 *
 * The function composes the existing invariants and adds no policy of its
 * own: liveness comes from the task-progress primitive, classification from
 * `classifyFailure`, and the attempt budget from the shared bounded-retry
 * bucket the policy names (`stage-failure-<stage>`).
 *
 * The live monitor loop and its helpers were retired in HOK-3235 because
 * step rows never settled in shadow mode (1,306 shadow decisions against
 * cleanly merged tasks). A follow-up issue holds the rebuild once step rows
 * settle. The HOK-3177 replay harness still runs every fixture through
 * `decideRecovery`.
 *
 * @module ledger-recovery
 */

import type { BoundedRetryDecision } from './bounded-retry.ts';
import {
  classifyFailure,
  type FailureClass,
  type FailureEvidence,
  type FailureStage,
} from './failure-policy.ts';
import type { EvidenceRow, TaskRow, WaitingOnRow } from './ledger.ts';
import { stepTtlMinutes } from './ledger-shadow.ts';

export type RecoveryActionKind =
  | 'skip'
  | 'settle-aborted'
  | 'spawn-remediation'
  | 'bounded-relaunch'
  | 'escalate-waiting-on';

/** The slice of the HOK-3101 `TaskProgress` the loop consumes. */
export interface RecoveryProgress {
  agentIdle: boolean;
  stalled: boolean;
  lastProgressAt: string | null;
}

export interface RecoveryRetryVerdict {
  decision: BoundedRetryDecision;
  /** Attempts already spent in the bucket for the current key. */
  attempts: number;
  maxAttempts: number;
}

/**
 * The bounded-retry budget, keyed per state dir. `peek` must not mutate in
 * shadow mode; `consume` is only called by the live dispatcher.
 */
export interface RecoveryRetryBudget {
  peek(bucket: string, stateDir: string, head?: string, base?: string): RecoveryRetryVerdict;
  consume(bucket: string, stateDir: string, head?: string, base?: string): void;
}

/** Per-step environment, resolved lazily so a step before its deadline costs nothing. */
export interface RecoveryStepEnv {
  stateDir: string;
  head?: string;
  base?: string;
  /** Current `.operator-events.jsonl` seq for the state dir (HOK-3172). */
  operatorEventSeq?: number;
  challengeArm?: boolean;
  progress(): RecoveryProgress | null;
  failure(step: TaskRow, evidence: EvidenceRow[]): FailureEvidence;
}

export interface RecoveryInputs {
  step: TaskRow;
  issueKey: string;
  now: Date;
  waitingOn: WaitingOnRow[];
  evidence: EvidenceRow[];
  env: RecoveryStepEnv;
  retry: RecoveryRetryBudget;
}

export interface RecoveryDecision {
  stepId: string;
  issueKey: string;
  stepKind: string;
  action: RecoveryActionKind;
  rationale: string;
  failureClass?: FailureClass;
  failureKind?: string;
  nextAction?: string;
  retryBucket?: string;
  /** For `bounded-relaunch`: the attempt this relaunch spends (1-based). */
  attempt?: number;
  /** For `bounded-relaunch`: the last attempt in the budget is a fresh relaunch from the row's inputs. */
  fresh?: boolean;
  terminalCode?: string;
  codeFailureExcerpt?: string;
}

/** Evidence events (any source) that carry a stage failure for classification. */
export const FAILURE_EVIDENCE_EVENTS: ReadonlySet<string> = new Set([
  'stage-failed',
  'agent-exit',
  'hook-error',
  'StopFailure',
]);

/** Controller evidence events this loop writes; the newest restarts the step's deadline window. */
export const RECOVERY_EVIDENCE_EVENTS = {
  settled: 'recovery-settled',
  remediation: 'recovery-remediation-requested',
  relaunch: 'recovery-relaunch-requested',
  escalated: 'recovery-escalated',
  cleared: 'recovery-escalation-cleared',
} as const;

const FAILURE_STAGES: ReadonlySet<string> = new Set<FailureStage>(['planning', 'coding', 'review', 'ready', 'tend', 'eval']);

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The step's deadline, pushed out by one TTL window after the loop's own
 * last action on it — a relaunch or a cleared escalation gets a full window
 * to show progress before it is inspected again.
 */
export function effectiveDeadlineMs(step: TaskRow, evidence: EvidenceRow[]): number | null {
  const deadline = ms(step.deadline);
  if (deadline === null) return null;
  const recoveryEvents = new Set<string>(Object.values(RECOVERY_EVIDENCE_EVENTS));
  let lastRecovery: number | null = null;
  for (const row of evidence) {
    if (row.source !== 'controller' || !recoveryEvents.has(row.event)) continue;
    const at = ms(row.recorded_at);
    if (at !== null && (lastRecovery === null || at > lastRecovery)) lastRecovery = at;
  }
  if (lastRecovery === null) return deadline;
  return Math.max(deadline, lastRecovery + stepTtlMinutes(step.slug) * 60_000);
}

function skip(step: TaskRow, issueKey: string, rationale: string): RecoveryDecision {
  return { stepId: step.id, issueKey, stepKind: step.slug, action: 'skip', rationale };
}

/** Decide what the loop does with one step. Pure apart from the injected env/retry reads. */
export function decideRecovery(inputs: RecoveryInputs): RecoveryDecision {
  const { step, issueKey, now, env } = inputs;
  if (step.settled_as !== null) return skip(step, issueKey, 'step already settled');
  if (step.background === 1 || step.state === 'background') return skip(step, issueKey, 'background step');
  if (!FAILURE_STAGES.has(step.slug)) return skip(step, issueKey, `no failure stage for step kind ${step.slug}`);

  const deadline = effectiveDeadlineMs(step, inputs.evidence);
  if (deadline === null) return skip(step, issueKey, 'step has no deadline');
  if (now.getTime() < deadline) return skip(step, issueKey, `deadline not reached (${new Date(deadline).toISOString()})`);

  if (inputs.waitingOn.some((row) => row.trigger === 'operator-event')) {
    return skip(step, issueKey, 'already escalated; waiting on an operator event');
  }

  // HOK-3101: only agent progress after the step launched keeps it alive.
  // Monitor/controller writes are excluded by the primitive itself.
  const progress = env.progress();
  const progressAt = ms(progress?.lastProgressAt);
  const createdAt = ms(step.created_at) ?? 0;
  if (progress && !progress.agentIdle && !progress.stalled && progressAt !== null && progressAt >= createdAt) {
    return skip(step, issueKey, `agent progressing (last progress ${progress.lastProgressAt})`);
  }

  const failure = classifyFailure({ ...env.failure(step, inputs.evidence), challengeArm: env.challengeArm === true });
  const base: RecoveryDecision = {
    stepId: step.id,
    issueKey,
    stepKind: step.slug,
    action: 'skip',
    rationale: failure.rationale,
    failureClass: failure.class,
    failureKind: failure.failureKind,
    nextAction: failure.nextAction,
  };

  if (failure.class === 'terminal') {
    return { ...base, action: 'settle-aborted', terminalCode: failure.cause?.code ?? failure.failureKind };
  }
  if (failure.class === 'code-failure') {
    return { ...base, action: 'spawn-remediation', codeFailureExcerpt: failure.codeFailureExcerpt };
  }

  const bucket = failure.retryBucket!;
  const verdict = inputs.retry.peek(bucket, env.stateDir, env.head, env.base);
  switch (verdict.decision) {
    case 'proceed': {
      const attempt = verdict.attempts + 1;
      const fresh = attempt >= verdict.maxAttempts;
      return {
        ...base,
        action: 'bounded-relaunch',
        retryBucket: bucket,
        attempt,
        fresh,
        rationale: `${failure.rationale}; ${fresh ? 'fresh relaunch from row inputs' : 'bounded retry'} ${attempt}/${verdict.maxAttempts}`,
      };
    }
    case 'backoff':
      return { ...base, retryBucket: bucket, rationale: `${failure.rationale}; ${bucket} backing off` };
    default:
      return {
        ...base,
        action: 'escalate-waiting-on',
        retryBucket: bucket,
        rationale: `${failure.rationale}; ${bucket} exhausted after ${verdict.attempts}/${verdict.maxAttempts} attempts`,
      };
  }
}
