import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { normalizeJobs, type JobResultFile, type MillJob, type WorkflowStateLike } from './job-tracker.ts';
import type { IncidentRecord, IncidentRootCauseClass } from './wavemill-incident-model.ts';

export type IncidentFilingReconciliationStatus =
  | 'confirmed_active'
  | 'recovered'
  | 'superseded'
  | 'needs_inspection';

export interface IncidentFilingReconciliationEvidence {
  reason: string;
  jobId?: string;
  jobStatus?: string;
  jobFinishedAt?: string | null;
  resultPath?: string;
  resultExists?: boolean;
  resultPersisted?: boolean;
  supersedingJobId?: string;
  supersedingJobFinishedAt?: string | null;
}

export interface IncidentFilingReconciliation {
  status: IncidentFilingReconciliationStatus;
  evidence: IncidentFilingReconciliationEvidence;
}

export interface IncidentFilingTruthReader {
  readWorkflowState(repoDir: string): WorkflowStateLike | null;
  readJobArtifacts(repoDir: string): MillJob[];
  readResult(path: string): JobResultFile | null;
  resultExists(path: string): boolean;
}

export interface IncidentFilingReconcilerOptions {
  repoDir?: string;
  reader?: IncidentFilingTruthReader;
}

const JOB_BACKED_CLASSES = new Set<IncidentRootCauseClass>([
  'failed_job_no_result',
  'failed_background_job',
  'missing_eval_records_for_comparison',
]);

export function reconcileIncidentFiling(
  incident: IncidentRecord,
  options: IncidentFilingReconcilerOptions = {},
): IncidentFilingReconciliation {
  if (!JOB_BACKED_CLASSES.has(incident.rootCauseClass)) {
    return { status: 'confirmed_active', evidence: { reason: 'incident class is not job-backed' } };
  }

  const repoDir = options.repoDir;
  if (!repoDir) {
    return { status: 'needs_inspection', evidence: { reason: 'repoDir unavailable for job-backed reconciliation' } };
  }

  const reader = options.reader ?? DEFAULT_INCIDENT_FILING_TRUTH_READER;
  const jobId = stringField(incident.metadata?.jobId);
  if (!jobId) {
    return { status: 'needs_inspection', evidence: { reason: 'incident metadata is missing jobId' } };
  }

  let jobs: Record<string, MillJob>;
  try {
    const state = reader.readWorkflowState(repoDir);
    const artifactJobs = reader.readJobArtifacts(repoDir);
    jobs = {
      ...Object.fromEntries(artifactJobs.map((job) => [job.id, job])),
      ...(state ? normalizeJobs(state) : {}),
    };
  } catch (error) {
    return {
      status: 'needs_inspection',
      evidence: { reason: `could not read job truth: ${error instanceof Error ? error.message : String(error)}`, jobId },
    };
  }

  const job = jobs[jobId];
  if (!job || !wellFormedJob(job)) {
    return { status: 'needs_inspection', evidence: { reason: 'referenced job missing or malformed', jobId } };
  }

  const lineage = incidentLineage(incident, job);
  if (!lineage.ok) {
    return {
      status: 'needs_inspection',
      evidence: { reason: lineage.reason, jobId, jobStatus: job.status, jobFinishedAt: job.finishedAt },
    };
  }

  const current = classifyCurrentJob(job, reader);
  if (current === 'recovered') {
    return {
      status: 'recovered',
      evidence: evidenceForJob('referenced job now succeeded with persisted result', job, reader),
    };
  }
  if (current === 'needs_inspection') {
    return {
      status: 'needs_inspection',
      evidence: evidenceForJob('referenced job truth is ambiguous', job, reader),
    };
  }

  const superseding = Object.values(jobs)
    .filter((candidate) => candidate.id !== job.id && sameLineage(candidate, job))
    .filter((candidate) => isLater(candidate, job))
    .filter((candidate) => classifyCurrentJob(candidate, reader) === 'recovered')
    .sort((a, b) => Date.parse(b.finishedAt ?? '') - Date.parse(a.finishedAt ?? ''))[0];

  if (superseding) {
    return {
      status: 'superseded',
      evidence: {
        ...evidenceForJob('newer same-lineage job succeeded with persisted result', job, reader),
        supersedingJobId: superseding.id,
        supersedingJobFinishedAt: superseding.finishedAt,
      },
    };
  }

  if (job.status === 'failed' || job.status === 'timeout' || job.status === 'running') {
    return {
      status: 'confirmed_active',
      evidence: evidenceForJob('referenced job is still failed, timed out, or running without newer success', job, reader),
    };
  }

  return {
    status: 'needs_inspection',
    evidence: evidenceForJob(`unexpected referenced job status ${job.status}`, job, reader),
  };
}

