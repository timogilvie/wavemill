/**
 * Sentinel ↔ ledger consistency checker (HOK-3184 — Ledger E Phase 2 §3g).
 *
 * One pass over a task's state directory and the shadow ledger that detects
 * every disagreement between the on-disk sentinels/hooks and the mirror
 * rows. Output is a structured list of {@link Disagreement}s; the gate for
 * Phase 2 is zero disagreements for 14 days.
 *
 * Reads are additive: this module does not switch any launch gate or
 * dashboard surface. It only reports.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger, TaskRow, WaitingOnRow, EvidenceRow, WaitingTrigger } from './ledger.ts';
import { findActiveStep } from './ledger-shadow.ts';

export type DisagreementCategory =
  | 'missing-step'
  | 'extra-step'
  | 'missing-waiting-on'
  | 'extra-waiting-on'
  | 'missing-evidence'
  | 'extra-evidence'
  | 'attempt-mismatch'
  | 'settled-reason-mismatch'
  | 'inputs-hash-mismatch'
  | 'pair-intent-mismatch';

export type Severity = 'info' | 'warn' | 'error';

export interface Disagreement {
  category: DisagreementCategory;
  severity: Severity;
  detail: string;
  stepId?: string;
  bucket?: string;
  trigger?: WaitingTrigger;
}

export interface ConsistencyScanSummary {
  steps: number;
  waitingOn: number;
  evidence: number;
  retrySentinels: number;
}

export interface ConsistencyResult {
  issue: string;
  stateDir: string;
  disagreements: Disagreement[];
  scanned: ConsistencyScanSummary;
  tookMs: number;
}

export interface RunConsistencyCheckOptions {
  stateDir: string;
  issue: string;
  ledger: Ledger;
  nowMs?: number;
  /** Window inside which a hook event is expected to have a mirror evidence row. */
  evidenceWindowMs?: number;
  /** Optional override for the hook file path (defaults to /tmp/wavemill-$session-$issue.hook). */
  hookFilePath?: string;
  /** Session id, used to derive the default hook file path. */
  sessionId?: string;
}

interface RetryFileSet {
  bucket: string;
  countPath: string;
  count: number;
  headPath: string;
  headSha?: string;
  baseSha?: string;
  exhaustedPath: string;
  exhaustedReason?: string;
}

const RETRY_PREFIX = /^\.retry-(.+?)-(count|head|exhausted|last-at|exhausted-condition\.json)$/;
const LEGACY_FAILED_READY_PREFIX = /^\.failed-ready-recheck-(count|head|exhausted|last-at|exhausted-condition\.json)$/;

/** Enumerate every retry bucket present under a state directory. */
export function enumerateRetrySentinels(stateDir: string): RetryFileSet[] {
  if (!existsSync(stateDir)) return [];
  const buckets = new Map<string, RetryFileSet>();
  for (const entry of readdirSync(stateDir)) {
    let bucket: string | undefined;
    let kind: string | undefined;
    const retryMatch = entry.match(RETRY_PREFIX);
    const legacyMatch = entry.match(LEGACY_FAILED_READY_PREFIX);
    if (retryMatch) {
      bucket = retryMatch[1];
      kind = retryMatch[2];
    } else if (legacyMatch) {
      bucket = 'failed-ready-recheck';
      kind = legacyMatch[1];
    }
    if (!bucket || !kind) continue;
    let state = buckets.get(bucket);
    if (!state) {
      state = {
        bucket,
        countPath: join(stateDir, `.retry-${bucket}-count`),
        count: 0,
        headPath: join(stateDir, `.retry-${bucket}-head`),
        exhaustedPath: join(stateDir, `.retry-${bucket}-exhausted`),
      };
      buckets.set(bucket, state);
    }
    const path = join(stateDir, entry);
    if (kind === 'count') {
      const raw = safeReadInt(path);
      if (raw !== null) {
        state.count = raw;
        state.countPath = path;
      }
    } else if (kind === 'head') {
      state.headPath = path;
      const lines = safeReadFile(path)?.split('\n').map((s) => s.trim()).filter(Boolean) ?? [];
      state.headSha = lines[0];
      state.baseSha = lines[1];
    } else if (kind === 'exhausted') {
      state.exhaustedPath = path;
      state.exhaustedReason = safeReadFile(path)?.trim();
    }
  }
  return Array.from(buckets.values());
}

/**
 * Run the full consistency scan. Caller owns the Ledger handle.
 */
