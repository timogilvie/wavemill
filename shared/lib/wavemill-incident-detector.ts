import { ISSUE_ID_WORD_RE, challengerTaskKey, parseTaskId } from './task-identity.ts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  readHookStatus,
  readJobState,
  type JobStateDiagnostic,
  readPlanningResult,
  readPrIdentity,
  type PrIdentityDiagnostic,
  readQuotaSnapshotDiagnostic,
  type QuotaSnapshotDiagnostic,
  readReadyResultDiagnostic,
  type ReadyResultDiagnostic,
  readReviewFailureEnvelope,
  type ReviewFailureEnvelopeDiagnostic,
  type ReviewResultDiagnostic,
  readReviewResultDiagnostic,
  redactIncidentData,
} from './artifact-diagnostics.ts';
import {
  REMEDIATION_PROPOSAL_SCHEMA_VERSION,
  canonicalizeRootCauseClass,
  createIncidentDraft,
  isRemoteRootCauseClass,
  type CausalChainEntry,
  type IncidentEvidence,
  type IncidentCategory,
  type IncidentRecord,
  type IncidentRootCauseClass,
  type RemediationAllowedAction,
  type RemediationForbiddenAction,
  type RemediationProposal,
  type RemediationTarget,
} from './wavemill-incident-model.ts';
import { TEND_STALL_MARKER_KINDS } from './wavemill-incident-tend-candidates.ts';
import { readIncidentLogExcerpt } from './incident-log-excerpt-reader.ts';
import { checkDepsDrift, type DepsDriftResult } from './deps-drift.ts';

const PLANNING_TERMINAL_REASONS = new Set([
  'turn_limit',
  'tool_call_limit',
  'wall_clock_limit',
  'tool_stagnation',
  'invalid_plan',
  'empty_final_plan',
  'provider_error',
  'aborted',
]);

export interface DetectorContext {
  repoDir: string;
  session?: string;
  now?: Date;
  tendCandidates?: TendCandidateDiagnostic[];
}

export interface TendCandidateDiagnostic {
  taskId?: string;
  pr?: number;
  headBranch?: string;
  markerKind?: string;
  firstBlockedGate?: string;
  pairId?: string;
  blockedReason?: string;
  /** Additive (HOK-2595): Tend-reported PR label names. */
  labels?: string[];
  /** Where the candidate came from: the tend heartbeat or a stall marker finding. */
  source?: 'backstage-health' | 'observer-marker';
  /** Consecutive unchanged idle-blocked polls Tend reported. */
  blockedStreak?: number;
  /** When Tend observed the blocked lane (heartbeat or marker time). */
  observedAt?: string;
}

export class PlanningFailureDetector {
  detect(taskPath: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const resultPath = join(taskPath, '.planning-result.json');
    const result = readPlanningResult(resultPath);
    if (result?.error) return [malformedPlanningResultIncident(resultPath, taskId, result.error, context)];
    if (!result || result.status !== 'failed' || !result.failureReason) return [];
    const normalizedReason = normalizePlanningReason(result.failureReason);
    if (!PLANNING_TERMINAL_REASONS.has(normalizedReason)) return [];

    const timestamp = result.finishedAt ?? context.now?.toISOString() ?? new Date().toISOString();
    const planState = result.planFile
      ? (existsSync(resolveTaskPath(taskPath, result.planFile)) ? 'present' : 'missing')
      : 'not_referenced';
    const model = result.model ?? 'unknown_model';
    const agent = result.agent ?? 'unknown_planner';
    return [createIncidentDraft({
      taskId,
      session: context.session ?? null,
      category: 'model_task_harness_outcome',
      severity: 'high',
      confidence: 'definite',
      lifecycle: 'observed',
      rootCauseClass: normalizedReason as IncidentRootCauseClass,
      summary: `Planning failed with ${normalizedReason} for ${taskId}.`,
      operatorAction: 'Review task scope and native planning limits; simplify the task or adjust planning budgets before retrying.',
      evidence: [{
        type: 'planning_result',
        source: resultPath,
        timestamp,
        redactedData: redactIncidentData(`status=failed failureReason=${normalizedReason} planner=${agent} model=${model} planArtifact=${planState}`),
        key: normalizedReason,
      }, {
        type: 'log_excerpt',
        source: result.transcriptFile ? basename(result.transcriptFile) : '(no transcript)',
        timestamp,
        redactedData: redactIncidentData(`transcript_ref=${result.transcriptFile ? basename(result.transcriptFile) : 'none'} terminalReason=${normalizedReason}`),
        key: 'planning_transcript_ref',
      }],
      metadata: { planArtifactState: planState, planner: agent, model },
    })];
  }
}

/**
 * A `.planning-result.json` that exists but cannot be parsed is a coverage
 * gap, not a planning outcome. Evidence is the path plus a bounded parse
 * error with any quoted content removed — never the file content. The file
 * mtime is the event time, so re-polling the same broken file dedupes.
 */
