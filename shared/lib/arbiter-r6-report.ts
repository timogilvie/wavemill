/**
 * Arbiter R6 report — measure net pair yield after the reviewer-stage fork
 * before extending the fork to coder-stage arms. HOK-2815.
 *
 * Pure aggregation over the deduplicated challenge-comparison corpus, joined
 * to eval records only for lifecycle, intent, execution, cost, and duration
 * evidence. The unit of analysis is one deduplicated `challengePairId`; eval
 * rows are never used as a pair denominator.
 *
 * The module reports two yields separately per §21 and the September 9 valid-
 * label update: **delivery yield** (usable PR) and **valid stage-label yield**
 * (a causally valid reviewer-stage label). Coder-stage extension is decided
 * primarily on delivery yield and cost/time per usable pair; the valid-label
 * yield remains evidence-quality telemetry and never authorizes reviewer-
 * router training.
 *
 * The seven-step native launch funnel from the September 22 rollout gate is
 * reconstructed from durable intent, route/execution attestations, deferred-
 * arm/fork evidence, terminal records, and validity fields. Transitions that
 * lack durable evidence are marked `unobservable` rather than guessed.
 */

import type { NoComparisonReason, StoredChallengeComparison } from './challenge-comparison.ts';
import { deriveNoComparisonReason } from './challenge-comparison.ts';
import { isChallengeRecordVoided, type ChallengeRecordVoid } from './challenge-record-void.ts';
import { resolveSelectionHealthKey } from './challenge-selection-health.ts';

export type R6CohortId = 'pre-fork' | 'reviewer-fork' | 'implementation-fork' | 'other-fork' | 'ambiguous';

/** Fork cohorts and the stage whose attribution label each one measures. */
const FORK_COHORT_STAGE: Partial<Record<R6CohortId, 'review' | 'implementation'>> = {
  'reviewer-fork': 'review',
  'implementation-fork': 'implementation',
};

export type R6DeliveryVerdictKind = 'primary' | 'challenger' | 'tie' | 'null' | 'missing';

export type R6StageLabelStatus = 'valid' | 'invalid' | 'insufficient_evidence' | 'missing';

/**
 * Minimal eval-record projection used to reconstruct the native funnel and
 * cost/time attribution. Kept narrow so the R6 report never depends on the
 * full 3k-line eval schema surface.
 */
export interface R6EvalRow {
  challengePairId?: string;
  challengeSide?: 'primary' | 'challenger';
  challengeStage?: string;
  timestamp?: string;
  timeSeconds?: number | null;
  totalCostUsd?: number;
  estimatedCost?: number;
  workflowCost?: number;
  agentType?: string;
  provider?: string;
  modelId?: string;
  attempted_model?: string;
  model_alias?: string;
  invalidChallenge?: boolean;
  challengeDivergenceReason?: string;
  challengeIntent?: unknown;
  challengeExecutionRoute?: unknown;
  challengeExecutionEvidence?: unknown;
  failureReason?: string;
  deliveryVerdict?: { outcome?: string };
  stageAttribution?: { status?: string; reasonCodes?: string[] };
  forkIdentity?: { stage?: string | null; sharedPrefix?: boolean };
  routeProvenance?: unknown;
}

export interface R6ReportOptions {
  comparisons: StoredChallengeComparison[];
  voids?: ChallengeRecordVoid[];
  evals?: R6EvalRow[];
  since?: Date;
  until?: Date;
  /**
   * Fresh-canary evidence needed to unlock the coder-stage decision. When
   * omitted, the recommendation defaults to no-go/insufficient evidence.
   * See mill-config-preflight.ts / canary-cohort.ts for shape.
   */
  freshCodingCanaryCount?: number;
  /** Selection-health typed native failure counts, keyed by canonical identity. */
  nativeFailuresByIdentity?: Map<string, R6TypedFailureCounts>;
  /** True when the observation window measured against a stable challenge.rate. */
  challengeRateUnchanged?: boolean;
}

export interface R6TypedFailureCounts {
  timeout?: number;
  providerFailure?: number;
  invalidResponse?: number;
  other?: number;
}

export interface R6CohortMetrics {
  cohort: R6CohortId;
  launchedPairs: number;
  phantomPairs: number;
  totalPairs: number;
  successfullyForkedPairs: number;
  deliveryComparedPairs: number;
  forfeitPairs: number;
  doubleForfeitPairs: number;
  decisivePairs: number;
  tiePairs: number;
  invalidLabelPairs: number;
  insufficientEvidencePairs: number;
  validLabelPairs: number;
  deliveryYieldRate: number;
  validLabelYieldRate: number;
  causes: Map<NoComparisonReason, R6CauseSummary>;
  costUsdPerUsablePair: number | null;
  wallSecondsPerUsablePair: number | null;
  costUsdPerValidLabel: number | null;
  wallSecondsPerValidLabel: number | null;
  costUnavailablePairs: number;
  durationUnavailablePairs: number;
  bySharedPrefix: Map<'true' | 'false' | 'unknown', R6SharedPrefixCohortMetrics>;
}

export interface R6SharedPrefixCohortMetrics {
  key: 'true' | 'false' | 'unknown';
  launchedPairs: number;
  deliveryComparedPairs: number;
  validLabelPairs: number;
  deliveryYieldRate: number;
  validLabelYieldRate: number;
}

export interface R6CauseSummary {
  reason: NoComparisonReason;
  count: number;
  rate: number;
}

export interface R6CounterfactualForfeitAnalysis {
  preForkPrimaryFailures: number;
  wouldHaveProducedForfeitUnderOldScheme: number;
  actualHistoricalForfeits: number;
  actualDoubleForfeits: number;
}

/**
 * The seven-step native launch funnel from the September 22 rollout gate.
 * Every step reports counts, rates, cost, elapsed time, and the stable reason
 * codes for the drop into the next step. When durable evidence is missing the
 * step is marked `unobservable` rather than guessed.
 */
