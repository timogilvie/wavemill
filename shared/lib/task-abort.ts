// allow-arm-termination: task-abort.ts delegates to the arm-termination
// recorder; this file re-exports {@link abortTaskInState} but no longer
// writes `challengeAborted` directly (HOK-3358).
/**
 * Shared task-abort primitive (HOK-3097, HOK-3358).
 *
 * `abortTaskInState` moved here so the observer can call it without pulling
 * `tools/abort-task.ts` into the module graph. HOK-3358 made it a thin
 * wrapper over {@link recordArmTermination}: the operator's abort is the
 * same termination event as the monitor's, with `actor: 'operator'`.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TASK_ID_RE } from './task-identity.ts';
import { readWorkflowState, type TaskRecord } from './workflow-state.ts';
import { recordArmTermination, normalizeArmTerminationKind, type ArmTerminationKind } from './arm-termination.ts';
import type { ArmFaultClass } from './arm-failure-taxonomy.ts';

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
    faultClass: ArmFaultClass;
    kind: ArmTerminationKind;
  };
}

export interface AbortTaskOptions {
  /** Typed arm-failure kind. Defaults to `cancelled` (harness-fault). */
  kind?: string;
  /** Path to a stage artifact. Required when the kind classifies model-fault. */
  evidencePath?: string;
  /** Phase string (`planning` / `coding` / `review` / `ready`). */
  stage?: string;
  /** Executed model id. */
  model?: string;
  /** ISO timestamp; defaults to now. Keeps the previous signature compatible. */
  now?: string;
}

function taskString(task: TaskRecord | undefined, key: 'phase' | 'status' | 'pr'): string {
  const value = task?.[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

/**
 * Overload: the three-argument call used by the observer stays valid.
 */
export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  now?: string,
): Promise<AbortTaskResult>;
export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  options: AbortTaskOptions,
): Promise<AbortTaskResult>;
export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  nowOrOptions: string | AbortTaskOptions = {},
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

  const legacyNow = typeof nowOrOptions === 'string' ? nowOrOptions : nowOrOptions.now;
  const options: AbortTaskOptions = typeof nowOrOptions === 'string'
    ? { now: nowOrOptions }
    : nowOrOptions;
  const kind = normalizeArmTerminationKind(options.kind ?? 'cancelled');
  const timestamp = legacyNow ?? new Date().toISOString();
  const nowFn = () => new Date(timestamp);

  const inferredStage = options.stage || taskString(beforeTask, 'phase');
  // Resolve the repoDir from the state file path (<repoDir>/.wavemill/workflow-state.json).
  const repoDir = resolve(dirname(stateFile), '..');

  const outcome = await recordArmTermination({
    issueId: issue,
    kind,
    actor: 'operator',
    detail: reason,
    evidencePath: options.evidencePath,
    stage: inferredStage || undefined,
    model: options.model,
    scope: 'single',
    featureDir: inferFeatureDir(repoDir, beforeTask),
    repoDir,
    stateFile,
    now: nowFn,
  });

  return {
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
      challengeAborted: outcome.abortReason,
      faultClass: outcome.faultClass,
      kind,
    },
  };
}

function inferFeatureDir(repoDir: string, task: TaskRecord | undefined): string | undefined {
  const slug = typeof task?.slug === 'string' ? task.slug : null;
  if (!slug) return undefined;
  return join(repoDir, 'features', slug);
}
