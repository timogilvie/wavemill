/**
 * HOK-3509 — One fleet incident for failures that share a cause across tasks.
 *
 * Correlates recent per-attempt stage and job failures into **one** fleet
 * incident when the same `(endpoint, faultClass)` cause key hits N distinct
 * tasks inside the detection window. Before this, every per-task site made
 * its own decision and a shared cause (DeepSeek stalls, GitHub rate limit,
 * OpenRouter credit exhaustion) was read as N independent task failures.
 *
 * The module is pure except for {@link readTaskFailureFacts}, which reads
 * the per-stage result artifacts a stage already wrote. The incident path
 * (`reconcileIncidentCycle`) consumes the correlation list and the
 * covered-candidate predicate; no other site classifies failures by cause
 * across tasks (enforced by `tools/check-incident-currentness.ts`).
 *
 * @module fleet-incident-correlation
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmFaultClass } from './arm-failure-taxonomy.ts';
import { classifyArmFault } from './arm-failure-taxonomy.ts';
import { canonicalFailureKind, detectFailureKind } from './failure-policy.ts';
import { classifyGitHubCallFailure } from './github.ts';
import {
  createIncidentDraft,
  type IncidentCategory,
  type IncidentRecord,
  type FleetIncidentMetadata,
} from './wavemill-incident-model.ts';
import type { WorkflowJob } from './incident-filing-reconciler.ts';

export const STAGES = ['planning', 'coding', 'review', 'ready'] as const;
export type FactStage = (typeof STAGES)[number];

/**
 * One per-attempt failure fact. These are the units the correlator groups
 * by cause key; the evidence of a fleet incident is the distinct set.
 */
export interface FailureFact {
  taskId: string;
  stage: FactStage | 'job';
  attemptId: string;
  failedAt: number;
  endpoint: string;
  endpointEvidence: 'direct' | 'launch-intent' | 'dependency';
  failureKind: string;
  faultClass: ArmFaultClass;
  sourcePath?: string;
}

export interface FleetCorrelation {
  causeKey: string;
  endpoint: string;
  endpointEvidence: 'direct' | 'launch-intent' | 'dependency';
  faultClass: ArmFaultClass;
  /** `provider-fault` when the grouped class is already provider-fault; else `harness-fault`. */
  fleetFaultClass: 'harness-fault' | 'provider-fault';
  tasks: string[];
  attempts: FailureFact[];
  firstAt: number;
  lastAt: number;
}

/**
 * Failure kinds whose evidence is direct model-output: never a fleet cause.
 * A weak model failing honestly on three tasks must not be rewritten as a
 * shared harness fault. (Decision 3 in the plan.)
 */
const DIRECT_MODEL_EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  'completion-protocol',
  'planning-artifact-invalid',
  'review-malformed-response',
  'review-not-ready',
  'ready-exhausted',
  'coding-dirty-handoff',
]);

/**
 * True when a fact may join a fleet. Settled-without-result and other
 * ambiguous failure kinds correlate; direct-model-evidence kinds do not
 * (Decision 3 in the plan). Eligibility is a kind-level predicate so an
 * honest model failure (`completion-protocol`, `planning-artifact-invalid`,
 * …) is never rewritten as a shared cause even when several arms share a
 * model; by contrast, `coding-exited-without-result` / `review-no-output`
 * are ambiguous between harness and model and may correlate.
 */
export function isCorrelatableFailure(fact: FailureFact): boolean {
  const kind = canonicalFailureKind(fact.failureKind);
  const base = kind.startsWith('planning-artifact-invalid') ? 'planning-artifact-invalid' : kind;
  return !DIRECT_MODEL_EVIDENCE_KINDS.has(base);
}

/**
 * Cause key = `<endpoint>::<faultClass>`. Stable across callers that read
 * the same evidence so two correlators always hash to the same fingerprint.
 */
export function fleetCauseKey(fact: Pick<FailureFact, 'endpoint' | 'faultClass'>): string {
  return `${fact.endpoint}::${fact.faultClass}`;
}

export interface CorrelateOptions {
  windowMs: number;
  threshold: number;
}

/**
 * Correlate a bag of facts into zero or more {@link FleetCorrelation} entries.
 * A sliding window is anchored on each fact; when two windows overlap the
 * larger one wins. The threshold is on distinct `taskId`s (a `_c` challenger
 * counts as its own task).
 */
