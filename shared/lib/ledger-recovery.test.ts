import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoundedRetryDecision, StateDirRetry } from './bounded-retry.ts';
import { Ledger, type EvidenceRow, type TaskRow } from './ledger.ts';
import { defaultStepDeadline, stepTtlMinutes, upsertStep } from './ledger-shadow.ts';
import {
  appendRecoveryLog,
  applyRecovery,
  createRecoveryRetryBudget,
  decideRecovery,
  effectiveDeadlineMs,
  readStepFailureEvidence,
  reconcileRecoveryEscalations,
  RECOVERY_EVIDENCE_EVENTS,
  recoverStalledSteps,
  type RecoveryProgress,
  type RecoveryRetryBudget,
  type RecoveryRetryVerdict,
  type RecoveryStepEnv,
} from './ledger-recovery.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const PAST = '2026-10-11T11:00:00.000Z';
const FUTURE = '2026-10-11T13:00:00.000Z';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-ledger-recovery-'));
  ledger = Ledger.open({ dbPath: join(dir, 'ledger.sqlite') });
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'step-1', parent_id: 'root', kind: 'step', slug: 'review', inputs_hash: 'h', state: 'running',
    owner: null, next_action: null, deadline: PAST, background: 0, replay: 'unsafe', attempt: 0,
    max_attempts: null, created_at: '2026-10-11T10:00:00.000Z', settled_at: null, settled_as: null, settled_reason: null,
    ...overrides,
  };
}

function env(overrides: { progress?: RecoveryProgress | null; detail?: string; failureKind?: string } & Partial<Omit<RecoveryStepEnv, 'progress'>> = {}): RecoveryStepEnv {
  const { progress = { agentIdle: true, stalled: true, lastProgressAt: null }, detail = '', failureKind, ...rest } = overrides;
  return {
    stateDir: join(dir, 'state'),
    head: 'aaaaaaa1',
    operatorEventSeq: 0,
    progress: () => progress,
    failure: (step) => ({ stage: step.slug as 'review', detail, failureKind: failureKind ?? null }),
    ...rest,
  };
}

function budget(verdict: Partial<RecoveryRetryVerdict> = {}): RecoveryRetryBudget & { consumed: string[] } {
  const consumed: string[] = [];
  return {
    consumed,
    peek: () => ({ decision: 'proceed', attempts: 0, maxAttempts: 3, ...verdict }),
    consume: (bucket) => { consumed.push(bucket); },
  };
}

function decide(step: TaskRow, stepEnv = env(), retry = budget(), extra: { evidence?: EvidenceRow[]; waitingOn?: { trigger: string }[] } = {}) {
  return decideRecovery({
    step, issueKey: 'HOK-1', now: NOW, env: stepEnv, retry,
    evidence: extra.evidence ?? [],
    waitingOn: (extra.waitingOn ?? []).map((w) => ({ step_id: step.id, trigger: w.trigger as 'operator-event', condition: '{}', recheck_after: null, recorded_at: PAST })),
  });
}

function seedStep(deadline = PAST): TaskRow {
  const { id } = upsertStep(ledger, { issueKey: 'HOK-1', kind: 'review', inputsHash: 'inputs-v1', deadline });
  return ledger.getTask(id)!;
}

// ── decideRecovery ──────────────────────────────────────────────────────────

test('skips settled, background, deadline-less and not-yet-due steps', () => {
  assert.equal(decide(row({ settled_as: 'done', state: 'done' })).action, 'skip');
  assert.equal(decide(row({ background: 1 })).action, 'skip');
  assert.match(decide(row({ deadline: null })).rationale, /no deadline/);
  assert.match(decide(row({ deadline: FUTURE })).rationale, /deadline not reached/);
});

test('skips a step whose agent is still progressing after launch (HOK-3101)', () => {
  const live = env({ progress: { agentIdle: false, stalled: false, lastProgressAt: '2026-10-11T11:55:00.000Z' } });
  assert.match(decide(row(), live).rationale, /agent progressing/);
  // Progress from before the step launched is not this step's progress.
  const stale = env({ progress: { agentIdle: false, stalled: false, lastProgressAt: '2026-10-11T09:00:00.000Z' } });
  assert.notEqual(decide(row(), stale).action, 'skip');
});

test('skips a step already escalated to an operator', () => {
  assert.match(decide(row(), env(), budget(), { waitingOn: [{ trigger: 'operator-event' }] }).rationale, /already escalated/);
});

test('terminal allowlisted cause settles the step aborted', () => {
  const decision = decide(row(), env({ failureKind: 'policy-denied' }));
  assert.equal(decision.action, 'settle-aborted');
  assert.equal(decision.failureClass, 'terminal');
  assert.equal(decision.terminalCode, 'policy-denied');
});

