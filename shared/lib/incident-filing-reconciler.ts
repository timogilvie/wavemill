import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readJobResultFile, classifyJobCompletion, type MillJob } from './job-tracker.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';

export type IncidentFilingReconciliationOutcome = 'confirmed_active' | 'recovered' | 'superseded' | 'needs_inspection';

export interface IncidentFilingReconciliation {
  outcome: IncidentFilingReconciliationOutcome;
  evidence: Record<string, unknown>;
}

export interface WorkflowJob {
  id: string;
  kind: string;
  status: string;
  taskId?: string;
  issueId?: string;
  source: string;
  prNumbers?: number[];
  reason?: string;
  error?: string;
  logPath?: string;
  pairId?: string;
  side?: string;
  startedAt?: string;
  finishedAt?: string;
  resultPath?: string;
}

const JOB_BACKED_CLASSES = new Set([
  'failed_job_no_result',
  'failed_background_job',
  'missing_eval_records_for_comparison',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function taskId(job: Record<string, unknown>): string | undefined {
  return string(job.taskId) ?? string(job.issueId);
}

function toJob(value: unknown, source: string): WorkflowJob | null {
  const job = object(value);
  const id = string(job?.id);
  const kind = string(job?.kind);
  const status = string(job?.status);
  if (!id || !kind || !status) return null;
  return {
    id,
    kind,
    status,
    taskId: taskId(job!) ?? (kind === 'comparison' ? string(job!.pairId) : undefined),
    issueId: taskId(job!),
    source,
    prNumbers: Array.isArray(job!.prNumbers) ? job!.prNumbers as number[] : undefined,
    reason: string(job!.reason),
    error: string(job!.error) ?? string(job!.excerpt),
    logPath: string(job!.logPath),
    pairId: string(job!.pairId) ?? string(job!.challengePairId),
    side: string(job!.side) ?? string(job!.challengeRole) ?? string(job!.role),
    startedAt: string(job!.startedAt),
    finishedAt: string(job!.finishedAt) ?? string(job!.completedAt),
    resultPath: string(job!.resultPath),
  };
}

function parseJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Reads only persisted job state; it deliberately never polls or settles jobs. */
export function readAuthoritativeWorkflowJobs(repoDir: string): { jobs: WorkflowJob[]; error?: string } {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const jobs = new Map<string, WorkflowJob>();
  const errors: string[] = [];
  const add = (value: unknown, source: string) => {
    const job = toJob(value, source);
    if (!job) { errors.push(`malformed workflow job in ${source}`); return; }
    const prior = jobs.get(job.id);
    if (prior && ['status', 'kind', 'taskId', 'pairId', 'side', 'resultPath', 'startedAt', 'finishedAt'].some((key) => prior[key as keyof WorkflowJob] !== job[key as keyof WorkflowJob])) {
      errors.push(`job artifact contradicts workflow state: ${job.id}`);
    } else if (!prior) jobs.set(job.id, job);
  };
  if (existsSync(statePath)) {
    const state = object(parseJson(statePath));
    if (!state) errors.push('workflow state is malformed');
    else if (state.jobs) {
      if (typeof state.jobs !== 'object') errors.push('workflow jobs are malformed');
      else for (const job of Object.values(state.jobs)) add(job, statePath);
    }
  }
  const jobsDir = join(repoDir, '.wavemill', 'jobs');
  if (existsSync(jobsDir)) {
    for (const file of readdirSync(jobsDir).filter((name) => name.endsWith('.json') && !name.endsWith('.result.json'))) add(parseJson(join(jobsDir, file)), join(jobsDir, file));
  } else if (!existsSync(statePath)) errors.push('workflow state is missing');
  return { jobs: [...jobs.values()], ...(errors.length ? { error: errors.join('; ') } : {}) };
}

/** Validate the existing job-result contract; filenames never prove success. */
export function workflowJobResultSucceeded(repoDir: string, job: WorkflowJob): boolean | null {
  if (!job.resultPath) return null;
  const path = isAbsolute(job.resultPath) ? job.resultPath : join(repoDir, job.resultPath);
  if (!existsSync(path)) return false;
  const result = readJobResultFile(path);
  if (!result || typeof result.ok !== 'boolean' || !Number.isFinite(result.exitCode) || result.reason === 'invalid_result_file') return null;
  const started = timestamp(job.startedAt);
  if (started === null || statSync(path).mtimeMs < started) return null;
  const lineage = result as unknown as Record<string, unknown>;
  for (const [key, expected] of Object.entries({jobId:job.id,taskId:job.taskId,issueId:job.issueId,pairId:job.pairId,side:job.side})) {
    if (lineage[key] !== undefined && lineage[key] !== expected) return null;
  }
  if (result.ok === true && result.persisted === false) return null;
  if (job.kind === 'eval' && result.persisted !== true) return false;
  if (result.persisted === false) return false;
  return classifyJobCompletion(job as MillJob, result).status === 'succeeded';
}

export function isJobBackedIncident(incident: IncidentRecord): boolean {
  return JOB_BACKED_CLASSES.has(incident.rootCauseClass) || Boolean(incident.metadata.jobId);
}

function sameLineage(job: WorkflowJob, incident: IncidentRecord, expectedKind: string, expectedPair?: string, expectedSide?: string): boolean {
  if (job.taskId !== incident.taskId || job.kind !== expectedKind) return false;
  if (job.pairId !== expectedPair) return false;
  if (job.side !== expectedSide) return false;
  return true;
}

function decision(outcome: IncidentFilingReconciliationOutcome, evidence: Record<string, unknown>): IncidentFilingReconciliation {
  return { outcome, evidence };
}

export function reconcileIncidentForFiling(incident: IncidentRecord, repoDir = process.cwd(), read = readAuthoritativeWorkflowJobs(repoDir)): IncidentFilingReconciliation {
  if (!isJobBackedIncident(incident)) {
    return decision('confirmed_active', { classAware: false, reason: 'not_job_backed' });
  }
  const jobId = string(incident.metadata.jobId);
  const expectedKind = string(incident.metadata.jobKind);
  const expectedPair = string(incident.metadata.pairId);
  const expectedSide = string(incident.metadata.side);
  const failureAt = string(incident.metadata.authoritativeFailureAt) ?? incident.evidence.find((item) => item.type === 'job_state')?.timestamp;
  const failureTime = timestamp(failureAt);
  if (!jobId || !incident.taskId || !expectedKind || failureTime === null || (expectedKind === 'comparison' && !expectedPair)) {
    return decision('needs_inspection', { reason: 'incident lineage is incomplete or malformed', jobId, taskId: incident.taskId, jobKind: expectedKind });
  }

  if (read.error) return decision('needs_inspection', { reason: read.error, jobId });
  const original = read.jobs.filter((job) => job.id === jobId);
  if (original.length !== 1 || !sameLineage(original[0], incident, expectedKind, expectedPair, expectedSide)) {
    return decision('needs_inspection', { reason: 'authoritative job is missing, ambiguous, or has mismatched lineage', jobId, matches: original.length });
  }
  const current = original[0];
  const currentTime = timestamp(current.finishedAt ?? current.startedAt);
  if ((current.finishedAt || current.startedAt) && currentTime === null) {
    return decision('needs_inspection', { reason: 'authoritative job timestamp is malformed', jobId });
  }
  const result = workflowJobResultSucceeded(repoDir, current);
  if (current.status === 'succeeded') {
    if (currentTime === null || currentTime < failureTime || result !== true) {
      return decision('needs_inspection', { reason: 'successful job has insufficient or contradictory result evidence', jobId, successfulResult: result });
    }
    return decision('recovered', { jobId, status: current.status, completedAt: current.finishedAt, successfulResult: result });
  }
  if (current.status !== 'failed' && current.status !== 'timeout') {
    return decision('needs_inspection', { reason: 'authoritative job has non-terminal status', jobId, status: current.status });
  }

  const newerSuccess = read.jobs.find((job) => job.id !== jobId
    && job.status === 'succeeded'
    && JSON.stringify(job.prNumbers) === JSON.stringify(current.prNumbers)
    && sameLineage(job, incident, expectedKind, expectedPair, expectedSide)
    && timestamp(job.finishedAt ?? job.startedAt) !== null
    && timestamp(job.finishedAt ?? job.startedAt)! > failureTime
    && timestamp(job.startedAt) !== null
    && timestamp(job.startedAt)! >= failureTime
    && workflowJobResultSucceeded(repoDir, job) === true);
  if (newerSuccess) {
    return decision('superseded', { jobId, supersedingJobId: newerSuccess.id, supersedingFinishedAt: newerSuccess.finishedAt, taskId: incident.taskId });
  }
  if (result === true || result === null) return decision('needs_inspection', { jobId, status: current.status, reason: 'failed job has contradictory or malformed result evidence' });
  return decision('confirmed_active', { jobId, status: current.status, successfulResult: result, taskId: incident.taskId });
}
