import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import { errorMessage } from './error-utils.ts';
import type { NoComparisonReason } from './challenge-comparison.ts';

/**
 * Check kinds (HOK-3206) move slow ready-path reads off the monitor loop. Their
 * canonical output is a condition-keyed result marker the job writes itself;
 * the tracker only supervises the process (timeout, exit classification).
 */
export const CHECK_JOB_KINDS = ['cross-pr-guard', 'pr-ci-status', 'ready-watchdog', 'route-task'] as const;
export type CheckJobKind = typeof CHECK_JOB_KINDS[number];
export type MillJobKind = 'eval' | 'comparison' | CheckJobKind;

/** Settled check jobs older than this are pruned from workflow state. */
export const CHECK_JOB_RETENTION_MS = 60 * 60 * 1000;

export function isCheckJobKind(kind: string): kind is CheckJobKind {
  return (CHECK_JOB_KINDS as readonly string[]).includes(kind);
}
export type MillJobStatus = 'running' | 'succeeded' | 'failed' | 'timeout';

export interface MillJob {
  id: string;
  kind: MillJobKind;
  session?: string;
  issueId?: string;
  side?: string;
  pairId?: string;
  prNumbers: number[];
  pid: number;
  startedAt: string;
  timeoutSeconds: number;
  logPath: string;
  resultPath: string;
  status: MillJobStatus;
  exitCode: number | null;
  finishedAt: string | null;
  reason: string | null;
  excerpt: string | null;
  settled: boolean;
}

export interface JobResultFile {
  ok: boolean;
  exitCode: number;
  persisted?: boolean;
  reason?: string;
  error?: string;
  quarantinePath?: string;
  comparison?: {
    winner?: 'primary' | 'challenger';
    winnerModel?: string;
    rationale?: string;
    comparisonOutcome?: 'compared' | 'skipped' | 'forfeit' | 'double-forfeit' | 'invalid' | 'inconclusive' | 'invalid_challenge';
    skipReason?: 'identical-routing-dimensions';
    invalidChallenge?: boolean;
    invalidChallengeReason?: string;
    invalidChallengeDetails?: string;
    noComparisonReason?: NoComparisonReason;
    cleanupPolicy?: 'primary-wins-close-challenger';
    primaryModel?: string;
    challengerModel?: string;
    primaryPrUrl?: string;
    challengerPrUrl?: string;
    primaryEvalScore?: number | null;
    challengerEvalScore?: number | null;
    dimensions?: Record<string, unknown>;
  };
  invalidChallenge?: boolean;
}

export interface WorkflowStateLike {
  tasks?: Record<string, Record<string, unknown>>;
  jobs?: Record<string, MillJob> | MillJob[];
  updated?: string;
  [key: string]: unknown;
}

export interface LaunchJobOptions {
  statePath: string;
  job: MillJob;
}

export interface PollJobsOptions {
  statePath: string;
  now?: Date;
  timeoutGraceMs?: number;
}

export interface PollJobsResult {
  changed: MillJob[];
  unsettled: MillJob[];
  jobs: Record<string, MillJob>;
}

export interface MarkJobSettledOptions {
  statePath: string;
  jobId: string;
  now?: Date;
}