test('code failure requests remediation with the excerpt', () => {
  const decision = decide(row({ slug: 'ready' }), env({ detail: 'not ok 3 - parses config\n# 2 passed, 1 failed' }));
  assert.equal(decision.action, 'spawn-remediation');
  assert.equal(decision.failureClass, 'code-failure');
  assert.match(decision.codeFailureExcerpt ?? '', /not ok 3/);
});

test('retryable failure relaunches within budget, the last attempt is fresh', () => {
  const first = decide(row(), env({ detail: 'socket hang up' }));
  assert.equal(first.action, 'bounded-relaunch');
  assert.equal(first.retryBucket, 'stage-failure-review');
  assert.equal(first.attempt, 1);
  assert.equal(first.fresh, false);
  const last = decide(row(), env(), budget({ attempts: 2 }));
  assert.equal(last.action, 'bounded-relaunch');
  assert.equal(last.attempt, 3);
  assert.equal(last.fresh, true);
});

test('an unrecognised silent stall is retryable, never terminal (HOK-3176)', () => {
  const decision = decide(row(), env({ detail: '' }));
  assert.equal(decision.failureClass, 'retryable');
  assert.equal(decision.failureKind, 'native-unclassified');
});

test('backoff waits; an exhausted budget escalates', () => {
  assert.match(decide(row(), env(), budget({ decision: 'backoff', attempts: 1 })).rationale, /backing off/);
  for (const decisionKind of ['exhausted', 'exhausted-quiet'] as BoundedRetryDecision[]) {
    const decision = decide(row(), env(), budget({ decision: decisionKind, attempts: 3 }));
    assert.equal(decision.action, 'escalate-waiting-on');
    assert.ok(decision.nextAction);
  }
});

test('the loop\'s own last action restarts the deadline window', () => {
  const step = row({ deadline: PAST });
  const relaunchedAt = '2026-10-11T11:55:00.000Z';
  const evidence: EvidenceRow[] = [{ id: 'e1', step_id: step.id, source: 'controller', event: RECOVERY_EVIDENCE_EVENTS.relaunch, detail: null, recorded_at: relaunchedAt }];
  assert.equal(effectiveDeadlineMs(step, evidence), Date.parse(relaunchedAt) + stepTtlMinutes('review') * 60_000);
  assert.match(decide(step, env(), budget(), { evidence }).rationale, /deadline not reached/);
  // Agent-sourced evidence does not move the deadline.
  const agentOnly: EvidenceRow[] = [{ ...evidence[0], source: 'agent-hook' }];
  assert.equal(effectiveDeadlineMs(step, agentOnly), Date.parse(PAST));
});

// ── applyRecovery / recoverStalledSteps (live + shadow) ─────────────────────

test('live relaunch consumes the bucket, bumps attempt and hands the row back as pending', () => {
  const step = seedStep();
  const retry = budget();
  const decision = decide(step, env({ detail: 'ECONNRESET' }), retry);
  assert.equal(applyRecovery(decision, { ledger, env: env(), retry, now: NOW }), true);
  const after = ledger.getTask(step.id)!;
  assert.deepEqual(retry.consumed, ['stage-failure-review']);
  assert.equal(after.attempt, 1);
  assert.equal(after.state, 'pending');
  assert.ok(ledger.listEvidence(step.id).some((e) => e.event === RECOVERY_EVIDENCE_EVENTS.relaunch && e.source === 'controller'));
});

test('live terminal settles the row aborted with the cause', () => {
  const step = seedStep();
  applyRecovery(decide(step, env({ failureKind: 'cancelled' })), { ledger, env: env(), retry: budget(), now: NOW });
  const after = ledger.getTask(step.id)!;
  assert.equal(after.settled_as, 'aborted');
  assert.equal(after.settled_reason, 'recovery:cancelled');
});

test('live remediation records the request without settling', () => {
  const step = seedStep();
  applyRecovery(decide(step, env({ detail: 'ERR_TEST_FAILURE' })), { ledger, env: env(), retry: budget(), now: NOW });
  assert.equal(ledger.getTask(step.id)!.settled_as, null);
  assert.ok(ledger.listEvidence(step.id).some((e) => e.event === RECOVERY_EVIDENCE_EVENTS.remediation));
});

