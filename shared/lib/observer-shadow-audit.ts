import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mutateJsonState } from './state-mutex.ts';
import type { ShadowSyncPlan } from './incident-to-linear-synchronizer.ts';

const SCHEMA_VERSION = '1.0';

export interface ShadowAuditRecord {
  schemaVersion: '1.0';
  recordedAt: string;
  repoDir?: string;
  session?: string;
  fingerprint: string;
  class: string;
  task?: string;
  action: ShadowSyncPlan['action'];
  reason?: string;
  evidenceRevision: string;
  correlationTarget: ShadowSyncPlan['correlationTarget'];
  reconciliation: ShadowSyncPlan['reconciliation'];
  redactionSummary: ShadowSyncPlan['redactionSummary'];
  policyDecision: ShadowSyncPlan['policyDecision'];
  plannedTitle: string;
  plannedBody?: string;
  plannedCommentBody?: string;
  mutationAttempts: number;
}

export interface ShadowRetentionOptions {
  maxEntries?: number;
  maxAgeDays?: number;
  now?: Date;
}

export interface ShadowCounters {
  eligible: number;
  proposedCreate: number;
  proposedUpdate: number;
  noOp: number;
  skipRecovered: number;
  skip: number;
  failed: number;
  ambiguous: number;
  redactionFailures: number;
  correlationCollisions: number;
  mutationAttempts: number;
  lastRunAt?: string;
  lastAuditPath?: string;
}

export function emptyShadowCounters(): ShadowCounters {
  return {
    eligible: 0,
    proposedCreate: 0,
    proposedUpdate: 0,
    noOp: 0,
    skipRecovered: 0,
    skip: 0,
    failed: 0,
    ambiguous: 0,
    redactionFailures: 0,
    correlationCollisions: 0,
    mutationAttempts: 0,
  };
}

function resolvePath(configured: string, repoDir?: string): string {
  if (isAbsolute(configured)) return configured;
  return join(repoDir ?? process.cwd(), configured);
}

function readAllRecords(path: string): ShadowAuditRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const out: ShadowAuditRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ShadowAuditRecord);
    } catch {
      // Skip malformed lines rather than losing the whole audit trail.
    }
  }
  return out;
}

function trimRecords(records: ShadowAuditRecord[], options: ShadowRetentionOptions): ShadowAuditRecord[] {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeDays !== undefined ? options.maxAgeDays * 24 * 60 * 60 * 1000 : undefined;
  let filtered = records;
  if (maxAgeMs !== undefined) {
    filtered = filtered.filter((record) => {
      const at = Date.parse(record.recordedAt);
      if (!Number.isFinite(at)) return true;
      return now.getTime() - at <= maxAgeMs;
    });
  }
  if (options.maxEntries !== undefined && filtered.length > options.maxEntries) {
    filtered = filtered.slice(filtered.length - options.maxEntries);
  }
  return filtered;
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.shadow-audit-tmp-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, contents, 'utf-8');
  renameSync(tmpPath, path);
}

/**
 * Bounded-retention JSONL append. Reads existing records, appends the new
 * one, trims by age and count, and atomically replaces the file so a partial
 * write cannot leave the audit unreadable.
 */
export function appendShadowRecord(
  path: string,
  record: ShadowAuditRecord,
  retention: ShadowRetentionOptions = {},
  repoDir?: string,
): void {
  const resolved = resolvePath(path, repoDir);
  const existing = readAllRecords(resolved);
  const combined = [...existing, record];
  const trimmed = trimRecords(combined, retention);
  const contents = trimmed.map((entry) => JSON.stringify(entry)).join('\n') + (trimmed.length ? '\n' : '');
  atomicWrite(resolved, contents);
}

export function readShadowAudit(path: string, repoDir?: string): ShadowAuditRecord[] {
  return readAllRecords(resolvePath(path, repoDir));
}

/** Read the persistent counters JSON, returning zeroed defaults when missing. */
export async function loadShadowCounters(path: string, repoDir?: string): Promise<ShadowCounters> {
  const resolved = resolvePath(path, repoDir);
  if (!existsSync(resolved)) return emptyShadowCounters();
  try {
    return { ...emptyShadowCounters(), ...(JSON.parse(readFileSync(resolved, 'utf-8')) as Partial<ShadowCounters>) };
  } catch {
    return emptyShadowCounters();
  }
}

/**
 * Merge pass-local increments into the persistent counters under an atomic
 * lock so restart continues from the previous total instead of resetting.
 */
export async function updateShadowCounters(
  path: string,
  increments: Partial<ShadowCounters>,
  overrides: Partial<Pick<ShadowCounters, 'lastRunAt' | 'lastAuditPath'>> = {},
  repoDir?: string,
): Promise<ShadowCounters> {
  const resolved = resolvePath(path, repoDir);
  return mutateJsonState<ShadowCounters>(resolved, (current) => {
    const base = { ...emptyShadowCounters(), ...current };
    const next: ShadowCounters = {
      eligible: base.eligible + (increments.eligible ?? 0),
      proposedCreate: base.proposedCreate + (increments.proposedCreate ?? 0),
      proposedUpdate: base.proposedUpdate + (increments.proposedUpdate ?? 0),
      noOp: base.noOp + (increments.noOp ?? 0),
      skipRecovered: base.skipRecovered + (increments.skipRecovered ?? 0),
      skip: base.skip + (increments.skip ?? 0),
      failed: base.failed + (increments.failed ?? 0),
      ambiguous: base.ambiguous + (increments.ambiguous ?? 0),
      redactionFailures: base.redactionFailures + (increments.redactionFailures ?? 0),
      correlationCollisions: base.correlationCollisions + (increments.correlationCollisions ?? 0),
      mutationAttempts: base.mutationAttempts + (increments.mutationAttempts ?? 0),
      lastRunAt: overrides.lastRunAt ?? base.lastRunAt,
      lastAuditPath: overrides.lastAuditPath ?? base.lastAuditPath,
    };
    return next;
  }, { createIfMissing: true, initial: emptyShadowCounters() });
}

/**
 * Convert a ShadowSyncPlan into a persistable audit record. The record uses
 * only redacted fields already produced by planShadowSync — nothing raw is
 * captured here.
 */
export function buildShadowAuditRecord(
  plan: ShadowSyncPlan,
  meta: {
    recordedAt: string;
    repoDir?: string;
    session?: string;
    mutationAttempts?: number;
  },
): ShadowAuditRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordedAt: meta.recordedAt,
    repoDir: meta.repoDir,
    session: meta.session,
    fingerprint: plan.fingerprint,
    class: plan.class,
    task: plan.task,
    action: plan.action,
    reason: plan.reason,
    evidenceRevision: plan.evidenceRevision,
    correlationTarget: plan.correlationTarget,
    reconciliation: plan.reconciliation,
    redactionSummary: plan.redactionSummary,
    policyDecision: plan.policyDecision,
    plannedTitle: plan.plannedTitle,
    plannedBody: plan.plannedBody,
    plannedCommentBody: plan.plannedCommentBody,
    mutationAttempts: meta.mutationAttempts ?? 0,
  };
}
