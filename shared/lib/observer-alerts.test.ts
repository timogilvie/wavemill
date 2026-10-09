import assert from 'node:assert/strict';
import test from 'node:test';
import { OBSERVER_ALERTS_DEFAULTS, type ObserverAlertsConfig } from './config.ts';
import {
  selectAlertsToSend,
  sendPushNotification,
  runObserverAlerts,
  type AlertFinding,
  type AlertJournal,
} from './observer-alerts.ts';

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
