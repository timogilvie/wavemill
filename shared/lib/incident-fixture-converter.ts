/**
 * HOK-3231 — convert recorded incident evidence into replay fixtures.
 *
 * Reads `.wavemill/incidents/index.json` + `*.evidence.jsonl` and produces
 * sanitised, deterministic fixtures (`tests/fixtures/incident-replay/real/`)
 * that drive the real IncidentStore cycle (`incident-reconcile-cycle.ts`) and,
 * for stage-failure chains, `runWithRecoveryLoop`. Expectations are an oracle
 * derived from the observation timeline, never from running the code.
 *
 * See `features/c3-replay-real-incident-evidence-as-test-fixtures/plan.md` §3.
 *
 * @module incident-fixture-converter
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { DEFAULT_RETRY_ATTEMPTS, type FailureStage } from './failure-policy.ts';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  redactPaths,
  redactSecrets,
} from './fixture-capturer.ts';
import {
  canonicalizeRootCauseClass,
  type IncidentCategory,
  type IncidentConfidence,
  type IncidentEvidence,
  type IncidentLifecycle,
  type IncidentRecord,
  type IncidentRootCauseClass,
  type IncidentSeverity,
} from './wavemill-incident-model.ts';
import { parseTaskId, ISSUE_ID_RE, TASK_ID_RE, TASK_ID_EMBEDDED_GLOBAL_RE } from './task-identity.ts';

export const INCIDENT_FIXTURE_SCHEMA_VERSION = 'incident-fixture/1';

/** Observer cadence falls back to 120s when the stream is too short to measure. */
const DEFAULT_OBSERVER_INTERVAL_SECONDS = 120;
/** Resolution-after-cycles contract from `IncidentStore`. */
const RESOLUTION_AFTER_CYCLES = 5;
/** Escalation threshold contract from `IncidentStore`. */
const ESCALATION_THRESHOLD = 3;
/** Default cap on retained observation cycles per fixture. */
const DEFAULT_MAX_OBSERVATIONS = 40;

const STORE_OWNED_METADATA_KEYS = new Set([
  'seenEventKeys',
  'missedCycles',
  'resolution',
  'recurrence',
  'escalatedAt',
  'lastEventAt',
  'thresholdTriggered',
  'lifecycleSync',
  'linearIssueId',
  'linearIssueUrl',
  'lastSyncedAt',
  'lastSyncedEvidenceRevision',
  'syncCooldownUntil',
  'syncErrors',
  'updateCount',
  'authoritativeFailureAt',
]);

export interface IncidentFixtureEvidence {
  type: string;
  source: string;
  timestamp: string;
  redactedData: string;
  key?: string;
}

export interface IncidentFixtureObservation {
  absentCyclesBefore: number;
  evidence: IncidentFixtureEvidence[];
}

export interface IncidentFixtureFailure {
  stage: FailureStage;
  failureKind: string | null;
  detail: string;
  survivesRelaunches: number | 'never';
  progressing?: boolean;
}

export interface IncidentFixtureExpected {
  rootCauseClass: IncidentRootCauseClass;
  category: IncidentCategory;
  occurrenceCount: number;
  lifecycleWhilePresent: IncidentLifecycle;
  finalLifecycle: IncidentLifecycle;
  resolutionReasonPrefix: string | null;
  recurrences: number;
}

export interface IncidentFixtureJob {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  reason?: string;
  side?: string;
  pair?: string;
  resultPath?: string;
}

export interface IncidentFixtureTask {
  issue: string;
  slug: string;
  phase: 'planning' | 'coding' | 'review' | 'ready';
  status: 'working' | 'idle' | 'waiting' | 'blocked';
}

export interface IncidentFixtureInitialState {
  task: IncidentFixtureTask;
  jobs: IncidentFixtureJob[];
  worktreeFiles?: Record<string, string>;
}

export interface IncidentFixtureSource {
  category: IncidentCategory;
  rootCauseClass: IncidentRootCauseClass;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  recordedLifecycle: IncidentLifecycle;
  recordedResolution: string | null;
  occurrenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  stateSnapshot: string | null;
  convertedBy: string;
  observationsTruncated: boolean;
}

export interface IncidentFixtureIncident {
  category: IncidentCategory;
  rootCauseClass: IncidentRootCauseClass;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  summary: string;
  operatorAction: string;
  metadata: Record<string, unknown>;
}

export interface IncidentFixtureConvergence {
  mustMerge?: boolean;
  mustEscalate?: boolean;
  maxTickCount: number;
  tickIntervalSeconds: number;
}

export interface IncidentFixture {
  schemaVersion: typeof INCIDENT_FIXTURE_SCHEMA_VERSION;
  chain: string;
  incidents: string[];
  source: IncidentFixtureSource;
  initialState: IncidentFixtureInitialState;
  incident: IncidentFixtureIncident;
  observations: IncidentFixtureObservation[];
  trailingAbsentCycles: number;
  failure?: IncidentFixtureFailure;
  convergence: IncidentFixtureConvergence;
  journey: string | null;
  journeyNullReason?: string;
  expected: IncidentFixtureExpected;
}

export interface IncidentIndex {
  [fingerprint: string]: IncidentRecord;
}

export interface ReadIncidentIndexResult {
  index: IncidentIndex;
  warnings: string[];
}

