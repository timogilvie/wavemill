/**
 * HOK-3322 / HOK-3386 — Ready remediation reads the one stage-agent disposition.
 *
 * Every row of tests/fixtures/ready-remediation-disposition-cases.json runs
 * through the shared `decideStageAgentDisposition` as the remediation
 * sub-stage Ready maps it to; tests/ready-remediation-disposition.test.sh
 * materialises the same rows for the monitor's shell wrapper, so the monitor
 * and the watchdog (which calls this module in process) agree on identical
 * inputs. The launch reader is exercised against real state dirs: the
 * bounded-retry bucket, the conflict marker and the ownership record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateDirRetry } from './bounded-retry.ts';
import {
  evaluateReadyRemediationDisposition,
  gatherReadyTaskProgress,
  readReadyRemediationLaunch,
  readyDispositionFromStage,
  type ReadyRemediationKind,
  type ReadyRemediationProgress,
} from './ready-remediation-disposition.ts';
import { appendOwnershipRow } from './session-ownership.ts';
import { decideStageAgentDisposition } from './stage-agent-disposition.ts';
import type { StageResult } from './stage-result.ts';
import type { HookState } from './task-progress.ts';
import { writeMarker } from './transient-marker.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';

interface FixtureCase {
  name: string;
  protects: string;
  shell: boolean;
  readyStatus: string;
  launch: { remediation: ReadyRemediationKind; head: 'current' | 'other'; launchedAgoSec: number | null } | null;
  agentRecord?: { state: HookState; event: string; agoSec: number } | null;
  progress?: Partial<ReadyRemediationProgress>;
  progressUnavailable?: boolean;
  expected: { kind: string; reason: string };
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ready-remediation-disposition-cases.json');
const { cases } = JSON.parse(readFileSync(fixturePath, 'utf-8')) as { cases: FixtureCase[] };

const CURRENT = 'c0ffee0000000000000000000000000000000001';
const OTHER = 'c0ffee0000000000000000000000000000000002';
const NOW_MS = Date.parse('2026-10-26T19:30:00.000Z');
const ago = (sec: number): number => NOW_MS - sec * 1000;

const STAGE = { ci: 'ready-remediation', conflict: 'conflict-resolution' } as const;

function progressFor(c: FixtureCase): ReadyRemediationProgress | null {
  if (c.progressUnavailable) return null;
  const agentRecord = c.agentRecord
    ? { state: c.agentRecord.state, event: c.agentRecord.event, agent: 'claude', timestamp: Math.floor(ago(c.agentRecord.agoSec) / 1000) }
    : null;
  return {
    agentRecord,
    agentState: agentRecord?.state ?? null,
    agentIdle: agentRecord?.state === 'idle',
    agentExited: null,
    agentBackgroundLive: null,
    blockingPrompt: null,
    stalled: false,
    ownedSessionIdleAt: null,
    terminal: false,
    ...c.progress,
  };
}

for (const c of cases) {
  // protects: each fixture row's `protects` scenario (monitor and watchdog share this table).
  test(`decision: ${c.name}`, () => {
    // A launch with no ownership row (launchedAgoSec null) is an unrecorded launch.
    const launch = c.launch && c.launch.launchedAgoSec !== null
      ? {
          sessionRef: 'fixture-session',
          harness: 'claude-code' as const,
          launchedAt: new Date(ago(c.launch.launchedAgoSec)).toISOString(),
          attemptId: 'fixture-attempt',
          kind: STAGE[c.launch.remediation],
        }
      : null;
    const launchHead = c.launch ? (c.launch.head === 'current' ? CURRENT : OTHER) : null;
    const stageDisposition = decideStageAgentDisposition({
      stage: c.launch ? STAGE[c.launch.remediation] : 'ready-remediation',
      stageStatus: c.readyStatus,
      hasCompletionArtifact: false,
      hasResultVerdict: c.readyStatus !== 'running',
      launch,
      currentHead: CURRENT,
      launchHead,
      progress: progressFor(c),
    });
    const disposition = c.launch && launchHead
      ? readyDispositionFromStage(stageDisposition, { remediation: c.launch.remediation, stage: STAGE[c.launch.remediation], launchHead }, CURRENT)
      : stageDisposition;
    assert.deepEqual({ kind: disposition.kind, reason: disposition.reason }, c.expected, c.protects);
  });
}

// ── launch reader against real state ──────────────────────────────────────────

function stateDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'ready-remediation-disposition-'));
}

function readyResult(status: StageResult['status'], startedAt: string, mergeConflict?: string): Pick<StageResult, 'status' | 'startedAt' | 'artifacts'> {
  return {
    status,
    startedAt,
    artifacts: { type: 'ready', verdict: 'fail', ...(mergeConflict ? { mergeConflict } : {}) },
  };
}

const noProgress = (): ReadyRemediationProgress | null => null;

// protects: the launch head read from the JSON mirror (which never resets) instead of the bucket.
test('launch reader: CI remediation head comes from the ready-remediation bucket', () => {
  const dir = stateDir();
  try {
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, CURRENT);
    const launch = readReadyRemediationLaunch(dir, readyResult('running', '2026-10-26T19:00:00.000Z'));
    assert.deepEqual(launch, { remediation: 'ci', stage: 'ready-remediation', launchHead: CURRENT });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a running Ready with no recorded launch being held as remediation.
test('launch reader: nothing launched, or Ready not running, is no launch', () => {
  const dir = stateDir();
  try {
    assert.equal(readReadyRemediationLaunch(dir, readyResult('running', '2026-10-26T19:00:00.000Z')), null);
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, CURRENT);
    assert.equal(readReadyRemediationLaunch(dir, readyResult('completed', '2026-10-26T19:00:00.000Z')), null);
    assert.equal(readReadyRemediationLaunch(dir, null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: HOK-3273 — the conflict resolver's head read from anything but its condition-keyed marker.
test('launch reader: conflict resolver head comes from the condition-keyed marker', () => {
  const dir = stateDir();
  try {
    // A CI bucket head from an earlier remediation must not be read for a conflict launch.
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, OTHER);
    const result = readyResult('running', '2026-10-26T19:00:00.000Z', 'CONFLICTED');
    assert.equal(readReadyRemediationLaunch(dir, result), null, 'expired marker → no conflict launch');
    writeMarker({ path: join(dir, '.conflict-remediation.json'), kind: 'conflict-remediation' }, {
      headSha: CURRENT,
      detail: { head: CURRENT, base: 'main', launchHead: CURRENT, prNumber: 1720 },
    });
    assert.deepEqual(readReadyRemediationLaunch(dir, result), {
      remediation: 'conflict',
      stage: 'conflict-resolution',
      launchHead: CURRENT,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a pending rewrite of .ready-result.json restamping startedAt after the
// agent settled, which would make the settled agent look pre-launch and re-latch the hold.
test('evaluate: the ownership launch row beats a later ready startedAt', () => {
  const dir = stateDir();
  try {
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, CURRENT);
    appendOwnershipRow(dir, { sessionRef: 'review-1', harness: 'claude-code', kind: 'review', model: 'm', launchedAt: '2026-10-26T18:00:00.000Z' });
    appendOwnershipRow(dir, { sessionRef: 'fix-1', harness: 'claude-code', kind: 'ready-remediation', model: 'm', launchedAt: '2026-10-26T19:00:00.000Z' });
    appendOwnershipRow(dir, { sessionRef: 'fix-2', harness: 'claude-code', kind: 'ready-remediation', model: 'm', launchedAt: '2026-10-26T19:10:00.000Z' });
    const pendingRewrite = readyResult('running', '2026-10-26T19:29:00.000Z');
    const disposition = evaluateReadyRemediationDisposition({
      stateDir: dir,
      readyResult: pendingRewrite,
      currentHead: CURRENT,
      getProgress: () => ({
        agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: Math.floor(Date.parse('2026-10-26T19:20:00.000Z') / 1000) },
        agentState: 'idle',
        agentIdle: true,
        agentExited: null,
        agentBackgroundLive: null,
        blockingPrompt: null,
        stalled: false,
        ownedSessionIdleAt: null,
        terminal: false,
      }),
    });
    assert.equal(disposition.launchedAt, '2026-10-26T19:10:00.000Z');
    assert.equal(disposition.remediation, 'ci');
    assert.deepEqual([disposition.kind, disposition.reason], ['settled', 'agent-idle-after-launch']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: the monitor hot pass probing the pane for tasks whose outcome needs no liveness.
test('evaluate: progress is gathered only for a same-head running launch', () => {
  const dir = stateDir();
  let probes = 0;
  const getProgress = (): ReadyRemediationProgress | null => {
    probes += 1;
    return null;
  };
  try {
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, OTHER);
    appendOwnershipRow(dir, { sessionRef: 'fix-1', harness: 'claude-code', kind: 'ready-remediation', model: 'm', launchedAt: '2026-10-26T19:00:00.000Z' });
    const running = readyResult('running', '2026-10-26T19:00:00.000Z');
    assert.equal(evaluateReadyRemediationDisposition({ stateDir: dir, readyResult: running, currentHead: CURRENT, getProgress }).kind, 'advanced');
    assert.equal(evaluateReadyRemediationDisposition({ stateDir: dir, readyResult: null, currentHead: CURRENT, getProgress }).kind, 'inactive');
    assert.equal(probes, 0);
    assert.deepEqual(
      (({ kind, reason }) => ({ kind, reason }))(evaluateReadyRemediationDisposition({ stateDir: dir, readyResult: running, currentHead: OTHER, getProgress })),
      { kind: 'in-flight', reason: 'progress-unavailable' },
    );
    assert.equal(probes, 1);
    const throwing = evaluateReadyRemediationDisposition({
      stateDir: dir,
      readyResult: running,
      currentHead: OTHER,
      getProgress: () => {
        throw new Error('tmux gone');
      },
    });
    assert.deepEqual([throwing.kind, throwing.reason], ['in-flight', 'progress-unavailable']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a running Ready with no recorded launch, or no running Ready, reporting the wrong inactive reason.
test('evaluate: inactive reasons distinguish not-running from no-launch', () => {
  const dir = stateDir();
  try {
    const running = readyResult('running', '2026-10-26T19:00:00.000Z');
    assert.deepEqual(
      (({ kind, reason }) => ({ kind, reason }))(evaluateReadyRemediationDisposition({ stateDir: dir, readyResult: running, currentHead: CURRENT, getProgress: noProgress })),
      { kind: 'inactive', reason: 'no-launch' },
    );
    assert.deepEqual(
      (({ kind, reason }) => ({ kind, reason }))(evaluateReadyRemediationDisposition({ stateDir: dir, readyResult: readyResult('completed', '2026-10-26T19:00:00.000Z'), currentHead: CURRENT, getProgress: noProgress })),
      { kind: 'inactive', reason: 'not-running' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── HOK-3415 incident replay ──────────────────────────────────────────────────

// protects: HOK-3415 (2026-11-05) — a Ready remediation agent that finished before a
// host reboot cleared /tmp (its hook file) was held `in-flight / awaiting-agent-evidence`
// forever. Its own Claude Code transcript still recorded the stop; Ready must read it.
test('replay HOK-3415: owned transcript stop settles remediation with no hook file', () => {
  const worktree = mkdtempSync(join(os.tmpdir(), 'hok3415-wt-'));
  try {
    const slug = 'contribution-4-5-replay';
    const dir = join(worktree, 'features', slug);
    mkdirSync(dir, { recursive: true });
    const launchHead = 'efe006ae41889660977471ae394d21248c7c7621';
    const sessionRef = '404ef1f4-651e-4ba3-aea1-423814c6e809';
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, launchHead);
    appendOwnershipRow(dir, {
      sessionRef,
      harness: 'claude-code',
      kind: 'ready-remediation',
      model: 'claude-opus-4-7',
      launchedAt: '2026-11-04T22:33:08.000Z',
      cwd: worktree,
    });
    // The agent's own transcript, in a projects dir resolveProjectsDirs searches
    // under the worktree (so the test never touches the real ~/.claude).
    const projects = join(worktree, '.wavemill', 'runs', 'r1', 'providers', 'deepseek', 'home', '.claude', 'projects', encodeProjectDir(worktree));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${sessionRef}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: '2026-11-04T22:33:10.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T22:35:40.000Z' }),
      JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-11-04T22:35:43.811Z' }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-11-04T22:35:43.816Z' }),
      '',
    ].join('\n'));
    // The monitor kept rewriting the running result after the agent stopped.
    const running: StageResult = {
      stage: 'ready',
      status: 'running',
      startedAt: '2026-11-04T22:27:00.768Z',
      finishedAt: null,
      artifacts: { type: 'ready', verdict: 'fail', prNumber: 1797, lastCiObservedAt: '2026-11-05T14:07:28Z' },
    } as StageResult;
    writeFileSync(join(dir, '.ready-result.json'), JSON.stringify(running));

    const disposition = evaluateReadyRemediationDisposition({
      stateDir: dir,
      readyResult: running,
      currentHead: launchHead,
      getProgress: () => gatherReadyTaskProgress({
        issue: 'HOK-3415',
        // A session no hook file exists for: the reboot cleared /tmp.
        session: `hok3415-replay-${process.pid}`,
        worktree,
        stateDir: dir,
        readyResult: running,
        now: new Date('2026-11-05T14:07:30.000Z'),
      }),
    });
    assert.equal(disposition.launchedAt, '2026-11-04T22:33:08.000Z');
    assert.deepEqual([disposition.kind, disposition.reason], ['settled', 'agent-idle-after-launch']);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// protects: the shell agreement test silently covering no rows of a kind.
test('fixture: at least one materialisable row per disposition kind', () => {
  const kinds = new Set(cases.filter((c) => c.shell).map((c) => c.expected.kind));
  assert.deepEqual([...kinds].sort(), ['advanced', 'in-flight', 'inactive', 'settled']);
});

// ── HOK-3422: controller writes never reset the stall clock ───────────────

// protects: HOK-3422 — the direct cause the HOK-3415 incident exposed. Before
// the fix, a dead Ready remediation agent (no hook, no transcript events after
// launch) read as `in-flight / awaiting-agent-evidence` indefinitely because
// the per-tick `.ready-result.json` mtime rewrite pushed `lastProgressAt`
// forward. Post-fix: the stall clock anchors to the ownership `launchedAt` and
// fires once the threshold elapses, so the disposition settles with
// `agent-stalled` and the controller re-runs its own Ready check.
test('HOK-3422: per-tick ready-result rewrite without agent evidence settles as agent-stalled', () => {
  const worktree = mkdtempSync(join(os.tmpdir(), 'hok3422-wt-'));
  try {
    const slug = 'hok3422-replay';
    const dir = join(worktree, 'features', slug);
    mkdirSync(dir, { recursive: true });
    const launchHead = 'c0ffee0000000000000000000000000000003422';
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, launchHead);
    // Launch recorded 45 minutes ago. No hook file, no agent transcript.
    appendOwnershipRow(dir, {
      sessionRef: 'remediation-dead-agent',
      harness: 'claude-code',
      kind: 'ready-remediation',
      model: 'claude-opus-4-7',
      launchedAt: '2026-11-05T13:00:00.000Z',
      cwd: worktree,
    });
    // The controller's per-tick CI refresh keeps rewriting lastCiObservedAt
    // and the file's mtime. Pre-fix: these advanced lastProgressAt.
    const running: StageResult = {
      stage: 'ready',
      status: 'running',
      startedAt: '2026-11-05T13:00:00.000Z',
      finishedAt: null,
      artifacts: { type: 'ready', verdict: 'fail', lastCiObservedAt: '2026-11-05T13:44:30.000Z' },
    } as StageResult;
    writeFileSync(join(dir, '.ready-result.json'), JSON.stringify(running));

    const disposition = evaluateReadyRemediationDisposition({
      stateDir: dir,
      readyResult: running,
      currentHead: launchHead,
      getProgress: () => gatherReadyTaskProgress({
        issue: 'HOK-3422',
        session: `hok3422-replay-${process.pid}`,
        worktree,
        stateDir: dir,
        readyResult: running,
        now: new Date('2026-11-05T13:45:00.000Z'),
      }),
    });
    assert.equal(disposition.launchedAt, '2026-11-05T13:00:00.000Z');
    assert.deepEqual([disposition.kind, disposition.reason], ['settled', 'agent-stalled']);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// protects: a healthy controller-owned Ready CI wait (no remediation launched)
// being reported stalled by the new launch-anchored stall clock. The gatherer
// must NOT synthesize a launch anchor from the ready-result startedAt when no
// ownership row exists.
test('HOK-3422: Ready CI wait with no remediation launched is never stalled', () => {
  const worktree = mkdtempSync(join(os.tmpdir(), 'hok3422-ciwait-'));
  try {
    const slug = 'hok3422-ciwait';
    const dir = join(worktree, 'features', slug);
    mkdirSync(dir, { recursive: true });
    const running: StageResult = {
      stage: 'ready',
      status: 'running',
      startedAt: '2026-11-05T12:00:00.000Z',
      finishedAt: null,
      artifacts: { type: 'ready', verdict: 'fail', lastCiObservedAt: '2026-11-05T13:44:30.000Z' },
    } as StageResult;
    writeFileSync(join(dir, '.ready-result.json'), JSON.stringify(running));

    const progress = gatherReadyTaskProgress({
      issue: 'HOK-3422-CI',
      session: `hok3422-ciwait-${process.pid}`,
      worktree,
      stateDir: dir,
      readyResult: running,
      now: new Date('2026-11-05T13:45:00.000Z'),
    });
    assert.equal(progress.stalled, false,
      'with no ownership launch row, the controller-owned CI wait has no stall-clock anchor');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});
