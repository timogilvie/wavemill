import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getHokusaiContributionsConfig } from './config.ts';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V4,
  validateContributionRow,
  type ContributionRow,
} from './hokusai-contribution-schema.ts';
import { contributionConsentBlockers, getContributionConsentStatus } from './hokusai-consent.ts';
import { errorMessage } from './error-utils.ts';
import { resolveHokusaiQueuePaths } from './hokusai-queue-paths.ts';
import { mutateJsonState, StateParseError } from './state-mutex.ts';

const STATE_SCHEMA_VERSION = '1.0';
const MAX_RECENT_IDEMPOTENCY_KEYS = 1000;

export type QueueRowShape =
  | typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION
  | typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V4
  // Historical shape: rows already in the queue from a pre-HOK-3415 writer.
  // Wavemill no longer writes these.
  | 'submit_data';

export interface HokusaiQueueEnvelope {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  entryId: string;
  rowShape: QueueRowShape;
  row: ContributionRow;
  idempotencyKey: string;
  enqueuedAt: string;
  attempts: number;
  nextAttemptAt: string;
  provenance?: HokusaiQueueProvenance;
}

export interface HokusaiQueueProvenance {
  evalId: string;
  source: 'live' | 'promoted_backfill';
  identityRevision?: number;
  identityFingerprint?: string;
  promotionManifestId?: string;
  promotionFromRevision?: number;
  promotionToRevision?: number;
  reconciliationReportHash?: string;
}

export interface HokusaiQueueFailureDetail {
  code: string;
  message: string;
  status?: number;
  at: string;
}

export interface AcceptedBatchRecord {
  batchId: string;
  idempotencyKey: string;
  acceptedAt: string;
  rowCount: number;
  jobIds: string[];
  entries?: AcceptedBatchEntryRecord[];
}

export interface AcceptedBatchEntryRecord {
  entryId: string;
  idempotencyKey: string;
  provenance?: HokusaiQueueProvenance;
}

export interface HokusaiQueueState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  processedLineCount: number;
  exportLineCount: number;
  recentIdempotencyKeys: string[];
  acceptedBatches: AcceptedBatchRecord[];
  lastError: HokusaiQueueFailureDetail | null;
}

export interface QueueAccessOptions {
  repoDir?: string;
  configDir?: string;
  now?: Date;
  provenance?: HokusaiQueueProvenance;
}

export type EnqueueResult =
  | { status: 'disabled'; blockers: string[] }
  | { status: 'enqueued'; entry: HokusaiQueueEnvelope }
  | { status: 'duplicate' };

export interface PendingBatch {
  entries: HokusaiQueueEnvelope[];
  lineCount: number;
  idempotencyKey: string;
}

export interface ReadPendingResult {
  status: 'disabled' | 'ready' | 'waiting' | 'empty' | 'corrupt_state';
  batch?: PendingBatch;
  nextAttemptAt?: string;
  error?: string;
}

export interface HokusaiQueueStatus {
  enabled: boolean;
  consentValid: boolean;
  queueExists: boolean;
  endpointConfigured: boolean;
  exportConfigured: boolean;
  pendingCount: number;
  deadLetterCount: number;
  processedLineCount: number;
  exportLineCount: number;
  lastError: HokusaiQueueFailureDetail | null;
}

export interface DeadLetterRecord {
  entry: HokusaiQueueEnvelope;
  failure: HokusaiQueueFailureDetail;
}

export interface RequeueFilter {
  entryId?: string;
  since?: string;
}

export interface RequeueReportEntry {
  entryId: string;
  idempotencyKey: string;
  failureCode: string;
  failureStatus?: number;
  failedAt: string;
  enqueuedAt: string;
}

export interface RequeueResult {
  status: 'disabled' | 'nothing_to_requeue' | 'dry_run' | 'requeued';
  requeued: RequeueReportEntry[];
  remaining: number;
  skippedMalformed: number;
}

function initialState(): HokusaiQueueState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedLineCount: 0,
    exportLineCount: 0,
    recentIdempotencyKeys: [],
    acceptedBatches: [],
    lastError: null,
  };
}

function toStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => toStableJson(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${toStableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function getRowShape(row: ContributionRow): QueueRowShape {
  // HOK-3415: Wavemill only writes v4 rows now; a row that still arrives
  // without `schema_version` must be a historical submit_data entry rebuilt
  // from the queue for drain and is tagged so for provenance.
  return 'schema_version' in row ? row.schema_version : 'submit_data';
}

export function computeContributionRowIdempotencyKey(
  row: ContributionRow,
  explicitSeed?: string,
): string {
  const hash = createHash('sha256');
  hash.update(explicitSeed ?? '');
  hash.update(':');
  hash.update(toStableJson(row));
  return hash.digest('hex').slice(0, 32);
}

export function computeBatchIdempotencyKey(entries: HokusaiQueueEnvelope[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.idempotencyKey);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 32);
}

function appendJsonlLine(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

function readLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function rewriteJsonlLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tempPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8');
  renameSync(tempPath, path);
}

function loadStateOrDefault(statePath: string): HokusaiQueueState {
  if (!existsSync(statePath)) {
    return initialState();
  }

  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as HokusaiQueueState;
  } catch (error) {
    throw new StateParseError(statePath, error);
  }
}

function appendEnvelope(paths: ReturnType<typeof resolveHokusaiQueuePaths>, envelope: HokusaiQueueEnvelope): void {
  appendJsonlLine(paths.pendingPath, envelope);
}

function sanitizeRecentKeys(keys: string[]): string[] {
  return keys.slice(-MAX_RECENT_IDEMPOTENCY_KEYS);
}

function safeFailure(code: string, message: string, now: Date, status?: number): HokusaiQueueFailureDetail {
  return {
    code,
    message,
    ...(status !== undefined ? { status } : {}),
    at: now.toISOString(),
  };
}

interface ParsedDeadLetterLine {
  line: string;
  record?: DeadLetterRecord;
}

interface DeadLetterPartition {
  matched: ParsedDeadLetterLine[];
  unmatched: ParsedDeadLetterLine[];
  malformed: string[];
}

function isDeadLetterRecord(value: unknown): value is DeadLetterRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { entry?: unknown; failure?: unknown };
  if (!record.entry || typeof record.entry !== 'object') {
    return false;
  }
  const entry = record.entry as Partial<HokusaiQueueEnvelope>;
  const failure = record.failure as Partial<HokusaiQueueFailureDetail> | undefined;
  return typeof entry.entryId === 'string'
    && entry.entryId.length > 0
    && typeof entry.idempotencyKey === 'string'
    && entry.idempotencyKey.length > 0
    && Boolean(entry.row)
    && Boolean(failure)
    && typeof failure?.code === 'string'
    && typeof failure?.at === 'string';
}

function parseDeadLetterLine(line: string): ParsedDeadLetterLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isDeadLetterRecord(parsed)) {
      return { line };
    }
    return { line, record: parsed };
  } catch {
    return { line };
  }
}

function matchesRequeueFilter(record: DeadLetterRecord, filter: RequeueFilter, sinceTime?: number): boolean {
  if (filter.entryId && record.entry.entryId !== filter.entryId) {
    return false;
  }
  if (sinceTime !== undefined) {
    const failedAt = new Date(record.failure.at).getTime();
    if (!Number.isFinite(failedAt) || failedAt < sinceTime) {
      return false;
    }
  }
  return true;
}

function partitionDeadLetterLines(
  lines: string[],
  filter: RequeueFilter,
  sinceTime?: number,
): DeadLetterPartition {
  const matched: ParsedDeadLetterLine[] = [];
  const unmatched: ParsedDeadLetterLine[] = [];
  const malformed: string[] = [];

  for (const line of lines) {
    const parsed = parseDeadLetterLine(line);
    if (!parsed.record) {
      malformed.push(line);
    } else if (matchesRequeueFilter(parsed.record, filter, sinceTime)) {
      matched.push(parsed);
    } else {
      unmatched.push(parsed);
    }
  }

  return { matched, unmatched, malformed };
}

function toRequeueReportEntry(record: DeadLetterRecord): RequeueReportEntry {
  return {
    entryId: record.entry.entryId,
    idempotencyKey: record.entry.idempotencyKey,
    failureCode: record.failure.code,
    ...(record.failure.status !== undefined ? { failureStatus: record.failure.status } : {}),
    failedAt: record.failure.at,
    enqueuedAt: record.entry.enqueuedAt,
  };
}

