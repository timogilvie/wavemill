import assert from 'node:assert/strict';
import test from 'node:test';
import type { AliasAuditFinding, AliasAuditReport } from './openrouter-alias-audit.ts';
import {
  DRIFT_ISSUE_PRIORITY,
  DRIFT_ISSUE_TITLE,
  persistentDriftFindings,
  readDriftFingerprint,
  renderDriftIssueDescription,
  syncDriftIssue,
  type DriftIssueClient,
  type DriftIssueRef,
} from './openrouter-drift-issue.ts';

function finding(alias: string, overrides: Partial<AliasAuditFinding> = {}): AliasAuditFinding {
  return {
    alias,
    providerNativeId: `vendor/${alias}`,
    wireModelId: `vendor/${alias}`,
    reason: 'pricing-drift',
    lifecycle: 'supported',
    selectable: true,
    detail: 'cacheReadPerMTok drift | registry null understates 0.17',
    expected: 0.17,
    actual: null,
    ...overrides,
  };
}

function report(findings: AliasAuditFinding[], generatedAt = '2026-11-19T12:00:00.000Z'): AliasAuditReport {
  return { schemaVersion: '2', generatedAt, catalogSource: 'live', checked: 24, findings, selectableFindings: findings.filter((f) => f.selectable).length };
}

/** An in-memory Linear: records every write so a test can assert none happened. */
function fakeLinear(open: DriftIssueRef | null = null) {
  const writes: string[] = [];
  const state = { open };
  const client: DriftIssueClient = {
    async findOpenIssue(title) {
      assert.equal(title, DRIFT_ISSUE_TITLE);
      return state.open;
    },
    async fileIssue(input) {
      writes.push(`create:${input.priority}`);
      state.open = { id: 'id-1', identifier: 'HOK-9001', description: input.description };
      return state.open;
    },
    async updateDescription(issueId, description) {
      writes.push(`update:${issueId}`);
      state.open = { ...state.open!, description };
    },
  };
  return { client, writes, state };
}

test('only selectable findings seen in both audits persist', () => {
  const previous = report([finding('maverick'), finding('flapper'), finding('retired', { selectable: false })]);
  const current = report([finding('maverick'), finding('newcomer'), finding('retired', { selectable: false })]);

  assert.deepEqual(persistentDriftFindings(current, previous).map((f) => f.alias), ['maverick']);
  assert.deepEqual(persistentDriftFindings(current, null), [], 'a first observation is never filed');
  assert.deepEqual(
    persistentDriftFindings(report([finding('maverick', { reason: 'not-found-in-openrouter' })]), previous),
    [],
    'a different finding on the same alias is a new observation',
  );
});

test('persistent drift creates one High-priority issue, then stays quiet while nothing changes', async () => {
  const linear = fakeLinear();
  const findings = [finding('maverick')];

  const first = await syncDriftIssue({ findings, auditedAt: '2026-11-19T12:00:00.000Z', client: linear.client });
  assert.deepEqual(first, { action: 'created', identifier: 'HOK-9001' });
  assert.deepEqual(linear.writes, [`create:${DRIFT_ISSUE_PRIORITY}`]);
  assert.match(linear.state.open!.description!, /`maverick`.*pricing-drift/);
  assert.match(linear.state.open!.description!, /drift \\\| registry/, 'table cells escape pipes');

  const second = await syncDriftIssue({ findings, auditedAt: '2026-11-19T16:00:00.000Z', client: linear.client });
  assert.deepEqual(second, { action: 'unchanged', identifier: 'HOK-9001' });
  assert.equal(linear.writes.length, 1, 'a later audit of the same drift writes nothing');
});

test('a changed finding set rewrites the open issue instead of filing a second one', async () => {
  const linear = fakeLinear();
  await syncDriftIssue({ findings: [finding('maverick')], auditedAt: 't1', client: linear.client });

  const moved = await syncDriftIssue({ findings: [finding('maverick', { expected: 0.2 })], auditedAt: 't2', client: linear.client });
  const grown = await syncDriftIssue({ findings: [finding('maverick', { expected: 0.2 }), finding('qwen')], auditedAt: 't3', client: linear.client });

  assert.equal(moved.action, 'updated');
  assert.equal(grown.action, 'updated');
  assert.deepEqual(linear.writes, ['create:2', 'update:id-1', 'update:id-1']);
  assert.match(linear.state.open!.description!, /`qwen`/);
});

test('no drift writes nothing, with or without an open issue', async () => {
  const empty = fakeLinear();
  assert.deepEqual(await syncDriftIssue({ findings: [], auditedAt: 't', client: empty.client }), { action: 'none', reason: 'no-persistent-drift' });

  const open = fakeLinear({ id: 'id-1', identifier: 'HOK-9001', description: 'being worked on' });
  assert.deepEqual(await syncDriftIssue({ findings: [], auditedAt: 't', client: open.client }), { action: 'left-open', identifier: 'HOK-9001', reason: 'drift-cleared' });
  assert.deepEqual([...empty.writes, ...open.writes], []);
});

test('an open issue edited by hand, without the marker, is rewritten once', async () => {
  const linear = fakeLinear({ id: 'id-1', identifier: 'HOK-9001', description: 'someone replaced the body' });
  assert.equal(readDriftFingerprint(linear.state.open!.description), null);

  assert.equal((await syncDriftIssue({ findings: [finding('maverick')], auditedAt: 't', client: linear.client })).action, 'updated');
  assert.equal((await syncDriftIssue({ findings: [finding('maverick')], auditedAt: 't', client: linear.client })).action, 'unchanged');
  assert.equal(readDriftFingerprint(renderDriftIssueDescription([finding('maverick')], 't')), 'maverick:pricing-drift:0.17:');
});
