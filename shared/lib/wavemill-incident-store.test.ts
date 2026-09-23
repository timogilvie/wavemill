import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    taskId: 'HOK-1_c',
    category: 'model_task_harness_outcome',
    severity: 'high',
    confidence: 'definite',
    lifecycle: 'observed',
    rootCauseClass: 'turn_limit',
    summary: 'Planning failed with turn_limit for HOK-1_c.',
    operatorAction: 'Retry with more planning budget.',
    evidence: [{
      type: 'planning_result',
      source: '.planning-result.json',
      timestamp: '2026-08-03T12:00:00.000Z',
      redactedData: 'status=failed failureReason=turn_limit',
      key: 'turn_limit',
    }],
    metadata: {},
    ...overrides,
  });
}

function incidentEvent(timestamp: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return incident({
    evidence: [{
      type: 'planning_result',
      source: '.planning-result.json',
      timestamp,
      redactedData: 'status=failed failureReason=turn_limit',
      key: 'turn_limit',
    }],
    ...overrides,
  });
}

test('incident store deduplicates by deterministic fingerprint and counts distinct events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-store-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const first = await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    const second = await store.upsert(incidentEvent('2026-08-03T13:00:00.000Z'));

    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(second.occurrenceCount, 2);
    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-polling an unchanged event is a no-op for count and liveness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-repoll-'));
  try {
    let clock = Date.parse('2026-08-03T12:00:00.000Z');
    const store = new IncidentStore(dir, {
      escalationThreshold: 3,
      now: () => new Date((clock += 120_000)),
    });
    const first = await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    // Same terminal event re-detected on later poll cycles (e.g. an un-reaped
    // failed job in workflow-state.json) must not inflate the count.
    const repollA = await store.upsertDetailed(incidentEvent('2026-08-03T12:00:00.000Z'));
    const repollB = await store.upsertDetailed(incidentEvent('2026-08-03T12:00:00.000Z'));

    assert.equal(repollA.freshEvent, false);
    assert.equal(repollB.freshEvent, false);
    assert.equal(repollB.record.occurrenceCount, 1);
    assert.equal(repollB.record.lastObservedAt, first.lastObservedAt);
    assert.equal(repollB.record.lifecycle, 'observed');

    const evidence = await store.getEvidenceForIncident(first.fingerprint);
    assert.equal(evidence.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store escalates on distinct events at configured threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-threshold-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    await store.upsert(incidentEvent('2026-08-03T13:00:00.000Z'));
    const third = await store.upsert(incidentEvent('2026-08-03T14:00:00.000Z'));

    assert.equal(third.lifecycle, 'active');
    assert.equal(third.metadata.thresholdTriggered, true);
    assert.ok(third.metadata.escalatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store handles concurrent identical upserts as one distinct event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-concurrent-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 20 });
    await Promise.all(Array.from({ length: 10 }, () => store.upsert(incident())));

    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 1);

    const evidence = await store.getEvidenceForIncident(incidents[0].fingerprint);
    assert.equal(evidence.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store sets firstObservedAt on creation and backfills legacy records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-first-observed-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());
    assert.ok(created.firstObservedAt);
    assert.equal(created.firstObservedAt, created.createdAt);

    // Simulate a legacy record written before firstObservedAt existed.
    const indexPath = join(dir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, IncidentRecord>;
    const legacy = index[created.fingerprint] as Record<string, unknown>;
    delete legacy.firstObservedAt;
    (legacy.metadata as Record<string, unknown>).seenEventKeys = [];
    writeFileSync(indexPath, JSON.stringify(index));

    const touched = await store.upsert(incident());
    // Backfilled from the earliest trustworthy stored timestamp (evidence).
    assert.equal(touched.firstObservedAt, '2026-08-03T12:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parse errors differing only in token offset produce one record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-parse-dedup-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const shared = {
      taskId: null,
      category: 'configuration_operator_condition' as const,
      evidence: [{
        type: 'backstage_health' as const,
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=parse failure',
        key: 'queue_planner_fallback',
      }],
    };
    const first = await store.upsert(incident({
      ...shared,
      rootCauseClass: 'error_failed_to_parse_backlog_json_from_stdin_unexpected_token_h' as IncidentRecord['rootCauseClass'],
    }));
    const second = await store.upsert(incident({
      ...shared,
      rootCauseClass: 'error_failed_to_parse_backlog_json_from_stdin_unexpected_token_i' as IncidentRecord['rootCauseClass'],
      evidence: [{ ...shared.evidence[0], timestamp: '2026-08-03T13:00:00.000Z' }],
    }));

    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(second.rootCauseClass, 'local_parse_failure');
    assert.equal(second.occurrenceCount, 2);
    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolution sweep resolves records missing for N cycles and keeps fresh ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-sweep-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3, resolutionAfterCycles: 2 });
    const stale = await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    const fresh = await store.upsert(incident({
      taskId: 'HOK-2_c',
      rootCauseClass: 'orphaned_completion_marker',
      category: 'stale_orphaned_state',
      summary: 'HOK-2_c has a coding completion marker without a result artifact.',
      evidence: [{
        type: 'workflow_state',
        source: '.wavemill/workflow-state.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'stage=coding resultMissing=true',
        key: 'orphaned_coding_marker',
      }],
    }));

    const sweep1 = await store.runResolutionSweep([fresh.fingerprint]);
    assert.equal(sweep1.length, 0);
    const sweep2 = await store.runResolutionSweep([fresh.fingerprint]);
    assert.equal(sweep2.length, 1);
    assert.equal(sweep2[0].fingerprint, stale.fingerprint);
    assert.equal(sweep2[0].lifecycle, 'resolved');
    assert.equal(sweep2[0].metadata.resolution?.action, 'auto_resolved');

    const remaining = await store.getIncidents();
    assert.deepEqual(remaining.map((record) => record.fingerprint), [fresh.fingerprint]);
    assert.equal(remaining[0].metadata.missedCycles, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator resolve and archive transition lifecycle with audit metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-operator-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());

    const resolved = await store.resolve(created.fingerprint, { reason: 'fixed upstream' });
    assert.equal(resolved?.lifecycle, 'resolved');
    assert.equal(resolved?.metadata.resolution?.action, 'operator_resolved');
    assert.equal(resolved?.metadata.resolution?.reason, 'fixed upstream');

    const archived = await store.archive(created.fingerprint);
    assert.equal(archived?.lifecycle, 'archived');
    assert.equal(archived?.metadata.resolution?.action, 'operator_archived');

    assert.equal(await store.resolve('unknown-fingerprint'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archived incident that recurs reopens with recurrence metadata and can re-escalate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-recurrence-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    const second = await store.upsert(incidentEvent('2026-08-03T13:00:00.000Z'));
    await store.archive(second.fingerprint, { reason: 'manual backlog clear' });

    // Re-poll of an already-counted event does not reopen an archived record.
    const repoll = await store.upsertDetailed(incidentEvent('2026-08-03T13:00:00.000Z'));
    assert.equal(repoll.freshEvent, false);
    assert.equal(repoll.record.lifecycle, 'archived');

    // A genuinely new distinct event reopens it and re-escalates past threshold.
    const recurred = await store.upsert(incidentEvent('2026-08-04T09:00:00.000Z'));
    assert.equal(recurred.lifecycle, 'active');
    assert.equal(recurred.occurrenceCount, 3);
    assert.equal(recurred.metadata.recurrence?.count, 1);
    assert.equal(recurred.metadata.recurrence?.reopenedFrom, 'archived');
    assert.equal(recurred.metadata.resolution?.action, 'operator_archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store consolidates legacy fanned-out records under canonical attribution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-legacy-fanout-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const first = await store.upsert(incident({
      taskId: 'HOK-2841',
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=timeout',
        key: 'queue_planner_fallback',
      }],
    }));
    await store.recordLinearSync(first.fingerprint, {
      linearIssueId: 'HOK-3000',
      evidenceRevision: 'old-revision',
      syncedAt: '2026-08-03T12:01:00.000Z',
    });
    await store.upsert(incident({
      taskId: 'HOK-2842',
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: first.evidence,
    }));

    const canonical = await store.upsert(incident({
      taskId: null,
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: first.evidence,
    }));
    const incidents = await store.getIncidents();
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8')) as Record<string, IncidentRecord>;

    assert.equal(incidents.length, 1);
    assert.equal(canonical.taskId, null);
    assert.equal(canonical.occurrenceCount, 3);
    assert.equal(canonical.metadata.linkedLinearId, 'HOK-3000');
    assert.deepEqual(Object.keys(index), [canonical.fingerprint]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multiple tasks with same evidence source/key produce separate records with task-aware fingerprints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-multi-task-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    // Simulate three different eval jobs failing with identical evidence source/key
    // but different task IDs (e.g., failed evaluations of different tasks)
    const baseEvidence = [{
      type: 'job_state' as const,
      source: '.wavemill/workflow-state.json',
      timestamp: '2026-08-03T12:00:00.000Z',
      redactedData: 'stage=coding result=failed',
      key: 'failed_job_no_result',
    }];

    const incident1 = await store.upsert(incident({
      taskId: 'HOK-3017',
      category: 'model_task_harness_outcome',
      rootCauseClass: 'evaluation_failed',
      summary: 'Evaluation failed for HOK-3017',
      evidence: baseEvidence,
    }));

    const incident2 = await store.upsert(incident({
      taskId: 'HOK-2845_c',
      category: 'model_task_harness_outcome',
      rootCauseClass: 'evaluation_failed',
      summary: 'Evaluation failed for HOK-2845_c',
      evidence: baseEvidence,
    }));

    const incident3 = await store.upsert(incident({
      taskId: 'HOK-3009',
      category: 'model_task_harness_outcome',
      rootCauseClass: 'evaluation_failed',
      summary: 'Evaluation failed for HOK-3009',
      evidence: baseEvidence,
    }));

    // Three distinct records with task-aware fingerprints
    assert.notEqual(incident1.fingerprint, incident2.fingerprint);
    assert.notEqual(incident2.fingerprint, incident3.fingerprint);
    assert.notEqual(incident1.fingerprint, incident3.fingerprint);

    // Each maintains its own task identity
    assert.equal(incident1.taskId, 'HOK-3017');
    assert.equal(incident2.taskId, 'HOK-2845_c');
    assert.equal(incident3.taskId, 'HOK-3009');

    // Each maintains its own summary
    assert.equal(incident1.summary, 'Evaluation failed for HOK-3017');
    assert.equal(incident2.summary, 'Evaluation failed for HOK-2845_c');
    assert.equal(incident3.summary, 'Evaluation failed for HOK-3009');

    // Each has occurrence count of 1 (no consolidation)
    assert.equal(incident1.occurrenceCount, 1);
    assert.equal(incident2.occurrenceCount, 1);
    assert.equal(incident3.occurrenceCount, 1);

    // Re-poll one unchanged task: no count change, other tasks untouched
    const repoll = await store.upsertDetailed(incident({
      taskId: 'HOK-2845_c',
      category: 'model_task_harness_outcome',
      rootCauseClass: 'evaluation_failed',
      summary: 'Evaluation failed for HOK-2845_c',
      evidence: baseEvidence,
    }));

    assert.equal(repoll.freshEvent, false);
    assert.equal(repoll.record.occurrenceCount, 1);

    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 3);
    const taskIds = incidents.map((r) => r.taskId).sort();
    assert.deepEqual(taskIds, ['HOK-2845_c', 'HOK-3009', 'HOK-3017']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-task legacy canonicalization refreshes summary/evidence while preserving Linear/audit metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-same-task-legacy-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    // Seed a legacy record with raw/different root cause class
    const legacy = await store.upsert(incident({
      taskId: 'HOK-1_c',
      category: 'configuration_operator_condition',
      rootCauseClass: 'error_failed_to_parse_backlog_json_from_stdin_unexpected_token_a',
      summary: 'Legacy parse error for HOK-1_c',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=parse failure',
        key: 'queue_planner_fallback',
      }],
    }));

    // Link it to a Linear issue
    await store.recordLinearSync(legacy.fingerprint, {
      linearIssueId: 'HOK-9999',
      evidenceRevision: 'rev-1',
      syncedAt: '2026-08-03T12:01:00.000Z',
    });

    // Upsert same-task incident with slightly different raw root cause
    // (should consolidate via legacy canonicalization)
    const canonical = await store.upsert(incident({
      taskId: 'HOK-1_c',
      category: 'configuration_operator_condition',
      rootCauseClass: 'error_failed_to_parse_backlog_json_from_stdin_unexpected_token_b',
      summary: 'Updated parse error for HOK-1_c',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T13:00:00.000Z',
        redactedData: 'reason=parse failure',
        key: 'queue_planner_fallback',
      }],
    }));

    // Should have consolidated (same canonical root cause for parse errors)
    // and refreshed canonical fields
    assert.equal(canonical.fingerprint, legacy.fingerprint);
    assert.equal(canonical.summary, 'Updated parse error for HOK-1_c');
    assert.equal(canonical.rootCauseClass, 'local_parse_failure');
    assert.equal(canonical.taskId, 'HOK-1_c');
    assert.equal(canonical.occurrenceCount, 2); // legacy + canonical

    // Linear metadata preserved
    assert.equal(canonical.metadata.linkedLinearId, 'HOK-9999');
    assert.equal(canonical.metadata.lastSyncedAt, '2026-08-03T12:01:00.000Z');

    // Only one active incident (the consolidated record)
    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].fingerprint, canonical.fingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-to-null repo migration is explicit and does not permit task-to-different-task consolidation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-task-migration-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });

    // Create repo-scoped queue health incidents (safe-to-migrate evidence)
    const task1Queue = await store.upsert(incident({
      taskId: 'HOK-2841',
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=timeout',
        key: 'queue_planner_fallback',
      }],
    }));

    const task2Queue = await store.upsert(incident({
      taskId: 'HOK-2842',
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=timeout',
        key: 'queue_planner_fallback',
      }],
    }));

    // Repo-scoped candidate with same evidence: consolidates both task records
    const repoScoped = await store.upsert(incident({
      taskId: null,
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=timeout',
        key: 'queue_planner_fallback',
      }],
    }));

    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(repoScoped.taskId, null);
    assert.equal(repoScoped.occurrenceCount, 3); // consolidated 2 tasks + 1 repo

    // Now test that task-to-different-task consolidation is blocked
    // (using a different evidence type that is NOT safe-to-migrate)
    const taskA = await store.upsert(incident({
      taskId: 'HOK-1000_c',
      category: 'model_task_harness_outcome',
      rootCauseClass: 'evaluation_failed',
      summary: 'Evaluation failed for HOK-1000_c',
      evidence: [{
        type: 'job_state',
        source: '.wavemill/workflow-state.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'stage=coding result=failed',
        key: 'failed_job_no_result',
      }],
    }));

    const taskB = await store.upsert(incident({
      taskId: 'HOK-1001_c',
      category: 'model_task_harness_outcome',
      rootCauseClass: 'evaluation_failed',
      summary: 'Evaluation failed for HOK-1001_c',
      evidence: [{
        type: 'job_state',
        source: '.wavemill/workflow-state.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'stage=coding result=failed',
        key: 'failed_job_no_result',
      }],
    }));

    // Two separate records, never consolidated across tasks
    assert.notEqual(taskA.fingerprint, taskB.fingerprint);
    assert.equal(taskA.taskId, 'HOK-1000_c');
    assert.equal(taskB.taskId, 'HOK-1001_c');

    // Total 3 incidents: 1 consolidated repo queue + 2 separate task eval failures
    const allIncidents = await store.getIncidents();
    assert.equal(allIncidents.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeLifecycleRevision is stable when nothing changes and flips when lifecycle transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-lifecycle-revision-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());
    const initialRevision = store.computeLifecycleRevision(created);

    const same = await store.getIncident(created.fingerprint);
    assert.equal(store.computeLifecycleRevision(same!), initialRevision);

    const resolved = await store.resolve(created.fingerprint, { reason: 'fixed upstream' });
    const resolvedRevision = store.computeLifecycleRevision(resolved!);
    assert.notEqual(resolvedRevision, initialRevision);

    const archived = await store.archive(created.fingerprint);
    const archivedRevision = store.computeLifecycleRevision(archived!);
    assert.notEqual(archivedRevision, resolvedRevision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getIncidentsWithUnsyncedLifecycle selects linked incidents whose lifecycle revision changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-unsynced-lifecycle-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());

    // Not linked to Linear yet: not selected.
    assert.equal((await store.getIncidentsWithUnsyncedLifecycle()).length, 0);

    await store.recordLinearSync(created.fingerprint, {
      linearIssueId: 'HOK-9000',
      evidenceRevision: 'ev-1',
      syncedAt: '2026-08-04T12:00:00.000Z',
    });

    // Linked but lifecycle never synced: selected because current != lastSynced (undefined).
    const beforeResolve = await store.getIncidentsWithUnsyncedLifecycle();
    assert.equal(beforeResolve.length, 1);
    assert.equal(beforeResolve[0].fingerprint, created.fingerprint);

    // Record the lifecycle substep at current revision; now selection is empty.
    const currentRevision = store.computeLifecycleRevision(created);
    await store.recordLifecycleSubstep(created.fingerprint, {
      lifecycleRevision: currentRevision,
      commentPosted: true,
    });
    assert.equal((await store.getIncidentsWithUnsyncedLifecycle()).length, 0);

    // Operator resolves: lifecycle revision changes -> selected again.
    await store.resolve(created.fingerprint, { reason: 'shipped' });
    const afterResolve = await store.getIncidentsWithUnsyncedLifecycle();
    assert.equal(afterResolve.length, 1);
    assert.equal(afterResolve[0].fingerprint, created.fingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordLifecycleSubstep merges comment and state flags idempotently across replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-substep-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());
    const revision = store.computeLifecycleRevision(created);

    const afterComment = await store.recordLifecycleSubstep(created.fingerprint, {
      lifecycleRevision: revision,
      commentPosted: true,
      at: '2026-08-04T12:00:00.000Z',
    });
    assert.equal(afterComment?.metadata.lastSyncedLifecycle?.revision, revision);
    assert.equal(afterComment?.metadata.lastSyncedLifecycle?.commentPosted, true);
    assert.equal(afterComment?.metadata.lastSyncedLifecycle?.stateChanged, false);

    // Second substep at the same revision should preserve the earlier commentPosted flag.
    const afterState = await store.recordLifecycleSubstep(created.fingerprint, {
      lifecycleRevision: revision,
      stateChanged: true,
      observerStateId: 'state-done',
      at: '2026-08-04T12:05:00.000Z',
    });
    assert.equal(afterState?.metadata.lastSyncedLifecycle?.commentPosted, true);
    assert.equal(afterState?.metadata.lastSyncedLifecycle?.stateChanged, true);
    assert.equal(afterState?.metadata.lastSyncedLifecycle?.observerStateId, 'state-done');

    // A new revision resets prior substep flags (fresh transition to sync).
    await store.resolve(created.fingerprint, { reason: 'ship' });
    const resolved = await store.getIncident(created.fingerprint);
    const newRevision = store.computeLifecycleRevision(resolved!);
    const afterReset = await store.recordLifecycleSubstep(created.fingerprint, {
      lifecycleRevision: newRevision,
      commentPosted: true,
    });
    assert.equal(afterReset?.metadata.lastSyncedLifecycle?.revision, newRevision);
    assert.equal(afterReset?.metadata.lastSyncedLifecycle?.stateChanged, false);
    assert.equal(afterReset?.metadata.lastSyncedLifecycle?.observerStateId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
