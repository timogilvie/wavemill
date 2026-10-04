import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  TEND_READY_UNMERGED_WARN_MS,
  TEND_SKIP_LOG_REPEAT_MS,
  buildIntegrationUnhealthyFinding,
  buildReadyPrUnmergedFinding,
  buildSkipStallFinding,
  classifyTendLoopError,
  formatIdleStallWarning,
  formatIntegrationUnhealthyWarning,
  formatLaneStallWarning,
  formatSkipReasonLine,
  formatSkipStallWarning,
  runTendLoop,
  tendLoopBackoffMs,
  writeTendFailureState,
  writeTendHeartbeat,
  type MergeLaneObserverFinding,
  type TendLoopDeps,
} from './tend-loop.ts';
import type { StatusRenderer } from './tend-status-renderer.ts';
import type { MergeExecutionResult, TendDecision } from './tend-controller.ts';

function renderer(): StatusRenderer & { lines: string[]; finalized: boolean } {
  return {
    lines: [],
    finalized: false,
    write(line: string) { this.lines.push(line); },
    finalize() { this.finalized = true; },
  };
}

function idleDecision(): TendDecision {
  return { integrationHealth: { state: 'healthy' }, eligible: [], blocked: [], nextPR: null };
}

function deps(overrides: Partial<TendLoopDeps> = {}): Partial<TendLoopDeps> & { sleeps: number[]; heartbeats: unknown[]; gateCalls: unknown[] } {
  const sleeps: number[] = [];
  const heartbeats: unknown[] = [];
  const gateCalls: unknown[] = [];
  return {
    sleeps,
    heartbeats,
    gateCalls,
    selectNextCandidate: async () => idleDecision(),
    executeMerge: async () => ({ status: 'merged', prNumber: 1, haltLoop: false }),
    writePollHeartbeat: async (_repoDir, health) => { heartbeats.push({ kind: 'success', ...health }); },
    writeFailureState: async (_repoDir, health) => { heartbeats.push({ kind: 'failure', ...health }); },
    // HOK-3123: default the scheduler seam to a no-op stub so existing tests
    // that only exercise tend behavior are not surprised by a real file spawn.
    maybeRunToolChoiceGate: async (options) => {
      gateCalls.push(options);
      return { ran: false, skipped: 'fresh', nextLastCheckedMs: 0 };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (ms === 60_000) {
        throw new TypeError('stop');
      }
    },
    now: () => new Date('2026-08-18T12:00:00Z'),
    log: () => undefined,
    random: () => 0.5,
    ...overrides,
  };
}

describe('classifyTendLoopError', () => {
  it('distinguishes transient, terminal, and unknown errors', () => {
    assert.equal(classifyTendLoopError(new Error('HTTP 503 Service Unavailable')), 'transient');
    assert.equal(classifyTendLoopError(new Error('tend: integration branch not configured')), 'terminal');
    assert.equal(classifyTendLoopError(new TypeError('bad shape')), 'terminal');
    assert.equal(classifyTendLoopError(new Error('tend: gh pr list returned non-array JSON')), 'unknown');
  });
});

describe('tendLoopBackoffMs', () => {
  it('caps below the watchdog stale threshold', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((attempt) => tendLoopBackoffMs(attempt, { random: () => 0.5 })),
      [30_000, 60_000, 120_000, 120_000],
    );
  });
});

