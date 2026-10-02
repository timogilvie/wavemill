/**
 * Shared task-abort primitive (HOK-3097).
 *
 * `abortTaskInState` moved here so the observer can call it without pulling
 * `tools/abort-task.ts` into the module graph. `tools/abort-task.ts`
 * re-exports both {@link abortTaskInState} and {@link OPERATOR_ABORT_MARKER}
 * so its CLI contract and existing tests are unchanged.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mutateJsonState } from './state-mutex.ts';
import { TASK_ID_RE } from './task-identity.ts';

type JsonRecord = Record<string, unknown>;

interface WorkflowState {
  tasks?: Record<string, JsonRecord>;
  [key: string]: unknown;
}

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
}

// Deliberately NOT a `terminal_stage_failure:`/`terminal_launch_failure:` value.
// parseAbortFailureKind() returns null for this, so classifyArmFault() yields
// 'unknown-fault' and an operator abort is never counted as a model or provider
// quality signal in challenge eval attribution.
export const OPERATOR_ABORT_MARKER = 'operator_abort';

function taskString(task: JsonRecord | undefined, key: string): string {
  const value = task?.[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  now: string = new Date().toISOString(),
): Promise<AbortTaskResult> {
  if (!TASK_ID_RE.test(issue)) {
    throw new Error(`invalid issue id '${issue}'`);
  }
  if (!existsSync(stateFile)) {
    throw new Error(`no active workflow state found at ${stateFile}`);
  }

  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as WorkflowState;
  const beforeTask = state.tasks?.[issue];
  if (!beforeTask) {
    throw new Error(`task ${issue} is not present in workflow state`);
  }

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
      challengeAborted: OPERATOR_ABORT_MARKER,
    },
  };

  await mutateJsonState<WorkflowState>(stateFile, (current) => {
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
    task.challengeAborted = OPERATOR_ABORT_MARKER;
    task.challengeAbortedDetail = reason;
    task.abortedAt = now;
    task.updated = now;
    return current;
  });

  return result;
}