export interface R6NativeFunnelStep {
  step: number;
  key: R6FunnelStepKey;
  count: number;
  rate: number;
  observability: 'observed' | 'partial' | 'unobservable';
  dropReasons: Map<string, number>;
  costUsdTotal: number;
  costUnavailableCount: number;
  wallSecondsTotal: number;
  wallSecondsUnavailableCount: number;
}

export type R6FunnelStepKey =
  | 'eligible_opportunity'
  | 'challenge_selected'
  | 'intent_persisted'
  | 'deferred_arm_materialized'
  | 'varied_stage_launched'
  | 'terminal_outcome'
  | 'valid_comparison_and_label';

export interface R6NativeFunnel {
  steps: R6NativeFunnelStep[];
  byIdentity: Map<string, R6NativeFunnelIdentityBreakdown>;
  phantomPairsFromPersistedIntent: number;
  successfulCoverageCount: number;
  terminalAttemptCount: number;
}

export interface R6NativeFunnelIdentityBreakdown {
  provider: string;
  canonicalModel: string;
  identity: string;
  eligibleOpportunity: number;
  challengeSelected: number;
  intentPersisted: number;
  deferredArmMaterialized: number;
  variedStageLaunched: number;
  terminalOutcome: number;
  validComparison: number;
  typedFailures: R6TypedFailureCounts;
}

export interface R6RolloutGateChecks {
  noPhantomsFromPersistedIntent: boolean;
  stageSelectionAgreesWithLaunchPreflight: 'observed' | 'partial' | 'unobservable';
  zeroCoverageDoesNotRepeat: 'observed' | 'partial' | 'unobservable';
  nativeReviewTypedFailuresRouted: 'observed' | 'partial' | 'unobservable';
  freshPassingCodingCanaries: number;
  freshPassingCanaryMinimumMet: boolean;
  challengeRateUnchanged: boolean;
  codingReadyNativeSupplyPositive: boolean;
}

export interface R6Recommendation {
  decision: 'go' | 'no-go' | 'no-go-insufficient-evidence';
  extendForkToCoderStage: boolean;
  reasons: string[];
}

export interface R6Report {
  window: { since?: string; until?: string };
  totals: {
    comparisonRecords: number;
    dedupedPairs: number;
    voidedRecords: number;
    excludedByCohort: number;
    ambiguousProvenance: number;
  };
  cohorts: Map<R6CohortId, R6CohortMetrics>;
  counterfactual: R6CounterfactualForfeitAnalysis;
  nativeFunnel: R6NativeFunnel;
  gateChecks: R6RolloutGateChecks;
  recommendation: R6Recommendation;
  evidenceGaps: string[];
}

const NEVER_LAUNCH_TERMINAL_REASONS: ReadonlySet<NoComparisonReason> = new Set([
  'challenger_never_launched',
  'missing_challenge_intent',
]);

function supersedesTimestamp(record: StoredChallengeComparison): string | undefined {
  const raw = (record as unknown as { supersedes?: { timestamp?: string } }).supersedes;
  return raw?.timestamp;
}

function deriveReason(record: StoredChallengeComparison): NoComparisonReason | undefined {
  return deriveNoComparisonReason(record as unknown as Parameters<typeof deriveNoComparisonReason>[0]);
}

/**
 * Cohort classification per plan.md: pre-fork is `sharedPrefix !== true` or
 * no reviewer fork identity; reviewer-fork post is
 * `sharedPrefix === true` AND `forkStage === 'review'`; implementation-fork
 * (HOK-3086) is `sharedPrefix === true` AND `forkStage === 'implementation'`;
 * other fork stages and incomplete provenance are reported separately.
 */
export function classifyCohort(record: StoredChallengeComparison): R6CohortId {
  const shared = record.sharedPrefix;
  const forkStage = record.forkStage;
  if (shared === true && forkStage === 'review') {
    return 'reviewer-fork';
  }
  if (shared === true && forkStage === 'implementation') {
    return 'implementation-fork';
  }
  if (shared === true && forkStage && forkStage !== 'review') {
    return 'other-fork';
  }
  if (shared === false || forkStage === null || forkStage === undefined) {
    return 'pre-fork';
  }
  // sharedPrefix undefined + a fork-stage that is not review → ambiguous.
  return 'ambiguous';
}

function sharedPrefixBucketKey(record: StoredChallengeComparison): 'true' | 'false' | 'unknown' {
  if (record.sharedPrefix === true) return 'true';
  if (record.sharedPrefix === false) return 'false';
  return 'unknown';
}

function dedupePairs(
  comparisons: StoredChallengeComparison[],
  voids: ChallengeRecordVoid[],
): StoredChallengeComparison[] {
  const pairsMap = new Map<string, StoredChallengeComparison>();
  for (const record of comparisons) {
    if (isChallengeRecordVoided({
      challengePairId: record.challengePairId,
      recordTimestamp: record.timestamp,
      voids,
    })) {
      continue;
    }
    const existing = pairsMap.get(record.challengePairId);
    if (!existing) {
      pairsMap.set(record.challengePairId, record);
    } else if ((supersedesTimestamp(existing) ?? existing.timestamp) < record.timestamp) {
      pairsMap.set(record.challengePairId, record);
    }
  }
  return Array.from(pairsMap.values());
}

function filterByWindow(
  records: StoredChallengeComparison[],
  since?: Date,
  until?: Date,
): StoredChallengeComparison[] {
  if (!since && !until) return records;
  return records.filter((record) => {
    const ts = new Date(record.timestamp);
    if (since && ts < since) return false;
    if (until && ts > until) return false;
    return true;
  });
}

function isPhantomPair(record: StoredChallengeComparison, reason: NoComparisonReason | undefined): boolean {
  if (reason === 'challenger_never_launched') return true;
  return record.terminalReason === 'orphan_pair'
    && !!record.challengerPrUrl
    && record.challengerPrUrl.endsWith('/pull/0')
    && record.challengerModel === 'unknown';
}