export function correlateFleetFailures(
  facts: readonly FailureFact[],
  options: CorrelateOptions,
): FleetCorrelation[] {
  const buckets = new Map<string, FailureFact[]>();
  for (const fact of facts) {
    if (!isCorrelatableFailure(fact)) continue;
    const key = fleetCauseKey(fact);
    const list = buckets.get(key) ?? [];
    list.push(fact);
    buckets.set(key, list);
  }

  const correlations: FleetCorrelation[] = [];
  for (const [causeKey, bucket] of buckets) {
    const sorted = bucket.slice().sort((a, b) => a.failedAt - b.failedAt);
    let best: FleetCorrelation | null = null;
    for (let i = 0; i < sorted.length; i++) {
      const anchor = sorted[i];
      const windowEnd = anchor.failedAt + options.windowMs;
      const slice = sorted.filter((f) => f.failedAt >= anchor.failedAt && f.failedAt <= windowEnd);
      const tasks = [...new Set(slice.map((f) => f.taskId))];
      if (tasks.length < options.threshold) continue;
      const faultClass = anchor.faultClass;
      const fleetFaultClass: 'harness-fault' | 'provider-fault' = faultClass === 'provider-fault' ? 'provider-fault' : 'harness-fault';
      const candidate: FleetCorrelation = {
        causeKey,
        endpoint: anchor.endpoint,
        endpointEvidence: anchor.endpointEvidence,
        faultClass,
        fleetFaultClass,
        tasks,
        attempts: slice,
        firstAt: slice[0].failedAt,
        lastAt: slice[slice.length - 1].failedAt,
      };
      // Prefer the correlation that covers the most attempts (then the earliest start).
      if (!best
        || candidate.attempts.length > best.attempts.length
        || (candidate.attempts.length === best.attempts.length && candidate.firstAt < best.firstAt)) {
        best = candidate;
      }
    }
    if (best) correlations.push(best);
  }
  return correlations;
}

// ── Readers ────────────────────────────────────────────────────────────────

interface RawStageAttempt {
  runId?: string | null;
  stage?: unknown;
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  intendedModel?: unknown;
  executedModel?: unknown;
  model?: unknown;
  notes?: unknown;
  failureReason?: unknown;
  executionEvidence?: { status?: unknown } | null;
}

interface RawStageResult extends RawStageAttempt {
  history?: RawStageAttempt[];
}

function parseJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function inferEndpoint(attempt: RawStageAttempt): { endpoint: string; endpointEvidence: 'direct' | 'launch-intent' } {
  const evidenceStatus = typeof attempt.executionEvidence?.status === 'string' ? attempt.executionEvidence.status : null;
  const executed = typeof attempt.executedModel === 'string' ? attempt.executedModel.trim() : '';
  if (evidenceStatus === 'direct' && executed) {
    return { endpoint: executed, endpointEvidence: 'direct' };
  }
  const intended = typeof attempt.intendedModel === 'string' ? attempt.intendedModel.trim() : '';
  const legacy = typeof attempt.model === 'string' ? attempt.model.trim() : '';
  const endpoint = intended || legacy || 'unknown';
  return { endpoint, endpointEvidence: 'launch-intent' };
}

function factFromAttempt(
  taskId: string,
  stage: FactStage,
  attempt: RawStageAttempt,
  sourcePath: string,
): FailureFact | null {
  const status = typeof attempt.status === 'string' ? attempt.status : '';
  if (status !== 'failed' && status !== 'aborted') return null;
  const finishedAt = isoToMs(attempt.finishedAt);
  const startedAt = isoToMs(attempt.startedAt);
  const failedAt = finishedAt ?? startedAt;
  if (failedAt === null) return null;
  const { endpoint, endpointEvidence } = inferEndpoint(attempt);
  const detail = typeof attempt.failureReason === 'string'
    ? attempt.failureReason
    : (typeof attempt.notes === 'string' ? attempt.notes : '');
  const failureKind = detectFailureKind(detail);
  const faultClass = classifyArmFault({ failureKind, detail });
  const runId = typeof attempt.runId === 'string' && attempt.runId.length > 0 ? attempt.runId : null;
  const attemptId = runId ?? `${stage}@${attempt.startedAt ?? attempt.finishedAt ?? failedAt}`;
  return {
    taskId,
    stage,
    attemptId,
    failedAt,
    endpoint,
    endpointEvidence,
    failureKind,
    faultClass,
    sourcePath,
  };
}

export interface ReadTaskFailureFactsOptions {
  taskId: string;
  featureDir: string;
  now: number;
  windowMs: number;
}

/**
 * Read planning/coding/review/ready results (current + `history[]`) and
 * return per-attempt {@link FailureFact}s whose `failedAt` falls in the
 * window. Malformed/unreadable files are skipped.
 */
