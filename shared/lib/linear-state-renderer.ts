/**
 * linear-state-renderer — Linear state as a render of the settled run
 * (HOK-3373), the way `merge-labels.ts` `deriveMergeLabel` renders
 * `wm:ready` / `wm:blocked` from task state (HOK-3181).
 *
 * Linear is never a primary fact the mill reads back to decide what to do.
 * A settled, delivered run renders `Done`; nothing may move it back. The
 * mill's exit trap no longer writes Linear at all (it used to reset every
 * launched issue to Backlog, delivered or not — the HOK-2595 flips), and an
 * interrupted *unsettled* run is left for the next session's recovery.
 *
 * Only outcomes the row decides by itself render here. A closed or aborted
 * challenge arm's Linear move depends on its sibling and stays with the
 * terminal reconciler (`terminal-reconciler.sh`), which already records a
 * durable `linearApplied` marker; challengers never write Linear (HOK-3115).
 *
 * The shell twin is `attempt-identity.sh` `linear_state_for_task`; the
 * monitor's `linear_state_converge_tick` writes the rendered state for every
 * settled row whose `linearSyncedState` differs, so a crash between
 * settlement and the Linear write converges on the next tick. Both are
 * pinned by `tests/fixtures/linear-state-render-cases.json`.
 *
 * @module linear-state-renderer
 */
import { isChallengerTaskId } from './task-identity.ts';
import type { TaskRecord } from './workflow-state.ts';

/** Linear states this renderer can produce. */
export type RenderedLinearState = 'Done';

/**
 * The Linear state `task`'s settled outcome renders to, or `null` when the
 * row alone does not decide it (open run, aborted/closed arm whose move the
 * terminal reconciler derives from its sibling, or a challenger).
 */
export function renderLinearState(issue: string, task: Pick<TaskRecord, 'lifecycle' | 'status' | 'challengeRole'> | null | undefined): RenderedLinearState | null {
  if (!task) return null;
  if (isChallengerTaskId(issue) || task.challengeRole === 'challenger') return null;
  const outcome = task.lifecycle?.workflowOutcome;
  if (outcome === 'merged') return 'Done';
  if (outcome === 'closed' && task.status === 'completed-external') return 'Done';
  return null;
}

/** True when the row still owes Linear a write of its rendered state. */
export function linearSyncPending(issue: string, task: (Pick<TaskRecord, 'lifecycle' | 'status' | 'challengeRole' | 'linearSyncedState'>) | null | undefined): boolean {
  const rendered = renderLinearState(issue, task);
  return rendered !== null && task?.linearSyncedState !== rendered;
}
