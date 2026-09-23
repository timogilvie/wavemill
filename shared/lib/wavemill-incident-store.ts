import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  canonicalizeRootCauseClass,
  hasPendingLifecycleTransition,
  type IncidentEvidence,
  type IncidentLifecycle,
  type IncidentLifecycleSyncMetadata,
  type IncidentRecord,
  type IncidentResolutionAction,
  WAVEMILL_INCIDENT_SCHEMA_VERSION,
} from './wavemill-incident-model.ts';
import { mutateJsonState, StateParseError } from './state-mutex.ts';

export interface IncidentStoreOptions {
  escalationThreshold?: number;
  maxEvidencePerRecord?: number;
  /** Consecutive successful observer cycles without a fresh event before auto-resolve. */
  resolutionAfterCycles?: number;
  now?: () => Date;
}

export interface IncidentUpsertResult {
  record: IncidentRecord;
  /** True when this upsert counted a new distinct source event (not a re-poll). */
  freshEvent: boolean;
}

// Event keys are retained independently of the capped evidence list so an old
// terminal job cannot begin counting again after evidence rotation.
const MAX_SEEN_EVENT_KEYS = 200;

export interface IncidentEvidenceLogEntry {
  observedAt: string;
  fingerprint: string;
  evidence: IncidentEvidence;
}

type IncidentIndex = Record<string, IncidentRecord>;

export interface LinearSyncMetadataInput {
  linearIssueId: string;
  linearIssueUrl?: string;
  evidenceRevision: string;
  syncedAt?: string;
  cooldownUntil?: string;
}

export interface LinearSyncErrorInput {
  action: string;
  message: string;
  category?: string;
  retryQueued?: boolean;
  at?: string;
}

export class IncidentStore {
  private readonly incidentsDir: string;
  private readonly escalationThreshold: number;
  private readonly maxEvidencePerRecord: number;
  private readonly resolutionAfterCycles: number;
  private readonly now: () => Date;

  constructor(
    incidentsDir: string,
    options: IncidentStoreOptions = {},
  ) {
    this.incidentsDir = incidentsDir;
    this.escalationThreshold = options.escalationThreshold ?? 3;
    this.maxEvidencePerRecord = options.maxEvidencePerRecord ?? 50;
    this.resolutionAfterCycles = options.resolutionAfterCycles ?? 5;
    this.now = options.now ?? (() => new Date());
  }

  computeFingerprint(incident: Pick<IncidentRecord, 'category' | 'rootCauseClass' | 'taskId' | 'evidence'>): string {
    const evidenceKeys = incident.evidence
      .map((evidence) => evidence.key ?? `${evidence.type}:${evidence.source}`)
      .sort();
    const input = [
      incident.category,
      canonicalizeRootCauseClass(incident.rootCauseClass),
      incident.taskId ?? '',
      JSON.stringify(evidenceKeys),
    ].join('::');
    return createHash('sha256').update(input).digest('hex');
  }

  /**
   * Stable identity of the underlying source event. Repeated polling of an
   * unchanged event (same evidence sources/keys/timestamps) yields the same
   * key, so it is counted once regardless of observer cadence.
   */
  computeEventKey(incident: Pick<IncidentRecord, 'category' | 'rootCauseClass' | 'taskId' | 'evidence'>): string {
    const evidenceIdentity = incident.evidence
      .map((evidence) => `${evidence.type}:${evidence.source}:${evidence.key ?? ''}:${evidence.timestamp}`)
      .sort();
    const input = [
      incident.category,
      canonicalizeRootCauseClass(incident.rootCauseClass),
      incident.taskId ?? '',
      JSON.stringify(evidenceIdentity),
    ].join('::');
    return createHash('sha256').update(input).digest('hex');
  }

  async upsert(incident: IncidentRecord): Promise<IncidentRecord> {
    return (await this.upsertDetailed(incident)).record;
  }