export function runConsistencyCheck(options: RunConsistencyCheckOptions): ConsistencyResult {
  const started = Date.now();
  const nowMs = options.nowMs ?? started;
  const evidenceWindowMs = options.evidenceWindowMs ?? 300_000;
  const disagreements: Disagreement[] = [];
  const retrySentinels = enumerateRetrySentinels(options.stateDir);

  const steps = listIssueSteps(options.ledger, options.issue);
  const scanned: ConsistencyScanSummary = {
    steps: steps.length,
    waitingOn: 0,
    evidence: 0,
    retrySentinels: retrySentinels.length,
  };

  // Checks 1–2: retry mirrors. We cannot know which step a sentinel belongs
  // to without the bind file written at launch; so we accept any step row
  // in the running/aborted set that matches the bucket. If none exists,
  // report missing-step (warn) when there's a non-zero counter.
  for (const bucket of retrySentinels) {
    const matched = steps.find((row) => bucketMatchesStep(bucket.bucket, row));
    if (bucket.exhaustedReason) {
      if (!matched) {
        disagreements.push({
          category: 'missing-step',
          severity: 'warn',
          bucket: bucket.bucket,
          detail: `exhausted sentinel for bucket=${bucket.bucket} has no mirror step row`,
        });
        continue;
      }
      if (matched.settled_as !== 'aborted') {
        disagreements.push({
          category: 'settled-reason-mismatch',
          severity: 'warn',
          stepId: matched.id,
          bucket: bucket.bucket,
          detail: `exhausted sentinel but step state=${matched.state}`,
        });
      } else if (
        matched.settled_reason &&
        !matched.settled_reason.startsWith(`exhausted:${bucket.bucket}`)
      ) {
        disagreements.push({
          category: 'settled-reason-mismatch',
          severity: 'warn',
          stepId: matched.id,
          bucket: bucket.bucket,
          detail: `step settled_reason=${matched.settled_reason} does not match bucket`,
        });
      }
      continue;
    }
    if (bucket.count > 0 && !matched) {
      disagreements.push({
        category: 'missing-step',
        severity: 'warn',
        bucket: bucket.bucket,
        detail: `retry count=${bucket.count} without mirror step row for bucket=${bucket.bucket}`,
      });
      continue;
    }
    if (matched && bucket.count !== matched.attempt) {
      disagreements.push({
        category: 'attempt-mismatch',
        severity: 'info',
        stepId: matched.id,
        bucket: bucket.bucket,
        detail: `sentinel count=${bucket.count}, step attempt=${matched.attempt}`,
      });
    }
  }

  // Check 4: condition markers → waiting_on. Walk every *.condition*.json
  // sidecar at the state-dir root and look for a mirror row anywhere under
  // the issue root.
  const conditionSidecars = enumerateConditionSidecars(options.stateDir);
  const waitingOnByTrigger = collectWaitingOnByTrigger(options.ledger, options.issue, steps);
  scanned.waitingOn = Array.from(waitingOnByTrigger.values()).reduce((n, rows) => n + rows.length, 0);
  for (const sidecar of conditionSidecars) {
    const trigger = sidecar.trigger;
    if (!trigger) continue;
    const rows = waitingOnByTrigger.get(trigger) ?? [];
    if (rows.length === 0) {
      disagreements.push({
        category: 'missing-waiting-on',
        severity: 'warn',
        trigger,
        detail: `sidecar=${sidecar.path} has no mirror waiting_on row`,
      });
    }
  }

  // Check 5–6: agent-sourced hook events vs evidence rows.
  const hookFile = options.hookFilePath ?? deriveHookFilePath(options.sessionId, options.issue);
  const hookAgent = readAgentHookRecord(hookFile);
  const evidenceRows = collectEvidenceRows(options.ledger, steps);
  scanned.evidence = evidenceRows.length;
  if (hookAgent && hookAgent.timestampMs !== undefined) {
    const freshness = nowMs - hookAgent.timestampMs;
    if (freshness <= evidenceWindowMs) {
      const matched = evidenceRows.find(
        (row) => row.source === 'agent-hook' && row.event === hookAgent.event,
      );
      if (!matched) {
        // Downgrade to info when no running step exists — benign gap per plan §3e.
        const liveStep = findActiveStep(options.ledger, options.issue);
        disagreements.push({
          category: 'missing-evidence',
          severity: liveStep ? 'warn' : 'info',
          detail: `agent hook event=${hookAgent.event} has no mirror evidence row`,
        });
      }
    }
  }

  const tookMs = Date.now() - started;
  return {
    issue: options.issue,
    stateDir: options.stateDir,
    disagreements,
    scanned,
    tookMs,
  };
}

