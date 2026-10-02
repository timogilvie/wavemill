/**
 * Observer alerts (HOK-3097).
 *
 * Desktop and push notifications for urgent/high observer findings that have
 * persisted past `persistMinutes`. State lives in a JSON journal
 * (`.wavemill/observer/alert-state.json`) tracking when each finding was
 * first seen and last notified. Entries disappear when the finding resolves.
 *
 * The journal is pure data; this module takes it as input and returns the
 * next state alongside the notifications to send, so the behavior is unit-
 * testable. The `runObserverAlerts` wrapper does the IO: it loads the journal
 * with `mutateJsonStateSync`, calls the pure selector, dispatches sends, and
 * writes the next journal back.
 */

import { execFileSync } from 'node:child_process';
import type { ObserverAlertsConfig, ObserverAlertMinSeverity } from './config.ts';

export type AlertSeverity = 'urgent' | 'high' | 'medium' | 'low';

export interface AlertFinding {
  id: string;
  severity: AlertSeverity;
  title: string;
  recommendation: string;
  issue?: string;
  repoDir?: string;
  session?: string;
}

export interface AlertJournalEntry {
  firstSeenAt: string;
  lastNotifiedAt?: string;
  severity: AlertSeverity;
}

export interface AlertJournal {
  findings?: Record<string, AlertJournalEntry>;
}

export interface AlertDecision {
  finding: AlertFinding;
  firstSeenAt: string;
}

export interface SelectAlertsResult {
  due: AlertDecision[];
  journal: AlertJournal;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function meetsMinSeverity(severity: AlertSeverity, minSeverity: ObserverAlertMinSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

/**
 * Pure journal update. Caller writes the returned `journal` back and sends
 * one notification per `due` entry (bounded to `maxPerPass` by the caller
 * when that threshold is active).
 */
export function selectAlertsToSend(
  findings: AlertFinding[],
  journal: AlertJournal,
  config: ObserverAlertsConfig,
  now: Date,
): SelectAlertsResult {
  const next: AlertJournal = { findings: {} };
  const due: AlertDecision[] = [];
  const nowMs = now.getTime();

  const prev = journal.findings ?? {};
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!meetsMinSeverity(finding.severity, config.minSeverity)) continue;
    seen.add(finding.id);
    const existing = prev[finding.id];
    const firstSeenAt = existing?.firstSeenAt ?? now.toISOString();
    const firstMs = Date.parse(firstSeenAt);
    const ageMinutes = (nowMs - (Number.isFinite(firstMs) ? firstMs : nowMs)) / 60_000;

    let lastNotifiedAt = existing?.lastNotifiedAt;
    if (ageMinutes >= config.persistMinutes) {
      const lastMs = lastNotifiedAt ? Date.parse(lastNotifiedAt) : NaN;
      const sinceLastMinutes = Number.isFinite(lastMs) ? (nowMs - lastMs) / 60_000 : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(lastMs) || sinceLastMinutes >= config.repeatMinutes) {
        due.push({ finding, firstSeenAt });
        lastNotifiedAt = now.toISOString();
      }
    }

    next.findings![finding.id] = {
      firstSeenAt,
      lastNotifiedAt,
      severity: finding.severity,
    };
  }

  // Prune entries whose findings disappeared.
  for (const id of Object.keys(prev)) {
    if (!seen.has(id)) delete next.findings![id];
  }

  return { due, journal: next };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export type DesktopPlatform = 'darwin' | 'linux' | 'other';

export interface SendDesktopResult {
  ok: boolean;
  detail?: string;
}

export function detectDesktopPlatform(platform: string): DesktopPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'other';
}

