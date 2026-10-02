import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChallengeEvalHardFailureRetryMaxAttempts } from './config.ts';
import { mutateJsonState } from './state-mutex.ts';
import {
  appendChallengeComparison,
  buildDoubleForfeitComparison,
  buildForfeitComparison,
  buildInvalidChallengeArmComparison,
  isDecisiveChallengeComparison,
  readDecisiveChallengeComparisons,
  type ChallengeComparison,
} from './challenge-comparison.ts';
import { readEvalRecords } from './eval-persistence.ts';
import type { EvalRecord } from './eval-schema.ts';
import type { ForkIdentity, InvalidChallengeReason } from './challenge-execution-contract.ts';
import { readForkIdentity } from './fork-identity.ts';
import {
  getSiblingBranch,
  classifyPairUnresolvableState,
  evaluateSiblingLiveness,
  isSiblingLive,
  listRemoteTaskBranches,
  loadWorkflowStateChallengeData,
  pairHasPendingChallengeArm,
  type PairTaskState,
  type SiblingProgressProbe,
  type TaskEvalState,
  type UnresolvableReason,
} from './tend-challenge-gate.ts';
import {
  classifyArmFault,
  describeArmFailure,
  isInvalidChallengeAbort,
  parseAbortFailureKind,
  type ChallengeArmFailure,
} from './arm-failure-taxonomy.ts';
import { repairChallengePairingSync } from './challenge-pairing-repair.ts';
import {
  recordSelectionOutcome,
  releaseReservation,
} from './challenge-selection-health.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';

const ORPHAN_PAIR_GRACE_MS = 60_000;
const UNKNOWN_PR_NUMBER = 0;
const UNKNOWN_MODEL = 'unknown';
const PRIMARY_MERGED_REASON = 'Primary already merged as PR';
/** HOK-3128: abort stamp for a no-PR arm retired because it stopped progressing. */
const SIBLING_STALLED_ABORT_REASON = 'terminal_stage_failure:sibling-stalled';

type PrimaryMergedReason = 'primary_merged';

export interface UnresolvablePairInput {
  pairId: string;
  repoDir: string;
  reason?: UnresolvableReason;
  dryRun?: boolean;
  now?: () => Date;
  remoteBranches?: string[];
  listRemoteBranches?: (repoDir: string) => string[];
  /** HOK-3128: progress probe for a tracked no-PR arm (tests inject this). */
  getSiblingProgress?: SiblingProgressProbe;
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
    outcome: 'forfeit' | 'double-forfeit' | 'invalid_challenge';
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