describe('runTendLoop', () => {
  it('calls reconcileScratchPrepState once at startup, before the first poll (HOK-3039)', async () => {
    let reconcileCalls = 0;
    let selectCalls = 0;
    const d = deps({
      reconcileScratchPrepState: async () => {
        reconcileCalls += 1;
        assert.equal(selectCalls, 0, 'reconcile must run before the first selectNextCandidate');
        return [];
      },
      selectNextCandidate: async () => {
        selectCalls += 1;
        throw new TypeError('stop after first poll');
      },
    });
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }), TypeError);
    assert.equal(reconcileCalls, 1);
  });

  it('continues even when reconcileScratchPrepState throws at startup (best-effort)', async () => {
    const d = deps({
      reconcileScratchPrepState: async () => {
        throw new Error('boom');
      },
      selectNextCandidate: async () => {
        throw new TypeError('stop');
      },
    });
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }), TypeError);
  });

  it('passes onPhaseProgress to executeMerge, which writes a merging-#N worktree-prep heartbeat', async () => {
    const r = renderer();
    const capturedHeartbeats: Array<{ detail?: string }> = [];
    let phaseUpdates: unknown[] = [];
    const d = deps({
      selectNextCandidate: async () => ({
        integrationHealth: { state: 'healthy' },
        eligible: [{ number: 42, title: 'PR', headBranch: 'task/pr', createdAt: '2026-08-18T00:00:00Z', dependencyDepth: 0 }],
        blocked: [],
        nextPR: 42,
      }),
      executeMerge: async (_candidate, opts) => {
        // Simulate a phase-progress emission during preparation.
        await opts.onPhaseProgress?.({ prNumber: 42, phase: 'fetch', at: '2026-08-18T12:00:00.000Z' });
        phaseUpdates.push({ prNumber: 42, phase: 'fetch' });
        return { status: 'merged', prNumber: 42, haltLoop: false };
      },
      writePollHeartbeat: async (_repoDir, health) => {
        capturedHeartbeats.push(health as { detail?: string });
      },
    });
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }), TypeError);
    assert.equal(phaseUpdates.length, 1);
    const merging = capturedHeartbeats.find((h) => typeof h.detail === 'string' && h.detail.includes('worktree-prep:fetch'));
    assert.ok(merging, `expected a worktree-prep heartbeat, got ${JSON.stringify(capturedHeartbeats)}`);
  });

  it('does not write a heartbeat before selectNextCandidate succeeds', async () => {
    const d = deps({
      selectNextCandidate: async () => {
        throw new TypeError('stop before poll completion');
      },
    });

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }),
      TypeError,
    );

    assert.equal(d.heartbeats.length, 1);
    assert.equal((d.heartbeats[0] as { kind: string }).kind, 'failure');
    assert.equal((d.heartbeats[0] as { status: string }).status, 'unhealthy');
    assert.equal((d.heartbeats[0] as { pollCompletedAt: string | null }).pollCompletedAt, null);
  });

  it('successful poll heartbeat includes iteration and poll timestamps', async () => {
    const r = renderer();
    const d = deps();

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }),
      TypeError,
    );

    const heartbeat = d.heartbeats.find((entry) => (entry as { kind?: string }).kind === 'success') as {
      iteration: number;
      pollStartedAt: string;
      pollCompletedAt: string;
      laneCondition: string;
      laneEvidenceId: string;
    };
    assert.equal(heartbeat.iteration, 1);
    assert.equal(heartbeat.pollStartedAt, '2026-08-18T12:00:00.000Z');
    assert.equal(heartbeat.pollCompletedAt, '2026-08-18T12:00:00.000Z');
    assert.equal(heartbeat.laneCondition, 'no-eligible');
    assert.match(heartbeat.laneEvidenceId, /^[0-9a-f]{12}$/);
    assert.match(r.lines[0], /^iter=1 poll_started=2026-08-18T12:00:00.000Z poll_completed=2026-08-18T12:00:00.000Z /);
  });

  it('fires maybeRunToolChoiceGate after each idle poll heartbeat (HOK-3123)', async () => {
    const d = deps();
    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }),
      TypeError,
    );
    assert.equal(d.gateCalls.length, 1);
    const call = d.gateCalls[0] as { repoDir: string };
    assert.equal(call.repoDir, '/tmp/repo');
  });

  it('a scheduler error never fails the tend loop (HOK-3123)', async () => {
    let logged = '';
    const d = deps({
      maybeRunToolChoiceGate: async () => {
        throw new Error('scheduler blew up');
      },
      log: (line) => {
        logged += line;
      },
    });
    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }),
      TypeError,
    );
    assert.match(logged, /tool-choice-gate: scheduler threw/);
  });

  it('continues after a transient selection error and clears failure heartbeat on success', async () => {
    const r = renderer();
    let calls = 0;
    const d = deps({
      selectNextCandidate: async () => {
        calls += 1;
        if (calls === 1) throw new Error('HTTP 503 Service Unavailable');
        return idleDecision();
      },
    });

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }),
      TypeError,
    );

    assert.deepEqual(d.sleeps, [30_000, 60_000]);
    assert.equal(r.lines.some((line) => line.includes('error=transient')), true);
    assert.equal((d.heartbeats[0] as { kind: string }).kind, 'failure');
    assert.equal((d.heartbeats[0] as { failureCount: number }).failureCount, 1);
    const successHeartbeat = d.heartbeats.find((entry) => (entry as { kind?: string }).kind === 'success') as {
      failureCount: number;
    };
    assert.equal(successHeartbeat.failureCount, 0);
  });

  it('rejects terminal errors immediately', async () => {
    const d = deps({
      selectNextCandidate: async () => {
        throw new TypeError('bad code');
      },
    });

    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }), TypeError);
    assert.deepEqual(d.sleeps, []);
  });

  it('exits after the unknown error budget is exhausted', async () => {
    const sleeps: number[] = [];
    const d = deps({
      selectNextCandidate: async () => {
        throw new Error('tend: gh pr list returned non-array JSON');
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d, maxConsecutiveUnknownFailures: 3 }),
      /non-array JSON/,
    );
    assert.deepEqual(sleeps, [30_000, 60_000]);
  });

  it('returns halted when executeMerge asks the loop to stop', async () => {
    const r = renderer();
    const d = deps({
      selectNextCandidate: async () => ({
        integrationHealth: { state: 'healthy' },
        eligible: [{ number: 42, title: 'PR', headBranch: 'task/pr', createdAt: '2026-08-18T00:00:00Z', dependencyDepth: 0 }],
        blocked: [],
        nextPR: 42,
      }),
      executeMerge: async () => ({ status: 'halted', prNumber: 42, haltLoop: true }),
    });

    const result = await runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d });
    assert.equal(result.reason, 'halted');
    assert.equal(r.finalized, true);
  });

  it('warns about a stalled merge lane after 3 consecutive lane-held skips', async () => {
    const r = renderer();
    let polls = 0;
    const d = deps({
      selectNextCandidate: async () => candidateDecision(1245),
      executeMerge: async () => laneHeldSkip(1245, [1243]),
      sleep: async () => {
        polls += 1;
        if (polls >= 5) {
          throw new TypeError('stop');
        }
      },
    });

    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }), TypeError);

    assert.deepEqual(
      r.lines.filter((line) => line.startsWith('warn=merge-lane-stalled')),
      [
        'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=3',
        'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=4',
        'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=5',
      ],
    );
    // The regular status line still appears every poll alongside the warning.
    assert.equal(r.lines.filter((line) => line.includes('action=skipped-#1245')).length, 5);
  });

  it('resets the lane-stall streak when a poll produces any other result', async () => {
    const r = renderer();
    const results: MergeExecutionResult[] = [
      laneHeldSkip(1245, [1243]),
      laneHeldSkip(1245, [1243]),
      { status: 'merged', prNumber: 1243, haltLoop: false },
      laneHeldSkip(1245, [1243]),
      laneHeldSkip(1245, [1243]),
    ];
    let polls = 0;
    const d = deps({
      selectNextCandidate: async () => candidateDecision(1245),
      executeMerge: async () => results[polls] ?? laneHeldSkip(1245, [1243]),
      sleep: async () => {
        polls += 1;
        if (polls >= results.length) {
          throw new TypeError('stop');
        }
      },
    });

    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }), TypeError);

    assert.deepEqual(
      r.lines.filter((line) => line.startsWith('warn=merge-lane-stalled')),
      [],
      'a non-lane-held result between skips must reset the streak below the warning threshold',
    );
  });
});

