/**
 * Reconcile and backfill Hokusai submissions.
 *
 * Legacy date/id backfill still routes through `triggerHokusaiSubmission`, but
 * promoted-evidence backfill must first classify every explicitly reviewed eval
 * by stable eval ID across local Hokusai persistence surfaces. Content hashes
 * remain transport dedupe details only.
 */

import { prepareTerminalArmFeedback } from './terminal-arm-feedback.ts';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import {
  formatHokusaiSubmissionTriggerResult,
  triggerHokusaiSubmission,
} from './hokusai-submission-trigger.ts';
import { toHokusaiSubmission } from './hokusai-schema.ts';
import { getHokusaiSubmissionConfig, getHokusaiSubmissionEnableSources } from './config.ts';
import {
  type AcceptedBatchRecord,
  type DeadLetterRecord,
  type HokusaiQueueEnvelope,
  type HokusaiQueueProvenance,
  type HokusaiQueueState,
} from './hokusai-queue.ts';
import { readHokusaiLedger, type HokusaiLedgerEntry } from './hokusai-ledger.ts';
import { resolveHokusaiQueuePaths } from './hokusai-queue-paths.ts';
import { resolveHokusaiRewardLedgerPaths } from './hokusai-reward-ledger-paths.ts';

export type HokusaiObservedSourceState =
  | { state: 'never_submitted'; evidence: HokusaiSourceEvidence[] }
  | { state: 'pending'; evidence: HokusaiSourceEvidence[] }
  | { state: 'rejected'; evidence: HokusaiSourceEvidence[] }
  | { state: 'accepted'; evidence: HokusaiSourceEvidence[] }
  | { state: 'exported'; evidence: HokusaiSourceEvidence[] }
  | { state: 'ambiguous'; reason: HokusaiRefusalReason; evidence: HokusaiSourceEvidence[] };

export type HokusaiReconciliationDecision =
  | {
    action: 'enqueue_final';
    sourceState: 'never_submitted';
    reason: 'eligible_promoted_never_submitted';
    operatorAction: 'apply_backfill';
  }
  | {
    action: 'no_op';
    sourceState: 'pending';
    reason: 'already_pending';
    operatorAction: 'wait_for_existing_queue_entry';
  }
  | {
    action: 'refuse';
    sourceState: Exclude<HokusaiObservedSourceState['state'], 'never_submitted'>;
    reason: HokusaiRefusalReason;
    operatorAction: string;
  };

export type HokusaiRefusalReason =
  | 'ambiguous_identity'
  | 'manifest_not_reviewed'
  | 'manifest_lineage_mismatch'
  | 'eval_not_in_manifest'
  | 'finalization_lineage_mismatch'
  | 'not_eligible'
  | 'accepted_requires_correction_tombstone'
  | 'correction_endpoint_unavailable'
  | 'dead_letter_requires_manual_reconciliation'
  | 'exported_requires_operator_review';

export interface HokusaiSourceEvidence {
  surface:
    | 'pending_queue'
    | 'dead_letter_queue'
    | 'accepted_queue_state'
    | 'export_cursor'
    | 'trigger_log'
    | 'hokusai_ledger'
    | 'reward_ledger'
    | 'reconciliation_report';
  state: Exclude<HokusaiObservedSourceState['state'], 'never_submitted' | 'ambiguous'> | 'triggered';
  evalId?: string;
  entryId?: string;
  idempotencyKey?: string;
  batchId?: string | null;
  jobId?: string;
  jobIds?: string[];
  contributionId?: string;
  status?: string;
  at?: string;
  reportHash?: string;
  detail?: string;
}

export interface HokusaiPromotionManifestIdentity {
  alias?: string;
  revision?: number;
  fingerprint?: string;
}

export interface HokusaiPromotionManifestRow {
  evalId: string;
  fromRevision: number;
  toRevision: number;
  oldIdentity?: HokusaiPromotionManifestIdentity;
  finalIdentity?: HokusaiPromotionManifestIdentity;
  correctionAcknowledgement?: {
    contributionId?: string;
    acknowledgedAt?: string;
  };
}