test('live escalation writes one waiting_on operator row; the next pass is a no-op', () => {
  const step = seedStep();
  const exhausted = budget({ decision: 'exhausted', attempts: 3 });
  const stepEnv = env({ operatorEventSeq: 2 });
  const opts = { now: NOW, shadow: false, retry: exhausted, resolveEnv: () => stepEnv };
  const [first] = recoverStalledSteps(ledger, opts);
  assert.equal(first.action, 'escalate-waiting-on');
  const waiting = ledger.listWaitingOn(step.id);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].trigger, 'operator-event');
  const condition = JSON.parse(waiting[0].condition);
  assert.equal(condition.operatorEventSeq, 2);
  assert.equal(condition.head, 'aaaaaaa1');
  assert.equal(ledger.getTask(step.id)!.state, 'waiting');
  const [second] = recoverStalledSteps(ledger, opts);
  assert.equal(second.action, 'skip');
  assert.equal(ledger.listEvidence(step.id).filter((e) => e.event === RECOVERY_EVIDENCE_EVENTS.escalated).length, 1);
});

test('shadow mode decides but writes nothing', () => {
  const step = seedStep();
  const retry = budget();
  const [decision] = recoverStalledSteps(ledger, { now: NOW, shadow: true, retry, resolveEnv: () => env({ detail: 'ECONNRESET' }) });
  assert.equal(decision.action, 'bounded-relaunch');
  assert.deepEqual(retry.consumed, []);
  const after = ledger.getTask(step.id)!;
  assert.equal(after.state, 'running');
  assert.equal(after.attempt, 0);
  assert.equal(ledger.listEvidence(step.id).length, 0);
});

test('untracked issues are skipped', () => {
  seedStep();
  const [decision] = recoverStalledSteps(ledger, { now: NOW, shadow: false, retry: budget(), resolveEnv: () => null });
  assert.match(decision.rationale, /not tracked/);
});

test('apply re-reads the row and never acts on a settled step', () => {
  const step = seedStep();
  const decision = decide(step, env({ detail: 'ECONNRESET' }));
  ledger.transaction((tx) => tx.settleTask(step.id, 'done'));
  const retry = budget();
  assert.equal(applyRecovery(decision, { ledger, env: env(), retry, now: NOW }), false);
  assert.deepEqual(retry.consumed, []);
});

// ── reconcileRecoveryEscalations ────────────────────────────────────────────

function escalate(step: TaskRow, stepEnv: RecoveryStepEnv) {
  recoverStalledSteps(ledger, { now: NOW, shadow: false, retry: budget({ decision: 'exhausted', attempts: 3 }), resolveEnv: () => stepEnv });
  assert.equal(ledger.listWaitingOn(step.id).length, 1);
}

test('escalation holds while nothing changed', () => {
  const step = seedStep();
  const stepEnv = env({ operatorEventSeq: 1 });
  escalate(step, stepEnv);
  assert.deepEqual(reconcileRecoveryEscalations(ledger, { resolveEnv: () => stepEnv }), []);
  assert.equal(ledger.listWaitingOn(step.id).length, 1);
});

test('a later operator event clears the escalation and re-opens the step', () => {
  const step = seedStep();
  escalate(step, env({ operatorEventSeq: 1 }));
  const cleared = reconcileRecoveryEscalations(ledger, { resolveEnv: () => env({ operatorEventSeq: 2 }) });
  assert.equal(cleared.length, 1);
  assert.match(cleared[0].reason, /operator-event/);
  assert.equal(ledger.listWaitingOn(step.id).length, 0);
  assert.equal(ledger.getTask(step.id)!.state, 'pending');
  assert.ok(ledger.listEvidence(step.id).some((e) => e.event === RECOVERY_EVIDENCE_EVENTS.cleared));
});

test('a new head or later agent progress clears the escalation', () => {
  const step = seedStep();
  escalate(step, env());
  assert.match(reconcileRecoveryEscalations(ledger, { resolveEnv: () => env({ head: 'bbbbbbb2' }) })[0].reason, /head/);

  const other = upsertStep(ledger, { issueKey: 'HOK-2', kind: 'ready', inputsHash: 'x', deadline: PAST });
  recoverStalledSteps(ledger, { now: NOW, shadow: false, retry: budget({ decision: 'exhausted', attempts: 3 }), resolveEnv: (issue) => (issue === 'HOK-2' ? env() : null) });
  const later = new Date(Date.now() + 60_000).toISOString();
  const progressing = env({ progress: { agentIdle: false, stalled: false, lastProgressAt: later } });
  const cleared = reconcileRecoveryEscalations(ledger, { resolveEnv: (issue) => (issue === 'HOK-2' ? progressing : null) });
  assert.equal(cleared[0].stepId, other.id);
  assert.match(cleared[0].reason, /progress/);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('readStepFailureEvidence reads the newest failure evidence and a failed stage result', () => {
  const stateDir = join(dir, 'features', 'slug');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, '.review-result.json'), JSON.stringify({ status: 'failed', failureCategory: 'native-review-timeout', failureReason: 'stage timed out' }));
  const step = row();
  const evidence: EvidenceRow[] = [
    { id: 'a', step_id: step.id, source: 'agent-hook', event: 'PreToolUse', detail: 'Read', recorded_at: PAST },
    { id: 'b', step_id: step.id, source: 'agent-hook', event: 'StopFailure', detail: '503 service unavailable', recorded_at: PAST },
  ];
  const failure = readStepFailureEvidence(step, evidence, stateDir);
  assert.equal(failure.stage, 'review');
  assert.equal(failure.failureKind, 'native-review-timeout');
  assert.match(failure.detail ?? '', /503 service unavailable/);
  assert.match(failure.detail ?? '', /stage timed out/);
  // A passing result contributes nothing.
  writeFileSync(join(stateDir, '.review-result.json'), JSON.stringify({ status: 'pass', failureCategory: 'x' }));
  assert.equal(readStepFailureEvidence(step, [], stateDir).failureKind, null);
});