function candidateDecision(prNumber: number): TendDecision {
  return {
    integrationHealth: { state: 'healthy' },
    eligible: [{
      number: prNumber,
      title: 'PR',
      headBranch: 'task/pr',
      createdAt: '2026-08-18T00:00:00Z',
      dependencyDepth: 0,
    }],
    blocked: [],
    nextPR: prNumber,
  };
}

function laneHeldSkip(prNumber: number, heldBy: number[]): MergeExecutionResult {
  return { status: 'skipped', prNumber, phase: 'merge-lane-held', heldBy, haltLoop: false };
}

describe('formatLaneStallWarning', () => {
  it('formats holder, candidate, and streak', () => {
    assert.equal(
      formatLaneStallWarning({ holders: [1243], candidate: 1245, consecutive: 5 }),
      'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=5',
    );
  });

  it('joins multiple holders and tolerates an unknown holder list', () => {
    assert.equal(
      formatLaneStallWarning({ holders: [7, 9], candidate: 42, consecutive: 3 }),
      'warn=merge-lane-stalled holder=#7,#9 candidate=#42 consecutive=3',
    );
    assert.equal(
      formatLaneStallWarning({ holders: [], candidate: 42, consecutive: 3 }),
      'warn=merge-lane-stalled holder=unknown candidate=#42 consecutive=3',
    );
  });
});

