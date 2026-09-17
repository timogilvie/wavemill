import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_INCIDENT_LINEAR_CONFIG,
  generateIssueBody,
  generateIssueTitle,
  redactLinearIssueContent,
  syncIncident,
  type IncidentLinearClient,
  type ObserverLinearConfig,
} from './incident-to-linear-synchronizer.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentCategory, type IncidentRecord } from './wavemill-incident-model.ts';
import { LinearApiError, type LinearIssueSummary } from './linear.ts';

function config(overrides: Partial<ObserverLinearConfig> = {}): ObserverLinearConfig {
  return {
    ...DEFAULT_INCIDENT_LINEAR_CONFIG,
    enabled: true,
    team: 'HOK',
    project: 'Wavemill',
    requestDelayMs: 0,
    rateLimitBackoffMs: 0,
    ...overrides,
    policies: {
      ...DEFAULT_INCIDENT_LINEAR_CONFIG.policies,
      ...(overrides.policies ?? {}),
    },
    redaction: {
      ...DEFAULT_INCIDENT_LINEAR_CONFIG.redaction,
      ...(overrides.redaction ?? {}),
    },
  };
}

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    id: 'incident-1',
    fingerprint: 'f'.repeat(64),
    taskId: 'HOK-1',
    session: 'wavemill',
    category: 'product_defect',
    severity: 'high',
    confidence: 'definite',
    lifecycle: 'active',
    createdAt: '2026-08-04T12:00:00.000Z',
    lastObservedAt: '2026-08-04T12:10:00.000Z',
    occurrenceCount: 3,
    rootCauseClass: 'observer_crash',
    summary: 'Observer crashed while reading artifact.',
    operatorAction: 'Fix artifact parsing and add a regression test.',
    evidence: [{
      type: 'log_excerpt',
      source: '/Users/timothy/project/.wavemill/logs/mill.log',
      timestamp: '2026-08-04T12:10:00.000Z',
      lineNumber: 42,
      redactedData: 'ERROR token=supersecret model=gpt-test user=person@example.com',
      key: 'crash',
    }],
    metadata: { thresholdTriggered: true, escalatedAt: '2026-08-04T12:10:00.000Z' },
    ...overrides,
  });
}

function mockClient(overrides: Partial<IncidentLinearClient> = {}): IncidentLinearClient {
  return {
    getTeams: async () => [{ id: 'team-1', key: 'HOK', name: 'Hokusai' }],
    getProjects: async () => [{ id: 'project-1', name: 'Wavemill', state: 'started' }],
    searchIssues: async () => [],
    getIssue: async (identifier) => {
      throw new Error(`not found: ${identifier}`);
    },
    createIssue: async (params) => ({
      id: 'issue-uuid',
      identifier: 'HOK-100',
      title: params.title,
      url: 'https://linear.app/hokusai/issue/HOK-100/test',
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
        identifier: 'HOK-100',
        title: 'Issue',
        state: { name: 'Todo' },
        labels: { nodes: [] },
        team: { id: 'team-1', key: 'HOK', name: 'Hokusai' },
      },
    }),
    ...overrides,
  };
}

test('redaction removes secrets, emails, paths, and truncates transcript-like content', () => {
  const text = `token=abc123 user=person@example.com file=/Users/timothy/project/.env transcript=${'x'.repeat(500)}`;
  const redacted = redactLinearIssueContent(text, config().redaction);
  assert.doesNotMatch(redacted, /abc123|person@example.com|\/Users\/timothy/);
  assert.match(redacted, /\[REDACTED: secret\]/);
  assert.match(redacted, /\[REDACTED: email\]/);
  assert.match(redacted, /\[TRUNCATED\]/);
});

