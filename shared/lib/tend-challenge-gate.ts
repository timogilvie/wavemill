import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChallengeComparisons, type StoredChallengeComparison } from './challenge-comparison.ts';
import { getChallengeConfig, getChallengeEvalHardFailureRetryMaxAttempts, getChallengeGateConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import { normalizeJobs, type MillJob, type WorkflowStateLike } from './job-tracker.ts';
import { listOpenIssuesByIdentifierPrefix, type LinearIssueSummary } from './linear.ts';
import type { PrMetadata } from './pr-metadata.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { resolveEffectiveChallengeRole } from './challenge-role-utils.ts';
import { hasPendingArms } from './pending-arm-detection.ts';

export type ChallengeRole = 'primary' | 'challenger';
export const UNRESOLVABLE_REASONS = [
  'orphan-sibling',
  'sibling-eval-hard-failed',
  'both-eval-hard-failed',
  'sibling-challenge-aborted',
  'both-challenge-aborted',
] as const;
export type UnresolvableReason = typeof UNRESOLVABLE_REASONS[number];
export type AutoCloseRefusalReason =
  | 'missing_evidence_id'
  | 'missing_or_invalid_comparison'
  | 'missing_winner_pr'
  | 'missing_loser_pr'
  | 'winner_equals_loser'
  | 'non_decisive_comparison'
  | 'pr_identity_mismatch';

export interface AutoCloseEligibilityResult {
  eligible: boolean;
  refusal?: AutoCloseRefusalReason;
}

export interface ChallengeLoserCleanupCandidate {
  loserPr: number;
  winnerPr: number;
  evidenceId: string;
  pairId: string;
}

const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const TASK_IDENTIFIER_PATTERN = /^[A-Z]+-\d+(?:_c)?$/;
const ORPHAN_PAIR_GRACE_MS = 60_000;
const DEFAULT_HARD_FAILURE_RETRY_MAX = 2;
const UNRESOLVABLE_REASON_SET = new Set<string>(UNRESOLVABLE_REASONS);
const warnedInvalidChallengeRoleKeys = new Set<string>();

interface ChallengePairInfo {
  pairId: string;
  role: ChallengeRole;
  issueId: string;
  branch: string | null;
  updatedAt: number | null;
}

export interface TaskEvalState {
  issueId: string;
  prNumber: number | null;
  role: ChallengeRole;
  branch: string | null;
  challengeStage: string | null;
  model: string | null;
  updatedAt: number | null;
  evalFailed: boolean;
  evalCompleted: boolean;
  evalHardFailureRetryCount: number;
  comparisonState: string | null;
  /**
   * Set when an arm hit a terminal launch failure (unknown model ID, prompt
   * larger than the context window). Such an arm never produces a PR, so the
   * eval-based hard-failure signals never fire and the pair would otherwise sit
   * at `pair-unresolved:no-comparison` forever, blocking the merge lane.
   */
  challengeAborted: string | null;
  challengeAbortedDetail: string | null;
  challengeAbortedNextAction: string | null;
  challengeAbortedStage: string | null;
  /** Set to true when the challenger arm is actually launched (P0.6, HOK-2798). */
  challengerLaunched?: boolean;
  /** The missing challenger is still a valid nested deferred arm. */
  hasPendingChallengeArm?: boolean;
}

export interface PairTaskState {
  primary?: TaskEvalState;
  challenger?: TaskEvalState;
}

export interface WorkflowStateChallengeData {
  challengePairMap: Map<number, ChallengePairInfo>;
  taskStateByPair: Map<string, PairTaskState>;
  activeJobsByPair: Map<string, MillJob[]>;
}

interface WorkflowStateTask {
  pr?: unknown;
  branch?: unknown;
  updated?: unknown;
  challengePairId?: unknown;
  challengeRole?: unknown;
  challengeModel?: unknown;
  coderModel?: unknown;
  evalFailed?: unknown;
  evalCompleted?: unknown;
  evalHardFailureRetryCount?: unknown;
  comparisonState?: unknown;
  challengeAborted?: unknown;
  challengerLaunched?: unknown;
  challengeArms?: unknown;
}

type WorkflowStateFile = WorkflowStateLike & {
  tasks?: Record<string, WorkflowStateTask>;
};

interface ChallengeEligiblePr {
  number: number;
  title: string;
  headRefName: string;
  createdAt: string;
  labels: Array<{ name: string }>;
}

export interface ChallengeEligibleWorkItem {
  pr: ChallengeEligiblePr;
  metadata: PrMetadata;
}

export interface ChallengeBlockedCandidate {
  number: number;
  title: string;
  headBranch: string;
  reason: string;
}

export interface ChallengeGateDeps {
  linearSiblingLookup?: (identifierRoot: string) => Promise<LinearIssueSummary[]>;
  branchExists?: (branch: string, repoDir: string) => boolean | Promise<boolean>;
}

interface ChallengeGateRuntimeDeps {
  linearSiblingLookup: (identifierRoot: string) => Promise<LinearIssueSummary[]>;
  branchExists: (branch: string, repoDir: string) => Promise<boolean>;
  linearCache: Map<string, Promise<LinearIssueSummary[]>>;
  branchCache: Map<string, Promise<boolean>>;
}

type PendingSignal =
  | { kind: 'linear-sibling'; value: string }
  | { kind: 'branch-twin'; value: string };

type PendingSignalResult =
  | { kind: 'none' }
  | { kind: 'signals'; signals: PendingSignal[] }
  | { kind: 'lookup-error'; source: 'linear' | 'branch'; message: string };

/** Options for overriding gate behaviour in tests or specialized callers. */
export interface ChallengeGateOptions extends ChallengeGateDeps {
  /** Returns current epoch-ms; defaults to Date.now(). */
  nowMs?: () => number;
  /** Minimum age (seconds) a PR must reach before it is eligible for tend. */
  coolOffSeconds?: number;
  /** Pre-fetched list of remote branch names (skips git ls-remote call). */
  remoteBranches?: string[];
  /** Custom remote-branch lister; replaces the default git ls-remote call. */
  listRemoteBranches?: (repoDir: string) => string[];
}

export interface ChallengeClassificationOptions {
  activeJobsByPair?: Map<string, MillJob[]>;
  taskStateByPair?: Map<string, PairTaskState>;
  evalHardFailureRetryMax?: number;
  siblingLive?: boolean;
  nowMs?: number;
  orphanGraceMs?: number;
}

export type ChallengeGate =
  | { kind: 'not-in-challenge' }
  | { kind: 'pair-unresolved'; pairId: string; otherPr: number | null; reason: string }
  | { kind: 'pair-unresolvable'; pairId: string; otherPr: number | null; reason: UnresolvableReason }
  | { kind: 'cool-off'; reason: string }
  | { kind: 'winner'; pairId: string; loserPr: number | null; autoMerge: boolean }
  | {
      kind: 'loser';
      pairId: string;
      winnerPr: number;
      loserPr: number;
      evidenceId: string;
    };

export function evaluateAutoCloseEligibility(input: {
  loserPr: number | null;
  winnerPr: number | null;
  comparisonOutcome?: string;
  evidenceId?: string;
}): AutoCloseEligibilityResult {
  if (!input.evidenceId) {
    return { eligible: false, refusal: 'missing_evidence_id' };
  }

  if (typeof input.winnerPr !== 'number' || !Number.isInteger(input.winnerPr) || input.winnerPr <= 0) {
    return { eligible: false, refusal: 'missing_winner_pr' };
  }

  if (typeof input.loserPr !== 'number' || !Number.isInteger(input.loserPr) || input.loserPr <= 0) {
    return { eligible: false, refusal: 'missing_loser_pr' };
  }

  if (input.winnerPr === input.loserPr) {
    return { eligible: false, refusal: 'winner_equals_loser' };
  }

  // If no comparisonOutcome is specified, assume it's a decisive comparison (legacy behavior)
  // Only reject if it's explicitly marked as non-decisive
  const outcome = input.comparisonOutcome ?? 'compared';
  const nonDecisiveOutcomes = new Set(['invalid', 'inconclusive', 'invalid_challenge', 'double-forfeit', 'skipped']);
  if (nonDecisiveOutcomes.has(outcome)) {
    return { eligible: false, refusal: 'non_decisive_comparison' };
  }

  return { eligible: true };
}

export function loadWorkflowStateChallengePairs(repoDir: string): Map<number, ChallengePairInfo> {
  return loadWorkflowStateChallengeData(repoDir).challengePairMap;
}

export function loadWorkflowStateChallengeData(repoDir: string): WorkflowStateChallengeData {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(statePath)) {
    return {
      challengePairMap: new Map(),
      taskStateByPair: new Map(),
      activeJobsByPair: new Map(),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowStateFile;
    const tasks = parsed.tasks ?? {};
    const challengePairMap = new Map<number, ChallengePairInfo>();
    const taskStateByPair = new Map<string, PairTaskState>();
    const activeJobsByPair = buildActiveJobsByPair(normalizeJobs(parsed));

    for (const [issueId, task] of Object.entries(tasks)) {
      const prNumber = parseWorkflowStatePr(task.pr);
      if (typeof task.challengePairId === 'string' && task.challengePairId.trim()) {
        const pairId = task.challengePairId.trim();
        const role = resolveEffectiveChallengeRole(issueId, pairId, task.challengeRole);
        if (!role) {
          const warnKey = `${pairId}:${issueId}`;
          if (!warnedInvalidChallengeRoleKeys.has(warnKey)) {
            warnedInvalidChallengeRoleKeys.add(warnKey);
            console.warn(`[tend-challenge-gate] Skipping challenge task ${issueId} for pair ${pairId}: invalid challengeRole ${JSON.stringify(task.challengeRole)}`);
          }
          continue;
        }
        const updatedAt = parseWorkflowStateTimestamp(task.updated);
        const branch = typeof task.branch === 'string' ? task.branch : null;
        const info: ChallengePairInfo = {
          pairId,
          role,
          issueId,
          branch,
          updatedAt,
        };
        if (prNumber !== null) {
          challengePairMap.set(prNumber, info);
        }

        const pairTaskState = taskStateByPair.get(pairId) ?? {};
        pairTaskState[role] = {
          issueId,
          prNumber,
          role,
          branch,
          challengeStage: typeof task.challengeStage === 'string' && task.challengeStage
            ? task.challengeStage
            : null,
          model: stageVariedModel(task),
          updatedAt,
          evalFailed: task.evalFailed === true,
          evalCompleted: task.evalCompleted === true,
          evalHardFailureRetryCount: parseNonNegativeInteger(task.evalHardFailureRetryCount),
          comparisonState: typeof task.comparisonState === 'string' ? task.comparisonState : null,
          challengeAborted: typeof task.challengeAborted === 'string' && task.challengeAborted
            ? task.challengeAborted
            : null,
          challengeAbortedDetail: typeof task.challengeAbortedDetail === 'string' && task.challengeAbortedDetail
            ? task.challengeAbortedDetail
            : null,
          challengeAbortedNextAction: typeof task.challengeAbortedNextAction === 'string' && task.challengeAbortedNextAction
            ? task.challengeAbortedNextAction
            : null,
          challengeAbortedStage: typeof task.challengeAbortedStage === 'string' && task.challengeAbortedStage
            ? task.challengeAbortedStage
            : null,
          challengerLaunched: task.challengerLaunched === true,
          hasPendingChallengeArm: hasPendingArms(task),
        };
        taskStateByPair.set(pairId, pairTaskState);
      }
    }

    return {
      challengePairMap,
      taskStateByPair,
      activeJobsByPair,
    };
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to read workflow-state.json: ${errorMessage(error)}`);
    return {
      challengePairMap: new Map(),
      taskStateByPair: new Map(),
      activeJobsByPair: new Map(),
    };
  }
}

/** True when a pair's challenger is legitimately absent until its fork trigger. */
export function pairHasPendingChallengeArm(pairState: PairTaskState | undefined): boolean {
  return pairState?.primary?.hasPendingChallengeArm === true && !pairState.challenger;
}

function stageVariedModel(task: Record<string, unknown>): string | null {
  const stage = typeof task.challengeStage === 'string' ? task.challengeStage : '';
  if ((stage === 'plan' || stage === 'planning' || stage === 'planner') && typeof task.plannerModel === 'string') {
    return task.plannerModel;
  }
  if ((stage === 'review' || stage === 'reviewer') && typeof task.reviewerModel === 'string') {
    return task.reviewerModel;
  }
  if (typeof task.challengeModel === 'string') {
    return task.challengeModel;
  }
  return typeof task.coderModel === 'string' ? task.coderModel : null;
}

function parseWorkflowStatePr(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

function parseWorkflowStateTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return 0;
}

function buildActiveJobsByPair(jobs: Record<string, MillJob>): Map<string, MillJob[]> {
  const activeJobsByPair = new Map<string, MillJob[]>();
  for (const job of Object.values(jobs)) {
    if (job.pairId && job.status === 'running') {
      const pairJobs = activeJobsByPair.get(job.pairId) ?? [];
      pairJobs.push(job);
      activeJobsByPair.set(job.pairId, pairJobs);
    }
  }
  return activeJobsByPair;
}

export function classifyChallengeState(
  prNumber: number,
  metadata: PrMetadata | null,
  challengePairMap: Map<number, ChallengePairInfo>,
  comparisons: StoredChallengeComparison[],
  autoMerge: boolean,
  allPrNumbers: Set<number>,
  options: ChallengeClassificationOptions = {},
): ChallengeGate {
  const workflowStatePair = challengePairMap.get(prNumber);
  const pairId = metadata?.challengePairId ?? workflowStatePair?.pairId;

  if (!pairId) {
    return { kind: 'not-in-challenge' };
  }

  if (
    metadata?.challengePairId &&
    workflowStatePair?.pairId &&
    metadata.challengePairId !== workflowStatePair.pairId
  ) {
    console.warn(
      `[tend-challenge-gate] PR #${prNumber} pair mismatch: metadata=${metadata.challengePairId} workflow=${workflowStatePair.pairId}`,
    );
  }

  const relevantComparisons = comparisons
    .filter((comparison) => comparison.challengePairId === pairId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (relevantComparisons.length === 0) {
    const otherPr = findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers);
    const pairState = options.taskStateByPair?.get(pairId);
    if (hasRunningComparison(pairId, pairState, options.activeJobsByPair)) {
      return {
        kind: 'pair-unresolved',
        pairId,
        otherPr,
        reason: 'pair-unresolved:comparison-in-progress',
      };
    }

    const hardFailureState = classifyPairUnresolvableState(pairState, options.evalHardFailureRetryMax ?? DEFAULT_HARD_FAILURE_RETRY_MAX);
    if (hardFailureState) {
      return {
        kind: 'pair-unresolvable',
        pairId,
        otherPr,
        reason: hardFailureState,
      };
    }

    if (pairHasPendingChallengeArm(pairState)) {
      return {
        kind: 'pair-unresolved',
        pairId,
        otherPr,
        reason: 'pair-unresolved:challenger-awaiting-fork',
      };
    }

    if (isOrphanedPair(pairState, otherPr, options.siblingLive ?? false, options.nowMs, options.orphanGraceMs)) {
      return {
        kind: 'pair-unresolvable',
        pairId,
        otherPr,
        reason: 'orphan-sibling',
      };
    }

    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr,
      reason: 'pair-unresolved:no-comparison',
    };
  }

  const latestComparison = relevantComparisons[0];
  if (
    latestComparison.comparisonOutcome === 'invalid' ||
    latestComparison.comparisonOutcome === 'inconclusive' ||
    latestComparison.comparisonOutcome === 'invalid_challenge' ||
    latestComparison.invalidChallenge
  ) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: latestComparison.invalidChallenge || latestComparison.comparisonOutcome === 'invalid_challenge'
        ? `pair-unresolved:invalid-challenge:${latestComparison.invalidChallengeReason ?? 'unknown'}`
        : `pair-unresolved:${latestComparison.comparisonOutcome}-comparison`,
    };
  }

  if (latestComparison.comparisonOutcome === 'double-forfeit') {
    return {
      // A double-forfeit deliberately names no winner. Treating both sides as
      // losers sends both PRs to Tend's destructive loser-cleanup path. Keep
      // the work intact for an operator to repair or compare manually.
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: 'pair-unresolved:double-forfeit-comparison',
    };
  }

  if (relevantComparisons.some((comparison) => comparison.winner !== latestComparison.winner)) {
    console.warn(
      `[tend-challenge-gate] Pair ${pairId} has conflicting comparison winners; using latest record at ${latestComparison.timestamp}`,
    );
  }

  const role = resolvePrRole(prNumber, latestComparison, workflowStatePair?.role);
  if (!role) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: 'pair-unresolved:unknown-role',
    };
  }

  const winnerPr = latestComparison.winner === 'primary'
    ? parsePrNumberFromUrl(latestComparison.primaryPrUrl)
    : parsePrNumberFromUrl(latestComparison.challengerPrUrl);
  const loserPr = latestComparison.winner === 'primary'
    ? parsePrNumberFromUrl(latestComparison.challengerPrUrl)
    : parsePrNumberFromUrl(latestComparison.primaryPrUrl);

  if (role === latestComparison.winner) {
    return {
      kind: 'winner',
      pairId,
      loserPr: loserPr ?? findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      autoMerge,
    };
  }

  // Check if we have concrete, distinct winner and loser PRs
  // Missing PR identities must remain operator-actionable and never trigger auto-close
  if (!winnerPr) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: `pair-unresolved:missing-winner:${pairId}`,
    };
  }

  if (!loserPr || winnerPr === loserPr) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: `pair-unresolved:missing-loser:${pairId}`,
    };
  }

  // Validate that we have the eligibility to automatically close based on comparison
  const eligibilityCheck = evaluateAutoCloseEligibility({
    loserPr,
    winnerPr,
    comparisonOutcome: latestComparison.comparisonOutcome,
    evidenceId: latestComparison.timestamp,
  });

  if (!eligibilityCheck.eligible) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: `pair-unresolved:ineligible-close:${eligibilityCheck.refusal ?? 'unknown'}`,
    };
  }

  return {
    kind: 'loser',
    pairId,
    winnerPr,
    loserPr,
    evidenceId: latestComparison.timestamp,
  };
}

