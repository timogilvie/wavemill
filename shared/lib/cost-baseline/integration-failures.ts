/**
 * Integration-failure raw counts for the MQ-0.1 baseline (HOK-3336).
 *
 * Raw counts only — classifying causes is MQ-0.2. Sources:
 *
 * - merge-lane `progress.json`: `mergeAttemptCount - 1` failed merge attempts,
 *   `rebaseCount`, `ciRestartCount` (the last two exist only on lanes written
 *   after the counters landed; older lanes report null, not zero).
 * - label ledger: `wm:merging` applications that did not end in the merge
 *   (ejections from the lane) and `wm:blocked` applications after the PR first
 *   became ready.
 * - session ownership: distinct conflict-resolution, Ready remediation and
 *   CI-fix launches (each one is a repair rerun after an integration failure).
 *
 * @module cost-baseline/integration-failures
 */

import { countLaunches } from './review-rounds.ts';
import type { BaselineSession, BaselineTask, IntegrationFailureCounts, LabelEvent } from './types.ts';

function launchCount(sessions: BaselineSession[], kind: string): number {
  // Pre-launch-record sessions of a repair kind are each counted as a launch.
  return countLaunches(sessions, kind) ?? sessions.filter((s) => s.kind === kind).length;
}

function labeled(events: LabelEvent[], label: string): LabelEvent[] {
  return events.filter((e) => e.label === label && e.action === 'labeled');
}

/** Integration-failure counts for one merged task. */
export function computeIntegrationFailures(
  task: Pick<BaselineTask, 'lane' | 'labelEvents' | 'sessions'>,
): IntegrationFailureCounts {
  const lane = task.lane;
  const merging = labeled(task.labelEvents, 'wm:merging');
  const firstReady = labeled(task.labelEvents, 'wm:ready')[0];
  const hasLedger = task.labelEvents.length > 0;
  return {
    failedMergeAttempts: lane?.mergeAttemptCount != null ? Math.max(lane.mergeAttemptCount - 1, 0) : null,
    rebases: lane?.rebaseCount ?? null,
    ciRestarts: lane?.ciRestartCount ?? null,
    // The cohort is merged tasks, so every lane entry but the last was an ejection.
    ejections: hasLedger ? Math.max(merging.length - 1, 0) : null,
    blockedAfterReady: hasLedger
      ? firstReady
        ? labeled(task.labelEvents, 'wm:blocked').filter((e) => Date.parse(e.at) > Date.parse(firstReady.at)).length
        : 0
      : null,
    conflictResolutionLaunches: launchCount(task.sessions, 'conflict-resolution'),
    readyRemediationLaunches: launchCount(task.sessions, 'ready-remediation'),
    ciFixLaunches: launchCount(task.sessions, 'ci-fix'),
  };
}