export function sendDesktopNotification(
  title: string,
  body: string,
  platform: DesktopPlatform,
  runner: (file: string, args: string[]) => void = (file, args) => {
    execFileSync(file, args, { stdio: 'ignore', timeout: 5_000 });
  },
): SendDesktopResult {
  try {
    if (platform === 'darwin') {
      const safeTitle = title.replace(/"/g, '\\"');
      const safeBody = body.replace(/"/g, '\\"');
      runner('osascript', ['-e', `display notification "${safeBody}" with title "${safeTitle}"`]);
      return { ok: true };
    }
    if (platform === 'linux') {
      runner('notify-send', [title, body]);
      return { ok: true };
    }
    return { ok: false, detail: `unsupported-platform:${platform}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export interface PushPayload {
  title: string;
  body: string;
  severity: AlertSeverity;
  tags?: string[];
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SendPushResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

const PUSH_TIMEOUT_MS = 5_000;

export async function sendPushNotification(
  url: string,
  format: 'ntfy' | 'json',
  payload: PushPayload,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<SendPushResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    if (format === 'ntfy') {
      const headers: Record<string, string> = {
        'Title': payload.title,
        'Priority': payload.severity === 'urgent' ? '5' : '4',
      };
      if (payload.tags?.length) headers['Tags'] = payload.tags.join(',');
      const result = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: payload.body,
        signal: controller.signal,
      });
      return { ok: result.ok, status: result.status };
    }
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      severity: payload.severity,
      tags: payload.tags ?? [],
    });
    const result = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    return { ok: result.ok, status: result.status };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface AlertRunDeps {
  loadJournal(): AlertJournal;
  writeJournal(next: AlertJournal): void;
  sendDesktop(title: string, body: string): SendDesktopResult;
  sendPush(url: string, format: 'ntfy' | 'json', payload: PushPayload): Promise<SendPushResult>;
  redact(text: string): string;
}

export interface AlertRunResult {
  sent: number;
  sendFailures: Array<{ findingId: string; detail: string }>;
  dueCount: number;
}

const MAX_SENDS_PER_PASS = 3;

export async function runObserverAlerts(options: {
  findings: AlertFinding[];
  config: ObserverAlertsConfig;
  deps: AlertRunDeps;
  now: Date;
}): Promise<AlertRunResult> {
  const { findings, config, deps, now } = options;
  if (!config.enabled) {
    return { sent: 0, sendFailures: [], dueCount: 0 };
  }

  const journal = deps.loadJournal();
  const { due, journal: nextJournal } = selectAlertsToSend(findings, journal, config, now);
  deps.writeJournal(nextJournal);

  if (due.length === 0) {
    return { sent: 0, sendFailures: [], dueCount: 0 };
  }

  // Fold many due findings into one summary when over the pass ceiling.
  let toSend: Array<{ title: string; body: string; severity: AlertSeverity; id: string; tags?: string[] }>;
  if (due.length > MAX_SENDS_PER_PASS) {
    const highest = due.reduce<AlertSeverity>((max, entry) => (SEVERITY_RANK[entry.finding.severity] > SEVERITY_RANK[max] ? entry.finding.severity : max), 'low');
    toSend = [{
      id: `observer-alerts-summary-${now.toISOString()}`,
      title: `Wavemill: ${due.length} ${config.minSeverity}+ findings persisting`,
      body: deps.redact(due.map((d) => `• ${d.finding.title}`).join('\n')),
      severity: highest,
      tags: ['wavemill-observer', 'summary'],
    }];
  } else {
    toSend = due.map((entry) => ({
      id: entry.finding.id,
      title: deps.redact(`[${entry.finding.severity}] ${entry.finding.title}`),
      body: deps.redact(entry.finding.recommendation),
      severity: entry.finding.severity,
      tags: ['wavemill-observer', entry.finding.severity],
    }));
  }

  const failures: AlertRunResult['sendFailures'] = [];
  let sent = 0;

  for (const notification of toSend) {
    let anyOk = false;
    if (config.desktop) {
      const platform = detectDesktopPlatform(process.platform);
      const result = deps.sendDesktop(notification.title, notification.body);
      if (result.ok) anyOk = true;
      else if (platform !== 'other') failures.push({ findingId: notification.id, detail: `desktop: ${result.detail ?? 'unknown'}` });
    }
    if (config.push.url) {
      const result = await deps.sendPush(config.push.url, config.push.format, {
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        tags: notification.tags,
      });
      if (result.ok) anyOk = true;
      else failures.push({ findingId: notification.id, detail: `push: ${result.detail ?? `status ${result.status ?? 'unknown'}`}` });
    }
    if (anyOk) sent += 1;
  }

  return { sent, sendFailures: failures, dueCount: due.length };
}