test('ticket template includes required incident sections and redacted evidence', () => {
  const item = incident();
  const body = generateIssueBody(item, config(), 'revision-1', new Date('2026-08-04T12:15:00.000Z'));
  assert.match(generateIssueTitle(item), /\[wavemill incident\/product_defect\]/);
  for (const section of [
    '## Incident Summary',
    '## Impact',
    '## Affected Session/Task/Model',
    '## Evidence',
    '## Structured Evidence References',
    '## Threshold & Escalation',
    '## Related Issues',
    '## Operator Recommendation',
  ]) {
    assert.match(body, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(body, /supersecret|person@example.com/);
  assert.match(body, /observer_crash/);
});

test('confirmed product defect creates exactly one issue and persists sync metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-create-'));
  let createCalls = 0;
  try {
    const store = new IncidentStore(dir);
    const stored = await store.upsert(incident({ fingerprint: '' }));
    const result = await syncIncident({
      incident: stored,
      store,
      config: config(),
      now: new Date('2026-08-04T12:20:00.000Z'),
      client: mockClient({
        createIssue: async (params) => {
          createCalls += 1;
          return {
            id: 'issue-uuid',
            identifier: 'HOK-100',
            title: params.title,
            url: 'https://linear.app/hokusai/issue/HOK-100/test',
            state: { name: 'Todo' },
            labels: { nodes: [] },
            team: { id: 'team-1', key: 'HOK', name: 'Hokusai' },
          };
        },
      }),
    });
    const after = await store.getIncident(stored.fingerprint);
    assert.equal(result.status, 'created');
    assert.equal(createCalls, 1);
    assert.equal(after?.metadata.linkedLinearId, 'HOK-100');
    assert.equal(after?.metadata.lastSyncedEvidenceRevision, result.evidenceRevision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same evidence revision suppresses duplicate comments across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-noop-'));
  let commentCalls = 0;
  try {
    const store = new IncidentStore(dir);
    const stored = await store.upsert(incident({ fingerprint: '' }));
    const revision = store.computeEvidenceRevision(stored);
    await store.recordLinearSync(stored.fingerprint, {
      linearIssueId: 'HOK-101',
      evidenceRevision: revision,
      syncedAt: '2026-08-04T12:00:00.000Z',
      cooldownUntil: '2026-08-04T12:05:00.000Z',
    });
    const linked = await store.getIncident(stored.fingerprint);
    const result = await syncIncident({
      incident: linked!,
      store,
      config: config(),
      now: new Date('2026-08-04T12:20:00.000Z'),
      client: mockClient({
        getIssue: async () => issueSummary('HOK-101') as any,
        createComment: async () => {
          commentCalls += 1;
          return { id: 'comment-1', url: 'https://linear.app/comment' };
        },
      }),
    });
    assert.equal(result.action, 'no_op');
    assert.equal(commentCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing issue correlation updates comment when evidence revision changes outside cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-update-'));
  let commentCalls = 0;
  try {
    const store = new IncidentStore(dir);
    const stored = await store.upsert(incident({ fingerprint: '' }));
    const result = await syncIncident({
      incident: {
        ...stored,
        metadata: {
          ...stored.metadata,
          linkedLinearId: 'HOK-102',
          lastSyncedEvidenceRevision: 'old',
          syncCooldownUntil: '2026-08-04T12:00:00.000Z',
        },
      },
      store,
      config: config(),
      now: new Date('2026-08-04T12:30:00.000Z'),
      client: mockClient({
        getIssue: async () => issueSummary('HOK-102') as any,
        createComment: async () => {
          commentCalls += 1;
          return { id: 'comment-1', url: 'https://linear.app/comment' };
        },
      }),
    });
    assert.equal(result.status, 'updated');
    assert.equal(commentCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content search correlation attaches evidence instead of creating duplicate issue', async () => {
  let createCalls = 0;
  let commentCalls = 0;
  const result = await syncIncident({
    incident: incident({ metadata: { thresholdTriggered: true, lastSyncedEvidenceRevision: 'old' } }),
    config: config(),
    now: new Date('2026-08-04T12:40:00.000Z'),
    client: mockClient({
      searchIssues: async (term) => term.includes('observer_crash') ? [issueSummary('HOK-103')] : [],
      createIssue: async (params) => {
        createCalls += 1;
        return mockClient().createIssue(params);
      },
      createComment: async () => {
        commentCalls += 1;
        return { id: 'comment-1', url: 'https://linear.app/comment' };
      },
    }),
  });
  assert.equal(result.status, 'updated');
  assert.equal(result.issueId, 'HOK-103');
  assert.equal(createCalls, 0);
  assert.equal(commentCalls, 1);
});

test('class policies suppress model outcomes and below-threshold external transients', async () => {
  for (const [category, occurrenceCount] of [
    ['model_task_harness_outcome', 10],
    ['external_transient_dependency', 1],
  ] as Array<[IncidentCategory, number]>) {
    const result = await syncIncident({
      incident: incident({
        category,
        rootCauseClass: category === 'model_task_harness_outcome' ? 'turn_limit' : 'github_ssh_disconnect',
        occurrenceCount,
        metadata: { thresholdTriggered: true },
      }),
      config: config(),
      client: mockClient(),
    });
    assert.equal(result.status, 'skipped');
    assert.notEqual(result.action, 'create');
  }
});

test('repeated external transient can create one incident issue', async () => {
  const result = await syncIncident({
    incident: incident({
      category: 'external_transient_dependency',
      rootCauseClass: 'github_ssh_disconnect',
      occurrenceCount: 3,
      metadata: { thresholdTriggered: true },
    }),
    config: config(),
    client: mockClient(),
  });
  assert.equal(result.status, 'created');
});

test('dry-run returns offline unknown plan without Linear API calls', async () => {
  let linearCalls = 0;
  const result = await syncIncident({
    incident: incident(),
    config: config(),
    dryRun: true,
    client: mockClient({
      getTeams: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
      getProjects: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
      searchIssues: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
      getIssue: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
      createIssue: async (params) => {
        linearCalls += 1;
        return mockClient().createIssue(params);
      },
      createComment: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
      getOrCreateLabel: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
      addLabelsToIssue: async () => {
        linearCalls += 1;
        throw new Error('dry-run must not call Linear');
      },
    }),
  });
  assert.equal(result.action, 'unknown_needs_lookup');
  assert.equal(result.status, 'skipped');
  assert.equal(linearCalls, 0);
  assert.match(result.plannedTitle ?? '', /Observer crashed/);
});

test('recovered unlinked incident is skipped before every Linear client call and dry-run reports evidence', async () => {
  let calls = 0;
  const recovered = () => ({ outcome: 'recovered' as const, evidence: { jobId: 'job-1', resultExists: true } });
  const result = await syncIncident({
    incident: incident({ rootCauseClass: 'failed_job_no_result', metadata: { jobId: 'job-1', jobKind: 'eval', thresholdTriggered: true } }),
    config: config(),
    reconciler: recovered,
    client: mockClient({ searchIssues: async () => { calls += 1; return []; }, getTeams: async () => { calls += 1; return []; } }),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reconciliation?.outcome, 'recovered');
  assert.equal(calls, 0);

  const dry = await syncIncident({
    incident: incident({ rootCauseClass: 'failed_job_no_result', metadata: { jobId: 'job-1', jobKind: 'eval', thresholdTriggered: true } }),
    config: config({ detectionOnly: true }),
    reconciler: recovered,
    client: mockClient({ searchIssues: async () => { calls += 1; return []; } }),
  });
  assert.equal(dry.reconciliation?.evidence.resultExists, true);
  assert.equal(calls, 0);
});

test('detectionOnly returns local update plan without Linear API calls', async () => {
  let linearCalls = 0;
  const result = await syncIncident({
    incident: incident({
      metadata: {
        linkedLinearId: 'HOK-104',
        linkedLinearUrl: 'https://linear.app/hokusai/issue/HOK-104/test',
        lastSyncedEvidenceRevision: 'old',
      },
    }),
    config: config({ detectionOnly: true }),
    client: mockClient({
      getIssue: async () => {
        linearCalls += 1;
        throw new Error('detectionOnly must not call Linear');
      },
      createComment: async () => {
        linearCalls += 1;
        throw new Error('detectionOnly must not call Linear');
      },
    }),
  });
  assert.equal(result.action, 'update_comment');
  assert.equal(result.issueId, 'HOK-104');
  assert.equal(linearCalls, 0);
});

test('disabled config performs no Linear writes without dry-run consent', async () => {
  let createCalls = 0;
  const result = await syncIncident({
    incident: incident(),
    config: config({ enabled: false }),
    client: mockClient({
      createIssue: async (params) => {
        createCalls += 1;
        return mockClient().createIssue(params);
      },
    }),
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason ?? '', /enabled is false/);
  assert.equal(createCalls, 0);
});

test('retryable Linear failure is queued and stored as sync error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-queue-'));
  try {
    const store = new IncidentStore(dir);
    const stored = await store.upsert(incident({ fingerprint: '' }));
    const result = await syncIncident({
      incident: stored,
      store,
      config: config(),
      client: mockClient({
        getTeams: async () => {
          throw new LinearApiError('rate limited', { httpStatus: 429 });
        },
      }),
      retryQueue: {
        enqueueIncidentSync: () => ({ nextRetryAt: '2026-08-04T12:01:00.000Z' }),
      },
    });
    const after = await store.getIncident(stored.fingerprint);
    assert.equal(result.status, 'queued');
    assert.equal(result.nextRetryAt, '2026-08-04T12:01:00.000Z');
    assert.equal(after?.metadata.syncErrors?.[0].retryQueued, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function issueSummary(identifier: string): LinearIssueSummary {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: '[wavemill incident/product_defect] HOK-1: Observer crashed',
    state: { name: 'Todo' },
    labels: { nodes: [{ id: 'label-class', name: 'incident:class:product_defect' }] },
    project: { id: 'project-1', name: 'Wavemill' },
    team: { id: 'team-1', key: 'HOK', name: 'Hokusai' },
    url: `https://linear.app/hokusai/issue/${identifier}/test`,
    completedAt: null,
    canceledAt: null,
  };
}