function malformedPlanningResultIncident(resultPath: string, taskId: string, error: string, context: DetectorContext): IncidentRecord {
  const parseError = redactIncidentData(boundedOneLine(error.replace(/(["'`]).*?\1/g, '$1…$1'), 160));
  return createIncidentDraft({
    taskId,
    session: context.session ?? null,
    category: 'configuration_operator_condition',
    severity: 'low',
    confidence: 'high',
    lifecycle: 'observed',
    rootCauseClass: 'malformed_stage_artifact',
    summary: `${taskId} has an unreadable planning result artifact; planning outcome detection is blind for this task.`,
    operatorAction: 'Inspect the planning result file; rerun or rewrite it through the normal planning path. The observer does not modify stage artifacts.',
    evidence: [{
      type: 'planning_result',
      source: resultPath,
      timestamp: safeMtimeIso(resultPath) ?? context.now?.toISOString() ?? new Date().toISOString(),
      redactedData: `malformed=true parseError=${parseError}`,
      key: 'malformed_planning_result',
    }],
    metadata: { artifact: basename(resultPath), parseError },
  });
}

function boundedOneLine(text: string, maxLength: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}

export class WorkflowStateDetector {
  detect(taskPath: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const workflowStatePath = join(context.repoDir, '.wavemill', 'workflow-state.json');
    const workflowState = readObjectFile(workflowStatePath);
    const taskState = workflowState ? taskEntry(workflowState, taskId) : null;
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();

    for (const stage of ['coding', 'review', 'ready'] as const) {
      const markerPath = join(taskPath, `.${stage}-complete`);
      const resultPath = join(taskPath, `.${stage}-result.json`);
      const phase = stringField(taskState?.phase);
      if (existsSync(markerPath) && !existsSync(resultPath)) {
        // Marker mtime, not poll time: the same orphaned marker re-observed on
        // every cycle must keep a stable event identity.
        const markerTimestamp = safeMtimeIso(markerPath) ?? timestamp;
        incidents.push(createIncidentDraft({
          taskId,
          session: context.session ?? null,
          category: 'stale_orphaned_state',
          severity: 'medium',
          confidence: 'high',
          lifecycle: 'observed',
          rootCauseClass: 'orphaned_completion_marker',
          summary: `${taskId} has a ${stage} completion marker without a result artifact.`,
          operatorAction: 'Verify workflow state and recover the missing stage result or clear the stale marker through the normal controller path.',
          evidence: [{
            type: 'workflow_state',
            source: workflowStatePath,
            timestamp: markerTimestamp,
            redactedData: redactIncidentData(`stage=${stage} phase=${phase ?? 'unknown'} marker=${basename(markerPath)} resultMissing=true`),
            key: `orphaned_${stage}_marker`,
          }],
          metadata: { stage, markerPath, resultPath },
        }));
      }
    }

    return incidents;
  }
}

export class JobFailureDetector {
  detect(repoDir: string, taskId: string | null, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const seen = new Set<string>();
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();

    for (const job of readJobs(repoDir)) {
      const key = job.id ?? `${job.kind}:${job.issueId}:${job.startedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (job.status !== 'failed' && job.status !== 'timeout') continue;
      const subjectTaskId = jobSubjectTaskId(job);
      if (taskId && subjectTaskId !== taskId) continue;

      const missingResult = job.resultPath ? !existsSync(job.resultPath) : /no_result|missing/i.test(job.reason ?? '');
      const missingEvalEvidence = job.kind === 'comparison' && /eval|record|no_result|missing/i.test(`${job.reason ?? ''} ${job.error ?? ''}`);
      const observedSymptom: IncidentRootCauseClass = missingEvalEvidence
        ? 'missing_eval_records_for_comparison'
        : missingResult
          ? 'failed_job_no_result'
          : 'failed_background_job';

      const terminalTimestamp = job.finishedAt ?? job.startedAt ?? timestamp;
      const excerpt = readIncidentLogExcerpt(job, repoDir, observedSymptom);
      const diagnosed = excerpt.diagnosedClass;
      const rootCauseClass: IncidentRootCauseClass = diagnosed ?? observedSymptom;
      const category = diagnosed
        ? categoryForDiagnosedClass(diagnosed)
        : (observedSymptom === 'failed_background_job' ? 'product_defect' : 'stale_orphaned_state');

      const summary = diagnosed
        ? `${job.kind ?? 'background'} job ${job.id ?? '(unknown)'} ended ${job.status}: ${diagnosed}.`
        : `${job.kind ?? 'background'} job ${job.id ?? '(unknown)'} ended ${job.status}.`;
      const operatorAction = diagnosed
        ? operatorActionForDiagnosedClass(diagnosed)
        : (missingEvalEvidence
          ? 'Inspect eval-record production for the compared pair and retry comparison only after records exist.'
          : 'Review the managed job result/log evidence and retry or settle the orphaned job through the controller.');

      const jobEvidence: IncidentEvidence = {
        type: 'job_state',
        source: job.source,
        // Terminal event time, not poll time: an un-reaped historical failure
        // must not register a fresh occurrence every observer cycle.
        timestamp: terminalTimestamp,
        redactedData: redactIncidentData(`id=${job.id ?? 'unknown'} kind=${job.kind ?? 'unknown'} status=${job.status} reason=${job.reason ?? 'unknown'} resultMissing=${missingResult}`),
        key: `observed:${observedSymptom}`,
      };
      const evidence: IncidentEvidence[] = [jobEvidence];
      if (excerpt.source !== 'unavailable') {
        evidence.push({
          type: 'log_excerpt',
          source: excerpt.logFileBasename ?? excerpt.source,
          timestamp: terminalTimestamp,
          redactedData: redactIncidentData(excerpt.redactedText),
          key: excerpt.key,
        });
      }

      incidents.push(createIncidentDraft({
        taskId: subjectTaskId,
        session: context.session ?? null,
        category,
        severity: 'medium',
        confidence: 'definite',
        lifecycle: 'observed',
        rootCauseClass,
        summary,
        operatorAction,
        evidence,
        metadata: {
          jobId: job.id,
          jobKind: job.kind,
          pairId: job.pairId,
          side: job.side,
          resultPath: job.resultPath,
          logPath: job.logPath,
          observedSymptom,
          diagnosedClass: diagnosed ?? null,
          logExcerptSource: excerpt.source,
          // Preserve the terminal event time used for this incident. Filing
          // reconciliation compares later successes against this value rather
          // than against observer poll time.
          authoritativeFailureAt: terminalTimestamp,
        },
      }));
    }

    return incidents;
  }
}

export interface DependencyHealthDetectorOptions {
  thresholdConsecutiveFailures?: number;
}

export class DependencyHealthDetector {
  private readonly options: DependencyHealthDetectorOptions;

  constructor(options: DependencyHealthDetectorOptions = {}) {
    this.options = options;
  }

  detect(repoDir: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    return [
      ...this.detectTask(repoDir, taskId, context),
      ...this.detectRepo(repoDir, context),
    ];
  }

  detectTask(repoDir: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();
    const threshold = this.options.thresholdConsecutiveFailures ?? 3;

    for (const hookFile of safeReaddir('/tmp').filter((name) => name.startsWith('wavemill-') && name.endsWith('.hook') && name.includes(taskId))) {
      const hookPath = join('/tmp', hookFile);
      const hook = readHookStatus(hookPath);
      const detail = `${hook?.detail ?? ''} ${hook?.error ?? ''}`;
      if (!hook || !/\b(remote|ssh|git|github|ls-remote|network)\b/i.test(detail)) continue;
      const rootCauseClass = canonicalizeRootCauseClass(detail);
      const remote = isRemoteRootCauseClass(rootCauseClass);
      incidents.push(createIncidentDraft({
        taskId,
        session: context.session ?? null,
        category: dependencyCategoryFor(rootCauseClass),
        severity: 'low',
        confidence: 'low',
        lifecycle: 'observed',
        rootCauseClass,
        summary: remote
          ? `${taskId} observed a remote dependency probe failure.`
          : `${taskId} observed a local harness failure (${rootCauseClass}).`,
        operatorAction: `Watch for repetition; escalate only when this reaches ${threshold} consecutive observations or blocks workflow progress.`,
        evidence: [{
          type: 'hook_status',
          source: hookPath,
          timestamp: hook.timestamp ? new Date(hook.timestamp).toISOString() : timestamp,
          redactedData: redactIncidentData(`state=${hook.state ?? 'unknown'} event=${hook.event ?? 'unknown'} detail=${detail}`),
          key: remote ? 'remote_probe_failure' : rootCauseClass,
        }],
        metadata: { threshold },
      }));
    }

    return incidents;
  }

  detectRepo(repoDir: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();
    const threshold = this.options.thresholdConsecutiveFailures ?? 3;

    const queueHealthPath = join(repoDir, '.wavemill', 'queue-health.json');
    const queueHealth = readObjectFile(queueHealthPath);
    if (queueHealth?.status === 'degraded') {
      const reason = stringField(queueHealth.degradationReason) ?? 'dependency_planning_failed';
      // HOK-3130: inference_unavailable is recorded on a *successful* planner
      // run, so the planner failureCount stays 0; repetition lives in the
      // inference block instead.
      const inferenceUnavailable = reason === 'inference_unavailable';
      const inference = objectField(queueHealth.inference);
      const planner = queueFailurePlanner(queueHealth);
      const diagnostic = inferenceUnavailable
        ? stringField(inference?.error) ?? `inference_${stringField(queueHealth.inferenceStatus) ?? 'unknown'}`
        : diagnosticReason(queueHealth) ?? reason;
      const failureCount = inferenceUnavailable
        ? Math.max(1, numberField(inference?.consecutiveFailures) ?? 1)
        : numberField(queueHealth.failureCount) ?? 1;
      const rootCauseClass = inferenceUnavailable
        ? queuePlannerClass(canonicalizeRootCauseClass(diagnostic))
        : queueDegradationRootCause(reason, diagnostic, planner.step);
      const plannerDetail = formatQueuePlannerDetail(planner);
      incidents.push(createIncidentDraft({
        taskId: null,
        session: context.session ?? null,
        category: dependencyCategoryFor(rootCauseClass),
        severity: failureCount >= threshold ? 'medium' : 'low',
        confidence: failureCount >= threshold ? 'high' : 'medium',
        lifecycle: 'observed',
        rootCauseClass,
        summary: `Queue planner fallback is active: ${reason}${plannerDetail ? ` (${plannerDetail})` : ''}.`,
        operatorAction: inferenceUnavailable
          ? 'Queue dependency inference is not answering; the wave uses explicit Linear relations only. Check the [classifier] lines in the mill log and the Claude CLI login, then the inference block in queue-health.json.'
          : 'Inspect queue-health diagnostics and dependency planner inputs; fallback is acceptable briefly but should not persist.',
        evidence: [{
          type: 'backstage_health',
          source: queueHealthPath,
          timestamp: stringField(queueHealth.lastAttemptAt) ?? stringField(queueHealth.updatedAt) ?? timestamp,
          redactedData: redactIncidentData(`reason=${reason} step=${planner.step ?? 'unknown'} exit=${planner.exitCode ?? 'unknown'} signal=${planner.signal ?? 'none'} diagnostic=${diagnostic} failureCount=${failureCount}`),
          key: 'queue_planner_fallback',
        }],
        metadata: {
          threshold,
          failureCount,
          diagnosticReason: diagnostic,
          degradationReason: reason,
          failureStep: planner.step,
          plannerExitCode: planner.exitCode,
          plannerSignal: planner.signal,
          cancellationOwner: planner.cancellationOwner,
        },
      }));
    }

    const backstageHealthPath = join(repoDir, '.wavemill', 'backstage-health.json');
    const backstageHealth = readObjectFile(backstageHealthPath);
    const services = objectField(backstageHealth?.services);
    if (services) {
      for (const [serviceName, rawService] of Object.entries(services)) {
        const service = objectField(rawService);
        if (!service) continue;
        const lastError = stringField(service.lastError);
        const detail = `${stringField(service.detail) ?? ''} ${lastError ?? ''}`;
        const failureCount = numberField(service.failureCount) ?? numberField(service.restartAttemptCount) ?? 0;
        if (failureCount < 1 || !/\b(remote|ssh|github|dependency|probe)\b/i.test(detail)) continue;
        const serviceRootCause = canonicalizeRootCauseClass(detail);
        const serviceRemote = isRemoteRootCauseClass(serviceRootCause);
        // A one-off probe failure is observed, not escalated; the same record
        // (same evidence key) is raised to a degraded-dependency incident once
        // the service reports the configured number of consecutive failures.
        const degraded = failureCount >= threshold;
        const errorSummary = redactIncidentData(boundedOneLine(lastError ?? detail, 240));
        incidents.push(createIncidentDraft({
          taskId: null,
          session: context.session ?? null,
          category: dependencyCategoryFor(serviceRootCause),
          severity: degraded ? 'medium' : 'low',
          confidence: degraded ? 'high' : 'low',
          lifecycle: 'observed',
          rootCauseClass: serviceRootCause,
          summary: degraded
            ? (serviceRemote
              ? `${serviceName} dependency health is degraded by ${failureCount} consecutive probe failures: ${errorSummary}`
              : `${serviceName} health is degraded by repeated local failures (${serviceRootCause}).`)
            : `${serviceName} observed ${failureCount} ${serviceRemote ? 'remote probe' : 'local'} failure(s); below the ${threshold}-failure escalation threshold.`,
          operatorAction: degraded
            ? 'Check the external dependency and credentials before treating this as a Wavemill product defect.'
            : `Watch for repetition; escalate only when this reaches ${threshold} consecutive failures or blocks workflow progress.`,
          evidence: [{
            type: 'backstage_health',
            source: backstageHealthPath,
            timestamp: stringField(service.lastErrorAt) ?? stringField(service.updatedAt) ?? timestamp,
            redactedData: redactIncidentData(`service=${serviceName} failureCount=${failureCount} lastError=${errorSummary}`),
            key: `degraded_dependency_health:${serviceName}`,
          }],
          metadata: { threshold, failureCount, serviceName, escalated: degraded, lastErrorSummary: errorSummary },
        }));
      }
    }

    return incidents;
  }
}

/**
 * HOK-3254 — stale node_modules detector. Surfaces off-machine when a
 * dependency bump landed but nothing reinstalled, so the mill is running
 * against an older install. The monitor's deps-drift tick auto-fixes locally
 * when `WAVEMILL_DEPS_DRIFT_AUTOFIX` is on; this detector exists so the
 * condition is still raised when auto-fix is off, or when the monitor is not
 * running.
 */
export class DepsDriftDetector {
  detectRepo(repoDir: string, context: DetectorContext): IncidentRecord[] {
    const now = context.now?.toISOString() ?? new Date().toISOString();
    let result: DepsDriftResult;
    try {
      result = checkDepsDrift(repoDir);
    } catch {
      return [];
    }
    if (result.status !== 'drift') return [];
    const names = result.packages.map((pkg) => pkg.name).filter(Boolean);
    const packageLabel = names.length > 0
      ? names.slice(0, 5).join(', ') + (names.length > 5 ? `, …+${names.length - 5}` : '')
      : '(hidden lockfile unavailable)';
    const detail = `reason=${result.reason} packages=${names.length > 0 ? names.join(',') : 'unknown'}`;
    return [createIncidentDraft({
      taskId: null,
      session: context.session ?? null,
      category: dependencyCategoryFor('stale_dependency_install'),
      severity: 'medium',
      confidence: 'high',
      lifecycle: 'observed',
      rootCauseClass: 'stale_dependency_install',
      summary: `node_modules is stale against the lockfile (${result.reason}): ${packageLabel}.`,
      operatorAction: 'Run `npm ci` in the repo, or set WAVEMILL_DEPS_DRIFT_AUTOFIX=1 to let the monitor repair it on its next tick.',
      evidence: [{
        type: 'backstage_health',
        source: join(repoDir, 'package-lock.json'),
        timestamp: now,
        redactedData: redactIncidentData(boundedOneLine(detail, 240)),
        key: `deps_drift:${result.reason}`,
      }],
      metadata: {
        driftReason: result.reason,
        driftedPackages: names,
        driftedPackageCount: result.packages.length,
      },
    })];
  }
}

/** Review failure categories that mean the reviewer ran out of context. */
const CONTEXT_FAILURE_CATEGORIES = new Set([
  'context-window-exceeded',
  'native-context-window-exceeded',
]);
/** Typed envelope causes / provider error kinds that mean credit or quota exhaustion. */
const PROVIDER_QUOTA_SIGNALS = new Set([
  'provider-credit-exhausted',
  'openrouter-credits-exhausted',
  'provider-quota-exhausted',
]);
/** Base forbidden set for every correlated proposal. */
const FORBIDDEN_REMEDIATION_ACTIONS: RemediationForbiddenAction[] = [
  'add_ready_label',
  'merge',
  'destructive_git',
  'delete_branch',
  'kill_process',
  'modify_worktree',
];
/** Challenge-pair proposals must also never manufacture a comparison outcome. */
const PAIR_FORBIDDEN_REMEDIATION_ACTIONS: RemediationForbiddenAction[] = [
  ...FORBIDDEN_REMEDIATION_ACTIONS,
  'synthesize_winner',
  'force_comparison',
];
const DO_NOT_CLAUSE = 'Do not add wm:ready, merge, rewrite destructively, or delete the branch from this proposal.';
const PAIR_DO_NOT_CLAUSE = 'Do not synthesize a winner, force a comparison, add wm:ready, or merge from this proposal.';

/** `missingEvidence` vocabulary for inspection incidents. */
type MissingEvidenceKind = 'task' | 'pr_identity' | 'review_result' | 'pair_state' | 'file_counts';

/** Where a challenge pair stands relative to the blocked comparison. */
export type ChallengePairState =
  | 'waiting_for_work'
  | 'blocked_on_provider_recovery'
  | 'ready_for_rereview'
  | 'blocked_on_rereview';

/** Per-arm structured evidence joined for pair correlation. */
interface PairArmEvidence {
  side: 'primary' | 'challenger';
  taskId: string;
  taskDir: string | null;
  prNumber?: number;
  pr: PrIdentityDiagnostic | null;
  review: ReviewResultDiagnostic | null;
  envelope: ReviewFailureEnvelopeDiagnostic | null;
  ready: ReadyResultDiagnostic | null;
}

/**
 * Correlates Tend blocked-lane candidates with task state, review/Ready
 * artifacts, failure envelopes, PR identity, provider quota and background
 * jobs into one typed root cause plus a schema-versioned remediation proposal.
 *
 * Read-only: it never mutates worktrees, labels or jobs. Diagnosis prefers
 * structured fields (`failureCategory`, envelope `cause`, diff-base
 * provenance, exact head/base SHAs); missing evidence lowers confidence to an
 * inspection incident and never fabricates a stale-base or provider cause.
 */
export class StalledLifecycleCorrelator {
  detect(repoDir: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const candidates = (context.tendCandidates ?? [])
      .filter((candidate) => candidate.pr && TEND_STALL_MARKER_KINDS.has(candidate.markerKind ?? ''));
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();
    const workflowState = readObjectFile(join(repoDir, '.wavemill', 'workflow-state.json'));
    const seenPrs = new Set<number>();
    const seenPairs = new Set<string>();

    for (const candidate of candidates) {
      const prNumber = candidate.pr!;
      if (seenPrs.has(prNumber)) continue;
      seenPrs.add(prNumber);
      const taskId = candidate.taskId ?? extractIssueId(candidate.headBranch) ?? null;
      const task = workflowState && taskId ? taskEntry(workflowState, taskId) : null;
      const gate = candidate.firstBlockedGate ?? candidate.blockedReason ?? '';

      if (isChallengePairGate(gate)) {
        const pairId = candidate.pairId ?? stringField(task?.challengePairId) ?? stringField(task?.pairId);
        const pairKey = pairId ?? `pr:${prNumber}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        incidents.push(...this.correlateChallengePair({ repoDir, workflowState, candidate, taskId, pairId, gate, timestamp }));
        continue;
      }

      const taskDir = taskId ? resolveTaskArtifactDir(repoDir, taskId, workflowState) : null;
      const review = taskDir ? readReviewResultDiagnostic(taskDir) : null;
      // A review in flight is work in progress, not a stall cause.
      if (review?.stageStatus === 'running') continue;
      const envelope = taskDir ? readReviewFailureEnvelope(taskDir) : null;
      const ready = taskDir ? readReadyResultDiagnostic(taskDir) : null;
      const pr = readPrIdentity(prNumber, repoDir);
      const evidenceSet = { repoDir, candidate, taskId, taskDir, pr, review, envelope, ready, timestamp };

      const missing: MissingEvidenceKind[] = [];
      if (!taskId || !taskDir) missing.push('task');
      if (!pr) missing.push('pr_identity');
      if (!review) missing.push('review_result');

      if (isContextFailure(review, envelope)) {
        if (pr && review && (review.reviewedFileCount === undefined || pr.changedFileCount === undefined)) {
          missing.push('file_counts');
        }
        if (missing.length > 0) {
          incidents.push(this.inspectionIncident({ ...evidenceSet, reason: 'missing_authoritative_evidence', missing }));
        } else if (qualifiesStaleBaseOverflow(review!, pr!)) {
          incidents.push(this.staleBaseOverflowIncident({ ...evidenceSet, pr: pr!, review: review! }));
        } else {
          // Context overflow on the current head/base, or a scope that is not
          // materially larger than the PR: a genuinely large diff, not a
          // stale base. Do not claim a cause.
          incidents.push(this.inspectionIncident({ ...evidenceSet, reason: 'contradictory_context_scope_evidence', missing }));
        }
        continue;
      }

      // The scope guard could not evaluate scope: no structured cause, so
      // the only honest output is an inspection.
      if (review?.failureCategory === 'review-scope-unverifiable') {
        incidents.push(this.inspectionIncident({ ...evidenceSet, reason: 'review_scope_unverifiable', missing }));
        continue;
      }

      // No structured causal chain applies. With complete evidence the
      // generic stale-task detectors remain in charge; with missing evidence
      // record an inspection incident so the gap is visible.
      if (missing.length > 0) {
        incidents.push(this.inspectionIncident({ ...evidenceSet, reason: 'missing_authoritative_evidence', missing }));
      }
    }
    return incidents;
  }

  private staleBaseOverflowIncident(input: {
    repoDir: string;
    taskId: string | null;
    taskDir: string | null;
    candidate: TendCandidateDiagnostic;
    pr: PrIdentityDiagnostic;
    review: ReviewResultDiagnostic;
    envelope: ReviewFailureEnvelopeDiagnostic | null;
    ready: ReadyResultDiagnostic | null;
    timestamp: string;
  }): IncidentRecord {
    const { pr, review, candidate } = input;
    const evidence: IncidentEvidence[] = [
      prEvidence(pr, input.timestamp),
      reviewEvidence(review, input.timestamp),
      tendEvidence(candidate, input.repoDir, input.timestamp),
      ...(input.envelope ? [envelopeEvidence(input.envelope, input.timestamp)] : []),
      ...(input.ready ? [readyEvidence(input.ready, input.timestamp)] : []),
    ];
    const gate = candidate.firstBlockedGate ?? candidate.blockedReason ?? 'unknown';
    const causalChain: CausalChainEntry[] = [
      { cause: 'context_window_exceeded', evidenceIndex: 1, detail: review.failureCategory ?? input.envelope?.cause },
      { cause: 'stale_review_scope', evidenceIndex: 1, detail: describeScopeStaleness(review, pr) },
      { cause: 'review_not_ready', evidenceIndex: 1, detail: review.verdict ?? review.stageStatus },
      { cause: 'no_wm_ready', evidenceIndex: 0, detail: pr.labels.includes('wm:ready') ? 'wm:ready present' : 'wm:ready absent' },
      { cause: `tend_blocked(${gate})`, evidenceIndex: 2 },
    ];
    const headSha = pr.headSha ?? 'unknown';
    const baseSha = pr.baseSha ?? 'unknown';
    const proposal = remediationProposal({
      kind: 'refresh_base_and_rereview',
      recommendationId: 'refresh_base_and_rereview',
      retryKey: `refresh-base-rereview:pr:${pr.number}:head:${headSha}:base:${baseSha}`,
      safetyLevel: 'operator_only',
      prerequisites: [
        'Confirm the PR still targets the expected integration base.',
        'Refresh the authoritative base (fetch the PR base ref) through the normal workflow path.',
        'Invalidate the stale review evidence recorded against the old base/head.',
        'Run review again against the current PR head before any Ready action.',
      ],
      evidence,
      allowedActions: ['refresh_authoritative_base', 'invalidate_stale_review_evidence', 'rerun_review'],
      forbiddenActions: FORBIDDEN_REMEDIATION_ACTIONS,
      target: { issueId: input.taskId ?? undefined, prNumber: pr.number, headSha: pr.headSha, baseSha: pr.baseSha },
      recoveryPredicate: {
        kind: 'review_now_ready',
        details: {
          pr: String(pr.number),
          head: headSha,
          reviewResultPath: review.source,
          reviewHead: review.reviewedHead ?? 'unknown',
          reviewFinishedAt: review.finishedAt ?? review.reviewedAtIso ?? 'unknown',
        },
      },
    });
    return createIncidentDraft({
      taskId: input.taskId,
      session: null,
      category: 'stale_orphaned_state',
      severity: 'high',
      confidence: 'high',
      lifecycle: 'observed',
      rootCauseClass: 'review_context_overflow_stale_base',
      summary: `PR #${pr.number} review overflowed its context on a stale scope `
        + `(${review.reviewedFileCount} files reviewed vs ${pr.changedFileCount} in the PR); Tend holds it at ${gate}.`,
      operatorAction: `Refresh authoritative base, invalidate stale review evidence, rerun review. ${DO_NOT_CLAUSE}`,
      evidence,
      metadata: {
        proposal,
        causalChain,
        prNumber: pr.number,
        taskId: input.taskId,
        tendGate: gate,
        tendLabels: candidate.labels ?? pr.labels,
        failureCategory: review.failureCategory,
        envelopeCause: input.envelope?.cause,
        recordedHead: review.reviewedHead,
        recordedBase: review.reviewedBase,
        recordedMergeBase: review.reviewedMergeBase,
        diffBaseRef: review.diffBaseRef,
        diffBaseKind: review.diffBaseKind,
        diffBaseFetch: review.diffBaseFetch,
        currentHead: pr.headSha,
        currentBase: pr.baseSha,
        authoritativeHead: pr.headSha,
        authoritativeBase: pr.baseSha,
        reviewedFileCount: review.reviewedFileCount,
        authoritativeFileCount: pr.changedFileCount,
        artifactPaths: artifactPaths(input),
        knownIssueIds: input.taskId ? [input.taskId] : [],
      },
    });
  }

  /**
   * Join a `challenge:pair-unresolved*` Tend blocker to both arms' state and
   * artifacts. Emits at most one incident per failed arm, keyed on the pair
   * and the failed arm's issue/review head so both arms' candidates dedupe.
   */
  private correlateChallengePair(input: {
    repoDir: string;
    workflowState: Record<string, unknown> | null;
    candidate: TendCandidateDiagnostic;
    taskId: string | null;
    pairId: string | undefined;
    gate: string;
    timestamp: string;
  }): IncidentRecord[] {
    const { repoDir, workflowState, candidate, pairId, gate, timestamp } = input;
    if (pairId && comparisonSucceededForPair(repoDir, pairId)) return [];
    const arms = pairId && workflowState ? resolvePairArms(repoDir, workflowState, pairId) : [];
    const primary = arms.find((arm) => arm.side === 'primary');
    const challenger = arms.find((arm) => arm.side === 'challenger');
    if (!pairId || !primary || !challenger) {
      return [this.pairInspectionIncident({ repoDir, candidate, taskId: input.taskId, pairId, gate, timestamp, arms, reason: 'pair_arm_missing', missing: ['pair_state'] })];
    }

    if (pairWorkInFlight(repoDir, pairId, arms)) return [];

    const failedArms = arms.filter(armReviewFailed);
    if (failedArms.length === 0) {
      return [this.pairInspectionIncident({ repoDir, candidate, taskId: input.taskId, pairId, gate, timestamp, arms, reason: 'no_failed_arm_identified', missing: [] })];
    }

    const quota = readQuotaSnapshotDiagnostic(repoDir);
    return failedArms.map((failed) => {
      const blocked = failed.side === 'primary' ? challenger : primary;
      return this.pairFailureIncident({ repoDir, candidate, pairId, gate, timestamp, failed, blocked, quota });
    });
  }

  private pairFailureIncident(input: {
    repoDir: string;
    candidate: TendCandidateDiagnostic;
    pairId: string;
    gate: string;
    timestamp: string;
    failed: PairArmEvidence;
    blocked: PairArmEvidence;
    quota: QuotaSnapshotDiagnostic | null;
  }): IncidentRecord {
    const { failed, blocked, pairId, gate, timestamp, quota } = input;
    const provider = providerQuotaEvidence(failed, quota);
    const pairState: ChallengePairState = provider
      ? (providerRecovered(failed, quota, provider.failureAt) ? 'ready_for_rereview' : 'blocked_on_provider_recovery')
      : 'blocked_on_rereview';
    const reviewHead = failed.review?.reviewedHead ?? failed.pr?.headSha ?? 'unknown';
    const category = failed.review?.failureCategory ?? failed.envelope?.cause ?? failed.review?.verdict ?? 'unknown';

    const evidence: IncidentEvidence[] = [
      {
        type: 'challenge_pair_state',
        source: join(input.repoDir, '.wavemill', 'workflow-state.json'),
        timestamp: failed.review?.finishedAt ?? failed.review?.reviewedAtIso ?? timestamp,
        redactedData: redactIncidentData(`pairId=${pairId} failedSide=${failed.side} failedIssue=${failed.taskId} blockedIssue=${blocked.taskId} pairState=${pairState} comparison=missing`),
        key: `pair:${pairId}:failed:${failed.taskId}:head:${reviewHead}`,
      },
    ];
    const reviewIndex = failed.review ? evidence.push(reviewEvidence(failed.review, timestamp)) - 1 : -1;
    const envelopeIndex = failed.envelope ? evidence.push(envelopeEvidence(failed.envelope, timestamp)) - 1 : -1;
    const quotaIndex = provider?.source === 'quota_state' && quota
      ? evidence.push(quotaEvidence(quota, timestamp)) - 1
      : -1;
    const failedPrIndex = failed.pr ? evidence.push(prEvidence(failed.pr, timestamp)) - 1 : -1;
    const blockedPrIndex = blocked.pr ? evidence.push(prEvidence(blocked.pr, timestamp)) - 1 : -1;
    const tendIndex = evidence.push(pairTendEvidence(input.candidate, pairId, gate, input.repoDir, timestamp)) - 1;
    const firstArtifactIndex = [envelopeIndex, reviewIndex, quotaIndex].find((index) => index >= 0) ?? 0;

    const causalChain: CausalChainEntry[] = [
      ...(provider ? [{
        cause: 'provider_credit_exhausted',
        evidenceIndex: provider.source === 'quota_state' ? quotaIndex : firstArtifactIndex,
        detail: provider.detail,
      }] : []),
      { cause: `review_not_ready(${category})`, evidenceIndex: reviewIndex >= 0 ? reviewIndex : firstArtifactIndex },
      { cause: `no_wm_ready(${failed.side})`, evidenceIndex: failedPrIndex >= 0 ? failedPrIndex : 0 },
      { cause: 'no_current_head_eval', evidenceIndex: 0 },
      { cause: 'no_comparison', evidenceIndex: 0 },
      { cause: `tend_blocked(${gate})`, evidenceIndex: tendIndex },
    ];
    const prLabel = failed.prNumber ? `PR #${failed.prNumber}` : 'its PR';
    const proposal = provider
      ? remediationProposal({
        kind: 'provider_retry_or_forfeit_inspection',
        recommendationId: pairState === 'ready_for_rereview' ? 'retry_same_reviewer' : 'await_provider_recovery_then_retry_same_reviewer',
        retryKey: `provider-retry-or-forfeit:${pairId}:issue:${failed.taskId}:head:${reviewHead}`,
        safetyLevel: 'operator_only',
        prerequisites: [
          'Confirm provider credit/quota for the failed reviewer has recovered.',
          'Retry the same reviewer at the failed arm\'s current head; do not switch models silently.',
          'If bounded retries are exhausted, terminalize the failed arm for explicit forfeit.',
        ],
        evidence,
        allowedActions: ['retry_same_reviewer_after_provider_recovery', 'terminalize_forfeit_after_policy_exhaustion'],
        forbiddenActions: PAIR_FORBIDDEN_REMEDIATION_ACTIONS,
        target: pairTarget(pairId, failed, blocked),
        recoveryPredicate: reviewProgressPredicate(failed),
      })
      : remediationProposal({
        kind: 'rereview_failed_challenge_arm',
        recommendationId: 'rerun_failed_arm_review',
        retryKey: `rereview-failed-arm:${pairId}:issue:${failed.taskId}:head:${reviewHead}`,
        safetyLevel: 'operator_only',
        prerequisites: [
          'Inspect the failed arm\'s review result for the failure category.',
          'Rerun review on the failed arm at its current head.',
          'If bounded retries are exhausted, terminalize the failed arm for explicit forfeit.',
        ],
        evidence,
        allowedActions: ['rerun_review', 'terminalize_forfeit_after_policy_exhaustion'],
        forbiddenActions: PAIR_FORBIDDEN_REMEDIATION_ACTIONS,
        target: pairTarget(pairId, failed, blocked),
        recoveryPredicate: reviewProgressPredicate(failed),
      });

    const operatorAction = pairState === 'blocked_on_provider_recovery'
      ? `Work cannot start until ${provider?.provider ?? 'the provider'} recovers: then retry the same reviewer on ${failed.taskId} (${prLabel}); if policy retries are exhausted, terminalize the arm for explicit forfeit. ${PAIR_DO_NOT_CLAUSE}`
      : pairState === 'ready_for_rereview'
        ? `Provider has recovered: retry the same reviewer on ${failed.taskId} (${prLabel}); if policy retries are exhausted, terminalize the arm for explicit forfeit. ${PAIR_DO_NOT_CLAUSE}`
        : `Rerun review on ${failed.taskId} (${prLabel}) at its current head; if policy retries are exhausted, terminalize the arm for explicit forfeit. ${PAIR_DO_NOT_CLAUSE}`;

    return createIncidentDraft({
      taskId: failed.taskId,
      session: null,
      category: provider ? 'external_transient_dependency' : 'model_task_harness_outcome',
      severity: 'high',
      confidence: provider ? 'high' : 'medium',
      lifecycle: 'observed',
      rootCauseClass: provider ? 'provider_quota_exhaustion_blocking_review' : 'challenge_arm_review_failed_blocking_pair',
      summary: provider
        ? `Challenge pair ${pairId} is blocked: the ${failed.side} arm ${failed.taskId} review failed on provider credit/quota exhaustion, so no comparison can run.`
        : `Challenge pair ${pairId} is blocked: the ${failed.side} arm ${failed.taskId} review ended ${category}, so no comparison can run.`,
      operatorAction,
      evidence,
      metadata: {
        proposal,
        causalChain,
        earliestActionableCause: causalChain[0]?.cause,
        pairId,
        pairState,
        tendGate: gate,
        failedSide: failed.side,
        failedIssueId: failed.taskId,
        failedPrNumber: failed.prNumber,
        blockedIssueId: blocked.taskId,
        blockedPrNumber: blocked.prNumber,
        failureCategory: failed.review?.failureCategory,
        envelopeCause: failed.envelope?.cause,
        providerErrorKind: failed.envelope?.providerErrorKind,
        provider: provider?.provider,
        authoritativeHead: failed.pr?.headSha,
        authoritativeBase: failed.pr?.baseSha,
        artifactPaths: [failed.review?.source, failed.envelope?.source, failed.ready?.source, failed.pr?.source, blocked.pr?.source]
          .filter((path): path is string => Boolean(path)),
        knownIssueIds: [failed.taskId, blocked.taskId],
      },
    });
  }

  private pairInspectionIncident(input: {
    repoDir: string;
    candidate: TendCandidateDiagnostic;
    taskId: string | null;
    pairId: string | undefined;
    gate: string;
    timestamp: string;
    arms: PairArmEvidence[];
    reason: string;
    missing: MissingEvidenceKind[];
  }): IncidentRecord {
    const pairKey = input.pairId ?? 'unknown';
    const evidence: IncidentEvidence[] = [
      {
        type: 'challenge_pair_state',
        source: join(input.repoDir, '.wavemill', 'workflow-state.json'),
        timestamp: input.timestamp,
        redactedData: redactIncidentData(`pairId=${pairKey} arms=${input.arms.map((arm) => `${arm.side}:${arm.taskId}`).join(',') || 'none'} reason=${input.reason}`),
        key: `pair:${pairKey}:inspection:${input.reason}`,
      },
      pairTendEvidence(input.candidate, pairKey, input.gate, input.repoDir, input.timestamp),
    ];
    const proposal = remediationProposal({
      kind: 'inspection_only',
      recommendationId: 'inspect_challenge_pair',
      retryKey: `inspection:pair:${pairKey}:${input.reason}`,
      safetyLevel: 'inspect',
      prerequisites: ['Inspect both arms\' task state, review/Ready artifacts, eval and comparison jobs before choosing a recovery.'],
      evidence,
      allowedActions: ['inspect'],
      forbiddenActions: PAIR_FORBIDDEN_REMEDIATION_ACTIONS,
    });
    return createIncidentDraft({
      taskId: input.taskId,
      session: null,
      category: 'configuration_operator_condition',
      severity: 'medium',
      confidence: 'low',
      lifecycle: 'observed',
      rootCauseClass: 'inspection_required',
      summary: `Challenge pair ${pairKey} blocks Tend (${input.gate}) but the pair evidence does not identify a failed arm.`,
      operatorAction: `Inspect both challenge arms' state and artifacts; the evidence is not enough to name a cause. ${PAIR_DO_NOT_CLAUSE}`,
      evidence,
      metadata: {
        proposal,
        inspectionReason: input.reason,
        missingEvidence: input.missing,
        pairId: input.pairId,
        tendGate: input.gate,
        knownIssueIds: input.arms.map((arm) => arm.taskId),
      },
    });
  }

  private inspectionIncident(input: {
    repoDir: string;
    taskId: string | null;
    taskDir: string | null;
    candidate: TendCandidateDiagnostic;
    pr: PrIdentityDiagnostic | null;
    review: ReviewResultDiagnostic | null;
    envelope: ReviewFailureEnvelopeDiagnostic | null;
    ready: ReadyResultDiagnostic | null;
    timestamp: string;
    reason: string;
    missing: MissingEvidenceKind[];
  }): IncidentRecord {
    const evidence: IncidentEvidence[] = [
      ...(input.pr ? [prEvidence(input.pr, input.timestamp)] : []),
      ...(input.review ? [reviewEvidence(input.review, input.timestamp)] : []),
      ...(input.envelope ? [envelopeEvidence(input.envelope, input.timestamp)] : []),
      tendEvidence(input.candidate, input.repoDir, input.timestamp),
    ];
    const gate = input.candidate.firstBlockedGate ?? input.candidate.blockedReason ?? 'unknown';
    const proposal = remediationProposal({
      kind: 'inspection_only',
      recommendationId: 'inspect_stalled_candidate',
      retryKey: `inspection:${input.candidate.pr ?? 'unknown'}:${input.reason}`,
      safetyLevel: 'inspect',
      prerequisites: [
        'Inspect PR metadata, review result, pair state, and eval/comparison artifacts before choosing a recovery.',
      ],
      evidence,
      allowedActions: ['inspect'],
      forbiddenActions: FORBIDDEN_REMEDIATION_ACTIONS,
    });
    const missingText = input.missing.length > 0 ? ` Missing: ${input.missing.join(', ')}.` : '';
    return createIncidentDraft({
      taskId: input.taskId,
      session: null,
      category: 'configuration_operator_condition',
      severity: 'medium',
      confidence: 'low',
      lifecycle: 'observed',
      rootCauseClass: 'inspection_required',
      summary: input.reason === 'contradictory_context_scope_evidence'
        ? `PR #${input.candidate.pr ?? 'unknown'} review overflowed its context but the reviewed scope matches the PR; this is not a stale-base diagnosis.`
        : `PR #${input.candidate.pr ?? 'unknown'} stalled at ${gate} and its lifecycle evidence is incomplete.${missingText}`,
      operatorAction: 'Inspect authoritative PR and stage artifacts manually; missing or conflicting evidence is not enough to diagnose stale base or provider failure.',
      evidence,
      metadata: {
        proposal,
        inspectionReason: input.reason,
        missingEvidence: input.missing,
        prNumber: input.candidate.pr,
        tendGate: gate,
        failureCategory: input.review?.failureCategory,
        authoritativeHead: input.pr?.headSha,
        authoritativeBase: input.pr?.baseSha,
        reviewedFileCount: input.review?.reviewedFileCount,
        authoritativeFileCount: input.pr?.changedFileCount,
        knownIssueIds: input.taskId ? [input.taskId] : [],
      },
    });
  }
}

export function detectIncidentsForTask(taskPath: string, taskId: string, context: DetectorContext, dependencyThreshold = 3): IncidentRecord[] {
  return [
    ...new PlanningFailureDetector().detect(taskPath, taskId, context),
    ...new WorkflowStateDetector().detect(taskPath, taskId, context),
    ...new DependencyHealthDetector({ thresholdConsecutiveFailures: dependencyThreshold }).detectTask(context.repoDir, taskId, context),
  ];
}

export function detectIncidentsForRepo(repoDir: string, context: DetectorContext, dependencyThreshold = 3): IncidentRecord[] {
  return [
    ...new StalledLifecycleCorrelator().detect(repoDir, context),
    ...new JobFailureDetector().detect(repoDir, null, context),
    ...new DependencyHealthDetector({ thresholdConsecutiveFailures: dependencyThreshold }).detectRepo(repoDir, context),
    ...new DepsDriftDetector().detectRepo(repoDir, context),
  ];
}

function normalizePlanningReason(reason: string): string {
  if (reason === 'invalid_or_empty_final_plan') return 'invalid_plan';
  if (reason === 'empty_plan') return 'empty_final_plan';
  return reason.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
}

function isChallengePairGate(gate: string): boolean {
  return gate.startsWith('challenge:pair-unresolved') || gate.startsWith('challenge:pair-unresolvable');
}

/** Structured context-overflow signal only; no regex over free text. */
function isContextFailure(review: ReviewResultDiagnostic | null, envelope: ReviewFailureEnvelopeDiagnostic | null): boolean {
  if (review && CONTEXT_FAILURE_CATEGORIES.has(review.failureCategory ?? '')) return true;
  return envelope?.cause === 'context-window-exceeded';
}

/**
 * Stale-base overflow requires a stale/missing review scope *and* an
 * authoritative PR diff materially smaller than what was reviewed (< 75% and
 * at least 5 fewer files). Both counts must be known (callers check).
 */
function qualifiesStaleBaseOverflow(review: ReviewResultDiagnostic, pr: PrIdentityDiagnostic): boolean {
  const reviewedFileCount = review.reviewedFileCount;
  const authoritativeFileCount = pr.changedFileCount;
  if (reviewedFileCount === undefined || authoritativeFileCount === undefined) return false;
  if (!scopeIsStale(review, pr)) return false;
  return authoritativeFileCount < reviewedFileCount * 0.75
    && authoritativeFileCount <= reviewedFileCount - 5;
}

function scopeIsStale(review: ReviewResultDiagnostic, pr: PrIdentityDiagnostic): boolean {
  if (!review.reviewedBase) return true;
  if (review.diffBaseKind === 'local' || review.diffBaseFetch === 'failed') return true;
  const baseMatches = review.reviewedBase === pr.baseSha || review.reviewedMergeBase === pr.baseSha;
  if (!baseMatches) return true;
  return Boolean(review.reviewedHead && pr.headSha && review.reviewedHead !== pr.headSha);
}

function describeScopeStaleness(review: ReviewResultDiagnostic, pr: PrIdentityDiagnostic): string {
  const reasons: string[] = [];
  if (!review.reviewedBase) reasons.push('reviewed base missing');
  else if (review.reviewedBase !== pr.baseSha && review.reviewedMergeBase !== pr.baseSha) reasons.push('reviewed base differs from PR base');
  if (review.diffBaseKind === 'local') reasons.push(`local diff base${review.diffBaseRef ? ` ${review.diffBaseRef}` : ''}`);
  if (review.diffBaseFetch === 'failed') reasons.push('base fetch failed');
  if (review.reviewedHead && pr.headSha && review.reviewedHead !== pr.headSha) reasons.push('reviewed head differs from PR head');
  reasons.push(`${review.reviewedFileCount ?? '?'} reviewed vs ${pr.changedFileCount ?? '?'} authoritative files`);
  return reasons.join('; ');
}

/** Resolve both challenge arms from workflow state (`challengePairId` + task-identity roles). */
function resolvePairArms(repoDir: string, workflowState: Record<string, unknown>, pairId: string): PairArmEvidence[] {
  const tasks = objectField(workflowState.tasks) ?? {};
  const arms: PairArmEvidence[] = [];
  const keys = Object.keys(tasks).sort();
  for (const key of keys) {
    const task = objectField(tasks[key]);
    if (!task) continue;
    const memberOfPair = stringField(task.challengePairId) === pairId || stringField(task.pairId) === pairId
      || key === pairId || key === challengerTaskKey(pairId);
    if (!memberOfPair) continue;
    const side = stringEnum(task.challengeRole, ['primary', 'challenger'])
      ?? stringEnum(task.challengeSide, ['primary', 'challenger'])
      ?? parseTaskId(key)?.role;
    if (!side || arms.some((arm) => arm.side === side)) continue;
    const taskDir = resolveTaskArtifactDir(repoDir, key, workflowState);
    const review = taskDir ? readReviewResultDiagnostic(taskDir) : null;
    const prNumber = prNumberFromValue(task.pr) ?? review?.prNumber;
    arms.push({
      side,
      taskId: key,
      taskDir,
      prNumber,
      pr: prNumber ? readPrIdentity(prNumber, repoDir) : null,
      review,
      envelope: taskDir ? readReviewFailureEnvelope(taskDir) : null,
      ready: taskDir ? readReadyResultDiagnostic(taskDir) : null,
    });
  }
  return arms;
}

/** "Waiting for work": a pair job or an arm review is still running. */
function pairWorkInFlight(repoDir: string, pairId: string, arms: PairArmEvidence[]): boolean {
  if (arms.some((arm) => arm.review?.stageStatus === 'running' || arm.ready?.stageStatus === 'running')) return true;
  return readJobs(repoDir).some((job) => job.status === 'running' && jobBelongsToPair(job, pairId));
}

function armReviewFailed(arm: PairArmEvidence): boolean {
  if (arm.pr?.labels.includes('wm:ready')) return false;
  const verdict = arm.review?.verdict;
  if (verdict === 'ready') return false;
  return verdict === 'not_ready' || verdict === 'error' || arm.review?.stageStatus === 'failed' || Boolean(arm.envelope?.cause);
}

/** Structured provider-exhaustion evidence for an arm, in precedence order. */
function providerQuotaEvidence(
  arm: PairArmEvidence,
  quota: QuotaSnapshotDiagnostic | null,
): { source: 'review_failure_envelope' | 'review_result' | 'quota_state'; provider?: string; detail: string; failureAt?: string } | null {
  const failureAt = arm.envelope?.createdAt ?? arm.review?.finishedAt ?? arm.review?.reviewedAtIso;
  const envelope = arm.envelope;
  if (envelope && !envelope.error) {
    const signal = [envelope.cause, envelope.providerErrorKind].find((value) => value && PROVIDER_QUOTA_SIGNALS.has(value));
    if (signal) return { source: 'review_failure_envelope', provider: envelope.provider, detail: `envelope ${signal}`, failureAt };
  }
  if (arm.review?.failureCategory === 'provider-credit-exhausted') {
    return { source: 'review_result', provider: envelope?.provider, detail: 'review failureCategory provider-credit-exhausted', failureAt };
  }
  const model = envelope?.model ?? arm.review?.executedReviewer;
  const provider = envelope?.provider;
  if (quota && ((model && quota.exhaustedModels.includes(model)) || (provider && quota.exhaustedProviders.includes(provider)))) {
    return { source: 'quota_state', provider, detail: `quota-state marks ${model ?? provider} exhausted`, failureAt };
  }
  return null;
}

/**
 * Provider recovered after the failure: the failed model has succeeded since,
 * or (OpenRouter) a positive balance was refreshed after the failure. Unknown
 * failure time or snapshot means not recovered.
 */
function providerRecovered(arm: PairArmEvidence, quota: QuotaSnapshotDiagnostic | null, failureAt: string | undefined): boolean {
  if (!quota || !failureAt) return false;
  const failureMs = Date.parse(failureAt);
  if (!Number.isFinite(failureMs)) return false;
  const model = arm.envelope?.model ?? arm.review?.executedReviewer;
  const health = model ? quota.modelHealth[model] : undefined;
  if (health?.status === 'healthy' && health.lastSuccessAt && Date.parse(health.lastSuccessAt) > failureMs) return true;
  const provider = arm.envelope?.provider;
  if (provider === 'openrouter' && (quota.openrouterBalanceUsd ?? 0) > 0 && quota.providersUpdatedAt
    && Date.parse(quota.providersUpdatedAt) > failureMs && !quota.exhaustedProviders.includes('openrouter')) {
    return true;
  }
  return false;
}

function pairTarget(pairId: string, failed: PairArmEvidence, blocked: PairArmEvidence): RemediationTarget {
  return {
    pairId,
    issueId: blocked.taskId,
    prNumber: blocked.prNumber,
    failedSide: failed.side,
    failedIssueId: failed.taskId,
    failedPrNumber: failed.prNumber,
    headSha: failed.pr?.headSha ?? failed.review?.reviewedHead,
    baseSha: failed.pr?.baseSha,
  };
}

function reviewProgressPredicate(failed: PairArmEvidence): NonNullable<RemediationProposal['recoveryPredicate']> {
  return {
    kind: 'review_attempt_progressed',
    details: {
      issue: failed.taskId,
      reviewResultPath: failed.review?.source ?? (failed.taskDir ? join(failed.taskDir, '.review-result.json') : 'unknown'),
      reviewHead: failed.review?.reviewedHead ?? 'unknown',
      reviewFinishedAt: failed.review?.finishedAt ?? failed.review?.reviewedAtIso ?? 'unknown',
    },
  };
}

function remediationProposal(input: {
  kind: RemediationProposal['kind'];
  recommendationId: string;
  prerequisites: string[];
  retryKey: string;
  safetyLevel: RemediationProposal['safetyLevel'];
  evidence: IncidentEvidence[];
  allowedActions: RemediationAllowedAction[];
  forbiddenActions: RemediationForbiddenAction[];
  target?: RemediationTarget;
  recoveryPredicate?: RemediationProposal['recoveryPredicate'];
}): RemediationProposal {
  return {
    schemaVersion: REMEDIATION_PROPOSAL_SCHEMA_VERSION,
    kind: input.kind,
    recommendationId: input.recommendationId,
    prerequisites: input.prerequisites.slice(0, 10),
    retryKey: input.retryKey,
    safetyLevel: input.safetyLevel,
    evidenceRefs: input.evidence.map((evidence, index) => ({
      index,
      type: evidence.type,
      source: evidence.source,
    })),
    allowedActions: input.allowedActions,
    forbiddenActions: input.forbiddenActions,
    ...(input.target ? { target: input.target } : {}),
    ...(input.recoveryPredicate ? { recoveryPredicate: input.recoveryPredicate } : {}),
  };
}

function prEvidence(pr: PrIdentityDiagnostic, timestamp: string): IncidentEvidence {
  return {
    type: 'pr_metadata',
    source: pr.source,
    timestamp,
    redactedData: redactIncidentData(`pr=${pr.number} head=${pr.headSha ?? 'unknown'} base=${pr.baseSha ?? 'unknown'} files=${pr.changedFileCount ?? 'unknown'} labels=${pr.labels.join(',')}`),
    key: `pr:${pr.number}:head:${pr.headSha ?? 'unknown'}:base:${pr.baseSha ?? 'unknown'}:files:${pr.changedFileCount ?? 'unknown'}`,
  };
}

function reviewEvidence(review: ReviewResultDiagnostic, timestamp: string): IncidentEvidence {
  return {
    type: 'review_result',
    source: review.source,
    timestamp: review.finishedAt ?? review.reviewedAtIso ?? timestamp,
    redactedData: redactIncidentData(`verdict=${review.verdict ?? 'unknown'} stageStatus=${review.stageStatus ?? 'unknown'} failureCategory=${review.failureCategory ?? 'unknown'} reviewedHead=${review.reviewedHead ?? 'unknown'} reviewedBase=${review.reviewedBase ?? 'unknown'} diffBase=${review.diffBaseKind ?? 'unknown'}/${review.diffBaseFetch ?? 'unknown'} reviewedFiles=${review.reviewedFileCount ?? 'unknown'}`),
    key: `review:${review.failureCategory ?? 'unknown'}:head:${review.reviewedHead ?? 'unknown'}:base:${review.reviewedBase ?? 'unknown'}:files:${review.reviewedFileCount ?? 'unknown'}`,
  };
}

function envelopeEvidence(envelope: ReviewFailureEnvelopeDiagnostic, timestamp: string): IncidentEvidence {
  return {
    type: 'review_failure_envelope',
    source: envelope.source,
    timestamp: envelope.createdAt ?? timestamp,
    redactedData: redactIncidentData(envelope.error
      ? `malformed=${envelope.error}`
      : `cause=${envelope.cause ?? 'unknown'} providerErrorKind=${envelope.providerErrorKind ?? 'none'} provider=${envelope.provider ?? 'unknown'} model=${envelope.model ?? 'unknown'} transcript_ref=${envelope.transcriptBasename ?? 'none'}`),
    key: `envelope:${envelope.cause ?? 'malformed'}:${envelope.providerErrorKind ?? 'none'}:${envelope.createdAt ?? 'unknown'}`,
  };
}

function readyEvidence(ready: ReadyResultDiagnostic, timestamp: string): IncidentEvidence {
  return {
    type: 'ready_result',
    source: ready.source,
    timestamp: ready.finishedAt ?? timestamp,
    redactedData: redactIncidentData(`status=${ready.stageStatus ?? 'unknown'} verdict=${ready.verdict ?? 'unknown'} readyHead=${ready.readyHeadSha ?? 'unknown'} readyBase=${ready.readyBaseSha ?? 'unknown'} queueState=${ready.queueState ?? 'none'}`),
    key: `ready:${ready.stageStatus ?? 'unknown'}:${ready.verdict ?? 'unknown'}:head:${ready.readyHeadSha ?? 'unknown'}`,
  };
}

function quotaEvidence(quota: QuotaSnapshotDiagnostic, timestamp: string): IncidentEvidence {
  return {
    type: 'quota_state',
    source: quota.source,
    timestamp: quota.lastLimitErrorAtIso ?? timestamp,
    redactedData: redactIncidentData(`exhaustedProviders=${quota.exhaustedProviders.join(',')} exhaustedModels=${quota.exhaustedModels.length}`),
    key: `quota:${quota.exhaustedProviders.join(',') || 'exhausted'}`,
  };
}

/**
 * The Tend observation. Its key names the PR and gate only — not the source
 * (health vs marker) — so a candidate seen through either source dedupes.
 * The timestamp is the poll, so each tick that still sees the stall is a
 * fresh occurrence on the same fingerprint.
 */
function tendEvidence(candidate: TendCandidateDiagnostic, repoDir: string, timestamp: string): IncidentEvidence {
  const gate = candidate.firstBlockedGate ?? candidate.blockedReason ?? 'unknown';
  return {
    type: 'tend_lane',
    source: tendSource(candidate, repoDir),
    timestamp,
    redactedData: redactIncidentData(`source=${candidate.source ?? 'observer-marker'} pr=${candidate.pr ?? 'unknown'} task=${candidate.taskId ?? 'unknown'} gate=${gate} labels=${(candidate.labels ?? []).join(',')} streak=${candidate.blockedStreak ?? 'unknown'}`),
    key: `tend:pr:${candidate.pr ?? 'unknown'}:gate:${gate}`,
  };
}

/** Pair-scoped Tend observation: keyed on the pair, so either arm's candidate dedupes. */
function pairTendEvidence(candidate: TendCandidateDiagnostic, pairId: string, gate: string, repoDir: string, timestamp: string): IncidentEvidence {
  return {
    type: 'tend_lane',
    source: tendSource(candidate, repoDir),
    timestamp,
    redactedData: redactIncidentData(`source=${candidate.source ?? 'observer-marker'} pair=${pairId} pr=${candidate.pr ?? 'unknown'} gate=${gate} streak=${candidate.blockedStreak ?? 'unknown'}`),
    key: `tend:pair:${pairId}:gate:${gate}`,
  };
}

function tendSource(candidate: TendCandidateDiagnostic, repoDir: string): string {
  return candidate.source === 'backstage-health'
    ? join(repoDir, '.wavemill', 'backstage-health.json')
    : join(repoDir, '.wavemill', 'observer-findings.jsonl');
}

function artifactPaths(input: {
  repoDir: string;
  candidate: TendCandidateDiagnostic;
  pr: PrIdentityDiagnostic | null;
  review: ReviewResultDiagnostic | null;
  envelope: ReviewFailureEnvelopeDiagnostic | null;
  ready: ReadyResultDiagnostic | null;
}): string[] {
  return [
    input.review?.source,
    input.envelope?.source,
    input.ready?.source,
    input.pr?.source,
    tendSource(input.candidate, input.repoDir),
  ].filter((path): path is string => Boolean(path));
}

export function resolveTaskArtifactDir(
  repoDir: string,
  taskId: string,
  workflowState: Record<string, unknown> | null = readObjectFile(join(repoDir, '.wavemill', 'workflow-state.json')),
): string | null {
  const task = workflowState ? taskEntry(workflowState, taskId) : null;
  const candidates = [
    task && stringField(task.worktree) && stringField(task.slug) ? join(stringField(task.worktree)!, 'features', stringField(task.slug)!) : null,
    task && stringField(task.slug) ? join(repoDir, 'features', stringField(task.slug)!) : null,
    task && stringField(task.worktree) ? stringField(task.worktree)! : null,
    ...featureDirsForTask(repoDir, taskId),
  ].filter((candidateDir): candidateDir is string => Boolean(candidateDir));
  return candidates.find((candidateDir) => existsSync(candidateDir)) ?? null;
}

function featureDirsForTask(repoDir: string, taskId: string): string[] {
  const featuresDir = join(repoDir, 'features');
  const dirs: string[] = [];
  for (const entry of safeReaddir(featuresDir)) {
    const dir = join(featuresDir, entry);
    const selectedTask = readObjectFile(join(dir, 'selected-task.json'));
    if (selectedTask?.taskId === taskId) dirs.push(dir);
  }
  return dirs;
}

function jobBelongsToPair(job: JobStateWithSource, pairId: string): boolean {
  if (job.pairId) return job.pairId === pairId;
  // Legacy jobs without a pairId: fall back to the job id naming the pair.
  return Boolean(job.id && (job.id === pairId || job.id.includes(`-${pairId}-`) || job.id.endsWith(`-${pairId}`)));
}

/** True when a comparison job for exactly this pair succeeded. */
export function comparisonSucceededForPair(repoDir: string, pairId: string): boolean {
  return readJobs(repoDir).some((job) => job.kind === 'comparison' && job.status === 'succeeded' && jobBelongsToPair(job, pairId));
}

/** True when a eval record for the issue/pair matches `headSha` exactly. */
export function currentHeadEvalPresent(repoDir: string, taskId: string | undefined, pairId: string, headSha: string | undefined): boolean {
  if (!headSha) return false;
  const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  if (!existsSync(evalsPath)) return false;
  let lines: string[];
  try {
    lines = readFileSync(evalsPath, 'utf-8').split('\n');
  } catch {
    return false;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | null;
    try {
      record = objectField(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    if (!record) continue;
    const issueMatches = !taskId || stringField(record.issueId) === taskId;
    const pairMatches = stringField(record.challengePairId) === pairId;
    if (!issueMatches && !pairMatches) continue;
    const recordHead = stringField(record.headSha)
      ?? stringField(record.reviewedHead)
      ?? stringField(record.commitSha)
      ?? stringField(record.revision);
    if (recordHead === headSha) return true;
  }
  return false;
}

function prNumberFromValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  const match = typeof value === 'string' ? value.match(/\d+/) : null;
  const parsed = match ? Number(match[0]) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Category routing for a diagnosed job-log root cause. Product/API contract
 * mismatches are always a product defect; parse errors are operator-owned
 * configuration. Anything else keeps the caller's observed-symptom category.
 */
function categoryForDiagnosedClass(rootCauseClass: IncidentRootCauseClass): IncidentCategory {
  if (rootCauseClass === 'module_export_contract_mismatch') return 'product_defect';
  if (rootCauseClass === 'local_parse_failure') return 'configuration_operator_condition';
  return 'product_defect';
}

/**
 * Fixed operator-action strings for the diagnosed classes we can currently
 * detect from job logs. Kept small on purpose so the taxonomy stays bounded.
 */
function operatorActionForDiagnosedClass(rootCauseClass: IncidentRootCauseClass): string {
  if (rootCauseClass === 'module_export_contract_mismatch') {
    return 'Fix the missing module/API export or downgrade the caller to a compatible version before retrying the job.';
  }
  if (rootCauseClass === 'local_parse_failure') {
    return 'Repair the malformed input feeding the job (JSON/YAML/config parse) before retrying; do not retry blindly.';
  }
  return 'Review the diagnosed failure evidence and address it before retrying the job.';
}

/**
 * Category routing for classified dependency signals. Only affirmatively
 * remote failures stay external; auth/credential probes are operator-owned
 * configuration, and everything else is a local harness/config condition.
 */
function dependencyCategoryFor(rootCauseClass: IncidentRootCauseClass): IncidentCategory {
  if (rootCauseClass === 'remote_auth_failure'
    || rootCauseClass === 'local_parse_failure'
    || rootCauseClass === 'local_config_failure'
    || rootCauseClass === 'queue_planner_degraded'
    || rootCauseClass === 'stale_dependency_install') {
    return 'configuration_operator_condition';
  }
  if (isRemoteRootCauseClass(rootCauseClass)) return 'external_transient_dependency';
  return 'model_task_harness_outcome';
}

function safeMtimeIso(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function resolveTaskPath(taskPath: string, candidate: string): string {
  return candidate.startsWith('/') ? candidate : join(taskPath, candidate);
}

function readObjectFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return objectField(parsed);
  } catch {
    return null;
  }
}

function taskEntry(workflowState: Record<string, unknown>, taskId: string): Record<string, unknown> | null {
  const tasks = objectField(workflowState.tasks);
  return objectField(tasks?.[taskId]);
}

type JobStateWithSource = JobStateDiagnostic & { source: string };

function jobSubjectTaskId(job: JobStateWithSource): string | null {
  const candidates = job.kind === 'comparison'
    ? [job.pairId, job.id, job.issueId, job.resultPath, job.logPath, job.source]
    : [job.issueId, job.id, job.pairId, job.resultPath, job.logPath, job.source];
  for (const candidate of candidates) {
    const issueId = extractIssueId(candidate);
    if (issueId) return issueId;
  }
  return null;
}

function extractIssueId(value: string | undefined): string | null {
  const match = value?.match(ISSUE_ID_WORD_RE);
  return match?.[0] ?? null;
}

function readJobs(repoDir: string): JobStateWithSource[] {
  const jobs: JobStateWithSource[] = [];
  const jobsDir = join(repoDir, '.wavemill', 'jobs');
  for (const fileName of safeReaddir(jobsDir).filter((name) => name.endsWith('.json'))) {
    const source = join(jobsDir, fileName);
    const job = readJobState(source);
    if (job) jobs.push({ ...job, source });
  }

  const workflowStatePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const workflowState = readObjectFile(workflowStatePath);
  const rawJobs = workflowState?.jobs;
  const entries = Array.isArray(rawJobs) ? rawJobs : Object.values(objectField(rawJobs) ?? {});
  for (const entry of entries) {
    const job = objectField(entry);
    if (!job) continue;
    jobs.push({
      id: stringField(job.id),
      kind: stringEnum(job.kind, ['eval', 'comparison']),
      status: stringEnum(job.status, ['running', 'succeeded', 'failed', 'timeout']),
      issueId: stringField(job.issueId),
      startedAt: stringField(job.startedAt),
      finishedAt: stringField(job.finishedAt),
      exitCode: numberField(job.exitCode),
      reason: stringField(job.reason),
      error: stringField(job.error) ?? stringField(job.excerpt),
      resultPath: stringField(job.resultPath),
      logPath: stringField(job.logPath),
      pairId: stringField(job.pairId),
      side: stringField(job.side) ?? stringField(job.challengeRole) ?? stringField(job.role),
      source: workflowStatePath,
    });
  }
  return jobs;
}

/** Planner failure fields written by `queue_health_record_failure` (queue-health.sh). */
interface QueueFailurePlanner {
  step?: string;
  exitCode?: number;
  signal?: number;
  cancellationOwner?: string;
}

function queueFailurePlanner(queueHealth: Record<string, unknown>): QueueFailurePlanner {
  const planner = objectField(queueHealth.planner);
  return {
    step: stringField(queueHealth.failureStep),
    exitCode: numberField(planner?.exitCode),
    signal: numberField(planner?.signal),
    cancellationOwner: stringField(planner?.cancellationOwner),
  };
}

function formatQueuePlannerDetail(planner: QueueFailurePlanner): string {
  return [
    planner.step ? `step=${planner.step}` : null,
    planner.exitCode !== undefined ? `exit=${planner.exitCode}` : null,
    planner.signal !== undefined ? `signal=${planner.signal}` : null,
    planner.cancellationOwner ? `cancelledBy=${planner.cancellationOwner}` : null,
  ].filter((part): part is string => part !== null).join(', ');
}

/**
 * Structured degradation reasons recorded by the queue planner, mapped
 * explicitly so the class never depends on stderr wording.
 * `planner_error` and unmapped reasons fall through to the diagnostic.
 */
const QUEUE_DEGRADATION_ROOT_CAUSES: Record<string, IncidentRootCauseClass> = {
  timeout: 'queue_planner_degraded',
  external_cancellation: 'queue_planner_degraded',
  diagnostics_setup_failed: 'queue_planner_degraded',
  malformed_graph: 'local_parse_failure',
  invalid_input: 'local_parse_failure',
  planner_input_missing: 'local_config_failure',
};

function queueDegradationRootCause(reason: string, diagnostic: string, step: string | undefined): IncidentRootCauseClass {
  const mapped = QUEUE_DEGRADATION_ROOT_CAUSES[reason];
  if (mapped) return mapped;
  const fromDiagnostic = canonicalizeRootCauseClass(diagnostic);
  if (fromDiagnostic !== 'unclassified_local_failure') return queuePlannerClass(fromDiagnostic);
  return step ? queuePlannerClass(canonicalizeRootCauseClass(step)) : 'queue_planner_degraded';
}

/** An unclassifiable degradation is still a known local queue-planner condition, not free text. */
function queuePlannerClass(rootCauseClass: IncidentRootCauseClass): IncidentRootCauseClass {
  return rootCauseClass === 'unclassified_local_failure' ? 'queue_planner_degraded' : rootCauseClass;
}

/**
 * The queue fallback's underlying diagnostic: an explicit structured reason
 * first, then the recorded degradation reason with its failure step and
 * planner exit; the stderr excerpt is only a last resort.
 */
function diagnosticReason(queueHealth: Record<string, unknown>): string | null {
  const diagnostics = objectField(queueHealth.diagnostics);
  const structured = stringField(diagnostics?.structuredReason) ?? stringField(diagnostics?.reason);
  if (structured) return structured;
  const degradationReason = stringField(queueHealth.degradationReason);
  if (degradationReason && degradationReason !== 'dependency_planning_failed') {
    const detail = formatQueuePlannerDetail(queueFailurePlanner(queueHealth));
    return detail ? `${degradationReason} (${detail})` : degradationReason;
  }
  return stringField(diagnostics?.stderrExcerpt)
    ?? stringField(queueHealth.underlyingReason)
    ?? null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function objectField(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}
