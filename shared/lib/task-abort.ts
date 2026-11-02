/**
 * Shared task-abort primitive (HOK-3097, HOK-3358).
 *
 * `abortTaskInState` moved here so the observer can call it without pulling
 * `tools/abort-task.ts` into the module graph. `tools/abort-task.ts`
 * re-exports both {@link abortTaskInState}
 * so its CLI contract and existing tests are unchanged.
 *
 * Abort attribution (HOK-3358): abortTaskInState now delegates the challengeAborted
 * stamp and reliability/eval records to the recorder through recordArmTermination.
 */

import { existsSync } from 'node:fs';
import { TASK_ID_RE } from './task-identity.ts';
import { mutateWorkflowState, readWorkflowState, type TaskRecord } from './workflow-state.ts';
import { recordArmTermination, type ArmFailureKind, type TerminationActor } from './arm-termination.ts';
import { join } from 'node:path';

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
  // v1.1.0 (HOK-3358): attribution facts
  faultClass?: 'harness-fault' | 'model-fault' | 'unknown-fault' | 'provider-fault' | 'selection-fault';
  qualitySignalEligible?: boolean;
  reliabilityRecordId?: string;
  evalRecordId?: string;
}

function taskString(task: TaskRecord | undefined, key: 'phase' | 'status' | 'pr'): string {
  const value = task?.[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

export interface AbortTaskOptions {
  failureKind?: ArmFailureKind;
  evidencePath?: string;
  actor?: TerminationActor;
  repoDir?: string;
  now?: Date;
}

export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  opts?: AbortTaskOptions,
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

  const now = opts?.now ?? new Date();
  const nowStr = now.toISOString();
  const failureKind = opts?.failureKind ?? 'cancelled';
  const actor = opts?.actor ?? 'operator';

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
      challengeAborted: `terminal_stage_failure:${failureKind}`,
    },
  };

  const repoDir = opts?.repoDir ?? process.cwd();
  const featureDir = typeof beforeTask.worktree === 'string' && typeof beforeTask.slug === 'string'
    ? join(beforeTask.worktree, 'features', beforeTask.slug)
    : undefined;
  const termination = await recordArmTermination({
    repoDir,
    stateFile,
    issueId: issue,
    featureDir,
    stage: taskString(beforeTask, 'phase') || undefined,
    model: typeof beforeTask.model === 'string' ? beforeTask.model : (typeof beforeTask.coderModel === 'string' ? beforeTask.coderModel : undefined),
    failureKind,
    detail: reason,
    actor,
    evidencePath: opts?.evidencePath,
    now,
  });
  if ('error' in termination) {
    throw new Error(`${termination.error}: ${termination.validationErrors.map((error) => error.message).join('; ')}`);
  }
  result.faultClass = termination.faultClass;
  result.qualitySignalEligible = termination.qualitySignalEligible;
  result.reliabilityRecordId = termination.reliabilityRecordId;
  result.evalRecordId = termination.evalRecordId;

  await mutateWorkflowState(stateFile, (current) => {
    const task = current.tasks?.[issue];
    if (!task) {
      throw new Error(`task ${issue} disappeared from workflow state`);
    }
    task.phase = 'aborted';
    task.status = 'aborted';
    task.abortedReason = reason;
    task.abortedAt = nowStr;
    task.updated = nowStr;
    // HOK-3312: the shared decider in `decideTerminalTask` reads
    // `lifecycle.workflowOutcome` as the terminal signal. Without flipping it
    // here the row stays `workflowOutcome: 'active'` while status/phase say
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