export interface EvidenceLogEntry {
  observedAt: string;
  fingerprint: string;
  evidence: IncidentEvidence;
}

export interface ReadEvidenceLogResult {
  entries: EvidenceLogEntry[];
  warnings: string[];
  error?: { code: 'ENOENT' | 'EACCES' | 'EUNKNOWN'; message: string };
}

export interface IncidentCluster {
  class: IncidentRootCauseClass;
  count: number;
  categories: IncidentCategory[];
  representative: {
    fingerprint: string;
    record: IncidentRecord;
    evidencePath: string;
  };
}

/** Journey hints by class (D4, declarative). `null` → no end-to-end journey. */
const JOURNEY_BY_CLASS: Partial<Record<IncidentRootCauseClass, string>> = {
  arm_parked_awaiting_operator_commit: 'dirty-tree-coding-complete',
  failed_background_job: 'incident-currentness',
  terminal_arm_parked_with_residue: 'terminal-delivered-reap',
  stage_marker_not_advanced: 'agent-killed-mid-stage',
  inspection_required: 'ready-failure-disposition',
  active_unpublished_work_stalled: 'agent-killed-mid-stage',
};

const JOURNEY_NULL_REASON = 'detector-level class; replayed via the incident cycle loop';

/** Classes whose failure block is well-defined from evidence. */
const STAGE_FAILURE_CLASSES: Partial<Record<IncidentRootCauseClass, {
  stage: IncidentFixtureFailure['stage'] | 'metadata-stage';
  failureKind?: string;
  detailFrom: 'metadata-uncommitted' | 'review-failure-category' | 'log-excerpt' | 'job-reason' | 'none';
}>> = {
  arm_died_with_unpushed_work: { stage: 'coding', detailFrom: 'none' },
  stage_marker_not_advanced: { stage: 'metadata-stage', detailFrom: 'none' },
  failed_background_job: { stage: 'eval', detailFrom: 'job-reason' },
  active_unpublished_work_stalled: { stage: 'coding', detailFrom: 'none' },
  inspection_required: { stage: 'review', detailFrom: 'review-failure-category' },
  pr_create_failed: { stage: 'review', detailFrom: 'log-excerpt' },
  arm_parked_awaiting_operator_commit: { stage: 'coding', detailFrom: 'metadata-uncommitted' },
};

/**
 * Tolerant read of `.wavemill/incidents/index.json`. Missing or malformed
 * files are reported as warnings; the caller still gets a usable result.
 */
export function readIncidentIndex(dir: string): ReadIncidentIndexResult {
  const indexPath = join(dir, 'index.json');
  const warnings: string[] = [];
  if (!existsSync(indexPath)) {
    warnings.push(`index.json not found at ${indexPath}`);
    return { index: {}, warnings };
  }
  let text: string;
  try {
    text = readFileSync(indexPath, 'utf-8');
  } catch (error) {
    warnings.push(`index.json unreadable at ${indexPath}: ${errMessage(error)}`);
    return { index: {}, warnings };
  }
  if (!text.trim()) return { index: {}, warnings };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`index.json top-level is not an object at ${indexPath}`);
      return { index: {}, warnings };
    }
    return { index: parsed as IncidentIndex, warnings };
  } catch (error) {
    warnings.push(`index.json parse failed at ${indexPath}: ${errMessage(error)}`);
    return { index: {}, warnings };
  }
}

/**
 * Line-by-line parse of a `*.evidence.jsonl` file. Skips malformed lines with
 * a counted warning. ENOENT/EACCES → a typed `error` result; never throws.
 */
export function readEvidenceLog(path: string): ReadEvidenceLogResult {
  const warnings: string[] = [];
  if (!existsSync(path)) {
    return { entries: [], warnings, error: { code: 'ENOENT', message: `evidence log not found: ${path}` } };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    const code = /EACCES/.test(errMessage(error)) ? 'EACCES' : 'EUNKNOWN';
    return { entries: [], warnings, error: { code: code as 'EACCES' | 'EUNKNOWN', message: errMessage(error) } };
  }
  const entries: EvidenceLogEntry[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as EvidenceLogEntry).observedAt === 'string'
        && typeof (parsed as EvidenceLogEntry).fingerprint === 'string'
        && (parsed as EvidenceLogEntry).evidence
      ) {
        entries.push(parsed as EvidenceLogEntry);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) warnings.push(`${skipped} malformed line(s) skipped in ${path}`);
  return { entries, warnings };
}

export interface ClusterOptions {
  top?: number;
  maxObservations?: number;
}

/**
 * Group an index by canonical rootCauseClass. Rank by record count desc, class
 * name asc. The representative is the record whose evidence log has at least
 * 2 cycles and the fewest total lines; ties broken by fingerprint.
 */