export async function applyChallengePairGates<T extends ChallengeEligibleWorkItem>(
  eligibleItems: T[],
  blocked: ChallengeBlockedCandidate[],
  repoDir: string,
  options: ChallengeGateOptions = {},
): Promise<{ eligible: T[]; blocked: ChallengeBlockedCandidate[]; losers: number[]; loserCleanupCandidates: ChallengeLoserCleanupCandidate[] }> {
  const allPrNumbers = new Set([
    ...eligibleItems.map((item) => item.pr.number),
    ...blocked.map((item) => item.number),
  ]);
  const { challengePairMap, taskStateByPair, activeJobsByPair } = loadWorkflowStateChallengeData(repoDir);

  let comparisons: StoredChallengeComparison[];
  try {
    comparisons = readChallengeComparisons(join(repoDir, '.wavemill', 'evals'));
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to read challenge comparisons: ${errorMessage(error)}`);
    comparisons = [];
  }

  const autoMerge = getChallengeConfig(repoDir).autoMergeWinner ?? false;
  const gateConfig = getChallengeGateConfig(repoDir);
  const coolOffSeconds = options.coolOffSeconds ?? gateConfig.coolOffSeconds;
  const nowMs = options.nowMs ?? (() => Date.now());
  const evalHardFailureRetryMax = getChallengeEvalHardFailureRetryMaxAttempts(repoDir);

  const remoteBranches = options.remoteBranches
    ?? (options.listRemoteBranches
      ? options.listRemoteBranches(repoDir)
      : listRemoteTaskBranches(repoDir));
  const remoteBranchSet = new Set(remoteBranches);
  const runtimeDeps = createRuntimeDeps(options, async (branch) => remoteBranchSet.has(branch));

  const nextEligible: T[] = [];
  const nextBlocked = [...blocked];
  const losers = new Set<number>();
  const loserCleanupCandidates: ChallengeLoserCleanupCandidate[] = [];

  for (const item of eligibleItems) {
    const siblingBranch = getSiblingBranch(item.pr.headRefName);
    const hasSiblingBranch = Boolean(siblingBranch && remoteBranchSet.has(siblingBranch));
    const pairInfo = challengePairMap.get(item.pr.number);
    const siblingLive = isSiblingLive({
      hasSiblingBranch,
      openPrNumbers: allPrNumbers,
      pairState: pairInfo ? taskStateByPair.get(pairInfo.pairId) : undefined,
      side: pairInfo?.role ?? 'primary',
    });
    const state = classifyChallengeState(
      item.pr.number,
      item.metadata,
      challengePairMap,
      comparisons,
      autoMerge,
      allPrNumbers,
      {
        activeJobsByPair,
        taskStateByPair,
        evalHardFailureRetryMax,
        siblingLive,
        nowMs,
      },
    );

    if (state.kind === 'not-in-challenge') {
      // Deliberately still keyed on branch existence, not liveness. Without a
      // pairId there is no workflow state to judge the sibling from, so the
      // conservative block stays: an unpaired PR whose twin branch exists may
      // have lost its challenge metadata.
      if (hasSiblingBranch) {
        nextBlocked.push(toBlockedCandidate(item, 'challenge:pair-unresolved:branch-pair'));
        continue;
      }

      const pendingSignals = await detectPendingChallengeSignals(item, repoDir, runtimeDeps);
      if (pendingSignals.kind === 'lookup-error') {
        console.warn(
          `[tend-challenge-gate] Lookup failed for PR #${item.pr.number} (${pendingSignals.source}): ${pendingSignals.message}`,
        );
        nextBlocked.push(toBlockedCandidate(item, `challenge:pair-unresolved:lookup-error:${pendingSignals.source}`));
        continue;
      }

      if (pendingSignals.kind === 'signals') {
        nextBlocked.push(toBlockedCandidate(item, `challenge:${formatPendingSignalReason(pendingSignals.signals)}`));
        continue;
      }

      if (coolOffSeconds > 0 && item.pr.headRefName.startsWith('task/')) {
        const createdMs = Date.parse(item.pr.createdAt);
        if (!Number.isNaN(createdMs) && nowMs() - createdMs < coolOffSeconds * 1000) {
          nextBlocked.push(toBlockedCandidate(item, 'challenge:cool-off'));
          continue;
        }
      }

      nextEligible.push(item);
      continue;
    }

    if (state.kind === 'pair-unresolved') {
      nextBlocked.push(toBlockedCandidate(item, `challenge:${state.reason}`));
      continue;
    }

    if (state.kind === 'pair-unresolvable') {
      nextBlocked.push(toBlockedCandidate(item, `challenge:pair-unresolvable:${state.reason}`));
      continue;
    }

    if (state.kind === 'winner') {
      if (state.autoMerge) {
        nextEligible.push(item);
      } else {
        nextBlocked.push(toBlockedCandidate(item, `challenge:winner-held:${state.pairId}`));
      }
      continue;
    }

    // At this point, state.kind === 'loser' and has passed eligibility checks
    nextBlocked.push(toBlockedCandidate(item, `challenge:loser:${state.pairId}`));
    if (!labelSet(item.pr).has(WM_LABELS.superseded)) {
      losers.add(item.pr.number);
      loserCleanupCandidates.push({
        loserPr: state.loserPr,
        winnerPr: state.winnerPr,
        evidenceId: state.evidenceId,
        pairId: state.pairId,
      });
    }
  }

  return { eligible: nextEligible, blocked: nextBlocked, losers: [...losers], loserCleanupCandidates };
}

