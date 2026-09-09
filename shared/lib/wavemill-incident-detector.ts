import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  readChallengePairState,
  type ChallengePairStateDiagnostic,
  readEvalFallbackEventsDiagnostic,
  readHookStatus,
  readJobState,
  type JobStateDiagnostic,
  readPlanningResult,
  readPrIdentity,
  type PrIdentityDiagnostic,
  readQuotaSnapshotDiagnostic,
  type ReviewResultDiagnostic,
  readReviewResultDiagnostic,
  redactIncidentData,
} from './artifact-diagnostics.ts';
import {
  canonicalizeRootCauseClass,
  createIncidentDraft,
  isRemoteRootCauseClass,
  type IncidentEvidence,
  type IncidentCategory,
  type IncidentRecord,
  type IncidentRootCauseClass,
  type RemediationForbiddenAction,
  type RemediationProposal,
} from './wavemill-incident-model.ts';

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
}

export class PlanningFailureDetector {
  detect(taskPath: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const resultPath = join(taskPath, '.planning-result.json');
    const result = readPlanningResult(resultPath);
    if (!result || result.error || result.status !== 'failed' || !result.failureReason) return [];
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
      rootCauseClass: normalizedReason,
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
      const rootCauseClass = missingEvalEvidence ? 'missing_eval_records_for_comparison' : missingResult ? 'failed_job_no_result' : 'failed_background_job';
      incidents.push(createIncidentDraft({
        taskId: subjectTaskId,
        session: context.session ?? null,
        category: rootCauseClass === 'failed_background_job' ? 'product_defect' : 'stale_orphaned_state',
        severity: 'medium',
        confidence: 'definite',
        lifecycle: 'observed',
        rootCauseClass,
        summary: `${job.kind ?? 'background'} job ${job.id ?? '(unknown)'} ended ${job.status}.`,
        operatorAction: missingEvalEvidence
          ? 'Inspect eval-record production for the compared pair and retry comparison only after records exist.'
          : 'Review the managed job result/log evidence and retry or settle the orphaned job through the controller.',
        evidence: [{
          type: 'job_state',
          source: job.source,
          // Terminal event time, not poll time: an un-reaped historical failure
          // must not register a fresh occurrence every observer cycle.
          timestamp: job.finishedAt ?? job.startedAt ?? timestamp,
          redactedData: redactIncidentData(`id=${job.id ?? 'unknown'} kind=${job.kind ?? 'unknown'} status=${job.status} reason=${job.reason ?? 'unknown'} resultMissing=${missingResult}`),
          key: rootCauseClass,
        }],
        metadata: { jobId: job.id, jobKind: job.kind, resultPath: job.resultPath, logPath: job.logPath },
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
      const diagnostic = diagnosticReason(queueHealth) ?? reason;
      const failureCount = numberField(queueHealth.failureCount) ?? 1;
      const classified = canonicalizeRootCauseClass(diagnostic);
      // An unclassifiable degradation diagnostic is still a known local
      // condition of the queue planner, not free text.
      const rootCauseClass = classified === 'unclassified_local_failure' ? 'queue_planner_degraded' : classified;
      incidents.push(createIncidentDraft({
        taskId: null,
        session: context.session ?? null,
        category: dependencyCategoryFor(rootCauseClass),
        severity: failureCount >= threshold ? 'medium' : 'low',
        confidence: failureCount >= threshold ? 'high' : 'medium',
        lifecycle: 'observed',
        rootCauseClass,
        summary: `Queue planner fallback is active: ${reason}.`,
        operatorAction: 'Inspect queue-health diagnostics and dependency planner inputs; fallback is acceptable briefly but should not persist.',
        evidence: [{
          type: 'backstage_health',
          source: queueHealthPath,
          timestamp: stringField(queueHealth.lastAttemptAt) ?? stringField(queueHealth.updatedAt) ?? timestamp,
          redactedData: redactIncidentData(`reason=${reason} diagnostic=${diagnostic} failureCount=${failureCount}`),
          key: 'queue_planner_fallback',
        }],
        metadata: { threshold, failureCount, diagnosticReason: diagnostic },
      }));
    }

    const backstageHealthPath = join(repoDir, '.wavemill', 'backstage-health.json');
    const backstageHealth = readObjectFile(backstageHealthPath);
    const services = objectField(backstageHealth?.services);
    if (services) {
      for (const [serviceName, service] of Object.entries(services)) {
        const detail = `${stringField(service.detail) ?? ''} ${stringField(service.lastError) ?? ''}`;
        const failureCount = numberField(service.failureCount) ?? numberField(service.restartAttemptCount) ?? 0;
        if (failureCount < threshold || !/\b(remote|ssh|github|dependency|probe)\b/i.test(detail)) continue;
        const serviceRootCause = canonicalizeRootCauseClass(detail);
        const serviceRemote = isRemoteRootCauseClass(serviceRootCause);
        incidents.push(createIncidentDraft({
          taskId: null,
          session: context.session ?? null,
          category: dependencyCategoryFor(serviceRootCause),
          severity: 'medium',
          confidence: 'high',
          lifecycle: 'observed',
          rootCauseClass: serviceRootCause,
          summary: serviceRemote
            ? `${serviceName} dependency health is degraded by repeated probe failures.`
            : `${serviceName} health is degraded by repeated local failures (${serviceRootCause}).`,
          operatorAction: 'Check the external dependency and credentials before treating this as a Wavemill product defect.',
          evidence: [{
            type: 'backstage_health',
            source: backstageHealthPath,
            timestamp: stringField(service.updatedAt) ?? timestamp,
            redactedData: redactIncidentData(`service=${serviceName} failureCount=${failureCount} detail=${detail}`),
            key: 'degraded_dependency_health',
          }],
          metadata: { threshold, failureCount, serviceName },
        }));
      }
    }

    return incidents;
  }
}

const STALLED_MARKER_KINDS = new Set(['merge-lane-idle-stall', 'merge-lane-idle-stalled']);
const CONTEXT_FAILURE_CATEGORIES = new Set([
  'context-window-exceeded',
  'native-context-window-exceeded',
  'review-scope-unverifiable',
]);
const PROVIDER_QUOTA_FAILURE_CATEGORIES = new Set([
  'provider-quota-exhausted',
  'provider-credit-exhausted',
  'quota-exhausted',
  'credit-exhausted',
]);
const FORBIDDEN_REMEDIATION_ACTIONS: RemediationForbiddenAction[] = [
  'add_ready_label',
  'merge',
  'destructive_git',
  'delete_branch',
];

export class StalledLifecycleCorrelator {
  detect(repoDir: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const candidates = (context.tendCandidates ?? [])
      .filter((candidate) => candidate.pr && STALLED_MARKER_KINDS.has(candidate.markerKind ?? ''));
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const prNumber = candidate.pr;
      if (!prNumber) continue;
      const taskId = candidate.taskId ?? extractIssueId(candidate.headBranch) ?? null;
      const taskDir = taskId ? resolveTaskArtifactDir(repoDir, taskId) : null;
      const review = taskDir ? readReviewResultDiagnostic(taskDir) : null;
      const pr = readPrIdentity(prNumber, repoDir);
      const pairState = readPairStateForTask(repoDir, taskDir, taskId);
      const pairId = candidate.pairId ?? pairState?.pairId;
      const key = `${taskId ?? 'repo'}:${prNumber}:${pairId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const recovered = pairId && comparisonSucceededForPair(repoDir, pairId);
      if (recovered) continue;

      if (pr && review && qualifiesStaleBaseOverflow(review, pr)) {
        incidents.push(this.staleBaseOverflowIncident({
          repoDir,
          taskId,
          candidate,
          pr,
          review,
          timestamp,
        }));
        continue;
      }

      const contradiction = pr && review && isContextFailure(review)
        && !qualifiesStaleBaseOverflow(review, pr);
      if (contradiction || !pr || !review || (candidate.pairId && !pairState)) {
        incidents.push(this.inspectionIncident({
          repoDir,
          taskId,
          candidate,
          pr,
          review,
          pairStateSource: pairState?.source,
          timestamp,
          reason: contradiction ? 'contradictory_context_scope_evidence' : 'missing_authoritative_evidence',
        }));
        continue;
      }

      const quota = readQuotaSnapshotDiagnostic(repoDir);
      const fallbackEvents = readEvalFallbackEventsDiagnostic(repoDir, review.reviewedAtIso);
      if (pairId && qualifiesProviderQuotaChallenge(repoDir, candidate, pr, review, pairId, quota, fallbackEvents)) {
        incidents.push(this.providerQuotaIncident({
          repoDir,
          taskId,
          candidate,
          pr,
          review,
          pairId,
          quota,
          fallbackSource: fallbackEvents[0]?.source,
          timestamp,
        }));
      }
    }
    return incidents;
  }

  private staleBaseOverflowIncident(input: {
    repoDir: string;
    taskId: string | null;
    candidate: TendCandidateDiagnostic;
    pr: PrIdentityDiagnostic;
    review: ReviewResultDiagnostic;
    timestamp: string;
  }): IncidentRecord {
    const evidence = [
      prEvidence(input.pr, input.timestamp),
      reviewEvidence(input.review, input.timestamp),
      tendEvidence(input.candidate, input.repoDir, input.timestamp),
    ];
    const proposal = remediationProposal({
      kind: 'refresh_base_and_rereview',
      retryKey: `refresh-base-rereview:pr:${input.pr.number}:head:${input.pr.headSha ?? 'unknown'}`,
      safetyLevel: 'operator_only',
      prerequisites: [
        'Confirm the PR still targets the expected integration base.',
        'Refresh the branch base through the normal workflow path.',
        'Run review again against the current head before any Ready action.',
      ],
      evidence,
      recoveryPredicate: {
        kind: 'review_now_ready',
        details: {
          pr: String(input.pr.number),
          head: input.pr.headSha ?? 'unknown',
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
      summary: `PR #${input.pr.number} review failed from context overflow on a stale base/head scope.`,
      operatorAction: 'Refresh the PR base and rerun review; do not add Ready, merge, rewrite destructively, or delete the branch from this proposal.',
      evidence,
      metadata: {
        proposal,
        prNumber: input.pr.number,
        tendGate: input.candidate.firstBlockedGate ?? input.candidate.blockedReason,
        failureCategory: input.review.failureCategory,
        reviewedHead: input.review.reviewedHead,
        reviewedBase: input.review.reviewedBase,
        authoritativeHead: input.pr.headSha,
        authoritativeBase: input.pr.baseSha,
        reviewedFileCount: input.review.reviewedFileCount,
        authoritativeFileCount: input.pr.changedFileCount,
        artifactPaths: [input.review.source, input.pr.source],
      },
    });
  }

