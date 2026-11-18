/**
 * HOK-3231 — unit tests for the extracted incident cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileIncidentCycle } from './incident-reconcile-cycle.ts';
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
    const now = Date.parse('2026-11-10T17:00:00Z');
    const sources: Array<{ taskId: string; featureDir: string }> = [];
    const stalls = [
      { taskId: 'HOK-3469', slug: 'f1', at: '2026-11-10T16:52:57Z' },
      { taskId: 'HOK-3447_c', slug: 'f2', at: '2026-11-10T16:54:02Z' },
      { taskId: 'HOK-3470', slug: 'f3', at: '2026-11-10T16:55:17Z' },
    ];
    for (const t of stalls) {
      const featureDir = join(dir, 'features', t.slug);
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
        stage: 'coding',
        status: 'failed',
        startedAt: '2026-11-10T16:40:00Z',
        finishedAt: t.at,
        agent: 'claude',
        model: 'deepseek-v4-flash',
        intendedModel: 'deepseek-v4-flash',
        notes: 'Interrupted: coding agent settled without a result (agent-stalled)',
        runId: `r-${t.slug}`,
      }));
      sources.push({ taskId: t.taskId, featureDir });
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
    // The cause key names the attempt's classifyArmFault (model-fault, because
    // the mock records no harness-hold evidence); the fleet fault class the
    // row-attribution reader uses then maps that to harness-fault.
    assert.equal(stored[0].metadata?.fleet?.causeKey, 'deepseek-v4-flash::model-fault');
    assert.equal(stored[0].metadata?.fleet?.fleetFaultClass, 'harness-fault');
    assert.deepEqual(stored[0].metadata?.knownIssueIds, ['HOK-3469', 'HOK-3447_c', 'HOK-3470']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