function validateRequeueFilter(filter: RequeueFilter): number | undefined {
  if (!filter.since) {
    return undefined;
  }
  const sinceTime = new Date(filter.since).getTime();
  if (!Number.isFinite(sinceTime)) {
    throw new Error(`Invalid --since timestamp: ${filter.since}`);
  }
  return sinceTime;
}

export async function requeueDeadLetterEntries(
  filter: RequeueFilter = {},
  opts: QueueAccessOptions & { dryRun?: boolean } = {},
): Promise<RequeueResult> {
  const sinceTime = validateRequeueFilter(filter);
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled', requeued: [], remaining: 0, skippedMalformed: 0 };
  }

  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const lines = readLines(paths.deadLetterPath);
  const partition = partitionDeadLetterLines(lines, filter, sinceTime);
  const totalValidRecords = partition.matched.length + partition.unmatched.length;
  const report = partition.matched.map((entry) => toRequeueReportEntry(entry.record!));

  if (partition.matched.length === 0) {
    return {
      status: 'nothing_to_requeue',
      requeued: [],
      remaining: totalValidRecords,
      skippedMalformed: partition.malformed.length,
    };
  }

  if (opts.dryRun) {
    return {
      status: 'dry_run',
      requeued: report,
      remaining: totalValidRecords,
      skippedMalformed: partition.malformed.length,
    };
  }

  let movedReport: RequeueReportEntry[] = [];
  let remaining = 0;
  let skippedMalformed = 0;

  await mutateJsonState<HokusaiQueueState>(
    paths.statePath,
    (current) => {
      const lockedPartition = partitionDeadLetterLines(readLines(paths.deadLetterPath), filter, sinceTime);
      const now = (opts.now ?? new Date()).toISOString();
      movedReport = lockedPartition.matched.map((entry) => toRequeueReportEntry(entry.record!));
      skippedMalformed = lockedPartition.malformed.length;
      remaining = lockedPartition.unmatched.length;

      for (const parsed of lockedPartition.matched) {
        appendEnvelope(paths, {
          ...parsed.record!.entry,
          attempts: 0,
          nextAttemptAt: now,
        });
      }

      rewriteJsonlLines(paths.deadLetterPath, [
        ...lockedPartition.unmatched.map((entry) => entry.line),
        ...lockedPartition.malformed,
      ]);

      if (lockedPartition.matched.length === 0) {
        return current;
      }

      return {
        ...current,
        lastError: null,
      };
    },
    { createIfMissing: true, initial: initialState() },
  );

  if (movedReport.length === 0) {
    return { status: 'nothing_to_requeue', requeued: [], remaining, skippedMalformed };
  }

  return {
    status: 'requeued',
    requeued: movedReport,
    remaining,
    skippedMalformed,
  };
}

export async function enqueueContribution(
  row: ContributionRow,
  opts: QueueAccessOptions = {},
): Promise<EnqueueResult> {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled', blockers: contributionConsentBlockers(consent) };
  }

  const validatedRow = validateContributionRow(row);
  const now = opts.now ?? new Date();
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const explicitSeed = 'task_id' in validatedRow && validatedRow.task_id ? validatedRow.task_id : undefined;
  const idempotencyKey = computeContributionRowIdempotencyKey(validatedRow, explicitSeed);
  let status: EnqueueResult['status'] = 'enqueued';
  let entry: HokusaiQueueEnvelope | undefined;

  await mutateJsonState<HokusaiQueueState>(
    paths.statePath,
    (current) => {
      if (current.recentIdempotencyKeys.includes(idempotencyKey)) {
        status = 'duplicate';
        return current;
      }

      entry = {
        schemaVersion: STATE_SCHEMA_VERSION,
        entryId: randomUUID(),
        rowShape: getRowShape(validatedRow),
        row: validatedRow,
        idempotencyKey,
        enqueuedAt: now.toISOString(),
        attempts: 0,
        nextAttemptAt: now.toISOString(),
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
      };
      appendEnvelope(paths, entry);

      return {
        ...current,
        recentIdempotencyKeys: sanitizeRecentKeys([...current.recentIdempotencyKeys, idempotencyKey]),
      };
    },
    { createIfMissing: true, initial: initialState() },
  );

  return status === 'duplicate'
    ? { status }
    : { status, entry: entry! };
}