export interface HokusaiPromotionBackfillManifest {
  schemaVersion: 'hokusai.promoted-evidence-backfill.v1';
  manifestId: string;
  reviewed: true;
  sourcePath: string;
  sourceHash: string;
  rows: HokusaiPromotionManifestRow[];
}

export interface HokusaiReconciliationReportDecision {
  evalId: string;
  issueId: string;
  oldIdentity?: HokusaiPromotionManifestIdentity;
  finalIdentity?: HokusaiPromotionManifestIdentity;
  fromRevision: number;
  toRevision: number;
  sourceState: HokusaiObservedSourceState;
  decision: HokusaiReconciliationDecision;
  contributionIdentifiers: HokusaiSourceEvidence[];
}

export interface HokusaiReconciliationReport {
  schemaVersion: 'hokusai.reconciliation-report.v1';
  generatedAt: string;
  applied: boolean;
  repoDir: string;
  promotionManifestId: string;
  promotionManifestHash: string;
  decisions: HokusaiReconciliationReportDecision[];
  reportHash: string;
}

export interface HokusaiBackfillOptions {
  repoDir: string;
  configDir?: string;
  /** Inclusive ISO date (YYYY-MM-DD) lower bound on record timestamp. */
  since?: string;
  /** Inclusive ISO date (YYYY-MM-DD) upper bound on record timestamp. */
  until?: string;
  /** Restrict to specific eval record ids. */
  ids?: string[];
  apply?: boolean;
  /** Reviewed promotion/finalization manifest for promoted-evidence mode. */
  promotionManifestPath?: string;
}

export interface HokusaiBackfillRecordResult {
  id: string;
  issueId: string;
  timestamp: string;
  status: string;
  action?: HokusaiReconciliationDecision['action'];
  reason?: string;
}

export interface HokusaiBackfillSummary {
  applied: boolean;
  scanned: number;
  selected: number;
  results: HokusaiBackfillRecordResult[];
  counts: Record<string, number>;
  reconciliationReportPath?: string;
  reconciliationReportHash?: string;
}

interface ReconciliationIndex {
  byEvalId: Map<string, HokusaiSourceEvidence[]>;
}

function readEvalRecords(repoDir: string): EvalRecord[] {
  const path = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  const out: EvalRecord[] = [];
  if (!existsSync(path)) {
    return out;
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as EvalRecord);
    } catch {
      // A malformed historical line is not a record to resubmit.
    }
  }
  return out;
}

export function selectBackfillRecords(
  records: readonly EvalRecord[],
  options: Pick<HokusaiBackfillOptions, 'since' | 'until' | 'ids'>,
): EvalRecord[] {
  const ids = options.ids && options.ids.length > 0 ? new Set(options.ids) : null;
  return records.filter((record) => {
    if (ids) return typeof record.id === 'string' && ids.has(record.id);
    const day = String(record.timestamp ?? '').slice(0, 10);
    if (!day) return false;
    if (options.since && day < options.since) return false;
    if (options.until && day > options.until) return false;
    return true;
  });
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }
  }
  return undefined;
}

