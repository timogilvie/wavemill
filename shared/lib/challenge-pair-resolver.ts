import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChallengeEvalHardFailureRetryMaxAttempts } from './config.ts';
import { mutateJsonState } from './state-mutex.ts';
import {
  appendChallengeComparison,
  buildDoubleForfeitComparison,
  buildForfeitComparison,
  isDecisiveChallengeComparison,
  readDecisiveChallengeComparisons,
  type ChallengeComparison,
} from './challenge-comparison.ts';
import {
  getSiblingBranch,
  classifyPairUnresolvableState,
  isSiblingLive,
  listRemoteTaskBranches,
  loadWorkflowStateChallengeData,
  type PairTaskState,
  type TaskEvalState,
  type UnresolvableReason,
} from './tend-challenge-gate.ts';
import {
  classifyArmFault,
  describeArmFailure,
  parseAbortFailureKind,
  type ChallengeArmFailure,
} from './arm-failure-taxonomy.ts';
import { repairChallengePairingSync } from './challenge-pairing-repair.ts';
import { hasPendingArms } from './pending-arm-detection.ts';
import {
  recordSelectionOutcome,
  releaseReservation,
} from './challenge-selection-health.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';

const ORPHAN_PAIR_GRACE_MS = 60_000;
const UNKNOWN_PR_NUMBER = 0;
const UNKNOWN_MODEL = 'unknown';
const PRIMARY_MERGED_REASON = 'Primary already merged as PR';

type PrimaryMergedReason = 'primary_merged';

export interface UnresolvablePairInput {
  pairId: string;
  repoDir: string;
  reason?: UnresolvableReason;
  dryRun?: boolean;
  now?: () => Date;
  remoteBranches?: string[];
  listRemoteBranches?: (repoDir: string) => string[];
}

export interface PrimaryMergedInput {
  pairId: string;
  primaryPr: number;
  repoDir: string;
  dryRun?: boolean;
  now?: () => Date;
}

export type ResolveOutcome =
  | { status: 'already-resolved'; recordExists: true }
  | {
    status: 'resolved';
    record: ChallengeComparison;
    outcome: 'forfeit' | 'double-forfeit';
    reason: UnresolvableReason | PrimaryMergedReason;
    dryRun: boolean;
  }
  | { status: 'skipped'; reason: string };

