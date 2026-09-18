/**
 * Tend worktree preparation state management.
 *
 * Tracks in-flight merge-lane state during worktree prep/rebase/push phases.
 * On restart, reconciles persisted state with live git/GitHub state and recovers
 * to a safe retryable state or fails closed when mutation status is uncertain.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutateJsonState } from './state-mutex.ts';
import { mergeLaneStateDir } from './merge-queue.ts';
import { execShellCommand, escapeShellArg } from './shell-utils.ts';
import { execArgvCommand } from './shell-utils.ts';

export type TendMergePhase =
  | 'claimed'
  | 'worktree-reap'
  | 'worktree-fetch'
  | 'worktree-add'
  | 'rebase-local'
  | 'push'
  | 'awaiting-checks'
  | 'merging';

export interface TendInflightRecord {
  version: 1;
  prNumber: number;
  headBranch: string;
  headSha: string;
  featureDir?: string;
  phase: TendMergePhase;
  startedAt: string;
  updatedAt: string;
  pid: number;
  activePgid?: number;
  prePushSha?: string;
  intendedHeadSha?: string;
  recovery?: 'uncertain';
  recoveryReason?: string;
}

export type ReconcileOutcome =
  | 'none'
  | 'held-live-process'
  | 'released-retryable'
  | 'released-blocked'
  | 'completed-merged'
  | 'recovery-uncertain';

export interface TendPrepStateDeps {
  readPrHeadSha: (prNumber: number, repoDir: string) => Promise<string | null>;
  readPrMergeState: (prNumber: number, repoDir: string) => Promise<'MERGED' | 'OPEN' | null>;
  restoreWmReady: (prNumber: number) => void;
  restoreWmBlocked: (prNumber: number, reason: string) => void;
  restoreWmMerging: (prNumber: number) => void;
  addPrComment: (prNumber: number, body: string) => Promise<void>;
  shellRunner?: (cmd: string, opts?: { encoding?: string; cwd?: string; timeout?: number }) => string;
}

/**
 * Get the path to the merge-lane inflight marker.
 */
function getInflightMarkerPath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'merge-lane', 'tend-inflight.json');
}

/**
 * Read the current inflight marker, if any.
 */
export function readInflightMarker(repoDir: string): TendInflightRecord | null {
  const markerPath = getInflightMarkerPath(repoDir);
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    const content = readFileSync(markerPath, 'utf-8');
    return JSON.parse(content) as TendInflightRecord;
  } catch {
    return null;
  }
}

/**
 * Write the inflight marker before a side effect.
 */
export async function writeInflightMarker(
  repoDir: string,
  record: TendInflightRecord,
): Promise<void> {
  const markerPath = getInflightMarkerPath(repoDir);
  await mutateJsonState(
    markerPath,
    () => record,
    { createIfMissing: true, initial: record },
  );
}

/**
 * Advance the phase in the inflight marker.
 */