export function clusterIncidents(
  index: IncidentIndex,
  evidenceDir: string,
  options: ClusterOptions = {},
): IncidentCluster[] {
  const top = options.top ?? 15;
  const buckets = new Map<IncidentRootCauseClass, IncidentRecord[]>();
  for (const record of Object.values(index)) {
    if (!record || typeof record !== 'object' || !record.rootCauseClass) continue;
    const cls = canonicalizeRootCauseClass(record.rootCauseClass);
    const list = buckets.get(cls) ?? [];
    list.push(record);
    buckets.set(cls, list);
  }
  const clusters: IncidentCluster[] = [];
  for (const [cls, records] of buckets) {
    const sorted = records.slice().sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    const scored = sorted.map((record) => {
      const evidencePath = join(evidenceDir, `${record.fingerprint}.evidence.jsonl`);
      const lineCount = existsSync(evidencePath) ? countLines(evidencePath) : 0;
      return { record, evidencePath, lineCount };
    });
    // Class-specific preference: `failed_background_job` prefers eval-kind
    // records so the `incident-currentness` journey can replay the fixture.
    const classPreferred = cls === 'failed_background_job'
      ? scored.filter((s) => recordHasEvalKindEvidence(s.record))
      : [];
    const withMultipleCycles = (classPreferred.length > 0 ? classPreferred : scored).filter((s) => s.lineCount >= 2);
    const pool = withMultipleCycles.length > 0
      ? withMultipleCycles
      : classPreferred.length > 0 ? classPreferred : scored;
    const chosen = pool.slice().sort((a, b) => {
      if (a.lineCount !== b.lineCount) return a.lineCount - b.lineCount;
      return a.record.fingerprint.localeCompare(b.record.fingerprint);
    })[0];
    if (!chosen || !chosen.lineCount) continue;
    const categories = Array.from(new Set(records.map((r) => r.category))).sort() as IncidentCategory[];
    clusters.push({
      class: cls,
      count: records.length,
      categories,
      representative: {
        fingerprint: chosen.record.fingerprint,
        record: chosen.record,
        evidencePath: chosen.evidencePath,
      },
    });
  }
  clusters.sort((a, b) => (b.count - a.count) || a.class.localeCompare(b.class));
  return clusters.slice(0, top);
}

function recordHasEvalKindEvidence(record: IncidentRecord): boolean {
  return record.evidence.some((ev) => ev.type === 'job_state' && /\bkind=eval\b/.test(ev.redactedData ?? ''));
}

function countLines(path: string): number {
  try {
    const text = readFileSync(path, 'utf-8');
    let count = 0;
    for (const line of text.split('\n')) if (line.trim()) count += 1;
    return count;
  } catch {
    return 0;
  }
}

export interface IncidentToFixtureOptions {
  /** 1-based fixture index for `HOK-FIXTURE-<n>` naming. */
  fixtureIndex?: number;
  /** Optional A5 state snapshot path (recorded as provenance). */
  stateSnapshotPath?: string | null;
  /** `--expect merged|escalated` pins the convergence contract. */
  expect?: 'merged' | 'escalated';
  /** Cap on retained observation cycles (§3.2). */
  maxObservations?: number;
  /** `redactPaths` arguments. */
  homeDir?: string;
  repoDir?: string;
}

/**
 * Build a sanitised fixture from one incident record and its evidence log.
 */
export function incidentToFixture(
  record: IncidentRecord,
  evidenceEntries: EvidenceLogEntry[],
  options: IncidentToFixtureOptions = {},
): IncidentFixture {
  const fixtureIndex = Math.max(1, options.fixtureIndex ?? 1);
  const maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const homeDir = options.homeDir ?? '';
  const repoDir = options.repoDir ?? '';

  // Build a Linear-id → fixture-primary-id map by walking record + evidence.
  // The id scheme `HOK-FIXTURE-N` is a human-readable sentinel; the mapping
  // handles `_c` by appending the challenger suffix at write time.
  const finalMap = buildFixtureIdMap({ record, evidence: evidenceEntries }, fixtureIndex);

  const canonicalClass = canonicalizeRootCauseClass(record.rootCauseClass);
  const sourceTask = parseTaskId(record.taskId ?? '');
  const fixtureTaskId = sourceTask
    ? rewriteOneId(sourceTask.linearId + (sourceTask.role === 'challenger' ? '_c' : ''), finalMap)
    : `HOK-FIXTURE-${fixtureIndex}`;
  const slug = classToSlug(canonicalClass, fixtureIndex);

  const observationsRaw = compressObservations(evidenceEntries, maxObservations);
  const observations = observationsRaw.observations.map((obs) => ({
    absentCyclesBefore: obs.absentCyclesBefore,
    evidence: obs.evidence.map((ev) => sanitiseEvidence(ev, finalMap, homeDir, repoDir)),
  }));

  const trailingAbsentCycles = Math.min(RESOLUTION_AFTER_CYCLES + 1, Math.max(0, observationsRaw.trailingAbsentCycles));

  const metadata = sanitiseMetadata(record.metadata ?? {}, finalMap, homeDir, repoDir);
  const incident: IncidentFixtureIncident = {
    category: record.category,
    rootCauseClass: canonicalClass,
    severity: record.severity,
    confidence: record.confidence,
    summary: sanitiseString(record.summary ?? '', finalMap, homeDir, repoDir),
    operatorAction: sanitiseString(record.operatorAction ?? '', finalMap, homeDir, repoDir),
    metadata,
  };

  const jobs = deriveJobsFromEvidence(evidenceEntries, finalMap, homeDir, repoDir);
  const initialState: IncidentFixtureInitialState = {
    task: {
      issue: fixtureTaskId,
      slug,
      phase: phaseForClass(canonicalClass),
      status: 'working',
    },
    jobs,
  };

  const failure = deriveFailureEvidence(canonicalClass, record, evidenceEntries, finalMap, homeDir, repoDir);
  const expected = deriveExpectations(canonicalClass, record, observations, trailingAbsentCycles, jobs);
  const convergence = deriveConvergence(options.expect
    ?? (failure && failure.survivesRelaunches !== 'never' && failure.survivesRelaunches < DEFAULT_RETRY_ATTEMPTS
      ? 'merged'
      : defaultExpect(canonicalClass)));
  const journey = JOURNEY_BY_CLASS[canonicalClass] ?? null;

  const fixture: IncidentFixture = {
    schemaVersion: INCIDENT_FIXTURE_SCHEMA_VERSION,
    chain: canonicalClass,
    incidents: [record.fingerprint],
    source: {
      category: record.category,
      rootCauseClass: canonicalClass,
      severity: record.severity,
      confidence: record.confidence,
      recordedLifecycle: record.lifecycle,
      recordedResolution: typeof record.metadata?.resolution?.action === 'string' ? record.metadata.resolution.action : null,
      occurrenceCount: record.occurrenceCount ?? 0,
      firstObservedAt: record.firstObservedAt ?? record.createdAt ?? '',
      lastObservedAt: record.lastObservedAt ?? '',
      stateSnapshot: options.stateSnapshotPath ?? null,
      convertedBy: 'tools/incident-to-fixture.ts',
      observationsTruncated: observationsRaw.truncated,
    },
    initialState,
    incident,
    observations,
    trailingAbsentCycles,
    convergence,
    journey,
    ...(journey ? {} : { journeyNullReason: JOURNEY_NULL_REASON }),
    expected,
  };
  if (failure) fixture.failure = failure;
  assertNoLeaks(fixture);
  return fixture;
}

