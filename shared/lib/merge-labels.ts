/**
 * Merge label reconciler (HOK-3181)
 *
 * wm:ready / wm:blocked are a render of task state. This module derives the
 * correct label every tick and reconciles it with the GitHub label, never
 * trusting the latched label.
 *
 * See CLAUDE.md for the full invariant.
 */

import { readStageResult } from './stage-result.ts';
import {
  readReadyTendHandoff,
} from './ready-tend-handoff.ts';
import { probePrLiveState, type PrLiveState } from './pr-live-state.ts';
import {
  setWavemillReady,
  setWavemillBlocked,
  clearWavemillState,
} from './pr-state-labels.ts';
import { parseTaskId } from './task-identity.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkflowState, type WorkflowState } from './workflow-state.ts';
import { resolvePrTask } from './pr-task-resolver.ts';

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
 * Returns an object with the decision and the updated label set.
 */
export async function reconcileMergeLabelsForPr(
  pr: { number: number; labels: readonly string[]; headSha: string },
  deps: ReconcileMergeLabelsDeps,
): Promise<{ decision: MergeLabelDecision | null; updatedLabels: string[]; noTaskView?: boolean }> {
  const task = await deps.readTaskView(pr.number);
  if (!task) {
    // PR is not a wavemill PR or task view not available - fail loudly
    deps.logger.warn(`[merge-label] no task view for #${pr.number}`);
    return { decision: { label: null, reason: 'no-task-view' }, updatedLabels: [...pr.labels], noTaskView: true };
  }

  const liveState = await deps.probeLiveState(pr.number);
  const decision = deriveMergeLabel(task, pr, liveState);

  const currentLabels = new Set(pr.labels);
  const hasReady = currentLabels.has('wm:ready');
  const hasBlocked = currentLabels.has('wm:blocked');

  // Compute updated labels after reconciliation
  let updatedLabels = [...pr.labels];

  // Determine what needs to change
  if (decision.label === 'wm:ready') {
    if (hasReady && !hasBlocked) {
      // Already correct, no-op
      return { decision, updatedLabels };
    }
    deps.logger.info('Reconciling merge label to wm:ready', {
      pr: pr.number,
      before: hasBlocked ? 'wm:blocked' : hasReady ? 'wm:ready' : 'none',
      after: 'wm:ready',
    });
    await deps.applyLabel.setReady(pr.number);
    // Update in-memory labels
    updatedLabels = updatedLabels.filter(l => l !== 'wm:blocked');
    if (!hasReady) {
      updatedLabels.push('wm:ready');
    }
    return { decision, updatedLabels };
  }

  if (decision.label === 'wm:blocked') {
    if (hasBlocked && !hasReady) {
      // Already correct, no-op
      return { decision, updatedLabels };
    }
    deps.logger.info('Reconciling merge label to wm:blocked', {
      pr: pr.number,
      before: hasReady ? 'wm:ready' : hasBlocked ? 'wm:blocked' : 'none',
      after: 'wm:blocked',
      reason: decision.reason,
    });
    await deps.applyLabel.setBlocked(pr.number, decision.reason);
    // Update in-memory labels
    updatedLabels = updatedLabels.filter(l => l !== 'wm:ready');
    if (!hasBlocked) {
      updatedLabels.push('wm:blocked');
    }
    return { decision, updatedLabels };
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
    // Update in-memory labels
    updatedLabels = updatedLabels.filter(l => l !== 'wm:ready' && l !== 'wm:blocked');
  } else {
    // HOK-3242: always log the no-label reason so a reader can see which
    // null branch (`head-mismatch`, `ready-evidence-stale`, `ready-pending`,
    // `ready-unknown`, `checks-pending`, `no-handoff`) kept `wm:ready` off.
    deps.logger.info('Merge label unchanged (not stable)', {
      pr: pr.number,
      labels: [...pr.labels],
      reason: decision.reason,
    });
  }

  return { decision, updatedLabels };
}

/**
 * Build task view from workflow state for a given PR number.
 * Returns null if the PR is not tracked in workflow state.
 *
 * Task records carry `pr` (string), `slug`, `worktree` (abs path) — see
 * `TaskRecord`. No writer sets `prNumber`, `headSha` or `featureDir`
 * (HOK-3181 read them and never matched a task, HOK-3212), so the view
 * derives them here.
 *
 * @internal Exported for testing only
 */