function createRuntimeDeps(
  deps: ChallengeGateDeps,
  defaultBranchLookup: (branch: string, repoDir: string) => Promise<boolean>,
): ChallengeGateRuntimeDeps {
  return {
    linearSiblingLookup: deps.linearSiblingLookup ?? defaultLinearSiblingLookup,
    branchExists: async (branch, repoDir) => Boolean(await (deps.branchExists ?? defaultBranchLookup)(branch, repoDir)),
    linearCache: new Map(),
    branchCache: new Map(),
  };
}

async function defaultLinearSiblingLookup(identifierRoot: string): Promise<LinearIssueSummary[]> {
  if (!process.env.LINEAR_API_KEY) {
    return [];
  }

  return await listOpenIssuesByIdentifierPrefix(identifierRoot);
}

function labelSet(pr: ChallengeEligiblePr): Set<string> {
  return new Set(pr.labels.map((label) => label.name));
}

function toBlockedCandidate(item: ChallengeEligibleWorkItem, reason: string): ChallengeBlockedCandidate {
  return {
    number: item.pr.number,
    title: item.pr.title,
    headBranch: item.pr.headRefName,
    reason,
  };
}

function findOtherOpenPr(
  pairId: string,
  prNumber: number,
  challengePairMap: Map<number, ChallengePairInfo>,
  allPrNumbers: Set<number>,
): number | null {
  for (const [candidatePr, pair] of challengePairMap.entries()) {
    if (candidatePr !== prNumber && pair.pairId === pairId && allPrNumbers.has(candidatePr)) {
      return candidatePr;
    }
  }

  return null;
}