export const DEFAULT_INCIDENT_FILING_TRUTH_READER: IncidentFilingTruthReader = {
  readWorkflowState(repoDir) {
    const path = join(repoDir, '.wavemill', 'workflow-state.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowStateLike;
  },
  readJobArtifacts(repoDir) {
    const jobsDir = join(repoDir, '.wavemill', 'jobs');
    if (!existsSync(jobsDir)) return [];
    return readdirSync(jobsDir)
      .filter((entry) => entry.endsWith('.json'))
      .flatMap((entry) => {
        const source = join(jobsDir, entry);
        try {
          const parsed = JSON.parse(readFileSync(source, 'utf-8')) as MillJob;
          return parsed?.id ? [parsed] : [];
        } catch {
          return [];
        }
      });
  },
  readResult(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as JobResultFile;
    } catch {
      return null;
    }
  },
  resultExists(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function wellFormedJob(job: MillJob): boolean {
  return Boolean(job.id)
    && (job.kind === 'eval' || job.kind === 'comparison')
    && typeof job.status === 'string'
    && typeof job.resultPath === 'string'
    && job.resultPath.length > 0;
}

function incidentLineage(incident: IncidentRecord, job: MillJob): { ok: true } | { ok: false; reason: string } {
  const metadataKind = stringField(incident.metadata?.jobKind);
  if (metadataKind && metadataKind !== job.kind) return { ok: false, reason: 'incident jobKind does not match current job' };
  const incidentTask = incident.taskId ?? undefined;
  const jobTask = jobSubjectTaskId(job);
  if (incidentTask && jobTask !== incidentTask) return { ok: false, reason: 'incident task does not match current job task' };
  const metadataResultPath = stringField(incident.metadata?.resultPath);
  if (metadataResultPath && job.resultPath && metadataResultPath !== job.resultPath) {
    const sameAbsPath = isAbsolute(metadataResultPath) && isAbsolute(job.resultPath) && metadataResultPath === job.resultPath;
    if (!sameAbsPath) return { ok: false, reason: 'incident resultPath does not match current job' };
  }
  return { ok: true };
}

function jobSubjectTaskId(job: Pick<MillJob, 'kind' | 'issueId' | 'pairId'>): string | undefined {
  if (job.kind === 'eval') return job.issueId;
  const match = job.pairId?.match(/HOK-\d+(?:_[a-z])?/i) ?? job.issueId?.match(/HOK-\d+(?:_[a-z])?/i);
  return match?.[0];
}

function classifyCurrentJob(job: MillJob, reader: IncidentFilingTruthReader): 'recovered' | 'active' | 'needs_inspection' {
  const resultExists = reader.resultExists(job.resultPath);
  const result = resultExists ? reader.readResult(job.resultPath) : null;
  if (job.status === 'succeeded') {
    if (!resultExists || !result) return 'needs_inspection';
    return result.ok === true || result.persisted === true ? 'recovered' : 'needs_inspection';
  }
  if ((job.status === 'failed' || job.status === 'timeout') && resultExists && result && (result.ok === true || result.persisted === true)) {
    return 'needs_inspection';
  }
  return 'active';
}

function resultPersisted(job: MillJob, reader: IncidentFilingTruthReader): boolean | undefined {
  if (!reader.resultExists(job.resultPath)) return false;
  const result = reader.readResult(job.resultPath);
  if (!result) return undefined;
  return result.ok === true || result.persisted === true;
}

function evidenceForJob(reason: string, job: MillJob, reader: IncidentFilingTruthReader): IncidentFilingReconciliationEvidence {
  return {
    reason,
    jobId: job.id,
    jobStatus: job.status,
    jobFinishedAt: job.finishedAt,
    resultPath: job.resultPath,
    resultExists: reader.resultExists(job.resultPath),
    resultPersisted: resultPersisted(job, reader),
  };
}

function sameLineage(candidate: MillJob, failed: MillJob): boolean {
  if (candidate.kind !== failed.kind) return false;
  if (candidate.kind === 'eval') {
    return candidate.issueId === failed.issueId && candidate.side === failed.side;
  }
  return candidate.pairId === failed.pairId;
}

function isLater(candidate: MillJob, failed: MillJob): boolean {
  const candidateTime = Date.parse(candidate.finishedAt ?? candidate.startedAt ?? '');
  const failedTime = Date.parse(failed.finishedAt ?? failed.startedAt ?? '');
  return Number.isFinite(candidateTime) && Number.isFinite(failedTime) && candidateTime > failedTime;
}