export async function enqueueBatch(
  rows: ContributionRow[],
  opts: QueueAccessOptions = {},
): Promise<EnqueueResult[]> {
  const results: EnqueueResult[] = [];
  for (const row of rows) {
    results.push(await enqueueContribution(row, opts));
  }
  return results;
}

export function readPending(opts: QueueAccessOptions = {}): ReadPendingResult {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled' };
  }

  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const config = getHokusaiContributionsConfig(opts.repoDir);
  const now = opts.now ?? new Date();
  let state: HokusaiQueueState;

  try {
    state = loadStateOrDefault(paths.statePath);
  } catch (error) {
    return {
      status: 'corrupt_state',
      error: error instanceof StateParseError ? error.message : errorMessage(error),
    };
  }

  const lines = readLines(paths.pendingPath);
  if (state.processedLineCount >= lines.length) {
    return { status: 'empty' };
  }

  const slice = lines.slice(state.processedLineCount);
  const entries: HokusaiQueueEnvelope[] = [];
  let lineCount = 0;

  for (const line of slice) {
    lineCount += 1;
    let parsed: HokusaiQueueEnvelope;
    try {
      parsed = JSON.parse(line) as HokusaiQueueEnvelope;
      validateContributionRow(parsed.row);
    } catch (error) {
      return {
        status: 'ready',
        batch: {
          entries: [{
            schemaVersion: STATE_SCHEMA_VERSION,
            entryId: 'malformed-entry',
            rowShape: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V4,
            row: { success_under_budget: false },
            idempotencyKey: 'malformed-entry',
            enqueuedAt: now.toISOString(),
            attempts: 0,
            nextAttemptAt: now.toISOString(),
          }],
          lineCount: 1,
          idempotencyKey: 'malformed-entry',
        },
      };
    }

    if (new Date(parsed.nextAttemptAt).getTime() > now.getTime()) {
      if (entries.length === 0) {
        return { status: 'waiting', nextAttemptAt: parsed.nextAttemptAt };
      }
      break;
    }

    entries.push(parsed);
    if (entries.length >= config.batchSize) {
      break;
    }
  }

  if (entries.length === 0) {
    return { status: 'waiting', nextAttemptAt: undefined };
  }

  return {
    status: 'ready',
    batch: {
      entries,
      lineCount: entries.length,
      idempotencyKey: computeBatchIdempotencyKey(entries),
    },
  };
}

async function mutateQueueState(
  opts: QueueAccessOptions,
  transform: (current: HokusaiQueueState) => HokusaiQueueState,
): Promise<HokusaiQueueState> {
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  return mutateJsonState(paths.statePath, transform, {
    createIfMissing: true,
    initial: initialState(),
  });
}

export async function markBatchAccepted(
  batch: PendingBatch,
  result: { jobIds?: string[] },
  opts: QueueAccessOptions = {},
): Promise<void> {
  await mutateQueueState(opts, (current) => ({
    ...current,
    processedLineCount: current.processedLineCount + batch.lineCount,
    acceptedBatches: [
      ...current.acceptedBatches.slice(-49),
      {
        batchId: batch.entries[0]?.entryId ?? randomUUID(),
        idempotencyKey: batch.idempotencyKey,
        acceptedAt: (opts.now ?? new Date()).toISOString(),
        rowCount: batch.entries.length,
        jobIds: result.jobIds ?? [],
        entries: batch.entries.map((entry) => ({
          entryId: entry.entryId,
          idempotencyKey: entry.idempotencyKey,
          ...(entry.provenance ? { provenance: entry.provenance } : {}),
        })),
      },
    ],
    lastError: null,
  }));
}

