/**
 * HOK-3101 — unit tests for the shared task-progress primitive.
 *
 * The pure `deriveTaskProgress` cases pin the a-d families of bugs:
 *   (a) an idle agent REPL / pane presence is not progress;
 *   (b) wavemill controller processes never count as agent evidence;
 *   (c) a stale task.updated does not shadow fresh hook/commit evidence;
 *   (d) a monitor pr_merged hook write does not erase the agent's Stop.
 *
 * Gather-side tests use a temp dir + fixture hook file to exercise the IO
 * paths (history-file fallback, worktree-mtime filtering).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  CONTROLLER_HOOK_EVENTS,
  HOOK_TTL_SECONDS,
  deriveTaskProgress,
  gatherTaskProgressInputs,
  getTaskProgress,
  isControllerHookRecord,
  isWavemillControllerProcess,
  matchInteractivePromptSignature,
  progressCacheIsFresh,
  readHookFile,
  readOwnedSessionTail,
  readOwnedStageLaunch,
  readOwnedStageTranscript,
  selectAgentRecord,
  INTERACTIVE_PROMPT_SIGNATURES,
  normalizeInteractivePromptText,
  parsePsSnapshot,
  deriveAgentBackgroundWork,
  type HookFile,
  type TaskProgressInputs,
  type PaneProcess,
} from './task-progress.ts';
import { appendOwnershipRow } from './session-ownership.ts';
import { setTerminalExecForTest } from './terminal-backend.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function ts(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function emptyInputs(overrides: Partial<TaskProgressInputs> = {}): TaskProgressInputs {
  return {
    issue: 'TEST-1',
    hookFile: null,
    terminalHistoryIdleAt: null,
    latestCommitAt: null,
    launchAt: null,
    worktreeMtimeAt: null,
    statusFileMtimeAt: null,
    ownedSession: null,
    transitionInputs: [],
    terminal: { prState: null, prNumber: null, lifecycleOutcome: null, at: null },
    agentProcessLive: null,
    agentExited: null,
    backgroundWork: null,
    blockingPrompt: null,
    ...overrides,
  };
}

function makeHookFile(overrides: Partial<HookFile> & { topTimestamp?: number }): HookFile {
  return {
    top: null,
    writer: 'agent',
    agentRecord: null,
    topTimestamp: overrides.topTimestamp ?? 0,
    ...overrides,
  };
}

// ── (a) pane presence / idle REPL ────────────────────────────────────────────

test('(a) an agent-written idle Stop with a live pane counts as agentIdle, not progress', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const stopTs = ts('2026-09-28T15:59:30Z');
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      top: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      writer: 'agent',
      topTimestamp: stopTs,
    }),
    agentProcessLive: true, // pane is live
  });
  const p = deriveTaskProgress(inputs, { now });
  // agent idle, no progress source (idle is settled state, not progress).
  assert.equal(p.agentIdle, true);
  assert.equal(p.sources.length, 0);
  assert.equal(p.lastProgressAt, null);
});

test('(a) an idle agent with no other evidence, past threshold, is stalled', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const stopTs = ts('2026-09-28T15:15:00Z'); // 45m ago
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      writer: 'agent',
      topTimestamp: stopTs,
    }),
    // HOK-3422: stall clock anchors off launchAt when no agent progress has
    // landed. The idle Stop is an agent record but never a progress source.
    launchAt: '2026-09-28T15:15:00Z',
    transitionInputs: [{ at: '2026-09-28T15:15:00Z', detail: 'coding.startedAt' }],
    agentProcessLive: true,
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, true);
  assert.equal(p.agentIdle, true);
  // status/waiting attention state absent, so `stalled` fires.
});

// ── (b) controller-process regex ─────────────────────────────────────────────

test('(b) isWavemillControllerProcess matches monitor children and tool argv', () => {
  const controllerCmds = [
    'node /path/to/tools/pr-ci-status.ts 123 --repo-dir /tmp/wt',
    'bash /tmp/wavemill-monitor.sh',
    'node --import tsx tools/observer.ts --loop',
    'tmux attach -t wavemill-main',
    'npx tsx shared/lib/wavemill-common.sh',
    'ready-watchdog --tick',
  ];
  for (const cmd of controllerCmds) {
    assert.equal(isWavemillControllerProcess(cmd), true, `expected controller: ${cmd}`);
  }
  const agentCmds = [
    'claude --model claude-sonnet-5',
    'codex exec --json',
    'node dist/agent.js',
    'python my_script.py',
  ];
  for (const cmd of agentCmds) {
    assert.equal(isWavemillControllerProcess(cmd), false, `expected agent: ${cmd}`);
  }
});

// ── (c) transition-only evidence: task.updated is not dominant ──────────────

test('(c) a fresh agent hook + fresh commit override a stale task.updated (HOK-3087)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const launchTs = ts('2026-09-28T14:00:00Z');
  const hookTs = ts('2026-09-28T15:58:00Z'); // 2m ago
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      agentRecord: { state: 'working', event: 'PreToolUse', agent: 'claude', timestamp: hookTs },
      writer: 'agent',
      topTimestamp: hookTs,
    }),
    latestCommitAt: '2026-09-28T15:55:00Z', // 5m ago
    launchAt: '2026-09-28T14:00:00Z',
    transitionInputs: [
      { at: '2026-09-28T13:00:00Z', detail: 'task.updated' }, // 3h stale
    ],
  });
  void launchTs;
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, false);
  const kinds = p.sources.map((s) => s.kind);
  assert.ok(kinds.includes('hook'));
  assert.ok(kinds.includes('commit'));
  assert.ok(p.progressAgeMinutes !== null && p.progressAgeMinutes < 30);
  // HOK-3422: the stale controller-authored transition is surfaced via
  // lastTransitionAt only, never through sources[] or progressAgeMinutes.
  assert.ok(!kinds.includes('transition' as never));
  assert.equal(p.lastTransitionAt, '2026-09-28T13:00:00.000Z');
});

// HOK-3422: controller-authored transitions never become progress sources.
test('HOK-3422: transition input never appears in sources[] and never feeds lastProgressAt', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    transitionInputs: [{ at: '2026-09-28T15:50:00Z', detail: 'task.updated' }],
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.sources.length, 0);
  assert.equal(p.lastProgressAt, null);
  assert.equal(p.progressAgeMinutes, null);
  // But lastTransitionAt is derived from transitionInputs.
  assert.equal(p.lastTransitionAt, '2026-09-28T15:50:00.000Z');
});

// HOK-3422: lastTransitionAt picks the newest transition.
test('HOK-3422: lastTransitionAt derives from transitionInputs, newest first', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    transitionInputs: [
      { at: '2026-09-28T13:00:00Z', detail: 'coding.startedAt' },
      { at: '2026-09-28T15:50:00Z', detail: 'ready-result.mtime' },
      { at: '2026-09-28T14:30:00Z', detail: 'coding.finishedAt' },
    ],
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.lastTransitionAt, '2026-09-28T15:50:00.000Z');
});

// HOK-3422: launchAt is the stall-clock anchor when no agent evidence exists.
test('HOK-3422: no agent evidence after launchAt + stallMinutes → stalled=true, lastProgressAt=null', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    // Launched 45m ago; no hook, no commit, no worktree, no transcript.
    launchAt: '2026-09-28T15:15:00Z',
    // Controller rewrites the stage-result on every tick — the 2026-11-05
    // incident shape. Must NOT advance lastProgressAt.
    transitionInputs: [
      { at: '2026-09-28T15:15:00Z', detail: 'ready.startedAt' },
      { at: '2026-09-28T15:59:55Z', detail: 'ready.finishedAt' },
      { at: '2026-09-28T15:59:55Z', detail: 'ready-result.mtime' },
    ],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, true);
  assert.equal(p.lastProgressAt, null);
  assert.equal(p.progressAgeMinutes, null);
  // lastTransitionAt is the newest controller write so readers that want
  // "last controller move" still see it.
  assert.equal(p.lastTransitionAt, '2026-09-28T15:59:55.000Z');
});

// HOK-3422: controller-owned wait with no launch anchor is never stalled.
test('HOK-3422: no launchAt and no agent evidence → stalled=false (healthy CI wait)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    // Ready CI wait with no remediation launched: no agent was ever started,
    // so the stall clock has no anchor.
    launchAt: null,
    launchKnownAbsent: true,
    transitionInputs: [
      { at: '2026-09-28T13:00:00Z', detail: 'ready.startedAt' },
      { at: '2026-09-28T15:59:55Z', detail: 'ready-result.mtime' },
    ],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, false);
  assert.equal(p.lastProgressAt, null);
});

// protects: a stale commit/worktree mtime left over from an earlier stage
// (e.g. coding's last commit, hours old) must not be admitted as progress
// just because no agent was ever launched for this disposition — a
// `launchKnownAbsent` wait has nothing to compare staleness against, so
// admitting old evidence unconditionally would silently resurrect the false
// stall this field exists to prevent. Without `launchKnownAbsent` (launchAt
// merely unresolved, e.g. legacy archive replay), the same stale evidence
// still counts as progress on its own — see the `replayStallIntervals` tests
// in reliability-metrics.test.ts.
test('HOK-3422: stale evidence is never admitted when launchKnownAbsent (no anchor to compare against)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    launchAt: null,
    launchKnownAbsent: true,
    // All older than the stall threshold relative to `now`.
    latestCommitAt: '2026-09-28T10:00:00Z',
    worktreeMtimeAt: '2026-09-28T10:00:00Z',
    statusFileMtimeAt: '2026-09-28T10:00:00Z',
    nativeSessionLastEventAt: '2026-09-28T10:00:00Z',
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.sources.length, 0, 'no evidence source should be admitted when launchKnownAbsent');
  assert.equal(p.lastProgressAt, null);
  assert.equal(p.stalled, false);
});

// protects: when launchAt is merely unresolved (not positively known absent),
// stale commit/worktree evidence must still be admitted as progress — the
// pre-existing, generic fallback that `replayStallIntervals` (archive replay
// with no recorded launch marker) depends on must not regress.
test('HOK-3422: stale evidence IS admitted when launchAt is merely unresolved (not launchKnownAbsent)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    launchAt: null,
    latestCommitAt: '2026-09-28T10:00:00Z',
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].kind, 'commit');
  assert.equal(p.lastProgressAt, '2026-09-28T10:00:00.000Z');
});

test('HOK-3422 replay: 2026-11-05 incident — no hook after reboot, controller rewrites ready-result every tick', () => {
  // Launched 22:33:08Z; now ~14:00Z next day (~15h30m after launch).
  const now = new Date('2026-11-05T14:00:00Z');
  const launchIso = '2026-11-04T22:33:08Z';
  // Per-tick rewrite of the ready-result file keeps advancing the mtime,
  // the exact evidence attached to the issue. Pre-fix: these advanced
  // lastProgressAt and `stalled` never fired. Post-fix: they feed
  // lastTransitionAt only and the stall clock anchors to launchAt.
  const inputs = emptyInputs({
    hookFile: null, // /tmp was cleared on reboot
    launchAt: launchIso,
    transitionInputs: [
      { at: launchIso, detail: 'ready.startedAt' },
      { at: '2026-11-05T14:06:54Z', detail: 'ready.finishedAt' },
      { at: '2026-11-05T14:07:28Z', detail: 'ready-result.mtime' },
    ],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, true, 'the ready-remediation agent should be reported as stalled, not in-flight');
  assert.equal(p.lastProgressAt, null);
});

// ── (d) writer classification + agentRecord preservation ────────────────────

test('(d) a monitor pr_merged with agentRecord preserves agentIdle from the agent Stop', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const stopTs = ts('2026-09-28T15:58:00Z');
  const mergeTs = ts('2026-09-28T15:59:30Z');
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      top: { state: 'idle', event: 'pr_merged', agent: 'claude', timestamp: mergeTs },
      writer: 'monitor',
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      topTimestamp: mergeTs,
    }),
    terminal: {
      prState: 'MERGED',
      prNumber: 123,
      lifecycleOutcome: 'merged',
      at: '2026-09-28T15:59:30Z',
    },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentIdle, true);
  assert.equal(p.terminal, true);
  assert.equal(p.terminalIdle, true);
  // A terminal task is NEVER stalled, regardless of age.
  assert.equal(p.stalled, false);
  // controllerState reflects the fresh monitor write.
  assert.equal(p.controllerState, 'idle');
});

test('(d) a legacy hook (no writer field) with pr_merged event counts as monitor; history idle wins', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const mergeTs = ts('2026-09-28T15:59:00Z');
  const inputs = emptyInputs({
    hookFile: {
      top: { state: 'idle', event: 'pr_merged', agent: 'claude', timestamp: mergeTs },
      writer: 'monitor',
      agentRecord: null,
      topTimestamp: mergeTs,
    },
    terminalHistoryIdleAt: '2026-09-28T15:58:00Z',
    terminal: { prState: 'MERGED', prNumber: 42, lifecycleOutcome: 'merged', at: '2026-09-28T15:59:00Z' },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentIdle, true);
  assert.equal(p.terminal, true);
  assert.equal(p.terminalIdle, true);
});

test('(d) a monitor-written working hook is not agentState progress', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const monitorTs = ts('2026-09-28T15:58:00Z');
  const inputs = emptyInputs({
    hookFile: {
      top: { state: 'working', event: '', agent: 'claude', timestamp: monitorTs },
      writer: 'monitor',
      agentRecord: null,
      topTimestamp: monitorTs,
    },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentState, null); // agent's own record is what counts
  assert.equal(p.controllerState, 'working');
  assert.equal(p.sources.length, 0); // monitor working != progress
});

// ── HOK-3359 controller-termination exit fact ────────────────────────────────

test('(e) a controller-termination history entry makes agentIdle true without moving lastProgressAt', () => {
  const now = new Date('2026-10-30T11:00:00Z');
  // The live hook still shows the agent mid-write (no Stop was ever
  // written) — exactly the HOK-3315 incident shape.
  const baseInputs = emptyInputs({
    hookFile: makeHookFile({
      top: { state: 'working', event: 'PreToolUse', agent: 'claude', timestamp: ts('2026-10-30T10:36:08Z') },
      agentRecord: { state: 'working', event: 'PreToolUse', agent: 'claude', timestamp: ts('2026-10-30T10:36:08Z') },
      writer: 'agent',
      topTimestamp: ts('2026-10-30T10:36:08Z'),
    }),
  });

  const without = deriveTaskProgress(baseInputs, { now });
  const withTermination = deriveTaskProgress(
    { ...baseInputs, terminalHistoryIdleAt: '2026-10-30T10:36:09Z' },
    { now },
  );

  assert.equal(without.agentIdle, false);
  assert.equal(withTermination.agentIdle, true);
  // The controller-termination fact never becomes a progress source or moves
  // lastProgressAt (HOK-3101 invariant 1) — it is an exit fact, not progress.
  assert.equal(withTermination.lastProgressAt, without.lastProgressAt);
  assert.deepEqual(withTermination.sources, without.sources);
});

// ── HOK-3069 stall replay ────────────────────────────────────────────────────

test('HOK-3069 replay: no hook, HEAD older than launch, clean worktree, status mtime = launch, age > 30m → stalled', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const launchIso = '2026-09-28T15:29:00Z'; // 31m ago
  const inputs = emptyInputs({
    hookFile: null,
    latestCommitAt: '2026-09-28T13:00:00Z', // older than launch
    launchAt: launchIso,
    worktreeMtimeAt: null,
    statusFileMtimeAt: '2026-09-28T15:29:00Z', // == launch, within 5s grace
    transitionInputs: [{ at: launchIso, detail: 'coding.startedAt' }],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, true);
  const kinds = p.sources.map((s) => s.kind);
  // HOK-3422: transitions are no longer a progress source.
  assert.deepEqual(kinds, []);
});

test('HOK-3069 counter: status mtime at launch+10m => not stalled at 31m', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    launchAt: '2026-09-28T15:29:00Z',
    statusFileMtimeAt: '2026-09-28T15:39:00Z',
    transitionInputs: [{ at: '2026-09-28T15:29:00Z', detail: 'coding.startedAt' }],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, false);
});

// ── attention states never stall ─────────────────────────────────────────────

test('a fresh agent waiting or approval-needed state suppresses the stall flag', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const waitingTs = ts('2026-09-28T15:59:00Z');
  for (const state of ['waiting', 'approval-needed', 'blocked', 'policy-denied'] as const) {
    const inputs = emptyInputs({
      hookFile: {
        top: { state, event: 'Notification', agent: 'claude', timestamp: waitingTs },
        writer: 'agent',
        agentRecord: { state, event: 'Notification', agent: 'claude', timestamp: waitingTs },
        topTimestamp: waitingTs,
      },
      // HOK-3422: launchAt anchors the stall clock; a fresh attention state
      // suppresses it even though the launch is 2h old.
      launchAt: '2026-09-28T14:00:00Z',
      transitionInputs: [{ at: '2026-09-28T14:00:00Z', detail: 'coding.startedAt' }],
    });
    const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
    assert.equal(p.stalled, false, `expected not stalled for ${state}`);
  }
});

test('a terminal task is never stalled, even after threshold', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    launchAt: '2026-09-28T00:00:00Z',
    terminal: { prState: 'MERGED', prNumber: 1, lifecycleOutcome: 'merged', at: '2026-09-28T00:00:00Z' },
    transitionInputs: [{ at: '2026-09-28T00:00:00Z', detail: 'task.updated' }],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, false);
  assert.equal(p.terminal, true);
});

// ── blocking prompt matcher (extended catalog) ───────────────────────────────

test('codex_daemon_version_mismatch matches the incident text', () => {
  const paneText = 'Warning: Cannot use the background server (client 0.157.0 vs daemon 0.158.0)\n> 1. Continue\n> 2. Cancel';
  const sig = matchInteractivePromptSignature(paneText);
  assert.ok(sig, 'should match');
  assert.equal(sig!.id, 'codex_daemon_version_mismatch');
});

test('codex_daemon_version_mismatch does not match source code with the same tokens', () => {
  const code = 'function cancelBackgroundServer() { return "Cannot use the background server"; }';
  assert.equal(matchInteractivePromptSignature(code), undefined);
});

test('codex_model_retirement still matches', () => {
  const paneText = 'GPT-5.5 retires on October 14. Try new model or Use existing model?';
  const sig = matchInteractivePromptSignature(paneText);
  assert.ok(sig);
  assert.equal(sig!.id, 'codex_model_retirement');
});

test('INTERACTIVE_PROMPT_SIGNATURES includes both signatures', () => {
  const ids = INTERACTIVE_PROMPT_SIGNATURES.map((s) => s.id);
  assert.ok(ids.includes('codex_model_retirement'));
  assert.ok(ids.includes('codex_daemon_version_mismatch'));
});

test('normalizeInteractivePromptText caps input length', () => {
  const long = 'x'.repeat(20_000);
  const norm = normalizeInteractivePromptText(long);
  assert.ok(norm.length <= 8_000);
});

// ── Hook writer classification ───────────────────────────────────────────────

test('isControllerHookRecord: explicit writer field wins over event', () => {
  assert.equal(isControllerHookRecord({ writer: 'agent', event: 'pr_merged', state: 'idle' }), false);
  assert.equal(isControllerHookRecord({ writer: 'monitor', event: 'PreToolUse', state: 'working' }), true);
});

test('isControllerHookRecord: legacy hook uses event classification', () => {
  assert.equal(isControllerHookRecord({ event: 'pr_merged', state: 'idle' }), true);
  assert.equal(isControllerHookRecord({ event: 'Stop', state: 'idle' }), false);
  assert.equal(isControllerHookRecord({ event: '', state: 'working' }), true);
  assert.equal(isControllerHookRecord({ event: '', state: 'idle' }), false);
});

test('CONTROLLER_HOOK_EVENTS matches the plan list', () => {
  const required = [
    'pr_merged', 'pr_closed_unmerged', 'operator_abort', 'recovery_failure',
    'review_complete', 'ready_complete', 'pr_opened',
    'blocked_completion_liveness', 'premature_plan_approval',
    'recovery_contract_unavailable', 'planning_rejection_notify_failed',
    'NoPR', 'worktree-setup',
  ];
  for (const e of required) {
    assert.ok(CONTROLLER_HOOK_EVENTS.has(e), `missing controller event: ${e}`);
  }
});

// ── HOOK_TTL_SECONDS is 300 ──────────────────────────────────────────────────

test('HOOK_TTL_SECONDS is 300', () => {
  assert.equal(HOOK_TTL_SECONDS, 300);
});

// ── selectAgentRecord ────────────────────────────────────────────────────────

test('selectAgentRecord returns null for missing hook or missing record', () => {
  assert.equal(selectAgentRecord(null), null);
  const hook: HookFile = {
    top: { state: 'idle', event: 'pr_merged', agent: 'claude', timestamp: 1 },
    writer: 'monitor',
    agentRecord: null,
    topTimestamp: 1,
  };
  assert.equal(selectAgentRecord(hook), null);
});

// ── progressCacheIsFresh ─────────────────────────────────────────────────────

test('progressCacheIsFresh returns true only when computedAt is within the window', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const fresh = {
    issue: 'x',
    computedAt: '2026-09-28T15:59:00Z',
    lastProgressAt: null,
    progressAgeMinutes: null,
    sources: [],
    agentState: null,
    agentRecord: null,
    controllerState: null,
    agentIdle: false,
    terminal: false,
    terminalIdle: false,
    agentProcessLive: null,
    stalled: false,
    stallMinutes: 30,
    blockingPrompt: null,
  } as const;
  assert.equal(progressCacheIsFresh(fresh, 300, now), true);
  const stale = { ...fresh, computedAt: '2026-09-28T15:00:00Z' };
  assert.equal(progressCacheIsFresh(stale, 300, now), false);
});

test('progressCacheIsFresh treats a cache older than the hook file as stale', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const cached = {
    issue: 'x',
    computedAt: '2026-09-28T15:59:00Z',
    lastProgressAt: null,
    progressAgeMinutes: null,
    sources: [],
    agentState: 'working',
    agentRecord: null,
    controllerState: null,
    agentIdle: false,
    terminal: false,
    terminalIdle: false,
    agentProcessLive: null,
    stalled: false,
    stallMinutes: 30,
    blockingPrompt: null,
  } as const;
  const computedAtMs = Date.parse(cached.computedAt);
  // The agent's Stop landed after the cache was computed: recompute.
  assert.equal(progressCacheIsFresh(cached, 300, now, computedAtMs + 1_000), false);
  // A hook written before the cache leaves it fresh; an absent hook is ignored.
  assert.equal(progressCacheIsFresh(cached, 300, now, computedAtMs - 1_000), true);
  assert.equal(progressCacheIsFresh(cached, 300, now, null), true);
});

// ── Gather IO: history-file fallback + worktree filter ───────────────────────

test('gather: a controller-termination entry provides terminalHistoryIdleAt, ignoring a stale monitor entry', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-test-'));
  try {
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    const monitorTs = Math.floor(Date.parse('2026-10-30T10:30:00Z') / 1000);
    const teardownTs = Math.floor(Date.parse('2026-10-30T10:36:09Z') / 1000);
    const lines = [
      // A stale writer=monitor archive entry must never count as idle, even
      // when it carries state=idle itself.
      {
        archivedAt: '2026-10-30T10:30:00Z',
        reason: 'pr_opened',
        session: 'sess', issue: 'TEST-3315',
        payload: { state: 'idle', event: 'pr_opened', writer: 'monitor', agent: 'wavemill', timestamp: monitorTs },
      },
      // The controller-termination exit fact (HOK-3359).
      {
        archivedAt: '2026-10-30T10:36:09Z',
        reason: 'completed-coding-pane-quarantine',
        session: 'sess', issue: 'TEST-3315',
        payload: {
          state: 'idle', event: 'controller_termination', writer: 'controller', kind: 'controller-termination',
          reason: 'completed-coding-pane-quarantine', phase: 'coding', agent: 'wavemill', timestamp: teardownTs,
          agentRecord: { state: 'working', event: 'PreToolUse', agent: 'claude', timestamp: teardownTs },
        },
      },
    ];
    writeFileSync(featureDir + '/.terminal-history.jsonl', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const inputs = gatherTaskProgressInputs({
      issue: 'TEST-3315',
      session: 'sess',
      featureDir,
    });
    assert.equal(inputs.terminalHistoryIdleAt, new Date(teardownTs * 1000).toISOString());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// protects: the HOK-3426 exit fact — a controller-termination record for THIS
// stage, at/after the launch, becomes `agentExited`; one for another phase
// (the coding pane's quarantine) never settles review.
test('gather: controller-termination is agentExited only for its own phase and attempt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-exit-'));
  try {
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    const codingTs = Math.floor(Date.parse('2026-11-05T12:01:00Z') / 1000);
    const reviewTs = Math.floor(Date.parse('2026-11-05T12:10:00Z') / 1000);
    const lines = [
      {
        archivedAt: '2026-11-05T12:01:00Z', reason: 'completed-coding-pane-quarantine', session: 'sess', issue: 'TEST-3426',
        payload: { state: 'idle', event: 'controller_termination', writer: 'controller', kind: 'controller-termination', reason: 'completed-coding-pane-quarantine', phase: 'coding', timestamp: codingTs },
      },
      {
        archivedAt: '2026-11-05T12:10:00Z', reason: 'review-reroute', session: 'sess', issue: 'TEST-3426',
        payload: { state: 'idle', event: 'controller_termination', writer: 'controller', kind: 'controller-termination', reason: 'review-reroute', phase: 'review', timestamp: reviewTs },
      },
    ];
    writeFileSync(join(featureDir, '.terminal-history.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    // Review, launched before the termination: the review record is the fact.
    const review = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.deepEqual(review.agentExited, {
      at: new Date(reviewTs * 1000).toISOString(), source: 'controller-termination',
    });

    // The coding quarantine alone is not evidence about review: a gather that
    // sees ONLY the coding record must not settle review.
    const codingOnlyDir = join(tmp, 'features', 'coding-only');
    mkdirSync(codingOnlyDir, { recursive: true });
    writeFileSync(join(codingOnlyDir, '.terminal-history.jsonl'), JSON.stringify(lines[0]) + '\n');
    const reviewWithCodingOnly = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir: codingOnlyDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.equal(reviewWithCodingOnly.agentExited, null,
      'the coding pane quarantine must never be the review stage exit fact');

    // A terminated attempt followed by a relaunch: the older record is stale.
    const relaunched = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:11:00Z',
    });
    assert.equal(relaunched.agentExited, null);

    // A coding-stage gather sees only its own record.
    const coding = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'coding', agentExitSince: '2026-11-05T12:00:00Z',
    });
    assert.deepEqual(coding.agentExited, {
      at: new Date(codingTs * 1000).toISOString(), source: 'controller-termination',
    });

    // No launch recorded → no agent was launched → no termination is an exit.
    const notLaunched = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: null,
    });
    assert.equal(notLaunched.agentExited, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// protects: the launcher's own `agent-exit` record (the agent process's parent
// observed its exit — the only surface that sees a hard-killed agent) becomes
// the exit fact, phase- and launch-scoped, and a controller termination for
// the same stage takes precedence over it.
test('gather: a launcher agent-exit record is agentExited, phase- and attempt-scoped', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-launcher-exit-'));
  try {
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const launcherExit = (phase: string, iso: string, exitCode: number) => ({
      archivedAt: iso,
      reason: 'agent-exit',
      payload: {
        state: exitCode === 0 ? 'idle' : 'error', event: 'agent_exit', writer: 'launcher',
        kind: 'agent-exit', phase, timestamp: ts(iso), exitCode, recordedAt: iso,
      },
    });
    const codingTs = ts('2026-11-05T12:02:00Z');
    const reviewTs = ts('2026-11-05T12:05:00Z');

    // The coding pane's launcher exit never settles a review gather.
    const codingOnlyDir = join(tmp, 'features', 'coding-only');
    mkdirSync(codingOnlyDir, { recursive: true });
    writeFileSync(
      join(codingOnlyDir, '.terminal-history.jsonl'),
      JSON.stringify(launcherExit('coding', '2026-11-05T12:02:00Z', 143)) + '\n',
    );
    assert.equal(gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir: codingOnlyDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:03:00Z',
    }).agentExited, null, 'another phase\'s agent-exit is never this stage\'s exit');

    // The review attempt launched at 12:03 exited at 12:05.
    writeFileSync(
      join(featureDir, '.terminal-history.jsonl'),
      [
        JSON.stringify(launcherExit('coding', '2026-11-05T12:02:00Z', 143)),
        JSON.stringify(launcherExit('review', '2026-11-05T12:05:00Z', 143)),
      ].join('\n') + '\n',
    );
    assert.deepEqual(gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:03:00Z',
    }).agentExited, { at: new Date(reviewTs * 1000).toISOString(), source: 'launcher' });

    // A relaunch after that exit has no exit fact of its own yet.
    assert.equal(gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:06:00Z',
    }).agentExited, null);

    // Exit records carry second precision: an agent that exits in the launch's
    // own second is still this attempt's exit, while a later second is not.
    assert.deepEqual(gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:05:00.800Z',
    }).agentExited, { at: new Date(reviewTs * 1000).toISOString(), source: 'launcher' });
    assert.equal(gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:05:01.500Z',
    }).agentExited, null);

    // The coding stage gathers its own launcher exit.
    assert.deepEqual(gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'coding', agentExitSince: '2026-11-05T12:00:00Z',
    }).agentExited, { at: new Date(codingTs * 1000).toISOString(), source: 'launcher' });

    // A controller termination for the same stage is the preferred source.
    const termination = {
      archivedAt: '2026-11-05T12:07:00Z', reason: 'review-reroute',
      payload: {
        state: 'idle', event: 'controller_termination', writer: 'controller',
        kind: 'controller-termination', reason: 'review-reroute', phase: 'review',
        timestamp: ts('2026-11-05T12:07:00Z'),
      },
    };
    writeFileSync(
      join(featureDir, '.terminal-history.jsonl'),
      [
        JSON.stringify(launcherExit('review', '2026-11-05T12:05:00Z', 143)),
        JSON.stringify(termination),
      ].join('\n') + '\n',
    );
    const preferred = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitPhase: 'review', agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.equal(preferred.agentExited?.source, 'controller-termination');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// protects: the launched slot itself reports dead (term_is_dead on the
// recorded window handle) becoming the exit fact — never a pane descendant
// count — while the probe stays bounded to a disposition gather that knows a
// launch time, and a missing/replaced handle never reads as an exit.
test("gather: term_is_dead on the task row's recorded windowId is agentExited", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-exit-'));
  const calls: string[][] = [];
  try {
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    setTerminalExecForTest({
      sync(args) {
        calls.push([...args]);
        if (args[0] === 'list-panes') return { ok: true, stdout: '1\n' };
        return { ok: false, stdout: '' };
      },
      async async(args) {
        return this.sync(args);
      },
    });
    const dead = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      task: { windowId: '@7' } as never,
      agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.equal(dead.agentExited?.source, 'terminal-backend');
    assert.ok(calls.some((args) => args.includes('@7')), 'probed the task row surface');

    // Without a recorded handle the slot cannot be read; no exit fact.
    const noHandle = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.equal(noHandle.agentExited, null);

    // HOK-3206 hot-pass callers (dashboard, monitor tick) do not supply a
    // launch time, so they must not pay for a terminal-backend probe even when
    // the task row carries a windowId.
    const beforeCalls = calls.length;
    const hotPass = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      task: { windowId: '@hot' } as never,
    });
    assert.equal(hotPass.agentExited, null);
    assert.equal(calls.length, beforeCalls, 'no slot probe outside a disposition gather');
    assert.ok(!calls.some((args) => args.includes('@hot')), 'never probed the hot-pass handle');

    // `null` means no agent was ever launched for this stage: a dead slot is
    // then not an exit of one.
    const notLaunched = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      task: { windowId: '@7' } as never,
      agentExitSince: null,
    });
    assert.equal(notLaunched.agentExited, null);

    // A running slot reports dead=0 → no exit fact.
    setTerminalExecForTest({
      sync(args) {
        if (args[0] === 'list-panes') return { ok: true, stdout: '0\n' };
        return { ok: false, stdout: '' };
      },
      async async(args) {
        return this.sync(args);
      },
    });
    const live = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      task: { windowId: '@8' } as never,
      agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.equal(live.agentExited, null);

    // A reaped or recreated handle is unreadable (the backend call fails):
    // `termIsDead` reports null, never true, so a replaced window cannot fake
    // an exit for a live agent.
    setTerminalExecForTest({
      sync(args) {
        calls.push([...args]);
        if (args[0] === 'list-panes') return { ok: false, stdout: '' };
        return { ok: false, stdout: '' };
      },
      async async(args) {
        return this.sync(args);
      },
    });
    const missing = gatherTaskProgressInputs({
      issue: 'TEST-3426', session: 'sess', featureDir,
      task: { windowId: '@gone' } as never,
      agentExitSince: '2026-11-05T12:03:00Z',
    });
    assert.equal(missing.agentExited, null, 'a missing window is not an exit');
  } finally {
    setTerminalExecForTest(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gather: history file with agent Stop provides terminalHistoryIdleAt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-test-'));
  try {
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    const stopTs = Math.floor(Date.parse('2026-09-28T15:00:00Z') / 1000);
    const historyLine = JSON.stringify({
      archivedAt: '2026-09-28T15:59:00Z',
      reason: 'pr_merged',
      session: 'sess', issue: 'TEST-9',
      payload: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
    });
    writeFileSync(join(featureDir, '.terminal-history.jsonl'), historyLine + '\n');
    const inputs = gatherTaskProgressInputs({
      issue: 'TEST-9',
      session: 'sess',
      featureDir,
    });
    assert.ok(inputs.terminalHistoryIdleAt);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gather: worktree source excludes .wavemill/prompt-registry.jsonl and features/<slug>/.coding-result.json', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-test-'));
  try {
    // Init git repo
    execFileSync('git', ['-C', tmp, 'init', '-q']);
    execFileSync('git', ['-C', tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    // Set up features/testslug/.coding-result.json (controller write)
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.coding-result.json'), '{}');
    // Set up .wavemill/prompt-registry.jsonl (telemetry, should also be ignored)
    mkdirSync(join(tmp, '.wavemill'), { recursive: true });
    writeFileSync(join(tmp, '.wavemill', 'prompt-registry.jsonl'), '{}');
    const inputs = gatherTaskProgressInputs({
      issue: 'TEST-11',
      session: 'sess',
      worktree: tmp,
      task: { slug: 'testslug' },
    });
    // Only controller dotfiles are present; worktree mtime should be null.
    assert.equal(inputs.worktreeMtimeAt, null, `worktreeMtimeAt should be null, got ${inputs.worktreeMtimeAt}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gather: an agent-owned file (plan.md) in features/<slug> DOES count as worktree progress', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-test-'));
  try {
    execFileSync('git', ['-C', tmp, 'init', '-q']);
    execFileSync('git', ['-C', tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const featureDir = join(tmp, 'features', 'testslug');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'plan.md'), '# plan');
    const inputs = gatherTaskProgressInputs({
      issue: 'TEST-12',
      session: 'sess',
      worktree: tmp,
      task: { slug: 'testslug' },
    });
    assert.ok(inputs.worktreeMtimeAt, 'plan.md should register as worktree progress');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gather: reading a hook file with .agentRecord preserves the agent record', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'task-progress-test-'));
  try {
    const hookPath = join(tmp, 'hook.json');
    const stopTs = Math.floor(Date.parse('2026-09-28T15:00:00Z') / 1000);
    writeFileSync(hookPath, JSON.stringify({
      state: 'idle',
      event: 'pr_merged',
      agent: 'claude',
      timestamp: stopTs + 60,
      writer: 'monitor',
      detail: 'PR #123 merged',
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
    }));
    const hf = readHookFile(hookPath);
    assert.ok(hf);
    assert.equal(hf!.writer, 'monitor');
    assert.equal(hf!.agentRecord?.event, 'Stop');
    assert.equal(hf!.top?.event, 'pr_merged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('getTaskProgress on a missing hook + no worktree returns an empty-progress result', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const p = getTaskProgress({ issue: 'DOES-NOT-EXIST', session: 'sess', now });
  assert.equal(p.lastProgressAt, null);
  assert.equal(p.agentIdle, false);
  assert.equal(p.terminal, false);
  assert.equal(p.stalled, false);
});

// ── HOK-3137: background-work detection (ps snapshot parsing) ───────────────

test('parsePsSnapshot parses pid/ppid/etime shapes and commands with spaces', () => {
  const psOutput = [
    '  100     1 01:02:03 /bin/bash -c sleep 30',
    '  200   100       45 node /app/agent.js --flag value',
    '  300   200 3-04:05:06 npm test -- --watch',
    '  400   200    12:34 sleep 600',
    '',
  ].join('\n');
  const processes = parsePsSnapshot(psOutput);
  assert.equal(processes.length, 4);
  assert.deepEqual(processes[0], { pid: 100, ppid: 1, etimeSeconds: 3600 + 120 + 3, command: '/bin/bash -c sleep 30' });
  assert.deepEqual(processes[1], { pid: 200, ppid: 100, etimeSeconds: 45, command: 'node /app/agent.js --flag value' });
  assert.deepEqual(processes[2].etimeSeconds, ((3 * 24 + 4) * 60 + 5) * 60 + 6);
  assert.equal(processes[2].command, 'npm test -- --watch');
  assert.deepEqual(processes[3], { pid: 400, ppid: 200, etimeSeconds: 12 * 60 + 34, command: 'sleep 600' });
});

test('parsePsSnapshot skips unparsable rows without throwing', () => {
  const processes = parsePsSnapshot('garbage line\n  100     1 00:01 ok-process\n');
  assert.equal(processes.length, 1);
  assert.equal(processes[0].pid, 100);
});

// ── HOK-3137/HOK-3374: deriveAgentBackgroundWork (one ownership rule) ──────
//
// The second parameter is the AGENT's pid (HOK-3374): a process is the
// agent's background work iff it is a descendant of the agent process that
// started at least `minChildLagSeconds` after it. No command names.

function proc(pid: number, ppid: number, etimeSeconds: number, command: string): PaneProcess {
  return { pid, ppid, etimeSeconds, command };
}

// protects: HOK-3101(a) — an idle agent REPL with no descendants is never background work
test('bg-work: idle REPL regression — shell -> claude only is NOT live (HOK-3101(a))', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
  assert.deepEqual(result.processes, []);
});

// protects: HOK-3137 — a backgrounded task the idle agent waits on suppresses the stall
test('bg-work: shell -> claude -> sleep 30 with sufficient lag is live', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
    proc(3, 2, 20, 'sleep 30'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.deepEqual(result.processes, [{ pid: 3, command: 'sleep 30' }]);
});

// protects: the lag floor (agent-relative) excludes session-startup services
test('bg-work: shell -> claude -> mcp-server with lag under threshold is NOT live (session-service exclusion)', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
    proc(3, 2, 95, 'mcp-server --stdio'), // started 5s after claude, under the 30s lag floor
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
});

// protects: HOK-3374 — every qualifying descendant is evidence, not only the deepest leaf
test('bg-work: shell -> claude -> bash -c -> npm test is live (shells are owned like anything else)', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'bash -c "npm test"'),
    proc(4, 3, 50, 'npm test -- --watch'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.ok(result.processes.length >= 1, 'at least one evidence row');
  assert.ok(result.processes.some((p) => p.pid === 4), 'evidence includes the deepest leaf');
});

// protects: HOK-3222 — a controller-named descendant of the agent IS the agent's work
test('bg-work: a tools/*.ts child of the agent is live (HOK-3374 regression fix)', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'npx tsx tools/tend.ts --issue HOK-1'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true); // was false under the HOK-3222 name classifier
  assert.deepEqual(result.processes, [{ pid: 3, command: 'npx tsx tools/tend.ts --issue HOK-1' }]);
});

// protects: HOK-3222 replay — the incident's pure shell chain reads live under the agent
test('bg-work: HOK-3222 replay — pure shell chain under the agent is live', () => {
  const processes = [
    proc(1, 0, 1900, '-zsh'),
    proc(2, 1, 1800, 'claude --model claude-opus-5-5'),
    proc(3, 2, 1750, 'zsh -c bash tests/run-related.sh'),
    proc(4, 3, 1700, 'bash tests/run-related.sh'),
    proc(5, 4, 1600, 'bash tests/run-journeys.sh'),
    proc(6, 5, 1500, 'bash tests/journeys/x.journey.sh'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.ok(result.processes.some((p) => p.pid === 6), 'evidence reaches the deepest leaf of the chain');
});

// protects: HOK-3222 replay — the mill's own tend.ts is agent work when the agent ran it
test('bg-work: HOK-3222 replay — a tools/tend.ts descendant of the agent is live', () => {
  const processes = [
    proc(1, 0, 1900, '-zsh'),
    proc(2, 1, 1800, 'claude'),
    proc(3, 2, 50, 'npx tsx tools/tend.ts HOK-1'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true); // was false under the HOK-3222 name classifier
});

// protects: HOK-3222 replay — the incident's controller-tagged probe argv is agent work under the agent
test('bg-work: HOK-3222 replay — an npx tsx --test tools/plan-queue.test.ts child of the agent is live', () => {
  const processes = [
    proc(1, 0, 1900, '-zsh'),
    proc(2, 1, 1800, 'claude'),
    proc(3, 2, 1700, 'npx tsx --test tools/plan-queue.test.ts'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
});

// protects: HOK-3222 replay — node --test children of the agent count as its work
test('bg-work: HOK-3222 replay — a node --test child of the agent is live', () => {
  const processes = [
    proc(1, 0, 1900, '-zsh'),
    proc(2, 1, 1800, 'claude'),
    proc(3, 2, 1700, 'node --test shared/lib/x.test.ts'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
});

// protects: HOK-3222 replay — even a trivial sleep child past the lag floor counts
test('bg-work: HOK-3222 replay — a sleep child of the agent past the lag floor is live', () => {
  const processes = [
    proc(1, 0, 1900, '-zsh'),
    proc(2, 1, 1800, 'claude'),
    proc(3, 2, 1700, 'sleep 5'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
});

// protects: the pane root may itself be the agent (pane command = the agent CLI)
test('bg-work: pane root is the agent itself (claude -> sleep, no wrapping shell) is live', () => {
  const processes = [
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'sleep 600'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.deepEqual(result.processes, [{ pid: 3, command: 'sleep 600' }]);
});

// protects: BACKGROUND_EVIDENCE_LIMIT bounds the evidence payload
test('bg-work: multiple background tasks — still live, evidence capped', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'sleep 600'),
    proc(4, 2, 40, 'npm test'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.equal(result.processes.length, 2);
});

// protects: a short-lived child that already exited is not evidence
test('bg-work: a short-lived child that has already exited is simply absent from the snapshot — not live', () => {
  // The 1s child from REQ-F1's edge case is gone by the time ps runs; the
  // snapshot never contains it, so the subtree looks like the idle-REPL case.
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
});

// protects: a dead agent (pid gone, children reparented) is never live
test('bg-work: an orphaned descendant outside the agent subtree does not protect a dead agent', () => {
  // The agent (pid 2) is gone; its former child (pid 3) reparented to pid 1
  // directly (simulating init/subreaper adoption) and is outside the dead
  // agent's subtree entirely.
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(3, 1, 50, 'sleep 600'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
  assert.deepEqual(result.processes, []);
});

// protects: descendants older than the agent (inherited pty-style) are not its work
test('bg-work: a descendant that started before the agent (negative lag) is not live', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
    proc(3, 2, 150, 'npm test'), // etime 150 > claude's 100: started before the agent
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
  assert.deepEqual(result.processes, []);
});

// ── HOK-3137: deriveTaskProgress stall suppression ──────────────────────────

// NOTE: an idle hook record is never itself a progress `source` (it is the
// agent's settled state, not progress), so `progressAgeMinutes` would be
// `null` — and `overThreshold` false — without an independent stall anchor.
// HOK-3422: each fixture below sets `launchAt` to 60 minutes ago; the
// derivation's new anchor rule (`lastProgressMs ?? launchMs`) then fires
// `overThreshold` from the launch, isolating what we're actually testing:
// whether background-work suppression fires.
const STALE_LAUNCH_AT = '2026-09-28T15:00:00Z';

test('deriveTaskProgress: idle agent + live background work suppresses stalled, never touches lastProgressAt/sources', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const stopTs = ts('2026-09-28T15:00:00Z'); // 60 minutes ago — over the 30m default threshold
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      top: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      writer: 'agent',
      topTimestamp: stopTs,
    }),
    launchAt: STALE_LAUNCH_AT,
    backgroundWork: { live: true, processes: [{ pid: 999, command: 'sleep 600' }] },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentIdle, true);
  assert.equal(p.agentBackgroundLive, true);
  assert.equal(p.backgroundProcesses.length, 1);
  assert.equal(p.stalled, false);
  // HOK-3422 invariant: the idle hook and background-work probe never add
  // progress sources. Transitions are no longer a progress kind either, so
  // sources[] is empty here.
  assert.equal(p.sources.length, 0);
});

test('deriveTaskProgress: idle agent + no background work still stalls (existing behavior preserved)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const stopTs = ts('2026-09-28T15:00:00Z');
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      top: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      writer: 'agent',
      topTimestamp: stopTs,
    }),
    launchAt: STALE_LAUNCH_AT,
    backgroundWork: { live: false, processes: [] },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentIdle, true);
  assert.equal(p.agentBackgroundLive, false);
  assert.equal(p.stalled, true);
});

test('deriveTaskProgress: not probed (backgroundWork null) behaves like today (agentBackgroundLive null, stall unaffected)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const stopTs = ts('2026-09-28T15:00:00Z');
  const inputs = emptyInputs({
    hookFile: makeHookFile({
      top: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: stopTs },
      writer: 'agent',
      topTimestamp: stopTs,
    }),
    launchAt: STALE_LAUNCH_AT,
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentBackgroundLive, null);
  assert.equal(p.stalled, true);
});

test('deriveTaskProgress: non-idle agent + live background work does NOT suppress stall (suppression is idle-scoped)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    hookFile: null,
    launchAt: STALE_LAUNCH_AT,
    backgroundWork: { live: true, processes: [{ pid: 999, command: 'sleep 600' }] },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentIdle, false);
  assert.equal(p.agentBackgroundLive, true);
  assert.equal(p.stalled, true);
});

// ── Ensure existsSync helper is imported by the test (avoid unused var) ─────
test('smoke: existsSync helper is available in the test env', () => {
  assert.equal(existsSync('/'), true);
});

// ── HOK-3381: shared tool-call progress rule ────────────────────────────────

import {
  ToolCallProgressTracker,
  toolCallResultKey,
  toolSelectionKey,
} from './task-progress.ts';
import { trackedContentFingerprint } from './native-agent/worktree-fingerprint.ts';

const CODING_PROGRESS_POLICY = { maxRepeatedSelectionCalls: 8, maxNoProgressCalls: 4 };

function testObservation(selection: string, fingerprint: string, result: string) {
  return { selectionKey: selection, worktreeFingerprint: fingerprint, resultKey: result };
}

// protects: a model rerunning the same failing selection with no edits looping forever (HOK-3381 acceptance)
test('ToolCallProgressTracker: same selection, unchanged tree, same failure stagnates within the configured count', () => {
  const tracker = new ToolCallProgressTracker(CODING_PROGRESS_POLICY);
  let stagnantAt: number | null = null;
  for (let call = 1; call <= 10; call += 1) {
    const decision = tracker.record(testObservation('run_tests:{"command":"node --test a.test.ts"}', 'tree-1', 'exit:1'));
    if (decision.stagnant && stagnantAt === null) stagnantAt = call;
  }
  assert.equal(stagnantAt, CODING_PROGRESS_POLICY.maxRepeatedSelectionCalls);
});

// protects: slow repeats of the same timed-out selection evading the rule because output text differs (old output-hash rule)
test('ToolCallProgressTracker: repeated timeouts of one selection are no-progress even when each run is slow', () => {
  const tracker = new ToolCallProgressTracker({ maxRepeatedSelectionCalls: 3, maxNoProgressCalls: 2 });
  assert.equal(tracker.record(testObservation('sel', 'tree-1', 'timeout')).stagnant, false);
  assert.equal(tracker.record(testObservation('sel', 'tree-1', 'timeout')).noProgress, true);
  const third = tracker.record(testObservation('sel', 'tree-1', 'timeout'));
  assert.equal(third.noProgress, true);
  assert.equal(third.stagnant, true);
});

// protects: an agent that edits code between runs being stopped as "stagnant"
test('ToolCallProgressTracker: changed tracked content resets the no-progress count', () => {
  const tracker = new ToolCallProgressTracker({ maxRepeatedSelectionCalls: 2, maxNoProgressCalls: 1 });
  tracker.record(testObservation('sel', 'tree-1', 'exit:1'));
  const edited = tracker.record(testObservation('sel', 'tree-2', 'exit:1'));
  assert.equal(edited.noProgress, false);
  assert.equal(edited.stagnant, false);
  // Same content but a different result (the failure changed) is also progress.
  const differentResult = tracker.record(testObservation('sel', 'tree-2', 'exit:0'));
  assert.equal(differentResult.noProgress, false);
});

// protects: HOK-3374 attempt 2 — running smaller selections after a timeout is new information, not a loop
test('ToolCallProgressTracker: a narrower selection after a timeout is a new selection, never stagnant', () => {
  const tracker = new ToolCallProgressTracker(CODING_PROGRESS_POLICY);
  tracker.record(testObservation('run_tests:{"command":"bash tests/run-related.sh"}', 'tree-1', 'timeout'));
  for (let shard = 0; shard < 10; shard += 1) {
    const decision = tracker.record(
      testObservation(`run_tests:{"command":"node --test file-${shard}.test.ts"}`, 'tree-1', 'exit:0'),
    );
    assert.equal(decision.stagnant, false);
    assert.equal(decision.noProgress, false);
  }
});

// protects: a changed timeoutMs or argument order making a repeat look like a new selection
test('toolSelectionKey: ignores volatile budget args and key order', () => {
  const a = toolSelectionKey('run_tests', { command: 'node --test a.test.ts', timeoutMs: 100, maxOutputBytes: 1024 });
  const b = toolSelectionKey('run_tests', { maxOutputBytes: 65536, command: 'node --test a.test.ts', timeoutMs: 600_000 });
  assert.equal(a, b);
  assert.notEqual(a, toolSelectionKey('run_tests', { command: 'node --test b.test.ts' }));
  assert.notEqual(a, toolSelectionKey('run_format', { command: 'node --test a.test.ts' }));
});

// protects: test output with timings in it defeating result comparison (the old byte-identical output-hash rule)
test('toolCallResultKey: command outcomes collapse to pass/fail/timeout, ignoring output noise', () => {
  const timeoutA = toolCallResultKey({ details: { ok: true, status: 'timed_out', exitCode: null, durationMs: 300_001, stdout: 'ran 14s' } });
  const timeoutB = toolCallResultKey({ details: { ok: true, status: 'timed_out', exitCode: null, durationMs: 599_872, stdout: 'ran 599s' } });
  assert.equal(timeoutA, 'timeout');
  assert.equal(timeoutA, timeoutB);
  assert.equal(toolCallResultKey({ details: { ok: true, status: 'completed', exitCode: 1 } }), 'exit:1');
  assert.equal(toolCallResultKey({ details: { ok: true, status: 'completed', exitCode: 0 } }), 'exit:0');
  assert.equal(toolCallResultKey({ details: { ok: false, error: 'full_suite_refused' } }), 'rejected:full_suite_refused');
  // Read-only tools digest the observable result.
  const read1 = toolCallResultKey({ content: [{ type: 'text', text: 'page 1' }] });
  const read2 = toolCallResultKey({ content: [{ type: 'text', text: 'page 2' }] });
  assert.notEqual(read1, read2);
  assert.equal(read1, toolCallResultKey({ content: [{ type: 'text', text: 'page 1' }] }));
});

// protects: test logs under .wavemill/ counting as worktree progress (HOK-3381: logs must not count)
test('trackedContentFingerprint: tracked edits change it, .wavemill log writes do not', () => {
  const repo = mkdtempSync(join(tmpdir(), 'hok3381-fp-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    const base = trackedContentFingerprint(repo);
    assert.ok(base.length > 0);

    // Log-only change: .wavemill/logs must not count as progress.
    mkdirSync(join(repo, '.wavemill', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'logs', 'run-tests.log'), 'line 1\n');
    assert.equal(trackedContentFingerprint(repo), base);
    writeFileSync(join(repo, '.wavemill', 'logs', 'run-tests.log'), 'line 1\nline 2\n');
    assert.equal(trackedContentFingerprint(repo), base);

    // A tracked-file edit is progress.
    writeFileSync(join(repo, 'src.ts'), 'export const x = 2;\n');
    assert.notEqual(trackedContentFingerprint(repo), base);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── HOK-3381: native session stream as a progress source ───────────────────

// protects: a native coder deep inside a long run_tests reading as stalled while its own loop events keep flowing
test('deriveTaskProgress: native session events after launch are a progress source', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const inputs = emptyInputs({
    launchAt: '2026-11-01T11:00:00Z',
    nativeSessionLastEventAt: '2026-11-01T11:55:00Z',
  });
  const p = deriveTaskProgress(inputs, { now });
  const native = p.sources.find((s) => s.kind === 'native-session');
  assert.ok(native, 'expected a native-session source');
  assert.equal(p.lastProgressAt, '2026-11-01T11:55:00.000Z');
  assert.equal(p.stalled, false);
});

// protects: stale pre-launch transcript events (a relaunch over an old stream) counting as progress
test('deriveTaskProgress: native session events older than the launch anchor are ignored', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const inputs = emptyInputs({
    launchAt: '2026-11-01T11:00:00Z',
    nativeSessionLastEventAt: '2026-11-01T10:55:00Z',
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.sources.find((s) => s.kind === 'native-session'), undefined);
});

// protects: the gather side never wiring the transcript tail into the primitive
test('gatherTaskProgressInputs: reads the newest native session event from the transcript tail', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'hok3381-run-'));
  const prevRunDir = process.env.WAVEMILL_RUN_DIR;
  try {
    process.env.WAVEMILL_RUN_DIR = runDir;
    const dir = join(runDir, 'native-sessions');
    mkdirSync(dir, { recursive: true });
    const tsA = Date.UTC(2026, 10, 1, 11, 10, 0);
    const tsB = Date.UTC(2026, 10, 1, 11, 20, 0);
    writeFileSync(join(dir, 'coding-HOK-9999.jsonl'), [
      JSON.stringify({ seq: 0, sessionId: 's', timestamp: tsA, type: 'tool_started', toolCallId: 't1', toolName: 'run_tests', args: {} }),
      JSON.stringify({ seq: 1, sessionId: 's', timestamp: tsB, type: 'tool_result', toolCallId: 't1', toolName: 'run_tests', isError: false, content: '' }),
      '',
    ].join('\n'));
    const inputs = gatherTaskProgressInputs({ issue: 'HOK-9999', session: 'wavemill', phase: 'coding' });
    assert.equal(inputs.nativeSessionLastEventAt, new Date(tsB).toISOString());
  } finally {
    if (prevRunDir === undefined) delete process.env.WAVEMILL_RUN_DIR;
    else process.env.WAVEMILL_RUN_DIR = prevRunDir;
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ── HOK-3386: owned session transcript as agent evidence ───────────────────

const CODEX_ROLLOUT_WITH_TASK_COMPLETE = [
  JSON.stringify({ timestamp: '2026-11-02T09:40:00.000Z', type: 'session_meta', payload: { id: 'thread-1', cwd: '/tmp' } }),
  JSON.stringify({ timestamp: '2026-11-02T09:41:00.000Z', type: 'response_item', payload: { type: 'message' } }),
  JSON.stringify({ timestamp: '2026-11-02T09:42:00.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '…' } }),
  '',
].join('\n');

const CODEX_ROLLOUT_IN_FLIGHT = [
  JSON.stringify({ timestamp: '2026-11-02T09:40:00.000Z', type: 'session_meta', payload: { id: 'thread-2', cwd: '/tmp' } }),
  JSON.stringify({ timestamp: '2026-11-02T09:45:00.000Z', type: 'event_msg', payload: { type: 'item_started' } }),
  '',
].join('\n');

const CLAUDE_CODE_SESSION_WITH_STOP = [
  JSON.stringify({ type: 'queue-operation', timestamp: '2026-11-02T09:30:00.000Z', operation: 'start' }),
  JSON.stringify({ type: 'user', timestamp: '2026-11-02T09:30:01.000Z' }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-02T09:30:30.000Z' }),
  JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-11-02T09:30:31.000Z' }),
  '',
].join('\n');

const CLAUDE_CODE_SESSION_IN_FLIGHT = [
  JSON.stringify({ type: 'user', timestamp: '2026-11-02T09:30:01.000Z' }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-02T09:30:30.000Z' }),
  '',
].join('\n');

// protects: a Codex review agent that writes task_complete without producing a verdict
//           must raise agentIdle through the transcript so disposition can read settled.
test('(HOK-3386) readOwnedSessionTail: codex task_complete sets agentIdleAtMs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hok3386-codex-'));
  const path = join(tmp, 'rollout.jsonl');
  writeFileSync(path, CODEX_ROLLOUT_WITH_TASK_COMPLETE);
  const tail = readOwnedSessionTail(path, 'codex');
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(tail.agentIdleAtMs, Date.parse('2026-11-02T09:42:00.000Z'));
  assert.equal(tail.lastEventAtMs, Date.parse('2026-11-02T09:42:00.000Z'));
});

// protects: an in-flight codex rollout being misread as idle.
test('(HOK-3386) readOwnedSessionTail: codex in-flight events raise progress, not idle', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hok3386-codex-'));
  const path = join(tmp, 'rollout.jsonl');
  writeFileSync(path, CODEX_ROLLOUT_IN_FLIGHT);
  const tail = readOwnedSessionTail(path, 'codex');
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(tail.agentIdleAtMs, null);
  assert.equal(tail.lastEventAtMs, Date.parse('2026-11-02T09:45:00.000Z'));
});

// protects: a Claude Code stop_hook_summary system event being ignored as agent idle.
test('(HOK-3386) readOwnedSessionTail: claude-code stop_hook_summary sets agentIdleAtMs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hok3386-claude-'));
  const path = join(tmp, 'sess.jsonl');
  writeFileSync(path, CLAUDE_CODE_SESSION_WITH_STOP);
  const tail = readOwnedSessionTail(path, 'claude-code');
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(tail.agentIdleAtMs, Date.parse('2026-11-02T09:30:31.000Z'));
});

// protects: a running claude-code transcript being misread as idle.
test('(HOK-3386) readOwnedSessionTail: claude-code running transcript is progress, not idle', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hok3386-claude-'));
  const path = join(tmp, 'sess.jsonl');
  writeFileSync(path, CLAUDE_CODE_SESSION_IN_FLIGHT);
  const tail = readOwnedSessionTail(path, 'claude-code');
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(tail.agentIdleAtMs, null);
  assert.equal(tail.lastEventAtMs, Date.parse('2026-11-02T09:30:30.000Z'));
});

// protects: readOwnedStageLaunch picks the newest launch row for the stage only.
test('(HOK-3386) readOwnedStageLaunch: honours the stage selection (review not coding)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hok3386-ownership-'));
  try {
    appendOwnershipRow(dir, { sessionRef: 'sess-coding', harness: 'claude-code', kind: 'coding', model: 'm', launchedAt: '2026-11-02T08:00:00.000Z' });
    appendOwnershipRow(dir, { sessionRef: 'sess-review-old', harness: 'codex', kind: 'review', model: 'm', launchedAt: '2026-11-02T09:00:00.000Z' });
    appendOwnershipRow(dir, { sessionRef: 'sess-review-new', harness: 'codex', kind: 'review', model: 'm', launchedAt: '2026-11-02T09:39:13.000Z' });
    const launch = readOwnedStageLaunch(dir, 'review');
    assert.ok(launch);
    assert.equal(launch!.sessionRef, 'sess-review-new');
    assert.equal(launch!.harness, 'codex');
    assert.equal(launch!.stage ?? launch!.kind, 'review');
    // A conflicting coding stage is not selected when we ask for review.
    assert.notEqual(launch!.sessionRef, 'sess-coding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a transcript owned by another stage leaking into this stage's disposition.
test('(HOK-3386) readOwnedStageLaunch: returns null when no row names the stage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hok3386-ownership-'));
  try {
    appendOwnershipRow(dir, { sessionRef: 'sess-coding', harness: 'claude-code', kind: 'coding', model: 'm', launchedAt: '2026-11-02T08:00:00.000Z' });
    assert.equal(readOwnedStageLaunch(dir, 'review'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a native-harness row triggering an owned-session read (the native-session reader already covers it).
test('(HOK-3386) readOwnedStageLaunch: native rows are skipped (native-session reader owns them)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hok3386-ownership-'));
  try {
    appendOwnershipRow(dir, { sessionRef: 'native-sess', harness: 'native', kind: 'native-arm', stage: 'review', model: 'm', launchedAt: '2026-11-02T09:00:00.000Z' });
    assert.equal(readOwnedStageLaunch(dir, 'review'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: deriveTaskProgress missing the owned-session evidence folded into agentIdle.
test('(HOK-3386) deriveTaskProgress: owned-session events are progress and task_complete is idle', () => {
  const now = new Date('2026-11-02T11:00:00.000Z');
  const ownedIdleMs = Date.parse('2026-11-02T09:42:00.000Z');
  const inputs = emptyInputs({
    launchAt: '2026-11-02T09:00:00.000Z',
    ownedSession: { lastEventAtMs: ownedIdleMs, agentIdleAtMs: ownedIdleMs, harness: 'codex' },
  });
  const p = deriveTaskProgress(inputs, { now });
  const owned = p.sources.find((s) => s.kind === 'owned-session');
  assert.ok(owned, 'expected owned-session source');
  assert.equal(p.agentIdle, true);
  assert.equal(p.ownedSessionIdleAt, new Date(ownedIdleMs).toISOString());
  assert.equal(p.ownedSessionHarness, 'codex');
});

// protects: a pre-launch owned-session event being counted as this launch's progress.
test('(HOK-3386) deriveTaskProgress: owned-session events older than launch are ignored', () => {
  const now = new Date('2026-11-02T11:00:00.000Z');
  const ownedMs = Date.parse('2026-11-02T08:30:00.000Z'); // 30m before launch
  const inputs = emptyInputs({
    launchAt: '2026-11-02T09:00:00.000Z',
    ownedSession: { lastEventAtMs: ownedMs, agentIdleAtMs: ownedMs, harness: 'codex' },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.sources.find((s) => s.kind === 'owned-session'), undefined);
  // Pre-launch idle also must not make agentIdle true.
  assert.equal(p.agentIdle, false);
  assert.equal(p.ownedSessionIdleAt, null);
});

// protects: the gather side of the primitive never wiring stageForOwnedSession.
test('(HOK-3386) gatherTaskProgressInputs: ownedSession is null without stage context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hok3386-gather-'));
  try {
    appendOwnershipRow(dir, { sessionRef: 'sess-codex-1', harness: 'codex', kind: 'review', model: 'm', launchedAt: '2026-11-02T09:00:00.000Z' });
    const inputs = gatherTaskProgressInputs({ issue: 'HOK-TEST', session: 'wavemill', featureDir: dir, stageForOwnedSession: null });
    assert.equal(inputs.ownedSession, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: readOwnedStageTranscript treating a missing transcript as evidence.
test('(HOK-3386) readOwnedStageTranscript: a launch with no transcript file returns null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hok3386-notranscript-'));
  try {
    appendOwnershipRow(dir, {
      sessionRef: 'no-such-id',
      harness: 'claude-code',
      kind: 'review',
      model: 'm',
      launchedAt: '2026-11-02T09:00:00.000Z',
      cwd: '/nonexistent/path',
    });
    assert.equal(readOwnedStageTranscript(dir, 'review'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