function resolvePrRole(
  prNumber: number,
  comparison: StoredChallengeComparison,
  workflowRole: ChallengeRole | undefined,
): ChallengeRole | null {
  const primaryPr = parsePrNumberFromUrl(comparison.primaryPrUrl);
  const challengerPr = parsePrNumberFromUrl(comparison.challengerPrUrl);

  if (primaryPr === prNumber) {
    return 'primary';
  }

  if (challengerPr === prNumber) {
    return 'challenger';
  }

  return workflowRole ?? null;
}

function hasRunningComparison(
  pairId: string,
  pairState: PairTaskState | undefined,
  activeJobsByPair: Map<string, MillJob[]> | undefined,
): boolean {
  const pairJobs = activeJobsByPair?.get(pairId) ?? [];
  if (pairJobs.some((job) => job.kind === 'comparison' && job.status === 'running')) {
    return true;
  }
  return pairState?.primary?.comparisonState === 'comparison_running'
    || pairState?.challenger?.comparisonState === 'comparison_running';
}

export function isUnresolvableReason(value: unknown): value is UnresolvableReason {
  return typeof value === 'string' && UNRESOLVABLE_REASON_SET.has(value);
}

/** Shared unresolvable-pair classifier used by the gate and terminal resolver. */
export function classifyPairUnresolvableState(
  pairState: PairTaskState | undefined,
  retryMax: number,
): UnresolvableReason | null {
  if (!pairState) {
    return null;
  }
  const primaryExhausted = isHardFailureExhausted(pairState.primary, retryMax);
  const challengerExhausted = isHardFailureExhausted(pairState.challenger, retryMax);

  if (primaryExhausted && challengerExhausted) {
    return 'both-eval-hard-failed';
  }
  if (primaryExhausted || challengerExhausted) {
    return 'sibling-eval-hard-failed';
  }

  // A terminally aborted arm is unrecoverable without a fresh launch, so the
  // comparison it was supposed to supply will never arrive.
  const primaryAborted = Boolean(pairState.primary?.challengeAborted);
  const challengerAborted = Boolean(pairState.challenger?.challengeAborted);
  if (primaryAborted && challengerAborted) {
    return 'both-challenge-aborted';
  }
  if (primaryAborted || challengerAborted) {
    return 'sibling-challenge-aborted';
  }
  return null;
}

