/**
 * HOK-3231 — unit tests for the extracted incident cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileIncidentCycle } from './incident-reconcile-cycle.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';

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

test('a store error is returned as a typed error, not thrown', async () => {
  // protects: a persistence failure crashing the whole observer tick
  const { dir, incidentsDir } = makeSandbox();
  try {
    // Shim store with a failing upsertDetailed.
    const store = {
      upsertDetailed: async () => { throw new Error('simulated-write-fail'); },
      getIncidents: async () => [],
      autoResolve: async () => null,
      runResolutionSweep: async () => [],
    } as unknown as IncidentStore;
    const result = await reconcileIncidentCycle({ store, candidates: [draft('d')], cycleComplete: true, repoDir: dir });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].kind, 'store');
    assert.match(result.errors[0].error.message, /simulated-write-fail/);
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
