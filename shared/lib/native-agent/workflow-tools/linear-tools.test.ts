/**
 * Fixture-backed tests for the three Linear native workflow tools.
 *
 * No live network calls — all Linear API interactions are replaced by fakes
 * that replay data from the fixtures/ directory.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executeLinearGetIssue,
  executeLinearComment,
  executeExpandIssue,
  type LinearClient,
  type LinearToolsDeps,
  type WorkflowToolTranscriptEvent,
  type WorkflowToolStageArtifactEntry,
} from './linear-tools.ts';
import { createInMemoryDedupeRegistry } from './dedupe.ts';
import type { NetworkPolicy } from '../network-policy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/linear');
const ALLOW_LINEAR_NETWORK_POLICY: NetworkPolicy = {
  planning: {
    linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
    expand_issue: { kind: 'allow' },
  },
  coding: {
    linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
    expand_issue: { kind: 'allow' },
  },
  review: {
    linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
    expand_issue: { kind: 'allow' },
  },
  ready: {
    linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
    expand_issue: { kind: 'allow' },
  },
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Fake client helpers
// ---------------------------------------------------------------------------

type IssueFixture = ReturnType<typeof loadFixture> & {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state?: { name: string };
  assignee?: { name: string };
  labels?: { nodes: Array<{ id: string; name: string }> };
  url?: string;
};

function makeFakeClient(opts: {
  issue?: IssueFixture | null | 'throw';
  comment?: { id: string; url: string } | 'throw';
  updateComment?: { id: string; url: string } | 'throw';
} = {}): LinearClient & { createCallCount: number; updateCallCount: number } {
  let createCallCount = 0;
  let updateCallCount = 0;
  const client = {
    get createCallCount() { return createCallCount; },
    get updateCallCount() { return updateCallCount; },
    async getIssue(identifier: string) {
      const target = opts.issue ?? (loadFixture('issue-hok-1.json') as IssueFixture);
      if (target === 'throw') throw new Error(`Issue not found: ${identifier}`);
      if (target === null) throw new Error(`Issue not found: ${identifier}`);
      return target as IssueFixture;
    },
    async createComment(_issueId: string, _body: string) {
      createCallCount++;
      const result = opts.comment ?? (loadFixture('comment-created.json') as { id: string; url: string });
      if (result === 'throw') throw new Error('Linear API error on createComment');
      return result as { id: string; url: string };
    },
    async updateComment(_commentId: string, _body: string) {
      updateCallCount++;
      const result = opts.updateComment ?? (loadFixture('comment-updated.json') as { id: string; url: string });
      if (result === 'throw') throw new Error('Linear API error on updateComment');
      return result as { id: string; url: string };
    },
  };
  return client;
}

function makeDeps(overrides: Partial<LinearToolsDeps> & { client?: LinearClient } = {}): LinearToolsDeps & {
  transcriptEvents: WorkflowToolTranscriptEvent[];
  stageArtifactEntries: WorkflowToolStageArtifactEntry[];
} {
  const transcriptEvents: WorkflowToolTranscriptEvent[] = [];
  const stageArtifactEntries: WorkflowToolStageArtifactEntry[] = [];
  return {
    client: overrides.client ?? makeFakeClient(),
    registry: overrides.registry ?? createInMemoryDedupeRegistry({ clock: () => 1_000 }),
    transcript: { append(e) { transcriptEvents.push(e); } },
    stageArtifact: { append(e) { stageArtifactEntries.push(e); } },
    sessionId: overrides.sessionId ?? 'sess-test-1',
    phase: overrides.phase ?? 'coding',
    expander: overrides.expander,
    clock: overrides.clock ?? (() => 1_000),
    networkPolicy: overrides.networkPolicy ?? ALLOW_LINEAR_NETWORK_POLICY,
    getSecretEnvNames: overrides.getSecretEnvNames,
    // Pin identity metadata so tests never read a live workflow-state file.
    taskMeta: overrides.taskMeta !== undefined ? overrides.taskMeta : null,
    transcriptEvents,
    stageArtifactEntries,
  };
}

// ---------------------------------------------------------------------------
// REQ-F1: linear_get_issue
// ---------------------------------------------------------------------------

describe('linear_get_issue: success path', () => {
  it('returns normalized issue shape from fixture', async () => {
    const deps = makeDeps();
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.ok(result.ok, `expected ok:true, got ${JSON.stringify(result)}`);
    assert.equal(result.tool, 'linear_get_issue');
    assert.equal(result.issue.identifier, 'HOK-1');
    assert.equal(result.issue.id, 'abc123-uuid');
    assert.equal(typeof result.issue.title, 'string');
    assert.equal(result.metadata?.trust?.sourceKind, 'issue');
    assert.equal(result.metadata?.trust?.trust, 'untrusted');
  });

  it('flattens state object to string', async () => {
    const deps = makeDeps();
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.ok(result.ok);
    assert.equal(result.issue.state, 'In Progress');
  });

  it('flattens assignee object to string', async () => {
    const deps = makeDeps();
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.ok(result.ok);
    assert.equal(result.issue.assignee, 'Tim Ogilvie');
  });

  it('flattens labels nodes to string array', async () => {
    const deps = makeDeps();
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.ok(result.ok);
    assert.deepEqual(result.issue.labels, ['epic']);
  });

  it('appends one transcript event per call', async () => {
    const deps = makeDeps();
    await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.equal(deps.transcriptEvents.length, 1);
    assert.equal(deps.transcriptEvents[0].tool, 'linear_get_issue');
    assert.equal(deps.transcriptEvents[0].phase, 'coding');
  });

  it('does not append stage-artifact entry for read-only tool', async () => {
    const deps = makeDeps();
    await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.equal(deps.stageArtifactEntries.length, 0);
  });
});

describe('linear_get_issue: error paths', () => {
  it('REQ-F1 edge: not-found error when issue does not exist', async () => {
    const deps = makeDeps({ client: makeFakeClient({ issue: 'throw' }) });
    const result = await executeLinearGetIssue({ issue: 'HOK-999' }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.tool, 'linear_get_issue');
    assert.ok(!result.ok);
    assert.equal(result.error, 'not_found');
    assert.ok(result.message.includes('not found') || result.message.includes('HOK-999'));
  });

  it('REQ-F1 edge: external_error for non-not-found API error', async () => {
    const client = makeFakeClient();
    client.getIssue = async (_id: string) => { throw new Error('Network timeout'); };
    const deps = makeDeps({ client });
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error, 'external_error');
  });

  it('still appends transcript event on error', async () => {
    const deps = makeDeps({ client: makeFakeClient({ issue: 'throw' }) });
    const result = await executeLinearGetIssue({ issue: 'HOK-99' }, deps);
    assert.equal(deps.transcriptEvents.length, 1);
    assert.equal(result.metadata?.trust?.sourceKind, 'issue');
  });
});

describe('linear_get_issue: ready phase allows reads', () => {
  it('REQ-F5 edge: linear_get_issue succeeds in ready phase', async () => {
    const deps = makeDeps({ phase: 'ready' });
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.ok(result.ok);
  });

  it('denies when the network policy is missing for the phase/tool', async () => {
    const deps = makeDeps({ phase: 'coding', networkPolicy: {} });
    const result = await executeLinearGetIssue({ issue: 'HOK-1' }, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error, 'policy_denied');
    assert.equal((result.diagnostics as { category: string; reason: string }).category, 'network');
    assert.equal((result.diagnostics as { reason: string }).reason, 'missing_policy');
  });
});

// ---------------------------------------------------------------------------
// REQ-F2 / REQ-F3: linear_comment
// ---------------------------------------------------------------------------

describe('linear_comment: task identity gate (HOK-3115)', () => {
  it('challenger task ID is a skipped no-op that never touches the Linear client', async () => {
    const client = makeFakeClient();
    let getIssueCalls = 0;
    const countingClient: LinearClient = {
      ...client,
      async getIssue(identifier: string) {
        getIssueCalls++;
        return client.getIssue(identifier);
      },
    };
    const deps = makeDeps({ client: countingClient, taskMeta: { linearIssueId: 'HOK-1' } });
    const result = await executeLinearComment(
      { issue: 'HOK-1_c', body: 'Review summary', sessionId: 'sess-1', phase: 'coding' },
      deps,
    );
    assert.ok(result.ok, `expected ok:true, got ${JSON.stringify(result)}`);
    assert.equal(result.ok && result.idempotency.outcome, 'skipped');
    assert.equal(result.ok && result.idempotency.ref, null);
    assert.equal(getIssueCalls, 0);
    assert.equal(client.createCallCount, 0);
    assert.equal(deps.stageArtifactEntries[0]?.idempotency.outcome, 'skipped');
  });

  it('primary-shaped ID whose metadata records challengeRole=challenger is skipped', async () => {
    const client = makeFakeClient();
    const deps = makeDeps({ client, taskMeta: { challengeRole: 'challenger' } });
    const result = await executeLinearComment(
      { issue: 'HOK-1', body: 'Review summary', sessionId: 'sess-1', phase: 'coding' },
      deps,
    );
    assert.ok(result.ok && result.idempotency.outcome === 'skipped');
    assert.equal(client.createCallCount, 0);
  });

  it('invalid or conflicting task IDs fail closed without a Linear call', async () => {
    for (const [issue, taskMeta] of [['hok-1', null], ['HOK-1', { linearIssueId: 'HOK-2' }]] as const) {
      const client = makeFakeClient();
      const deps = makeDeps({ client, taskMeta });
      const result = await executeLinearComment(
        { issue, body: 'Review summary', sessionId: 'sess-1', phase: 'coding' },
        deps,
      );
      assert.equal(result.ok, false, `${issue} should fail closed`);
      assert.equal(!result.ok && result.error, 'invalid_input');
      assert.equal(client.createCallCount, 0);
    }
  });
});

describe('linear_comment: created → reused → updated sequence', () => {
  it('REQ-F2: first call creates, second identical call is reused (createComment spy = 1)', async () => {
    const client = makeFakeClient();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const deps1 = makeDeps({ client, registry, phase: 'coding' });
    const params = { issue: 'HOK-1', body: 'Progress update', sessionId: 'sess-1', phase: 'coding' as const };

    const r1 = await executeLinearComment(params, deps1);
    assert.ok(r1.ok);
    assert.ok(r1.ok && r1.idempotency.outcome === 'created', 'first call should be created');

    const deps2 = makeDeps({ client, registry, phase: 'coding' });
    const r2 = await executeLinearComment(params, deps2);
    assert.ok(r2.ok);
    assert.ok(r2.ok && r2.idempotency.outcome === 'reused', 'second call should be reused');

    assert.equal(client.createCallCount, 1, 'createComment should only be called once');
  });

  it('REQ-F3: third call with changed body triggers update via new registry entry with new key', async () => {
    const client = makeFakeClient();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const baseParams = { issue: 'HOK-1', body: 'Original body', sessionId: 'sess-1', phase: 'coding' as const };
    const deps = makeDeps({ client, registry, phase: 'coding' });

    const r1 = await executeLinearComment(baseParams, deps);
    assert.ok(r1.ok && r1.idempotency.outcome === 'created');

    // Changed body → different content hash → different key → new create
    const updatedParams = { ...baseParams, body: 'Updated body content' };
    const deps2 = makeDeps({ client, registry, phase: 'coding' });
    const r2 = await executeLinearComment(updatedParams, deps2);
    assert.ok(r2.ok);
    // Since body changed, the key is different → new 'created' entry
    assert.ok(r2.ok && (r2.idempotency.outcome === 'created' || r2.idempotency.outcome === 'updated'));
    // createComment was called for both (different keys)
    assert.equal(client.createCallCount, 2);
  });
});

describe('linear_comment: idempotency edge cases', () => {
  it('REQ-F2 edge: different sessionId produces different key → both are created', async () => {
    const client = makeFakeClient();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const params1 = { issue: 'HOK-1', body: 'Same body', sessionId: 'sess-1', phase: 'coding' as const };
    const params2 = { issue: 'HOK-1', body: 'Same body', sessionId: 'sess-2', phase: 'coding' as const };

    const deps1 = makeDeps({ client, registry, phase: 'coding' });
    const deps2 = makeDeps({ client, registry, phase: 'coding' });

    const r1 = await executeLinearComment(params1, deps1);
    const r2 = await executeLinearComment(params2, deps2);

    assert.ok(r1.ok && r1.idempotency.outcome === 'created');
    assert.ok(r2.ok && r2.idempotency.outcome === 'created');
    assert.equal(client.createCallCount, 2);
  });

  it('REQ-F2 edge: whitespace normalization → trailing space is treated as reused', async () => {
    const client = makeFakeClient();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const params1 = { issue: 'HOK-1', body: 'Body A', sessionId: 'sess-1', phase: 'coding' as const };
    const params2 = { issue: 'HOK-1', body: 'Body A ', sessionId: 'sess-1', phase: 'coding' as const };

    const deps1 = makeDeps({ client, registry, phase: 'coding' });
    await executeLinearComment(params1, deps1);

    const deps2 = makeDeps({ client, registry, phase: 'coding' });
    const r2 = await executeLinearComment(params2, deps2);
    assert.ok(r2.ok && r2.idempotency.outcome === 'reused', 'whitespace-only difference should be reused');
    assert.equal(client.createCallCount, 1);
  });

  it('REQ-F6: identical args → identical key string; changed phase → different key', async () => {
    const client = makeFakeClient();
    const reg1 = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const reg2 = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const params = { issue: 'HOK-1', body: 'Test', sessionId: 'sess-1', phase: 'coding' as const };
    const paramsPlanning = { ...params, phase: 'planning' as const };

    const deps1 = makeDeps({ client, registry: reg1, phase: 'coding' });
    const deps2 = makeDeps({ client, registry: reg2, phase: 'planning' });

    const r1 = await executeLinearComment(params, deps1);
    const r2 = await executeLinearComment(params, makeDeps({ client, registry: reg1, phase: 'coding' }));
    const r3 = await executeLinearComment(paramsPlanning, deps2);

    assert.ok(r1.ok && r1.idempotency.key === (r2.ok ? r2.idempotency.key : ''), 'same args → same key');
    assert.ok(r1.ok && r3.ok && r1.idempotency.key !== r3.idempotency.key, 'different phase → different key');
  });
});

describe('linear_comment: phase policy gate', () => {
  it('REQ-F5: ready phase denies linear_comment (policy_denied, no create call, registry untouched)', async () => {
    const client = makeFakeClient();
    const registry = createInMemoryDedupeRegistry();
    const deps = makeDeps({ client, registry, phase: 'ready' });
    const params = { issue: 'HOK-1', body: 'Denied comment', sessionId: 'sess-1', phase: 'ready' as const };

    const result = await executeLinearComment(params, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error, 'policy_denied');
    assert.equal(client.createCallCount, 0);
    assert.equal(registry.size(), 0);
  });

  it('REQ-F5 edge: denial then allowed phase → created (registry was untouched)', async () => {
    const client = makeFakeClient();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const readyDeps = makeDeps({ client, registry, phase: 'ready' });
    await executeLinearComment({ issue: 'HOK-1', body: 'Test', sessionId: 'sess-1', phase: 'ready' }, readyDeps);
    assert.equal(registry.size(), 0);

    const codingDeps = makeDeps({ client, registry, phase: 'coding' });
    const r2 = await executeLinearComment({ issue: 'HOK-1', body: 'Test', sessionId: 'sess-1', phase: 'coding' }, codingDeps);
    assert.ok(r2.ok && r2.idempotency.outcome === 'created');
    assert.equal(client.createCallCount, 1);
  });

  it('REQ-F7: policy-denied still appends transcript + stage-artifact entries', async () => {
    const deps = makeDeps({ phase: 'ready' });
    await executeLinearComment({ issue: 'HOK-1', body: 'x', sessionId: 'sess-1', phase: 'ready' }, deps);
    assert.equal(deps.transcriptEvents.length, 1);
    assert.equal(deps.stageArtifactEntries.length, 1);
  });

  it('denies coding-phase network access before calling Linear', async () => {
    const client = makeFakeClient();
    const deps = makeDeps({
      client,
      phase: 'coding',
      networkPolicy: {
        coding: {
          linear_comment: { kind: 'deny' },
        },
      },
    });
    const result = await executeLinearComment(
      { issue: 'HOK-1', body: 'Denied by network policy', sessionId: 'sess-1', phase: 'coding' },
      deps,
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error, 'policy_denied');
    assert.equal(client.createCallCount, 0);
    assert.equal((result.diagnostics as { category: string; reason: string }).category, 'network');
    assert.equal((result.diagnostics as { reason: string }).reason, 'not_allowed');
  });
});

describe('linear_comment: observability', () => {
  it('REQ-F7: one transcript AND one stage-artifact entry per allowed mutation call', async () => {
    const deps = makeDeps({ phase: 'coding' });
    await executeLinearComment({ issue: 'HOK-1', body: 'Hello', sessionId: 'sess-1', phase: 'coding' }, deps);
    assert.equal(deps.transcriptEvents.length, 1);
    assert.equal(deps.stageArtifactEntries.length, 1);
  });

  it('transcript event includes idempotency key and outcome', async () => {
    const deps = makeDeps({ phase: 'coding' });
    await executeLinearComment({ issue: 'HOK-1', body: 'Hello', sessionId: 'sess-1', phase: 'coding' }, deps);
    const ev = deps.transcriptEvents[0];
    assert.ok(ev.idempotency, 'transcript event should include idempotency');
    assert.ok(ev.idempotency?.key?.startsWith('linear_comment:'));
    assert.equal(ev.idempotency?.outcome, 'created');
  });

  it('transcript event does not contain raw comment body', async () => {
    const deps = makeDeps({ phase: 'coding' });
    const secretBody = 'super secret message xyz';
    await executeLinearComment({ issue: 'HOK-1', body: secretBody, sessionId: 'sess-1', phase: 'coding' }, deps);
    const eventStr = JSON.stringify(deps.transcriptEvents);
    assert.equal(eventStr.includes(secretBody), false, 'raw body must not appear in transcript');
  });
});

// ---------------------------------------------------------------------------
// REQ-F4: expand_issue
// ---------------------------------------------------------------------------

describe('expand_issue: created → reused → updated sequence', () => {
  it('REQ-F4: first expansion is created, second identical call is reused', async () => {
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    let expanderCallCount = 0;
    const expander = async () => {
      expanderCallCount++;
      return '/features/hok-1/task-packet.md';
    };

    const deps1 = makeDeps({ registry, phase: 'planning', expander, sessionId: 'sess-1' });
    const r1 = await executeExpandIssue({ issue: 'HOK-1' }, deps1);
    assert.ok(r1.ok);
    assert.ok(r1.ok && r1.idempotency?.outcome === 'created');
    assert.equal(expanderCallCount, 1);

    const deps2 = makeDeps({ registry, phase: 'planning', expander, sessionId: 'sess-1' });
    const r2 = await executeExpandIssue({ issue: 'HOK-1' }, deps2);
    assert.ok(r2.ok);
    assert.ok(r2.ok && r2.idempotency?.outcome === 'reused');
    assert.equal(expanderCallCount, 1, 'expander should not be called again on reuse');
  });

  it('REQ-F4 edge: empty expansion output → expansion_failed error', async () => {
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const expander = async () => '';
    const deps = makeDeps({ registry, phase: 'planning', expander, sessionId: 'sess-1' });
    const result = await executeExpandIssue({ issue: 'HOK-1' }, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error === 'expansion_failed');
  });

  it('REQ-F4 edge: expander throwing → expansion_failed error', async () => {
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const expander = async () => { throw new Error('LLM unavailable'); };
    const deps = makeDeps({ registry, phase: 'planning', expander, sessionId: 'sess-1' });
    const result = await executeExpandIssue({ issue: 'HOK-1' }, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error === 'expansion_failed');
    assert.ok(result.message.includes('LLM unavailable'));
  });
});

describe('expand_issue: phase policy gate', () => {
  it('REQ-F5: ready phase denies expand_issue (policy_denied, no expander call)', async () => {
    const registry = createInMemoryDedupeRegistry();
    let expanderCallCount = 0;
    const expander = async () => { expanderCallCount++; return '/some/path.md'; };
    const deps = makeDeps({ registry, phase: 'ready', expander, sessionId: 'sess-1' });
    const result = await executeExpandIssue({ issue: 'HOK-1' }, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error === 'policy_denied');
    assert.equal(expanderCallCount, 0);
    assert.equal(registry.size(), 0);
  });

  it('REQ-F5 edge: expand_issue denied in ready, then allowed in planning → created', async () => {
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    let expanderCallCount = 0;
    const expander = async () => { expanderCallCount++; return '/features/hok-1/task-packet.md'; };

    const readyDeps = makeDeps({ registry, phase: 'ready', expander, sessionId: 'sess-1' });
    await executeExpandIssue({ issue: 'HOK-1' }, readyDeps);
    assert.equal(registry.size(), 0);

    const planningDeps = makeDeps({ registry, phase: 'planning', expander, sessionId: 'sess-1' });
    const r2 = await executeExpandIssue({ issue: 'HOK-1' }, planningDeps);
    assert.ok(r2.ok && r2.idempotency?.outcome === 'created');
    assert.equal(expanderCallCount, 1);
  });

  it('no expander provided → expansion_failed error', async () => {
    const deps = makeDeps({ phase: 'planning', sessionId: 'sess-1' }); // no expander
    const result = await executeExpandIssue({ issue: 'HOK-1' }, deps);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error === 'expansion_failed');
  });

  it('returns policy_denied with network diagnostics when command-network access is denied', async () => {
    let expanderCallCount = 0;
    const deps = makeDeps({
      phase: 'planning',
      sessionId: 'sess-1',
      expander: async () => {
        expanderCallCount++;
        return '/features/hok-1/task-packet.md';
      },
      networkPolicy: {
        planning: {
          expand_issue: { kind: 'deny' },
        },
      },
    });
    const result = await executeExpandIssue({ issue: 'HOK-1' }, deps);

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error, 'policy_denied');
    assert.equal(expanderCallCount, 0);
    assert.equal((result.diagnostics as { category: string }).category, 'network');
  });
});

describe('expand_issue: observability', () => {
  it('REQ-F7: records transcript event but no stage-artifact (read-only tool)', async () => {
    const expander = async () => '/features/hok-1/task-packet.md';
    const deps = makeDeps({ phase: 'planning', expander, sessionId: 'sess-1' });
    await executeExpandIssue({ issue: 'HOK-1' }, deps);
    assert.equal(deps.transcriptEvents.length, 1);
    assert.equal(deps.stageArtifactEntries.length, 0, 'expand_issue is a read-only tool and should not write stage artifacts');
  });

  it('transcript event includes idempotency data on success', async () => {
    const expander = async () => '/features/hok-1/task-packet.md';
    const deps = makeDeps({ phase: 'planning', expander, sessionId: 'sess-1' });
    await executeExpandIssue({ issue: 'HOK-1' }, deps);
    const ev = deps.transcriptEvents[0];
    assert.ok(ev.idempotency, 'should have idempotency in transcript');
    assert.ok(ev.idempotency?.key?.startsWith('expand_issue:'));
    assert.equal(ev.idempotency?.outcome, 'created');
  });
});

// ---------------------------------------------------------------------------
// REQ-F6: idempotency-key stability across tools
// ---------------------------------------------------------------------------

describe('idempotency key stability', () => {
  it('REQ-F6: expand_issue key is stable — identical args produce same key', async () => {
    const keys: string[] = [];
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    let first = true;
    const expander = async () => {
      if (first) { first = false; return '/features/hok-1/task-packet.md'; }
      return '/features/hok-1/task-packet.md';
    };

    for (let i = 0; i < 2; i++) {
      const deps = makeDeps({ registry, phase: 'planning', expander, sessionId: 'sess-1' });
      const r = await executeExpandIssue({ issue: 'HOK-1' }, deps);
      if (r.ok && r.idempotency) keys.push(r.idempotency.key);
    }

    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'key must be stable across calls');
  });
});

// ---------------------------------------------------------------------------
// Secret redaction in linear_comment
// ---------------------------------------------------------------------------

describe('linear_comment: secret redaction', () => {
  it('records redacted body via createComment when body contains a secret token', async () => {
    let capturedBody: string | undefined;
    const client = makeFakeClient({
      comment: { id: 'cmt-redact-1', url: 'https://linear.app/hok/comment/cmt-redact-1' },
    });
    client.createComment = async (_issueId: string, body: string) => {
      capturedBody = body;
      return { id: 'cmt-redact-1', url: 'https://linear.app/hok/comment/cmt-redact-1' };
    };

    const token = 'sk-testFAKEKEY12345678901234567890';
    const deps = makeDeps({ client, phase: 'review' });
    const result = await executeLinearComment(
      { issue: 'HOK-1', body: `Review complete. Token used: ${token}`, sessionId: 'sess-1', phase: 'review' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.ok(capturedBody !== undefined, 'createComment must have been called');
    assert.ok(!capturedBody.includes(token), 'original token must not appear in comment body');
    assert.ok(capturedBody.includes('[REDACTED:openai_key]'), 'redacted placeholder must appear');
  });

  it('records redacted body via createComment when body contains a configured secret env value', async () => {
    let capturedBody: string | undefined;
    process.env.HOKUSAI_LINEAR_SECRET = 'linear-configured-value-without-known-pattern';
    const client = makeFakeClient({
      comment: { id: 'cmt-redact-2', url: 'https://linear.app/hok/comment/cmt-redact-2' },
    });
    client.createComment = async (_issueId: string, body: string) => {
      capturedBody = body;
      return { id: 'cmt-redact-2', url: 'https://linear.app/hok/comment/cmt-redact-2' };
    };

    const deps = makeDeps({
      client,
      phase: 'review',
      getSecretEnvNames: () => ['HOKUSAI_LINEAR_SECRET'],
    });

    try {
      const result = await executeLinearComment(
        {
          issue: 'HOK-1',
          body: 'Secret: linear-configured-value-without-known-pattern',
          sessionId: 'sess-1',
          phase: 'review',
        },
        deps,
      );

      assert.equal(result.ok, true);
      assert.ok(capturedBody !== undefined, 'createComment must have been called');
      assert.equal(capturedBody, 'Secret: [REDACTED:configured_secret]');
    } finally {
      delete process.env.HOKUSAI_LINEAR_SECRET;
    }
  });
});