export async function markBatchTransientFailure(
  batch: PendingBatch,
  failure: HokusaiQueueFailureDetail,
  opts: QueueAccessOptions & {
    maxRetries?: number;
    nextAttemptAt: string;
  },
): Promise<'retry_scheduled' | 'dead_lettered'> {
  const now = opts.now ?? new Date();
  const maxRetries = opts.maxRetries ?? getHokusaiContributionsConfig(opts.repoDir).maxRetries;
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const exhausted = batch.entries.some((entry) => entry.attempts + 1 >= maxRetries);

  if (exhausted) {
    for (const entry of batch.entries) {
      appendJsonlLine(paths.deadLetterPath, {
        entry,
        failure: { ...failure, code: 'transient_exhausted' },
      });
    }
    await mutateQueueState(opts, (current) => ({
      ...current,
      processedLineCount: current.processedLineCount + batch.lineCount,
      lastError: { ...failure, code: 'transient_exhausted', at: now.toISOString() },
    }));
    return 'dead_lettered';
  }

  for (const entry of batch.entries) {
    appendEnvelope(paths, {
      ...entry,
      entryId: randomUUID(),
      attempts: entry.attempts + 1,
      nextAttemptAt: opts.nextAttemptAt,
    });
  }

  await mutateQueueState(opts, (current) => ({
    ...current,
    processedLineCount: current.processedLineCount + batch.lineCount,
    lastError: failure,
  }));
  return 'retry_scheduled';
}

export async function markBatchPermanentFailure(
  batch: PendingBatch,
  failure: HokusaiQueueFailureDetail,
  opts: QueueAccessOptions = {},
): Promise<void> {
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  for (const entry of batch.entries) {
    appendJsonlLine(paths.deadLetterPath, {
      entry,
      failure,
    });
  }
  await mutateQueueState(opts, (current) => ({
    ...current,
    processedLineCount: current.processedLineCount + batch.lineCount,
    lastError: failure,
  }));
}

export async function updateExportCursor(
  lineCount: number,
  opts: QueueAccessOptions = {},
): Promise<void> {
  await mutateQueueState(opts, (current) => ({
    ...current,
    exportLineCount: current.exportLineCount + lineCount,
  }));
}

export function listUnexportedEntries(opts: QueueAccessOptions = {}): HokusaiQueueEnvelope[] {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return [];
  }
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const state = loadStateOrDefault(paths.statePath);
  return readLines(paths.pendingPath)
    .slice(state.exportLineCount)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HokusaiQueueEnvelope];
      } catch {
        return [];
      }
    });
}

export function createSafeFailure(
  code: string,
  message: string,
  now: Date,
  status?: number,
): HokusaiQueueFailureDetail {
  return safeFailure(code, message, now, status);
}

export function hokusaiQueueStatus(opts: QueueAccessOptions = {}): HokusaiQueueStatus {
  const consent = getContributionConsentStatus(opts);
  const config = getHokusaiContributionsConfig(opts.repoDir);
  if (!consent.submissionAllowed) {
    return {
      enabled: false,
      consentValid: consent.consentValid,
      queueExists: false,
      endpointConfigured: Boolean(config.endpoint),
      exportConfigured: Boolean(config.exportPath),
      pendingCount: 0,
      deadLetterCount: 0,
      processedLineCount: 0,
      exportLineCount: 0,
      lastError: null,
    };
  }

  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const queueExists = existsSync(paths.rootDir);
  let state = initialState();
  if (queueExists) {
    try {
      state = loadStateOrDefault(paths.statePath);
    } catch (error) {
      return {
        enabled: true,
        consentValid: consent.consentValid,
        queueExists,
        endpointConfigured: Boolean(config.endpoint),
        exportConfigured: Boolean(config.exportPath),
        pendingCount: 0,
        deadLetterCount: 0,
        processedLineCount: 0,
        exportLineCount: 0,
        lastError: safeFailure('state_parse_error', errorMessage(error), opts.now ?? new Date()),
      };
    }
  }
  const pendingLines = queueExists ? readLines(paths.pendingPath) : [];
  const deadLetterLines = queueExists ? readLines(paths.deadLetterPath) : [];

  return {
    enabled: true,
    consentValid: consent.consentValid,
    queueExists,
    endpointConfigured: Boolean(config.endpoint),
    exportConfigured: Boolean(config.exportPath),
    pendingCount: Math.max(pendingLines.length - state.processedLineCount, 0),
    deadLetterCount: deadLetterLines.length,
    processedLineCount: state.processedLineCount,
    exportLineCount: state.exportLineCount,
    lastError: state.lastError,
  };
}
