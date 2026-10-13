/**
 * Ledger F — the one recovery loop (HOK-3185).
 *
 * Every unsettled step row past its `deadline` with no progress (HOK-3101)
 * gets the HOK-3176 failure policy, and nothing else:
 *
 * | Failure class  | Action                                                       |
 * | -------------- | ------------------------------------------------------------ |
 * | `terminal`     | settle the step `aborted` with the allowlisted cause         |
 * | `code-failure` | request a remediation step carrying the failure excerpt      |
 * | `retryable`    | bounded retry with backoff (HOK-2924), the last attempt is   |
 * |                | a fresh relaunch from the row's inputs, then escalate ONCE   |
 * |                | as a `waiting_on: operator-event` row with evidence          |
 *
 * The loop composes the existing invariants and adds no policy of its own:
 * liveness comes from the task-progress primitive, classification from
 * `classifyFailure`, and the attempt budget from the shared bounded-retry
 * bucket the policy names (`stage-failure-<stage>`).
 *
 * Escalations never latch: {@link reconcileRecoveryEscalations} (run by the
 * condition reconciler, HOK-3172) clears the `waiting_on` row on a later
 * operator event, a new head, or later agent progress.
 *
 * PR1 of the stack runs in **shadow** by default: decisions are appended to
 * `.wavemill/ledger-recovery.jsonl` and nothing is written to the ledger or
 * the retry buckets. The per-stage recovery branches it replaces are retired
 * one per follow-up PR, each flipping its stage to live.
 *
 * @module ledger-recovery
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoundedRetryDecision, StateDirRetry } from './bounded-retry.ts';
import {
  classifyFailure,
  DEFAULT_RETRY_ATTEMPTS,
  type FailureClass,
  type FailureEvidence,
  type FailureStage,
} from './failure-policy.ts';
import type { EvidenceRow, Ledger, TaskRow, WaitingOnRow } from './ledger.ts';
import { stepTtlMinutes } from './ledger-shadow.ts';
import { getTaskProgress } from './task-progress.ts';
import { isChallengerTaskId } from './task-identity.ts';

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

export interface ApplyContext {
  ledger: Ledger;
  env: RecoveryStepEnv;
  retry: RecoveryRetryBudget;
  now: Date;
}

/**
 * Live dispatcher: writes the ledger rows for one decision. Callers skip it
 * in shadow mode. Re-reads the row first so a step settled or escalated
 * between decide and apply is never acted on twice.
 */
export function applyRecovery(decision: RecoveryDecision, ctx: ApplyContext): boolean {
  if (decision.action === 'skip') return false;
  const current = ctx.ledger.getTask(decision.stepId);
  if (!current || current.settled_as !== null || (current.state !== 'running' && current.state !== 'waiting' && current.state !== 'pending')) {
    return false;
  }
  const detail = JSON.stringify({
    failureKind: decision.failureKind,
    failureClass: decision.failureClass,
    nextAction: decision.nextAction,
    attempt: decision.attempt,
    fresh: decision.fresh,
    terminalCode: decision.terminalCode,
    excerpt: decision.codeFailureExcerpt?.slice(-1000),
  });

  switch (decision.action) {
    case 'settle-aborted':
      ctx.ledger.transaction((tx) => {
        tx.recordEvidence(decision.stepId, 'controller', RECOVERY_EVIDENCE_EVENTS.settled, detail);
        tx.settleTask(decision.stepId, 'aborted', `recovery:${decision.terminalCode}`);
      });
      return true;
    case 'spawn-remediation':
      ctx.ledger.transaction((tx) => {
        tx.recordEvidence(decision.stepId, 'controller', RECOVERY_EVIDENCE_EVENTS.remediation, detail);
      });
      return true;
    case 'bounded-relaunch':
      ctx.retry.consume(decision.retryBucket!, ctx.env.stateDir, ctx.env.head, ctx.env.base);
      ctx.ledger.transaction((tx) => {
        if (current.max_attempts === null || current.attempt < current.max_attempts) tx.incrementAttempt(decision.stepId);
        tx.recordEvidence(decision.stepId, 'controller', RECOVERY_EVIDENCE_EVENTS.relaunch, detail);
        // `pending` hands the row back to its stage launcher, which relaunches from the row's inputs.
        tx.transitionState(decision.stepId, 'pending');
      });
      return true;
    case 'escalate-waiting-on':
      ctx.ledger.transaction((tx) => {
        tx.setWaitingOn(decision.stepId, 'operator-event', {
          expiresOn: ['operator-event', 'head', 'progress'],
          issueKey: decision.issueKey,
          head: ctx.env.head ?? null,
          operatorEventSeq: ctx.env.operatorEventSeq ?? 0,
          failureKind: decision.failureKind,
          nextAction: decision.nextAction,
          escalatedAt: ctx.now.toISOString(),
        });
        tx.transitionState(decision.stepId, 'waiting');
        tx.recordEvidence(decision.stepId, 'controller', RECOVERY_EVIDENCE_EVENTS.escalated, detail);
      });
      return true;
  }
}

