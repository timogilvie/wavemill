import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoundedRetryDecision } from './bounded-retry.ts';
import { Ledger, type EvidenceRow, type TaskRow } from './ledger.ts';
import { defaultStepDeadline, stepTtlMinutes, upsertStep } from './ledger-shadow.ts';
import {
  decideRecovery,
  effectiveDeadlineMs,
  RECOVERY_EVIDENCE_EVENTS,
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

test("the loop's own last action restarts the deadline window", () => {
  const step = row({ deadline: PAST });
  const relaunchedAt = '2026-10-11T11:55:00.000Z';
  const evidence: EvidenceRow[] = [{ id: 'e1', step_id: step.id, source: 'controller', event: RECOVERY_EVIDENCE_EVENTS.relaunch, detail: null, recorded_at: relaunchedAt }];
  assert.equal(effectiveDeadlineMs(step, evidence), Date.parse(relaunchedAt) + stepTtlMinutes('review') * 60_000);
  assert.match(decide(step, env(), budget(), { evidence }).rationale, /deadline not reached/);
  // Agent-sourced evidence does not move the deadline.
  const agentOnly: EvidenceRow[] = [{ ...evidence[0], source: 'agent-hook' }];
  assert.equal(effectiveDeadlineMs(step, agentOnly), Date.parse(PAST));
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