function identityField(value: unknown): HokusaiPromotionManifestIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const identity: HokusaiPromotionManifestIdentity = {};
  const alias = stringField(record, ['alias', 'modelAlias', 'model_alias']);
  const revision = numberField(record, ['revision', 'identityRevision', 'identity_revision']);
  const fingerprint = stringField(record, ['fingerprint', 'identityFingerprint', 'identity_fingerprint']);
  if (alias) identity.alias = alias;
  if (revision !== undefined) identity.revision = revision;
  if (fingerprint) identity.fingerprint = fingerprint;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function rowsFromManifest(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  for (const key of ['rows', 'promotions', 'promotedEvalIds', 'evals']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function manifestReviewed(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.reviewed === true
    || record.applied === true
    || record.status === 'reviewed'
    || record.status === 'applied';
}

function parsePromotionManifestRow(value: unknown): HokusaiPromotionManifestRow {
  if (typeof value === 'string') {
    throw new Error(`Promotion row ${value} is missing from/to identity revisions`);
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Promotion manifest rows must be objects');
  }
  const record = value as Record<string, unknown>;
  const evalId = stringField(record, ['evalId', 'eval_id', 'id', 'stableEvalId', 'stable_eval_id']);
  const oldEvalId = stringField(record, ['oldEvalId', 'old_eval_id', 'fromEvalId', 'from_eval_id']);
  const newEvalId = stringField(record, ['newEvalId', 'new_eval_id', 'toEvalId', 'to_eval_id']);
  const fromRevision = numberField(record, ['fromRevision', 'from_revision', 'oldRevision', 'old_revision']);
  const toRevision = numberField(record, ['toRevision', 'to_revision', 'finalRevision', 'final_revision', 'newRevision', 'new_revision']);
  if (!evalId) {
    throw new Error('Promotion manifest row is missing evalId');
  }
  if (oldEvalId && oldEvalId !== evalId) {
    throw new Error(`Promotion manifest row ${evalId} changes stable eval ID from ${oldEvalId}`);
  }
  if (newEvalId && newEvalId !== evalId) {
    throw new Error(`Promotion manifest row ${evalId} changes stable eval ID to ${newEvalId}`);
  }
  if (fromRevision === undefined || toRevision === undefined) {
    throw new Error(`Promotion manifest row ${evalId} is missing from/to identity revisions`);
  }
  const correction = record.correctionAcknowledgement ?? record.correction_acknowledgement ?? record.tombstoneAcknowledgement;
  return {
    evalId,
    fromRevision,
    toRevision,
    oldIdentity: identityField(record.oldIdentity ?? record.old_identity),
    finalIdentity: identityField(record.finalIdentity ?? record.final_identity ?? record.newIdentity),
    ...(correction && typeof correction === 'object'
      ? {
        correctionAcknowledgement: {
          ...(stringField(correction as Record<string, unknown>, ['contributionId', 'contribution_id'])
            ? { contributionId: stringField(correction as Record<string, unknown>, ['contributionId', 'contribution_id']) }
            : {}),
          ...(stringField(correction as Record<string, unknown>, ['acknowledgedAt', 'acknowledged_at'])
            ? { acknowledgedAt: stringField(correction as Record<string, unknown>, ['acknowledgedAt', 'acknowledged_at']) }
            : {}),
        },
      }
      : {}),
  };
}

/**
 * A model-promotion manifest (shared/lib/model-promotion.ts) that promoted no
 * evidence is a legitimate zero-row reconciliation input: the promotion held
 * all evidence, so the report must show zero backfills and zero duplicates
 * rather than refusing. The manifest proves this itself via its conservation
 * block (eval IDs conserved). Hand-written row manifests keep the strict
 * explicit-rows requirement.
 */
function isZeroEvidencePromotionManifest(record: Record<string, unknown>): boolean {
  const conservation = record.conservation;
  if (!conservation || typeof conservation !== 'object') {
    return false;
  }
  return record.schemaVersion === '1'
    && typeof record.promotionId === 'string'
    && (conservation as Record<string, unknown>).evalIdsConserved === true;
}

export function readPromotionBackfillManifest(path: string): HokusaiPromotionBackfillManifest {
  const text = readFileSync(path, 'utf-8');
  const sourceHash = sha256Hex(text);
  const parsed = JSON.parse(text) as unknown;
  if (!manifestReviewed(parsed)) {
    throw new Error('Promotion manifest must be reviewed or applied before Hokusai backfill');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Promotion manifest must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const manifestId = stringField(record, ['manifestId', 'manifest_id', 'id']) ?? `sha256:${sourceHash}`;
  const rows = rowsFromManifest(parsed).map(parsePromotionManifestRow);
  if (rows.length === 0 && !isZeroEvidencePromotionManifest(record)) {
    throw new Error('Promotion manifest must include explicit promoted eval rows');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.evalId)) {
      throw new Error(`Promotion manifest repeats evalId ${row.evalId}`);
    }
    seen.add(row.evalId);
  }
  return {
    schemaVersion: 'hokusai.promoted-evidence-backfill.v1',
    manifestId,
    reviewed: true,
    sourcePath: path,
    sourceHash,
    rows,
  };
}

function addEvidence(index: ReconciliationIndex, evidence: HokusaiSourceEvidence): void {
  if (!evidence.evalId) {
    return;
  }
  const current = index.byEvalId.get(evidence.evalId) ?? [];
  current.push(evidence);
  index.byEvalId.set(evidence.evalId, current);
}

function evidenceFromProvenance(
  surface: HokusaiSourceEvidence['surface'],
  state: HokusaiSourceEvidence['state'],
  provenance: HokusaiQueueProvenance | undefined,
  extras: Omit<HokusaiSourceEvidence, 'surface' | 'state' | 'evalId'> = {},
): HokusaiSourceEvidence | undefined {
  if (!provenance?.evalId) {
    return undefined;
  }
  return {
    surface,
    state,
    evalId: provenance.evalId,
    ...extras,
  };
}

function readQueueState(repoDir: string): HokusaiQueueState | null {
  const statePath = resolveHokusaiQueuePaths(repoDir).statePath;
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return parseJsonFile(statePath) as HokusaiQueueState;
  } catch {
    return null;
  }
}

