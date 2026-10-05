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
  selectAgentRecord,
  INTERACTIVE_PROMPT_SIGNATURES,
  normalizeInteractivePromptText,
  parsePsSnapshot,
  deriveAgentBackgroundWork,
  type HookFile,
  type TaskProgressInputs,
  type PaneProcess,
} from './task-progress.ts';

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
    transitionSources: [],
    terminal: { prState: null, prNumber: null, lifecycleOutcome: null, at: null },
    agentProcessLive: null,
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
    transitionSources: [{ kind: 'transition', at: '2026-09-28T15:15:00Z', detail: 'coding.startedAt' }],
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
    transitionSources: [
      { kind: 'transition', at: '2026-09-28T13:00:00Z', detail: 'task.updated' }, // 3h stale
    ],
  });
  void launchTs;
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, false);
  const kinds = p.sources.map((s) => s.kind);
  assert.ok(kinds.includes('hook'));
  assert.ok(kinds.includes('commit'));
  assert.ok(p.progressAgeMinutes !== null && p.progressAgeMinutes < 30);
});

test('(c) with only transition (task.updated) available, age falls back to it', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    transitionSources: [{ kind: 'transition', at: '2026-09-28T15:50:00Z', detail: 'task.updated' }],
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.progressAgeMinutes, 10);
  assert.equal(p.stalled, false);
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
    transitionSources: [{ kind: 'transition', at: launchIso, detail: 'coding.startedAt' }],
  });
  const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
  assert.equal(p.stalled, true);
  const kinds = p.sources.map((s) => s.kind);
  assert.deepEqual(kinds, ['transition']);
});

test('HOK-3069 counter: status mtime at launch+10m => not stalled at 31m', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    launchAt: '2026-09-28T15:29:00Z',
    statusFileMtimeAt: '2026-09-28T15:39:00Z',
    transitionSources: [{ kind: 'transition', at: '2026-09-28T15:29:00Z', detail: 'coding.startedAt' }],
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
      transitionSources: [{ kind: 'transition', at: '2026-09-28T14:00:00Z', detail: 'coding.startedAt' }],
    });
    const p = deriveTaskProgress(inputs, { now, stallMinutes: 30 });
    assert.equal(p.stalled, false, `expected not stalled for ${state}`);
  }
});

test('a terminal task is never stalled, even after threshold', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    terminal: { prState: 'MERGED', prNumber: 1, lifecycleOutcome: 'merged', at: '2026-09-28T00:00:00Z' },
    transitionSources: [{ kind: 'transition', at: '2026-09-28T00:00:00Z', detail: 'task.updated' }],
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

// ── Gather IO: history-file fallback + worktree filter ───────────────────────

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

// ── HOK-3137: deriveAgentBackgroundWork (D2 process-tree heuristic) ─────────

function proc(pid: number, ppid: number, etimeSeconds: number, command: string): PaneProcess {
  return { pid, ppid, etimeSeconds, command };
}

test('bg-work: idle REPL regression — shell -> claude only is NOT live (HOK-3101(a))', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
  assert.deepEqual(result.processes, []);
});

test('bg-work: shell -> claude -> sleep 30 with sufficient lag is live', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
    proc(3, 2, 20, 'sleep 30'),
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.deepEqual(result.processes, [{ pid: 3, command: 'sleep 30' }]);
});

test('bg-work: shell -> claude -> mcp-server with lag under threshold is NOT live (session-service exclusion)', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
    proc(3, 2, 95, 'mcp-server --stdio'), // started 5s after claude, under the 30s lag floor
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
});

test('bg-work: shell -> claude -> bash -c -> npm test is live (neutral shells transparent)', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'bash -c "npm test"'),
    proc(4, 3, 50, 'npm test -- --watch'),
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.deepEqual(result.processes.map((p) => p.pid), [4]);
});

test('bg-work: controller child under claude is NOT live (invariant 2 — never agent evidence)', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'npx tsx tools/foo.ts'),
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
});

test('bg-work: pane root is the agent itself (claude -> sleep, no wrapping shell) is live', () => {
  const processes = [
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'sleep 600'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.deepEqual(result.processes, [{ pid: 3, command: 'sleep 600' }]);
});

test('bg-work: multiple background tasks — still live, evidence capped', () => {
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 200, 'claude'),
    proc(3, 2, 50, 'sleep 600'),
    proc(4, 2, 40, 'npm test'),
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, true);
  assert.equal(result.processes.length, 2);
});

test('bg-work: a short-lived child that has already exited is simply absent from the snapshot — not live', () => {
  // The 1s child from REQ-F1's edge case is gone by the time ps runs; the
  // snapshot never contains it, so the subtree looks like the idle-REPL case.
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(2, 1, 100, 'claude'),
  ];
  const result = deriveAgentBackgroundWork(processes, 1, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
});

test('bg-work: an orphaned descendant outside the pane subtree does not protect a dead agent', () => {
  // The agent (pid 2) is gone; its former child (pid 3) reparented to pid 1
  // directly (simulating init/subreaper adoption) and is outside pane pid 2's
  // subtree entirely when probed with the agent's own pid as panePid.
  const processes = [
    proc(1, 0, 600, '-bash'),
    proc(3, 1, 50, 'sleep 600'),
  ];
  const result = deriveAgentBackgroundWork(processes, 2, { minChildLagSeconds: 30 });
  assert.equal(result.live, false);
  assert.deepEqual(result.processes, []);
});

// ── HOK-3137: deriveTaskProgress stall suppression ──────────────────────────

// NOTE: an idle hook record is never itself a progress `source` (it is the
// agent's settled state, not progress), so `progressAgeMinutes` would be
// `null` — and `overThreshold` false — without an independent stale
// transition source. Each fixture below supplies one (`task.updated` 60
// minutes ago) purely to make `overThreshold` true, isolating what we're
// actually testing: whether background-work suppression fires.
const STALE_TRANSITION_SOURCE = { kind: 'transition' as const, at: '2026-09-28T15:00:00Z', detail: 'task.updated' };

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
    transitionSources: [STALE_TRANSITION_SOURCE],
    backgroundWork: { live: true, processes: [{ pid: 999, command: 'sleep 600' }] },
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentIdle, true);
  assert.equal(p.agentBackgroundLive, true);
  assert.equal(p.backgroundProcesses.length, 1);
  assert.equal(p.stalled, false);
  // Invariant 1 pinned: background work never becomes progress — the only
  // source present is the caller-supplied transition, not the idle hook or
  // the background-work probe.
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].kind, 'transition');
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
    transitionSources: [STALE_TRANSITION_SOURCE],
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
    transitionSources: [STALE_TRANSITION_SOURCE],
  });
  const p = deriveTaskProgress(inputs, { now });
  assert.equal(p.agentBackgroundLive, null);
  assert.equal(p.stalled, true);
});

test('deriveTaskProgress: non-idle agent + live background work does NOT suppress stall (suppression is idle-scoped)', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const inputs = emptyInputs({
    hookFile: null,
    transitionSources: [{ kind: 'transition', at: '2026-09-28T15:00:00Z', detail: 'task.updated' }],
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