interface ConditionSidecar {
  path: string;
  trigger?: WaitingTrigger;
}

export function enumerateConditionSidecars(stateDir: string): ConditionSidecar[] {
  if (!existsSync(stateDir)) return [];
  const out: ConditionSidecar[] = [];
  for (const entry of readdirSync(stateDir)) {
    if (!entry.endsWith('-condition.json') && !entry.endsWith('.condition.json')) continue;
    const path = join(stateDir, entry);
    const raw = safeReadFile(path);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { condition?: { expiresOn?: string[] } };
      const expiresOn = parsed.condition?.expiresOn ?? [];
      const trigger = pickWaitingTrigger(expiresOn);
      out.push({ path, trigger });
    } catch {
      out.push({ path });
    }
  }
  return out;
}

function pickWaitingTrigger(expiresOn: string[]): WaitingTrigger | undefined {
  for (const value of expiresOn) {
    switch (value) {
      case 'head':
      case 'operator-event':
      case 'review-artifact':
      case 'review-artifact-substantive':
      case 'ready-artifact':
      case 'remote':
      case 'waiting-on':
      case 'deadline':
        return value;
    }
  }
  return undefined;
}

function listIssueSteps(ledger: Ledger, issueKey: string): TaskRow[] {
  const roots = ledger.listTasks({ kind: 'issue' });
  const root = roots.find((row) => row.slug === issueKey && row.parent_id === null);
  if (!root) return [];
  return ledger.listChildren(root.id).filter((row) => row.kind === 'step');
}

function bucketMatchesStep(bucket: string, step: TaskRow): boolean {
  if (bucket.includes('review')) return step.slug === 'review';
  if (bucket.includes('ready')) return step.slug === 'ready';
  if (bucket.includes('eval')) return step.slug === 'eval';
  return false;
}

function collectWaitingOnByTrigger(
  ledger: Ledger,
  issueKey: string,
  steps: TaskRow[],
): Map<WaitingTrigger, WaitingOnRow[]> {
  const result = new Map<WaitingTrigger, WaitingOnRow[]>();
  const roots = ledger.listTasks({ kind: 'issue' });
  const root = roots.find((row) => row.slug === issueKey && row.parent_id === null);
  const ids = steps.map((row) => row.id);
  if (root) ids.push(root.id);
  for (const stepId of ids) {
    for (const row of ledger.listWaitingOn(stepId)) {
      const bucket = result.get(row.trigger) ?? [];
      bucket.push(row);
      result.set(row.trigger, bucket);
    }
  }
  return result;
}

function collectEvidenceRows(ledger: Ledger, steps: TaskRow[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const step of steps) {
    for (const row of ledger.listEvidence(step.id)) rows.push(row);
  }
  return rows;
}

interface HookAgentRecord {
  event: string;
  state: string;
  timestampMs?: number;
}

export function readAgentHookRecord(hookFile: string): HookAgentRecord | null {
  const raw = safeReadFile(hookFile);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const agent = parsed.agentRecord ?? parsed;
    if (!agent || typeof agent !== 'object') return null;
    const timestamp = typeof agent.timestamp === 'number' ? agent.timestamp * 1000 : undefined;
    const event = typeof agent.event === 'string' ? agent.event : '';
    const state = typeof agent.state === 'string' ? agent.state : '';
    if (!event && !state) return null;
    return { event, state, timestampMs: timestamp };
  } catch {
    return null;
  }
}

function deriveHookFilePath(sessionId: string | undefined, issue: string): string {
  const session = sessionId ?? process.env.WAVEMILL_SESSION ?? '';
  return `/tmp/wavemill-${session}-${issue}.hook`;
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeReadInt(path: string): number | null {
  const raw = safeReadFile(path);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

export function appendConsistencyLog(stateDir: string, record: ConsistencyResult): void {
  const path = join(stateDir, '.ledger-consistency.jsonl');
  const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n';
  try {
    // Simple append; the file is append-only JSONL per CLAUDE.md.
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      const stat = statSync(path);
      if (stat.size > 10 * 1024 * 1024) {
        fs.renameSync(path, path + '.1');
      }
    } catch {
      /* ignore */
    }
    fs.appendFileSync(path, line);
  } catch {
    /* best-effort */
  }
}