export async function resolveUnresolvablePair(input: UnresolvablePairInput): Promise<ResolveOutcome> {
  const evalsDir = join(input.repoDir, '.wavemill', 'evals');
  const existing = readDecisiveChallengeComparisons(evalsDir).find((comparison) => comparison.challengePairId === input.pairId);
  if (existing) {
    return { status: 'already-resolved', recordExists: true };
  }

  try {
    await repairChallengePairingSync({ pairId: input.pairId, repoDir: input.repoDir });
  } catch (error) {
    console.warn(`[challenge-pair-resolver] Failed to repair pairing metadata for ${input.pairId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const workflow = loadWorkflowStateChallengeData(input.repoDir);
  const trackedPairState = workflow.taskStateByPair.get(input.pairId);
  if (!trackedPairState) {
    return { status: 'skipped', reason: `Pair ${input.pairId} is not present in workflow state.` };
  }
  const pairState = hydrateCleanedAbortedArm(input.pairId, evalsDir, trackedPairState);
  const retryMax = getChallengeEvalHardFailureRetryMaxAttempts(input.repoDir);

  if ((workflow.activeJobsByPair.get(input.pairId) ?? []).length > 0) {
    return { status: 'skipped', reason: `Pair ${input.pairId} still has active eval/comparison work.` };
  }

  const resolvedReason = input.reason ?? detectUnresolvableReason(
    input.pairId,
    input.repoDir,
    pairState,
    workflow.challengePairMap,
    input.now ?? (() => new Date()),
    retryMax,
    input.remoteBranches ?? input.listRemoteBranches?.(input.repoDir),
  );
  if (!resolvedReason) {
    return { status: 'skipped', reason: `Pair ${input.pairId} is not currently unresolvable.` };
  }

  const resolution = buildResolutionRecord({
    pairId: input.pairId,
    pairState,
    challengePairMap: workflow.challengePairMap,
    reason: resolvedReason,
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
    retryMax,
  });
  if (!resolution) {
    if (resolvedReason === 'sibling-challenge-aborted' || resolvedReason === 'both-challenge-aborted') {
      return {
        status: 'skipped',
        reason: `Pair ${input.pairId} has a quarantined arm but the surviving arm has not persisted an eval yet; rerun after eval completes or pass --reason.`,
      };
    }
    return { status: 'skipped', reason: `Pair ${input.pairId} requires manual repair before a terminal record can be written.` };
  }

  if (!isDecisiveChallengeComparison(resolution.record)) {
    return { status: 'skipped', reason: 'non-decisive stall record suppressed; pair left open for retry' };
  }

  if (!input.dryRun) {
    appendChallengeComparison(resolution.record, evalsDir);
    await safelyReleasePairSelectionHealth(input.repoDir, input.pairId, pairState);
  }

  return {
    status: 'resolved',
    record: resolution.record,
    outcome: resolution.outcome,
    reason: resolvedReason,
    dryRun: input.dryRun === true,
  };
}

interface ArchivedChallengeAbort {
  pairId?: unknown;
  model?: unknown;
  reason?: unknown;
  detail?: unknown;
  nextAction?: unknown;
  stage?: unknown;
  abortedAt?: unknown;
}

/**
 * Post-review cleanup can remove an aborted challenger from workflow state
 * while preserving its `.challenge-aborted.json` under eval artifacts. The
 * pair-wide quarantine stamp then survives only on the healthy primary, which
 * makes the resolver misidentify the primary as the failed arm. Rehydrate the
 * missing terminal arm from durable evidence and discard that mirrored stamp
 * from the evaluated survivor.
 */
function hydrateCleanedAbortedArm(
  pairId: string,
  evalsDir: string,
  pairState: PairTaskState,
): PairTaskState {
  if (pairState.primary && pairState.challenger) return pairState;

  const missingRole = pairState.primary ? 'challenger' : 'primary';
  const taskKeys = missingRole === 'challenger'
    ? [`${pairId}_c`, `${pairId}-challenger`]
    : [pairId];

  for (const taskKey of taskKeys) {
    const artifactPath = join(evalsDir, 'artifacts', taskKey, '.challenge-aborted.json');
    if (!existsSync(artifactPath)) continue;
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as ArchivedChallengeAbort;
      if (typeof artifact.reason !== 'string' || !artifact.reason.trim()) continue;
      if (typeof artifact.pairId === 'string' && artifact.pairId.trim() !== pairId) continue;

      const timestamp = typeof artifact.abortedAt === 'string' ? Date.parse(artifact.abortedAt) : NaN;
      const restored: TaskEvalState = {
        issueId: taskKey,
        prNumber: null,
        role: missingRole,
        branch: null,
        challengeStage: typeof artifact.stage === 'string' && artifact.stage.trim() ? artifact.stage.trim() : null,
        model: typeof artifact.model === 'string' && artifact.model.trim() ? artifact.model.trim() : null,
        updatedAt: Number.isFinite(timestamp) ? timestamp : null,
        evalFailed: false,
        evalCompleted: false,
        evalHardFailureRetryCount: 0,
        comparisonState: null,
        challengeAborted: artifact.reason.trim(),
        challengeAbortedDetail: typeof artifact.detail === 'string' && artifact.detail.trim() ? artifact.detail.trim() : null,
        challengeAbortedNextAction: typeof artifact.nextAction === 'string' && artifact.nextAction.trim() ? artifact.nextAction.trim() : null,
        challengeAbortedStage: typeof artifact.stage === 'string' && artifact.stage.trim() ? artifact.stage.trim() : null,
      };

      const hydrated: PairTaskState = { ...pairState, [missingRole]: restored };
      const survivorRole = missingRole === 'challenger' ? 'primary' : 'challenger';
      const survivor = hydrated[survivorRole];
      if (survivor?.evalCompleted && survivor.challengeAborted === restored.challengeAborted
        && survivor.challengeAbortedDetail === restored.challengeAbortedDetail) {
        hydrated[survivorRole] = {
          ...survivor,
          challengeAborted: null,
          challengeAbortedDetail: null,
          challengeAbortedNextAction: null,
          challengeAbortedStage: null,
        };
      }
      return hydrated;
    } catch {
      // Try the next canonical artifact key; malformed evidence stays fail-closed.
    }
  }
  return pairState;
}

export async function resolvePrimaryMergedPair(input: PrimaryMergedInput): Promise<ResolveOutcome> {
  const evalsDir = join(input.repoDir, '.wavemill', 'evals');
  const workflow = loadWorkflowStateChallengeData(input.repoDir);
  const pairState = workflow.taskStateByPair.get(input.pairId);
  const existing = readDecisiveChallengeComparisons(evalsDir).find((comparison) => comparison.challengePairId === input.pairId);

  if (existing) {
    if (pairState?.challenger && !input.dryRun) {
      await markChallengerSupersededForPrimaryMerge(input.repoDir, pairState.challenger, input.primaryPr, input.now);
    }
    return { status: 'already-resolved', recordExists: true };
  }

  if (!pairState) {
    return { status: 'skipped', reason: `Pair ${input.pairId} is not present in workflow state.` };
  }

  const primary = pairState.primary;
  const challenger = pairState.challenger;
  const primaryPr = normalizePrNumber(input.primaryPr) ?? primary?.prNumber ?? UNKNOWN_PR_NUMBER;
  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const record = buildForfeitComparison({
    challengePairId: input.pairId,
    primaryModel: getTaskModel(primary),
    challengerModel: getTaskModel(challenger),
    primaryPrUrl: getPrUrl(primaryPr),
    challengerPrUrl: getTaskPrUrl(challenger),
    winner: 'primary',
    primaryCompleted: true,
    challengerCompleted: challenger?.evalCompleted === true,
    rationale: `Primary PR #${primaryPr} merged before challenge comparison completed. Challenger arm superseded.`,
    terminalReason: 'primary_merged',
    noComparisonReason: 'primary_merged',
    timestamp,
  });

  if (!input.dryRun) {
    appendChallengeComparison(record, evalsDir);
    await safelyReleasePairSelectionHealth(input.repoDir, input.pairId, pairState);
    if (challenger) {
      await markChallengerSupersededForPrimaryMerge(input.repoDir, challenger, primaryPr, input.now);
    }
  }

  return {
    status: 'resolved',
    record,
    outcome: 'forfeit',
    reason: 'primary_merged',
    dryRun: input.dryRun === true,
  };
}

