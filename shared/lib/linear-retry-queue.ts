import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyLinearError, getIssueReplayState, setIssuesState, type ClassifiedLinearError, type LinearBatchFailure, type LinearIssueReplayState } from './linear.ts';
import { mutateJsonState } from './state-mutex.ts';

const QUEUE_RELATIVE_PATH = join('.wavemill', 'registry', 'linear-retry-queue.jsonl');
const COMPACT_LOCK_RELATIVE_PATH = join('.wavemill', 'registry', 'linear-retry-queue.compact-state.json');
const SCHEMA_VERSION = '1.0';
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30 * 60_000;
export const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60_000;
const RETAIN_SETTLED_MS = 24 * 60 * 60_000;

export interface RetryQueueErrorSnapshot extends ClassifiedLinearError {
  error: string;
}

export interface PendingRetryRecord {
  schemaVersion: '1.0';
  recordType: 'pending';
  id: string;
  enqueuedAt: string;
  issueIds: string[];
  targetState: string;
  attempts: number;
  nextRetryAt: string;
  lastError: RetryQueueErrorSnapshot;
}

export interface TombstoneRetryRecord {
  schemaVersion: '1.0';
  recordType: 'tombstone';
  id: string;
  settledAt: string;
}

export interface PermanentlyFailedRetryRecord {
  schemaVersion: '1.0';
  recordType: 'permanently_failed';
  id: string;
  failedAt: string;
  issueIds: string[];
  targetState: string;
  attempts: number;
  lastError: RetryQueueErrorSnapshot;
}

export interface DroppedRetryRecord {
  schemaVersion: '1.0';
  recordType: 'dropped';
  id: string;
  droppedAt: string;
  issueIds: string[];
  targetState: string;
  reason: 'stale_state' | 'expired' | 'invalid_age';
  details: Array<{ issueId: string; observedState?: string; reason: string; ageMs?: number }>;
}

type RetryQueueRecord = PendingRetryRecord | TombstoneRetryRecord | PermanentlyFailedRetryRecord | DroppedRetryRecord;

export interface EnqueueRetryEntry {
  issueIds: string[];
  targetState: string;
  lastError: RetryQueueErrorSnapshot;
  attempts?: number;
  now?: Date;
  repoDir?: string;
}

export interface DrainRetryQueueOptions {
  maxEntries?: number;
  now?: Date;
  repoDir?: string;
  setIssuesStateImpl?: typeof setIssuesState;
  getIssueReplayStateImpl?: (identifier: string) => Promise<LinearIssueReplayState>;
  log?: Pick<Console, 'error'>;
}

export interface DrainRetryQueueResult {
  processed: number;
  succeeded: number;
  failed: number;
  permanentFailures: number;
  dropped: number;
  expired: number;
  skipped: number;
}

function queuePath(repoDir = process.cwd()): string {
  return join(repoDir, QUEUE_RELATIVE_PATH);
}

function compactLockPath(repoDir = process.cwd()): string {
  return join(repoDir, COMPACT_LOCK_RELATIVE_PATH);
}

function toIso(now: Date): string {
  return now.toISOString();
}

function computeBackoffMs(attempts: number): number {
  const exponential = Math.min(60_000 * (2 ** Math.max(attempts - 1, 0)), MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * 30_001);
  return exponential + jitter;
}

function appendRecord(repoDir: string, record: RetryQueueRecord): void {
  const path = queuePath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

function parseQueue(repoDir: string): RetryQueueRecord[] {
  const path = queuePath(repoDir);
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RetryQueueRecord];
      } catch {
        return [];
      }
    });
}

function latestRecordById(records: RetryQueueRecord[]): Map<string, RetryQueueRecord> {
  const latest = new Map<string, RetryQueueRecord>();
  for (const record of records) {
    latest.set(record.id, record);
  }
  return latest;
}

function toRetryErrorSnapshot(failure: LinearBatchFailure | RetryQueueErrorSnapshot | ClassifiedLinearError, error?: string): RetryQueueErrorSnapshot {
  return {
    category: failure.category,
    httpStatus: failure.httpStatus,
    graphqlErrors: [...failure.graphqlErrors],
    isRetryable: failure.isRetryable,
    message: failure.message,
    error: error ?? ('error' in failure ? failure.error : failure.message),
  };
}