function fakeRetry(state: { head: string; count: number; exhausted: boolean }, calls: string[]): StateDirRetry {
  return {
    bucket: 'stage-failure-review',
    gate: () => { calls.push('gate'); return 'proceed'; },
    increment: () => { calls.push('increment'); },
    markExhausted: () => { calls.push('markExhausted'); },
    clear: () => { calls.push('clear'); },
    isExhausted: () => state.exhausted,
    count: () => state.count,
    readKey: () => ({ head: state.head, base: '' }),
    exhaustionReason: () => '',
  };
}

test('shadow retry budget peeks without mutating the bucket', () => {
  const calls: string[] = [];
  const state = { head: 'aaaaaaa1', count: 1, exhausted: false };
  const shadow = createRecoveryRetryBudget(() => fakeRetry(state, calls), { shadow: true });
  assert.deepEqual(shadow.peek('stage-failure-review', '/s', 'aaaaaaa1'), { decision: 'proceed', attempts: 1, maxAttempts: 3 });
  state.count = 3;
  assert.equal(shadow.peek('stage-failure-review', '/s', 'aaaaaaa1').decision, 'exhausted');
  assert.deepEqual(shadow.peek('stage-failure-review', '/s', 'ccccccc3'), { decision: 'proceed', attempts: 0, maxAttempts: 3 }, 'new head resets');
  state.exhausted = true;
  assert.equal(shadow.peek('stage-failure-review', '/s', 'aaaaaaa1').decision, 'exhausted-quiet');
  shadow.consume('stage-failure-review', '/s', 'aaaaaaa1');
  assert.deepEqual(calls, []);

  const live = createRecoveryRetryBudget(() => fakeRetry(state, calls), { shadow: false });
  live.peek('stage-failure-review', '/s', 'aaaaaaa1');
  live.consume('stage-failure-review', '/s', 'aaaaaaa1');
  assert.deepEqual(calls, ['gate', 'increment']);
});

test('appendRecoveryLog writes one line per non-skip decision, without excerpts', () => {
  const decisions = [
    { stepId: 's1', issueKey: 'HOK-1', stepKind: 'review', action: 'skip' as const, rationale: 'x' },
    { stepId: 's2', issueKey: 'HOK-1', stepKind: 'ready', action: 'spawn-remediation' as const, rationale: 'y', codeFailureExcerpt: 'long log' },
  ];
  assert.equal(appendRecoveryLog(dir, decisions, { mode: 'shadow', at: NOW.toISOString() }), 1);
  const lines = readFileSync(join(dir, '.wavemill', 'ledger-recovery.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.stepId, 's2');
  assert.equal(parsed.mode, 'shadow');
  assert.equal(parsed.codeFailureExcerpt, undefined);
  assert.equal(appendRecoveryLog(dir, [decisions[0]], { mode: 'shadow', at: NOW.toISOString() }), 0);
});

test('step TTLs default per kind and honour env overrides; upsertStep stamps a default deadline', () => {
  assert.equal(stepTtlMinutes('review', {}), 15);
  assert.equal(stepTtlMinutes('eval', {}), 60);
  assert.equal(stepTtlMinutes('review', { WAVEMILL_LEDGER_STEP_TTL_REVIEW_MINUTES: '5' }), 5);
  assert.equal(stepTtlMinutes('ready', { WAVEMILL_LEDGER_STEP_TTL_MINUTES: '7', WAVEMILL_LEDGER_STEP_TTL_READY_MINUTES: 'junk' }), 7);
  assert.equal(defaultStepDeadline('review', NOW, {}), '2026-10-11T12:15:00.000Z');
  const { id } = upsertStep(ledger, { issueKey: 'HOK-9', kind: 'eval', inputsHash: 'z' });
  assert.ok(ledger.getTask(id)!.deadline);
});