function classToSlug(cls: IncidentRootCauseClass, index: number): string {
  const prefix = cls.replace(/_/g, '-');
  return `incident-${prefix}-${index}`;
}

function phaseForClass(cls: IncidentRootCauseClass): IncidentFixtureTask['phase'] {
  const entry = STAGE_FAILURE_CLASSES[cls];
  if (!entry) return 'coding';
  return entry.stage === 'planning' || entry.stage === 'review' || entry.stage === 'ready' ? entry.stage : 'coding';
}

function defaultExpect(cls: IncidentRootCauseClass): 'merged' | 'escalated' {
  // Stage-failure chains normally escalate (no silent park). Everything else
  // we drive through the incident cycle only; still require convergence via
  // the harness's merged-happy-path default so the retry loop halts cleanly.
  return STAGE_FAILURE_CLASSES[cls] ? 'escalated' : 'merged';
}

function deriveConvergence(expect: 'merged' | 'escalated'): IncidentFixtureConvergence {
  return expect === 'merged'
    ? { mustMerge: true, maxTickCount: 15, tickIntervalSeconds: 30 }
    : { mustEscalate: true, maxTickCount: 15, tickIntervalSeconds: 30 };
}

interface CompressionResult {
  observations: Array<{ absentCyclesBefore: number; evidence: IncidentEvidence[] }>;
  trailingAbsentCycles: number;
  truncated: boolean;
}

/**
 * Group evidence lines into Observer cycles by `observedAt`. Compress runs of
 * identical cycles. §3.2.
 */
export function compressObservations(
  entries: EvidenceLogEntry[],
  maxObservations = DEFAULT_MAX_OBSERVATIONS,
): CompressionResult {
  if (entries.length === 0) {
    return { observations: [], trailingAbsentCycles: 0, truncated: false };
  }
  const sorted = entries.slice().sort((a, b) => {
    if (a.observedAt !== b.observedAt) return a.observedAt.localeCompare(b.observedAt);
    const ak = evidenceKey(a.evidence);
    const bk = evidenceKey(b.evidence);
    return ak.localeCompare(bk);
  });
  const byTime = new Map<string, IncidentEvidence[]>();
  const orderedTimes: string[] = [];
  for (const entry of sorted) {
    const existing = byTime.get(entry.observedAt);
    if (existing) {
      existing.push(entry.evidence);
    } else {
      byTime.set(entry.observedAt, [entry.evidence]);
      orderedTimes.push(entry.observedAt);
    }
  }
  const intervalMs = medianIntervalMs(orderedTimes);

  const rawObs: Array<{ time: string; absentCyclesBefore: number; evidence: IncidentEvidence[] }> = [];
  let prevTime: number | null = null;
  for (const time of orderedTimes) {
    const t = Date.parse(time);
    let absent = 0;
    if (prevTime !== null && Number.isFinite(t) && Number.isFinite(prevTime)) {
      const gap = Math.max(0, (t - prevTime) / intervalMs);
      absent = Math.max(0, Math.round(gap) - 1);
      absent = Math.min(absent, RESOLUTION_AFTER_CYCLES + 1);
    }
    rawObs.push({ time, absentCyclesBefore: absent, evidence: byTime.get(time) ?? [] });
    prevTime = Number.isFinite(t) ? t : prevTime;
  }

  // Compress identical middle cycles beyond the cap.
  const retained: typeof rawObs = [];
  // `timestamp` identifies when an evidence item was sampled, not a change in
  // the observed state.  Keeping it here would turn every poll into a new
  // cycle and defeat the bounded replay timeline.
  const identityOf = (obs: typeof rawObs[number]): string =>
    obs.evidence.map((ev) => [ev.type ?? '', ev.source ?? '', ev.key ?? '', ev.redactedData ?? ''].join('::')).sort().join('|');
  const identities = rawObs.map(identityOf);
  const keepIdx = new Set<number>();
  if (rawObs.length > 0) keepIdx.add(0);
  if (rawObs.length > 1) keepIdx.add(rawObs.length - 1);
  for (let i = 1; i < rawObs.length - 1; i += 1) {
    if (identities[i] !== identities[i - 1]) keepIdx.add(i);
    if (rawObs[i].absentCyclesBefore >= RESOLUTION_AFTER_CYCLES) keepIdx.add(i);
  }
  let truncated = false;
  if (keepIdx.size > maxObservations) {
    truncated = true;
    const indices = Array.from(keepIdx).sort((a, b) => a - b);
    const kept = new Set<number>();
    kept.add(indices[0]);
    kept.add(indices[indices.length - 1]);
    const stride = Math.max(1, Math.floor(indices.length / (maxObservations - 2)));
    for (let i = stride; i < indices.length - 1 && kept.size < maxObservations; i += stride) {
      kept.add(indices[i]);
    }
    for (const idx of Array.from(keepIdx)) if (!kept.has(idx)) keepIdx.delete(idx);
  }
  for (const idx of Array.from(keepIdx).sort((a, b) => a - b)) retained.push(rawObs[idx]);

  const trailingAbsentCycles = Math.max(0, RESOLUTION_AFTER_CYCLES + 1);
  return {
    observations: retained.map((obs) => ({ absentCyclesBefore: obs.absentCyclesBefore, evidence: obs.evidence })),
    trailingAbsentCycles,
    truncated,
  };
}