export function enqueue(entry: EnqueueRetryEntry): PendingRetryRecord {
  const repoDir = entry.repoDir ?? process.cwd();
  const now = entry.now ?? new Date();
  const attempts = entry.attempts ?? 1;
  const record: PendingRetryRecord = {
    schemaVersion: SCHEMA_VERSION,
    recordType: 'pending',
    id: randomUUID(),
    enqueuedAt: toIso(now),
    issueIds: [...entry.issueIds],
    targetState: entry.targetState,
    attempts,
    nextRetryAt: toIso(new Date(now.getTime() + computeBackoffMs(attempts))),
    lastError: entry.lastError,
  };
  appendRecord(repoDir, record);
  return record;
}

function summarizeFailures(failures: LinearBatchFailure[]): RetryQueueErrorSnapshot {
  const retryable = failures.find((failure) => failure.isRetryable) ?? failures[0];
  return toRetryErrorSnapshot(retryable);
}

function rewriteQueueFile(repoDir: string, records: RetryQueueRecord[]): void {
  const path = queuePath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf-8');
  renameSync(tmpPath, path);
  try {
    unlinkSync(tmpPath);
  } catch {
    // Already renamed or absent.
  }
}

export async function compact(repoDir = process.cwd(), now = new Date()): Promise<void> {
  const path = queuePath(repoDir);
  if (!existsSync(path)) {
    return;
  }

  const lockPath = compactLockPath(repoDir);
  await mutateJsonState<{ lastRunAt: string }>(
    lockPath,
    (current) => {
      const cutoff = now.getTime() - RETAIN_SETTLED_MS;
      const records = parseQueue(repoDir).filter((record) => {
        if (record.recordType === 'tombstone') {
          return new Date(record.settledAt).getTime() >= cutoff;
        }
        if (record.recordType === 'permanently_failed') {
          return new Date(record.failedAt).getTime() >= cutoff;
        }
        if (record.recordType === 'dropped') return new Date(record.droppedAt).getTime() >= cutoff;
        return true;
      });
      rewriteQueueFile(repoDir, records);
      return { lastRunAt: toIso(now) };
    },
    {
      createIfMissing: true,
      initial: { lastRunAt: toIso(now) },
    },
  );
}