  // HOK-2813: a challenger nested on the primary as an awaiting_fork arm is
  // legitimately missing until the fork trigger materialises it. The pair is
  // deferred, not orphaned — never forfeit it, even under an explicit reason.
  if (pairHasPendingChallengeArm(pairState)) {
    return { status: 'skipped', reason: `Pair ${input.pairId} has a challenger arm awaiting fork; deferred, not orphaned.` };
  }

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
    input.getSiblingProgress,
  );
  if (!resolvedReason) {
    return { status: 'skipped', reason: `Pair ${input.pairId} is not currently unresolvable.` };
  }

  // HOK-3128: a stalled no-PR arm is retired exactly like a quarantined one.
  // Stamp it (in memory now, durably below) and reuse the
  // `sibling-challenge-aborted` forfeit path so no new terminal reason or
  // comparison schema is needed.
  let resolutionPairState = pairState;
  let stalledArm: TaskEvalState | undefined;
  if (resolvedReason === 'sibling-stalled') {
    stalledArm = findStalledNoPrArm(pairState);
    if (!stalledArm) {
      return { status: 'skipped', reason: `Pair ${input.pairId} has no tracked no-PR arm to retire as stalled.` };
    }
    const survivor = stalledArm.role === 'primary' ? pairState.challenger : pairState.primary;
    if (!survivor?.evalCompleted) {
      return {
        status: 'skipped',
        reason: `Pair ${input.pairId} has a stalled arm but the surviving arm has not persisted an eval yet; rerun after eval completes.`,
      };
    }
    resolutionPairState = {
      ...pairState,
      [stalledArm.role]: {
        ...stalledArm,
        challengeAborted: SIBLING_STALLED_ABORT_REASON,
        challengeAbortedDetail: describeStalledArm(stalledArm),
        challengeAbortedStage: stalledArm.phase ?? stalledArm.challengeStage ?? null,
      },
    };
  }

  const resolution = buildResolutionRecord({
    pairId: input.pairId,
    pairState: resolutionPairState,
    challengePairMap: workflow.challengePairMap,
    reason: resolvedReason === 'sibling-stalled' ? 'sibling-challenge-aborted' : resolvedReason,
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
    retryMax,
    evalsDir,
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

  // HOK-2970: `invalid_challenge` is the correct terminal outcome for an
  // aborted arm whose eval was already invalid. It is deliberately not
  // "decisive" for merge-lane routing (see `isDecisiveChallengeComparison`),
  // but it still must land on disk so tend-challenge-gate treats the pair as
  // resolved and stops re-checking it. Only non-decisive stall records
  // (empty-forfeits with no arm failures) are suppressed for retry.
  if (
    resolution.outcome !== 'invalid_challenge'
    && !isDecisiveChallengeComparison(resolution.record)
  ) {
    return { status: 'skipped', reason: 'non-decisive stall record suppressed; pair left open for retry' };
  }

  if (!input.dryRun) {
    if (stalledArm) {
      await stampStalledArm(input.repoDir, stalledArm, input.now);
    }
    appendChallengeComparison(resolution.record, evalsDir);
    await safelyReleasePairSelectionHealth(input.repoDir, input.pairId, pairState, resolution.outcome);
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
  const forkDescriptor = forkDescriptorForPair(primary, challenger);
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
    ...forkDescriptor,
  });

  if (!input.dryRun) {
    appendChallengeComparison(record, evalsDir);
    await safelyReleasePairSelectionHealth(input.repoDir, input.pairId, pairState, 'forfeit');
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
  terminalOutcome?: 'forfeit' | 'double-forfeit' | 'invalid_challenge',
): Promise<void> {
  try {
    await releasePairSelectionHealth(repoDir, pairId, pairState, terminalOutcome);
  } catch (error) {
    console.warn(`[challenge-pair-resolver] Failed to release selection health for ${pairId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function releasePairSelectionHealth(
  repoDir: string,
  pairId: string,
  pairState: PairTaskState,
  terminalOutcome?: 'forfeit' | 'double-forfeit' | 'invalid_challenge',
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
    // A challenger resolved without a completed eval consumed its selection
    // slot without producing coverage: record one truthful forfeit/invalid
    // attempt so attempt-aware ranking rotates exploration (HOK-3066). The
    // primary arm was never chosen by the exploration selector, so its
    // reservation is simply released.
    if (terminalOutcome && task === pairState.challenger) {
      await recordSelectionOutcome({
        repoDir,
        owner,
        model,
        stage,
        terminalStatus: terminalOutcome === 'invalid_challenge' ? 'invalid' : 'forfeit',
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

function readIntentString(intent: Record<string, unknown> | undefined, key: string): string | null {
  const value = intent?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readInheritedStages(intent: Record<string, unknown> | undefined, side: 'primary' | 'challenger'): ChallengeStage[] {
  const sideIntent = intent?.[side];
  if (typeof sideIntent !== 'object' || sideIntent === null || Array.isArray(sideIntent)) return [];
  const stages = (sideIntent as { inheritedStages?: unknown }).inheritedStages;
  if (!Array.isArray(stages)) return [];
  return stages
    .filter((stage): stage is string => typeof stage === 'string' && stage.trim() !== '')
    .map((stage) => normalizeChallengeStage(stage));
}

function forkDescriptorForPair(
  primary: TaskEvalState | undefined,
  challenger: TaskEvalState | undefined,
): {
  forkStage?: ChallengeStage | null;
  forkCommit?: string | null;
  sharedPrefix?: boolean;
  primaryInheritedStages?: ChallengeStage[];
  challengerInheritedStages?: ChallengeStage[];
  forkIdentity?: ForkIdentity;
} {
  const intent = primary?.challengeExecutionIntent ?? challenger?.challengeExecutionIntent;
  if (!intent) return {};
  const forkStage = readIntentString(intent, 'forkStage');
  const forkCommit = readIntentString(intent, 'forkCommit');
  const forkIdentity = readForkIdentity(intent.forkIdentity);
  return {
    forkStage: forkStage ? normalizeChallengeStage(forkStage) : null,
    forkCommit,
    sharedPrefix: intent.sharedPrefix === true,
    primaryInheritedStages: readInheritedStages(intent, 'primary'),
    challengerInheritedStages: readInheritedStages(intent, 'challenger'),
    ...(forkIdentity ? { forkIdentity } : {}),
  };
}

function detectUnresolvableReason(
  pairId: string,
  repoDir: string,
  pairState: PairTaskState,
  challengePairMap: Map<number, { pairId: string }>,
  now: () => Date,
  retryMax: number,
  remoteBranchesInput?: string[],
  getSiblingProgress?: SiblingProgressProbe,
): UnresolvableReason | null {
  const sharedReason = classifyPairUnresolvableState(pairState, retryMax);
  if (sharedReason) {
    return sharedReason;
  }

  if (pairState.primary && pairState.challenger) {
    // HOK-3128: both arms tracked, one with a PR and one without. The no-PR
    // arm holds the pair only while the progress primitive shows it working.
    const stalledArm = findStalledNoPrArm(pairState);
    if (!stalledArm) {
      return null;
    }
    const { stalled } = evaluateSiblingLiveness({
      repoDir,
      hasSiblingBranch: true,
      openPrNumbers: new Set(challengePairMap.keys()),
      pairState,
      side: stalledArm.role === 'primary' ? 'challenger' : 'primary',
      nowMs: now().getTime(),
      getSiblingProgress,
    });
    return stalled ? 'sibling-stalled' : null;
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

/**
 * HOK-3128: the candidate arm for `sibling-stalled` — the only tracked,
 * non-aborted arm without a PR while its sibling has one. Returns undefined
 * when the shape does not match (both or neither have PRs).
 */
function findStalledNoPrArm(pairState: PairTaskState): TaskEvalState | undefined {
  const { primary, challenger } = pairState;
  if (!primary || !challenger) return undefined;
  if (primary.prNumber === null && challenger.prNumber !== null && !primary.challengeAborted) return primary;
  if (challenger.prNumber === null && primary.prNumber !== null && !challenger.challengeAborted) return challenger;
  return undefined;
}

function describeStalledArm(task: TaskEvalState): string {
  const phase = task.phase ? ` in phase ${task.phase}` : '';
  return `The ${task.role} arm (${getTaskModel(task)}) showed no agent progress${phase} past the stall grace and never opened a PR; retired so its sibling is released.`;
}

/**
 * Durably stamp a stalled arm so every other consumer (monitor, dashboard,
 * gate) sees it as aborted. Never overwrites an existing abort stamp.
 */
async function stampStalledArm(repoDir: string, task: TaskEvalState, now?: () => Date): Promise<void> {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const timestamp = (now ?? (() => new Date()))().toISOString();
  await mutateJsonState<WorkflowStateFile>(statePath, (current) => {
    const entry = current.tasks?.[task.issueId];
    if (!entry || (typeof entry.challengeAborted === 'string' && entry.challengeAborted)) {
      return current;
    }
    entry.challengeAborted = SIBLING_STALLED_ABORT_REASON;
    entry.challengeAbortedDetail = describeStalledArm(task);
    entry.challengeAbortedStage = task.phase ?? task.challengeStage ?? null;
    entry.updated = timestamp;
    return current;
  });
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

/**
 * HOK-2970: look up the aborted arm's latest persisted eval so the resolver
 * can distinguish a "real" abort (arm ran, produced valid eval, then aborted
 * for some non-eval reason) from an "invalid_challenge" abort where the
 * eval itself was already invalid (root cause HOK-3006). Returns the newest
 * `evals.jsonl` row matching the pairId + role, or `null` when none exists.
 */
function readLatestEvalForArm(
  evalsDir: string,
  pairId: string,
  role: 'primary' | 'challenger',
): EvalRecord | null {
  try {
    const records = readEvalRecords({ dir: evalsDir });
    const matching = records.filter((record) =>
      record.challengePairId === pairId
      && record.challengeSide === role,
    );
    if (matching.length === 0) return null;
    // evals.jsonl is append-only in eval order; last write wins.
    return matching[matching.length - 1] ?? null;
  } catch {
    return null;
  }
}

interface InvalidArmSnapshot {
  side: 'primary' | 'challenger';
  reason: InvalidChallengeReason;
  details?: string;
  evalId?: string;
  evaluatedPrHeadSha?: string;
}

function invalidArmSnapshot(
  evalsDir: string,
  pairId: string,
  role: 'primary' | 'challenger',
): InvalidArmSnapshot | null {
  const record = readLatestEvalForArm(evalsDir, pairId, role);
  if (!record) return null;
  if (record.invalidChallenge !== true) return null;
  const reason: InvalidChallengeReason = record.challengeDivergenceReason ?? 'missing_challenge_intent';
  return {
    side: role,
    reason,
    ...(record.nonRewardReason?.message ? { details: record.nonRewardReason.message } : {}),
    ...(record.id ? { evalId: record.id } : {}),
    ...(record.evaluatedPrHeadSha ? { evaluatedPrHeadSha: record.evaluatedPrHeadSha } : {}),
  };
}

function buildResolutionRecord(input: {
  pairId: string;
  pairState: PairTaskState;
  challengePairMap: Map<number, { pairId: string }>;
  reason: UnresolvableReason;
  timestamp: string;
  retryMax: number;
  evalsDir?: string;
}): { record: ChallengeComparison; outcome: 'forfeit' | 'double-forfeit' | 'invalid_challenge' } | null {
  const primary = input.pairState.primary;
  const challenger = input.pairState.challenger;
  const forkDescriptor = forkDescriptorForPair(primary, challenger);

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
        ...forkDescriptor,
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
          ...forkDescriptor,
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
          ...forkDescriptor,
        }),
      };
    }
    return null;
  }

  if (input.reason === 'sibling-challenge-aborted') {
    const aborted = primary?.challengeAborted ? primary : challenger?.challengeAborted ? challenger : undefined;
    const survivor = aborted?.role === 'primary' ? challenger : primary;
    if (!aborted) {
      return null;
    }
    // HOK-3147: an arm retired as `invalid_challenge:<kind>` (infrastructure/
    // identity failure, e.g. Ready failed at route-stamp) never had a valid
    // opponent. Resolve without a winner and without waiting on the
    // survivor's eval — there is nothing for that eval to decide.
    if (isInvalidChallengeAbort(aborted.challengeAborted)) {
      return buildInfrastructureAbortResolution(input, aborted, forkDescriptor);
    }
    if (!survivor?.evalCompleted) {
      return null;
    }
    const armFailures = buildArmFailures(primary, challenger);
    // HOK-2970: if the aborted arm's latest eval was already
    // `invalidChallenge: true` (root cause HOK-3006 — missing challenge
    // intent), the surviving arm cannot "win" this challenge because there
    // never was a valid opponent. Emit `invalid_challenge` with no winner
    // instead of a phantom forfeit that would let the merge lane treat this
    // as decisive.
    const invalidArm = input.evalsDir
      ? invalidArmSnapshot(input.evalsDir, input.pairId, aborted.role)
      : null;
    if (invalidArm) {
      return {
        outcome: 'invalid_challenge',
        record: buildInvalidChallengeArmComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          primaryCompleted: primary?.evalCompleted === true,
          challengerCompleted: challenger?.evalCompleted === true,
          armFailures,
          abortedSide: invalidArm.side,
          terminalReason: invalidArm.side === 'primary' ? 'primary_challenge_aborted' : 'challenger_challenge_aborted',
          invalidChallengeReason: invalidArm.reason,
          ...(invalidArm.details ? { invalidChallengeDetails: invalidArm.details } : {}),
          rationale: `${describeTaskFailure(aborted)} The ${aborted.role} arm's latest eval was marked invalid (${invalidArm.reason}); no reviewer-stage winner can be decided.`,
          timestamp: input.timestamp,
          ...forkDescriptor,
        }),
      };
    }
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
        ...forkDescriptor,
      }),
    };
  }

  if (input.reason === 'both-challenge-aborted') {
    const armFailures = buildArmFailures(primary, challenger);
    const completed = [primary, challenger].filter((task): task is TaskEvalState => task?.evalCompleted === true);
    // HOK-2970: when both arms carried an aborted stamp but one side has a
    // valid eval, we normally hand the win to the surviving arm. If the
    // aborted arm's eval was `invalidChallenge: true`, that phantom win must
    // become `invalid_challenge` instead — same rule as the sibling branch.
    if (completed.length === 1) {
      const survivor = completed[0];
      const abortedRole: 'primary' | 'challenger' = survivor.role === 'primary' ? 'challenger' : 'primary';
      // HOK-3147: same rule as the sibling branch — an infrastructure-retired
      // arm voids the pair instead of handing the survivor a phantom win.
      const abortedArm = abortedRole === 'primary' ? primary : challenger;
      if (abortedArm && isInvalidChallengeAbort(abortedArm.challengeAborted)) {
        return buildInfrastructureAbortResolution(input, abortedArm, forkDescriptor);
      }
      const invalidArm = input.evalsDir
        ? invalidArmSnapshot(input.evalsDir, input.pairId, abortedRole)
        : null;
      if (invalidArm) {
        return {
          outcome: 'invalid_challenge',
          record: buildInvalidChallengeArmComparison({
            challengePairId: input.pairId,
            primaryModel: getTaskModel(primary),
            challengerModel: getTaskModel(challenger),
            primaryPrUrl: getTaskPrUrl(primary),
            challengerPrUrl: getTaskPrUrl(challenger),
            primaryCompleted: primary?.evalCompleted === true,
            challengerCompleted: challenger?.evalCompleted === true,
            armFailures,
            abortedSide: invalidArm.side,
            terminalReason: invalidArm.side === 'primary' ? 'primary_challenge_aborted' : 'challenger_challenge_aborted',
            invalidChallengeReason: invalidArm.reason,
            ...(invalidArm.details ? { invalidChallengeDetails: invalidArm.details } : {}),
            rationale: `${armFailures.length > 0 ? armFailures.map(describeFailure).join(' ') : 'Both arms carried terminal quarantine marks.'} The ${abortedRole} arm's latest eval was marked invalid (${invalidArm.reason}); no reviewer-stage winner can be decided.`,
            timestamp: input.timestamp,
            ...forkDescriptor,
          }),
        };
      }
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
          ...forkDescriptor,
        }),
      };
    }
    const prBearingTasks = [primary, challenger].filter((task): task is TaskEvalState =>
      typeof task?.prNumber === 'number' && task.prNumber > 0,
    );
    if (completed.length === 0 && prBearingTasks.length === 1) {
      return null;
    }
    // HOK-2970: if either aborted arm's eval was invalid_challenge, emit
    // invalid_challenge instead of double-forfeit so the row cannot flow
    // into stage-attribution training as a decisive outcome.
    const invalidPrimary = input.evalsDir ? invalidArmSnapshot(input.evalsDir, input.pairId, 'primary') : null;
    const invalidChallenger = input.evalsDir ? invalidArmSnapshot(input.evalsDir, input.pairId, 'challenger') : null;
    const invalidArm = invalidPrimary ?? invalidChallenger;
    if (invalidArm) {
      const abortedSide: 'primary' | 'challenger' | 'both' =
        invalidPrimary && invalidChallenger ? 'both' : invalidArm.side;
      return {
        outcome: 'invalid_challenge',
        record: buildInvalidChallengeArmComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          primaryCompleted: primary?.evalCompleted === true,
          challengerCompleted: challenger?.evalCompleted === true,
          armFailures,
          abortedSide,
          terminalReason: 'both_challenge_aborted',
          invalidChallengeReason: invalidArm.reason,
          ...(invalidArm.details ? { invalidChallengeDetails: invalidArm.details } : {}),
          rationale: `${armFailures.length > 0 ? armFailures.map(describeFailure).join(' ') : 'Both arms were quarantined.'} Aborted arm(s) had invalid eval (${invalidArm.reason}); no reviewer-stage winner can be decided.`,
          timestamp: input.timestamp,
          ...forkDescriptor,
        }),
      };
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
        ...forkDescriptor,
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
        ...forkDescriptor,
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
      ...forkDescriptor,
    }),
  };
}