function isHardFailureExhausted(task: TaskEvalState | undefined, retryMax: number): boolean {
  return Boolean(task?.evalFailed && task.evalHardFailureRetryCount >= retryMax);
}

/**
 * Whether the paired arm is still live.
 *
 * Branch existence alone is a poor proxy. Post-review cleanup deletes a
 * completed task's local branch and worktree but leaves the remote ref, so a
 * merged, cleaned-up sibling looks identical to one still working. Treating
 * that leftover as live kept the survivor's PR at
 * `pair-unresolved:no-comparison` forever instead of reaching a terminal,
 * operator-actionable state.
 *
 * Keyed on PR numbers rather than branch names so every caller can supply the
 * same evidence. Only meaningful for a known pair, where workflow state is the
 * authority on that pair's arms.
 */
export function isSiblingLive(input: {
  hasSiblingBranch: boolean;
  openPrNumbers: ReadonlySet<number>;
  pairState: PairTaskState | undefined;
  side: ChallengeRole;
}): boolean {
  const { hasSiblingBranch, openPrNumbers, pairState, side } = input;

  if (!hasSiblingBranch) {
    return false;
  }

  const sibling = side === 'primary' ? pairState?.challenger : pairState?.primary;
  if (!sibling) {
    // Workflow state no longer tracks the sibling: it completed and was cleaned
    // up. The remote ref is a leftover, not a live arm.
    return false;
  }
  if (sibling.challengeAborted) {
    return false;
  }
  if (sibling.prNumber === null) {
    // Tracked but no PR yet — work in flight.
    return true;
  }
  // Live only while its PR is still in play; a merged or closed one is settled.
  return openPrNumbers.has(sibling.prNumber);
}