function indexQueueSurfaces(index: ReconciliationIndex, repoDir: string): void {
  const paths = resolveHokusaiQueuePaths(repoDir);
  const state = readQueueState(repoDir);
  const processedLineCount = state?.processedLineCount ?? 0;
  const exportLineCount = state?.exportLineCount ?? 0;
  const pendingLines = readJsonl(paths.pendingPath) as HokusaiQueueEnvelope[];
  pendingLines.forEach((entry, lineIndex) => {
    const pendingState = lineIndex < exportLineCount && lineIndex >= processedLineCount
      ? 'exported'
      : lineIndex >= processedLineCount
        ? 'pending'
        : undefined;
    if (!pendingState) {
      return;
    }
    const evidence = evidenceFromProvenance(
      pendingState === 'exported' ? 'export_cursor' : 'pending_queue',
      pendingState,
      entry.provenance,
      { entryId: entry.entryId, idempotencyKey: entry.idempotencyKey, at: entry.enqueuedAt },
    );
    if (evidence) addEvidence(index, evidence);
  });

  for (const record of readJsonl(paths.deadLetterPath) as DeadLetterRecord[]) {
    const evidence = evidenceFromProvenance(
      'dead_letter_queue',
      'rejected',
      record.entry?.provenance,
      {
        entryId: record.entry?.entryId,
        idempotencyKey: record.entry?.idempotencyKey,
        status: record.failure?.code,
        at: record.failure?.at,
        detail: record.failure?.message,
      },
    );
    if (evidence) addEvidence(index, evidence);
  }

  for (const batch of (state?.acceptedBatches ?? []) as AcceptedBatchRecord[]) {
    for (const entry of batch.entries ?? []) {
      const evidence = evidenceFromProvenance(
        'accepted_queue_state',
        'accepted',
        entry.provenance,
        {
          entryId: entry.entryId,
          idempotencyKey: entry.idempotencyKey,
          batchId: batch.batchId,
          jobIds: batch.jobIds,
          at: batch.acceptedAt,
        },
      );
      if (evidence) addEvidence(index, evidence);
    }
  }
}

function indexTriggerLog(index: ReconciliationIndex, repoDir: string): void {
  const path = resolveHokusaiQueuePaths(repoDir).triggerLogPath;
  for (const entry of readJsonl(path) as Array<Record<string, unknown>>) {
    const evalId = stringField(entry, ['evalId']);
    const status = stringField(entry, ['status']);
    if (!evalId || !status) {
      continue;
    }
    if (status !== 'enqueued' && status !== 'duplicate') {
      continue;
    }
    addEvidence(index, {
      surface: 'trigger_log',
      state: 'triggered',
      evalId,
      entryId: stringField(entry, ['entryId']),
      idempotencyKey: stringField(entry, ['idempotencyKey']),
      status,
      at: stringField(entry, ['at']),
      reportHash: stringField(entry, ['reconciliationReportHash']),
    });
  }
}