describe('writeTendHeartbeat', () => {
  it('merges diagnostics into existing tend service state and clears them on success', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:00:00Z', {
        failureCount: 2,
        lastError: 'transient: HTTP 503',
        lastErrorAt: '2026-08-18T12:00:00Z',
        iteration: 7,
        pollStartedAt: '2026-08-18T11:59:59Z',
        pollCompletedAt: '2026-08-18T12:00:00Z',
      });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:01:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 8,
        pollStartedAt: '2026-08-18T12:00:59Z',
        pollCompletedAt: '2026-08-18T12:01:00Z',
        laneCondition: 'needs-user-hold',
        laneEvidenceId: 'abc123def456',
      });
      const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.equal(parsed.services.tend.status, 'healthy');
      assert.equal(parsed.services.tend.failureCount, 0);
      assert.equal(parsed.services.tend.lastError, null);
      assert.equal(parsed.services.tend.iteration, 8);
      assert.equal(parsed.services.tend.lastSuccessfulPollAt, '2026-08-18T12:01:00Z');
      assert.equal(parsed.services.tend.laneCondition, 'needs-user-hold');
      assert.equal(parsed.services.tend.laneEvidenceId, 'abc123def456');
      assert.equal(parsed.restartAttemptCount, undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('failure state preserves the last successful heartbeat', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:00:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 1,
        pollStartedAt: '2026-08-18T11:59:59Z',
        pollCompletedAt: '2026-08-18T12:00:00Z',
      });
      await writeTendFailureState(repoDir, '2026-08-18T12:02:00Z', {
        status: 'degraded',
        detail: 'backstage tend loop poll failed (transient)',
        failureCount: 1,
        lastError: 'transient: timeout',
        lastErrorAt: '2026-08-18T12:02:00Z',
        iteration: 2,
        pollStartedAt: '2026-08-18T12:01:59Z',
        pollCompletedAt: null,
      });
      const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.equal(parsed.services.tend.status, 'degraded');
      assert.equal(parsed.services.tend.heartbeatAt, '2026-08-18T12:00:00Z');
      assert.equal(parsed.services.tend.iteration, 2);
      assert.equal(parsed.services.tend.pollCompletedAt, null);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // HOK-3009: advisory drift on the integration tip is recorded in
  // .wavemill/backstage-health.json so operators can see the condition
  // even though it does not halt the lane. A subsequent poll with no
  // drift must clear the record.
  it('records integrationAdvisory in backstage-health.json and clears it when drift resolves', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      await writeTendHeartbeat(repoDir, '2026-09-14T08:36:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 1,
        pollStartedAt: '2026-09-14T08:35:59Z',
        pollCompletedAt: '2026-09-14T08:36:00Z',
        integrationAdvisory: [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
      });
      let parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.deepEqual(
        parsed.services.tend.integrationAdvisory,
        [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
      );

      // A later heartbeat with an empty array clears the stale record.
      await writeTendHeartbeat(repoDir, '2026-09-14T11:45:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 2,
        pollStartedAt: '2026-09-14T11:44:59Z',
        pollCompletedAt: '2026-09-14T11:45:00Z',
        integrationAdvisory: [],
      });
      parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.deepEqual(parsed.services.tend.integrationAdvisory, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('preserves the existing integrationAdvisory value when the field is undefined', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      await writeTendHeartbeat(repoDir, '2026-09-14T08:36:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 1,
        pollStartedAt: '2026-09-14T08:35:59Z',
        pollCompletedAt: '2026-09-14T08:36:00Z',
        integrationAdvisory: [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
      });
      // Failure-state writer never observed check runs; do not clobber the
      // previously recorded advisory.
      await writeTendFailureState(repoDir, '2026-09-14T08:37:00Z', {
        status: 'degraded',
        detail: 'backstage tend loop poll failed (transient)',
        failureCount: 1,
        lastError: 'transient: timeout',
        lastErrorAt: '2026-09-14T08:37:00Z',
        iteration: 2,
        pollStartedAt: '2026-09-14T08:36:59Z',
        pollCompletedAt: null,
      });
      const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.deepEqual(
        parsed.services.tend.integrationAdvisory,
        [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('merge-lane progress detection (HOK-2919)', () => {
  function blockedDecision(reason = 'challenge:pair-unresolved:branch-pair', labels = ['wavemill']): TendDecision {
    return {
      integrationHealth: { state: 'healthy' },
      eligible: [],
      blocked: [{ number: 1265, title: 'Blocked PR', headBranch: 'task/blocked', reason, labels }],
      nextPR: null,
    };
  }

  function integrationUnhealthyDecision(waitingPrs = [1265], reason = 'OpenRouter Alias Audit: failure'): TendDecision {
    return {
      integrationHealth: { state: 'unhealthy', reason },
      eligible: [],
      blocked: [],
      waitingReady: waitingPrs.map((number) => ({
        number,
        title: `Ready PR ${number}`,
        headBranch: `task/ready-${number}`,
        labels: ['wavemill', 'wm:ready'],
      })),
      nextPR: null,
    };
  }

  function loopHarness(options: {
    decision: (iteration: number) => TendDecision;
    iterations: number;
    minutesPerPoll?: number;
  }) {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    const findings: Array<{ repoDir: string; finding: MergeLaneObserverFinding }> = [];
    const heartbeats: Array<Record<string, unknown>> = [];
    const r = renderer();
    let iteration = 0;
    let clockMs = Date.parse('2026-08-28T00:00:00Z');
    const d: Partial<TendLoopDeps> = {
      selectNextCandidate: async () => {
        iteration += 1;
        return options.decision(iteration);
      },
      executeMerge: async () => ({ status: 'merged', prNumber: 1, haltLoop: false }),
      writePollHeartbeat: async (_repoDir, health) => {
        heartbeats.push({ ...health });
      },
      writeFailureState: async () => {},
      emitObserverFinding: (findingRepoDir, finding) => {
        findings.push({ repoDir: findingRepoDir, finding });
      },
      sleep: async () => {
        clockMs += (options.minutesPerPoll ?? 1) * 60_000;
        if (iteration >= options.iterations) {
          throw new TypeError('stop');
        }
      },
      now: () => new Date(clockMs),
      log: () => undefined,
      random: () => 0.5,
    };
    return {
      repoDir,
      findings,
      heartbeats,
      renderer: r,
      run: async () => {
        await assert.rejects(
          runTendLoop({ repoDir, renderer: r, deps: d, intervalMs: 60_000 }),
          TypeError,
        );
      },
      cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
    };
  }

  it('fires a high finding at 30 unhealthy integration polls with ready PRs and escalates at 120', async () => {
    const harness = loopHarness({ decision: () => integrationUnhealthyDecision([1395, 1398, 1399]), iterations: 121 });
    try {
      await harness.run();

      const integrationFindings = harness.findings.filter(
        (entry) => entry.finding.context?.markerKind === 'merge-lane-integration-unhealthy',
      );
      assert.equal(integrationFindings.length, 2);
      assert.equal(integrationFindings[0]?.finding.severity, 'high');
      assert.equal(integrationFindings[0]?.finding.context?.consecutivePolls, 30);
      assert.equal(integrationFindings[0]?.finding.context?.waitingPrs, '1395,1398,1399');
      assert.equal(integrationFindings[0]?.finding.context?.integrationHealthReason, 'OpenRouter Alias Audit: failure');
      assert.equal(integrationFindings[0]?.finding.context?.integrationCheck, 'OpenRouter Alias Audit');
      assert.match(integrationFindings[0]?.finding.body ?? '', /PR #1395 \(task\/ready-1395\)/);
      assert.equal(integrationFindings[1]?.finding.severity, 'urgent');
      assert.equal(integrationFindings[1]?.finding.context?.consecutivePolls, 120);

      assert.ok(harness.renderer.lines.some((line) => (
        line === 'warn=merge-lane-integration-unhealthy severity=high reason="OpenRouter Alias Audit: failure" waiting=#1395,#1398,#1399 consecutive=30'
      )));
      assert.ok(harness.renderer.lines.some((line) => /warn=merge-lane-integration-unhealthy severity=urgent/.test(line)));
      assert.ok(harness.renderer.lines.some((line) => /health=unhealthy reason="OpenRouter Alias Audit: failure"/.test(line)));
      assert.deepEqual(
        harness.findings.filter((entry) => entry.finding.context?.markerKind === 'merge-lane-idle-stall'),
        [],
      );

      const stalledHeartbeats = harness.heartbeats.filter((heartbeat) => heartbeat.progressState === 'stalled');
      assert.ok(stalledHeartbeats.length > 0);
      assert.equal(stalledHeartbeats[0]?.laneCondition, 'integration-unhealthy-stall');
      assert.equal(stalledHeartbeats[0]?.status, 'unhealthy');
      assert.match(String(stalledHeartbeats[0]?.detail), /OpenRouter Alias Audit: failure/);
      assert.match(String(stalledHeartbeats[0]?.laneEvidenceId), /^[0-9a-f]{12}$/);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps unhealthy integration quiet when no ready PRs are waiting', async () => {
    const harness = loopHarness({ decision: () => integrationUnhealthyDecision([]), iterations: 60 });
    try {
      await harness.run();
      assert.deepEqual(harness.findings, []);
      assert.equal(
        harness.renderer.lines.some((line) => line.startsWith('warn=merge-lane-integration-unhealthy')),
        false,
      );
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.progressState === 'idle'));
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.laneCondition === 'no-eligible'));
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.status === 'healthy'));
    } finally {
      harness.cleanup();
    }
  });

  it('resets the unhealthy integration streak when the reason or waiting queue changes', async () => {
    const harness = loopHarness({
      decision: (iteration) => integrationUnhealthyDecision([1265], `ci-${iteration % 2}: failure`),
      iterations: 80,
    });
    try {
      await harness.run();
      assert.deepEqual(
        harness.findings.filter((entry) => entry.finding.context?.markerKind === 'merge-lane-integration-unhealthy'),
        [],
      );
      assert.equal(
        harness.renderer.lines.some((line) => line.startsWith('warn=merge-lane-integration-unhealthy')),
        false,
      );
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.progressState !== 'stalled'));
    } finally {
      harness.cleanup();
    }
  });

  it('fires a high finding at 30 idle-blocked polls and escalates to urgent at 120 (REQ-F1/REQ-F3)', async () => {
    const harness = loopHarness({ decision: () => blockedDecision(), iterations: 121 });
    try {
      await harness.run();

      const stallFindings = harness.findings.filter(
        (entry) => entry.finding.context?.markerKind === 'merge-lane-idle-stall',
      );
      assert.equal(stallFindings.length, 2);
      assert.equal(stallFindings[0]?.finding.severity, 'high');
      assert.equal(stallFindings[0]?.finding.context?.consecutivePolls, 30);
      assert.equal(stallFindings[1]?.finding.severity, 'urgent');
      assert.equal(stallFindings[1]?.finding.context?.consecutivePolls, 120);

      // REQ-F2: the finding names the blocked PR, its labels, and the gate.
      assert.equal(stallFindings[0]?.finding.context?.firstBlockedPr, 1265);
      assert.equal(stallFindings[0]?.finding.context?.firstBlockedGate, 'challenge:pair-unresolved:branch-pair');
      assert.equal(stallFindings[0]?.finding.context?.firstBlockedLabels, 'wavemill');
      assert.match(stallFindings[0]?.finding.body ?? '', /PR #1265 \(task\/blocked\)/);

      // The status stream carries a greppable warning once past the threshold.
      assert.ok(harness.renderer.lines.some((line) => /warn=merge-lane-idle-stalled severity=high/.test(line)));
      assert.ok(harness.renderer.lines.some((line) => /warn=merge-lane-idle-stalled severity=urgent/.test(line)));

      // Heartbeats flip to stalled once the threshold is crossed.
      const stalledHeartbeats = harness.heartbeats.filter((heartbeat) => heartbeat.progressState === 'stalled');
      assert.ok(stalledHeartbeats.length > 0);
      assert.equal(harness.heartbeats[0]?.progressState, 'progressing');
      assert.equal(harness.heartbeats[0]?.laneCondition, 'needs-user-hold');
      assert.equal(stalledHeartbeats[0]?.laneCondition, 'idle-blocked-stall');
      assert.match(String(stalledHeartbeats[0]?.laneEvidenceId), /^[0-9a-f]{12}$/);
      assert.ok(typeof harness.heartbeats[0]?.lastProgressAt === 'string');
    } finally {
      harness.cleanup();
    }
  });

  it('produces no stall finding while the lane state keeps changing', async () => {
    const harness = loopHarness({
      decision: (iteration) => blockedDecision(`gate-variant-${iteration % 2}`),
      iterations: 80,
    });
    try {
      await harness.run();
      assert.deepEqual(
        harness.findings.filter((entry) => entry.finding.context?.markerKind === 'merge-lane-idle-stall'),
        [],
      );
      // Every poll changed the lane signature, so progress stays current and
      // the heartbeat never reports a stall.
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.progressState !== 'stalled'));
      const evidenceIds = new Set(harness.heartbeats.map((heartbeat) => heartbeat.laneEvidenceId));
      assert.equal(evidenceIds.size, 2);
    } finally {
      harness.cleanup();
    }
  });

  it('treats an empty lane as idle, never stalled', async () => {
    const harness = loopHarness({ decision: () => idleDecision(), iterations: 60 });
    try {
      await harness.run();
      assert.deepEqual(harness.findings, []);
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.progressState === 'idle'));
      assert.ok(harness.heartbeats.every((heartbeat) => heartbeat.laneCondition === 'no-eligible'));
      assert.equal(new Set(harness.heartbeats.map((heartbeat) => heartbeat.laneEvidenceId)).size, 1);
    } finally {
      harness.cleanup();
    }
  });

  it('flags a green wm:ready PR unmerged past the threshold regardless of lane health (REQ-F4)', async () => {
    const harness = loopHarness({
      decision: () => blockedDecision('challenge:pair-unresolved:branch-pair', ['wavemill', 'wm:ready']),
      iterations: 45,
      minutesPerPoll: 1,
    });
    try {
      await harness.run();
      const readyFindings = harness.findings.filter(
        (entry) => entry.finding.context?.markerKind === 'merge-lane-ready-unmerged',
      );
      assert.ok(readyFindings.length >= 1);
      assert.equal(readyFindings[0]?.finding.context?.prNumber, 1265);
      assert.equal(readyFindings[0]?.finding.context?.gate, 'challenge:pair-unresolved:branch-pair');
      assert.match(readyFindings[0]?.finding.title ?? '', /unmerged for \d+ minutes/);
      // Throttled: 45 minutes of waiting emits once, not once per poll.
      assert.equal(readyFindings.length, 1);
    } finally {
      harness.cleanup();
    }
  });

  it('does not flag a wm:ready PR whose gate already names failing checks', async () => {
    const harness = loopHarness({
      decision: () => blockedDecision('blocked-label:checks-failing:ci', ['wavemill', 'wm:ready']),
      iterations: 45,
    });
    try {
      await harness.run();
      assert.deepEqual(
        harness.findings.filter((entry) => entry.finding.context?.markerKind === 'merge-lane-ready-unmerged'),
        [],
      );
    } finally {
      harness.cleanup();
    }
  });
});

