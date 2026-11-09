import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OBSERVER_ALERTS_DEFAULTS, type ObserverAlertsConfig } from './config.ts';
import {
  attentionItemsToAlertFindings,
  readAttentionItemsForPush,
  selectAlertsToSend,
  sendPushNotification,
  runObserverAlerts,
  type AlertFinding,
  type AlertJournal,
} from './observer-alerts.ts';
import type { AttentionItem } from './attention.ts';

function cfg(overrides: Partial<ObserverAlertsConfig> = {}): ObserverAlertsConfig {
  return {
    ...OBSERVER_ALERTS_DEFAULTS,
    enabled: true,
    desktop: false,
    push: { ...OBSERVER_ALERTS_DEFAULTS.push },
    ...overrides,
  };
}

const base: AlertFinding = {
  id: 'finding-A',
  severity: 'high',
  title: 'something urgent',
  recommendation: 'look at it',
};

function attentionItem(overrides: Partial<AttentionItem> & Pick<AttentionItem, 'id' | 'kind'>): AttentionItem {
  return {
    since: Date.parse('2026-11-05T11:00:00Z'),
    summary: `${overrides.kind} summary`,
    evidence: [],
    commands: [],
    ...overrides,
  };
}

test('attentionItemsToAlertFindings: task items map to high findings keyed by the stable item id', () => {
  // protects: the Observer deciding loudness itself — every task kind paged at
  // high before HOK-3424 (exhaustion detector, interactive-prompt incident), so
  // the projection read must keep the same severity and dedupe identity.
  const items: AttentionItem[] = [
    attentionItem({
      id: 'HOK-1:exhausted:stage-failure-ready:abcd1234abcd',
      kind: 'exhausted',
      taskId: 'HOK-1',
      summary: 'HOK-1 exceeded its ready budget',
      evidence: [{ source: '.needs-attention', summary: 'Ready failed 3 times' }],
    }),
    attentionItem({
      id: 'HOK-2:answer-agent:prompt',
      kind: 'answer-agent',
      taskId: 'HOK-2',
      summary: 'HOK-2 is waiting on an answer',
      commands: [{ label: 'reply in pane', argv: ['answer', 'HOK-2'] }],
    }),
    // A free (non-task) signal: inbox-only, never pushed.
    attentionItem({ id: 'queue-health:degraded-inference', kind: 'queue-health', summary: 'queue degraded' }),
  ];
  const findings = attentionItemsToAlertFindings(items, { repoDir: '/repo', session: 'wavemill' });
  assert.deepEqual(findings.map((finding) => finding.id), [
    'HOK-1:exhausted:stage-failure-ready:abcd1234abcd',
    'HOK-2:answer-agent:prompt',
  ]);
  assert.deepEqual(findings.map((finding) => finding.severity), ['high', 'high']);
  assert.deepEqual(findings.map((finding) => finding.issue), ['HOK-1', 'HOK-2']);
  assert.equal(findings[0].title, 'HOK-1 exceeded its ready budget');
  assert.equal(findings[0].recommendation, 'Ready failed 3 times');
  assert.equal(findings[1].recommendation, 'reply in pane');
  assert.equal(findings[0].repoDir, '/repo');
  assert.equal(findings[0].session, 'wavemill');
});

