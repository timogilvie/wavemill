import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LinearApiError } from './linear.ts';
import { DEFAULT_INCIDENT_LINEAR_CONFIG, type IncidentLinearClient } from './incident-to-linear-synchronizer.ts';
import { computeIncidentBackoffMs, drainIncidentQueue, enqueueIncidentSync } from './incident-linear-retry-queue.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft } from './wavemill-incident-model.ts';

const queuePath = (repoDir: string) => join(repoDir, '.wavemill', 'registry', 'linear-incident-queue.jsonl');

test('enqueueIncidentSync writes retryable incident action with short exponential backoff', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-enqueue-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const record = enqueueIncidentSync({
      repoDir,
      incidentFingerprint: 'abc',
      linearAction: 'create',
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'rate limited',
      },
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].incidentFingerprint, 'abc');
    assert.equal(record.nextRetryAt, '2026-08-04T12:00:01.000Z');
    assert.equal(computeIncidentBackoffMs(2), 2000);
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('enqueueIncidentSync deduplicates pending incident actions', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-dedupe-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const first = enqueueIncidentSync({
      repoDir,
      incidentFingerprint: 'abc',
      linearAction: 'create',
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'rate limited',
      },
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const second = enqueueIncidentSync({
      repoDir,
      incidentFingerprint: 'abc',
      linearAction: 'create',
      attempts: 2,
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'still rate limited',
      },
      now: new Date('2026-08-04T12:01:00.000Z'),
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(first.id, second.id);
    assert.equal(new Set(rows.map((row) => row.id)).size, 1);
    assert.equal(rows.at(-1).attempts, 2);
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('drainIncidentQueue replays queued incident and tombstones success', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-drain-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    const stored = await store.upsert(createIncidentDraft({
      taskId: 'HOK-1',
      category: 'product_defect',
      severity: 'high',
      confidence: 'definite',
      lifecycle: 'active',
      rootCauseClass: 'observer_crash',
      summary: 'Observer crashed.',
      operatorAction: 'Fix parser.',
      evidence: [{
        type: 'log_excerpt',
        source: 'mill.log',
        timestamp: '2026-08-04T12:00:00.000Z',
        redactedData: 'ERROR',
        key: 'error',
      }],
      metadata: { thresholdTriggered: true },
    }));
    enqueueIncidentSync({
      repoDir,
      incidentFingerprint: stored.fingerprint,
      linearAction: 'create',
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'rate limited',
      },
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const result = await drainIncidentQueue({
      repoDir,
      store,
      config: {
        ...DEFAULT_INCIDENT_LINEAR_CONFIG,
        enabled: true,
        team: 'HOK',
        project: 'Wavemill',
        requestDelayMs: 0,
        rateLimitBackoffMs: 0,
      },
      now: new Date('2026-08-04T12:01:00.000Z'),
      client: successClient(),
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(result.succeeded, 1);
    assert.equal(rows.at(-1).recordType, 'tombstone');
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('drainIncidentQueue tombstones a recovered queued create without Linear calls', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-recovered-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    const stored = await store.upsert(createIncidentDraft({
      taskId: 'HOK-1', category: 'stale_orphaned_state', severity: 'medium', confidence: 'definite', lifecycle: 'active',
      rootCauseClass: 'failed_job_no_result', summary: 'job failed', operatorAction: 'retry',
      evidence: [{ type: 'job_state', source: 'state', timestamp: '2026-08-04T12:00:00.000Z', redactedData: 'failed', key: 'failed' }],
      metadata: { jobId: 'job-1', jobKind: 'eval' },
    }));
    enqueueIncidentSync({ repoDir, incidentFingerprint: stored.fingerprint, linearAction: 'create', lastError: {
      category: 'rate_limit', httpStatus: 429, graphqlErrors: [], isRetryable: true, message: 'rate limited',
    }, now: new Date('2026-08-04T12:00:00.000Z') });
    const result = await drainIncidentQueue({
      repoDir, store, config: { ...DEFAULT_INCIDENT_LINEAR_CONFIG, enabled: true, requestDelayMs: 0, rateLimitBackoffMs: 0 },
      now: new Date('2026-08-04T12:01:00.000Z'),
      reconciler: () => ({ outcome: 'recovered', evidence: { jobId: 'job-1' } }),
      client: successClient({ searchIssues: async () => { throw new Error('Linear must not be called'); } }),
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(result.succeeded, 1);
    assert.equal(rows.at(-1).recordType, 'tombstone');
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('drainIncidentQueue marks nonretryable replay failure permanent', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-permanent-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    const stored = await store.upsert(createIncidentDraft({
      taskId: 'HOK-1',
      category: 'product_defect',
      severity: 'high',
      confidence: 'definite',
      lifecycle: 'active',
      rootCauseClass: 'observer_crash',
      summary: 'Observer crashed.',
      operatorAction: 'Fix parser.',
      evidence: [{
        type: 'log_excerpt',
        source: 'mill.log',
        timestamp: '2026-08-04T12:00:00.000Z',
        redactedData: 'ERROR',
        key: 'error',
      }],
      metadata: { thresholdTriggered: true },
    }));
    enqueueIncidentSync({
      repoDir,
      incidentFingerprint: stored.fingerprint,
      linearAction: 'create',
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'rate limited',
      },
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const result = await drainIncidentQueue({
      repoDir,
      store,
      config: {
        ...DEFAULT_INCIDENT_LINEAR_CONFIG,
        enabled: true,
        team: 'HOK',
        project: 'Wavemill',
        requestDelayMs: 0,
        rateLimitBackoffMs: 0,
      },
      now: new Date('2026-08-04T12:01:00.000Z'),
      client: successClient({
        getTeams: async () => {
          throw new LinearApiError('forbidden', { httpStatus: 403 });
        },
      }),
      log: { error: () => {} },
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(result.permanentFailures, 1);
    assert.equal(rows.at(-1).recordType, 'permanently_failed');
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('drainIncidentQueue keeps replayed 429 pending with incremented attempt', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-429-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    const stored = await store.upsert(createIncidentDraft({
      taskId: 'HOK-1',
      category: 'product_defect',
      severity: 'high',
      confidence: 'definite',
      lifecycle: 'active',
      rootCauseClass: 'observer_crash',
      summary: 'Observer crashed.',
      operatorAction: 'Fix parser.',
      evidence: [{
        type: 'log_excerpt',
        source: 'mill.log',
        timestamp: '2026-08-04T12:00:00.000Z',
        redactedData: 'ERROR',
        key: 'error',
      }],
      metadata: { thresholdTriggered: true },
    }));
    enqueueIncidentSync({
      repoDir,
      incidentFingerprint: stored.fingerprint,
      linearAction: 'create',
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'rate limited',
      },
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const result = await drainIncidentQueue({
      repoDir,
      store,
      config: {
        ...DEFAULT_INCIDENT_LINEAR_CONFIG,
        enabled: true,
        team: 'HOK',
        project: 'Wavemill',
        requestDelayMs: 0,
        rateLimitBackoffMs: 0,
      },
      now: new Date('2026-08-04T12:01:00.000Z'),
      client: successClient({
        getTeams: async () => {
          throw new LinearApiError('rate limited', { httpStatus: 429 });
        },
      }),
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(result.failed, 1);
    assert.equal(result.permanentFailures, 0);
    assert.equal(rows.at(-1).recordType, 'pending');
    assert.equal(rows.at(-1).attempts, 2);
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

function successClient(overrides: Partial<IncidentLinearClient> = {}): IncidentLinearClient {
  return {
    getTeams: async () => [{ id: 'team-1', key: 'HOK', name: 'Hokusai' }],
    getProjects: async () => [{ id: 'project-1', name: 'Wavemill', state: 'started' }],
    searchIssues: async () => [],
    getIssue: async () => {
      throw new Error('not found');
    },
    createIssue: async (params) => ({
      id: 'issue-uuid',
      identifier: 'HOK-200',
      title: params.title,
      url: 'https://linear.app/hokusai/issue/HOK-200/test',
      state: { name: 'Todo' },
      labels: { nodes: [] },
      team: { id: 'team-1', key: 'HOK', name: 'Hokusai' },
    }),
    createComment: async () => ({ id: 'comment-1', url: 'https://linear.app/comment' }),
    getOrCreateLabel: async (name) => ({ id: `label-${name}`, name }),
    addLabelsToIssue: async () => ({
      success: true,
      issue: {
        id: 'issue-uuid',
        identifier: 'HOK-200',
        title: 'Issue',
        state: { name: 'Todo' },
        labels: { nodes: [] },
        team: { id: 'team-1', key: 'HOK', name: 'Hokusai' },
      },
    }),
    ...overrides,
  };
}

test('enqueueIncidentSync dedupes lifecycle entries by transition revision', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-lifecycle-dedupe-'));
  try {
    const base = {
      repoDir,
      incidentFingerprint: 'fp1',
      linearAction: 'lifecycle' as const,
      linearIssueId: 'HOK-9',
      lifecycleKind: 'resolved' as const,
      lastError: { category: 'rate_limit' as const, httpStatus: 429, graphqlErrors: [], isRetryable: true, message: 'x' },
      now: new Date('2026-08-04T12:00:00.000Z'),
    };
    enqueueIncidentSync({ ...base, transitionRevision: 'rev-a' });
    enqueueIncidentSync({ ...base, transitionRevision: 'rev-a' });
    enqueueIncidentSync({ ...base, transitionRevision: 'rev-b' });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const ids = new Set(rows.map((r) => r.id));
    // Same revision reuses one id; a different revision gets its own.
    assert.equal(ids.size, 2);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('drainIncidentQueue replays a lifecycle entry and tombstones on success', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'incident-queue-lifecycle-drain-'));
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'), { escalationThreshold: 1, resolutionAfterCycles: 1 });
    const stored = await store.upsert(createIncidentDraft({
      taskId: 'HOK-1', category: 'product_defect', severity: 'high', confidence: 'definite', lifecycle: 'observed',
      rootCauseClass: 'observer_crash', summary: 'crash', operatorAction: 'fix',
      evidence: [{ type: 'log_excerpt', source: 'mill.log', timestamp: '2026-08-04T12:00:00.000Z', redactedData: 'ERROR', key: 'error' }],
      metadata: {},
    }));
    await store.recordLinearSync(stored.fingerprint, { linearIssueId: 'HOK-9', evidenceRevision: 'r1' });
    await store.resolve(stored.fingerprint);
    enqueueIncidentSync({
      repoDir,
      incidentFingerprint: stored.fingerprint,
      linearAction: 'lifecycle',
      linearIssueId: 'HOK-9',
      lifecycleKind: 'resolved',
      transitionRevision: 'rev-a',
      lastError: { category: 'rate_limit', httpStatus: 429, graphqlErrors: [], isRetryable: true, message: 'x' },
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    let comments = 0;
    const result = await drainIncidentQueue({
      repoDir,
      store,
      config: {
        ...DEFAULT_INCIDENT_LINEAR_CONFIG,
        enabled: true,
        team: 'HOK',
        requestDelayMs: 0,
        rateLimitBackoffMs: 0,
        lifecycle: { ...DEFAULT_INCIDENT_LINEAR_CONFIG.lifecycle, enabled: true },
      },
      now: new Date('2026-08-04T12:01:00.000Z'),
      reconciler: () => ({ outcome: 'recovered', evidence: {} }),
      client: successClient({
        getIssue: async (identifier) => ({
          id: `uuid-${identifier}`, identifier, title: 't', state: { name: 'Todo' }, labels: { nodes: [] },
          team: { id: 'team-1', key: 'HOK', name: 'Hokusai' }, url: 'u', completedAt: null, canceledAt: null,
        }),
        createComment: async () => { comments += 1; return { id: 'c', url: 'u' }; },
      }),
    });
    const rows = readFileSync(queuePath(repoDir), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(result.succeeded, 1);
    assert.equal(comments, 1);
    assert.equal(rows.at(-1).recordType, 'tombstone');
  } finally {
    Math.random = originalRandom;
    rmSync(repoDir, { recursive: true, force: true });
  }
});