  private providerQuotaIncident(input: {
    repoDir: string;
    taskId: string | null;
    candidate: TendCandidateDiagnostic;
    pr: PrIdentityDiagnostic;
    review: ReviewResultDiagnostic;
    pairId: string;
    quota: ReturnType<typeof readQuotaSnapshotDiagnostic>;
    fallbackSource?: string;
    timestamp: string;
  }): IncidentRecord {
    const evidence = [
      prEvidence(input.pr, input.timestamp),
      reviewEvidence(input.review, input.timestamp),
      tendEvidence(input.candidate, input.repoDir, input.timestamp),
      {
        type: 'challenge_pair_state' as const,
        source: join(input.repoDir, '.wavemill', 'workflow-state.json'),
        timestamp: input.timestamp,
        redactedData: redactIncidentData(`pairId=${input.pairId} comparison=missing currentHeadEval=missing`),
        key: `pair:${input.pairId}`,
      },
      ...(input.quota ? [{
        type: 'quota_state' as const,
        source: input.quota.source,
        timestamp: input.quota.lastLimitErrorAtIso ?? input.timestamp,
        redactedData: redactIncidentData(`exhaustedProviders=${input.quota.exhaustedProviders.join(',')} exhaustedModels=${input.quota.exhaustedModels.length}`),
        key: `quota:${input.quota.exhaustedProviders.join(',') || 'exhausted'}`,
      }] : []),
      ...(input.fallbackSource ? [{
        type: 'eval_fallback_event' as const,
        source: input.fallbackSource,
        timestamp: input.timestamp,
        redactedData: redactIncidentData(`pairId=${input.pairId} outcome=all_exhausted`),
        key: `fallback:${input.pairId}`,
      }] : []),
    ];
    const chain = [
      { cause: 'provider_quota_failure', evidenceIndex: evidence.findIndex((item) => item.type === 'quota_state' || item.type === 'eval_fallback_event'), detail: 'Provider quota/credit exhaustion blocked the failed arm.' },
      { cause: 'review_not_ready', evidenceIndex: 1, detail: input.review.failureCategory ?? input.review.verdict },
      { cause: 'no_ready_label', evidenceIndex: 0, detail: 'Current PR labels do not include wm:ready.' },
      { cause: 'no_current_head_eval', evidenceIndex: 3, detail: 'No eval record matches the failed arm and current PR head.' },
      { cause: 'no_comparison', evidenceIndex: 3, detail: 'No successful comparison job exists for the pair.' },
    ].map((entry) => ({ ...entry, evidenceIndex: entry.evidenceIndex < 0 ? 3 : entry.evidenceIndex }));
    const proposal = remediationProposal({
      kind: 'provider_retry_or_forfeit_inspection',
      retryKey: `provider-retry-or-forfeit:${input.pairId}:pr:${input.pr.number}:head:${input.pr.headSha ?? 'unknown'}`,
      safetyLevel: 'operator_only',
      prerequisites: [
        'Inspect provider quota/credit state for the failed arm.',
        'Retry review/eval only after provider capacity is restored, or explicitly forfeit the blocked arm.',
        'Require current-head eval evidence before comparison recovery.',
      ],
      evidence,
      recoveryPredicate: {
        kind: 'current_head_eval_present',
        details: {
          pairId: input.pairId,
          pr: String(input.pr.number),
          head: input.pr.headSha ?? 'unknown',
        },
      },
    });
    return createIncidentDraft({
      taskId: input.taskId,
      session: null,
      category: 'external_transient_dependency',
      severity: 'high',
      confidence: 'high',
      lifecycle: 'observed',
      rootCauseClass: 'provider_quota_exhaustion_blocking_review',
      summary: `Challenge pair ${input.pairId} is blocked by provider quota failure on PR #${input.pr.number}.`,
      operatorAction: 'Inspect provider quota and retry or forfeit through the normal challenge workflow; do not add Ready or force comparison/merge from this proposal.',
      evidence,
      metadata: {
        proposal,
        causalChain: chain,
        pairId: input.pairId,
        failedPr: input.pr.number,
        failedTaskId: input.taskId,
        authoritativeHead: input.pr.headSha,
        authoritativeBase: input.pr.baseSha,
        failureCategory: input.review.failureCategory,
      },
    });
  }

