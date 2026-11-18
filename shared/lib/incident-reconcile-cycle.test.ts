/**
 * HOK-3231 — unit tests for the extracted incident cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileIncidentCycle } from './incident-reconcile-cycle.ts';
import { deriveAttentionItems } from './attention.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';
import { reclaimLegacyStateLock } from './state-lock.ts';

function makeSandbox(): { dir: string; incidentsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-cycle-test-'));
  const incidentsDir = join(dir, '.wavemill', 'incidents');
  mkdirSync(incidentsDir, { recursive: true });
  // allow-task-literal: synthetic sandbox state for a single-task fixture, not workflow-state read by production code
  writeFileSync(join(dir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks: {} }));
  return { dir, incidentsDir };
}

function draft(fingerprintSeed: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    taskId: 'HOK-FIXTURE-1',
    category: 'stale_orphaned_state',
    severity: 'medium',
    confidence: 'high',
    lifecycle: 'observed',
    rootCauseClass: 'cleanup_dirty_worktree',
    summary: `summary-${fingerprintSeed}`,
    operatorAction: 'none',
    evidence: [
      { type: 'workflow_state', source: `/tmp/${fingerprintSeed}`, timestamp: '2026-10-10T10:00:00Z', redactedData: `d-${fingerprintSeed}`, key: `k-${fingerprintSeed}` },
    ],
    metadata: {},
    ...overrides,
  });
}

test('fresh event + re-observation keeps the incident open', async () => {
  // protects: a re-polled identical event never counts as a new occurrence
  const { dir, incidentsDir } = makeSandbox();
  try {
    const store = new IncidentStore(incidentsDir);
    const first = await reconcileIncidentCycle({ store, candidates: [draft('a')], cycleComplete: true, repoDir: dir });
    assert.equal(first.fresh.length, 1);
    assert.equal(first.observed.length, 1);
    const second = await reconcileIncidentCycle({ store, candidates: [draft('a')], cycleComplete: true, repoDir: dir });
    // Same event-key: observed but not fresh.
    assert.equal(second.fresh.length, 0);
    assert.equal(second.observed.length, 1);
    const stored = await store.getIncidents();
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].lifecycle, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('absence sweep resolves after 5 empty cycles', async () => {
  // protects: condition going away actually resolves the record
  const { dir, incidentsDir } = makeSandbox();
  try {
    const store = new IncidentStore(incidentsDir);
    await reconcileIncidentCycle({ store, candidates: [draft('b')], cycleComplete: true, repoDir: dir });
    for (let i = 0; i < 5; i += 1) {
      await reconcileIncidentCycle({ store, candidates: [], cycleComplete: true, repoDir: dir });
    }
    const stored = await store.getIncidents();
    // getIncidents filters resolved out — after 5 missed cycles the record is gone.
    assert.equal(stored.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HOK-3403 recorded stale incident index lock is reclaimed and absence resolves', async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'incident-replay', 'real', 'state-lock', '2026-11-02-stale-incident-index-lock.json'), 'utf8')) as { rootCauseClass: string; absentCyclesToResolve: number };
  const { dir, incidentsDir } = makeSandbox();
  try {
    const store = new IncidentStore(incidentsDir);
    await reconcileIncidentCycle({ store, candidates: [draft('hok-3403', { rootCauseClass: fixture.rootCauseClass })], cycleComplete: true, repoDir: dir });
    const lockPath = join(incidentsDir, 'index.json.lock');
    writeFileSync(lockPath, ''); // recorded 0-byte pre-migration lock
    assert.equal(reclaimLegacyStateLock(lockPath), true, 'startup preflight clears recorded ownerless lock');
    const first = await reconcileIncidentCycle({ store, candidates: [], cycleComplete: true, repoDir: dir });
    assert.deepEqual(first.errors, [], 'next cycle must persist after reclaim');
    assert.equal((await store.getIncidents())[0].metadata.missedCycles, 1);
    for (let i = 1; i < fixture.absentCyclesToResolve; i += 1) {
      const result = await reconcileIncidentCycle({ store, candidates: [], cycleComplete: true, repoDir: dir });
      assert.deepEqual(result.errors, []);
    }
    assert.equal((await store.getIncidents()).length, 0, 'stale record auto-resolves');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('job-backed incident is not resolved by absence', async () => {
  // protects: a failed job that we stopped polling must not vanish silently
  const { dir, incidentsDir } = makeSandbox();
  try {
    const store = new IncidentStore(incidentsDir);
    const candidate = draft('c', {
      rootCauseClass: 'failed_background_job',
      category: 'product_defect',
      metadata: { jobId: 'eval-fake-1' },
      evidence: [
        { type: 'job_state', source: '/x', timestamp: '2026-10-10T10:00:00Z', redactedData: 'id=eval-fake-1 kind=eval status=failed reason=task_aborted', key: 'failed_background_job' },
      ],
    });
    await reconcileIncidentCycle({ store, candidates: [candidate], cycleComplete: true, repoDir: dir });
    for (let i = 0; i < 7; i += 1) {
      await reconcileIncidentCycle({ store, candidates: [], cycleComplete: true, repoDir: dir });
    }
    const stored = await store.getIncidents();
    assert.equal(stored.length, 1, 'job-backed records must not be resolved by absence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store error leaves the cycle incomplete', async () => {
  // protects: a persistence failure cannot turn an unseen record into an absence resolution
  const { dir, incidentsDir } = makeSandbox();
  try {
    // Shim store with a failing upsertDetailed.
    let recoveryReads = 0;
    let sweeps = 0;
    const store = {
      upsertDetailed: async () => { throw new Error('simulated-write-fail'); },
      getIncidents: async () => { recoveryReads += 1; return []; },
      autoResolve: async () => null,
      runResolutionSweep: async () => { sweeps += 1; return []; },
    } as unknown as IncidentStore;
    const result = await reconcileIncidentCycle({ store, candidates: [draft('d')], cycleComplete: true, repoDir: dir });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].kind, 'store');
    assert.match(result.errors[0].error.message, /simulated-write-fail/);
    assert.equal(recoveryReads, 0, 'partial cycles must not evaluate recovery');
    assert.equal(sweeps, 0, 'partial cycles must not accrue absence misses');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canResolveByAbsence gate blocks absence resolution', async () => {
  // protects: interactive-prompt gate still works through the extracted cycle
  const { dir, incidentsDir } = makeSandbox();
  try {
    const store = new IncidentStore(incidentsDir);
    await reconcileIncidentCycle({ store, candidates: [draft('e')], cycleComplete: true, repoDir: dir });
    for (let i = 0; i < 10; i += 1) {
      await reconcileIncidentCycle({ store, candidates: [], cycleComplete: true, repoDir: dir, canResolveByAbsence: () => false });
    }
    const stored = await store.getIncidents();
    assert.equal(stored.length, 1, 'gate must keep the record open despite absence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HOK-3509: three tasks sharing a cause across the window upsert one fleet incident', async () => {
  // Fault injection: three features with coding-result files recording the
  // same failure kind and endpoint inside the window. The cycle receives
  // them as failureSources and no per-task candidates; it must upsert one
  // fleet incident with taskId=null and metadata.fleet.causeKey.
  const { dir, incidentsDir } = makeSandbox();
  try {
    const now = Date.parse('2026-11-10T18:40:00Z');
    const sources: Array<{ taskId: string; featureDir: string }> = [];
    const replay = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'incident-replay', 'real', 'fleet_deepseek_stalls.json'), 'utf8')) as {
      failureFacts: Array<{ taskId: string; slug: string; at: string; attemptId: string }>;
    };
    const stalls = replay.failureFacts;
    assert.equal(stalls.length, 20, 'the recorded incident has five arms with four stalls each');
    const stallsByTask = Map.groupBy(stalls, (stall) => stall.taskId);
    assert.equal(stallsByTask.size, 5);
    for (const [taskId, taskStalls] of stallsByTask) {
      assert.ok(taskStalls);
      const [current, ...history] = taskStalls.slice().sort((left, right) => right.at.localeCompare(left.at));
      const featureDir = join(dir, 'features', current.slug);
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
        stage: 'coding',
        status: 'failed',
        startedAt: '2026-11-10T16:40:00Z',
        finishedAt: current.at,
        agent: 'claude',
        model: 'deepseek-v4-flash',
        intendedModel: 'deepseek-v4-flash',
        notes: 'Interrupted: coding agent settled without a result (agent-stalled)',
        artifacts: { exitEvidence: { reason: 'agent-stalled', harnessHold: { toolName: 'native_tool', toolCallId: `hold-${taskId}`, startedAt: current.at } } },
        runId: current.attemptId,
        history: history.map((stall) => ({
          stage: 'coding', status: 'failed', startedAt: '2026-11-10T16:40:00Z', finishedAt: stall.at,
          agent: 'claude', model: 'deepseek-v4-flash', intendedModel: 'deepseek-v4-flash',
          notes: 'Interrupted: coding agent settled without a result (agent-stalled)', runId: stall.attemptId,
          artifacts: { exitEvidence: { reason: 'agent-stalled', harnessHold: { toolName: 'native_tool', toolCallId: `hold-${taskId}-${stall.attemptId}`, startedAt: stall.at } } },
        })),
      }));
      sources.push({ taskId, featureDir });
    }
    const store = new IncidentStore(incidentsDir);
    const result = await reconcileIncidentCycle({
      store,
      candidates: [],
      cycleComplete: true,
      repoDir: dir,
      failureSources: sources,
      correlation: { windowMs: 10 * 60_000, threshold: 3, session: null, now: new Date(now) },
    });
    assert.ok(result.fleetIncidents && result.fleetIncidents.length === 1, 'exactly one correlation');
    const stored = await store.getIncidents();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].taskId, null);
    assert.equal(stored[0].rootCauseClass, 'fleet_shared_endpoint_failure');
    // The typed exit evidence proves the lockstep was a harness hold, so the
    // cause key and the downstream reliability rows agree on harness-fault.
    assert.equal(stored[0].metadata?.fleet?.causeKey, 'deepseek-v4-flash::harness-fault');
    assert.equal(stored[0].metadata?.fleet?.fleetFaultClass, 'harness-fault');
    assert.deepEqual(stored[0].metadata?.knownIssueIds, [...stallsByTask.keys()]);
    assert.equal(stored[0].metadata?.fleet?.attempts.length, 5, 'the current lockstep is five failure rows');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HOK-3509: GitHub rate-limit replay produces one dependency incident and one attention item', async () => {
  const { dir, incidentsDir } = makeSandbox();
  try {
    const now = new Date('2026-11-10T17:00:00Z');
    const replay = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'incident-replay', 'real', 'fleet_github_rate_limit.json'), 'utf8')) as {
      jobs: Array<{ id: string; taskId: string; finishedAt: string; error: string }>;
    };
    const sources = replay.jobs.map((job) => {
      const featureDir = join(dir, 'features', job.taskId);
      mkdirSync(featureDir, { recursive: true });
      return { taskId: job.taskId, featureDir };
    });
    const store = new IncidentStore(incidentsDir);
    await reconcileIncidentCycle({
      store,
      candidates: [],
      cycleComplete: true,
      repoDir: dir,
      jobs: { jobs: replay.jobs.map((job) => ({ ...job, kind: 'pr-ci-status', status: 'failed', source: 'fixture' })), source: 'fixture' },
      failureSources: sources,
      correlation: { windowMs: 10 * 60_000, threshold: 3, session: null, now },
    });
    const stored = await store.getIncidents();
    assert.equal(stored.length, 1, 'the replay must not create per-task incidents');
    assert.equal(stored[0].taskId, null);
    assert.equal(stored[0].rootCauseClass, 'remote_dependency_rate_limited');
    const attention = deriveAttentionItems({
      passStampMs: now.getTime(), staleAfterMs: now.getTime() + 60_000, nowMs: now.getTime(), tasks: [],
      incidents: [{ incident: stored[0], reconciliation: { outcome: 'confirmed_active', evidence: {} } }],
    });
    assert.deepEqual(attention.items.map((item) => item.kind), ['fleet-incident']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
