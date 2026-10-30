/**
 * HOK-3322 — the one Ready remediation disposition.
 *
 * Every row of tests/fixtures/ready-remediation-disposition-cases.json is
 * asserted here through the real task-progress primitive (hook file →
 * getTaskProgress → decide) and in tests/ready-remediation-disposition.test.sh
 * through the shell twin the monitor calls, so monitor and watchdog agree on
 * identical inputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideReadyRemediationDisposition,
  deriveRemediationOwner,
  readLatestRemediationLaunchAt,
  readyRemediationNeedsRecheck,
  type ReadyRemediationDispositionKind,
} from './ready-remediation-disposition.ts';
import { appendOwnershipRow, type SessionOwnershipRow } from './session-ownership.ts';
import { getTaskProgress } from './task-progress.ts';

interface FixtureCase {
  name: string;
  readyStatus: string | null;
  launchHead: string;
  currentHead: string;
  hook: { state: string; event: string; ageSeconds: number } | null;
  launchedAgeSeconds: number | null;
  expected: ReadyRemediationDispositionKind;
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ready-remediation-disposition-cases.json');
const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: FixtureCase[] };

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ready-disposition-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeAgentHook(file: string, hook: NonNullable<FixtureCase['hook']>, nowSeconds: number): void {
  const record = { state: hook.state, event: hook.event, agent: 'claude', timestamp: nowSeconds - hook.ageSeconds };
  writeFileSync(file, JSON.stringify({ ...record, writer: 'agent', agentRecord: record }));
}

for (const c of cases) {
  // protects: monitor and watchdog disagreeing on a fixture row (the HOK-3316 strand)
  test(`fixture: ${c.name}`, () => {
    withTempDir((stateDir) => {
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const hookFilePath = join(stateDir, 'agent.hook');
      if (c.hook) writeAgentHook(hookFilePath, c.hook, nowSeconds);
      if (c.launchedAgeSeconds !== null) {
        appendOwnershipRow(stateDir, {
          sessionRef: 'remediation-session',
          harness: 'claude-code',
          kind: 'ready-remediation',
          model: 'claude-opus-4-7',
          launchedAt: new Date(now.getTime() - c.launchedAgeSeconds * 1000),
          head: c.launchHead || null,
        });
      }

      const progress = getTaskProgress({ issue: 'HOK-0000', session: 'fixture', featureDir: stateDir, phase: 'ready', hookFilePath, now });
      const disposition = decideReadyRemediationDisposition({
        readyStatus: c.readyStatus,
        launchHead: c.launchHead,
        currentHead: c.currentHead,
        progress,
        launchedAt: readLatestRemediationLaunchAt(stateDir),
      });
      assert.equal(disposition.kind, c.expected, disposition.reason);
    });
  });
}

// protects: an idle REPL in a live pane being read as an active owner (HOK-3095 (a))
test('owner: an idle agent in a live pane is idle, not live', () => {
  assert.equal(deriveRemediationOwner({ agentIdle: true }, { ownerPaneLive: true }), 'idle');
});

// protects: a dead pane with a stale working hook holding the remediation forever
test('owner: a gone pane is exited even with a stale working record', () => {
  assert.equal(deriveRemediationOwner({ agentIdle: false, agentState: null }, { ownerPaneLive: false }), 'exited');
  assert.equal(
    decideReadyRemediationDisposition({ readyStatus: 'running', launchHead: 'a1', currentHead: 'a1', progress: null, ownerPaneLive: false }).kind,
    'settled',
  );
});

// protects: re-checking Ready over an agent that is waiting on its own background job (HOK-3137)
test('owner: live background work or a blocking prompt keeps an idle agent live', () => {
  assert.equal(deriveRemediationOwner({ agentIdle: true, agentBackgroundLive: true }), 'live');
  assert.equal(
    deriveRemediationOwner({ agentIdle: true, blockingPrompt: { id: 'trust-folder', agent: 'claude', detail: 'Trust this folder?' } }),
    'live',
  );
});

// protects: a live pane with no idle record losing its owner (the pre-HOK-3322 pane fact)
test('owner: a live pane without an idle record is live; no evidence is unknown', () => {
  assert.equal(deriveRemediationOwner(null, { ownerPaneLive: true }), 'live');
  assert.equal(deriveRemediationOwner(null), 'unknown');
  assert.equal(deriveRemediationOwner({ agentIdle: false }, { ownerPaneLive: null }), 'unknown');
});

// protects: a millisecond hook writer comparing as decades before the launch
test('owner: millisecond hook timestamps compare against the launch time', () => {
  const launchedAt = '2026-10-26T19:20:00.000Z';
  const idleMs = Date.parse('2026-10-26T19:25:00.000Z');
  const progress = { agentIdle: true, agentRecord: { state: 'idle' as const, event: 'Stop', agent: 'claude', timestamp: idleMs } };
  assert.equal(deriveRemediationOwner(progress, { launchedAt }), 'idle');
  const before = { ...progress, agentRecord: { ...progress.agentRecord, timestamp: Date.parse('2026-10-26T19:19:00.000Z') } };
  assert.equal(deriveRemediationOwner(before, { launchedAt }), 'unknown');
});

// protects: an idle record in the launch second being read as the previous owner's
test('owner: an idle record in the launch second counts as this owner settling', () => {
  const launchedAt = '2026-10-26T19:20:00.750Z';
  const progress = { agentIdle: true, agentRecord: { state: 'idle' as const, event: 'Stop', agent: 'claude', timestamp: Date.parse('2026-10-26T19:20:00Z') / 1000 } };
  assert.equal(deriveRemediationOwner(progress, { launchedAt }), 'idle');
});

// protects: settled/superseded not handing back to the controller Ready check
test('readyRemediationNeedsRecheck: only superseded and settled hand back', () => {
  assert.deepEqual(
    (['none', 'superseded', 'in-flight', 'settled'] as const).map((kind) => readyRemediationNeedsRecheck({ kind })),
    [false, true, false, true],
  );
});

// protects: a coding or review session's launch time masking the remediation launch
test('readLatestRemediationLaunchAt: latest ready-remediation or conflict-resolution row wins', () => {
  withTempDir((stateDir) => {
    const row = (kind: 'review' | 'ready-remediation' | 'conflict-resolution', at: string) => appendOwnershipRow(stateDir, {
      sessionRef: `${kind}-${at}`,
      harness: 'claude-code',
      kind,
      model: 'claude-opus-4-7',
      launchedAt: at,
    });
    assert.equal(readLatestRemediationLaunchAt(stateDir), null);
    row('ready-remediation', '2026-10-26T19:00:00.000Z');
    row('conflict-resolution', '2026-10-26T19:10:00.000Z');
    row('review', '2026-10-26T19:30:00.000Z');
    assert.equal(readLatestRemediationLaunchAt(stateDir), '2026-10-26T19:10:00.000Z');
  });
});

// protects: an unreadable ownership file crashing the disposition instead of degrading
test('readLatestRemediationLaunchAt: a reader error degrades to no recorded launch', () => {
  const throwing = (): SessionOwnershipRow[] => {
    throw new Error('EACCES');
  };
  assert.equal(readLatestRemediationLaunchAt('/nonexistent', throwing), null);
});
