/**
 * HOK-3322 — the one Ready remediation disposition.
 *
 * Every row of tests/fixtures/ready-remediation-disposition-cases.json runs
 * through the pure decision here; tests/ready-remediation-disposition.test.sh
 * materialises the same rows for the monitor's shell wrapper, so the monitor
 * and the watchdog (which calls this module in process) agree on identical
 * inputs. The launch reader is exercised against real state dirs: the
 * bounded-retry bucket, the conflict marker and the ownership record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateDirRetry } from './bounded-retry.ts';
import {
  decideReadyRemediationDisposition,
  evaluateReadyRemediationDisposition,
  readReadyRemediationLaunch,
  type ReadyRemediationKind,
  type ReadyRemediationProgress,
} from './ready-remediation-disposition.ts';
import { appendOwnershipRow } from './session-ownership.ts';
import type { StageResult } from './stage-result.ts';
import type { HookState } from './task-progress.ts';
import { writeMarker } from './transient-marker.ts';

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

function progressFor(c: FixtureCase): ReadyRemediationProgress | null {
  if (c.progressUnavailable) return null;
  return {
    agentRecord: c.agentRecord
      ? { state: c.agentRecord.state, event: c.agentRecord.event, agent: 'claude', timestamp: Math.floor(ago(c.agentRecord.agoSec) / 1000) }
      : null,
    agentProcessLive: null,
    agentBackgroundLive: null,
    blockingPrompt: null,
    stalled: false,
    ...c.progress,
  };
}

for (const c of cases) {
  // protects: each fixture row's `protects` scenario (monitor and watchdog share this table).
  test(`decision: ${c.name}`, () => {
    const disposition = decideReadyRemediationDisposition({
      readyStatus: c.readyStatus,
      launch: c.launch && {
        remediation: c.launch.remediation,
        launchHead: c.launch.head === 'current' ? CURRENT : OTHER,
        launchedAt: c.launch.launchedAgoSec === null ? null : new Date(ago(c.launch.launchedAgoSec)).toISOString(),
      },
      currentHead: CURRENT,
      progress: progressFor(c),
    });
    assert.deepEqual({ kind: disposition.kind, reason: disposition.reason }, c.expected, c.protects);
    assert.equal(disposition.remediation, c.launch?.remediation ?? null);
  });
}

// protects: a failed HEAD probe must never masquerade as evidence that a
// remediation launch advanced to another commit.
test('decision: unavailable current head holds fail-safe', () => {
  const disposition = decideReadyRemediationDisposition({
    readyStatus: 'running',
    launch: { remediation: 'ci', launchHead: CURRENT, launchedAt: '2026-10-26T19:00:00.000Z' },
    currentHead: null,
    progress: null,
  });
  assert.deepEqual([disposition.kind, disposition.reason], ['in-flight', 'current-head-unavailable']);
});

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

// protects: the launch head read from the JSON mirror (which never resets) instead of the bucket.
test('launch reader: CI remediation head comes from the ready-remediation bucket', () => {
  const dir = stateDir();
  try {
    createStateDirRetry('ready-remediation', { maxAttempts: 3 }).increment(dir, CURRENT);
    const launch = readReadyRemediationLaunch(dir, readyResult('running', '2026-10-26T19:00:00.000Z'));
    assert.deepEqual(launch, { remediation: 'ci', launchHead: CURRENT, launchedAt: '2026-10-26T19:00:00.000Z' });
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
      launchHead: CURRENT,
      launchedAt: '2026-10-26T19:00:00.000Z',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a pending rewrite of .ready-result.json restamping startedAt after the
// agent settled, which would make the settled agent look pre-launch and re-latch the hold.
test('launch reader: the ownership launch row beats a later ready startedAt', () => {
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
        agentProcessLive: null,
        agentBackgroundLive: null,
        blockingPrompt: null,
        stalled: false,
      }),
    });
    assert.equal(disposition.launchedAt, '2026-10-26T19:10:00.000Z');
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

// protects: the shell agreement test silently covering no rows of a kind.
test('fixture: at least one materialisable row per disposition kind', () => {
  const kinds = new Set(cases.filter((c) => c.shell).map((c) => c.expected.kind));
  assert.deepEqual([...kinds].sort(), ['advanced', 'in-flight', 'inactive', 'settled']);
});