function indexHokusaiLedger(index: ReconciliationIndex, repoDir: string): void {
  for (const entry of readHokusaiLedger({ repoDir }) as HokusaiLedgerEntry[]) {
    const state = entry.eventType === 'accepted'
      ? 'accepted'
      : entry.eventType === 'rejected'
        ? 'rejected'
        : undefined;
    if (!state) {
      continue;
    }
    for (const provenance of entry.queueProvenance ?? []) {
      const evidence = evidenceFromProvenance('hokusai_ledger', state, provenance, {
        idempotencyKey: entry.idempotencyKey,
        batchId: entry.batchId,
        jobId: entry.jobId ?? entry.submissionId,
        jobIds: entry.jobIds,
        at: entry.timestamp,
        status: entry.eventType,
      });
      if (evidence) addEvidence(index, evidence);
    }
  }
}

function indexRewardLedger(index: ReconciliationIndex, repoDir: string): void {
  const path = resolveHokusaiRewardLedgerPaths(repoDir).ledgerPath;
  if (!existsSync(path)) {
    return;
  }
  let entries: Array<Record<string, unknown>> = [];
  try {
    const parsed = parseJsonFile(path) as { entries?: Array<Record<string, unknown>> };
    entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return;
  }
  for (const entry of entries) {
    const status = stringField(entry, ['status']);
    const state = status === 'accepted'
      ? 'accepted'
      : status === 'rejected'
        ? 'rejected'
        : undefined;
    if (!state || !Array.isArray(entry.queueProvenance)) {
      continue;
    }
    for (const provenance of entry.queueProvenance as HokusaiQueueProvenance[]) {
      const evidence = evidenceFromProvenance('reward_ledger', state, provenance, {
        contributionId: stringField(entry, ['contributionId']),
        idempotencyKey: stringField(entry, ['idempotencyKey']),
        batchId: stringField(entry, ['batchId']) ?? null,
        jobIds: Array.isArray(entry.hokusaiJobIds)
          ? entry.hokusaiJobIds.filter((jobId): jobId is string => typeof jobId === 'string')
          : undefined,
        at: stringField(entry, ['acceptedAt']) ?? stringField(entry, ['submittedAt']),
        status,
      });
      if (evidence) addEvidence(index, evidence);
    }
  }
}

function indexPriorReports(index: ReconciliationIndex, repoDir: string): void {
  const dir = join(resolveHokusaiQueuePaths(repoDir).rootDir, 'reconciliation');
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    let report: HokusaiReconciliationReport | undefined;
    try {
      report = parseJsonFile(join(dir, name)) as HokusaiReconciliationReport;
    } catch {
      continue;
    }
    for (const decision of report.decisions ?? []) {
      if (decision.decision?.action !== 'enqueue_final') {
        continue;
      }
      addEvidence(index, {
        surface: 'reconciliation_report',
        state: 'triggered',
        evalId: decision.evalId,
        reportHash: report.reportHash,
        at: report.generatedAt,
        status: decision.decision.action,
      });
    }
  }
}

export function buildHokusaiReconciliationIndex(repoDir: string): ReconciliationIndex {
  const index: ReconciliationIndex = { byEvalId: new Map() };
  indexQueueSurfaces(index, repoDir);
  indexTriggerLog(index, repoDir);
  indexHokusaiLedger(index, repoDir);
  indexRewardLedger(index, repoDir);
  indexPriorReports(index, repoDir);
  return index;
}

function classifySourceState(evidence: HokusaiSourceEvidence[]): HokusaiObservedSourceState {
  const terminalStates = new Set(
    evidence
      .map((entry) => entry.state)
      .filter((state): state is 'pending' | 'rejected' | 'accepted' | 'exported' => state !== 'triggered'),
  );
  if (terminalStates.size === 0) {
    if (evidence.some((entry) => entry.state === 'triggered')) {
      return { state: 'ambiguous', reason: 'ambiguous_identity', evidence };
    }
    return { state: 'never_submitted', evidence: [] };
  }
  if (terminalStates.size > 1) {
    return { state: 'ambiguous', reason: 'ambiguous_identity', evidence };
  }
  const [state] = [...terminalStates];
  return { state, evidence };
}