function isOrphanedPair(
  pairState: PairTaskState | undefined,
  otherPr: number | null,
  siblingLive: boolean,
  nowMs: (() => number) | undefined,
  orphanGraceMs: number | undefined,
): boolean {
  if (!pairState) {
    return false;
  }
  if (pairState.primary && pairState.challenger) {
    return false;
  }
  if (pairHasPendingChallengeArm(pairState)) {
    return false;
  }
  if (otherPr !== null || siblingLive) {
    return false;
  }
  const loneTask = pairState.primary ?? pairState.challenger;
  if (!loneTask) {
    return false;
  }
  if (loneTask.updatedAt === null) {
    return true;
  }
  const now = nowMs?.() ?? Date.now();
  return now - loneTask.updatedAt >= (orphanGraceMs ?? ORPHAN_PAIR_GRACE_MS);
}

const CHALLENGER_SUFFIX = '-challenger';

/**
 * Returns the paired branch name for a `task/<slug>` or `task/<slug>-challenger` branch.
 * Returns null if the branch does not follow the `task/` naming convention.
 */
export function getSiblingBranch(branch: string): string | null {
  if (!branch.startsWith('task/')) return null;
  if (branch.endsWith(CHALLENGER_SUFFIX)) {
    return branch.slice(0, -CHALLENGER_SUFFIX.length);
  }
  return branch + CHALLENGER_SUFFIX;
}