export async function drain(opts: DrainRetryQueueOptions = {}): Promise<DrainRetryQueueResult> {
  const repoDir = opts.repoDir ?? process.cwd();
  const now = opts.now ?? new Date();
  const maxEntries = opts.maxEntries ?? 10;
  const setIssuesStateImpl = opts.setIssuesStateImpl ?? setIssuesState;
  const getIssueReplayStateImpl = opts.getIssueReplayStateImpl ?? getIssueReplayState;
  const log = opts.log ?? console;
  const latest = latestRecordById(parseQueue(repoDir));
  const pending = [...latest.values()]
    .filter((record): record is PendingRetryRecord => record.recordType === 'pending')
    .filter((record) => new Date(record.nextRetryAt).getTime() <= now.getTime())
    .sort((a, b) => a.nextRetryAt.localeCompare(b.nextRetryAt))
    .slice(0, maxEntries);

  const result: DrainRetryQueueResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    permanentFailures: 0,
    dropped: 0,
    expired: 0,
    skipped: Math.max(latest.size - pending.length, 0),
  };

  for (const record of pending) {
    result.processed += 1;
    let failures: LinearBatchFailure[] = [];

    const enqueuedAtMs = Date.parse(record.enqueuedAt);
    const ageMs = now.getTime() - enqueuedAtMs;
    if (!Number.isFinite(enqueuedAtMs) || ageMs < 0 || ageMs > MAX_PENDING_AGE_MS) {
      const invalidAge = !Number.isFinite(enqueuedAtMs) || ageMs < 0;
      appendRecord(repoDir, {
        schemaVersion: SCHEMA_VERSION,
        recordType: 'dropped',
        id: record.id,
        droppedAt: toIso(now),
        issueIds: [...record.issueIds],
        targetState: record.targetState,
        reason: invalidAge ? 'invalid_age' : 'expired',
        details: [{ issueId: '*', reason: invalidAge ? 'invalid_or_future_enqueued_at' : 'max_pending_age_exceeded', ageMs: Number.isFinite(ageMs) ? ageMs : undefined }],
      });
      result.dropped += 1;
      result.expired += 1;
      log.error(`Linear retry queue dropped ${record.id}: ${invalidAge ? 'invalid age' : 'expired'} (ageMs=${Number.isFinite(ageMs) ? ageMs : 'unknown'})`);
      continue;
    }

    try {
      const observed = await Promise.all(record.issueIds.map((issueId) => getIssueReplayStateImpl(issueId)));
      const staleDetails = observed.flatMap((issue) => {
        const current = issue.state;
        const target = issue.teamStates.find((state) => state.name.toLowerCase() === record.targetState.toLowerCase());
        const currentState = issue.teamStates.find((state) => state.id && state.id === current.id)
          ?? issue.teamStates.find((state) => state.name.toLowerCase() === current.name.toLowerCase());
        let reason: string | undefined;
        if (issue.completedAt || current.type === 'completed') reason = 'issue_completed';
        else if (issue.canceledAt || current.type === 'canceled') reason = 'issue_canceled';
        else if (!target || !currentState || typeof target.position !== 'number' || typeof currentState.position !== 'number') reason = 'state_order_unavailable';
        else if (currentState.position > target.position) reason = 'current_state_later_than_target';
        return reason ? [{ issueId: issue.identifier, observedState: current.name, reason }] : [];
      });
      const unavailable = staleDetails.filter((detail) => detail.reason === 'state_order_unavailable');
      const stale = staleDetails.filter((detail) => detail.reason !== 'state_order_unavailable');
      // A batch is all-or-nothing: once any issue has passed the target, a
      // replay would regress that issue.  Keep any unavailable ordering in
      // the audit details, but never let it keep the stale write retryable.
      if (stale.length > 0) {
        appendRecord(repoDir, {
          schemaVersion: SCHEMA_VERSION,
          recordType: 'dropped',
          id: record.id,
          droppedAt: toIso(now),
          issueIds: [...record.issueIds],
          targetState: record.targetState,
          reason: 'stale_state',
          details: staleDetails,
        });
        result.dropped += 1;
        log.error(`Linear retry queue dropped ${record.id}: stale state (${stale.map((detail) => `${detail.issueId}=${detail.observedState}:${detail.reason}`).join(', ')})`);
        continue;
      }
      if (unavailable.length > 0) {
        failures = unavailable.map((detail) => ({ issueId: detail.issueId, error: detail.reason, category: 'unknown', httpStatus: null, graphqlErrors: [], isRetryable: true, message: detail.reason }));
      }
    } catch (error) {
      const classified = classifyLinearError(error);
      failures = record.issueIds.map((issueId) => ({ issueId, error: classified.message, ...classified }));
    }

    if (failures.length === 0) try {
      // HOK-3183: the queue record is the trigger event every replay shares.
      const response = await setIssuesStateImpl(record.issueIds, record.targetState, {
        triggerEventId: `linear-retry:${record.id}`,
      });
      if (response.failed.length === 0) {
        appendRecord(repoDir, {
          schemaVersion: SCHEMA_VERSION,
          recordType: 'tombstone',
          id: record.id,
          settledAt: toIso(now),
        });
        result.succeeded += 1;
        continue;
      }
      failures = response.failed;
    } catch (error) {
      const classified = classifyLinearError(error);
      failures = record.issueIds.map((issueId) => ({
        issueId,
        error: classified.message,
        ...classified,
      }));
    }

    const summary = summarizeFailures(failures);
    const attempts = record.attempts + 1;
    if (!summary.isRetryable || attempts >= MAX_ATTEMPTS) {
      appendRecord(repoDir, {
        schemaVersion: SCHEMA_VERSION,
        recordType: 'permanently_failed',
        id: record.id,
        failedAt: toIso(now),
        issueIds: [...record.issueIds],
        targetState: record.targetState,
        attempts,
        lastError: summary,
      });
      log.error(
        `Linear retry queue permanently failed for ${record.issueIds.join(', ')} ` +
        `(state=${record.targetState}, attempts=${attempts}, category=${summary.category}, http=${summary.httpStatus ?? 'none'})`,
      );
      result.failed += 1;
      result.permanentFailures += 1;
      continue;
    }

    appendRecord(repoDir, {
      ...record,
      attempts,
      nextRetryAt: toIso(new Date(now.getTime() + computeBackoffMs(attempts))),
      lastError: summary,
    });
    result.failed += 1;
  }

  await compact(repoDir, now);
  return result;
}