async function safelyReleasePairSelectionHealth(
  repoDir: string,
  pairId: string,
  pairState: PairTaskState,
): Promise<void> {
  try {
    await releasePairSelectionHealth(repoDir, pairId, pairState);
  } catch (error) {
    console.warn(`[challenge-pair-resolver] Failed to release selection health for ${pairId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function releasePairSelectionHealth(
  repoDir: string,
  pairId: string,
  pairState: PairTaskState,
): Promise<void> {
  const owner = { issueId: pairId, pairId };
  const tasks = [pairState.primary, pairState.challenger].filter((task): task is TaskEvalState => Boolean(task));
  await Promise.all(tasks.map(async (task) => {
    const stage = normalizeChallengeStage(task.challengeStage ?? task.challengeAbortedStage);
    const model = getTaskModel(task);
    if (model === UNKNOWN_MODEL) {
      return;
    }
    if (task.evalCompleted) {
      await recordSelectionOutcome({
        repoDir,
        owner,
        model,
        stage,
        success: true,
      });
      return;
    }
    await releaseReservation({
      repoDir,
      owner,
      model,
      stage,
    });
  }));
}

function normalizeChallengeStage(value: string | null | undefined): ChallengeStage {
  const raw = value?.trim().toLowerCase();
  if (raw === 'plan' || raw === 'planning' || raw === 'planner') return 'plan';
  if (raw === 'review' || raw === 'reviewer') return 'review';
  return 'implementation';
}

function detectUnresolvableReason(
  pairId: string,
  repoDir: string,
  pairState: PairTaskState,
  challengePairMap: Map<number, { pairId: string }>,
  now: () => Date,
  retryMax: number,
  remoteBranchesInput?: string[],
): UnresolvableReason | null {
  const sharedReason = classifyPairUnresolvableState(pairState, retryMax);
  if (sharedReason) {
    return sharedReason;
  }

  if (pairState.primary && pairState.challenger) {
    return null;
  }

  // HOK-2813_c: If the primary has pending arms (awaiting_fork), the pair is
  // not orphaned — it's just waiting for the fork trigger to materialise the
  // challenger. Do not treat it as unresolvable.
  if (pairState.primary && hasPendingArms(pairState.primary)) {
    return null;
  }

  const representative = pairState.primary ?? pairState.challenger;
  if (!representative || !isPastOrphanGrace(representative, now)) {
    return null;
  }

  const siblingBranch = representative.branch ? getSiblingBranch(representative.branch) : null;
  const remoteBranches = new Set(remoteBranchesInput ?? listRemoteTaskBranches(repoDir));
  const hasSiblingBranch = Boolean(siblingBranch && remoteBranches.has(siblingBranch));
  const openPrNumbers = new Set(challengePairMap.keys());
  if (isSiblingLive({
    hasSiblingBranch,
    openPrNumbers,
    pairState,
    side: representative.role,
  })) {
    return null;
  }

  const otherOpenPrExists = [...challengePairMap.entries()].some(
    ([prNumber, info]) => info.pairId === pairId && prNumber !== representative.prNumber,
  );
  if (otherOpenPrExists) {
    return null;
  }

  return 'orphan-sibling';
}

function isPastOrphanGrace(task: TaskEvalState, now: () => Date): boolean {
  if (task.updatedAt === null) {
    return true;
  }
  return now().getTime() - task.updatedAt >= ORPHAN_PAIR_GRACE_MS;
}

function isHardFailureExhausted(task: TaskEvalState | undefined, retryMax: number): boolean {
  return Boolean(task?.evalFailed && task.evalHardFailureRetryCount >= retryMax);
}

function buildResolutionRecord(input: {
  pairId: string;
  pairState: PairTaskState;
  challengePairMap: Map<number, { pairId: string }>;
  reason: UnresolvableReason;
  timestamp: string;
  retryMax: number;
}): { record: ChallengeComparison; outcome: 'forfeit' | 'double-forfeit' } | null {
  const primary = input.pairState.primary;
  const challenger = input.pairState.challenger;

  if (input.reason === 'both-eval-hard-failed') {
    return {
      outcome: 'double-forfeit',
      record: buildDoubleForfeitComparison({
        challengePairId: input.pairId,
        primaryModel: getTaskModel(primary),
        challengerModel: getTaskModel(challenger),
        primaryPrUrl: getTaskPrUrl(primary),
        challengerPrUrl: getTaskPrUrl(challenger),
        rationale: 'Both sides exhausted challenge eval hard-failure retries before a comparison could be launched.',
        primaryCompleted: primary?.evalCompleted === true,
        challengerCompleted: challenger?.evalCompleted === true,
        terminalReason: 'both_eval_hard_failed',
        timestamp: input.timestamp,
      }),
    };
  }

  if (input.reason === 'sibling-eval-hard-failed') {
    const primaryExhausted = isHardFailureExhausted(primary, input.retryMax);
    const challengerExhausted = isHardFailureExhausted(challenger, input.retryMax);
    if (primaryExhausted && challenger?.evalCompleted) {
      return {
        outcome: 'forfeit',
        record: buildForfeitComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          winner: 'challenger',
          rationale: 'Primary exhausted challenge eval hard-failure retries before persisting an eval record.',
          primaryCompleted: false,
          challengerCompleted: true,
          terminalReason: 'primary_eval_hard_failed',
          timestamp: input.timestamp,
        }),
      };
    }
    if (challengerExhausted && primary?.evalCompleted) {
      return {
        outcome: 'forfeit',
        record: buildForfeitComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          winner: 'primary',
          rationale: 'Challenger exhausted challenge eval hard-failure retries before persisting an eval record.',
          primaryCompleted: true,
          challengerCompleted: false,
          terminalReason: 'challenger_eval_hard_failed',
          timestamp: input.timestamp,
        }),
      };
    }
    return null;
  }

  if (input.reason === 'sibling-challenge-aborted') {
    const aborted = primary?.challengeAborted ? primary : challenger?.challengeAborted ? challenger : undefined;
    const survivor = aborted?.role === 'primary' ? challenger : primary;
    if (!aborted || !survivor?.evalCompleted) {
      return null;
    }
    const armFailures = buildArmFailures(primary, challenger);
    return {
      outcome: 'forfeit',
      record: buildForfeitComparison({
        challengePairId: input.pairId,
        primaryModel: getTaskModel(primary),
        challengerModel: getTaskModel(challenger),
        primaryPrUrl: getTaskPrUrl(primary),
        challengerPrUrl: getTaskPrUrl(challenger),
        winner: survivor.role,
        primaryCompleted: primary?.evalCompleted === true,
        challengerCompleted: challenger?.evalCompleted === true,
        armFailures,
        rationale: `${describeTaskFailure(aborted)} The surviving ${survivor.role} side wins by forfeit.`,
        terminalReason: aborted.role === 'primary' ? 'primary_challenge_aborted' : 'challenger_challenge_aborted',
        timestamp: input.timestamp,
      }),
    };
  }

  if (input.reason === 'both-challenge-aborted') {
    const armFailures = buildArmFailures(primary, challenger);
    const completed = [primary, challenger].filter((task): task is TaskEvalState => task?.evalCompleted === true);
    if (completed.length === 1) {
      const survivor = completed[0];
      return {
        outcome: 'forfeit',
        record: buildForfeitComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          winner: survivor.role,
          primaryCompleted: primary?.evalCompleted === true,
          challengerCompleted: challenger?.evalCompleted === true,
          armFailures,
          rationale: `${armFailures.length > 0 ? armFailures.map(describeFailure).join(' ') : 'Both arms carry terminal quarantine marks.'} Only the ${survivor.role} side produced a persisted eval, so it wins by forfeit.`,
          terminalReason: survivor.role === 'primary' ? 'challenger_challenge_aborted' : 'primary_challenge_aborted',
          timestamp: input.timestamp,
        }),
      };
    }
    const prBearingTasks = [primary, challenger].filter((task): task is TaskEvalState =>
      typeof task?.prNumber === 'number' && task.prNumber > 0,
    );
    if (completed.length === 0 && prBearingTasks.length === 1) {
      return null;
    }
    return {
      outcome: 'double-forfeit',
      record: buildDoubleForfeitComparison({
        challengePairId: input.pairId,
        primaryModel: getTaskModel(primary),
        challengerModel: getTaskModel(challenger),
        primaryPrUrl: getTaskPrUrl(primary),
        challengerPrUrl: getTaskPrUrl(challenger),
        primaryCompleted: primary?.evalCompleted === true,
        challengerCompleted: challenger?.evalCompleted === true,
        armFailures,
        rationale: `${armFailures.length > 0 ? armFailures.map(describeFailure).join(' ') : 'Both arms were quarantined.'} No valid comparison could be produced.`,
        terminalReason: 'both_challenge_aborted',
        timestamp: input.timestamp,
      }),
    };
  }

  if (input.reason === 'orphan-sibling' && primary && challenger) {
    return null;
  }

  const loneSide = primary ?? challenger;
  if (!loneSide) {
    return null;
  }

  if (input.reason === 'orphan-sibling' && hasOtherOpenPrForPair(input.challengePairMap, input.pairId, loneSide.prNumber)) {
    return null;
  }

  const armFailures = buildArmFailures(primary, challenger);
  if (!loneSide.evalCompleted) {
    return {
      outcome: 'double-forfeit',
      record: buildDoubleForfeitComparison({
        challengePairId: input.pairId,
        primaryModel: getTaskModel(primary),
        challengerModel: getTaskModel(challenger),
        primaryPrUrl: getTaskPrUrl(primary),
        challengerPrUrl: getTaskPrUrl(challenger),
        primaryCompleted: primary?.evalCompleted === true,
        challengerCompleted: challenger?.evalCompleted === true,
        armFailures,
        rationale: armFailures.length > 0
          ? `${armFailures.map(describeFailure).join(' ')} No valid comparison could be produced.`
          : 'Challenge pair became orphaned before either side produced a persisted eval/comparison result.',
        terminalReason: 'orphan_pair',
        timestamp: input.timestamp,
      }),
    };
  }

  // Determine the reason: if the lone side is the primary and has no challengerLaunched marker,
  // it's a phantom pair (challenger was never actually launched).
  const noComparisonReason = (!primary && loneSide.role === 'challenger') || primary?.challengerLaunched === true
    ? 'orphan_pair'
    : 'challenger_never_launched';

  return {
    outcome: 'forfeit',
    record: buildForfeitComparison({
      challengePairId: input.pairId,
      primaryModel: getTaskModel(primary),
      challengerModel: getTaskModel(challenger),
      primaryPrUrl: getTaskPrUrl(primary),
      challengerPrUrl: getTaskPrUrl(challenger),
      winner: loneSide.role,
      primaryCompleted: primary?.evalCompleted === true,
      challengerCompleted: challenger?.evalCompleted === true,
      armFailures,
      rationale: armFailures.length > 0
        ? `${armFailures.map(describeFailure).join(' ')} The surviving ${loneSide.role} side wins by forfeit.`
        : 'Challenge pair became orphaned before a comparison could be launched; the surviving side wins by forfeit.',
      terminalReason: 'orphan_pair',
      noComparisonReason,
      timestamp: input.timestamp,
    }),
  };
}

function hasOtherOpenPrForPair(
  challengePairMap: Map<number, { pairId: string }>,
  pairId: string,
  representativePr: number | null,
): boolean {
  for (const [prNumber, info] of challengePairMap) {
    if (info.pairId === pairId && prNumber > 0 && prNumber !== representativePr) {
      return true;
    }
  }
  return false;
}

function buildArmFailures(
  primary: TaskEvalState | undefined,
  challenger: TaskEvalState | undefined,
): ChallengeArmFailure[] {
  return [primary, challenger]
    .filter((task): task is TaskEvalState => Boolean(task?.challengeAborted))
    .map((task) => {
      const failureKind = parseAbortFailureKind(task.challengeAborted);
      const faultClass = classifyArmFault({ failureKind, detail: task.challengeAbortedDetail });
      return {
        side: task.role,
        model: getTaskModel(task),
        ...(task.challengeAbortedStage ? { stage: task.challengeAbortedStage } : {}),
        ...(failureKind ? { failureKind } : {}),
        faultClass,
        ...(task.challengeAbortedDetail ? { detail: task.challengeAbortedDetail } : {}),
      };
    });
}

function describeTaskFailure(task: TaskEvalState): string {
  const failure = buildArmFailures(
    task.role === 'primary' ? task : undefined,
    task.role === 'challenger' ? task : undefined,
  )[0];
  return failure ? describeFailure(failure) : `${task.role === 'primary' ? 'Primary' : 'Challenger'} arm (${getTaskModel(task)}) failed: ${task.challengeAborted ?? 'unknown'}.`;
}

function describeFailure(failure: ChallengeArmFailure): string {
  return describeArmFailure({
    role: failure.side,
    model: failure.model,
    stage: failure.stage,
    failureKind: failure.failureKind,
    faultClass: failure.faultClass,
    detail: failure.detail,
  });
}

function getTaskModel(task: TaskEvalState | undefined): string {
  return task?.model?.trim() || UNKNOWN_MODEL;
}

function getTaskPrUrl(task: TaskEvalState | undefined): string {
  const prNumber = task?.prNumber ?? UNKNOWN_PR_NUMBER;
  return getPrUrl(prNumber);
}

function getPrUrl(prNumber: number | null | undefined): string {
  return `https://github.com/unknown/unknown/pull/${prNumber ?? UNKNOWN_PR_NUMBER}`;
}

function normalizePrNumber(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}

interface WorkflowStateFile {
  tasks?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

async function markChallengerSupersededForPrimaryMerge(
  repoDir: string,
  challenger: TaskEvalState,
  primaryPr: number,
  now?: () => Date,
): Promise<void> {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const timestamp = (now ?? (() => new Date()))().toISOString();
  const reason = `${PRIMARY_MERGED_REASON} #${primaryPr}`;

  await mutateJsonState<WorkflowStateFile>(statePath, (current) => {
    const task = current.tasks?.[challenger.issueId];
    if (!task) {
      return current;
    }
    if (task.phase === 'superseded' && task.status === 'superseded') {
      return current;
    }
    task.phase = 'superseded';
    task.status = 'superseded';
    task.supersededReason = reason;
    task.supersededAt = timestamp;
    task.challengeAborted = reason;
    task.updated = timestamp;
    return current;
  });
}