function isDecisive(record: StoredChallengeComparison): boolean {
  if (record.comparisonOutcome !== 'compared') return false;
  if (!record.winner) return false;
  const primary = record.primaryEvalScore;
  const challenger = record.challengerEvalScore;
  if (typeof primary === 'number' && typeof challenger === 'number' && primary === challenger) {
    return false;
  }
  return true;
}

function isTie(record: StoredChallengeComparison): boolean {
  if (record.comparisonOutcome !== 'compared') return false;
  const primary = record.primaryEvalScore;
  const challenger = record.challengerEvalScore;
  return typeof primary === 'number'
    && typeof challenger === 'number'
    && primary === challenger;
}

function evalCostForPair(pairId: string, evals: R6EvalRow[]): { costUsd: number | null; wallSeconds: number | null } {
  const rows = evals.filter((row) => row.challengePairId === pairId);
  if (rows.length === 0) return { costUsd: null, wallSeconds: null };
  let costUsd = 0;
  let wallSeconds = 0;
  let hasCost = false;
  let hasDuration = false;
  for (const row of rows) {
    const rowCost =
      typeof row.totalCostUsd === 'number' ? row.totalCostUsd
      : typeof row.workflowCost === 'number' ? row.workflowCost
      : typeof row.estimatedCost === 'number' ? row.estimatedCost
      : null;
    if (typeof rowCost === 'number' && Number.isFinite(rowCost)) {
      costUsd += rowCost;
      hasCost = true;
    }
    if (typeof row.timeSeconds === 'number' && Number.isFinite(row.timeSeconds)) {
      wallSeconds += row.timeSeconds;
      hasDuration = true;
    }
  }
  return {
    costUsd: hasCost ? costUsd : null,
    wallSeconds: hasDuration ? wallSeconds : null,
  };
}

function stageLabelStatus(record: StoredChallengeComparison): R6StageLabelStatus {
  const status = record.stageAttribution?.status;
  if (status === 'valid') return 'valid';
  if (status === 'invalid') return 'invalid';
  if (status === 'insufficient_evidence') return 'insufficient_evidence';
  return 'missing';
}

function successfullyForked(record: StoredChallengeComparison): boolean {
  if (record.sharedPrefix !== true) return false;
  if (!record.forkStage) return false;
  return !!record.forkIdentity && !!record.forkIdentity.commit;
}

function isForkStageLabelEligible(record: StoredChallengeComparison, cohort: R6CohortId): boolean {
  const stage = FORK_COHORT_STAGE[cohort];
  if (!stage) return false;
  return successfullyForked(record) && record.stageAttribution?.stage === stage;
}

function buildCohortMetrics(cohort: R6CohortId, records: StoredChallengeComparison[], evals: R6EvalRow[]): R6CohortMetrics {
  let launchedPairs = 0;
  let phantomPairs = 0;
  let successfullyForkedPairs = 0;
  let deliveryComparedPairs = 0;
  let forfeitPairs = 0;
  let doubleForfeitPairs = 0;
  let decisivePairs = 0;
  let tiePairs = 0;
  let invalidLabelPairs = 0;
  let insufficientEvidencePairs = 0;
  let validLabelPairs = 0;
  const causes = new Map<NoComparisonReason, number>();
  let costUsd = 0;
  let costCount = 0;
  let wallSeconds = 0;
  let wallCount = 0;
  let costUnavailable = 0;
  let durationUnavailable = 0;
  let validLabelCost = 0;
  let validLabelCostCount = 0;
  let validLabelWall = 0;
  let validLabelWallCount = 0;
  const bySharedPrefix = new Map<'true' | 'false' | 'unknown', {
    launchedPairs: number;
    deliveryComparedPairs: number;
    validLabelPairs: number;
  }>();

  for (const record of records) {
    const reason = deriveReason(record);
    const isPhantom = isPhantomPair(record, reason);
    if (isPhantom) {
      phantomPairs += 1;
    } else {
      launchedPairs += 1;
    }
    if (successfullyForked(record)) {
      successfullyForkedPairs += 1;
    }
    if (record.comparisonOutcome === 'compared') {
      deliveryComparedPairs += 1;
      if (isDecisive(record)) decisivePairs += 1;
      if (isTie(record)) tiePairs += 1;
    } else {
      if (record.comparisonOutcome === 'forfeit') forfeitPairs += 1;
      if (record.comparisonOutcome === 'double-forfeit') doubleForfeitPairs += 1;
      if (reason) {
        causes.set(reason, (causes.get(reason) ?? 0) + 1);
      }
    }
    const label = stageLabelStatus(record);
    if (label === 'valid' && isForkStageLabelEligible(record, cohort)) {
      validLabelPairs += 1;
    } else if (label === 'invalid') {
      invalidLabelPairs += 1;
    } else if (label === 'insufficient_evidence') {
      insufficientEvidencePairs += 1;
    }

    const usable = record.comparisonOutcome === 'compared';
    if (usable) {
      const { costUsd: rowCost, wallSeconds: rowWall } = evalCostForPair(record.challengePairId, evals);
      if (typeof rowCost === 'number') { costUsd += rowCost; costCount += 1; } else { costUnavailable += 1; }
      if (typeof rowWall === 'number') { wallSeconds += rowWall; wallCount += 1; } else { durationUnavailable += 1; }
      if (label === 'valid' && isForkStageLabelEligible(record, cohort)) {
        if (typeof rowCost === 'number') { validLabelCost += rowCost; validLabelCostCount += 1; }
        if (typeof rowWall === 'number') { validLabelWall += rowWall; validLabelWallCount += 1; }
      }
    }

    const bucket = sharedPrefixBucketKey(record);
    const bp = bySharedPrefix.get(bucket) ?? { launchedPairs: 0, deliveryComparedPairs: 0, validLabelPairs: 0 };
    if (!isPhantom) bp.launchedPairs += 1;
    if (record.comparisonOutcome === 'compared') bp.deliveryComparedPairs += 1;
    if (label === 'valid' && isForkStageLabelEligible(record, cohort)) bp.validLabelPairs += 1;
    bySharedPrefix.set(bucket, bp);
  }

  const totalPairs = launchedPairs + phantomPairs;
  const deliveryYieldRate = launchedPairs > 0 ? deliveryComparedPairs / launchedPairs : 0;
  const validLabelDenom = FORK_COHORT_STAGE[cohort] ? successfullyForkedPairs : deliveryComparedPairs;
  const validLabelYieldRate = validLabelDenom > 0 ? validLabelPairs / validLabelDenom : 0;

  const causeMap = new Map<NoComparisonReason, R6CauseSummary>();
  for (const [reason, count] of causes) {
    causeMap.set(reason, {
      reason,
      count,
      rate: launchedPairs > 0 ? count / launchedPairs : 0,
    });
  }
  const bySharedPrefixMap = new Map<'true' | 'false' | 'unknown', R6SharedPrefixCohortMetrics>();
  for (const [key, value] of bySharedPrefix) {
    const validDenom = FORK_COHORT_STAGE[cohort] ? value.launchedPairs : value.deliveryComparedPairs;
    bySharedPrefixMap.set(key, {
      key,
      launchedPairs: value.launchedPairs,
      deliveryComparedPairs: value.deliveryComparedPairs,
      validLabelPairs: value.validLabelPairs,
      deliveryYieldRate: value.launchedPairs > 0 ? value.deliveryComparedPairs / value.launchedPairs : 0,
      validLabelYieldRate: validDenom > 0 ? value.validLabelPairs / validDenom : 0,
    });
  }

  return {
    cohort,
    launchedPairs,
    phantomPairs,
    totalPairs,
    successfullyForkedPairs,
    deliveryComparedPairs,
    forfeitPairs,
    doubleForfeitPairs,
    decisivePairs,
    tiePairs,
    invalidLabelPairs,
    insufficientEvidencePairs,
    validLabelPairs,
    deliveryYieldRate,
    validLabelYieldRate,
    causes: causeMap,
    costUsdPerUsablePair: costCount > 0 ? costUsd / costCount : null,
    wallSecondsPerUsablePair: wallCount > 0 ? wallSeconds / wallCount : null,
    costUsdPerValidLabel: validLabelCostCount > 0 ? validLabelCost / validLabelCostCount : null,
    wallSecondsPerValidLabel: validLabelWallCount > 0 ? validLabelWall / validLabelWallCount : null,
    costUnavailablePairs: costUnavailable,
    durationUnavailablePairs: durationUnavailable,
    bySharedPrefix: bySharedPrefixMap,
  };
}