function validatePromotionLineage(
  record: EvalRecord,
  row: HokusaiPromotionManifestRow,
  manifest: HokusaiPromotionBackfillManifest,
): HokusaiRefusalReason | null {
  if (record.id !== row.evalId) {
    return 'eval_not_in_manifest';
  }
  const finalization = record.modelIdentityAttribution?.finalization;
  if (!finalization) {
    return 'finalization_lineage_mismatch';
  }
  if (
    finalization.fromRevision !== row.fromRevision
    || finalization.toRevision !== row.toRevision
  ) {
    return 'finalization_lineage_mismatch';
  }
  if (
    manifest.manifestId !== `sha256:${manifest.sourceHash}`
    && finalization.manifestId !== manifest.manifestId
  ) {
    return 'manifest_lineage_mismatch';
  }
  const coderRevision = record.modelIdentityAttribution?.roles.coder?.identityRevision;
  if (coderRevision !== undefined && coderRevision !== row.toRevision) {
    return 'finalization_lineage_mismatch';
  }
  return null;
}

function refusalDecision(
  sourceState: HokusaiObservedSourceState,
  reason: HokusaiRefusalReason,
): HokusaiReconciliationDecision {
  const state = sourceState.state === 'never_submitted' ? 'ambiguous' : sourceState.state;
  const operatorActionByReason: Record<HokusaiRefusalReason, string> = {
    ambiguous_identity: 'inspect local Hokusai queue/ledger records and add stable eval provenance before retrying',
    manifest_not_reviewed: 'review and mark the promotion manifest before retrying',
    manifest_lineage_mismatch: 'rerun promotion/finalization and use the matching manifest',
    eval_not_in_manifest: 'add the eval ID to the reviewed promotion manifest',
    finalization_lineage_mismatch: 'finalize the eval identity lineage before Hokusai backfill',
    not_eligible: 'fix eligibility, consent, or redaction blockers before retrying',
    accepted_requires_correction_tombstone: 'obtain a correction/tombstone acknowledgement for the accepted provisional contribution',
    correction_endpoint_unavailable: 'wait for Hokusai correction/tombstone support before resubmitting accepted evidence',
    dead_letter_requires_manual_reconciliation: 'repair or tombstone the existing dead-letter contribution; do not append a new run',
    exported_requires_operator_review: 'remove or tombstone the exported contribution before enqueueing a final replacement',
  };
  return {
    action: 'refuse',
    sourceState: state,
    reason,
    operatorAction: operatorActionByReason[reason],
  };
}

function decideForRecord(
  record: EvalRecord,
  row: HokusaiPromotionManifestRow,
  manifest: HokusaiPromotionBackfillManifest,
  sourceState: HokusaiObservedSourceState,
): HokusaiReconciliationDecision {
  const lineageFailure = validatePromotionLineage(record, row, manifest);
  if (lineageFailure) {
    return refusalDecision(sourceState, lineageFailure);
  }
  const eligibility = toHokusaiSubmission(record);
  if (!eligibility.ok) {
    return refusalDecision(sourceState, 'not_eligible');
  }
  switch (sourceState.state) {
    case 'never_submitted':
      return {
        action: 'enqueue_final',
        sourceState: 'never_submitted',
        reason: 'eligible_promoted_never_submitted',
        operatorAction: 'apply_backfill',
      };
    case 'pending':
      return {
        action: 'no_op',
        sourceState: 'pending',
        reason: 'already_pending',
        operatorAction: 'wait_for_existing_queue_entry',
      };
    case 'rejected':
      return refusalDecision(sourceState, 'dead_letter_requires_manual_reconciliation');
    case 'exported':
      return refusalDecision(sourceState, 'exported_requires_operator_review');
    case 'accepted':
      return refusalDecision(
        sourceState,
        row.correctionAcknowledgement
          ? 'correction_endpoint_unavailable'
          : 'accepted_requires_correction_tombstone',
      );
    case 'ambiguous':
      return refusalDecision(sourceState, sourceState.reason);
  }
}

