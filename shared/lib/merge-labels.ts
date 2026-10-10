/**
 * Merge label reconciler (HOK-3181)
 *
 * wm:ready / wm:blocked are a render of task state. This module derives the
 * correct label every tick and reconciles it with the GitHub label, never
 * trusting the latched label.
 *
 * See CLAUDE.md for the full invariant.
 */

export interface MergeLabelTaskView {
  prNumber: number;
  headSha: string;
  phase: string; // 'planning' | 'coding' | 'review' | 'ready' | 'merged' | …
  challengeRole?: 'primary' | 'challenger';
  linearIssueId?: string;
  featureDir: string;
}

export interface MergeLabelLiveState {
  prHeadSha: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string; // 'CLEAN' | 'BLOCKED' | 'DIRTY' | …
  statusCheckRollup: readonly { name: string; conclusion: string; status: string }[];
  readyAtHead?: {
    verdict: 'ready' | 'not-ready' | 'running' | 'errored';
    sha: string;
  };
  handoffAtHead?: {
    state: 'checked' | 'ready-published' | 'tend-claimed' | 'terminal';
    headSha: string;
    prNumber: number;
  };
}

export type MergeLabelDecision =
  | { label: 'wm:ready' }
  | { label: 'wm:blocked'; reason: string }
  | { label: null; reason?: string };

/**
 * Pure function to derive the correct merge label for a PR.
 *
 * Rules (exhaustive, ordered - first match wins):
 * 1. Live PR head ≠ task head → null (not stable)
 * 2. Live PR head ≠ readyAtHead.sha → null (Ready evidence for different head)
 * 3. Ready verdict is errored/not-ready → wm:blocked
 * 4. Ready verdict is running or missing → null (not yet decided)
 * 5. Ready verdict is ready but CI failing/conflict/dirty → wm:blocked
 * 6. Ready verdict is ready but checks still pending → null (not stable)
 * 7. Ready verdict is ready, all green, handoff exists → wm:ready
 * 8. Fallthrough → null
 */
export function deriveMergeLabel(
  task: MergeLabelTaskView,
  pr: { number: number; labels: readonly string[]; headSha: string },
  liveState: MergeLabelLiveState,
): MergeLabelDecision {
  // Rule 1: Live PR head ≠ task head → not stable
  if (liveState.prHeadSha !== task.headSha) {
    return { label: null, reason: 'head-mismatch' };
  }

  // Rule 2: Live PR head ≠ readyAtHead.sha → Ready evidence for different head
  if (liveState.readyAtHead && liveState.readyAtHead.sha !== liveState.prHeadSha) {
    return { label: null, reason: 'ready-evidence-stale' };
  }

  // Rule 3: Ready verdict is errored or not-ready → blocked
  if (liveState.readyAtHead?.verdict === 'errored') {
    return { label: 'wm:blocked', reason: 'ready-errored' };
  }
  if (liveState.readyAtHead?.verdict === 'not-ready') {
    return { label: 'wm:blocked', reason: 'ready-not-ready' };
  }

  // Rule 4: Ready verdict is running or missing → not yet decided
  if (!liveState.readyAtHead || liveState.readyAtHead.verdict === 'running') {
    return { label: null, reason: 'ready-pending' };
  }

  // At this point, Ready verdict must be 'ready'
  if (liveState.readyAtHead.verdict !== 'ready') {
    return { label: null, reason: 'ready-unknown' };
  }

  // Rule 5: Ready is ready, but merge state or CI is blocked
  if (liveState.mergeStateStatus === 'BLOCKED') {
    return { label: 'wm:blocked', reason: 'merge-state-blocked' };
  }
  if (liveState.mergeStateStatus === 'DIRTY') {
    return { label: 'wm:blocked', reason: 'merge-state-dirty' };
  }
  if (liveState.mergeStateStatus === 'UNKNOWN') {
    return { label: 'wm:blocked', reason: 'merge-state-unknown' };
  }

  if (liveState.mergeable === 'CONFLICTING') {
    return { label: 'wm:blocked', reason: 'merge-conflict' };
  }
  if (liveState.mergeable === 'UNKNOWN') {
    return { label: 'wm:blocked', reason: 'mergeable-unknown' };
  }

  // Check for failing or cancelled checks
  const hasFailingChecks = liveState.statusCheckRollup.some(
    (check) =>
      check.conclusion === 'FAILURE' ||
      check.conclusion === 'CANCELLED' ||
      check.conclusion === 'TIMED_OUT',
  );
  if (hasFailingChecks) {
    return { label: 'wm:blocked', reason: 'ci-failing' };
  }

  // Rule 6: Ready is ready, all green, but checks still pending
  const hasPendingChecks = liveState.statusCheckRollup.some(
    (check) => check.status !== 'COMPLETED',
  );
  if (hasPendingChecks) {
    return { label: null, reason: 'checks-pending' };
  }

  // Rule 7: Ready is ready, all checks pass, mergeable, and handoff exists
  if (
    liveState.mergeable === 'MERGEABLE' &&
    liveState.handoffAtHead &&
    liveState.handoffAtHead.headSha === liveState.prHeadSha
  ) {
    return { label: 'wm:ready' };
  }

  // Rule 8: Fallthrough
  return { label: null, reason: 'no-handoff' };
}