export function findTaskInState(
  prNumber: number,
  state: WorkflowState,
  repoDir: string,
): MergeLabelTaskView | null {
  // HOK-3242: route the PR → task lookup through the shared resolver so
  // every miss (empty state, no row with that PR, worktree/slug blank, no
  // feature dir) emits one structured warn line. The resolver returns the
  // task row + featureDir; local derivations below layer `headSha` and
  // `challengeRole` on top.
  const { location } = resolvePrTask(prNumber, state, {
    site: 'merge-label.findTaskInState',
  });
  if (!location) {
    return null;
  }

  // Derive challengeRole from taskId using parseTaskId
  const parsed = parseTaskId(location.taskId);
  const challengeRole = parsed ? parsed.role : undefined;

  // Derive headSha from the Ready artifact; empty when it is unavailable.
  let headSha = '';
  const readyResultPath = join(location.featureDir, '.ready-result.json');
  try {
    const readyResultContent = readFileSync(readyResultPath, 'utf-8');
    const readyResult = JSON.parse(readyResultContent) as { artifacts?: { readyHeadSha?: string } };
    if (readyResult.artifacts?.readyHeadSha) {
      headSha = readyResult.artifacts.readyHeadSha;
    }
  } catch (err) {
    // ENOENT is the expected "no Ready result yet" case; a parse/other
    // error is the HOK-3242 case we want visible so a malformed artifact
    // never silently reduces to an empty headSha.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[merge-label] evidence-read-failed site=findTaskInState path=${readyResultPath} error=${String(err)}`,
      );
    }
  }

  return {
    prNumber,
    headSha,
    phase: typeof location.task.phase === 'string' ? location.task.phase : 'unknown',
    challengeRole,
    linearIssueId: typeof location.task.linearIssueId === 'string' ? location.task.linearIssueId : undefined,
    featureDir: location.featureDir,
  };
}

export async function buildTaskView(
  prNumber: number,
  repoDir: string,
): Promise<MergeLabelTaskView | null> {
  const state = readWorkflowState(join(repoDir, '.wavemill', 'workflow-state.json'));
  return state ? findTaskInState(prNumber, state, repoDir) : null;
}

/**
 * Build complete live state for a PR, including GitHub state, Ready result, and handoff.
 * The prHeadSha comes from the PR object passed by the caller.
 */