describe('merge-lane finding builders', () => {
  it('formatIdleStallWarning names each blocked PR with its gate', () => {
    const line = formatIdleStallWarning({
      blocked: [
        { number: 1265, title: 'a', headBranch: 'task/a', reason: 'challenge:pair-unresolved' },
        { number: 1267, title: 'b', headBranch: 'task/b', reason: 'blocked-label:behind-base' },
      ],
      consecutive: 31,
      severity: 'high',
    });
    assert.equal(
      line,
      'warn=merge-lane-idle-stalled severity=high blocked=#1265(challenge:pair-unresolved),#1267(blocked-label:behind-base) consecutive=31',
    );
  });

  it('formatIntegrationUnhealthyWarning quotes reason and names waiting PRs', () => {
    const line = formatIntegrationUnhealthyWarning({
      reason: 'OpenRouter Alias Audit:\nfailure',
      waiting: [
        { number: 1395, title: 'a', headBranch: 'task/a' },
        { number: 1398, title: 'b', headBranch: 'task/b' },
      ],
      consecutive: 30,
      severity: 'high',
    });
    assert.equal(
      line,
      'warn=merge-lane-integration-unhealthy severity=high reason="OpenRouter Alias Audit: failure" waiting=#1395,#1398 consecutive=30',
    );
  });

  it('buildIntegrationUnhealthyFinding names the check and waiters', () => {
    const finding = buildIntegrationUnhealthyFinding({
      decision: {
        integrationHealth: { state: 'unhealthy', reason: 'OpenRouter Alias Audit: failure' },
        eligible: [],
        blocked: [],
        waitingReady: [{ number: 1395, title: 'a', headBranch: 'task/a', labels: ['wm:ready'] }],
        nextPR: null,
      },
      consecutive: 30,
      severity: 'high',
      now: '2026-09-14T00:00:00Z',
    });
    assert.equal(finding.context?.integrationCheck, 'OpenRouter Alias Audit');
    assert.equal(finding.context?.waitingPrs, '1395');
  });

  it('buildReadyPrUnmergedFinding escalates to urgent past twice the threshold', () => {
    const candidate = { number: 9, title: 'x', headBranch: 'task/x', reason: 'gate', labels: ['wm:ready'] };
    assert.equal(
      buildReadyPrUnmergedFinding({ candidate, waitedMs: TEND_READY_UNMERGED_WARN_MS, now: '2026-08-28T00:00:00Z' }).severity,
      'high',
    );
    assert.equal(
      buildReadyPrUnmergedFinding({ candidate, waitedMs: 2 * TEND_READY_UNMERGED_WARN_MS, now: '2026-08-28T00:00:00Z' }).severity,
      'urgent',
    );
  });
});