  async upsertDetailed(incident: IncidentRecord): Promise<IncidentUpsertResult> {
    mkdirSync(this.incidentsDir, { recursive: true });
    const canonicalIncident: IncidentRecord = {
      ...incident,
      rootCauseClass: canonicalizeRootCauseClass(incident.rootCauseClass),
    };
    const fingerprint = this.computeFingerprint(canonicalIncident);
    const eventKey = this.computeEventKey(canonicalIncident);
    const indexPath = join(this.incidentsDir, 'index.json');
    const observedAt = this.now().toISOString();
    let stored: IncidentRecord | undefined;
    let freshEvent = true;

    const updatedIndex = await this.mutateIndex(indexPath, (index) => {
      const legacyEntries = Object.entries(index)
        .filter(([key, record]) => key !== fingerprint && this.sameCanonicalIncident(record, canonicalIncident, record.taskId, canonicalIncident.taskId));
      for (const [key] of legacyEntries) delete index[key];

      const existing = this.mergeStoredRecords([
        index[fingerprint],
        ...legacyEntries.map(([, record]) => record),
      ].filter((record): record is IncidentRecord => Boolean(record)));
      const redactedEvidence = canonicalIncident.evidence.slice(-this.maxEvidencePerRecord);
      if (existing) {
        const seenEventKeys = Array.isArray(existing.metadata?.seenEventKeys) ? existing.metadata.seenEventKeys : [];
        freshEvent = !seenEventKeys.includes(eventKey);
        const firstObservedAt = this.backfillFirstObservedAt(existing, observedAt);
        if (!freshEvent) {
          // Re-poll of an already-counted event: no count/liveness change,
          // but refresh canonical identity and presentation fields while preserving store-owned metadata.
          const refreshed = this.refreshCanonicalFields(existing, canonicalIncident);
          stored = {
            ...refreshed,
            firstObservedAt,
            metadata: this.preserveStoreOwnedMetadata(existing.metadata, canonicalIncident.metadata),
          };
          index[fingerprint] = stored;
          return index;
        }

        const occurrenceCount = (existing.occurrenceCount || 0) + 1;
        const reopened = existing.lifecycle === 'resolved' || existing.lifecycle === 'archived';
        const baseLifecycle = reopened ? 'observed' : existing.lifecycle;
        const lifecycle = this.nextLifecycle(baseLifecycle, occurrenceCount);
        const previousRecurrence = existing.metadata?.recurrence;
        const metadata = {
          ...(existing.metadata ?? {}),
          thresholdTriggered: occurrenceCount >= this.escalationThreshold,
          seenEventKeys: [...seenEventKeys, eventKey].slice(-MAX_SEEN_EVENT_KEYS),
          lastEventAt: observedAt,
          missedCycles: 0,
          ...(lifecycle === 'active' && existing.lifecycle !== 'active' ? { escalatedAt: observedAt } : {}),
          ...(reopened ? {
            recurrence: {
              count: (previousRecurrence?.count ?? 0) + 1,
              lastRecurredAt: observedAt,
              reopenedFrom: existing.lifecycle,
            },
          } : {}),
        };
        stored = {
          ...this.refreshCanonicalFields(existing, canonicalIncident),
          lifecycle,
          firstObservedAt,
          lastObservedAt: observedAt,
          occurrenceCount,
          evidence: [...existing.evidence, ...redactedEvidence].slice(-this.maxEvidencePerRecord),
          metadata,
        };
        index[fingerprint] = stored;
        return index;
      }

      stored = {
        ...canonicalIncident,
        schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
        id: canonicalIncident.id || randomUUID(),
        fingerprint,
        createdAt: observedAt,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        occurrenceCount: 1,
        lifecycle: canonicalIncident.lifecycle ?? 'observed',
        evidence: redactedEvidence,
        metadata: {
          ...(canonicalIncident.metadata ?? {}),
          thresholdTriggered: 1 >= this.escalationThreshold,
          seenEventKeys: [eventKey],
          lastEventAt: observedAt,
          missedCycles: 0,
        },
      };
      index[fingerprint] = stored;
      return index;
    });

    const record = stored ?? updatedIndex[fingerprint];
    if (freshEvent) {
      this.appendEvidence(fingerprint, canonicalIncident.evidence, observedAt);
    }
    return { record, freshEvent };
  }

