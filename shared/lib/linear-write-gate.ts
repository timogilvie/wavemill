/**
 * Linear write gate (HOK-3115) — the one decision every Linear-writing tool
 * makes before touching the API: may this task write, and to which issue?
 *
 * Built on the task identity invariant in `task-identity.ts`:
 * - A primary task with a resolvable, non-conflicting Linear ID **writes**.
 * - A challenger (`<ID>_c`, or metadata `challengeRole: "challenger"`) is a
 *   **skip**: a logged, successful no-op. Challengers never write Linear.
 * - An invalid task ID or a recorded `linearIssueId` that conflicts with the
 *   task ID is a **reject**: fail closed, never call Linear.
 *
 * Metadata comes from the workflow-state file (`WAVEMILL_STATE_FILE`, then
 * `STATE_FILE`) unless the caller supplies it. A missing or unreadable file
 * means "no metadata"; the structural task ID alone then decides.
 *
 * The shell twin is `linear_write_target` in `shared/lib/wavemill-common.sh`.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  parseTaskId,
  resolveLinearIssueId,
  type TaskIdentityErrorCode,
  type TaskIdentityMeta,
} from './task-identity.ts';
import { setIssuesState, type LinearBatchFailure } from './linear.ts';

export type LinearWriteDecision =
  | { action: 'write'; taskId: string; linearId: string }
  | { action: 'skip'; taskId: string; reason: 'challenger'; message: string }
  | { action: 'reject'; taskId: string; error: TaskIdentityErrorCode; message: string };

export interface LinearWriteGateOptions {
  /** Task metadata; when omitted it is read from `stateFile`. */
  meta?: TaskIdentityMeta | null;
  /** Workflow-state file; defaults to `WAVEMILL_STATE_FILE` / `STATE_FILE`. */
  stateFile?: string;
}

function defaultStateFile(): string | undefined {
  return process.env.WAVEMILL_STATE_FILE || process.env.STATE_FILE || undefined;
}

/**
 * Read `.tasks[taskId]` from a workflow-state file.
 *
 * @returns The task record, or `null` when the file or task is missing/unreadable.
 */
export function readTaskIdentityMeta(taskId: string, stateFile = defaultStateFile()): TaskIdentityMeta | null {
  if (!stateFile || !existsSync(stateFile)) return null;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { tasks?: Record<string, unknown> };
    const task = state.tasks?.[taskId];
    return task && typeof task === 'object' ? (task as TaskIdentityMeta) : null;
  } catch {
    return null;
  }
}

/** Decide whether and where `taskId` may write to Linear. */
export function resolveLinearWriteTarget(taskId: string, opts: LinearWriteGateOptions = {}): LinearWriteDecision {
  const parsed = parseTaskId(taskId);
  if (!parsed) {
    return { action: 'reject', taskId, error: 'invalid_task_id', message: `Invalid task ID: ${JSON.stringify(taskId)}` };
  }
  const meta = opts.meta !== undefined ? opts.meta : readTaskIdentityMeta(taskId, opts.stateFile);
  // Same precedence as isLinearWriter(): role first, then ID resolution.
  if (parsed.role === 'challenger' || meta?.challengeRole === 'challenger') {
    return {
      action: 'skip',
      taskId,
      reason: 'challenger',
      message: `${taskId} is a challenger task; challengers never write Linear`,
    };
  }
  const resolved = resolveLinearIssueId(taskId, meta);
  if (!resolved.ok) {
    return { action: 'reject', taskId, error: resolved.error, message: resolved.message };
  }
  return { action: 'write', taskId, linearId: resolved.linearId };
}

/**
 * Gate for single-issue write tools. Returns the Linear ID to write, or
 * `null` after logging a challenger skip (the tool should exit 0 without
 * calling Linear).
 *
 * @throws Error for an invalid or conflicting task ID (fail closed).
 */
export function linearWriteTargetOrSkip(
  taskId: string,
  opts: LinearWriteGateOptions & { log?: Pick<Console, 'log'> } = {},
): string | null {
  const decision = resolveLinearWriteTarget(taskId, opts);
  if (decision.action === 'reject') {
    throw new Error(`Refusing Linear write: ${decision.message}`);
  }
  if (decision.action === 'skip') {
    (opts.log ?? console).log(`↷ skipped Linear write: ${decision.message}`);
    return null;
  }
  return decision.linearId;
}

export interface PartitionedLinearWriteTargets {
  /** Unique Linear IDs that may be written, in first-seen order. */
  linearIds: string[];
  skipped: Array<Extract<LinearWriteDecision, { action: 'skip' }>>;
  rejected: Array<Extract<LinearWriteDecision, { action: 'reject' }>>;
}

/** Run {@link resolveLinearWriteTarget} over many task IDs. */
export function partitionLinearWriteTargets(
  taskIds: string[],
  opts: Omit<LinearWriteGateOptions, 'meta'> = {},
): PartitionedLinearWriteTargets {
  const result: PartitionedLinearWriteTargets = { linearIds: [], skipped: [], rejected: [] };
  for (const taskId of taskIds) {
    const decision = resolveLinearWriteTarget(taskId, opts);
    if (decision.action === 'write') {
      if (!result.linearIds.includes(decision.linearId)) result.linearIds.push(decision.linearId);
    } else if (decision.action === 'skip') {
      result.skipped.push(decision);
    } else {
      result.rejected.push(decision);
    }
  }
  return result;
}

/** Non-retryable batch failure for a task the gate rejected. */
export function rejectedWriteFailure(decision: Extract<LinearWriteDecision, { action: 'reject' }>): LinearBatchFailure {
  return {
    issueId: decision.taskId,
    error: decision.message,
    category: 'client',
    httpStatus: null,
    graphqlErrors: [],
    isRetryable: false,
    message: decision.message,
  };
}

export interface GatedBatchResult {
  updated: string[];
  failed: LinearBatchFailure[];
  /** Challenger task IDs that were skipped as no-ops. */
  skipped: string[];
}

/**
 * Set one Linear state on many tasks, gated through the task identity
 * contract. Challengers are skipped (and logged); rejected IDs become
 * non-retryable `client` failures so batch retry classification still works.
 */
export async function setTaskIssuesState(
  taskIds: string[],
  stateName: string,
  opts: Omit<LinearWriteGateOptions, 'meta'> & {
    setIssuesStateImpl?: typeof setIssuesState;
    log?: Pick<Console, 'error'>;
  } = {},
): Promise<GatedBatchResult> {
  const log = opts.log ?? console;
  const { linearIds, skipped, rejected } = partitionLinearWriteTargets(taskIds, opts);
  for (const decision of skipped) {
    log.error(`↷ skipped Linear write: ${decision.message}`);
  }
  const response = linearIds.length > 0
    ? await (opts.setIssuesStateImpl ?? setIssuesState)(linearIds, stateName)
    : { updated: [], failed: [] };
  return {
    updated: response.updated,
    failed: [...rejected.map(rejectedWriteFailure), ...response.failed],
    skipped: skipped.map((decision) => decision.taskId),
  };
}