describe('HOK-3108 skip-stall formatters', () => {
  it('formatSkipReasonLine names phase, reason, and consecutive count', () => {
    assert.equal(
      formatSkipReasonLine({ prNumber: 1519, headSha: 'abc1234deadbeef', phase: 'handoff', reason: 'no Ready handoff file', consecutive: 3 }),
      'note=tend-skip pr=#1519 head=abc1234 phase=handoff consecutive=3 reason="no Ready handoff file"',
    );
  });

  it('formatSkipReasonLine tolerates a missing head', () => {
    assert.equal(
      formatSkipReasonLine({ prNumber: 42, headSha: '', phase: 'merge-lane-held', reason: 'held-by=#3', consecutive: 5 }),
      'note=tend-skip pr=#42 head=unknown phase=merge-lane-held consecutive=5 reason="held-by=#3"',
    );
  });

  it('formatSkipStallWarning names PR, head, phase, and streak', () => {
    assert.equal(
      formatSkipStallWarning({ prNumber: 1519, headSha: 'abc1234deadbeef', phase: 'handoff', consecutive: 3 }),
      'warn=merge-lane-skip-stalled pr=#1519 head=abc1234 phase=handoff consecutive=3',
    );
  });

  it('buildSkipStallFinding includes a phase-specific recommendation and marker context', () => {
    const finding = buildSkipStallFinding({
      prNumber: 1519,
      headSha: 'abc1234deadbeef56789',
      phase: 'handoff',
      consecutive: 3,
      severity: 'high',
      now: '2026-09-29T12:14:00Z',
      failureExcerpt: 'Tend claim rejected (3/3) for head abc1234',
    });
    assert.equal(finding.subsystem, 'merge-lane');
    assert.match(finding.title, /PR #1519 skipped \(handoff\) for 3 consecutive polls/);
    assert.match(finding.recommendation ?? '', /Re-run Ready|push a new head/i);
    assert.equal(finding.context?.markerKind, 'merge-lane-skip-stall');
    assert.equal(finding.context?.prNumber, 1519);
    assert.equal(finding.context?.phase, 'handoff');
    assert.equal(finding.context?.consecutivePolls, 3);
    assert.match(String(finding.context?.markerPath), /merge-lane\/skip-stall\/#1519/);
  });
});

describe('HOK-3108 skip-stall loop integration', () => {
  function eligibleDecision(prNumber: number, headSha = ''): TendDecision {
    return {
      integrationHealth: { state: 'healthy' },
      eligible: [{
        number: prNumber,
        title: 'PR',
        headBranch: 'task/pr',
        createdAt: '2026-09-29T00:00:00Z',
        dependencyDepth: 0,
        ...(headSha ? { headSha } : {}),
      }],
      blocked: [],
      nextPR: prNumber,
    };
  }
  function handoffSkip(prNumber: number, excerpt: string): MergeExecutionResult {
    return {
      status: 'skipped',
      prNumber,
      phase: 'handoff',
      failureExcerpt: excerpt,
      haltLoop: false,
    };
  }

  it('logs the skip reason once, then warns and emits a finding + stalled heartbeat once the streak hits 3', async () => {
    const r = renderer();
    const findings: MergeLaneObserverFinding[] = [];
    const heartbeats: Array<Record<string, unknown>> = [];
    let poll = 0;
    let clockMs = Date.parse('2026-09-29T12:00:00Z');
    // Poll 5 returns a merged result (heartbeat 'progressing'), simulating
    // the block+recovery path from a follow-up eligible PR.
    const executeResults: MergeExecutionResult[] = [
      handoffSkip(1519, 'Tend claim rejected (1/3) for head abc1234: no Ready handoff file'),
      handoffSkip(1519, 'Tend claim rejected (2/3) for head abc1234: no Ready handoff file'),
      handoffSkip(1519, 'Tend claim rejected (3/3) for head abc1234: no Ready handoff file'),
      { status: 'blocked', prNumber: 1519, phase: 'handoff', failureExcerpt: 'wm:ready without a published Ready handoff for head head-a', haltLoop: false },
      { status: 'merged', prNumber: 1520, haltLoop: false },
    ];
    const d: Partial<TendLoopDeps> = {
      selectNextCandidate: async () => eligibleDecision(poll >= 4 ? 1520 : 1519, poll >= 4 ? '' : 'head-a'),
      executeMerge: async () => executeResults[poll] ?? { status: 'merged', prNumber: 1520, haltLoop: false },
      writePollHeartbeat: async (_repoDir, health) => { heartbeats.push({ ...health }); },
      writeFailureState: async () => {},
      emitObserverFinding: (_repoDir, finding) => { findings.push(finding); },
      sleep: async () => {
        poll += 1;
        clockMs += 60_000;
        if (poll >= executeResults.length) {
          throw new TypeError('stop');
        }
      },
      now: () => new Date(clockMs),
      log: () => undefined,
      random: () => 0.5,
    };
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d, intervalMs: 60_000 }), TypeError);

    // Skip-reason log: exactly one occurrence on poll 1; subsequent identical
    // signatures on polls 2 and 3 are suppressed by the rate-limit.
    const skipLines = r.lines.filter((line) => line.startsWith('note=tend-skip pr=#1519'));
    assert.equal(skipLines.length, 1, `expected exactly 1 skip-reason log, got ${skipLines.length}: ${skipLines.join(' | ')}`);
    assert.match(skipLines[0], /phase=handoff/);
    assert.match(skipLines[0], /no Ready handoff file/);

    // Stall warning fires on poll 3 (streak 3) and again on later skips.
    const stallWarns = r.lines.filter((line) => line.startsWith('warn=merge-lane-skip-stalled'));
    assert.ok(stallWarns.length >= 1, `expected a skip-stall warning, got: ${r.lines.join(' | ')}`);
    assert.match(stallWarns[0], /pr=#1519/);
    assert.match(stallWarns[0], /phase=handoff/);
    assert.match(stallWarns[0], /consecutive=3/);

    // Observer finding emitted exactly once at count===3 (high severity).
    const skipFindings = findings.filter((f) => f.context?.markerKind === 'merge-lane-skip-stall');
    assert.equal(skipFindings.length, 1);
    assert.equal(skipFindings[0].severity, 'high');
    assert.equal(skipFindings[0].context?.consecutivePolls, 3);

    // Heartbeat: at least one 'stalled' with laneCondition 'skip-stall'.
    const stalled = heartbeats.find((h) => h.progressState === 'stalled' && h.laneCondition === 'skip-stall');
    assert.ok(stalled, `expected a stalled skip-stall heartbeat, heartbeats=${JSON.stringify(heartbeats)}`);
    assert.match(String(stalled?.detail), /PR #1519 has been skipped/);

    // After the merge on poll 5, the heartbeat is 'progressing' (or 'idle')
    // and no stall warning fires for #1520.
    const post = heartbeats[heartbeats.length - 1];
    assert.notEqual(post?.laneCondition, 'skip-stall');
  });

  it('a new head at the same PR resets the streak and re-logs the reason', async () => {
    const r = renderer();
    let poll = 0;
    let clockMs = Date.parse('2026-09-29T12:00:00Z');
    const heads = ['head-a', 'head-b'];
    const d: Partial<TendLoopDeps> = {
      // Poll 1 uses head-a, poll 2 uses head-b (a fresh push at the same PR).
      selectNextCandidate: async () => eligibleDecision(1519, heads[poll] ?? 'head-b'),
      executeMerge: async () => handoffSkip(1519, `Tend claim rejected (1/3) for head ${heads[poll] ?? 'head-b'}`),
      writePollHeartbeat: async () => {},
      writeFailureState: async () => {},
      emitObserverFinding: () => {},
      sleep: async () => {
        poll += 1;
        clockMs += 60_000;
        if (poll >= 3) {
          throw new TypeError('stop');
        }
      },
      now: () => new Date(clockMs),
      log: () => undefined,
      random: () => 0.5,
    };
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d, intervalMs: 60_000 }), TypeError);

    // Two distinct (pr, head) keys → two skip-reason logs, streak never
    // crosses the threshold, no warning fires.
    const skipLines = r.lines.filter((line) => line.startsWith('note=tend-skip pr=#1519'));
    assert.equal(skipLines.length, 2, `expected 2 skip-reason logs (one per head), got: ${skipLines.join(' | ')}`);
    assert.equal(r.lines.filter((line) => line.startsWith('warn=merge-lane-skip-stalled')).length, 0);
  });

  it('a rate-limited skip re-logs after TEND_SKIP_LOG_REPEAT_MS elapses', async () => {
    const r = renderer();
    let poll = 0;
    let clockMs = Date.parse('2026-09-29T12:00:00Z');
    // Two polls: poll 1 (t=0), poll 2 (t = TEND_SKIP_LOG_REPEAT_MS + 1s).
    // Both produce the same (phase, reason) — the second should re-log.
    const d: Partial<TendLoopDeps> = {
      selectNextCandidate: async () => eligibleDecision(1519, 'head-a'),
      executeMerge: async () => handoffSkip(1519, 'Tend claim rejected (1/3) for head head-a: no Ready handoff file'),
      writePollHeartbeat: async () => {},
      writeFailureState: async () => {},
      emitObserverFinding: () => {},
      sleep: async () => {
        poll += 1;
        clockMs += poll === 1 ? TEND_SKIP_LOG_REPEAT_MS + 1000 : 60_000;
        if (poll >= 2) {
          throw new TypeError('stop');
        }
      },
      now: () => new Date(clockMs),
      log: () => undefined,
      random: () => 0.5,
    };
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d, intervalMs: 60_000 }), TypeError);

    const skipLines = r.lines.filter((line) => line.startsWith('note=tend-skip pr=#1519'));
    assert.equal(skipLines.length, 2, `expected 2 skip-reason logs after 10min elapse, got: ${skipLines.join(' | ')}`);
  });

  it('alternating PRs never cross the stall threshold', async () => {
    const r = renderer();
    let poll = 0;
    let clockMs = Date.parse('2026-09-29T12:00:00Z');
    const d: Partial<TendLoopDeps> = {
      selectNextCandidate: async () => eligibleDecision(poll % 2 === 0 ? 1519 : 1520, 'head-a'),
      executeMerge: async () => handoffSkip(poll % 2 === 0 ? 1519 : 1520, `Tend claim rejected (1/3) for head head-a`),
      writePollHeartbeat: async () => {},
      writeFailureState: async () => {},
      emitObserverFinding: () => {},
      sleep: async () => {
        poll += 1;
        clockMs += 60_000;
        if (poll >= 6) {
          throw new TypeError('stop');
        }
      },
      now: () => new Date(clockMs),
      log: () => undefined,
      random: () => 0.5,
    };
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d, intervalMs: 60_000 }), TypeError);

    assert.equal(r.lines.filter((line) => line.startsWith('warn=merge-lane-skip-stalled')).length, 0);
  });

  it('merge-lane-held keeps its legacy warn format and now also emits a skip-stall finding', async () => {
    const r = renderer();
    const findings: MergeLaneObserverFinding[] = [];
    let poll = 0;
    let clockMs = Date.parse('2026-09-29T12:00:00Z');
    const d: Partial<TendLoopDeps> = {
      selectNextCandidate: async () => eligibleDecision(1245),
      executeMerge: async () => ({ status: 'skipped', prNumber: 1245, phase: 'merge-lane-held', heldBy: [1243], haltLoop: false }),
      writePollHeartbeat: async () => {},
      writeFailureState: async () => {},
      emitObserverFinding: (_repoDir, finding) => { findings.push(finding); },
      sleep: async () => {
        poll += 1;
        clockMs += 60_000;
        if (poll >= 3) {
          throw new TypeError('stop');
        }
      },
      now: () => new Date(clockMs),
      log: () => undefined,
      random: () => 0.5,
    };
    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d, intervalMs: 60_000 }), TypeError);

    // Legacy warning still emitted for merge-lane-held.
    assert.ok(r.lines.some((line) => line.startsWith('warn=merge-lane-stalled')));
    // But NOT the new one — merge-lane-held keeps only the legacy format.
    assert.equal(r.lines.filter((line) => line.startsWith('warn=merge-lane-skip-stalled')).length, 0);
    // And now emits a skip-stall finding (previously merge-lane-held had none).
    assert.ok(findings.some((f) => f.context?.markerKind === 'merge-lane-skip-stall' && f.context?.phase === 'merge-lane-held'));
  });
});