export async function advanceInflightPhase(
  repoDir: string,
  newPhase: TendMergePhase,
): Promise<void> {
  const markerPath = getInflightMarkerPath(repoDir);
  await mutateJsonState<TendInflightRecord>(
    markerPath,
    (current) => {
      if (!current) return current;
      return {
        ...current,
        phase: newPhase,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

/**
 * Record the active process group ID for a running prep command.
 */
export async function recordActivePgid(
  repoDir: string,
  pgid: number | undefined,
): Promise<void> {
  const markerPath = getInflightMarkerPath(repoDir);
  await mutateJsonState<TendInflightRecord>(
    markerPath,
    (current) => {
      if (!current) return current;
      return {
        ...current,
        activePgid: pgid,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

/**
 * Record the SHAs before a push operation.
 */
export async function recordPrePushShas(
  repoDir: string,
  prePushSha: string,
  intendedHeadSha: string,
): Promise<void> {
  const markerPath = getInflightMarkerPath(repoDir);
  await mutateJsonState<TendInflightRecord>(
    markerPath,
    (current) => {
      if (!current) return current;
      return {
        ...current,
        prePushSha,
        intendedHeadSha,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

/**
 * Clear the inflight marker (terminal path).
 */
export async function clearInflightMarker(repoDir: string): Promise<void> {
  const markerPath = getInflightMarkerPath(repoDir);
  await mutateJsonState<null>(
    markerPath,
    () => null,
  );
}

/**
 * Mark the inflight record as uncertain recovery (fail closed).
 */
export async function markRecoveryUncertain(
  repoDir: string,
  reason: string,
): Promise<void> {
  const markerPath = getInflightMarkerPath(repoDir);
  await mutateJsonState<TendInflightRecord>(
    markerPath,
    (current) => {
      if (!current) return current;
      return {
        ...current,
        recovery: 'uncertain',
        recoveryReason: reason,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

/**
 * Check if a process is still alive using kill -0.
 * Permission denied (EPERM) means the process exists, so return true.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // Check for EPERM (permission denied) which means the process exists
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Kill a process group, with SIGTERM → SIGKILL escalation.
 */
function killProcessGroup(pgid: number): void {
  if (pgid <= 1) return; // Safety: never kill process group 1 (init)
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // Already dead
  }
  // Wait a short time for graceful termination
  setTimeout(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already dead
    }
  }, 2000);
}

/**
 * Pre-mutation phases are those where no remote mutation has occurred.
 */
function isPreMutationPhase(phase: TendMergePhase): boolean {
  return ['claimed', 'worktree-reap', 'worktree-fetch', 'worktree-add', 'rebase-local'].includes(phase);
}

const TEND_PREP_RECOVERY_BUCKET = 'tend-prep-recovery';
const TEND_PREP_RECOVERY_MAX_ATTEMPTS = 2;
const BOUNDED_RETRY_HELPER_TIMEOUT_MS = 30_000;
const BOUNDED_RETRY_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bounded-retry.sh');

/**
 * Run a bounded-retry shell command.
 */
function runBoundedRetryHelper(repoDir: string, invocation: string): string {
  const result = execArgvCommand(
    'bash',
    ['-c', `source ${escapeShellArg(BOUNDED_RETRY_HELPER_PATH)} && ${invocation}`],
    { cwd: repoDir, encoding: 'utf-8', timeout: BOUNDED_RETRY_HELPER_TIMEOUT_MS },
  );
  if (result.failed) {
    throw new Error(`bounded-retry helper unavailable: ${result.stderr || 'bash not found'}`);
  }
  return result.stdout.trim();
}

/**
 * Reconcile inflight state on startup.
 *
 * Returns the outcome and performs necessary cleanup/remediation.
 */
export async function reconcileTendInflightState(
  repoDir: string,
  prNumber: number,
  deps: TendPrepStateDeps,
): Promise<ReconcileOutcome> {
  const marker = readInflightMarker(repoDir);

  if (!marker) {
    return 'none';
  }

  // If marker is for a different PR, skip reconciliation (shouldn't happen with singleton marker)
  if (marker.prNumber !== prNumber) {
    return 'none';
  }

  // Check if the marker's process is still live (and not this current process)
  // If it's this process that crashed and restarted, we should reconcile.
  // But if it's a different process, don't touch it.
  if (marker.pid !== process.pid) {
    if (isProcessAlive(marker.pid)) {
      return 'held-live-process';
    }
  }

  // Kill any recorded live process group from the dead process
  if (marker.activePgid) {
    killProcessGroup(marker.activePgid);
  }

  const phase = marker.phase;

  if (isPreMutationPhase(phase)) {
    // Pre-mutation: safe to retry using bounded-retry helper
    const stateDir = mergeLaneStateDir(prNumber, repoDir);
    const decision = runBoundedRetryHelper(
      repoDir,
      `bounded_retry_gate ${escapeShellArg(stateDir)} ${escapeShellArg(TEND_PREP_RECOVERY_BUCKET)} `
      + `${escapeShellArg(marker.headSha)} ${TEND_PREP_RECOVERY_MAX_ATTEMPTS}`,
    );

    if (decision === 'exhausted' || decision === 'exhausted-quiet') {
      // Exhausted: block the PR
      deps.restoreWmBlocked(prNumber, `Worktree preparation retry budget exhausted at ${phase} phase`);
      await clearInflightMarker(repoDir);
      return 'released-blocked';
    } else if (decision === 'proceed') {
      // Not exhausted: release to retryable
      deps.restoreWmReady(prNumber);
      await clearInflightMarker(repoDir);
      return 'released-retryable';
    } else {
      // backoff or unknown: treat as blocked to be safe
      deps.restoreWmBlocked(prNumber, `Unexpected retry gate decision: ${decision} at ${phase} phase`);
      await clearInflightMarker(repoDir);
      return 'released-blocked';
    }
  }

  if (phase === 'push' || phase === 'awaiting-checks') {
    // Check remote state to see if push completed
    const remoteHead = await deps.readPrHeadSha(prNumber, repoDir);

    if (remoteHead === null) {
      // Cannot determine remote state; fail closed
      await markRecoveryUncertain(
        repoDir,
        `Could not verify PR head after ${phase} phase (API unavailable)`,
      );
      return 'recovery-uncertain';
    }

    if (remoteHead === marker.prePushSha) {
      // Push never landed; pre-mutation path
      deps.restoreWmReady(prNumber);
      await clearInflightMarker(repoDir);
      return 'released-retryable';
    }

    if (remoteHead === marker.intendedHeadSha) {
      // Push landed, no merge ran; safe to retry at new head
      deps.restoreWmReady(prNumber);
      await clearInflightMarker(repoDir);
      return 'released-retryable';
    }

    // Head is something else; fail closed
    await markRecoveryUncertain(
      repoDir,
      `PR head is ${remoteHead?.substring(0, 8)}, expected ${marker.intendedHeadSha?.substring(0, 8)}; remote mutation status uncertain`,
    );
    return 'recovery-uncertain';
  }

  if (phase === 'merging') {
    // Check if PR was actually merged
    const mergeState = await deps.readPrMergeState(prNumber, repoDir);

    if (mergeState === 'MERGED') {
      // Merge completed; just mark done
      await clearInflightMarker(repoDir);
      return 'completed-merged';
    }

    if (mergeState === 'OPEN') {
      // Still open; check head
      const remoteHead = await deps.readPrHeadSha(prNumber, repoDir);
      if (remoteHead === marker.intendedHeadSha) {
        // Head matches; safe to retry
        deps.restoreWmReady(prNumber);
        await clearInflightMarker(repoDir);
        return 'released-retryable';
      }
    }

    // Fail closed: uncertain state
    await markRecoveryUncertain(
      repoDir,
      `PR merge state unclear after ${phase} phase; could not determine if merge succeeded`,
    );
    return 'recovery-uncertain';
  }

  return 'none';
}

/**
 * Pre-flux check: if there's an unresolved uncertain recovery marker, don't proceed.
 */
export function checkRecoveryBlocker(repoDir: string): { blocked: boolean; reason?: string } {
  const marker = readInflightMarker(repoDir);
  if (marker?.recovery === 'uncertain') {
    return {
      blocked: true,
      reason: marker.recoveryReason || 'Recovery from previous attempt is uncertain',
    };
  }
  return { blocked: false };
}