/**
 * Dependencies for the merge label reconciler. Injected to keep the reconciler
 * testable and pure.
 */
export interface ReconcileMergeLabelsDeps {
  readTaskView(prNumber: number): Promise<MergeLabelTaskView | null>;
  probeLiveState(prNumber: number): Promise<MergeLabelLiveState>;
  applyLabel: {
    setReady(prNumber: number, reason?: string): Promise<void>;
    setBlocked(prNumber: number, reason: string): Promise<void>;
    clear(prNumber: number): Promise<void>;
  };
  logger: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
  };
}

/**
 * Reconciles the merge label for a single PR. Derives the correct label from
 * task state, compares with current labels, and applies the difference.
 *
 * Returns the decision, or null if task view could not be read.
 */
export async function reconcileMergeLabelsForPr(
  pr: { number: number; labels: readonly string[]; headSha: string },
  deps: ReconcileMergeLabelsDeps,
): Promise<MergeLabelDecision | null> {
  const task = await deps.readTaskView(pr.number);
  if (!task) {
    // PR is not a wavemill PR or task view not available
    return null;
  }

  const liveState = await deps.probeLiveState(pr.number);
  const decision = deriveMergeLabel(task, pr, liveState);

  const currentLabels = new Set(pr.labels);
  const hasReady = currentLabels.has('wm:ready');
  const hasBlocked = currentLabels.has('wm:blocked');

  // Determine what needs to change
  if (decision.label === 'wm:ready') {
    if (hasReady && !hasBlocked) {
      // Already correct, no-op
      return decision;
    }
    deps.logger.info('Reconciling merge label to wm:ready', {
      pr: pr.number,
      before: hasBlocked ? 'wm:blocked' : hasReady ? 'wm:ready' : 'none',
      after: 'wm:ready',
    });
    await deps.applyLabel.setReady(pr.number);
    return decision;
  }

  if (decision.label === 'wm:blocked') {
    if (hasBlocked && !hasReady) {
      // Already correct, no-op
      return decision;
    }
    deps.logger.info('Reconciling merge label to wm:blocked', {
      pr: pr.number,
      before: hasReady ? 'wm:ready' : hasBlocked ? 'wm:blocked' : 'none',
      after: 'wm:blocked',
      reason: decision.reason,
    });
    await deps.applyLabel.setBlocked(pr.number, decision.reason);
    return decision;
  }

  // decision.label === null
  if (hasReady || hasBlocked) {
    deps.logger.info('Clearing merge label (not stable)', {
      pr: pr.number,
      before: hasReady ? 'wm:ready' : 'wm:blocked',
      after: 'none',
      reason: decision.reason,
    });
    await deps.applyLabel.clear(pr.number);
  }

  return decision;
}