function evidenceKey(ev: IncidentEvidence): string {
  return [ev.type ?? '', ev.source ?? '', ev.key ?? '', ev.timestamp ?? ''].join('::');
}

/**
 * The Observer cadence is the smallest gap in the stream (jittering around a
 * fixed tick); larger gaps are the incident being absent, not the Observer
 * slowing down. Taking the median would be biased by long absences and under-
 * count short gaps. Floor at the plan default so a one-point stream still
 * yields plausible absentCyclesBefore values.
 */
function medianIntervalMs(times: string[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const a = Date.parse(times[i - 1]);
    const b = Date.parse(times[i]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) gaps.push(b - a);
  }
  if (gaps.length === 0) return DEFAULT_OBSERVER_INTERVAL_SECONDS * 1000;
  gaps.sort((a, b) => a - b);
  const smallest = gaps[0];
  return Math.max(60_000, smallest);
}

function sanitiseEvidence(
  ev: IncidentEvidence,
  idMap: Map<string, string>,
  homeDir: string,
  repoDir: string,
): IncidentFixtureEvidence {
  return {
    type: ev.type,
    source: sanitiseString(ev.source ?? '', idMap, homeDir, repoDir),
    timestamp: ev.timestamp,
    redactedData: sanitiseString(ev.redactedData ?? '', idMap, homeDir, repoDir),
    ...(ev.key ? { key: sanitiseString(ev.key, idMap, homeDir, repoDir) } : {}),
  };
}

function sanitiseString(input: string, idMap: Map<string, string>, homeDir: string, repoDir: string): string {
  let out = redactSecrets(input);
  out = redactPaths(out, homeDir, repoDir);
  // Also redact nested worktree paths from any home (e.g. a different operator's
  // Dropbox tree, in case the fixture is converted on a sibling box).
  out = out.replace(/\/Users\/[A-Za-z0-9_.-]+(?:\/[^\s"'`]+)?/g, '~');
  out = rewriteIdsInString(out, idMap);
  // Long feature slugs under features/<slug>/… or worktrees/<slug>/… collapse
  // so prose does not pin a specific operator worktree. The compactor runs
  // after id rewrite so a slug beginning with HOK-FIXTURE still shortens.
  out = out.replace(/features\/[A-Za-z0-9_.-]{20,}/g, 'features/<fixture-slug>');
  out = out.replace(/worktrees\/[A-Za-z0-9_.-]{20,}/g, 'worktrees/<fixture-slug>');
  return out;
}

/**
 * Build a `linearId → fixturePrimaryId` map. Walks every string in the input
 * tree and assigns `HOK-FIXTURE-<n>` to each distinct Linear issue id in
 * first-seen order. Supports `_c` at rewrite time without ever calling
 * `challengerTaskId` on the fixture id (`HOK-FIXTURE-N` is not Linear-shaped).
 */
export function buildFixtureIdMap(
  envelope: unknown,
  fixtureIndex: number,
): Map<string, string> {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(TASK_ID_EMBEDDED_GLOBAL_RE)) {
        const parsed = parseTaskId(match[0]);
        if (!parsed) continue;
        if (!seen.has(parsed.linearId)) {
          seen.add(parsed.linearId);
          order.push(parsed.linearId);
        }
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k);
      visit(v);
    }
  };
  visit(envelope);
  const map = new Map<string, string>();
  order.forEach((linearId, i) => {
    map.set(linearId, `HOK-FIXTURE-${fixtureIndex + i}`);
  });
  return map;
}

