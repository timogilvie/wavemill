/**
 * HOK-3386 — unit tests for the one stage-agent in-flight/settled decision.
 *
 * Every row below pins one behaviour the 2026-11-02 incident's replay
 * fixtures also exercise end-to-end; this file covers the pure decision and
 * the shallow IO reader.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
  decideStageAgentDisposition,
  readStageAgentLaunch,
  type StageAgentDispositionInput,
  type StageAgentProgress,
} from './stage-agent-disposition.ts';
import { appendOwnershipRow } from './session-ownership.ts';
import type { HookState } from './task-progress.ts';

const LAUNCH_ISO = '2026-11-02T09:00:00.000Z';
const CURRENT = 'c0ffee0000000000000000000000000000000001';
const OTHER = 'c0ffee0000000000000000000000000000000002';

function stateDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'stage-agent-disposition-'));
}

function baseInput(overrides: Partial<StageAgentDispositionInput> = {}): StageAgentDispositionInput {
  return {
    stage: 'review',
    stageStatus: 'running',
    hasCompletionArtifact: false,
    hasResultVerdict: false,
    launch: {
      sessionRef: 'sess-1',
      harness: 'codex',
      launchedAt: LAUNCH_ISO,
      attemptId: 'review@abcdef#1762',
      kind: 'review',
      stage: 'review',
    },
    currentHead: CURRENT,
    launchHead: CURRENT,
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: false,
      agentProcessLive: null,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
    ...overrides,
  };
}

function hookRecord(state: HookState, agoSec: number, now = Date.parse('2026-11-02T10:00:00.000Z')): StageAgentProgress['agentRecord'] {
  return {
    state,
    event: 'PreToolUse',
    agent: 'claude',
    timestamp: Math.floor((now - agoSec * 1000) / 1000),
  };
}

// ── core decision cases ────────────────────────────────────────────────────

// protects: a non-running stage reading as in-flight (the decision only acts on `running`).
test('decision: stageStatus != running → inactive', () => {
  const d = decideStageAgentDisposition(baseInput({ stageStatus: 'completed' }));
  assert.equal(d.kind, 'inactive');
  assert.equal(d.reason, 'not-running');
});

// protects: planning awaiting_user being re-decided by the stage disposition instead of the approval gate.
test('decision: stageStatus == awaiting_user → inactive awaiting-approval', () => {
  const d = decideStageAgentDisposition(baseInput({ stage: 'planning', stageStatus: 'awaiting_user' }));
  assert.equal(d.kind, 'inactive');
  assert.equal(d.reason, 'awaiting-approval');
  assert.deepEqual(d.waitingOn, { kind: 'approval', detail: 'awaiting_user' });
});

// protects: a running stage with no launch row being decided as in-flight (the monitor should route it inactive).
test('decision: no launch row → inactive no-launch', () => {
  const d = decideStageAgentDisposition(baseInput({ launch: null }));
  assert.equal(d.kind, 'inactive');
  assert.equal(d.reason, 'no-launch');
});

// protects: advanced head decision bleeding into liveness (the monitor relies on advanced to clear a stale remediation).
test('decision: launch head behind current head → advanced', () => {
  const d = decideStageAgentDisposition(baseInput({ launchHead: OTHER, currentHead: CURRENT }));
  assert.equal(d.kind, 'advanced');
  assert.equal(d.reason, 'head-moved');
});

// protects: a failed probe being read as settled (must hold).
test('decision: null progress → in-flight progress-unavailable', () => {
  const d = decideStageAgentDisposition(baseInput({ progress: null }));
  assert.equal(d.kind, 'in-flight');
  assert.equal(d.reason, 'progress-unavailable');
  assert.equal(d.evidenceConfidence, 'unknown');
});

// protects: a recognised blocking prompt being held forever (the 2026-11-02 incident's trust prompt).
test('decision: blockingPrompt → settled blocking-prompt:<id>', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: false,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: { id: 'codex_daemon_version_mismatch', agent: 'codex', detail: 'cancel the menu' },
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'settled');
  assert.equal(d.reason, 'blocking-prompt:codex_daemon_version_mismatch');
  assert.ok(d.blockingPrompt);
});

// protects: HOK-3137 — an idle agent with a live background task being replaced instead of waited on.
test('decision: agentBackgroundLive → in-flight background-work', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: true,
      agentProcessLive: true,
      agentBackgroundLive: true,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'in-flight');
  assert.equal(d.reason, 'background-work');
  assert.deepEqual(d.waitingOn, { kind: 'background' });
});

// protects: a fresh agent `working` hook being misread as idle.
test('decision: agent working at launch+30s → in-flight agent-working', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: hookRecord('working', 30, now),
      agentState: 'working',
      agentIdle: false,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'in-flight');
  assert.equal(d.reason, 'agent-working');
  assert.equal(d.evidenceConfidence, 'high');
});

// protects: an agent idle record being ignored so a review stage with no verdict holds forever.
test('decision: agent idle after launch → settled agent-idle-after-launch', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: Math.floor((now - 60 * 1000) / 1000) },
      agentState: null,
      agentIdle: true,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'settled');
  assert.equal(d.reason, 'agent-idle-after-launch');
  assert.equal(d.evidenceConfidence, 'high');
});

// protects: a Codex rollout task_complete being ignored because Codex has no hook adapter.
test('decision: owned-session idle after launch → settled agent-idle-after-launch', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: true,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: '2026-11-02T09:42:00.000Z',
    },
  }));
  assert.equal(d.kind, 'settled');
  assert.equal(d.reason, 'agent-idle-after-launch');
  assert.equal(d.evidenceConfidence, 'high');
});

// protects: a stale pre-launch owned-session idle counting as this launch's idle.
test('decision: owned-session idle BEFORE launch is ignored', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: false,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: '2026-11-02T08:00:00.000Z',
    },
  }));
  assert.equal(d.kind, 'in-flight');
  assert.equal(d.reason, 'awaiting-agent-evidence');
});

// protects: a 30m silent stage never reaching settled (the 2026-11-02 incident's symptom).
test('decision: stalled → settled agent-stalled', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: false,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: true,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'settled');
  assert.equal(d.reason, 'agent-stalled');
  assert.equal(d.evidenceConfidence, 'high');
});

// protects: a dead agent process being held in-flight by the default fallthrough.
test('decision: process exited → settled agent-exited', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: false,
      agentProcessLive: false,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'settled');
  assert.equal(d.reason, 'agent-exited');
});

// ── HOK-3277 inputs shape ──────────────────────────────────────────────────

// protects: finished-but-unconsumed (status=completed) being decided as settled.
test('HOK-3277: stageStatus=completed is inactive and hasResultVerdict exposed', () => {
  const d = decideStageAgentDisposition(baseInput({
    stage: 'review',
    stageStatus: 'completed',
    hasCompletionArtifact: true,
    hasResultVerdict: true,
  }));
  assert.equal(d.kind, 'inactive');
  assert.equal(d.hasResultVerdict, true);
  assert.equal(d.hasCompletionArtifact, true);
});

// protects: stopped-without-result being read as settled with hasResultVerdict false.
test('HOK-3277: stopped-without-result exposes hasResultVerdict=false', () => {
  const d = decideStageAgentDisposition(baseInput({
    stage: 'review',
    hasCompletionArtifact: false,
    hasResultVerdict: false,
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: true,
      agentProcessLive: false,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: '2026-11-02T09:42:00.000Z',
    },
  }));
  assert.equal(d.kind, 'settled');
  assert.equal(d.hasResultVerdict, false);
  assert.equal(d.hasCompletionArtifact, false);
});

// protects: insufficient evidence replacing a running stage (must hold).
test('HOK-3277: insufficient evidence → in-flight evidenceConfidence unknown', () => {
  const d = decideStageAgentDisposition(baseInput({ progress: null }));
  assert.equal(d.kind, 'in-flight');
  assert.equal(d.evidenceConfidence, 'unknown');
});

// protects: agent long legitimate background work being replaced for elapsed age.
test('HOK-3277: long legitimate background work → in-flight waitingOn.background', () => {
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: null,
      agentState: null,
      agentIdle: true,
      agentProcessLive: true,
      agentBackgroundLive: true,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'in-flight');
  assert.deepEqual(d.waitingOn, { kind: 'background' });
});

// protects: a legitimate approval-needed wait escalating as a terminal.
test('HOK-3277: approval-needed → in-flight waitingOn.approval', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const d = decideStageAgentDisposition(baseInput({
    progress: {
      agentRecord: { state: 'approval-needed', event: 'Notification', agent: 'claude', timestamp: Math.floor((now - 30 * 1000) / 1000) },
      agentState: 'approval-needed',
      agentIdle: false,
      agentProcessLive: true,
      agentBackgroundLive: null,
      blockingPrompt: null,
      stalled: false,
      ownedSessionIdleAt: null,
    },
  }));
  assert.equal(d.kind, 'in-flight');
  assert.deepEqual(d.waitingOn, { kind: 'approval', detail: 'approval-needed' });
});

// ── launch reader against real state ──────────────────────────────────────

// protects: a stage disposition driven by a conflicting kind's launch time.
test('readStageAgentLaunch: picks newest launch row for the stage (review only)', () => {
  const dir = stateDir();
  try {
    appendOwnershipRow(dir, { sessionRef: 'old', harness: 'claude-code', kind: 'review', model: 'm', launchedAt: '2026-11-02T08:00:00.000Z' });
    appendOwnershipRow(dir, { sessionRef: 'new', harness: 'codex', kind: 'review', model: 'm', launchedAt: '2026-11-02T09:00:00.000Z' });
    appendOwnershipRow(dir, { sessionRef: 'coding', harness: 'claude-code', kind: 'coding', model: 'm', launchedAt: '2026-11-02T09:30:00.000Z' });
    const launch = readStageAgentLaunch(dir, 'review');
    assert.ok(launch);
    assert.equal(launch!.sessionRef, 'new');
    assert.equal(launch!.harness, 'codex');
    assert.equal(launch!.kind, 'review');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a stage with no matching row leaking in-flight through the launch reader.
test('readStageAgentLaunch: returns null when no row matches', () => {
  const dir = stateDir();
  try {
    assert.equal(readStageAgentLaunch(dir, 'review'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