function buildReconciliationReport(
  repoDir: string,
  applied: boolean,
  manifest: HokusaiPromotionBackfillManifest,
  selected: EvalRecord[],
  index: ReconciliationIndex,
): HokusaiReconciliationReport {
  const rowByEvalId = new Map(manifest.rows.map((row) => [row.evalId, row]));
  const decisions: HokusaiReconciliationReportDecision[] = selected.map((record) => {
    const evalId = String(record.id ?? '');
    const row = rowByEvalId.get(evalId);
    if (!row) {
      const sourceState: HokusaiObservedSourceState = { state: 'ambiguous', reason: 'eval_not_in_manifest', evidence: [] };
      return {
        evalId,
        issueId: String(record.issueId ?? ''),
        fromRevision: -1,
        toRevision: -1,
        sourceState,
        decision: refusalDecision(sourceState, 'eval_not_in_manifest'),
        contributionIdentifiers: [],
      };
    }
    const evidence = index.byEvalId.get(evalId) ?? [];
    const sourceState = classifySourceState(evidence);
    const decision = decideForRecord(record, row, manifest, sourceState);
    return {
      evalId,
      issueId: String(record.issueId ?? ''),
      oldIdentity: row.oldIdentity,
      finalIdentity: row.finalIdentity,
      fromRevision: row.fromRevision,
      toRevision: row.toRevision,
      sourceState,
      decision,
      contributionIdentifiers: evidence.filter((entry) => (
        Boolean(entry.entryId)
        || Boolean(entry.idempotencyKey)
        || Boolean(entry.batchId)
        || Boolean(entry.jobId)
        || Boolean(entry.jobIds?.length)
        || Boolean(entry.contributionId)
        || Boolean(entry.reportHash)
      )),
    };
  });
  const unsigned = {
    schemaVersion: 'hokusai.reconciliation-report.v1' as const,
    generatedAt: new Date().toISOString(),
    applied,
    repoDir,
    promotionManifestId: manifest.manifestId,
    promotionManifestHash: manifest.sourceHash,
    decisions,
  };
  const reportHash = sha256Hex(toStableJson(unsigned));
  return { ...unsigned, reportHash };
}

function reconciliationReportPath(repoDir: string, reportHash: string): string {
  return join(resolveHokusaiQueuePaths(repoDir).rootDir, 'reconciliation', `report-${reportHash}.json`);
}

function persistReconciliationReport(report: HokusaiReconciliationReport): string {
  const path = reconciliationReportPath(report.repoDir, report.reportHash);
  mkdirSync(join(resolveHokusaiQueuePaths(report.repoDir).rootDir, 'reconciliation'), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }
  return path;
}

function promotedManifestSelection(
  records: readonly EvalRecord[],
  manifest: HokusaiPromotionBackfillManifest,
  options: Pick<HokusaiBackfillOptions, 'ids'>,
): EvalRecord[] {
  const manifestIds = new Set(manifest.rows.map((row) => row.evalId));
  if (options.ids?.length) {
    const outside = options.ids.filter((id) => !manifestIds.has(id));
    if (outside.length > 0) {
      throw new Error(`Selected eval IDs are outside the promotion manifest: ${outside.join(', ')}`);
    }
  }
  const explicit = options.ids?.length ? new Set(options.ids) : manifestIds;
  return records.filter((record) => typeof record.id === 'string' && explicit.has(record.id));
}

function legacyDryRunStatus(repoDir: string, record: EvalRecord): string {
  if (getHokusaiSubmissionConfig(repoDir).enabled !== true) {
    const sources = getHokusaiSubmissionEnableSources(repoDir);
    return `would-skip: submission disabled (repo_config: hokusai.dataSubmission.enabled resolved false for repoDir=${repoDir} (base=${sources.baseEnabled ?? 'unset'} local=${sources.localEnabled ?? 'unset'}))`;
  }
  const eligibility = toHokusaiSubmission(record);
  return eligibility.ok
    ? 'would-submit'
    : `would-skip: not eligible (${eligibility.reasons.join(', ') || 'no reason provided'})`;
}

