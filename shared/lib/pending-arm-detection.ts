/**
 * HOK-2813_c: Type-safe helpers for detecting and handling pending
 * (awaiting_fork) challenge arms.
 *
 * Pending arms are legitimate nested records on the primary task's
 * .challengeArms array. They must not be treated as orphaned or
 * repairable, and they should not be touched by sweepers or ready-gates.
 */

export interface ChallengeArm {
  key: string;
  challengeArmState: string;
  slug?: string;
  branch?: string;
  [key: string]: unknown;
}

export interface TaskWithChallengeArms {
  challengeArms?: ChallengeArm[];
  [key: string]: unknown;
}

/**
 * Check if a task has any valid pending (awaiting_fork) arms.
 * Returns true if at least one arm is in the awaiting_fork state.
 */
export function hasPendingArms(task: TaskWithChallengeArms | undefined): boolean {
  if (!task?.challengeArms || !Array.isArray(task.challengeArms)) {
    return false;
  }
  return task.challengeArms.some((arm) => arm.challengeArmState === 'awaiting_fork');
}

/**
 * Get all pending arms from a task.
 */
export function getPendingArms(task: TaskWithChallengeArms | undefined): ChallengeArm[] {
  if (!task?.challengeArms || !Array.isArray(task.challengeArms)) {
    return [];
  }
  return task.challengeArms.filter((arm) => arm.challengeArmState === 'awaiting_fork');
}

/**
 * Type guard: a primary with pending arms is neither orphaned nor repairable.
 * Pending arms indicate a legitimate two-stage pair that hasn't forked yet.
 */
export function isPrimaryWithPendingArm(task: TaskWithChallengeArms | undefined): boolean {
  return hasPendingArms(task);
}