/** Iterate open step rows under open issue roots. */
export function listOpenSteps(ledger: Ledger): { issueKey: string; step: TaskRow }[] {
  const out: { issueKey: string; step: TaskRow }[] = [];
  for (const root of ledger.listTasks({ kind: 'issue' })) {
    if (root.parent_id !== null || root.settled_as !== null) continue;
    for (const step of ledger.listChildren(root.id)) {
      if (step.kind === 'step' && step.settled_as === null) out.push({ issueKey: root.slug, step });
    }
  }
  return out;
}

export interface RecoverStalledOptions {
  now: Date;
  shadow: boolean;
  retry: RecoveryRetryBudget;
  /** Resolve the step's environment; `null` means the issue is not tracked (skipped). */
  resolveEnv(issueKey: string, step: TaskRow): RecoveryStepEnv | null;
  onApplyError?(decision: RecoveryDecision, error: unknown): void;
}

/** The monitor-tick entry point. Returns every decision, including skips. */
export function recoverStalledSteps(ledger: Ledger, options: RecoverStalledOptions): RecoveryDecision[] {
  const decisions: RecoveryDecision[] = [];
  for (const { issueKey, step } of listOpenSteps(ledger)) {
    const env = options.resolveEnv(issueKey, step);
    if (!env) {
      decisions.push(skip(step, issueKey, 'issue not tracked by the mill'));
      continue;
    }
    const decision = decideRecovery({
      step,
      issueKey,
      now: options.now,
      waitingOn: ledger.listWaitingOn(step.id),
      evidence: ledger.listEvidence(step.id),
      env,
      retry: options.retry,
    });
    decisions.push(decision);
    if (options.shadow || decision.action === 'skip') continue;
    try {
      applyRecovery(decision, { ledger, env, retry: options.retry, now: options.now });
    } catch (error) {
      options.onApplyError?.(decision, error);
    }
  }
  return decisions;
}

export interface ClearedEscalation {
  stepId: string;
  issueKey: string;
  reason: string;
}

/**
 * The `waiting_on: operator-event` half of the HOK-3172 reconciler: an
 * escalation expires on a later operator event, a new head, or agent
 * progress after it was recorded. The step goes back to `pending` so the
 * loop (or its stage launcher) picks it up again with a fresh window.
 */
export function reconcileRecoveryEscalations(
  ledger: Ledger,
  options: { resolveEnv: RecoverStalledOptions['resolveEnv'] },
): ClearedEscalation[] {
  const cleared: ClearedEscalation[] = [];
  for (const { issueKey, step } of listOpenSteps(ledger)) {
    const row = ledger.listWaitingOn(step.id).find((candidate) => candidate.trigger === 'operator-event');
    if (!row) continue;
    const env = options.resolveEnv(issueKey, step);
    if (!env) continue;
    const reason = escalationExpiry(row, env);
    if (!reason) continue;
    ledger.transaction((tx) => {
      tx.clearWaitingOn(step.id, 'operator-event');
      tx.transitionState(step.id, 'pending');
      tx.recordEvidence(step.id, 'controller', RECOVERY_EVIDENCE_EVENTS.cleared, reason);
    });
    cleared.push({ stepId: step.id, issueKey, reason });
  }
  return cleared;
}

