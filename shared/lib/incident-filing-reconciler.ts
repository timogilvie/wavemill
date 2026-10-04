import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { IncidentRecord } from './wavemill-incident-model.ts';

export type IncidentFilingReconciliationOutcome = 'confirmed_active' | 'recovered' | 'superseded' | 'needs_inspection';

export interface IncidentFilingReconciliation {
  outcome: IncidentFilingReconciliationOutcome;
  evidence: Record<string, unknown>;
}

interface WorkflowJob {
  id: string;
  kind: string;
  status: string;
  taskId?: string;
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

function toJob(value: unknown): WorkflowJob | null {
  const job = object(value);
  const id = string(job?.id);
  const kind = string(job?.kind);
  const status = string(job?.status);
  if (!id || !kind || !status) return null;
  return {
    id,
    kind,
    status,
    taskId: taskId(job!),
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
  if (!existsSync(statePath)) return { jobs: [], error: 'workflow state is missing' };
  const state = object(parseJson(statePath));
  if (!state) return { jobs: [], error: 'workflow state is malformed' };
  const rawJobs = state.jobs;
  if (!rawJobs || (typeof rawJobs !== 'object')) return { jobs: [], error: 'workflow jobs are missing' };
  const entries = Array.isArray(rawJobs) ? rawJobs : Object.values(rawJobs as Record<string, unknown>);
  const jobs: WorkflowJob[] = [];
  for (const entry of entries) {
    const job = toJob(entry);
    if (!job) return { jobs: [], error: 'workflow job is malformed' };
    jobs.push(job);
  }
  // Job artifacts are a second persisted source used by the detector. They
  // are read here solely to reject contradictory state, never to poll jobs.
  const jobsDir = join(repoDir, '.wavemill', 'jobs');
  if (existsSync(jobsDir)) {
    for (const file of readdirSync(jobsDir).filter((name) => name.endsWith('.json'))) {
      const job = toJob(parseJson(join(jobsDir, file)));
      if (!job) return { jobs: [], error: `job artifact is malformed: ${file}` };
      const duplicate = jobs.find((candidate) => candidate.id === job.id);
      if (duplicate) {
        if (duplicate.status !== job.status || duplicate.kind !== job.kind || duplicate.taskId !== job.taskId || duplicate.pairId !== job.pairId) {
          return { jobs: [], error: `job artifact contradicts workflow state: ${job.id}` };
        }
      } else {
        jobs.push(job);
      }
    }
  }
  return { jobs };
}

function resultExists(repoDir: string, resultPath: string | undefined): boolean | null {
  if (!resultPath) return null;
  return existsSync(isAbsolute(resultPath) ? resultPath : join(repoDir, resultPath));
}

function sameLineage(job: WorkflowJob, incident: IncidentRecord, expectedKind: string, expectedPair?: string, expectedSide?: string): boolean {
  if (job.taskId !== incident.taskId || job.kind !== expectedKind) return false;
  if (expectedPair && job.pairId !== expectedPair) return false;
  if (expectedSide && job.side !== expectedSide) return false;
  return true;
}

function decision(outcome: IncidentFilingReconciliationOutcome, evidence: Record<string, unknown>): IncidentFilingReconciliation {
  return { outcome, evidence };
}

export function reconcileIncidentForFiling(incident: IncidentRecord, repoDir = process.cwd()): IncidentFilingReconciliation {
  if (!JOB_BACKED_CLASSES.has(incident.rootCauseClass)) {
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

  const read = readAuthoritativeWorkflowJobs(repoDir);
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
  const result = resultExists(repoDir, current.resultPath ?? string(incident.metadata.resultPath));
  if (current.status === 'succeeded') {
    if (currentTime === null || currentTime < failureTime || result === false) {
      return decision('needs_inspection', { reason: 'successful job has insufficient or contradictory result evidence', jobId, resultExists: result });
    }
    return decision('recovered', { jobId, status: current.status, completedAt: current.finishedAt, resultExists: result });
  }
  if (current.status !== 'failed' && current.status !== 'timeout') {
    return decision('needs_inspection', { reason: 'authoritative job has non-terminal status', jobId, status: current.status });
  }
  if (result === true) {
    return decision('recovered', { jobId, status: current.status, resultExists: true });
  }
  if (result === null && incident.rootCauseClass !== 'failed_background_job') {
    return decision('needs_inspection', { reason: 'result path is missing for result-backed incident', jobId });
  }

  const newerSuccess = read.jobs.find((job) => job.id !== jobId
    && job.status === 'succeeded'
    && sameLineage(job, incident, expectedKind, expectedPair, expectedSide)
    && timestamp(job.finishedAt ?? job.startedAt) !== null
    && timestamp(job.finishedAt ?? job.startedAt)! > failureTime
    && resultExists(repoDir, job.resultPath) === true);
  if (newerSuccess) {
    return decision('superseded', { jobId, supersedingJobId: newerSuccess.id, supersedingFinishedAt: newerSuccess.finishedAt, taskId: incident.taskId });
  }
  return decision('confirmed_active', { jobId, status: current.status, resultExists: result, taskId: incident.taskId });
}
