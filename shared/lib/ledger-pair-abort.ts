/**
 * Ledger pair-abort walk primitive (HOK-3186 — Ledger G Phase 3).
 *
 * Bottom-up abort walk for challenge pairs. When both arms of a pair have
 * settled, the pair row itself is settled with a composite reason. This
 * replaces the per-reason `pair-unresolvable` gate classification with a
 * single primitive.
 */

import type { Ledger, TaskRow } from './ledger.ts';

export interface PairAbortWalkResult {
  /** True if the pair row was settled by this call. */
  settled: boolean;
  /** ID of the surviving arm (when one arm is 'done' and the other 'aborted'), or null. */
  survivorArmId: string | null;
  /** Role of the surviving arm, or null when both arms aborted or pair was already settled. */
  survivorRole: 'primary' | 'challenger' | null;
}

/**
 * Attempt to settle a pair row after one or both of its arms have been
 * aborted or completed. If all non-background children are settled, the
 * pair is settled as 'aborted' with a composite reason like
 * `pair-settled:aborted-done`. The database trigger `trg_task_parent_consistent`
 * is defense-in-depth; if a child is unexpectedly open the trigger refuses
 * the update and this helper logs and bails.
 *
 * Returns a result indicating whether the pair was settled, and if so,
 * which arm (if any) survived.
 */
export function attemptPairAbortWalk(ledger: Ledger, pairId: string): PairAbortWalkResult {
  const roots = ledger.listTasks({ kind: 'pair' });
  const pairRow = roots.find((row) => row.slug === pairId && row.parent_id === null);

  if (!pairRow) {
    // Pair row doesn't exist yet — no-op
    return { settled: false, survivorArmId: null, survivorRole: null };
  }

  if (pairRow.settled_as !== null) {
    // Pair already settled — idempotent
    return { settled: false, survivorArmId: null, survivorRole: null };
  }

  const children = ledger.listChildren(pairRow.id);
  const arms = children.filter((row) => row.kind === 'arm');
  const nonBackgroundChildren = children.filter((row) => !row.background);

  // Check if all non-background children are settled
  const allSettled = nonBackgroundChildren.every((row) => row.settled_as !== null);

  if (!allSettled) {
    // Not ready to settle yet
    return { settled: false, survivorArmId: null, survivorRole: null };
  }

  // Determine settlement reason and survivor
  let primaryArm: TaskRow | undefined;
  let challengerArm: TaskRow | undefined;

  for (const arm of arms) {
    if (arm.owner === 'primary') primaryArm = arm;
    else if (arm.owner === 'challenger') challengerArm = arm;
  }

  const primaryStatus = primaryArm?.settled_as ?? 'unknown';
  const challengerStatus = challengerArm?.settled_as ?? 'unknown';
  const settledReason = `pair-settled:${primaryStatus}-${challengerStatus}`;

  // Determine survivor (if any)
  let survivorArmId: string | null = null;
  let survivorRole: 'primary' | 'challenger' | null = null;

  if (primaryArm && primaryArm.settled_as === 'done' && challengerArm && challengerArm.settled_as === 'aborted') {
    survivorArmId = primaryArm.id;
    survivorRole = 'primary';
  } else if (challengerArm && challengerArm.settled_as === 'done' && primaryArm && primaryArm.settled_as === 'aborted') {
    survivorArmId = challengerArm.id;
    survivorRole = 'challenger';
  }

  try {
    ledger.transaction((tx) => tx.settleTask(pairRow.id, 'aborted', settledReason));
    return { settled: true, survivorArmId, survivorRole };
  } catch (error) {
    // Log and bail if the DB trigger refuses (defensive check)
    if (process.env.WAVEMILL_LEDGER_SHADOW_DEBUG === '1') {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ledger-pair-abort] failed to settle pair ${pairId}: ${message}\n`);
    }
    return { settled: false, survivorArmId: null, survivorRole: null };
  }
}