/**
 * HOK-3147: terminal record for a pair whose `aborted` arm was retired with an
 * `invalid_challenge:<kind>` stamp (harness/infrastructure failure before it
 * could be evaluated). Emits `invalid_challenge` with no winner; its
 * `armFailures` carry the harness-fault classification, so no model forfeit is
 * attributed. tend-challenge-gate releases the survivor once the retired
 * arm's PR is closed (`challenge-void`).
 */
function buildInfrastructureAbortResolution(
  input: { pairId: string; pairState: PairTaskState; timestamp: string; evalsDir?: string },
  aborted: TaskEvalState,
  forkDescriptor: ReturnType<typeof forkDescriptorForPair>,
): { record: ChallengeComparison; outcome: 'invalid_challenge' } {
  const { primary, challenger } = input.pairState;
  // HOK-2970 precedent: when the retired arm's latest eval already carries a
  // typed invalid-challenge reason, keep it rather than the generic one.
  const invalidArm = input.evalsDir
    ? invalidArmSnapshot(input.evalsDir, input.pairId, aborted.role)
    : null;
  const details = invalidArm?.details ?? aborted.challengeAbortedDetail;
  return {
    outcome: 'invalid_challenge',
    record: buildInvalidChallengeArmComparison({
      challengePairId: input.pairId,
      primaryModel: getTaskModel(primary),
      challengerModel: getTaskModel(challenger),
      primaryPrUrl: getTaskPrUrl(primary),
      challengerPrUrl: getTaskPrUrl(challenger),
      primaryCompleted: primary?.evalCompleted === true,
      challengerCompleted: challenger?.evalCompleted === true,
      armFailures: buildArmFailures(primary, challenger),
      abortedSide: aborted.role,
      terminalReason: aborted.role === 'primary' ? 'primary_challenge_aborted' : 'challenger_challenge_aborted',
      invalidChallengeReason: invalidArm?.reason ?? 'arm_infrastructure_failure',
      ...(details ? { invalidChallengeDetails: details } : {}),
      rationale: `${describeTaskFailure(aborted)} The ${aborted.role} arm was retired for an infrastructure failure before it could be evaluated; no winner can be decided.`,
      timestamp: input.timestamp,
      ...forkDescriptor,
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