export function readTaskFailureFacts(options: ReadTaskFailureFactsOptions): FailureFact[] {
  const windowStart = options.now - options.windowMs;
  const facts: FailureFact[] = [];
  for (const stage of STAGES) {
    const path = join(options.featureDir, `.${stage}-result.json`);
    const result = parseJson<RawStageResult>(path);
    if (!result) continue;
    const attempts: RawStageAttempt[] = [result, ...(Array.isArray(result.history) ? result.history : [])];
    for (const attempt of attempts) {
      const fact = factFromAttempt(options.taskId, stage, attempt, path);
      if (!fact) continue;
      if (fact.failedAt < windowStart || fact.failedAt > options.now) continue;
      facts.push(fact);
    }
  }
  return facts;
}

/**
 * Turn jobs the Observer already read into failure facts. Only GitHub-shaped
 * rate-limit evidence produces a `github-api` fact; everything else is
 * handled through the stage-result reader.
 */
export function jobFailureFacts(jobs: readonly WorkflowJob[], now: number, windowMs: number): FailureFact[] {
  const windowStart = now - windowMs;
  const facts: FailureFact[] = [];
  for (const job of jobs) {
    if (job.status !== 'failed' && job.status !== 'timeout') continue;
    const finishedAt = isoToMs(job.finishedAt);
    const startedAt = isoToMs(job.startedAt);
    const failedAt = finishedAt ?? startedAt;
    if (failedAt === null || failedAt < windowStart || failedAt > now) continue;
    const errorText = job.error ?? '';
    if (classifyGitHubCallFailure(errorText).category !== 'rate_limit') continue;
    const taskId = job.taskId ?? job.issueId;
    if (!taskId) continue;
    facts.push({
      taskId,
      stage: 'job',
      attemptId: job.id,
      failedAt,
      endpoint: 'github-api',
      endpointEvidence: 'dependency',
      failureKind: 'github-rate-limited',
      faultClass: 'provider-fault',
    });
  }
  return facts;
}

// ── Draft builder ──────────────────────────────────────────────────────────

/**
 * Turn a correlation into a draft incident. `taskId: null`, cause key in
 * `metadata.fleet`, known issue ids on `metadata.knownIssueIds` so the
 * inbox renders affected tasks.
 */
export function buildFleetIncident(correlation: FleetCorrelation, options: { session?: string | null; now: Date }): IncidentRecord {
  const category: IncidentCategory = correlation.endpointEvidence === 'dependency'
    ? 'external_transient_dependency'
    : 'model_task_harness_outcome';
  const rootCauseClass = correlation.endpointEvidence === 'dependency'
    ? 'remote_dependency_rate_limited'
    : 'fleet_shared_endpoint_failure';
  const fleet: FleetIncidentMetadata = {
    causeKey: correlation.causeKey,
    endpoint: correlation.endpoint,
    endpointEvidence: correlation.endpointEvidence,
    faultClass: correlation.faultClass,
    fleetFaultClass: correlation.fleetFaultClass,
    attempts: correlation.attempts.map((fact) => ({
      taskId: fact.taskId,
      attemptId: fact.attemptId,
      stage: fact.stage,
      at: new Date(fact.failedAt).toISOString(),
    })),
  };
  const taskCount = correlation.tasks.length;
  const summary = correlation.endpointEvidence === 'dependency'
    ? `${correlation.endpoint}: ${taskCount} tasks blocked by dependency rate limit (${correlation.fleetFaultClass})`
    : `${correlation.endpoint}: ${taskCount} tasks failed together (${correlation.fleetFaultClass})`;
  return createIncidentDraft({
    taskId: null,
    session: options.session ?? null,
    category,
    severity: 'medium',
    confidence: 'high',
    lifecycle: 'observed',
    rootCauseClass,
    summary,
    operatorAction: correlation.endpointEvidence === 'dependency'
      ? 'Wait for the external dependency to recover; the mill is retrying affected arms. Review per-arm attempts under metadata.fleet for the shared cause.'
      : 'Inspect the shared endpoint under metadata.fleet; routing changes remain with Hokusai. The affected arms continue through per-arm bounded retry.',
    evidence: correlation.attempts.map((fact) => ({
      type: 'log_excerpt',
      source: `${fact.taskId}:${fact.attemptId}`,
      timestamp: new Date(fact.failedAt).toISOString(),
      redactedData: `stage=${fact.stage} endpoint=${fact.endpoint} evidence=${fact.endpointEvidence} kind=${fact.failureKind} fault=${fact.faultClass}`,
      key: `${fact.taskId}:${fact.stage}:${fact.attemptId}`,
    })),
    metadata: {
      fleet,
      knownIssueIds: correlation.tasks,
    },
  });
}