export function buildJobId(job: Pick<MillJob, 'kind' | 'issueId' | 'side' | 'pairId' | 'prNumbers'>): string {
  const sanitize = (value: string | undefined): string =>
    (value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');

  if (job.kind === 'eval') {
    return `eval-${sanitize(job.issueId)}-${sanitize(job.side)}-${job.prNumbers[0] ?? 'na'}`;
  }

  if (isCheckJobKind(job.kind)) {
    // One stable id per (kind, subject): a relaunch overwrites the settled
    // predecessor, so check jobs never accumulate in workflow state.
    return job.issueId ? `${job.kind}-${sanitize(job.issueId)}` : job.kind;
  }

  const prPart = [...job.prNumbers].sort((a, b) => a - b).join('-');
  return `comparison-${sanitize(job.pairId)}-${prPart || 'na'}`;
}

export function normalizeJobs(state: WorkflowStateLike): Record<string, MillJob> {
  const rawJobs = state.jobs;
  if (!rawJobs) {
    return {};
  }

  if (Array.isArray(rawJobs)) {
    return rawJobs.reduce<Record<string, MillJob>>((acc, job) => {
      if (job?.id) {
        acc[job.id] = job;
      }
      return acc;
    }, {});
  }

  return { ...rawJobs };
}

export function extractLogExcerpt(logPath: string, maxLines = 8, maxCharsPerLine = 160): string | null {
  if (!existsSync(logPath)) {
    return null;
  }

  const lines = readFileSync(logPath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  return lines
    .slice(-maxLines)
    .map((line) => (line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 3)}...` : line))
    .join('\n');
}

export function isActiveStatus(status: MillJobStatus): boolean {
  return status === 'running';
}

export function classifyJobCompletion(
  job: MillJob,
  result: JobResultFile | null,
): Pick<MillJob, 'status' | 'exitCode' | 'reason'> {
  if (!result) {
    return {
      status: 'failed',
      exitCode: null,
      reason: 'no_result_file',
    };
  }

  if (result.ok || result.persisted) {
    return {
      status: 'succeeded',
      exitCode: result.exitCode ?? 0,
      reason: result.ok ? null : (result.reason || 'persisted_eval_record'),
    };
  }

  return {
    status: 'failed',
    exitCode: result.exitCode ?? null,
    reason: result.reason || result.error || 'job_failed',
  };
}

export function settleJobSuccess<T extends WorkflowStateLike>(state: T, job: MillJob, now = new Date()): T {
  const tasks = { ...(state.tasks || {}) };
  const updatedAt = now.toISOString();

  if (job.kind === 'eval' && job.issueId && tasks[job.issueId]) {
    tasks[job.issueId] = {
      ...tasks[job.issueId],
      evalCompleted: true,
      evalFailed: false,
      evalHardFailureRetryCount: 0,
      evalRunning: undefined,
      updated: updatedAt,
    };
    delete tasks[job.issueId].evalRunning;
  }

  if (job.kind === 'comparison' && job.pairId) {
    for (const [taskId, task] of Object.entries(tasks)) {
      if ((task.challengePairId as string | undefined) === job.pairId) {
        tasks[taskId] = {
          ...task,
          challengeCompared: true,
          comparisonRunning: undefined,
          comparisonState: undefined,
          comparisonBlockedReason: undefined,
          comparisonRetryCount: undefined,
          comparisonRetryMaxAttempts: undefined,
          comparisonRetryTargetIssue: undefined,
          comparisonTimedOutSides: undefined,
          manualComparisonArtifact: undefined,
          updated: updatedAt,
        };
        delete tasks[taskId].comparisonRunning;
        delete tasks[taskId].comparisonState;
        delete tasks[taskId].comparisonBlockedReason;
        delete tasks[taskId].comparisonRetryCount;
        delete tasks[taskId].comparisonRetryMaxAttempts;
        delete tasks[taskId].comparisonRetryTargetIssue;
        delete tasks[taskId].comparisonTimedOutSides;
        delete tasks[taskId].manualComparisonArtifact;
      }
    }
  }

  return {
    ...state,
    tasks,
  };
}

export function writeJobResultFile(path: string, result: JobResultFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
}

function readWorkflowState(statePath: string): WorkflowStateLike {
  if (!existsSync(statePath)) {
    return {};
  }
  return JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowStateLike;
}

function readResultFile(path: string): JobResultFile | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as JobResultFile;
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      reason: 'invalid_result_file',
      error: errorMessage(error),
    };
  }
}

function hasExplicitTerminalResult(result: JobResultFile | null): result is JobResultFile {
  if (!result) {
    return false;
  }

  return typeof result.ok === 'boolean' || result.persisted === true;
}

function readTerminalResultFile(path: string): JobResultFile | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const result = JSON.parse(readFileSync(path, 'utf-8')) as JobResultFile;
    return hasExplicitTerminalResult(result) ? result : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(pid: number, graceMs: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(100);
  }

  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Ignore already-dead processes.
  }
}

export async function launchJob({ statePath, job }: LaunchJobOptions): Promise<MillJob> {
  let storedJob = job;

  await mutateJsonState<WorkflowStateLike>(statePath, (current) => {
    const jobs = normalizeJobs(current);
    const existing = jobs[job.id];

    if (existing && isActiveStatus(existing.status)) {
      storedJob = existing;
      return {
        ...current,
        jobs,
      };
    }

    jobs[job.id] = job;
    storedJob = jobs[job.id];
    return {
      ...current,
      jobs,
      updated: new Date().toISOString(),
    };
  });

  return storedJob;
}

export async function pollJobs({
  statePath,
  now = new Date(),
  timeoutGraceMs = 1_500,
}: PollJobsOptions): Promise<PollJobsResult> {
  const state = readWorkflowState(statePath);
  const jobs = normalizeJobs(state);
  const updates = new Map<string, Partial<MillJob>>();
  const changedIds = new Set<string>();

  for (const job of Object.values(jobs)) {
    if (!isActiveStatus(job.status)) {
      continue;
    }

    const startedAtMs = Date.parse(job.startedAt);
    const elapsedMs = Number.isFinite(startedAtMs) ? now.getTime() - startedAtMs : 0;

    if (elapsedMs > job.timeoutSeconds * 1000) {
      const result = readResultFile(job.resultPath);
      const completion = classifyJobCompletion(job, result);
      if (completion.status === 'succeeded') {
        updates.set(job.id, {
          ...completion,
          finishedAt: now.toISOString(),
          excerpt: null,
          settled: false,
        });
        changedIds.add(job.id);
        continue;
      }

      await terminateProcess(job.pid, timeoutGraceMs);
      updates.set(job.id, {
        status: 'timeout',
        exitCode: null,
        finishedAt: now.toISOString(),
        reason: 'timed_out',
        excerpt: extractLogExcerpt(job.logPath),
        settled: false,
      });
      changedIds.add(job.id);
      continue;
    }

    if (job.kind === 'comparison') {
      const result = readTerminalResultFile(job.resultPath);
      if (result) {
        const completion = classifyJobCompletion(job, result);
        updates.set(job.id, {
          ...completion,
          finishedAt: now.toISOString(),
          excerpt: completion.status === 'succeeded' ? null : extractLogExcerpt(job.logPath),
          settled: false,
        });
        changedIds.add(job.id);
        continue;
      }
    }

    if (isProcessAlive(job.pid)) {
      continue;
    }

    const result = readResultFile(job.resultPath);
    const completion = classifyJobCompletion(job, result);
    updates.set(job.id, {
      ...completion,
      finishedAt: now.toISOString(),
      excerpt: completion.status === 'succeeded' ? null : extractLogExcerpt(job.logPath),
      // A succeeded check job has nothing left for the monitor to do: its
      // result marker is the output. Settle it here so the hot pass never
      // spends a tsx spawn on `mark-settled`. Failures stay unsettled so the
      // monitor can charge the job's bounded-retry bucket.
      settled: isCheckJobKind(job.kind) && completion.status === 'succeeded',
    });
    changedIds.add(job.id);
  }

  const pruneIds = Object.values(jobs)
    .filter((job) => isCheckJobKind(job.kind) && job.settled && job.finishedAt
      && now.getTime() - Date.parse(job.finishedAt) > CHECK_JOB_RETENTION_MS)
    .map((job) => job.id);

  let nextState = state;
  if (updates.size > 0 || pruneIds.length > 0) {
    nextState = await mutateJsonState<WorkflowStateLike>(statePath, (current) => {
      const nextJobs = normalizeJobs(current);
      for (const [jobId, patch] of updates.entries()) {
        const existing = nextJobs[jobId];
        if (!existing) {
          continue;
        }
        nextJobs[jobId] = {
          ...existing,
          ...patch,
        };
      }
      for (const jobId of pruneIds) {
        const existing = nextJobs[jobId];
        if (existing && existing.settled && !isActiveStatus(existing.status)) {
          delete nextJobs[jobId];
        }
      }
      return {
        ...current,
        jobs: nextJobs,
        updated: now.toISOString(),
      };
    });
  }

  const normalized = normalizeJobs(nextState);
  return {
    changed: [...changedIds].map((jobId) => normalized[jobId]).filter(Boolean),
    unsettled: Object.values(normalized).filter((job) => job.status !== 'running' && !job.settled),
    jobs: normalized,
  };
}

export async function markJobSettled({
  statePath,
  jobId,
  now = new Date(),
}: MarkJobSettledOptions): Promise<MillJob | null> {
  let updatedJob: MillJob | null = null;

  await mutateJsonState<WorkflowStateLike>(statePath, (current) => {
    const jobs = normalizeJobs(current);
    const existing = jobs[jobId];
    if (!existing) {
      updatedJob = null;
      return {
        ...current,
        jobs,
      };
    }

    let nextState: WorkflowStateLike = {
      ...current,
      jobs,
      updated: now.toISOString(),
    };

    if (existing.status === 'succeeded') {
      nextState = settleJobSuccess(nextState, existing, now);
    } else if (existing.kind === 'eval' && existing.issueId && nextState.tasks?.[existing.issueId]) {
      nextState = {
        ...nextState,
        tasks: {
          ...nextState.tasks,
          [existing.issueId]: {
            ...nextState.tasks[existing.issueId],
            evalFailed: true,
            evalRunning: undefined,
            updated: now.toISOString(),
          },
        },
      };
      delete nextState.tasks?.[existing.issueId]?.evalRunning;
    } else if (existing.kind === 'comparison' && existing.pairId && nextState.tasks) {
      const tasks = { ...nextState.tasks };
      const comparisonBlockedReason = existing.reason || existing.error || 'job_failed';
      for (const [taskId, task] of Object.entries(tasks)) {
        if ((task.challengePairId as string | undefined) === existing.pairId) {
          tasks[taskId] = {
            ...task,
            comparisonState: 'manual_comparison_needed',
            comparisonBlockedReason,
            comparisonRunning: undefined,
            comparisonRetryCount: undefined,
            comparisonRetryMaxAttempts: undefined,
            comparisonRetryTargetIssue: undefined,
            comparisonTimedOutSides: undefined,
            manualComparisonArtifact: undefined,
            updated: now.toISOString(),
          };
          delete tasks[taskId].comparisonRunning;
          delete tasks[taskId].comparisonRetryCount;
          delete tasks[taskId].comparisonRetryMaxAttempts;
          delete tasks[taskId].comparisonRetryTargetIssue;
          delete tasks[taskId].comparisonTimedOutSides;
          delete tasks[taskId].manualComparisonArtifact;
        }
      }
      nextState = {
        ...nextState,
        tasks,
      };
    }

    const nextJobs = normalizeJobs(nextState);
    nextJobs[jobId] = {
      ...existing,
      settled: true,
    };
    updatedJob = nextJobs[jobId];

    return {
      ...nextState,
      jobs: nextJobs,
      updated: now.toISOString(),
    };
  });

  return updatedJob;
}

export function formatJobSummary(job: MillJob): string {
  const target = job.kind === 'eval'
    ? `${job.issueId || 'unknown'}:${job.side || 'unknown'}`
    : isCheckJobKind(job.kind)
      ? `${job.issueId || 'global'}${job.prNumbers.length > 0 ? `:${job.prNumbers.join('/')}` : ''}`
      : `${job.pairId || 'unknown'}:${job.prNumbers.join('/')}`;
  return `${job.kind} ${target} ${job.status} ${basename(job.logPath)}`;
}