  /**
   * Explicit operator resolution/archival — the CLI path that replaces
   * hand-editing the index. Returns the updated record, or null when the
   * fingerprint is unknown.
   */
  async resolve(fingerprint: string, options: { reason?: string } = {}): Promise<IncidentRecord | null> {
    return this.applyLifecycleAction(fingerprint, 'resolved', 'operator_resolved', options.reason);
  }

  async archive(fingerprint: string, options: { reason?: string } = {}): Promise<IncidentRecord | null> {
    return this.applyLifecycleAction(fingerprint, 'archived', 'operator_archived', options.reason);
  }

  /**
   * Run after a fully successful observer cycle for this repository. Records
   * with a fresh distinct event this cycle keep missedCycles=0 (set by upsert);
   * every other observed/active record accrues a missed cycle and transitions
   * to resolved at the configured threshold. Must NOT be called when detection
   * for the repository failed or was disabled — absence of data is not absence
   * of the incident.
   *
   * An optional `canResolveByAbsence` gate lets the caller keep specific
   * records active despite absence — for example, an interactive-prompt block
   * (HOK-3045) that must not auto-resolve until its correlated task advances
   * or reaches a terminal state. When the gate returns false, missed cycles
   * still accrue for audit but the record stays active.
   */
  async runResolutionSweep(
    freshFingerprints: Iterable<string>,
    canResolveByAbsence?: (record: IncidentRecord) => boolean,
  ): Promise<IncidentRecord[]> {
    const fresh = new Set(freshFingerprints);
    const indexPath = join(this.incidentsDir, 'index.json');
    if (!existsSync(indexPath)) return [];
    const sweptAt = this.now().toISOString();
    const resolved: IncidentRecord[] = [];
    await this.mutateIndex(indexPath, (index) => {
      for (const [fingerprint, record] of Object.entries(index)) {
        if (record.lifecycle !== 'observed' && record.lifecycle !== 'active') continue;
        if (fresh.has(fingerprint)) {
          index[fingerprint] = { ...record, metadata: { ...(record.metadata ?? {}), missedCycles: 0 } };
          continue;
        }
        const missedCycles = (typeof record.metadata?.missedCycles === 'number' ? record.metadata.missedCycles : 0) + 1;
        const gateAllowsResolve = canResolveByAbsence ? canResolveByAbsence(record) : true;
        if (gateAllowsResolve && missedCycles >= this.resolutionAfterCycles) {
          const updated: IncidentRecord = {
            ...record,
            lifecycle: 'resolved',
            metadata: {
              ...(record.metadata ?? {}),
              missedCycles,
              resolution: {
                action: 'auto_resolved' as IncidentResolutionAction,
                at: sweptAt,
                reason: `not re-observed for ${missedCycles} consecutive observer cycles`,
              },
            },
          };
          index[fingerprint] = updated;
          resolved.push(updated);
        } else {
          index[fingerprint] = { ...record, metadata: { ...(record.metadata ?? {}), missedCycles } };
        }
      }
      return index;
    });
    return resolved;
  }

  private async applyLifecycleAction(
    fingerprint: string,
    lifecycle: 'resolved' | 'archived',
    action: IncidentResolutionAction,
    reason?: string,
  ): Promise<IncidentRecord | null> {
    const indexPath = join(this.incidentsDir, 'index.json');
    if (!existsSync(indexPath)) return null;
    const at = this.now().toISOString();
    let updated: IncidentRecord | null = null;
    await this.mutateIndex(indexPath, (index) => {
      const existing = index[fingerprint];
      if (!existing) return index;
      updated = {
        ...existing,
        lifecycle,
        metadata: {
          ...(existing.metadata ?? {}),
          resolution: { action, at, ...(reason ? { reason } : {}) },
        },
      };
      index[fingerprint] = updated;
      return index;
    });
    return updated;
  }

