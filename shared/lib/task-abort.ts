/**
 * Shared task-abort primitive (HOK-3097).
 *
 * `abortTaskInState` moved here so the observer can call it without pulling
 * `tools/abort-task.ts` into the module graph.
 */

import { existsSync } from 'node:fs';
import { TASK_ID_RE } from './task-identity.ts';
import { mutateWorkflowState, readWorkflowState, type TaskRecord } from './workflow-state.ts';
import { formatTerminationReason } from './arm-failure-taxonomy.ts';

export interface AbortTaskResult {
  issue: string;
  reason: string;
  before: {
    phase: string;
    status: string;
    pr: string;
  };
  after: {
    phase: string;
    status: string;
    abortedReason: string;
    challengeAborted: string;
  };
  faultClass?: string;
  qualitySignalEligible?: boolean;
  reliabilityRecordId?: string;
  evalRecordId?: string | null;
}

function taskString(task: TaskRecord | undefined, key: 'phase' | 'status' | 'pr'): string {
  const value = task?.[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  opts?: {
    failureKind?: string;
    evidencePath?: string;
    actor?: 'operator' | 'observer';
    repoDir?: string;
    now?: string;
  },
  now: string = new Date().toISOString(),
): Promise<AbortTaskResult> {
  if (!TASK_ID_RE.test(issue)) {
    throw new Error(`invalid issue id '${issue}'`);
  }
  if (!existsSync(stateFile)) {
    throw new Error(`no active workflow state found at ${stateFile}`);
  }

  const state = readWorkflowState(stateFile);
  if (!state) {
    throw new Error(`workflow state at ${stateFile} is not a readable JSON object`);
  }
  const beforeTask = state.tasks?.[issue];
  if (!beforeTask) {
    throw new Error(`task ${issue} is not present in workflow state`);
  }

  // Default to cancelled kind for operator aborts
  const failureKind = opts?.failureKind ?? 'cancelled';
  const actor = opts?.actor ?? 'operator';
  
  // Format the termination reason
  const challengeAborted = formatTerminationReason(failureKind);

  const result: AbortTaskResult = {
    issue,
    reason,
    before: {
      phase: taskString(beforeTask, 'phase') || '(empty)',
      status: taskString(beforeTask, 'status') || '(empty)',
      pr: taskString(beforeTask, 'pr'),
    },
    after: {
      phase: 'aborted',
      status: 'aborted',
      abortedReason: reason,
      challengeAborted,
    },
  };

  await mutateWorkflowState(stateFile, (current) => {
    const task = current.tasks?.[issue];
    if (!task) {
      throw new Error(`task ${issue} disappeared from workflow state`);
    }
    task.phase = 'aborted';
    task.status = 'aborted';
    task.abortedReason = reason;
    // The mill's arm cleanup gate reads challengeAborted, not abortedReason.
    // Without a non-empty value here the window, worktree and branch are never
    // reaped, so an aborted arm lingers indefinitely.
    task.challengeAborted = challengeAborted;
    task.challengeAbortedDetail = reason;
    task.abortedAt = now;
    task.updated = now;
    // HOK-3312: the shared decider in `decideTerminalTask` reads
    // `lifecycle.workflowOutcome` as the terminal signal. Without flipping it
    // here the row stays `lifecycle.workflowOutcome: 'active'` while status/phase say
    // 'aborted', and the decider returns `not-terminal` so the monitor never
    // closes the pane or reaps the arm.
    const existingLifecycle = (task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle))
      ? task.lifecycle
      : {};
    task.lifecycle = { ...existingLifecycle, schemaVersion: 1, workflowOutcome: 'aborted' };
    return current;
  });

  return result;
}