test('attentionItemsToAlertFindings: a raw recovery command never becomes the push body', () => {
  // protects: the push body leaking the operator's absolute filesystem paths —
  // the ready-watchdog recovery command is `sh -c` with absolute paths and
  // `observer.alerts.push.url` may be a public ntfy topic (HOK-3424).
  const findings = attentionItemsToAlertFindings([
    attentionItem({
      id: 'HOK-4:operator-decision:inputs-preparation-failed:abcd',
      kind: 'operator-decision',
      taskId: 'HOK-4',
      summary: 'HOK-4 needs the operator',
      evidence: [{ source: '.needs-attention', summary: 'packet expansion failed' }],
      commands: [
        {
          label: 'npx tsx /Users/op/wavemill/tools/expand.ts --repo-dir /Users/op/wavemill --dry-run',
          argv: ['sh', '-c', 'npx tsx /Users/op/wavemill/tools/expand.ts --repo-dir /Users/op/wavemill --dry-run'],
        },
        { label: 'wavemill abort HOK-4', argv: ['wavemill', 'abort', 'HOK-4'] },
      ],
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].recommendation, 'wavemill abort HOK-4');
  assert.ok(!findings[0].recommendation.includes('/Users/op/'));
});

test('attentionItemsToAlertFindings: the journal still applies persistMinutes and repeatMinutes', () => {
  // protects: reading the projection bypassing the HOK-3097 dedupe — one
  // escalation held for persistMinutes, pushed once, not repeated before
  // repeatMinutes.
  const finding = attentionItemsToAlertFindings([
    attentionItem({ id: 'HOK-3:operator-decision:merge-residue:abcd', kind: 'operator-decision', taskId: 'HOK-3' }),
  ])[0];
  const config = cfg({ persistMinutes: 15, repeatMinutes: 60 });
  const t0 = new Date('2026-11-05T12:00:00Z');
  const t1 = new Date('2026-11-05T12:20:00Z');
  const t2 = new Date('2026-11-05T12:30:00Z');
  const held = selectAlertsToSend([finding], { findings: {} }, config, t0);
  assert.equal(held.due.length, 0);
  const sent = selectAlertsToSend([finding], held.journal, config, t1);
  assert.equal(sent.due.length, 1);
  const repeated = selectAlertsToSend([finding], sent.journal, config, t2);
  assert.equal(repeated.due.length, 0);
});

test('readAttentionItemsForPush: missing, wrong-schema, stale → no items', () => {
  // protects: push disagreeing with the inbox — the projection the dashboard
  // calls stale or pending must produce no alert.
  const root = mkdtempSync(join(tmpdir(), 'observer-push-'));
  try {
    const projectionPath = join(root, '.wavemill', 'attention.json');
    const now = new Date('2026-11-05T12:00:00Z');
    assert.deepEqual(readAttentionItemsForPush(root, now), []);

    mkdirSync(join(root, '.wavemill'), { recursive: true });
    const item = attentionItem({ id: 'HOK-4:exhausted:b:key', kind: 'exhausted', taskId: 'HOK-4' });
    writeFileSync(projectionPath, JSON.stringify({
      schemaVersion: 1,
      passStampMs: now.getTime() - 1_000,
      staleAfterMs: now.getTime() + 60_000,
      computedAt: now.toISOString(),
      items: [item],
    }));
    assert.deepEqual(readAttentionItemsForPush(root, now), [item]);

    assert.deepEqual(readAttentionItemsForPush(root, new Date(now.getTime() + 61_000)), []);

    writeFileSync(projectionPath, JSON.stringify({ schemaVersion: 2, staleAfterMs: now.getTime() + 60_000, items: [item] }));
    assert.deepEqual(readAttentionItemsForPush(root, now), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectAlertsToSend: holds back finding before persistMinutes', () => {
  const config = cfg({ persistMinutes: 15, repeatMinutes: 60 });
  const now = new Date('2026-10-02T12:00:00Z');
  const journal: AlertJournal = { findings: {} };
  const { due, journal: next } = selectAlertsToSend([base], journal, config, now);
  assert.equal(due.length, 0);
  assert.ok(next.findings!['finding-A']);
  assert.ok(!next.findings!['finding-A'].lastNotifiedAt);
});

test('selectAlertsToSend: sends once persist threshold passes', () => {
  const config = cfg({ persistMinutes: 15, repeatMinutes: 60 });
  const first = new Date('2026-10-02T12:00:00Z');
  const later = new Date('2026-10-02T12:20:00Z');
  const { journal: j1 } = selectAlertsToSend([base], { findings: {} }, config, first);
  const { due, journal: j2 } = selectAlertsToSend([base], j1, config, later);
  assert.equal(due.length, 1);
  assert.equal(due[0].finding.id, 'finding-A');
  assert.ok(j2.findings!['finding-A'].lastNotifiedAt);
});

test('selectAlertsToSend: respects repeat interval', () => {
  const config = cfg({ persistMinutes: 5, repeatMinutes: 60 });
  const t0 = new Date('2026-10-02T12:00:00Z');
  const t1 = new Date('2026-10-02T12:10:00Z');
  const t2 = new Date('2026-10-02T12:30:00Z'); // 20 min after notification
  const t3 = new Date('2026-10-02T13:30:00Z'); // 80 min after notification
  const { journal: j0 } = selectAlertsToSend([base], { findings: {} }, config, t0);
  const { journal: j1 } = selectAlertsToSend([base], j0, config, t1);
  const { due: d2, journal: j2 } = selectAlertsToSend([base], j1, config, t2);
  const { due: d3 } = selectAlertsToSend([base], j2, config, t3);
  assert.equal(d2.length, 0, 'not resend within repeatMinutes');
  assert.equal(d3.length, 1, 'resend after repeatMinutes');
});

test('selectAlertsToSend: oneShot findings skip persistMinutes but honor repeat interval (HOK-3239)', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const oneShot: AlertFinding = { ...base, id: 'one-shot', oneShot: true };
  const first = selectAlertsToSend([oneShot], { findings: {} }, cfg({ persistMinutes: 15 }), now);
  assert.equal(first.due.length, 1);
  assert.equal(first.journal.findings?.['one-shot']?.lastNotifiedAt, now.toISOString());

  const later = new Date(now.getTime() + 10 * 60_000);
  const second = selectAlertsToSend([oneShot], first.journal, cfg({ persistMinutes: 15, repeatMinutes: 240 }), later);
  assert.equal(second.due.length, 0);

  const belowFloor = selectAlertsToSend([{ ...oneShot, severity: 'medium' }], { findings: {} }, cfg(), now);
  assert.equal(belowFloor.due.length, 0);
});

test('selectAlertsToSend: medium findings never selected', () => {
  const config = cfg({ persistMinutes: 0, minSeverity: 'high' });
  const low: AlertFinding = { ...base, id: 'low-1', severity: 'medium' };
  const t = new Date();
  const { due } = selectAlertsToSend([low], { findings: {} }, config, t);
  assert.equal(due.length, 0);
});

test('selectAlertsToSend: urgent findings count under minSeverity=high', () => {
  const config = cfg({ persistMinutes: 0, minSeverity: 'high' });
  const urgent: AlertFinding = { ...base, id: 'urgent-1', severity: 'urgent' };
  const t = new Date();
  const { due } = selectAlertsToSend([urgent], { findings: {} }, config, t);
  assert.equal(due.length, 1);
});

test('selectAlertsToSend: journal prunes entries whose finding disappeared', () => {
  const config = cfg({ persistMinutes: 0 });
  const t0 = new Date('2026-10-02T12:00:00Z');
  const t1 = new Date('2026-10-02T12:10:00Z');
  const { journal: j0 } = selectAlertsToSend([base], { findings: {} }, config, t0);
  assert.ok(j0.findings!['finding-A']);
  const { journal: j1 } = selectAlertsToSend([], j0, config, t1);
  assert.ok(!j1.findings!['finding-A'], 'pruned when finding is gone');
});

test('sendPushNotification: ntfy format sets headers and body', async () => {
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    captured = { url, headers: init.headers, body: init.body };
    return { ok: true, status: 200, text: async () => '' };
  };
  const result = await sendPushNotification('https://ntfy.sh/wavemill', 'ntfy', {
    title: 'HOK-9001 stuck',
    body: 'needs attention',
    severity: 'urgent',
    tags: ['wavemill'],
  }, fakeFetch);
  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.equal(captured!.headers.Title, 'HOK-9001 stuck');
  assert.equal(captured!.headers.Priority, '5');
  assert.equal(captured!.headers.Tags, 'wavemill');
  assert.equal(captured!.body, 'needs attention');
});

test('sendPushNotification: json format sends JSON body', async () => {
  let captured: { body: string; contentType?: string } | null = null;
  const fakeFetch = async (_url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    captured = { body: init.body, contentType: init.headers['Content-Type'] };
    return { ok: true, status: 201, text: async () => '' };
  };
  const result = await sendPushNotification('https://hook.example/webhook', 'json', {
    title: 't',
    body: 'b',
    severity: 'high',
  }, fakeFetch);
  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.equal(captured!.contentType, 'application/json');
  const parsed = JSON.parse(captured!.body);
  assert.equal(parsed.title, 't');
  assert.equal(parsed.severity, 'high');
});

test('sendPushNotification: non-ok response returns ok:false', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => 'error' });
  const result = await sendPushNotification('https://nowhere', 'ntfy', {
    title: 't',
    body: 'b',
    severity: 'high',
  }, fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('runObserverAlerts: disabled → zero sent, no journal writes', async () => {
  let writes = 0;
  const result = await runObserverAlerts({
    findings: [base],
    config: cfg({ enabled: false }),
    now: new Date(),
    deps: {
      loadJournal: () => ({ findings: {} }),
      writeJournal: () => {
        writes += 1;
      },
      sendDesktop: () => ({ ok: true }),
      sendPush: async () => ({ ok: true }),
      redact: (text) => text,
    },
  });
  assert.equal(result.sent, 0);
  assert.equal(writes, 0);
});

test('runObserverAlerts: send failure produces a finding and does not throw', async () => {
  const result = await runObserverAlerts({
    findings: [base],
    config: cfg({ persistMinutes: 0, push: { url: 'https://x', format: 'ntfy' } }),
    now: new Date(),
    deps: {
      loadJournal: () => ({ findings: {} }),
      writeJournal: () => undefined,
      sendDesktop: () => ({ ok: true }),
      sendPush: async () => ({ ok: false, detail: 'network error' }),
      redact: (text) => text,
    },
  });
  assert.equal(result.dueCount, 1);
  assert.equal(result.sendFailures.length, 1);
  assert.match(result.sendFailures[0].detail, /network error/);
});