export async function buildMergeLabelLiveState(
  prNumber: number,
  prHeadSha: string,
  featureDir: string | undefined,
  repoDir: string,
): Promise<MergeLabelLiveState | null> {
  const prLiveState = await probePrLiveState(prNumber, repoDir);
  if (!prLiveState.available) {
    return null;
  }

  return {
    prHeadSha,
    mergeable: (prLiveState.mergeable?.toUpperCase() as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN') ?? 'UNKNOWN',
    mergeStateStatus: prLiveState.mergeStateStatus ?? 'UNKNOWN',
    statusCheckRollup: prLiveState.statusCheckRollup ?? [],
    ...(featureDir ? await readMergeLabelEvidence(featureDir) : {}),
  };
}

/**
 * Read the task-side evidence the label is derived from: the Ready stage
 * result (verdict + the head it was computed at) and the Ready→tend handoff.
 */
export async function readMergeLabelEvidence(
  featureDir: string,
): Promise<Pick<MergeLabelLiveState, 'readyAtHead' | 'handoffAtHead'>> {
  let readyAtHead: MergeLabelLiveState['readyAtHead'] | undefined;
  let handoffAtHead: MergeLabelLiveState['handoffAtHead'] | undefined;

  try {
    const readyResult = await readStageResult({ featureDir, stage: 'ready' });
    if (readyResult) {
      const artifacts = readyResult.artifacts?.type === 'ready' ? readyResult.artifacts : undefined;
      let verdict: 'ready' | 'not-ready' | 'running' | 'errored';
      if (readyResult.status === 'running') {
        verdict = 'running';
      } else if (artifacts?.verdict === 'pass') {
        verdict = 'ready';
      } else if (artifacts?.verdict === 'fail') {
        verdict = 'not-ready';
      } else {
        // status completed/failed with no verdict, or other states
        verdict = 'errored';
      }
      readyAtHead = { verdict, sha: artifacts?.readyHeadSha ?? '' };
    }
  } catch (err) {
    // readStageResult already stderr-logs its own first-level failures and
    // returns null on them, so a throw past it is a post-parse exception
    // (e.g. derivation threw on a surprising artifact shape). Surface those.
    console.warn(
      `[merge-label] evidence-read-failed site=readMergeLabelEvidence.ready featureDir=${featureDir} error=${String(err)}`,
    );
  }

  try {
    const handoffRecord = readReadyTendHandoff(featureDir);
    if (handoffRecord) {
      handoffAtHead = {
        state: handoffRecord.state,
        headSha: handoffRecord.headSha,
        prNumber: handoffRecord.prNumber,
      };
    }
  } catch (err) {
    // readReadyTendHandoff already returns null on malformed/missing files;
    // a throw past it is unexpected. Surface rather than swallow.
    console.warn(
      `[merge-label] evidence-read-failed site=readMergeLabelEvidence.handoff featureDir=${featureDir} error=${String(err)}`,
    );
  }

  return { readyAtHead, handoffAtHead };
}

/**
 * Create default dependencies for the reconciler using real implementations.
 * The prHeadShaByNumber map is passed from the caller (tend-controller) since
 * we need the live GitHub head, not just what's in workflow state.
 */
export function createDefaultReconcilerDeps(
  repoDir: string,
  prHeadShaByNumber: Map<number, string>,
  workflowState: WorkflowState,
): ReconcileMergeLabelsDeps {
  return {
    readTaskView: async (prNumber) => findTaskInState(prNumber, workflowState, repoDir),
    probeLiveState: async (prNumber) => {
      const task = findTaskInState(prNumber, workflowState, repoDir);
      const prHeadSha = prHeadShaByNumber.get(prNumber);
      if (!task || !prHeadSha) {
        return {
          prHeadSha: prHeadSha ?? '',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN',
          statusCheckRollup: [],
        };
      }
      const liveState = await buildMergeLabelLiveState(prNumber, prHeadSha, task.featureDir, repoDir);
      return liveState ?? {
        prHeadSha,
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        statusCheckRollup: [],
      };
    },
    applyLabel: {
      setReady: async (prNumber) => {
        setWavemillReady(prNumber, { markerRoot: repoDir });
      },
      setBlocked: async (prNumber, reason) => {
        setWavemillBlocked(prNumber, { reason }, { markerRoot: repoDir });
      },
      clear: async (prNumber) => {
        clearWavemillState(prNumber, { markerRoot: repoDir });
      },
    },
    logger: {
      info: (msg, meta) => console.log(msg, meta ? JSON.stringify(meta) : ''),
      warn: (msg, meta) => console.warn(msg, meta ? JSON.stringify(meta) : ''),
    },
  };
}

/**
 * Report returned by {@link reconcileMergeLabels} so decision-level callers
 * (tend `getInitialBlockReason`) can thread the reconciler's per-PR reason
 * into their own output instead of the generic `ready-failed:not-ready`
 * (HOK-3242).
 */
export interface ReconcileReport {
  decisionByPr: Map<number, MergeLabelDecision>;
  noTaskViewPrs: number[];
}

/**
 * Reconcile labels for all wavemill PRs. Called once per tend tick.
 * Updates the PR objects in-place with reconciled labels and returns the
 * per-PR decision so the caller can surface the specific no-label reason.
 */
export async function reconcileMergeLabels(
  prs: Array<{ number: number; labels: string[]; headSha: string }>,
  repoDir: string,
): Promise<ReconcileReport> {
  const prHeadShaByNumber = new Map(prs.map(pr => [pr.number, pr.headSha]));

  // Read workflow state once for all PRs
  const stateFile = join(repoDir, '.wavemill', 'workflow-state.json');
  const workflowState = readWorkflowState(stateFile);
  if (!workflowState) {
    console.warn('Failed to read workflow state', { stateFile });
  }

  const deps = createDefaultReconcilerDeps(repoDir, prHeadShaByNumber, workflowState ?? {});
  const decisionByPr = new Map<number, MergeLabelDecision>();
  const noTaskViewPrs: number[] = [];

  for (const pr of prs) {
    try {
      const result = await reconcileMergeLabelsForPr(pr, deps);
      // Update PR labels in-place so downstream code sees reconciled truth
      pr.labels = result.updatedLabels;

      if (result.decision) {
        decisionByPr.set(pr.number, result.decision);
      }

      // Track PRs with no task view
      if (result.noTaskView) {
        noTaskViewPrs.push(pr.number);
      }

    } catch (error) {
      deps.logger.warn(`Failed to reconcile labels for PR ${pr.number}`, { error: String(error) });
    }
  }

  // Emit aggregated warning for PRs with no task view
  if (noTaskViewPrs.length > 0) {
    const prList = noTaskViewPrs.map(n => `#${n}`).join(', ');
    deps.logger.warn(`[merge-label] no task view for PRs: ${prList}`);
  }

  return { decisionByPr, noTaskViewPrs };
}
