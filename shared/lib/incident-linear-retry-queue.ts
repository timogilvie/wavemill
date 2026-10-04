import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { classifyLinearError, type ClassifiedLinearError } from './linear.ts';
import { syncIncident, syncIncidentLifecycle, type IncidentLinearClient, type ObserverLinearConfig, type SyncIncidentOptions } from './incident-to-linear-synchronizer.ts';
import type { IncidentLifecycleTransitionKind } from './wavemill-incident-model.ts';
import { IncidentStore } from './wavemill-incident-store.ts';

const SCHEMA_VERSION = '1.0';
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30 * 60_000;

export interface IncidentRetryErrorSnapshot extends ClassifiedLinearError {
  error: string;
}

export type IncidentRetryAction = 'create' | 'update_comment' | 'lifecycle';

export interface PendingIncidentRetryRecord {
  schemaVersion: '1.0';
  recordType: 'pending';
  id: string;
  enqueuedAt: string;
  incidentFingerprint: string;
  linearAction: IncidentRetryAction;
  linearIssueId?: string;
  /** Lifecycle transition metadata (only present when linearAction === 'lifecycle'). */
  lifecycleKind?: IncidentLifecycleTransitionKind;
  transitionRevision?: string;
  attempts: number;
  nextRetryAt: string;
  lastError: IncidentRetryErrorSnapshot;
}

export interface SettledIncidentRetryRecord {
  schemaVersion: '1.0';
  recordType: 'tombstone';
  id: string;
  settledAt: string;
}

export interface PermanentlyFailedIncidentRetryRecord {
  schemaVersion: '1.0';
  recordType: 'permanently_failed';
  id: string;
  failedAt: string;
  incidentFingerprint: string;
  linearAction: IncidentRetryAction;
  linearIssueId?: string;
  lifecycleKind?: IncidentLifecycleTransitionKind;
  transitionRevision?: string;
  attempts: number;
  lastError: IncidentRetryErrorSnapshot;
}

export type IncidentRetryRecord = PendingIncidentRetryRecord | SettledIncidentRetryRecord | PermanentlyFailedIncidentRetryRecord;

export interface EnqueueIncidentSyncInput {
  repoDir?: string;
  queuePath?: string;
  incidentFingerprint: string;
  linearAction: IncidentRetryAction;
  linearIssueId?: string;
  lifecycleKind?: IncidentLifecycleTransitionKind;
  transitionRevision?: string;
  attempts?: number;
  lastError: ClassifiedLinearError;
  now?: Date;
}

export interface DrainIncidentQueueOptions {
  repoDir?: string;
  queuePath?: string;
  store: IncidentStore;
  config: ObserverLinearConfig;
  client?: IncidentLinearClient;
  maxEntries?: number;
  now?: Date;
  log?: Pick<Console, 'error'>;
  reconciler?: SyncIncidentOptions['reconciler'];
}

export interface DrainIncidentQueueResult {
  processed: number;
  succeeded: number;
  failed: number;
  permanentFailures: number;
  skipped: number;
}

function resolveQueuePath(repoDir: string, configured?: string): string {
  const path = configured || '.wavemill/registry/linear-incident-queue.jsonl';
  return isAbsolute(path) ? path : join(repoDir, path);
}

function toIso(now: Date): string {
  return now.toISOString();
}

export function computeIncidentBackoffMs(attempts: number): number {
  const base = Math.min(1000 * (2 ** Math.max(attempts - 1, 0)), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 1001);
}

function toSnapshot(error: ClassifiedLinearError): IncidentRetryErrorSnapshot {
  return {
    ...error,
    graphqlErrors: [...error.graphqlErrors],
    error: error.message,
  };
}

function appendRecord(path: string, record: IncidentRetryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

function parseQueue(path: string): IncidentRetryRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as IncidentRetryRecord];
      } catch {
        return [];
      }
    });
}

function latestById(records: IncidentRetryRecord[]): Map<string, IncidentRetryRecord> {
  const latest = new Map<string, IncidentRetryRecord>();
  for (const record of records) latest.set(record.id, record);
  return latest;
}

function rewriteQueue(path: string, records: IncidentRetryRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf-8');
  renameSync(tmp, path);
}

export function enqueueIncidentSync(input: EnqueueIncidentSyncInput): PendingIncidentRetryRecord {
  const repoDir = input.repoDir ?? process.cwd();
  const path = resolveQueuePath(repoDir, input.queuePath);
  const now = input.now ?? new Date();
  // Dedupe pending entries by fingerprint, action, issue, and — for lifecycle —
  // the transition revision, so replaying the same transition never fans out.
  const existing = [...latestById(parseQueue(path)).values()]
    .find((record): record is PendingIncidentRetryRecord =>
      record.recordType === 'pending'
      && record.incidentFingerprint === input.incidentFingerprint
      && record.linearAction === input.linearAction
      && (record.linearIssueId ?? '') === (input.linearIssueId ?? '')
      && (record.transitionRevision ?? '') === (input.transitionRevision ?? ''),
    );
  const attempts = input.attempts ?? existing?.attempts ?? 1;
  const record: PendingIncidentRetryRecord = {
    schemaVersion: SCHEMA_VERSION,
    recordType: 'pending',
    id: existing?.id ?? randomUUID(),
    enqueuedAt: existing?.enqueuedAt ?? toIso(now),
    incidentFingerprint: input.incidentFingerprint,
    linearAction: input.linearAction,
    linearIssueId: input.linearIssueId,
    lifecycleKind: input.lifecycleKind,
    transitionRevision: input.transitionRevision,
    attempts,
    nextRetryAt: toIso(new Date(now.getTime() + computeIncidentBackoffMs(attempts))),
    lastError: toSnapshot(input.lastError),
  };
  appendRecord(path, record);
  return record;
}