/** Why an escalation's condition no longer holds, or null while it still does. */
export function escalationExpiry(row: WaitingOnRow, env: RecoveryStepEnv): string | null {
  let condition: { head?: string | null; operatorEventSeq?: number } = {};
  try { condition = JSON.parse(row.condition) ?? {}; } catch { /* malformed → only progress can clear */ }
  const recordedSeq = Number(condition.operatorEventSeq ?? 0);
  if (env.operatorEventSeq !== undefined && env.operatorEventSeq > recordedSeq) {
    return `operator-event: seq ${env.operatorEventSeq} > ${recordedSeq}`;
  }
  if (condition.head && env.head && env.head !== condition.head) {
    return `head: ${condition.head.slice(0, 12)} -> ${env.head.slice(0, 12)}`;
  }
  const progress = env.progress();
  const progressAt = ms(progress?.lastProgressAt);
  const recordedAt = ms(row.recorded_at);
  if (progress && !progress.agentIdle && progressAt !== null && recordedAt !== null && progressAt > recordedAt) {
    return `progress: agent progress at ${progress.lastProgressAt}`;
  }
  return null;
}

// ── Environment helpers used by the CLI ─────────────────────────────────────

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

const FAILED_RESULT_STATUSES = new Set(['failed', 'failure', 'error', 'errored', 'infra-failure']);

/**
 * Build the `FailureEvidence` for a stalled step: the newest failure evidence
 * row, then the stage's on-disk result artifact (`.<stage>-result.json`,
 * `.coding-failure-handoff.json`). A step that simply went silent yields an
 * empty detail, which the policy classifies as retryable.
 */
export function readStepFailureEvidence(step: TaskRow, evidence: EvidenceRow[], stateDir: string): FailureEvidence {
  const stage = step.slug as FailureStage;
  const row = [...evidence].reverse().find((candidate) => FAILURE_EVIDENCE_EVENTS.has(candidate.event));
  const result = readJson(join(stateDir, `.${step.slug}-result.json`));
  const resultFailed = result !== null && FAILED_RESULT_STATUSES.has(String(result.status ?? '').toLowerCase());
  const handoff = stage === 'coding' ? readJson(join(stateDir, '.coding-failure-handoff.json')) : null;

  const failureKind = resultFailed ? str(result.failureKind) ?? str(result.failureCategory) : undefined;
  const details = [
    row?.detail ?? undefined,
    resultFailed ? str(result.failureReason) ?? str(result.note) ?? str(result.error) ?? str(result.reason) : undefined,
    str(handoff?.detail) ?? str(handoff?.error),
  ].filter((value): value is string => Boolean(value));
  return {
    stage,
    failureKind: failureKind ?? null,
    detail: details.join('\n'),
    handoffReason: str(handoff?.reason) ?? null,
  };
}

interface MillTaskEntry {
  slug?: string;
  branch?: string;
  worktree?: string;
  phase?: string;
  status?: string;
  updated?: string;
}

export interface MillEnvOptions {
  /** `workflow-state.json`; tasks absent from it are not tracked and are skipped. */
  stateFile: string;
  /** `$WORKTREE_ROOT`; used when the task entry has no `worktree`. */
  worktreeRoot?: string;
  session?: string;
}