  private backfillFirstObservedAt(existing: IncidentRecord, fallback: string): string {
    if (typeof existing.firstObservedAt === 'string' && existing.firstObservedAt) return existing.firstObservedAt;
    const earliestEvidence = existing.evidence
      .map((item) => item.timestamp)
      .filter((timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
      .sort()[0];
    return earlierIso(existing.createdAt, earliestEvidence) || fallback;
  }

  async getIncidents(): Promise<IncidentRecord[]> {
    const indexPath = join(this.incidentsDir, 'index.json');
    const index = this.readIndex(indexPath);
    return Object.values(index)
      .filter((incident) => incident.lifecycle === 'observed' || incident.lifecycle === 'active')
      .sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
  }

  /** All records regardless of lifecycle, newest last-observed first. */
  async getAllIncidents(): Promise<IncidentRecord[]> {
    const index = this.readIndex(join(this.incidentsDir, 'index.json'));
    return Object.values(index)
      .sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
  }

  /**
   * Linked records whose current lifecycle transition (resolution, archival, or
   * recurrence) has not yet been fully synchronized to Linear. Unlike
   * getIncidents() this deliberately includes resolved/archived records, since
   * those are exactly the lifecycle events evidence sync never sees.
   */
  async getLifecyclePendingIncidents(): Promise<IncidentRecord[]> {
    const index = this.readIndex(join(this.incidentsDir, 'index.json'));
    return Object.values(index)
      .filter((incident) => hasPendingLifecycleTransition(incident))
      .sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
  }

  async getEvidenceForIncident(fingerprint: string): Promise<IncidentEvidenceLogEntry[]> {
    const logPath = join(this.incidentsDir, `${fingerprint}.evidence.jsonl`);
    if (!existsSync(logPath)) return [];
    const entries: IncidentEvidenceLogEntry[] = [];
    for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as IncidentEvidenceLogEntry);
      } catch {
        // Evidence logs are append-only; skip malformed legacy/torn lines instead of crashing observer.
      }
    }
    return entries;
  }

  computeEvidenceRevision(incident: Pick<IncidentRecord, 'fingerprint' | 'occurrenceCount' | 'evidence'>): string {
    const normalized = incident.evidence.map((evidence) => ({
      type: evidence.type,
      source: evidence.source,
      timestamp: evidence.timestamp,
      lineNumber: evidence.lineNumber ?? null,
      key: evidence.key ?? null,
      redactedData: evidence.redactedData,
    })).sort((a, b) =>
      `${a.type}:${a.source}:${a.key ?? ''}:${a.timestamp}`.localeCompare(`${b.type}:${b.source}:${b.key ?? ''}:${b.timestamp}`),
    );
    return createHash('sha256').update(JSON.stringify({
      fingerprint: incident.fingerprint,
      occurrenceCount: incident.occurrenceCount,
      evidence: normalized,
    })).digest('hex');
  }

  async getIncident(fingerprint: string): Promise<IncidentRecord | null> {
    const index = this.readIndex(join(this.incidentsDir, 'index.json'));
    return index[fingerprint] ?? null;
  }

  async recordLinearSync(fingerprint: string, input: LinearSyncMetadataInput): Promise<IncidentRecord | null> {
    const indexPath = join(this.incidentsDir, 'index.json');
    let updated: IncidentRecord | null = null;
    await this.mutateIndex(indexPath, (index) => {
      const existing = index[fingerprint];
      if (!existing) return index;
      updated = {
        ...existing,
        metadata: {
          ...(existing.metadata ?? {}),
          linkedLinearId: input.linearIssueId,
          linkedLinearUrl: input.linearIssueUrl ?? existing.metadata?.linkedLinearUrl,
          lastSyncedAt: input.syncedAt ?? this.now().toISOString(),
          lastSyncedEvidenceRevision: input.evidenceRevision,
          syncCooldownUntil: input.cooldownUntil,
          updateCount: Number(existing.metadata?.updateCount ?? 0) + 1,
          syncErrors: [],
        },
      };
      index[fingerprint] = updated;
      return index;
    });
    return updated;
  }

  async recordSyncError(fingerprint: string, input: LinearSyncErrorInput): Promise<IncidentRecord | null> {
    const indexPath = join(this.incidentsDir, 'index.json');
    let updated: IncidentRecord | null = null;
    await this.mutateIndex(indexPath, (index) => {
      const existing = index[fingerprint];
      if (!existing) return index;
      const errors = Array.isArray(existing.metadata?.syncErrors) ? existing.metadata.syncErrors : [];
      updated = {
        ...existing,
        metadata: {
          ...(existing.metadata ?? {}),
          syncErrors: [...errors, {
            at: input.at ?? this.now().toISOString(),
            action: input.action,
            category: input.category,
            message: input.message,
            retryQueued: input.retryQueued,
          }].slice(-5),
        },
      };
      index[fingerprint] = updated;
      return index;
    });
    return updated;
  }

  /**
   * Merge a lifecycle-sync delta into the record's `lifecycleSync` metadata.
   * Callers pass only the fields a successful step produced (e.g. commentDelivered
   * after a comment lands, stateApplied after a state mutation), so repeated
   * replays accumulate independently-successful steps without repeating them.
   */
  async recordLifecycleSync(
    fingerprint: string,
    delta: Partial<IncidentLifecycleSyncMetadata> & { transitionRevision: string },
  ): Promise<IncidentRecord | null> {
    const indexPath = join(this.incidentsDir, 'index.json');
    let updated: IncidentRecord | null = null;
    await this.mutateIndex(indexPath, (index) => {
      const existing = index[fingerprint];
      if (!existing) return index;
      const previous = existing.metadata?.lifecycleSync ?? {};
      // A new transition revision starts fresh delivery tracking; the same
      // revision merges (so a later state success does not drop the recorded comment).
      const sameRevision = previous.transitionRevision === delta.transitionRevision;
      const base: IncidentLifecycleSyncMetadata = sameRevision ? previous : {};
      const lifecycleSync: IncidentLifecycleSyncMetadata = {
        ...base,
        ...delta,
        syncedAt: delta.syncedAt ?? this.now().toISOString(),
      };
      updated = {
        ...existing,
        metadata: {
          ...(existing.metadata ?? {}),
          lifecycleSync,
        },
      };
      index[fingerprint] = updated;
      return index;
    });
    return updated;
  }

  async summaryReport(): Promise<string> {
    const incidents = await this.getIncidents();
    if (incidents.length === 0) return 'No active Wavemill incidents.';

    const lines = ['Wavemill Incidents Report', `Total observed/active: ${incidents.length}`];
    for (const incident of incidents.slice(0, 20)) {
      lines.push('');
      lines.push(`[${incident.lifecycle}/${incident.severity}/${incident.category}] ${incident.summary}`);
      lines.push(`  task: ${incident.taskId ?? '(repo)'}`);
      lines.push(`  rootCause: ${incident.rootCauseClass}`);
      lines.push(`  firstObserved: ${incident.firstObservedAt || incident.createdAt || 'unknown'}`);
      lines.push(`  occurrences: ${incident.occurrenceCount} distinct event(s)`);
      lines.push(`  action: ${incident.operatorAction}`);
    }
    if (incidents.length > 20) {
      lines.push('');
      lines.push(`... ${incidents.length - 20} additional incident(s) omitted`);
    }
    return `${lines.join('\n')}\n`;
  }

  private async mutateIndex(indexPath: string, transform: (index: IncidentIndex) => IncidentIndex): Promise<IncidentIndex> {
    try {
      return await mutateJsonState<IncidentIndex>(
        indexPath,
        transform,
        { createIfMissing: true, initial: {} },
      );
    } catch (error) {
      if (!(error instanceof StateParseError)) throw error;
      this.quarantineMalformedIndex(indexPath);
      return mutateJsonState<IncidentIndex>(
        indexPath,
        transform,
        { createIfMissing: true, initial: {} },
      );
    }
  }

  private readIndex(indexPath: string): IncidentIndex {
    if (!existsSync(indexPath)) return {};
    try {
      return JSON.parse(readFileSync(indexPath, 'utf-8')) as IncidentIndex;
    } catch {
      return {};
    }
  }

  private quarantineMalformedIndex(indexPath: string): void {
    if (!existsSync(indexPath)) return;
    mkdirSync(dirname(indexPath), { recursive: true });
    const backupPath = `${indexPath}.malformed.${Date.now()}`;
    renameSync(indexPath, backupPath);
    writeFileSync(indexPath, '{}\n', 'utf-8');
  }

  private appendEvidence(fingerprint: string, evidence: IncidentEvidence[], observedAt: string): void {
    if (evidence.length === 0) return;
    const logPath = join(this.incidentsDir, `${fingerprint}.evidence.jsonl`);
    const lines = evidence.map((item) => JSON.stringify({ observedAt, fingerprint, evidence: item }));
    appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf-8');
  }

  private nextLifecycle(current: IncidentLifecycle, occurrenceCount: number): IncidentLifecycle {
    if (current === 'resolved' || current === 'archived') return current;
    if (occurrenceCount >= this.escalationThreshold) return 'active';
    return current;
  }

  private maxSeverity(a: IncidentRecord['severity'], b: IncidentRecord['severity']): IncidentRecord['severity'] {
    const order: IncidentRecord['severity'][] = ['info', 'low', 'medium', 'high', 'critical'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }

  private maxConfidence(a: IncidentRecord['confidence'], b: IncidentRecord['confidence']): IncidentRecord['confidence'] {
    const order: IncidentRecord['confidence'][] = ['low', 'medium', 'high', 'definite'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }

  private sameCanonicalIncident(
    stored: Pick<IncidentRecord, 'category' | 'rootCauseClass' | 'evidence'>,
    candidate: Pick<IncidentRecord, 'category' | 'rootCauseClass' | 'evidence'>,
    storedTaskId: string | null | undefined,
    candidateTaskId: string | null | undefined,
  ): boolean {
    // Base canonical match: same category, root cause, and evidence identity
    const baseMatch = stored.category === candidate.category
      && canonicalizeRootCauseClass(stored.rootCauseClass) === canonicalizeRootCauseClass(candidate.rootCauseClass)
      && this.evidenceIdentity(stored.evidence) === this.evidenceIdentity(candidate.evidence);

    if (!baseMatch) return false;

    // Attribution match: task-aware consolidation rules
    // 1. Both non-null and different: DO NOT consolidate (prevent task-A → task-B)
    if (storedTaskId && candidateTaskId && storedTaskId !== candidateTaskId) return false;

    // 2. Both null: consolidate (repo-scoped incidents can merge)
    if (!storedTaskId && !candidateTaskId) return true;

    // 3. Same task ID (including both null after above checks): consolidate
    if (storedTaskId === candidateTaskId) return true;

    // 4. One task-scoped, one repo-scoped: allow consolidation only for safe-to-migrate evidence classes
    // Repository-owned evidence (e.g., backstage_health) can migrate to repo scope.
    return this.isSafeToMigrateToRepoScope(stored.evidence, candidate.evidence);
  }

  private evidenceIdentity(evidence: IncidentEvidence[]): string {
    return [...new Set(evidence
      .map((item) => `${item.type}:${item.source}:${item.key ?? ''}`)
      .sort())]
      .join('|');
  }

  private isSafeToMigrateToRepoScope(storedEvidence: IncidentEvidence[], candidateEvidence: IncidentEvidence[]): boolean {
    // Evidence types that are repository-owned and safe to consolidate across tasks into repo scope
    const repoOwnedEvidenceTypes = new Set<string>(['backstage_health']);
    const allEvidence = [...storedEvidence, ...candidateEvidence];
    return allEvidence.every((item) => repoOwnedEvidenceTypes.has(item.type));
  }

  private refreshCanonicalFields(
    stored: IncidentRecord,
    canonical: IncidentRecord,
  ): IncidentRecord {
    // Rebuild a record by preserving store-owned lifecycle/sync metadata while
    // refreshing canonical identity and presentation fields from the current incident.
    return {
      ...stored,
      schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
      fingerprint: this.computeFingerprint(canonical),
      taskId: canonical.taskId ?? null,
      session: canonical.session ?? stored.session ?? null,
      category: canonical.category,
      rootCauseClass: canonical.rootCauseClass,
      severity: this.maxSeverity(stored.severity, canonical.severity),
      confidence: this.maxConfidence(stored.confidence, canonical.confidence),
      summary: canonical.summary,
      operatorAction: canonical.operatorAction,
    };
  }

  private preserveStoreOwnedMetadata(
    storedMetadata: IncidentRecord['metadata'] | undefined,
    currentMetadata: IncidentRecord['metadata'] | undefined,
  ): IncidentRecord['metadata'] {
    // Preserve store-owned metadata fields (Linear sync, lifecycle audit, recurrence tracking)
    // while allowing detector metadata to be refreshed from the current canonical incident.
    const storeOwned = {
      linkedLinearId: storedMetadata?.linkedLinearId,
      linkedLinearUrl: storedMetadata?.linkedLinearUrl,
      lastSyncedAt: storedMetadata?.lastSyncedAt,
      lastSyncedEvidenceRevision: storedMetadata?.lastSyncedEvidenceRevision,
      syncCooldownUntil: storedMetadata?.syncCooldownUntil,
      updateCount: storedMetadata?.updateCount,
      syncErrors: storedMetadata?.syncErrors,
      linearSyncConflict: storedMetadata?.linearSyncConflict,
      seenEventKeys: storedMetadata?.seenEventKeys,
      resolution: storedMetadata?.resolution,
      recurrence: storedMetadata?.recurrence,
      lifecycleSync: storedMetadata?.lifecycleSync,
    };
    // Merge, with stored taking precedence for store-owned fields
    return {
      ...(currentMetadata ?? {}),
      ...Object.fromEntries(
        Object.entries(storeOwned)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, v])
      ),
    };
  }

  private mergeStoredRecords(records: IncidentRecord[]): IncidentRecord | undefined {
    if (records.length === 0) return undefined;
    const [first, ...rest] = records;
    return rest.reduce((merged, record) => ({
      ...merged,
      schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
      severity: this.maxSeverity(merged.severity, record.severity),
      confidence: this.maxConfidence(merged.confidence, record.confidence),
      lifecycle: this.maxLifecycle(merged.lifecycle, record.lifecycle),
      createdAt: earlierIso(merged.createdAt, record.createdAt),
      firstObservedAt: earlierIso(merged.firstObservedAt, record.firstObservedAt),
      lastObservedAt: laterIso(merged.lastObservedAt, record.lastObservedAt),
      occurrenceCount: (merged.occurrenceCount || 0) + (record.occurrenceCount || 0),
      evidence: this.dedupeEvidence([...merged.evidence, ...record.evidence]).slice(-this.maxEvidencePerRecord),
      metadata: this.mergeMetadata(merged.metadata, record.metadata),
    }), first);
  }

  private dedupeEvidence(evidence: IncidentEvidence[]): IncidentEvidence[] {
    const byKey = new Map<string, IncidentEvidence>();
    for (const item of evidence) {
      byKey.set(`${item.type}:${item.source}:${item.key ?? ''}:${item.timestamp}:${item.redactedData}`, item);
    }
    return [...byKey.values()];
  }

  private mergeMetadata(a: IncidentRecord['metadata'], b: IncidentRecord['metadata']): IncidentRecord['metadata'] {
    const linkedIds = [a.linkedLinearId, b.linkedLinearId].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const distinctLinks = [...new Set(linkedIds)];
    const syncErrors = [
      ...(Array.isArray(a.syncErrors) ? a.syncErrors : []),
      ...(Array.isArray(b.syncErrors) ? b.syncErrors : []),
    ].slice(-5);
    const seenEventKeys = [...new Set([
      ...(Array.isArray(a.seenEventKeys) ? a.seenEventKeys : []),
      ...(Array.isArray(b.seenEventKeys) ? b.seenEventKeys : []),
    ])].slice(-MAX_SEEN_EVENT_KEYS);
    return {
      ...a,
      ...b,
      linkedLinearId: distinctLinks[0],
      linkedLinearUrl: a.linkedLinearId ? a.linkedLinearUrl : b.linkedLinearUrl ?? a.linkedLinearUrl,
      lastSyncedAt: laterIso(a.lastSyncedAt, b.lastSyncedAt),
      lastSyncedEvidenceRevision: a.lastSyncedAt && laterIso(a.lastSyncedAt, b.lastSyncedAt) === a.lastSyncedAt
        ? a.lastSyncedEvidenceRevision
        : b.lastSyncedEvidenceRevision ?? a.lastSyncedEvidenceRevision,
      syncCooldownUntil: laterIso(a.syncCooldownUntil, b.syncCooldownUntil),
      updateCount: Number(a.updateCount ?? 0) + Number(b.updateCount ?? 0),
      syncErrors,
      seenEventKeys,
      lastEventAt: laterIso(a.lastEventAt, b.lastEventAt),
      thresholdTriggered: a.thresholdTriggered === true || b.thresholdTriggered === true,
      lifecycleSync: this.mergeLifecycleSync(a.lifecycleSync, b.lifecycleSync),
      ...(distinctLinks.length > 1 ? { linearSyncConflict: { linkedLinearIds: distinctLinks } } : {}),
    };
  }

  private mergeLifecycleSync(
    a: IncidentLifecycleSyncMetadata | undefined,
    b: IncidentLifecycleSyncMetadata | undefined,
  ): IncidentLifecycleSyncMetadata | undefined {
    if (!a) return b;
    if (!b) return a;
    // Prefer the more recently synced snapshot; ownership of a closed issue must
    // survive either way so recurrence can still tell the Observer auto-closed it.
    const newer = laterIso(a.syncedAt, b.syncedAt) === b.syncedAt ? b : a;
    return {
      ...newer,
      observerClosedIssue: a.observerClosedIssue === true || b.observerClosedIssue === true,
      observerSetStateName: newer.observerSetStateName ?? a.observerSetStateName ?? b.observerSetStateName,
    };
  }

  private maxLifecycle(a: IncidentLifecycle, b: IncidentLifecycle): IncidentLifecycle {
    const order: IncidentLifecycle[] = ['observed', 'active', 'resolved', 'archived'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }
}

function earlierIso(a: unknown, b: unknown): string {
  const aString = typeof a === 'string' ? a : '';
  const bString = typeof b === 'string' ? b : '';
  if (!aString) return bString;
  if (!bString) return aString;
  return Date.parse(aString) <= Date.parse(bString) ? aString : bString;
}

function laterIso(a: unknown, b: unknown): string | undefined {
  const aString = typeof a === 'string' ? a : '';
  const bString = typeof b === 'string' ? b : '';
  if (!aString) return bString || undefined;
  if (!bString) return aString || undefined;
  return Date.parse(aString) >= Date.parse(bString) ? aString : bString;
}