// ── Covered-candidate filter ───────────────────────────────────────────────

/**
 * Candidates covered by at least one fleet correlation. Current rules:
 *   - a candidate with a `taskId` in the correlation AND produced from one
 *     of that correlation's stage attempts (by (taskId, stage)) is covered;
 *   - a job-backed candidate whose `jobId` matches a correlated job attempt
 *     is covered.
 *
 * The detector-side candidate shapes differ in fields but all share
 * `taskId` / `metadata.jobId` / the originating stage. This predicate only
 * reads those canonical fields and is defensive against missing shapes.
 */
export function coveredTaskCandidates(
  candidates: readonly IncidentRecord[],
  correlations: readonly FleetCorrelation[],
): readonly IncidentRecord[] {
  if (correlations.length === 0 || candidates.length === 0) return [];
  const byTaskStage = new Set<string>();
  const byJobId = new Set<string>();
  for (const correlation of correlations) {
    for (const attempt of correlation.attempts) {
      if (attempt.stage === 'job') {
        byJobId.add(attempt.attemptId);
      } else {
        byTaskStage.add(`${attempt.taskId}::${attempt.stage}`);
      }
    }
  }
  return candidates.filter((candidate) => {
    const jobId = typeof candidate.metadata?.jobId === 'string' ? candidate.metadata.jobId : '';
    if (jobId && byJobId.has(jobId)) return true;
    const taskId = candidate.taskId;
    if (!taskId) return false;
    // Use the candidate's rootCauseClass or any stage hint to approximate
    // "produced from this stage"; a stage-specific class names its stage.
    const stageHints: string[] = [];
    const rootCause = String(candidate.rootCauseClass ?? '');
    if (/planning/.test(rootCause)) stageHints.push('planning');
    if (/coding|active_unpublished_work_stalled/.test(rootCause)) stageHints.push('coding');
    if (/review/.test(rootCause)) stageHints.push('review');
    if (/ready/.test(rootCause)) stageHints.push('ready');
    for (const hint of stageHints) {
      if (byTaskStage.has(`${taskId}::${hint}`)) return true;
    }
    return false;
  });
}

// ── Row-builder reader ─────────────────────────────────────────────────────

/**
 * Lookup used by row builders (`arm-reliability`, `terminal-arm-feedback`,
 * `failure-policy`): given a failing attempt's identity, return the fleet
 * cause the correlator attached, or null when no fleet record covers it.
 *
 * The only I/O this does is reading `incidents/index.json` for its active
 * fleet records. It does not re-correlate — that decision belongs to the
 * incident path. When the store has not been written yet, the function
 * returns null and the per-attempt classifier runs unchanged.
 */
export interface FleetCauseLookupInput {
  incidents: readonly IncidentRecord[];
  taskId: string;
  stage?: string;
  at?: number;
}

export interface FleetCauseLookupResult {
  fingerprint: string;
  causeKey: string;
  fleetFaultClass: 'harness-fault' | 'provider-fault';
}

export function fleetCauseForAttempt(input: FleetCauseLookupInput): FleetCauseLookupResult | null {
  for (const incident of input.incidents) {
    if (incident.lifecycle !== 'observed' && incident.lifecycle !== 'active') continue;
    const fleet = incident.metadata?.fleet;
    if (!fleet || typeof fleet !== 'object') continue;
    const attempts = (fleet as FleetIncidentMetadata).attempts ?? [];
    const match = attempts.some((attempt) => attempt.taskId === input.taskId
      && (!input.stage || !attempt.stage || attempt.stage === input.stage));
    if (!match) continue;
    const fleetFaultClass = (fleet as FleetIncidentMetadata).fleetFaultClass ?? 'harness-fault';
    const causeKey = (fleet as FleetIncidentMetadata).causeKey ?? '';
    return { fingerprint: incident.fingerprint, causeKey, fleetFaultClass };
  }
  return null;
}

/**
 * Thin disk read of `incidents/index.json`. Returns an empty list when the
 * store is missing or malformed; never throws. Callers pass the result to
 * {@link fleetCauseForAttempt}.
 */
export function readFleetIncidents(stateDir: string): IncidentRecord[] {
  const indexPath = join(stateDir, 'incidents', 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, IncidentRecord>;
    return Object.values(parsed).filter((record) => Boolean(record?.metadata?.fleet));
  } catch {
    return [];
  }
}