  private inspectionIncident(input: {
    repoDir: string;
    taskId: string | null;
    candidate: TendCandidateDiagnostic;
    pr: PrIdentityDiagnostic | null;
    review: ReviewResultDiagnostic | null;
    pairStateSource?: string;
    timestamp: string;
    reason: string;
  }): IncidentRecord {
    const evidence = [
      ...(input.pr ? [prEvidence(input.pr, input.timestamp)] : []),
      ...(input.review ? [reviewEvidence(input.review, input.timestamp)] : []),
      tendEvidence(input.candidate, input.repoDir, input.timestamp),
      ...(input.pairStateSource ? [{
        type: 'challenge_pair_state' as const,
        source: input.pairStateSource,
        timestamp: input.timestamp,
        redactedData: redactIncidentData(`pairId=${input.candidate.pairId ?? 'unknown'}`),
        key: `pair:${input.candidate.pairId ?? 'unknown'}`,
      }] : []),
    ];
    const proposal = remediationProposal({
      kind: 'inspection_only',
      retryKey: `inspection:${input.candidate.pr ?? 'unknown'}:${input.reason}`,
      safetyLevel: 'inspect',
      prerequisites: [
        'Inspect PR metadata, review result, pair state, and eval/comparison artifacts before choosing a recovery.',
      ],
      evidence,
    });
    return createIncidentDraft({
      taskId: input.taskId,
      session: null,
      category: 'configuration_operator_condition',
      severity: 'medium',
      confidence: 'low',
      lifecycle: 'observed',
      rootCauseClass: 'inspection_required',
      summary: `PR #${input.candidate.pr ?? 'unknown'} stalled lifecycle evidence is incomplete or contradictory.`,
      operatorAction: 'Inspect authoritative PR and stage artifacts manually; missing/conflicting evidence is not enough to diagnose stale base or provider failure.',
      evidence,
      metadata: {
        proposal,
        inspectionReason: input.reason,
        authoritativeHead: input.pr?.headSha,
        authoritativeBase: input.pr?.baseSha,
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
  ];
}

function normalizePlanningReason(reason: string): string {
  if (reason === 'invalid_or_empty_final_plan') return 'invalid_plan';
  if (reason === 'empty_plan') return 'empty_final_plan';
  return reason.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
}

function qualifiesStaleBaseOverflow(review: ReviewResultDiagnostic, pr: PrIdentityDiagnostic): boolean {
  if (!isContextFailure(review)) return false;
  const reviewedFileCount = review.reviewedFileCount;
  const authoritativeFileCount = pr.changedFileCount;
  if (reviewedFileCount === undefined || authoritativeFileCount === undefined) return false;
  if (!scopeDiffers(review, pr)) return false;
  return authoritativeFileCount < reviewedFileCount * 0.75
    && authoritativeFileCount < reviewedFileCount - 5;
}

function isContextFailure(review: ReviewResultDiagnostic): boolean {
  const category = review.failureCategory ?? '';
  if (!CONTEXT_FAILURE_CATEGORIES.has(category)) return false;
  if (category !== 'review-scope-unverifiable') return true;
  return /context|window|token|length|scope/i.test(`${review.failureCategory ?? ''} ${review.verdict ?? ''}`);
}

function scopeDiffers(review: ReviewResultDiagnostic, pr: PrIdentityDiagnostic): boolean {
  if (!review.reviewedBase) return true;
  if (review.reviewedBase !== pr.baseSha) return true;
  if (review.reviewedHead && review.reviewedHead !== pr.headSha) return true;
  return false;
}

function qualifiesProviderQuotaChallenge(
  repoDir: string,
  candidate: TendCandidateDiagnostic,
  pr: PrIdentityDiagnostic,
  review: ReviewResultDiagnostic,
  pairId: string,
  quota: ReturnType<typeof readQuotaSnapshotDiagnostic>,
  fallbackEvents: ReturnType<typeof readEvalFallbackEventsDiagnostic>,
): boolean {
  if (!bothChallengeArmsVisible(repoDir, pairId)) return false;
  const reviewFailed = review.verdict === 'not_ready'
    || review.verdict === 'failed'
    || PROVIDER_QUOTA_FAILURE_CATEGORIES.has(review.failureCategory ?? '')
    || /quota|credit|402|provider/i.test(review.failureCategory ?? '');
  if (!reviewFailed) return false;
  const providerFailed = Boolean(quota && (quota.exhaustedProviders.length > 0 || quota.exhaustedModels.length > 0))
    || fallbackEvents.some((event) =>
      event.challengePairId === pairId
      || event.issueId === candidate.taskId
      || event.taskType === 'review'
    );
  if (!providerFailed) return false;
  if (pr.labels.includes('wm:ready')) return false;
  if (comparisonSucceededForPair(repoDir, pairId)) return false;
  if (currentHeadEvalPresent(repoDir, candidate.taskId, pairId, pr.headSha)) return false;
  return true;
}

function remediationProposal(input: {
  kind: RemediationProposal['kind'];
  prerequisites: string[];
  retryKey: string;
  safetyLevel: RemediationProposal['safetyLevel'];
  evidence: IncidentEvidence[];
  recoveryPredicate?: RemediationProposal['recoveryPredicate'];
}): RemediationProposal {
  return {
    schemaVersion: '1.1',
    kind: input.kind,
    prerequisites: input.prerequisites.slice(0, 10),
    retryKey: input.retryKey,
    safetyLevel: input.safetyLevel,
    evidenceRefs: input.evidence.map((evidence, index) => ({
      index,
      type: evidence.type,
      source: evidence.source,
    })),
    forbiddenActions: FORBIDDEN_REMEDIATION_ACTIONS,
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
    timestamp: review.reviewedAtIso ?? timestamp,
    redactedData: redactIncidentData(`verdict=${review.verdict ?? 'unknown'} failureCategory=${review.failureCategory ?? 'unknown'} reviewedHead=${review.reviewedHead ?? 'unknown'} reviewedBase=${review.reviewedBase ?? 'unknown'} reviewedFiles=${review.reviewedFileCount ?? 'unknown'}`),
    key: `review:${review.failureCategory ?? 'unknown'}:head:${review.reviewedHead ?? 'unknown'}:base:${review.reviewedBase ?? 'unknown'}:files:${review.reviewedFileCount ?? 'unknown'}`,
  };
}

function tendEvidence(candidate: TendCandidateDiagnostic, repoDir: string, timestamp: string): IncidentEvidence {
  return {
    type: 'log_excerpt',
    source: join(repoDir, '.wavemill', 'observer-findings.jsonl'),
    timestamp,
    redactedData: redactIncidentData(`markerKind=${candidate.markerKind ?? 'unknown'} pr=${candidate.pr ?? 'unknown'} task=${candidate.taskId ?? 'unknown'} gate=${candidate.firstBlockedGate ?? candidate.blockedReason ?? 'unknown'}`),
    key: `tend:${candidate.markerKind ?? 'unknown'}:pr:${candidate.pr ?? 'unknown'}:gate:${candidate.firstBlockedGate ?? candidate.blockedReason ?? 'unknown'}`,
  };
}

function resolveTaskArtifactDir(repoDir: string, taskId: string): string | null {
  const workflowState = readObjectFile(join(repoDir, '.wavemill', 'workflow-state.json'));
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

function bothChallengeArmsVisible(repoDir: string, pairId: string): boolean {
  const arms = new Set<string>();
  const workflowState = readObjectFile(join(repoDir, '.wavemill', 'workflow-state.json'));
  const tasks = objectField(workflowState?.tasks);
  for (const task of Object.values(tasks ?? {})) {
    const entry = objectField(task);
    if (!entry) continue;
    if (stringField(entry.challengePairId) !== pairId && stringField(entry.pairId) !== pairId) continue;
    const role = stringField(entry.challengeRole) ?? stringField(entry.role);
    if (role) arms.add(role);
  }
  return arms.has('primary') && arms.has('challenger');
}

function comparisonSucceededForPair(repoDir: string, pairId: string): boolean {
  return readJobs(repoDir).some((job) => {
    if (job.kind !== 'comparison' || job.status !== 'succeeded') return false;
    return [job.pairId, job.id, job.issueId, job.resultPath, job.logPath, job.source]
      .some((value) => value?.includes(pairId));
  });
}

function currentHeadEvalPresent(repoDir: string, taskId: string | undefined, pairId: string, headSha: string | undefined): boolean {
  if (!headSha) return false;
  const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  if (!existsSync(evalsPath)) return false;
  try {
    const lines = readFileSync(evalsPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = objectField(JSON.parse(line) as unknown);
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
  } catch {
    return false;
  }
  return false;
}

function readPairStateForTask(repoDir: string, taskDir: string | null, taskId: string | null): ChallengePairStateDiagnostic | null {
  const fromTaskDir = taskDir ? readChallengePairState(taskDir) : null;
  if (fromTaskDir?.pairId) return fromTaskDir;
  if (!taskId) return fromTaskDir;
  const source = join(repoDir, '.wavemill', 'workflow-state.json');
  const workflowState = readObjectFile(source);
  const task = workflowState ? taskEntry(workflowState, taskId) : null;
  if (!task) return fromTaskDir;
  return {
    pairId: stringField(task.challengePairId) ?? stringField(task.pairId),
    role: stringEnum(task.challengeRole, ['primary', 'challenger'])
      ?? stringEnum(task.role, ['primary', 'challenger']),
    comparisonState: stringField(task.comparisonState),
    comparisonBlockedReason: stringField(task.comparisonBlockedReason),
    comparisonRetryCount: numberField(task.comparisonRetryCount),
    comparisonRetryMaxAttempts: numberField(task.comparisonRetryMaxAttempts),
    comparisonRetryTargetIssue: stringField(task.comparisonRetryTargetIssue),
    comparisonTimedOutSides: Array.isArray(task.comparisonTimedOutSides)
      ? task.comparisonTimedOutSides.filter((side): side is string => typeof side === 'string').slice(0, 10)
      : [],
    manualComparisonArtifactPath: stringField(task.manualComparisonArtifact),
    source,
  };
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
    || rootCauseClass === 'queue_planner_degraded') {
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
  const match = value?.match(/\b[A-Z]+-\d+(?:_c)?\b/);
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
      source: workflowStatePath,
    });
  }
  return jobs;
}

function diagnosticReason(queueHealth: Record<string, unknown>): string | null {
  const diagnostics = objectField(queueHealth.diagnostics);
  return stringField(diagnostics?.structuredReason)
    ?? stringField(diagnostics?.reason)
    ?? stringField(diagnostics?.stderrExcerpt)
    ?? stringField(queueHealth.underlyingReason);
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