/**
 * Lists all remote `task/*` branches via `git ls-remote`.
 * Returns an empty array on error so callers degrade gracefully.
 */
export function listRemoteTaskBranches(repoDir: string): string[] {
  try {
    const output = String(execShellCommand(
      `git ls-remote --heads origin ${escapeShellArg('refs/heads/task/*')}`,
      { encoding: 'utf-8', cwd: repoDir },
    ));
    return parseRemoteBranchOutput(output);
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to list remote branches: ${errorMessage(error)}`);
    return [];
  }
}

/**
 * Parses raw `git ls-remote --heads` output into branch name strings.
 * Filters to only `task/`-prefixed names.
 */
export function parseRemoteBranchOutput(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const ref = line.split(/\s+/).pop() ?? '';
      return ref.replace(/^refs\/heads\//, '');
    })
    .filter((name) => name.startsWith('task/'));
}

function parsePrNumberFromUrl(url: string | undefined): number | null {
  if (!url) {
    return null;
  }

  const match = /\/pull\/(\d+)(?:\/|$)/.exec(url);
  if (!match) {
    return null;
  }

  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) ? prNumber : null;
}

async function detectPendingChallengeSignals(
  item: ChallengeEligibleWorkItem,
  repoDir: string,
  deps: ChallengeGateRuntimeDeps,
): Promise<PendingSignalResult> {
  const signals: PendingSignal[] = [];
  const taskRoot = normalizeChallengeIdentifierRoot(item.metadata.task);
  if (taskRoot) {
    try {
      const siblings = await getLinearSiblings(taskRoot, item.metadata.task || null, deps);
      for (const sibling of siblings) {
        signals.push({ kind: 'linear-sibling', value: sibling.identifier });
      }
    } catch (error) {
      return { kind: 'lookup-error', source: 'linear', message: errorMessage(error) };
    }
  } else if (item.metadata.task) {
    console.warn(`[tend-challenge-gate] Skipping Linear sibling lookup for invalid task id "${item.metadata.task}"`);
  }

  const twinBranch = deriveTwinBranch(item.pr.headRefName);
  if (twinBranch) {
    try {
      const exists = await getBranchExistence(twinBranch, repoDir, deps);
      if (exists) {
        signals.push({ kind: 'branch-twin', value: twinBranch });
      }
    } catch (error) {
      return { kind: 'lookup-error', source: 'branch', message: errorMessage(error) };
    }
  }

  return signals.length > 0 ? { kind: 'signals', signals } : { kind: 'none' };
}

async function getLinearSiblings(
  identifierRoot: string,
  currentIdentifier: string | null,
  deps: ChallengeGateRuntimeDeps,
): Promise<LinearIssueSummary[]> {
  let lookup = deps.linearCache.get(identifierRoot);
  if (!lookup) {
    lookup = deps.linearSiblingLookup(identifierRoot);
    deps.linearCache.set(identifierRoot, lookup);
  }

  const siblings = await lookup;
  return siblings.filter((issue) => issue.identifier !== currentIdentifier);
}

async function getBranchExistence(
  branch: string,
  repoDir: string,
  deps: ChallengeGateRuntimeDeps,
): Promise<boolean> {
  const cacheKey = `${repoDir}\u0000${branch}`;
  let lookup = deps.branchCache.get(cacheKey);
  if (!lookup) {
    lookup = deps.branchExists(branch, repoDir);
    deps.branchCache.set(cacheKey, lookup);
  }

  return await lookup;
}

function normalizeChallengeIdentifierRoot(identifier: string | undefined): string | null {
  if (!identifier || !TASK_IDENTIFIER_PATTERN.test(identifier)) {
    return null;
  }

  return identifier.endsWith('_c') ? identifier.slice(0, -2) : identifier;
}

function deriveTwinBranch(headBranch: string): string | null {
  if (!headBranch.startsWith('task/')) {
    return null;
  }

  const slug = headBranch.slice('task/'.length);
  if (!slug || !BRANCH_NAME_PATTERN.test(headBranch)) {
    return null;
  }

  return slug.endsWith('-challenger')
    ? `task/${slug.slice(0, -'-challenger'.length)}`
    : `task/${slug}-challenger`;
}

function formatPendingSignalReason(signals: PendingSignal[]): string {
  return `pair-unresolved:${signals.map((signal) => `${signal.kind}:${signal.value}`).join('+')}`;
}