function gitHead(worktree: string): string | undefined {
  try {
    return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function operatorEventSeq(stateDir: string): number {
  const path = join(stateDir, '.operator-events.jsonl');
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Resolve a step's environment from the mill's workflow state: the task's
 * state dir (same rule as `ready_state_dir`), its worktree head, operator
 * event seq, and lazily the HOK-3101 progress for the step's phase.
 */
export function createMillEnvResolver(options: MillEnvOptions): RecoverStalledOptions['resolveEnv'] {
  const state = readJson(options.stateFile);
  const tasks = (state?.tasks ?? {}) as Record<string, MillTaskEntry>;
  const cache = new Map<string, { worktree: string; stateDir: string; head?: string; seq: number; task: MillTaskEntry }>();
  return (issueKey, step) => {
    const task = tasks[issueKey];
    if (!task || typeof task !== 'object') return null;
    let base = cache.get(issueKey);
    if (!base) {
      const slug = task.slug ?? task.branch?.replace(/^(task|bug|epic)\//, '');
      if (!slug) return null;
      const worktree = task.worktree ?? (options.worktreeRoot ? join(options.worktreeRoot, slug) : '');
      if (!worktree) return null;
      const stateDir = ['features', 'bugs'].map((dir) => join(worktree, dir, slug)).find((dir) => existsSync(dir)) ?? join(worktree, 'features', slug);
      base = { worktree, stateDir, head: gitHead(worktree), seq: operatorEventSeq(stateDir), task };
      cache.set(issueKey, base);
    }
    const { worktree, stateDir, head, seq } = base;
    let progress: RecoveryProgress | null | undefined;
    return {
      stateDir,
      head,
      operatorEventSeq: seq,
      challengeArm: isChallengerTaskId(issueKey),
      progress() {
        if (progress !== undefined) return progress;
        try {
          const derived = getTaskProgress({ issue: issueKey, session: options.session, task: base!.task, worktree, featureDir: stateDir, phase: step.slug });
          progress = { agentIdle: derived.agentIdle, stalled: derived.stalled, lastProgressAt: derived.lastProgressAt };
        } catch {
          progress = null;
        }
        return progress;
      },
      failure: (row, evidence) => readStepFailureEvidence(row, evidence, stateDir),
    };
  };
}

/**
 * Retry budget over the shared bounded-retry buckets. Shadow peeks without
 * mutating (the shell gate resets on a new key, so it is not used there);
 * live gates and increments through the helper.
 */
export function createRecoveryRetryBudget(
  factory: (bucket: string) => StateDirRetry,
  options: { shadow: boolean; maxAttempts?: number },
): RecoveryRetryBudget {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const buckets = new Map<string, StateDirRetry>();
  const bucketFor = (name: string) => {
    let retry = buckets.get(name);
    if (!retry) { retry = factory(name); buckets.set(name, retry); }
    return retry;
  };
  return {
    peek(bucket, stateDir, head, base) {
      const retry = bucketFor(bucket);
      if (!options.shadow) {
        const decision = retry.gate(stateDir, head ?? '', base);
        return { decision, attempts: retry.count(stateDir), maxAttempts };
      }
      const key = retry.readKey(stateDir);
      const sameKey = !head || !key.head || (key.head === head && (!base || !key.base || key.base === base));
      if (!sameKey) return { decision: 'proceed', attempts: 0, maxAttempts };
      if (retry.isExhausted(stateDir)) return { decision: 'exhausted-quiet', attempts: retry.count(stateDir), maxAttempts };
      const attempts = retry.count(stateDir);
      return { decision: attempts >= maxAttempts ? 'exhausted' : 'proceed', attempts, maxAttempts };
    },
    consume(bucket, stateDir, head, base) {
      if (options.shadow) return;
      bucketFor(bucket).increment(stateDir, head ?? '', base);
    },
  };
}

/** One audit line per non-skip decision. Append-only (no lock, per CLAUDE.md). */
export function appendRecoveryLog(
  repoDir: string,
  decisions: RecoveryDecision[],
  meta: { mode: 'shadow' | 'live'; at: string },
): number {
  const lines = decisions
    .filter((decision) => decision.action !== 'skip')
    .map((decision) => {
      const { codeFailureExcerpt: _excerpt, ...rest } = decision;
      return JSON.stringify({ at: meta.at, mode: meta.mode, ...rest });
    });
  if (lines.length === 0) return 0;
  const dir = join(repoDir, '.wavemill');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'ledger-recovery.jsonl'), `${lines.join('\n')}\n`);
  return lines.length;
}