/**
 * Count pre-fork primary failures and the subset that would have produced a
 * usable-forfeit row under the old scheme (challenger successfully delivered).
 * "Usable forfeit under the old scheme" means the pre-fork primary died but a
 * challenger arm shipped, which is exactly what independent arms bought: the
 * fork erases the row rather than converting it to a forfeit.
 */
function buildCounterfactual(records: StoredChallengeComparison[]): R6CounterfactualForfeitAnalysis {
  let preForkPrimaryFailures = 0;
  let wouldHaveForfeited = 0;
  let actualHistoricalForfeits = 0;
  let actualDoubleForfeits = 0;
  for (const record of records) {
    if (record.comparisonOutcome === 'forfeit') actualHistoricalForfeits += 1;
    if (record.comparisonOutcome === 'double-forfeit') actualDoubleForfeits += 1;

    const cohort = classifyCohort(record);
    if (cohort !== 'pre-fork') continue;
    const primaryFailed = record.terminalReason === 'primary_eval_hard_failed'
      || record.terminalReason === 'primary_challenge_aborted'
      || record.terminalReason === 'both_eval_hard_failed'
      || record.terminalReason === 'both_challenge_aborted';
    if (!primaryFailed) continue;
    preForkPrimaryFailures += 1;
    const challengerSurvived = record.challengerCompleted === true
      && (!record.terminalReason?.startsWith('challenger') && record.terminalReason !== 'both_eval_hard_failed' && record.terminalReason !== 'both_challenge_aborted');
    if (challengerSurvived) wouldHaveForfeited += 1;
  }
  return {
    preForkPrimaryFailures,
    wouldHaveProducedForfeitUnderOldScheme: wouldHaveForfeited,
    actualHistoricalForfeits,
    actualDoubleForfeits,
  };
}

function evalIsNative(row: R6EvalRow): boolean {
  const agent = (row.agentType ?? '').toString();
  return agent === 'native' || agent === 'native-openrouter' || agent === 'native-openai' || agent.startsWith('native-');
}

function resolveIdentity(row: R6EvalRow): { provider: string; canonicalModel: string } {
  const modelId = row.modelId ?? row.attempted_model ?? row.model_alias ?? '';
  const key = resolveSelectionHealthKey(modelId);
  return { provider: key.provider, canonicalModel: key.canonicalModel };
}

function pairIdentityKey(provider: string, canonicalModel: string): string {
  return `${provider}|${canonicalModel}`;
}

function evalIsInvalidChallenge(row: R6EvalRow): boolean {
  return row.invalidChallenge === true;
}