export async function drainIncidentQueue(options: DrainIncidentQueueOptions): Promise<DrainIncidentQueueResult> {
  const repoDir = options.repoDir ?? process.cwd();
  const path = resolveQueuePath(repoDir, options.queuePath ?? options.config.retryQueuePath);
  const now = options.now ?? new Date();
  const latest = latestById(parseQueue(path));
  const pending = [...latest.values()]
    .filter((record): record is PendingIncidentRetryRecord => record.recordType === 'pending')
    .filter((record) => Date.parse(record.nextRetryAt) <= now.getTime())
    .sort((a, b) => a.nextRetryAt.localeCompare(b.nextRetryAt))
    .slice(0, options.maxEntries ?? 10);
  const result: DrainIncidentQueueResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    permanentFailures: 0,
    skipped: Math.max(latest.size - pending.length, 0),
  };

  for (const record of pending) {
    result.processed += 1;
    const incident = await options.store.getIncident(record.incidentFingerprint);
    if (!incident) {
      appendRecord(path, { schemaVersion: SCHEMA_VERSION, recordType: 'tombstone', id: record.id, settledAt: toIso(now) });
      result.succeeded += 1;
      continue;
    }
    try {
      // Lifecycle transition replay: settle comment/state steps independently and
      // skip any step already recorded successful on the reloaded record.
      if (record.linearAction === 'lifecycle') {
        const lifecycleResult = await syncIncidentLifecycle({
          incident,
          store: options.store,
          config: options.config,
          replay: true,
          now,
          client: options.client,
          repoDir,
          reconciler: options.reconciler,
          retryQueue: {
            enqueueLifecycleSync: (input) => enqueueIncidentSync({
              repoDir,
              queuePath: options.queuePath ?? options.config.retryQueuePath,
              incidentFingerprint: input.incidentFingerprint,
              linearAction: 'lifecycle',
              linearIssueId: input.linearIssueId,
              lifecycleKind: input.lifecycleKind,
              transitionRevision: input.transitionRevision,
              attempts: record.attempts + 1,
              lastError: input.lastError,
              now: input.now,
            }),
          },
        });
        if (lifecycleResult.status === 'synced' || lifecycleResult.status === 'no_op' || lifecycleResult.status === 'skipped') {
          appendRecord(path, { schemaVersion: SCHEMA_VERSION, recordType: 'tombstone', id: record.id, settledAt: toIso(now) });
          result.succeeded += 1;
          continue;
        }
        if (lifecycleResult.status === 'queued') {
          result.failed += 1;
          continue;
        }
        throw new Error(lifecycleResult.reason ?? 'incident lifecycle retry did not complete');
      }
      const syncResult = await syncIncident({
        incident,
        store: options.store,
        config: options.config,
        replay: true,
        now,
        client: options.client,
        retryQueue: {
          enqueueIncidentSync: (input) => enqueueIncidentSync({
            repoDir,
            queuePath: options.queuePath ?? options.config.retryQueuePath,
            incidentFingerprint: input.incidentFingerprint,
            linearAction: input.linearAction,
            linearIssueId: input.linearIssueId,
            attempts: record.attempts + 1,
            lastError: input.lastError,
            now: input.now,
          }),
        },
        repoDir,
        reconciler: options.reconciler,
      });
      if (record.linearAction === 'create' && (syncResult.reconciliation?.outcome === 'recovered' || syncResult.reconciliation?.outcome === 'superseded')) {
        appendRecord(path, { schemaVersion: SCHEMA_VERSION, recordType: 'tombstone', id: record.id, settledAt: toIso(now) });
        result.succeeded += 1;
        continue;
      }
      if (syncResult.status === 'created' || syncResult.status === 'updated' || syncResult.action === 'no_op') {
        appendRecord(path, { schemaVersion: SCHEMA_VERSION, recordType: 'tombstone', id: record.id, settledAt: toIso(now) });
        result.succeeded += 1;
        continue;
      }
      if (syncResult.status === 'queued') {
        result.failed += 1;
        continue;
      }
      throw new Error(syncResult.reason ?? 'incident retry did not complete');
    } catch (error) {
      const classified = classifyLinearError(error);
      const attempts = record.attempts + 1;
      if (!classified.isRetryable || attempts >= MAX_ATTEMPTS) {
        appendRecord(path, {
          schemaVersion: SCHEMA_VERSION,
          recordType: 'permanently_failed',
          id: record.id,
          failedAt: toIso(now),
          incidentFingerprint: record.incidentFingerprint,
          linearAction: record.linearAction,
          linearIssueId: record.linearIssueId,
          lifecycleKind: record.lifecycleKind,
          transitionRevision: record.transitionRevision,
          attempts,
          lastError: toSnapshot(classified),
        });
        await options.store.recordSyncError(record.incidentFingerprint, {
          action: record.linearAction,
          category: classified.category,
          message: classified.message,
          retryQueued: false,
          at: toIso(now),
        });
        options.log?.error(`Linear incident retry permanently failed for ${record.incidentFingerprint}: ${classified.message}`);
        result.failed += 1;
        result.permanentFailures += 1;
        continue;
      }
      appendRecord(path, {
        ...record,
        attempts,
        nextRetryAt: toIso(new Date(now.getTime() + computeIncidentBackoffMs(attempts))),
        lastError: toSnapshot(classified),
      });
      result.failed += 1;
    }
  }

  const compacted = [...latestById(parseQueue(path)).values()];
  rewriteQueue(path, compacted);
  return result;
}