/** Rewrite one task-id token through the map (preserving `_c`). */
function rewriteOneId(token: string, map: Map<string, string>): string {
  const parsed = parseTaskId(token);
  if (!parsed) return token;
  const primary = map.get(parsed.linearId);
  if (!primary) return token;
  return parsed.role === 'challenger' ? `${primary}_c` : primary;
}

/** Rewrite every task-id substring in a string using the fixture id map. */
export function rewriteIdsInString(input: string, map: Map<string, string>): string {
  return input.replace(TASK_ID_EMBEDDED_GLOBAL_RE, (match) => rewriteOneId(match, map));
}

function sanitiseMetadata(
  metadata: Record<string, unknown>,
  idMap: Map<string, string>,
  homeDir: string,
  repoDir: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (STORE_OWNED_METADATA_KEYS.has(key)) continue;
    out[key] = sanitiseValue(value, idMap, homeDir, repoDir);
  }
  return out;
}

function sanitiseValue(value: unknown, idMap: Map<string, string>, homeDir: string, repoDir: string): unknown {
  if (typeof value === 'string') return sanitiseString(value, idMap, homeDir, repoDir);
  if (Array.isArray(value)) return value.map((v) => sanitiseValue(v, idMap, homeDir, repoDir));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitiseValue(v, idMap, homeDir, repoDir);
    }
    return out;
  }
  return value;
}

/** Pull job-backed state out of `job_state` evidence lines so replay has a seed. */
function deriveJobsFromEvidence(
  entries: EvidenceLogEntry[],
  idMap: Map<string, string>,
  homeDir: string,
  repoDir: string,
): IncidentFixtureJob[] {
  const seen = new Map<string, IncidentFixtureJob>();
  for (const entry of entries) {
    const ev = entry.evidence;
    if (ev.type !== 'job_state') continue;
    const parsed = parseJobStateRedactedData(ev.redactedData ?? '');
    if (!parsed || !parsed.id) continue;
    const id = sanitiseString(parsed.id, idMap, homeDir, repoDir);
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      kind: parsed.kind ?? 'eval',
      status: statusOf(parsed.status),
      ...(parsed.reason ? { reason: sanitiseString(parsed.reason, idMap, homeDir, repoDir) } : {}),
    });
  }
  return [...seen.values()];
}

function statusOf(raw: string | undefined): IncidentFixtureJob['status'] {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'succeeded' || v === 'running' || v === 'queued' || v === 'failed') return v;
  return 'failed';
}