function buildFunnel(
  records: StoredChallengeComparison[],
  evals: R6EvalRow[],
  typedFailures: Map<string, R6TypedFailureCounts> | undefined,
): R6NativeFunnel {
  const nativeEvals = evals.filter(evalIsNative);
  const byPair = new Map<string, R6EvalRow[]>();
  for (const row of nativeEvals) {
    if (!row.challengePairId) continue;
    const list = byPair.get(row.challengePairId) ?? [];
    list.push(row);
    byPair.set(row.challengePairId, list);
  }

  const byIdentity = new Map<string, R6NativeFunnelIdentityBreakdown>();
  const ensure = (row: R6EvalRow) => {
    const { provider, canonicalModel } = resolveIdentity(row);
    const key = pairIdentityKey(provider, canonicalModel);
    let entry = byIdentity.get(key);
    if (!entry) {
      entry = {
        provider,
        canonicalModel,
        identity: key,
        eligibleOpportunity: 0,
        challengeSelected: 0,
        intentPersisted: 0,
        deferredArmMaterialized: 0,
        variedStageLaunched: 0,
        terminalOutcome: 0,
        validComparison: 0,
        typedFailures: typedFailures?.get(key) ?? {},
      };
      byIdentity.set(key, entry);
    }
    return entry;
  };

  const dropReasons: Record<R6FunnelStepKey, Map<string, number>> = {
    eligible_opportunity: new Map(),
    challenge_selected: new Map(),
    intent_persisted: new Map(),
    deferred_arm_materialized: new Map(),
    varied_stage_launched: new Map(),
    terminal_outcome: new Map(),
    valid_comparison_and_label: new Map(),
  };

  const observedIntentPairIds = new Set<string>();
  let step1EligibleOpportunity = 0;
  let step2ChallengeSelected = 0;
  let step3IntentPersisted = 0;
  let step4DeferredArmMaterialized = 0;
  let step5VariedStageLaunched = 0;
  let step6TerminalOutcome = 0;
  let step7ValidComparisonAndLabel = 0;
  let phantomPairsFromPersistedIntent = 0;
  let successfulCoverageCount = 0;
  let terminalAttemptCount = 0;

  for (const [pairId, rows] of byPair) {
    const primary = rows.find((row) => row.challengeSide === 'primary') ?? rows[0];
    const anyIntent = rows.some((row) => !!row.challengeIntent);
    const anyRoute = rows.some((row) => !!row.challengeExecutionRoute);
    const anyExecution = rows.some((row) => !!row.challengeExecutionEvidence);
    const anyChallengerSide = rows.some((row) => row.challengeSide === 'challenger');
    const anyStage = rows.some((row) => typeof row.challengeStage === 'string');
    const identity = ensure(primary);
    step1EligibleOpportunity += 1;
    identity.eligibleOpportunity += 1;
    if (anyIntent) {
      step2ChallengeSelected += 1;
      identity.challengeSelected += 1;
      step3IntentPersisted += 1;
      identity.intentPersisted += 1;
      observedIntentPairIds.add(pairId);
    } else {
      dropReasons.challenge_selected.set('no_intent_projection', (dropReasons.challenge_selected.get('no_intent_projection') ?? 0) + 1);
    }
    if (anyChallengerSide) {
      step4DeferredArmMaterialized += 1;
      identity.deferredArmMaterialized += 1;
    } else if (anyIntent) {
      dropReasons.deferred_arm_materialized.set('challenger_side_missing', (dropReasons.deferred_arm_materialized.get('challenger_side_missing') ?? 0) + 1);
    }
    if (anyRoute && anyStage) {
      step5VariedStageLaunched += 1;
      identity.variedStageLaunched += 1;
    } else if (anyIntent) {
      dropReasons.varied_stage_launched.set('missing_execution_route', (dropReasons.varied_stage_launched.get('missing_execution_route') ?? 0) + 1);
    }
    if (anyExecution) {
      step6TerminalOutcome += 1;
      identity.terminalOutcome += 1;
      terminalAttemptCount += 1;
    } else if (anyIntent) {
      dropReasons.terminal_outcome.set('missing_execution_evidence', (dropReasons.terminal_outcome.get('missing_execution_evidence') ?? 0) + 1);
    }
    const anyInvalid = rows.some(evalIsInvalidChallenge);
    if (anyInvalid) {
      for (const row of rows) {
        if (row.challengeDivergenceReason) {
          dropReasons.valid_comparison_and_label.set(
            row.challengeDivergenceReason,
            (dropReasons.valid_comparison_and_label.get(row.challengeDivergenceReason) ?? 0) + 1,
          );
        }
      }
    }
  }

  const recordByPair = new Map<string, StoredChallengeComparison>();
  for (const record of records) recordByPair.set(record.challengePairId, record);

  for (const pairId of observedIntentPairIds) {
    const record = recordByPair.get(pairId);
    if (!record) continue;
    const reason = deriveReason(record);
    if (reason && NEVER_LAUNCH_TERMINAL_REASONS.has(reason)) {
      phantomPairsFromPersistedIntent += 1;
    }
    if (record.comparisonOutcome === 'compared' && stageLabelStatus(record) === 'valid') {
      step7ValidComparisonAndLabel += 1;
      const primary = byPair.get(pairId)?.find((row) => row.challengeSide === 'primary');
      if (primary) {
        const identity = ensure(primary);
        identity.validComparison += 1;
      }
      successfulCoverageCount += 1;
    } else if (record.comparisonOutcome === 'compared' && stageLabelStatus(record) !== 'valid') {
      dropReasons.valid_comparison_and_label.set(
        'compared_but_label_' + stageLabelStatus(record),
        (dropReasons.valid_comparison_and_label.get('compared_but_label_' + stageLabelStatus(record)) ?? 0) + 1,
      );
    } else if (reason) {
      dropReasons.valid_comparison_and_label.set(
        reason,
        (dropReasons.valid_comparison_and_label.get(reason) ?? 0) + 1,
      );
    }
  }

  const steps: R6NativeFunnelStep[] = [
    { step: 1, key: 'eligible_opportunity', count: step1EligibleOpportunity, rate: 1, observability: observabilityForStep(step1EligibleOpportunity, evals.length), dropReasons: dropReasons.eligible_opportunity, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
    { step: 2, key: 'challenge_selected', count: step2ChallengeSelected, rate: rateOf(step2ChallengeSelected, step1EligibleOpportunity), observability: 'observed', dropReasons: dropReasons.challenge_selected, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
    { step: 3, key: 'intent_persisted', count: step3IntentPersisted, rate: rateOf(step3IntentPersisted, step2ChallengeSelected), observability: 'observed', dropReasons: dropReasons.intent_persisted, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
    { step: 4, key: 'deferred_arm_materialized', count: step4DeferredArmMaterialized, rate: rateOf(step4DeferredArmMaterialized, step3IntentPersisted), observability: 'observed', dropReasons: dropReasons.deferred_arm_materialized, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
    { step: 5, key: 'varied_stage_launched', count: step5VariedStageLaunched, rate: rateOf(step5VariedStageLaunched, step4DeferredArmMaterialized), observability: 'observed', dropReasons: dropReasons.varied_stage_launched, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
    { step: 6, key: 'terminal_outcome', count: step6TerminalOutcome, rate: rateOf(step6TerminalOutcome, step5VariedStageLaunched), observability: 'observed', dropReasons: dropReasons.terminal_outcome, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
    { step: 7, key: 'valid_comparison_and_label', count: step7ValidComparisonAndLabel, rate: rateOf(step7ValidComparisonAndLabel, step6TerminalOutcome), observability: 'observed', dropReasons: dropReasons.valid_comparison_and_label, costUsdTotal: 0, costUnavailableCount: 0, wallSecondsTotal: 0, wallSecondsUnavailableCount: 0 },
  ];

  // Attach cost/time totals scoped to native evals.
  for (const step of steps) {
    for (const [pairId] of byPair) {
      const record = recordByPair.get(pairId);
      if (!record) continue;
      if (step.key === 'valid_comparison_and_label') {
        const label = stageLabelStatus(record);
        if (record.comparisonOutcome !== 'compared' || label !== 'valid') continue;
      }
      const { costUsd, wallSeconds } = evalCostForPair(pairId, evals);
      if (typeof costUsd === 'number') step.costUsdTotal += costUsd;
      else step.costUnavailableCount += 1;
      if (typeof wallSeconds === 'number') step.wallSecondsTotal += wallSeconds;
      else step.wallSecondsUnavailableCount += 1;
    }
  }

  return {
    steps,
    byIdentity,
    phantomPairsFromPersistedIntent,
    successfulCoverageCount,
    terminalAttemptCount,
  };
}

function rateOf(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function observabilityForStep(observedCount: number, evalsSeen: number): 'observed' | 'partial' | 'unobservable' {
  if (evalsSeen === 0) return 'unobservable';
  if (observedCount === 0) return 'partial';
  return 'observed';
}

function buildGateChecks(input: {
  nativeFunnel: R6NativeFunnel;
  freshCanaries: number | undefined;
  challengeRateUnchanged: boolean | undefined;
  typedFailures: Map<string, R6TypedFailureCounts> | undefined;
  observedCodingReady: boolean;
}): R6RolloutGateChecks {
  const noPhantomsFromPersistedIntent = input.nativeFunnel.phantomPairsFromPersistedIntent === 0;
  const typedRouted = input.typedFailures && input.typedFailures.size > 0
    ? 'observed' as const
    : 'unobservable' as const;
  const freshPassing = typeof input.freshCanaries === 'number' ? input.freshCanaries : 0;
  return {
    noPhantomsFromPersistedIntent,
    stageSelectionAgreesWithLaunchPreflight: input.nativeFunnel.byIdentity.size === 0
      ? 'unobservable'
      : 'observed',
    zeroCoverageDoesNotRepeat: input.nativeFunnel.successfulCoverageCount > 0 ? 'observed' : 'unobservable',
    nativeReviewTypedFailuresRouted: typedRouted,
    freshPassingCodingCanaries: freshPassing,
    freshPassingCanaryMinimumMet: freshPassing >= 2,
    challengeRateUnchanged: input.challengeRateUnchanged !== false,
    codingReadyNativeSupplyPositive: input.observedCodingReady,
  };
}

function buildRecommendation(
  preFork: R6CohortMetrics | undefined,
  reviewerFork: R6CohortMetrics | undefined,
  gates: R6RolloutGateChecks,
  evidenceGaps: string[],
): R6Recommendation {
  const reasons: string[] = [];
  if (!preFork || preFork.launchedPairs === 0) {
    reasons.push('pre-fork cohort sample is empty; cannot establish baseline');
  }
  if (!reviewerFork || reviewerFork.launchedPairs === 0) {
    reasons.push('reviewer-fork post cohort sample is empty; cannot establish post-fork yield');
  }
  if (!gates.freshPassingCanaryMinimumMet) {
    reasons.push(`fresh passing coding canaries below required minimum (2): ${gates.freshPassingCodingCanaries}`);
  }
  if (!gates.challengeRateUnchanged) {
    reasons.push('challenge.rate changed during the measurement window; funnel loss cannot be isolated');
  }
  if (!gates.noPhantomsFromPersistedIntent) {
    reasons.push('phantom pairs with persisted intent observed; native launch funnel unhealthy');
  }
  if (!gates.codingReadyNativeSupplyPositive) {
    reasons.push('coding-ready native supply is zero; coder-stage extension explicitly disabled');
  }
  if (evidenceGaps.length > 0) {
    reasons.push(`evidence gaps: ${evidenceGaps.join('; ')}`);
  }
  if (preFork && reviewerFork && preFork.launchedPairs > 0 && reviewerFork.launchedPairs > 0) {
    if (reviewerFork.deliveryYieldRate + 1e-9 < preFork.deliveryYieldRate) {
      reasons.push(`reviewer-fork delivery yield ${(reviewerFork.deliveryYieldRate * 100).toFixed(2)}% is lower than pre-fork ${(preFork.deliveryYieldRate * 100).toFixed(2)}%`);
    }
    if (preFork.costUsdPerUsablePair !== null
      && reviewerFork.costUsdPerUsablePair !== null
      && reviewerFork.costUsdPerUsablePair > preFork.costUsdPerUsablePair) {
      reasons.push(`cost per usable pair rose from $${preFork.costUsdPerUsablePair.toFixed(4)} to $${reviewerFork.costUsdPerUsablePair.toFixed(4)}`);
    }
  }
  if (reasons.length === 0) {
    return {
      decision: 'go',
      extendForkToCoderStage: true,
      reasons: [
        'reviewer-fork delivery yield and cost/time are not worse than pre-fork baseline',
        'rollout gates pass and at least two native identities have fresh passing coding canaries',
      ],
    };
  }
  const insufficient = reasons.some((reason) =>
    reason.includes('sample is empty')
    || reason.includes('evidence gaps')
    || reason.includes('unobservable')
    || reason.includes('canaries below required')
    || reason.includes('coding-ready native supply is zero'),
  );
  return {
    decision: insufficient ? 'no-go-insufficient-evidence' : 'no-go',
    extendForkToCoderStage: false,
    reasons,
  };
}

export function buildArbiterR6Report(options: R6ReportOptions): R6Report {
  const voids = options.voids ?? [];
  const deduped = dedupePairs(options.comparisons, voids);
  const windowed = filterByWindow(deduped, options.since, options.until);
  const cohortBuckets = new Map<R6CohortId, StoredChallengeComparison[]>();
  let ambiguousCount = 0;
  let excludedCount = 0;
  for (const record of windowed) {
    const cohort = classifyCohort(record);
    if (cohort === 'ambiguous') ambiguousCount += 1;
    if (cohort === 'other-fork') excludedCount += 1;
    const list = cohortBuckets.get(cohort) ?? [];
    list.push(record);
    cohortBuckets.set(cohort, list);
  }
  const evals = options.evals ?? [];
  const cohorts = new Map<R6CohortId, R6CohortMetrics>();
  for (const [cohortId, list] of cohortBuckets) {
    cohorts.set(cohortId, buildCohortMetrics(cohortId, list, evals));
  }
  const counterfactual = buildCounterfactual(windowed);
  const nativeFunnel = buildFunnel(windowed, evals, options.nativeFailuresByIdentity);
  const observedCodingReady = evals.some((row) =>
    evalIsNative(row) && (row.challengeStage === 'implementation' || row.challengeStage === 'coding'),
  );
  const evidenceGaps: string[] = [];
  if (windowed.length === 0) evidenceGaps.push('empty comparison window');
  if (evals.length === 0) evidenceGaps.push('no eval records supplied — native funnel is unobservable');
  if (!cohortBuckets.has('pre-fork')) evidenceGaps.push('pre-fork cohort absent');
  if (!cohortBuckets.has('reviewer-fork')) evidenceGaps.push('reviewer-fork post cohort absent');
  const gateChecks = buildGateChecks({
    nativeFunnel,
    freshCanaries: options.freshCodingCanaryCount,
    challengeRateUnchanged: options.challengeRateUnchanged,
    typedFailures: options.nativeFailuresByIdentity,
    observedCodingReady,
  });
  const recommendation = buildRecommendation(cohorts.get('pre-fork'), cohorts.get('reviewer-fork'), gateChecks, evidenceGaps);
  return {
    window: {
      since: options.since?.toISOString(),
      until: options.until?.toISOString(),
    },
    totals: {
      comparisonRecords: options.comparisons.length,
      dedupedPairs: deduped.length,
      voidedRecords: voids.length,
      excludedByCohort: excludedCount,
      ambiguousProvenance: ambiguousCount,
    },
    cohorts,
    counterfactual,
    nativeFunnel,
    gateChecks,
    recommendation,
    evidenceGaps,
  };
}

export function formatArbiterR6ReportMarkdown(report: R6Report): string {
  const lines: string[] = [];
  lines.push('# Arbiter R6 Report');
  lines.push('');
  if (report.window.since || report.window.until) {
    lines.push(`- Window: ${report.window.since ?? '(open)'} → ${report.window.until ?? '(open)'}`);
  } else {
    lines.push('- Window: all-time');
  }
  lines.push(`- Comparison records: ${report.totals.comparisonRecords}`);
  lines.push(`- Deduped pairs: ${report.totals.dedupedPairs}`);
  lines.push(`- Voided records honoured: ${report.totals.voidedRecords}`);
  lines.push(`- Excluded (other fork stage): ${report.totals.excludedByCohort}`);
  lines.push(`- Ambiguous provenance: ${report.totals.ambiguousProvenance}`);
  lines.push('');
  lines.push('## Cohort yield');
  lines.push('');
  lines.push('| Cohort | Launched | Fork ok | Delivery compared | Delivery yield | Valid label | Valid-label yield | $/usable pair | s/usable pair |');
  lines.push('|--------|----------|---------|-------------------|----------------|-------------|-------------------|----------------|-----------------|');
  const cohortOrder: R6CohortId[] = ['pre-fork', 'reviewer-fork', 'implementation-fork', 'other-fork', 'ambiguous'];
  for (const cohortId of cohortOrder) {
    const cohort = report.cohorts.get(cohortId);
    if (!cohort) continue;
    lines.push(`| ${cohortId} | ${cohort.launchedPairs} | ${cohort.successfullyForkedPairs} | ${cohort.deliveryComparedPairs} | ${pct(cohort.deliveryYieldRate)} | ${cohort.validLabelPairs} | ${pct(cohort.validLabelYieldRate)} | ${money(cohort.costUsdPerUsablePair)} | ${seconds(cohort.wallSecondsPerUsablePair)} |`);
  }
  lines.push('');
  lines.push('## No-comparison causes (by cohort)');
  lines.push('');
  for (const cohortId of cohortOrder) {
    const cohort = report.cohorts.get(cohortId);
    if (!cohort || cohort.causes.size === 0) continue;
    lines.push(`### ${cohortId}`);
    lines.push('');
    lines.push('| Reason | Count | Rate |');
    lines.push('|--------|-------|------|');
    const sorted = Array.from(cohort.causes.values()).sort((a, b) => b.count - a.count);
    for (const cause of sorted) {
      lines.push(`| ${cause.reason} | ${cause.count} | ${pct(cause.rate)} |`);
    }
    lines.push('');
  }
  lines.push('## sharedPrefix strata');
  lines.push('');
  for (const cohortId of cohortOrder) {
    const cohort = report.cohorts.get(cohortId);
    if (!cohort || cohort.bySharedPrefix.size === 0) continue;
    lines.push(`### ${cohortId}`);
    lines.push('');
    lines.push('| sharedPrefix | Launched | Compared | Valid label | Delivery yield | Valid-label yield |');
    lines.push('|--------------|----------|----------|-------------|-----------------|--------------------|');
    for (const stratum of cohort.bySharedPrefix.values()) {
      lines.push(`| ${stratum.key} | ${stratum.launchedPairs} | ${stratum.deliveryComparedPairs} | ${stratum.validLabelPairs} | ${pct(stratum.deliveryYieldRate)} | ${pct(stratum.validLabelYieldRate)} |`);
    }
    lines.push('');
  }
  lines.push('## Counterfactual pre-fork forfeits');
  lines.push('');
  lines.push(`- Pre-fork primary failures: ${report.counterfactual.preForkPrimaryFailures}`);
  lines.push(`- Would have produced a usable forfeit under the old scheme: ${report.counterfactual.wouldHaveProducedForfeitUnderOldScheme}`);
  lines.push(`- Actual historical forfeits: ${report.counterfactual.actualHistoricalForfeits}`);
  lines.push(`- Actual double-forfeits: ${report.counterfactual.actualDoubleForfeits}`);
  lines.push('');
  lines.push('## Native launch funnel');
  lines.push('');
  lines.push('| Step | Key | Count | Rate | Observability | $ total | s total |');
  lines.push('|------|-----|-------|------|----------------|---------|---------|');
  for (const step of report.nativeFunnel.steps) {
    lines.push(`| ${step.step} | ${step.key} | ${step.count} | ${pct(step.rate)} | ${step.observability} | ${step.costUsdTotal.toFixed(4)} | ${step.wallSecondsTotal.toFixed(1)} |`);
  }
  lines.push('');
  if (report.nativeFunnel.byIdentity.size > 0) {
    lines.push('### By canonical identity');
    lines.push('');
    lines.push('| Identity | Eligible | Selected | Intent | Materialized | Launched | Terminal | Valid | Typed failures |');
    lines.push('|----------|----------|----------|--------|--------------|----------|----------|-------|-----------------|');
    for (const ident of report.nativeFunnel.byIdentity.values()) {
      const tf = ident.typedFailures;
      const tfSummary = `t=${tf.timeout ?? 0} p=${tf.providerFailure ?? 0} i=${tf.invalidResponse ?? 0} o=${tf.other ?? 0}`;
      lines.push(`| ${ident.identity} | ${ident.eligibleOpportunity} | ${ident.challengeSelected} | ${ident.intentPersisted} | ${ident.deferredArmMaterialized} | ${ident.variedStageLaunched} | ${ident.terminalOutcome} | ${ident.validComparison} | ${tfSummary} |`);
    }
    lines.push('');
  }
  lines.push('## Rollout gates');
  lines.push('');
  const g = report.gateChecks;
  lines.push(`- No phantoms from persisted intent: ${g.noPhantomsFromPersistedIntent}`);
  lines.push(`- Stage selection agrees with launch preflight: ${g.stageSelectionAgreesWithLaunchPreflight}`);
  lines.push(`- Zero coverage does not repeat: ${g.zeroCoverageDoesNotRepeat}`);
  lines.push(`- Native review typed failures routed: ${g.nativeReviewTypedFailuresRouted}`);
  lines.push(`- Fresh passing coding canaries: ${g.freshPassingCodingCanaries} (min met: ${g.freshPassingCanaryMinimumMet})`);
  lines.push(`- challenge.rate unchanged: ${g.challengeRateUnchanged}`);
  lines.push(`- Coding-ready native supply positive: ${g.codingReadyNativeSupplyPositive}`);
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(`- Decision: **${report.recommendation.decision}**`);
  lines.push(`- Extend fork to coder-stage: **${report.recommendation.extendForkToCoderStage}**`);
  for (const reason of report.recommendation.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push('');
  if (report.evidenceGaps.length > 0) {
    lines.push('## Evidence gaps');
    lines.push('');
    for (const gap of report.evidenceGaps) {
      lines.push(`- ${gap}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatArbiterR6ReportJson(report: R6Report): Record<string, unknown> {
  const cohortEntries: Record<string, unknown> = {};
  for (const [cohortId, cohort] of report.cohorts) {
    cohortEntries[cohortId] = {
      ...cohort,
      causes: Object.fromEntries(cohort.causes),
      bySharedPrefix: Object.fromEntries(cohort.bySharedPrefix),
    };
  }
  return {
    window: report.window,
    totals: report.totals,
    cohorts: cohortEntries,
    counterfactual: report.counterfactual,
    nativeFunnel: {
      steps: report.nativeFunnel.steps.map((step) => ({
        ...step,
        dropReasons: Object.fromEntries(step.dropReasons),
      })),
      byIdentity: Object.fromEntries(report.nativeFunnel.byIdentity),
      phantomPairsFromPersistedIntent: report.nativeFunnel.phantomPairsFromPersistedIntent,
      successfulCoverageCount: report.nativeFunnel.successfulCoverageCount,
      terminalAttemptCount: report.nativeFunnel.terminalAttemptCount,
    },
    gateChecks: report.gateChecks,
    recommendation: report.recommendation,
    evidenceGaps: report.evidenceGaps,
  };
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function money(value: number | null): string {
  if (value === null) return 'n/a';
  return `$${value.toFixed(4)}`;
}

function seconds(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value.toFixed(1)}s`;
}
