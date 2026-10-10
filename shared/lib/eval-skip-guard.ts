/**
 * Post-completion eval skip guard.
 *
 * Decides whether `tools/run-eval-hook.ts` should refuse to evaluate a task
 * because its workflow-state entry is terminal.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { challengerTaskKey, isChallengerTaskId } from './task-identity.ts';

/**
 * Challenge arms share the Linear issue id, but the challenger's state entry is
 * keyed `<issue>_c`. Resolve the entry for the arm being evaluated, not the
 * pair's primary: an aborted primary must not veto its surviving challenger's
 * eval (HOK-3172_c was refused `task_aborted` three times for this reason).
 */
export function evalTaskStateKey(issue: string, challengeSide: string | undefined): string {
  return challengeSide === 'challenger' && !isChallengerTaskId(issue) ? challengerTaskKey(issue) : issue;
}

/**
 * Returns a skip reason (`task_aborted` or `challenge_aborted_no_pr`) when the
 * evaluated arm's state entry is terminal, otherwise undefined. Missing or
 * unreadable state never blocks the eval.
 */
export function shouldSkipAbortedTaskEval(
  repoDir: string | undefined,
  issue: string | undefined,
  pr: string | undefined,
  challengeSide?: string,
): string | undefined {
  if (!issue) return undefined;
  const statePath = join(resolve(repoDir ?? process.cwd()), '.wavemill', 'workflow-state.json');
  if (!existsSync(statePath)) return undefined;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      tasks?: Record<string, { status?: unknown; challengeAborted?: unknown; pr?: unknown }>;
    };
    const task = state.tasks?.[evalTaskStateKey(issue, challengeSide)];
    if (!task) return undefined;
    const statePr = typeof task.pr === 'string' ? task.pr : '';
    if (task.status === 'aborted') return 'task_aborted';
    if (typeof task.challengeAborted === 'string' && task.challengeAborted && !pr && !statePr) {
      return 'challenge_aborted_no_pr';
    }
  } catch {
    return undefined;
  }
  return undefined;
}