function parseJobStateRedactedData(data: string): { id?: string; kind?: string; status?: string; reason?: string } | null {
  if (!data) return null;
  const out: Record<string, string> = {};
  for (const token of data.split(/\s+/)) {
    const m = /^([a-zA-Z_]+)=(.*)$/.exec(token);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Build the stage-failure block for classes in {@link STAGE_FAILURE_CLASSES}.
 * This describes *where in the evidence the facts live*; it is not a policy.
 */
export function deriveFailureEvidence(
  cls: IncidentRootCauseClass,
  record: IncidentRecord,
  entries: EvidenceLogEntry[],
  idMap: Map<string, string>,
  homeDir: string,
  repoDir: string,
): IncidentFixtureFailure | undefined {
  const entry = STAGE_FAILURE_CLASSES[cls];
  if (!entry) return undefined;
  let detail = '';
  switch (entry.detailFrom) {
    case 'metadata-uncommitted':
      detail = typeof record.metadata?.uncommittedReason === 'string' ? record.metadata.uncommittedReason : '';
      break;
    case 'review-failure-category':
      detail = typeof record.metadata?.failureCategory === 'string' ? record.metadata.failureCategory : '';
      break;
    case 'log-excerpt': {
      const log = entries.find((e) => e.evidence.type === 'log_excerpt');
      detail = log?.evidence.redactedData ?? '';
      break;
    }
    case 'job-reason': {
      const job = entries.find((e) => e.evidence.type === 'job_state');
      const parsed = job ? parseJobStateRedactedData(job.evidence.redactedData ?? '') : null;
      detail = parsed?.reason ?? '';
      break;
    }
    case 'none':
    default:
      detail = '';
  }
  detail = sanitiseString(detail, idMap, homeDir, repoDir);
  const metadataStage = typeof record.metadata?.stage === 'string' ? record.metadata.stage : null;
  const stage = entry.stage === 'metadata-stage'
    ? metadataStage === 'planning' || metadataStage === 'coding' || metadataStage === 'review' || metadataStage === 'ready' || metadataStage === 'tend' || metadataStage === 'eval'
      ? metadataStage
      : 'coding'
    : entry.stage;
  // Each distinct observed failure is one attempt in the recorded chain. The
  // first event is the initial failure, so subsequent events are relaunches
  // that also failed. A single event therefore recovers on its first relaunch.
  const failureEvents = new Set(entries.map((item) => item.observedAt || item.evidence.timestamp).filter(Boolean));
  // An incident still open at capture time has no recorded recovery. Preserve
  // that terminal fact instead of inferring success from its first event.
  const survivesRelaunches: number | 'never' = record.lifecycle === 'resolved'
    ? Math.max(0, failureEvents.size - 1)
    : 'never';
  const failure: IncidentFixtureFailure = {
    stage,
    failureKind: entry.failureKind ?? null,
    detail,
    survivesRelaunches,
  };
  return failure;
}

/**
 * Expectation oracle (§3.3). Derived from the retained observation timeline
 * and the record's own facts — not from running the replay.
 */
export function deriveExpectations(
  cls: IncidentRootCauseClass,
  record: IncidentRecord,
  observations: IncidentFixtureObservation[],
  trailingAbsentCycles: number,
  jobs: IncidentFixtureJob[],
): IncidentFixtureExpected {
  const occurrenceCount = Math.max(1, observations.length);
  const escalated = occurrenceCount >= ESCALATION_THRESHOLD
    || typeof record.metadata?.escalatedAt === 'string';
  const lifecycleWhilePresent: IncidentLifecycle = escalated ? 'active' : 'observed';

  const jobBacked = cls === 'failed_background_job' || cls === 'failed_job_no_result'
    || typeof record.metadata?.jobId === 'string';
  let finalLifecycle: IncidentLifecycle = lifecycleWhilePresent;
  let resolutionReasonPrefix: string | null = null;
  if (jobBacked) {
    const succeeded = jobs.some((j) => j.status === 'succeeded');
    if (succeeded) {
      finalLifecycle = 'resolved';
      resolutionReasonPrefix = 'current_disposition:';
    }
  } else if (trailingAbsentCycles >= RESOLUTION_AFTER_CYCLES) {
    finalLifecycle = 'resolved';
    resolutionReasonPrefix = 'not re-observed';
  }

  const recurrences = observations.filter((o) => o.absentCyclesBefore >= RESOLUTION_AFTER_CYCLES).length;
  return {
    rootCauseClass: cls,
    category: record.category,
    occurrenceCount,
    lifecycleWhilePresent,
    finalLifecycle,
    resolutionReasonPrefix,
    recurrences,
  };
}

/** Serialise a fixture with stable key order, 2-space JSON, trailing newline. */
export function serializeFixture(fixture: IncidentFixture): string {
  return `${JSON.stringify(fixture, stableReplacer(), 2)}\n`;
}

function stableReplacer(): (key: string, value: unknown) => unknown {
  const order = [
    'schemaVersion', 'chain', 'incidents', 'source', 'initialState', 'incident',
    'observations', 'trailingAbsentCycles', 'failure', 'convergence',
    'journey', 'journeyNullReason', 'expected',
    'category', 'rootCauseClass', 'severity', 'confidence', 'recordedLifecycle',
    'recordedResolution', 'occurrenceCount', 'firstObservedAt', 'lastObservedAt',
    'stateSnapshot', 'convertedBy', 'observationsTruncated',
    'task', 'jobs', 'worktreeFiles',
    'issue', 'slug', 'phase', 'status',
    'id', 'kind', 'reason', 'side', 'pair', 'resultPath',
    'summary', 'operatorAction', 'metadata',
    'absentCyclesBefore', 'evidence',
    'type', 'source', 'timestamp', 'redactedData', 'key',
    'stage', 'failureKind', 'detail', 'survivesRelaunches', 'progressing',
    'mustMerge', 'mustEscalate', 'maxTickCount', 'tickIntervalSeconds',
    'lifecycleWhilePresent', 'finalLifecycle', 'resolutionReasonPrefix', 'recurrences',
  ];
  const ranks = new Map(order.map((k, i) => [k, i]));
  // JSON.stringify's replacer runs on every key. For object serialisation we
  // need to reorder keys; the simplest deterministic way is to produce a new
  // ordered object recursively, then stringify with no replacer.
  return function replace(this: unknown, _key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sortedEntries = Object.entries(obj).sort(([a], [b]) => {
        const ra = ranks.has(a) ? (ranks.get(a) as number) : 1_000 + a.charCodeAt(0);
        const rb = ranks.has(b) ? (ranks.get(b) as number) : 1_000 + b.charCodeAt(0);
        return ra - rb || a.localeCompare(b);
      });
      const next: Record<string, unknown> = {};
      for (const [k, v] of sortedEntries) next[k] = v;
      return next;
    }
    return value;
  };
}

function assertNoLeaks(fixture: IncidentFixture): void {
  const serialised = JSON.stringify(fixture);
  if (/\/Users\//.test(serialised)) throw new Error('fixture contains /Users/ path after sanitisation');
  if (/\$HOME/.test(serialised)) throw new Error('fixture contains $HOME after sanitisation');
  // Match a Linear-shaped id that is NOT a substring of HOK-FIXTURE-N
  // (so the leading / trailing boundary rejects an inner dash as well).
  const scan = /(?<![A-Za-z0-9-])[A-Z][A-Z0-9]*-\d+(?:_c)?(?![A-Za-z0-9-])/g;
  for (const match of serialised.matchAll(scan)) {
    const token = match[0];
    if (!ISSUE_ID_RE.test(token.replace(/_c$/, '')) && !TASK_ID_RE.test(token)) continue;
    const parsed = parseTaskId(token);
    if (!parsed) continue;
    if (!/^HOK-FIXTURE-\d+$/.test(parsed.linearId)) {
      throw new Error(`fixture contains unmapped Linear id ${token} after sanitisation`);
    }
  }
}

/** Shared loader used by the harness, tests and journey step. */
export function loadIncidentFixture(path: string): IncidentFixture {
  const text = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(text) as unknown;
  const errors = validateIncidentFixture(parsed);
  if (errors.length > 0) {
    throw new Error(`fixture ${path} invalid: ${errors.join('; ')}`);
  }
  return parsed as IncidentFixture;
}

/** Strict shape validator. Returns a list of error strings (empty = valid). */
export function validateIncidentFixture(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['fixture must be an object'];
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== INCIDENT_FIXTURE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${INCIDENT_FIXTURE_SCHEMA_VERSION}`);
  if (typeof obj.chain !== 'string') errors.push('chain must be a string');
  if (!Array.isArray(obj.incidents)) errors.push('incidents must be an array');
  if (!obj.initialState || typeof obj.initialState !== 'object') errors.push('initialState missing');
  else {
    const init = obj.initialState as Record<string, unknown>;
    const task = init.task as Record<string, unknown> | undefined;
    if (!task || typeof task.issue !== 'string') errors.push('initialState.task.issue missing');
    if (!task || typeof task.slug !== 'string') errors.push('initialState.task.slug missing');
    if (!Array.isArray(init.jobs)) errors.push('initialState.jobs must be an array');
  }
  if (!Array.isArray(obj.observations)) errors.push('observations must be an array');
  if (typeof obj.trailingAbsentCycles !== 'number') errors.push('trailingAbsentCycles must be a number');
  const incident = obj.incident as Record<string, unknown> | undefined;
  if (!incident || typeof incident.rootCauseClass !== 'string') errors.push('incident.rootCauseClass missing');
  const convergence = obj.convergence as Record<string, unknown> | undefined;
  if (!convergence || !Number.isFinite(convergence.maxTickCount)) errors.push('convergence.maxTickCount missing');
  if (!convergence || !convergence.mustMerge && !convergence.mustEscalate) errors.push('convergence must require mustMerge or mustEscalate');
  const expected = obj.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected.rootCauseClass !== 'string') errors.push('expected.rootCauseClass missing');
  if (obj.failure !== undefined) {
    const f = obj.failure as Record<string, unknown>;
    const stage = f.stage;
    if (stage !== 'planning' && stage !== 'coding' && stage !== 'review' && stage !== 'ready' && stage !== 'tend' && stage !== 'eval') {
      errors.push('failure.stage must be planning|coding|review|ready|tend|eval');
    }
    const survives = f.survivesRelaunches;
    if (survives !== 'never' && typeof survives !== 'number') {
      errors.push('failure.survivesRelaunches must be a number or "never"');
    }
  }
  return errors;
}

/** Journey name declared for this class, or null with a reason. */
export function journeyFor(cls: IncidentRootCauseClass): { journey: string | null; reason?: string } {
  const journey = JOURNEY_BY_CLASS[cls];
  if (journey) return { journey };
  return { journey: null, reason: JOURNEY_NULL_REASON };
}

/**
 * Resolve the incidents directory to walk. Relative paths are resolved
 * against `cwd`. Returns a tuple of (absolute path, exists).
 */
export function resolveIncidentsDir(input: string | undefined, cwd: string): string {
  if (!input) return join(cwd, '.wavemill', 'incidents');
  return isAbsolute(input) ? input : join(cwd, input);
}

/** Enumerate evidence log files under a directory. */
export function listEvidenceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.evidence.jsonl'))
      .map((name) => join(dir, name))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

/** Convenience: evidence path for a fingerprint, under `dir`. */
export function evidencePathFor(dir: string, fingerprint: string): string {
  return join(dir, `${fingerprint}.evidence.jsonl`);
}

/** Short helper used by callers that pass a path like `<fp>.evidence.jsonl`. */
export function fingerprintFromPath(path: string): string {
  const base = basename(path);
  return base.replace(/\.evidence\.jsonl$/, '');
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Export convenience for the CLI: resolve-and-walk helper. */
export function listClustersFromDir(
  dir: string,
  options: ClusterOptions = {},
): { clusters: IncidentCluster[]; warnings: string[] } {
  const { index, warnings } = readIncidentIndex(dir);
  const clusters = clusterIncidents(index, dir, options);
  return { clusters, warnings };
}

/** Export: fetch one record + its evidence from a fingerprint or path. */
export function loadIncidentByFingerprint(
  dir: string,
  fingerprintOrPath: string,
): { record: IncidentRecord | null; evidence: EvidenceLogEntry[]; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  const fp = fingerprintOrPath.endsWith('.evidence.jsonl')
    ? fingerprintFromPath(fingerprintOrPath)
    : fingerprintOrPath;
  const evidenceDir = fingerprintOrPath.endsWith('.evidence.jsonl') ? dirname(fingerprintOrPath) : dir;
  const { index, warnings: idxWarnings } = readIncidentIndex(evidenceDir);
  warnings.push(...idxWarnings);
  const record = index[fp] ?? null;
  const log = readEvidenceLog(evidencePathFor(evidenceDir, fp));
  warnings.push(...log.warnings);
  if (log.error && !record) {
    return { record: null, evidence: [], warnings, error: log.error.message };
  }
  return { record, evidence: log.entries, warnings };
}