function promotedStatus(decision: HokusaiReconciliationDecision, applied: boolean): string {
  if (decision.action === 'enqueue_final') {
    return applied ? 'pending-enqueue' : 'would-submit: promoted never-submitted';
  }
  if (decision.action === 'no_op') {
    return `no-op: ${decision.reason}`;
  }
  return `refused: ${decision.reason}; ${decision.operatorAction}`;
}

async function runLegacyBackfill(
  options: HokusaiBackfillOptions,
): Promise<HokusaiBackfillSummary> {
  const { repoDir, apply = false } = options;
  const all = readEvalRecords(repoDir);
  const selected = selectBackfillRecords(all, options);
  const results: HokusaiBackfillRecordResult[] = [];
  const counts: Record<string, number> = {};

  for (const record of selected) {
    let status: string;
    if (!apply) {
      const prepared = getHokusaiSubmissionConfig(repoDir).enabled === true
        ? await prepareTerminalArmFeedback(record, { repoDir })
        : { record };
      status = legacyDryRunStatus(repoDir, prepared.record);
    } else {
      try {
        status = formatHokusaiSubmissionTriggerResult(
          await triggerHokusaiSubmission(record, { repoDir, configDir: options.configDir }),
        );
      } catch (error) {
        status = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    counts[status] = (counts[status] ?? 0) + 1;
    results.push({
      id: String(record.id ?? ''),
      issueId: String(record.issueId ?? ''),
      timestamp: String(record.timestamp ?? ''),
      status,
    });
  }

  return { applied: apply, scanned: all.length, selected: selected.length, results, counts };
}

export async function backfillHokusaiSubmissions(
  options: HokusaiBackfillOptions,
): Promise<HokusaiBackfillSummary> {
  const { repoDir, apply = false } = options;
  if (!options.promotionManifestPath) {
    if (!options.ids?.length && !options.since && !options.until) {
      throw new Error('hokusai-backfill requires --since/--until or --ids; refusing to resubmit the entire corpus');
    }
    return runLegacyBackfill(options);
  }

  const manifest = readPromotionBackfillManifest(options.promotionManifestPath);
  const all = readEvalRecords(repoDir);
  const selected = promotedManifestSelection(all, manifest, options);
  const index = buildHokusaiReconciliationIndex(repoDir);
  const report = buildReconciliationReport(repoDir, apply, manifest, selected, index);
  const reportPath = apply ? persistReconciliationReport(report) : undefined;

  const rowByEvalId = new Map(manifest.rows.map((row) => [row.evalId, row]));
  const decisionByEvalId = new Map(report.decisions.map((decision) => [decision.evalId, decision]));
  const results: HokusaiBackfillRecordResult[] = [];
  const counts: Record<string, number> = {};

  for (const record of selected) {
    const evalId = String(record.id ?? '');
    const reportDecision = decisionByEvalId.get(evalId)!;
    const row = rowByEvalId.get(evalId)!;
    let status = promotedStatus(reportDecision.decision, apply);
    if (apply && reportDecision.decision.action === 'enqueue_final') {
      const finalFingerprint = row.finalIdentity?.fingerprint
        ?? record.modelIdentityAttribution?.roles.coder?.fingerprint;
      status = formatHokusaiSubmissionTriggerResult(
        await triggerHokusaiSubmission(record, {
          repoDir,
          configDir: options.configDir,
          promotedBackfill: {
            manifestId: manifest.manifestId,
            fromRevision: row.fromRevision,
            toRevision: row.toRevision,
            ...(finalFingerprint ? { finalFingerprint } : {}),
            reconciliationReportHash: report.reportHash,
          },
        }),
      );
    }
    counts[status] = (counts[status] ?? 0) + 1;
    results.push({
      id: evalId,
      issueId: String(record.issueId ?? ''),
      timestamp: String(record.timestamp ?? ''),
      status,
      action: reportDecision.decision.action,
      reason: reportDecision.decision.reason,
    });
  }

  return {
    applied: apply,
    scanned: all.length,
    selected: selected.length,
    results,
    counts,
    ...(reportPath ? { reconciliationReportPath: reportPath } : {}),
    reconciliationReportHash: report.reportHash,
  };
}
