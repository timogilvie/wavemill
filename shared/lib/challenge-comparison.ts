import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import { isChallengeRecordVoided, readChallengeRecordVoids } from './challenge-record-void.ts';
import { getEffectiveRegistry, resolveModelRegistryKey } from './model-registry.ts';
import { resolveWavemillAliasFromOpenRouterId } from './openrouter-catalog.ts';
import type { StageExecutionEvidenceStatus, StageName, StageResult, StageStatus } from './stage-result.ts';
import type { ChallengeArmFailure } from './arm-failure-taxonomy.ts';
import type { ChallengeStage } from './challenge-mode.ts';
import type {
  DeliveryVerdict,
  ForkIdentity,
  InvalidChallengeReason,
  ReviewExecutedIdentitySet,
  StageAttribution,
} from './challenge-execution-contract.ts';
import type { PrDiffUnavailableReason } from './pr-diff-provider.ts';

export interface ChallengeRoutingMeta {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: string;
  codeDepth: string;
  reviewMode: string;
  routerVariant?: string;
  plannerPromptVariant?: string;
  reviewerPromptVariant?: string;
}

export interface VariedDimensions {
  planner: boolean;
  coder: boolean;
  reviewer: boolean;
  planDepth: boolean;
  codeDepth: boolean;
  reviewMode: boolean;
  routerVariant: boolean;
  plannerPromptVariant: boolean;
  reviewerPromptVariant: boolean;
}

export type RoutingDimensionKey =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'planDepth'
  | 'codeDepth'
  | 'reviewMode';

export type ChallengeType =
  | 'coder-only'
  | 'planner-only'
  | 'reviewer-only'
  | 'multi-variable'
  | 'full-stack';

export type StageEvidenceMode = 'direct' | 'inferred-fallback' | 'not-applicable';
export type ChallengeComparisonOutcome = 'compared' | 'skipped' | 'forfeit' | 'double-forfeit' | 'invalid' | 'inconclusive' | 'invalid_challenge';
export type ChallengeTerminalReason =
  | 'eval_hard_failed'
  | 'primary_eval_hard_failed'
  | 'challenger_eval_hard_failed'
  | 'both_eval_hard_failed'
  | 'primary_challenge_aborted'
  | 'challenger_challenge_aborted'
  | 'both_challenge_aborted'
  | 'orphan_pair'
  | 'primary_merged'
  | 'provenance_validation_failed';
export type ChallengeStageRole = 'planner' | 'coder' | 'reviewer';
export type ChallengeProvenanceSource =
  | '.planning-result.json'
  | '.coding-result.json'
  | '.review-result.json'
  | 'eval.executedPlanning'
  | 'inherited'
  | 'missing'
  | 'malformed-artifact';

/**
 * Diff identity for one side of a comparison (P0.2).
 * Tracks the exact commit/merge SHA and file changes for the varied stage.
 */
export interface ChallengeDiffIdentity {
  head_sha: string | null;
  merge_sha: string | null;
  files_touched: string[];
  line_ranges: Array<{ file: string; start: number; end: number }>;
}

export type DiffAvailabilitySummary =
  | { available: true; source: 'gh-pr-diff' | 'local-git'; bytes?: number }
  | { available: false; reason: PrDiffUnavailableReason; detail: string };

/**
 * Per-criterion rationale from the judge (P0.3).
 * Mirrors the rubric criteria and holds a rationale string for each.
 */
export interface ChallengeCriterionRationale {
  rationale: string;
}

/** Type alias for per-criterion rationales indexed by dimension name */
export type ChallengeCriterionRationales = {
  [K in keyof ChallengeComparisonDimensions]?: ChallengeCriterionRationale;
};

/**
 * Counted, named reason a launched challenge pair produced no LLM comparison (P0.6).
 * Mirrors InvalidChallengeReason (invalid-challenge family), ChallengeTerminalReason (forfeit family),
 * provenance validation outcomes, and legacy reasons (identical_routing_dimensions).
 */
export type NoComparisonReason =
  // invalid-challenge family
  | 'identical_effective_route'
  | 'stage_override_lost'
  | 'native_launch_fallback'
  | 'operator_reroute'
  | 'state_vs_derived_side_mismatch'
  | 'missing_challenge_intent'
  | 'multiple-varied-roles'
  // legacy skip reason
  | 'identical_routing_dimensions'
  // provenance validation outcomes
  | 'provenance_invalid'
  | 'provenance_inconclusive'
  // forfeit family
  | 'primary_eval_hard_failed'
  | 'challenger_eval_hard_failed'
  | 'both_eval_hard_failed'
  | 'eval_hard_failed'
  | 'primary_challenge_aborted'
  | 'challenger_challenge_aborted'
  | 'both_challenge_aborted'
  | 'orphan_pair'
  | 'primary_merged'
  // mitigation reasons
  | 'challenger_never_launched'
  | 'challenger_eval_not_persisted'
  | 'diff_unavailable'
  | 'eval_unscored'
  | 'recovery_tie'
  | 'unknown';

export const NO_COMPARISON_REASONS = [
  'identical_effective_route',
  'stage_override_lost',
  'native_launch_fallback',
  'operator_reroute',
  'state_vs_derived_side_mismatch',
  'missing_challenge_intent',
  'multiple-varied-roles',
  'identical_routing_dimensions',
  'provenance_invalid',
  'provenance_inconclusive',
  'primary_eval_hard_failed',
  'challenger_eval_hard_failed',
  'both_eval_hard_failed',
  'eval_hard_failed',
  'primary_challenge_aborted',
  'challenger_challenge_aborted',
  'both_challenge_aborted',
  'pre_fork_primary_failure',
  'orphan_pair',
  'primary_merged',
  'challenger_never_launched',
  'challenger_eval_not_persisted',
  'diff_unavailable',
  'eval_unscored',
  'recovery_tie',
  'unknown',
] as const;

export type ChallengeProvenanceValidationReason =
  | 'missing-artifact'
  | 'malformed-artifact'
  | 'stage-not-completed'
  | 'executed-model-missing'
  | 'execution-evidence-contradicted'
  | 'executed-model-mismatch'
  | 'same-intent-different-execution';

export interface ChallengeExecutedStageProvenance {
  stage: StageName;
  role: ChallengeStageRole;
  model: string;
  rawModel?: string;
  intendedModel?: string | null;
  agent: string;
  status: StageStatus | 'missing' | 'malformed';
  source: ChallengeProvenanceSource;
  artifactPath?: string;
  consultedArtifactPaths: string[];
  executionEvidenceStatus?: StageExecutionEvidenceStatus;
  modelAttributionEligible?: boolean;
  modelAttributionIneligibleReason?: StageResult['modelAttributionIneligibleReason'];
}

export interface ChallengeSideExecutionProvenance {
  planning: ChallengeExecutedStageProvenance;
  coding: ChallengeExecutedStageProvenance;
  review: ChallengeExecutedStageProvenance;
}

export interface ChallengeProvenanceValidationIssue {
  side: 'primary' | 'challenger' | 'pair';
  stage: StageName;
  role: ChallengeStageRole;
  reason: ChallengeProvenanceValidationReason;
  intendedModel?: string;
  executedModel?: string;
  executedAgent?: string;
  status?: string;
  artifactPath?: string;
  consultedArtifactPaths?: string[];
}

export interface ChallengeProvenanceValidation {
  valid: boolean;
  modelAttributionEligible?: boolean;
  outcome?: 'invalid' | 'inconclusive' | 'invalid_challenge';
  challengedStage?: StageName;
  challengedRole?: ChallengeStageRole;
  issues: ChallengeProvenanceValidationIssue[];
  /** Details about why the challenge was invalid, e.g. which dimensions varied. */
  invalidChallengeDetails?: string;
}

export interface ChallengeComparison {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  /** Harness IDs for each arm's eval record; arms may legitimately differ. */
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  /** Exact eval rows selected against each PR's current head (HOK-2949). */
  selectedEvalEvidence?: {
    primary: { evalId: string; evaluatedPrHeadSha: string };
    challenger: { evalId: string; evaluatedPrHeadSha: string };
  };
  primaryEvalScore: number | null;
  challengerEvalScore: number | null;
  primaryCompleted?: boolean;
  challengerCompleted?: boolean;
  armFailures?: ChallengeArmFailure[];
  winner?: 'primary' | 'challenger';
  winnerModel?: string;
  rationale: string;
  dimensions: ChallengeComparisonDimensions;
  timestamp: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryExecution?: ChallengeSideExecutionProvenance;
  challengerExecution?: ChallengeSideExecutionProvenance;
  provenanceValidation?: ChallengeProvenanceValidation;
  variedDimensions?: VariedDimensions;
  challengeType?: ChallengeType;
  variedStage?: 'plan' | 'implementation' | 'review';
  stageEvidenceMode?: StageEvidenceMode;
  /** Which side was shown to the blind judge as Candidate A ('primary-first' = primary was A) */
  presentationOrder?: 'primary-first' | 'challenger-first';
  workflowInsight?: string;
  comparisonOutcome?: ChallengeComparisonOutcome;
  skipReason?: 'identical-routing-dimensions';
  invalidChallengeReason?: InvalidChallengeReason;
  invalidChallengeDetails?: string;
  invalidChallenge?: boolean;
  primaryAttestation?: unknown;
  challengerAttestation?: unknown;
  terminalReason?: ChallengeTerminalReason;
  cleanupPolicy?: 'primary-wins-close-challenger';
  /** Source of the primary comparison score (e.g. "stage.review", "stage.plan", "overall") */
  primaryEvalScoreSource?: string;
  /** Source of the challenger comparison score */
  challengerEvalScoreSource?: string;
  /** Data-quality warnings emitted when a stage score was unavailable */
  dataQualityWarnings?: string[];
  /** Whether each PR diff was available to the comparison judge. */
  diffAvailability?: {
    primary: DiffAvailabilitySummary;
    challenger: DiffAvailabilitySummary;
  };

  // Fork descriptor fields (P0.5 Phase 0, HOK-2794)
  /** The stage at which the pair forked, or null if launched independently */
  forkStage?: ChallengeStage | null;
  /** Git SHA both arms share, or null if the pair did not fork from a shared commit */
  forkCommit?: string | null;
  /** Whether the challenger inherited pre-fork execution artifacts from the primary. False until challenge.fork() ships */
  sharedPrefix?: boolean;
  /** Stages the primary arm inherited from pre-fork execution rather than executing */
  primaryInheritedStages?: ChallengeStage[];
  /** Stages the challenger arm inherited from pre-fork execution rather than executing */
  challengerInheritedStages?: ChallengeStage[];

  // Diff identity fields (P0.2, HOK-2794)
  primaryDiffIdentity?: ChallengeDiffIdentity;
  challengerDiffIdentity?: ChallengeDiffIdentity;

  // Judge provenance and cost fields (P0.3, HOK-2794)
  judge_model?: string;
  judge_prompt_hash?: string;
  primary_cost_usd?: number | null;
  challenger_cost_usd?: number | null;
  criterionRationales?: ChallengeCriterionRationales;

  // No-comparison accounting field (P0.6, HOK-2794)
  noComparisonReason?: NoComparisonReason;

  /** Final delivery decision, independent from causal stage attribution. */
  deliveryVerdict?: DeliveryVerdict;
  /** Causal validity and outcome for the varied challenge stage. */
  stageAttribution?: StageAttribution;
  /** Immutable fork/input identity proving matched pre-stage inputs. */
  forkIdentity?: ForkIdentity;
  /** Executed review identities observed for the primary arm. */
  primaryReviewExecutedIdentity?: ReviewExecutedIdentitySet;
  /** Executed review identities observed for the challenger arm. */
  challengerReviewExecutedIdentity?: ReviewExecutedIdentitySet;

  /**
   * Corrective marker written by legacy sweeps (HOK-2970) and other quarantine
   * tools. Additive — historical rows without this key remain valid; rows
   * carrying it must be excluded from stage-attribution training and coverage.
   */
  quarantined?: {
    reason: string;
    ticket: string;
    at: string;
    evidence?: Record<string, unknown>;
  };
}

export interface ChallengeComparisonDimensions {
  completeness: { primary: number; challenger: number };
  correctness: { primary: number; challenger: number };
  code_quality: { primary: number; challenger: number };
  intervention_impact: { primary: number; challenger: number };
  autonomy: { primary: number; challenger: number };
}

interface LegacyChallengeComparisonDimensions {
  correctness: { primary: number; challenger: number };
  codeQuality: { primary: number; challenger: number };
  completeness: { primary: number; challenger: number };
  scopeDiscipline: { primary: number; challenger: number };
}

export type StoredChallengeComparison = Omit<ChallengeComparison, 'dimensions'> & {
  dimensions: ChallengeComparisonDimensions | LegacyChallengeComparisonDimensions;
};

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const CHALLENGE_RECORDS_FILENAME = 'challenge-records.jsonl';
const ROUTING_DIMENSION_KEYS: readonly RoutingDimensionKey[] = [
  'planner',
  'coder',
  'reviewer',
  'planDepth',
  'codeDepth',
  'reviewMode',
];
const EMPTY_DIMENSIONS: ChallengeComparisonDimensions = {
  completeness: { primary: 0, challenger: 0 },
  correctness: { primary: 0, challenger: 0 },
  code_quality: { primary: 0, challenger: 0 },
  intervention_impact: { primary: 0, challenger: 0 },
  autonomy: { primary: 0, challenger: 0 },
};
export const JUDGE_DISAGREEMENT_THRESHOLD = 0.5;

type ComparisonRetentionInput = {
  forkStage?: ChallengeStage | null;
  forkCommit?: string | null;
  sharedPrefix?: boolean;
  primaryInheritedStages?: ChallengeStage[];
  challengerInheritedStages?: ChallengeStage[];
  forkIdentity?: ForkIdentity;
  primaryDiffIdentity?: ChallengeDiffIdentity;
  challengerDiffIdentity?: ChallengeDiffIdentity;
};

function comparisonRetentionFields(input: ComparisonRetentionInput): Pick<
  ChallengeComparison,
  | 'forkStage'
  | 'forkCommit'
  | 'sharedPrefix'
  | 'primaryInheritedStages'
  | 'challengerInheritedStages'
  | 'forkIdentity'
  | 'primaryDiffIdentity'
  | 'challengerDiffIdentity'
> {
  return {
    forkStage: input.forkStage ?? null,
    forkCommit: input.forkCommit ?? null,
    sharedPrefix: input.sharedPrefix ?? false,
    primaryInheritedStages: input.primaryInheritedStages ?? [],
    challengerInheritedStages: input.challengerInheritedStages ?? [],
    ...(input.forkIdentity ? { forkIdentity: input.forkIdentity } : {}),
    ...(input.primaryDiffIdentity ? { primaryDiffIdentity: input.primaryDiffIdentity } : {}),
    ...(input.challengerDiffIdentity ? { challengerDiffIdentity: input.challengerDiffIdentity } : {}),
  };
}

type ChallengeEntryLike = {
  planner?: string;
  model?: string;
  reviewer?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
};

type EvalExecutedPlanningLike = {
  agent?: unknown;
  model?: unknown;
  status?: unknown;
  source?: unknown;
};

type EvalRecordLike = {
  executedPlanning?: EvalExecutedPlanningLike | null;
};

const STAGE_ROLES: Record<StageName, ChallengeStageRole | undefined> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
  ready: undefined,
};

const ROLE_STAGES: Record<ChallengeStageRole, StageName> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

function resolveRecordsFile(dir?: string): string {
  const baseDir = resolve(dir || DEFAULT_EVALS_DIR);
  return join(baseDir, CHALLENGE_RECORDS_FILENAME);
}

function normalize(value: string | undefined): string {
  return value?.trim() || '';
}

function normalizeUnknown(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function canonicalizeChallengeModelId(modelId: string, repoDir?: string): string {
  const trimmed = normalize(modelId);
  if (!trimmed) return '';
  const registry = getEffectiveRegistry(repoDir);
  const registryKey = resolveModelRegistryKey(registry, trimmed);
  if (registry.models[registryKey]) {
    return registryKey;
  }
  return resolveWavemillAliasFromOpenRouterId(trimmed) ?? trimmed;
}

/**
 * True when two model ids name the same model. Canonicalisation alone misses
 * a provider-native id that is itself a registry key (e.g. the dated
 * `claude-haiku-4-5-20251001` vs its alias `claude-haiku-4-5`), so also treat
 * ids as equivalent when a registry entry declares the other as its
 * `supportedModel.providerNativeId`.
 */
export function challengeModelIdsEquivalent(
  a: string | undefined,
  b: string | undefined,
  repoDir?: string,
): boolean {
  const ca = canonicalizeChallengeModelId(a ?? '', repoDir);
  const cb = canonicalizeChallengeModelId(b ?? '', repoDir);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const registry = getEffectiveRegistry(repoDir);
  const nativeA = registry.models[ca]?.supportedModel?.providerNativeId;
  const nativeB = registry.models[cb]?.supportedModel?.providerNativeId;
  return nativeA === cb || nativeB === ca || (!!nativeA && nativeA === nativeB);
}

function variantDiffers(a: string | undefined, b: string | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na !== '' && nb !== '' && na !== nb;
}

export function routingMetaFromChallengeEntry(entry: ChallengeEntryLike): ChallengeRoutingMeta {
  return {
    planner: normalize(entry.planner),
    coder: normalize(entry.model),
    reviewer: normalize(entry.reviewer),
    planDepth: normalize(entry.planDepth),
    codeDepth: normalize(entry.codeDepth),
    reviewMode: normalize(entry.reviewMode),
  };
}

export function listVariedRoutingDimensions(
  primaryRouting: ChallengeRoutingMeta | undefined,
  challengerRouting: ChallengeRoutingMeta | undefined,
): RoutingDimensionKey[] {
  if (!primaryRouting || !challengerRouting) {
    return [];
  }

  return ROUTING_DIMENSION_KEYS.filter(
    (key) => normalize(primaryRouting[key]) !== normalize(challengerRouting[key]),
  );
}

/**
 * Detect which dimensions varied between primary and challenger routing.
 * Returns undefined if either routing is missing.
 */
export function detectVariedDimensions(
  primaryRouting: ChallengeRoutingMeta | undefined,
  challengerRouting: ChallengeRoutingMeta | undefined,
): VariedDimensions | undefined {
  if (!primaryRouting || !challengerRouting) {
    return undefined;
  }
  const variedRoutingDimensions = new Set(listVariedRoutingDimensions(primaryRouting, challengerRouting));

  return {
    planner: variedRoutingDimensions.has('planner'),
    coder: variedRoutingDimensions.has('coder'),
    reviewer: variedRoutingDimensions.has('reviewer'),
    planDepth: variedRoutingDimensions.has('planDepth'),
    codeDepth: variedRoutingDimensions.has('codeDepth'),
    reviewMode: variedRoutingDimensions.has('reviewMode'),
    routerVariant: variantDiffers(primaryRouting.routerVariant, challengerRouting.routerVariant),
    plannerPromptVariant: variantDiffers(primaryRouting.plannerPromptVariant, challengerRouting.plannerPromptVariant),
    reviewerPromptVariant: variantDiffers(primaryRouting.reviewerPromptVariant, challengerRouting.reviewerPromptVariant),
  };
}

export function hasAnyVariedDimension(varied: VariedDimensions): boolean {
  return Object.values(varied).some(Boolean);
}

/**
 * Classify the challenge type based on which dimensions varied.
 */
export function classifyChallengeType(varied: VariedDimensions): ChallengeType {
  if (!hasAnyVariedDimension(varied)) {
    throw new Error('Cannot classify challenge type: no routing dimensions varied');
  }

  const roleChanges = [varied.planner, varied.coder, varied.reviewer].filter(Boolean).length;
  // Base config dimensions are the original 3; new variant dimensions are additive.
  // Keep them separate so legacy records (which lack variant fields) can still reach 'full-stack'.
  const baseConfigChanges = [varied.planDepth, varied.codeDepth, varied.reviewMode].filter(Boolean).length;
  const totalConfigChanges = baseConfigChanges + [
    varied.routerVariant,
    varied.plannerPromptVariant,
    varied.reviewerPromptVariant,
  ].filter(Boolean).length;

  // All base dimensions varied (roles + original config); variant fields are optional extras
  if (roleChanges === 3 && baseConfigChanges === 3) {
    return 'full-stack';
  }

  // Exactly one role varied, no config changes
  if (roleChanges === 1 && totalConfigChanges === 0) {
    if (varied.planner) return 'planner-only';
    if (varied.coder) return 'coder-only';
    if (varied.reviewer) return 'reviewer-only';
  }

  // Multiple variables changed
  return 'multi-variable';
}

/**
 * Derive noComparisonReason from a record's legacy fields.
 * Returns undefined for compared/manual-with-winner records.
 * Returns the explicit field if present and valid, otherwise derives from legacy fields.
 */
export function deriveNoComparisonReason(
  record: Pick<StoredChallengeComparison, 'comparisonOutcome' | 'skipReason' | 'invalidChallengeReason' | 'terminalReason' | 'provenanceValidation' | 'recordKind' | 'winner' | 'noComparisonReason'>
): NoComparisonReason | undefined {
  // Compared and manual-with-winner records have no reason.
  if (record.comparisonOutcome === 'compared' || (record.comparisonOutcome === 'manual' && record.winner)) {
    return undefined;
  }

  // If explicit field is set and valid, use it.
  if (record.noComparisonReason) {
    const valid = NO_COMPARISON_REASONS.includes(record.noComparisonReason as NoComparisonReason);
    if (valid) return record.noComparisonReason as NoComparisonReason;
  }

  // Derive from legacy fields.
  if (record.invalidChallengeReason) {
    return record.invalidChallengeReason as NoComparisonReason;
  }

  if (record.skipReason === 'identical-routing-dimensions') {
    return 'identical_routing_dimensions';
  }

  if (record.skipReason === 'challenger-eval-not-persisted') {
    return 'challenger_eval_not_persisted';
  }

  if (record.comparisonOutcome === 'invalid') {
    // Check if it's from provenance validation
    if (record.provenanceValidation?.outcome === 'invalid') {
      return 'provenance_invalid';
    }
    if (record.provenanceValidation?.outcome === 'inconclusive') {
      return 'provenance_inconclusive';
    }
    return 'provenance_invalid';
  }

  if (record.comparisonOutcome === 'inconclusive') {
    // Superseding record with equal scores → recovery_tie
    if (record.recordKind === 'superseding-comparison') {
      return 'recovery_tie';
    }
    return 'provenance_inconclusive';
  }

  // HOK-2970: invalid_challenge records that came from the auto-resolve path
  // (aborted-arm-was-invalid) carry the aborted eval's invalidChallengeReason
  // as their no-comparison reason.
  if (record.comparisonOutcome === 'invalid_challenge') {
    return 'missing_challenge_intent';
  }

  // Forfeit and double-forfeit use terminalReason
  if (record.terminalReason) {
    return record.terminalReason as NoComparisonReason;
  }

  // Fallback for records with neither comparisonOutcome nor winner
  return 'unknown';
}

export function appendChallengeComparison(record: ChallengeComparison, dir?: string): void {
  const recordToAppend = { ...record };

  // If record is non-compared and noComparisonReason is missing, fill it with derived value.
  if (recordToAppend.comparisonOutcome !== 'compared' && !recordToAppend.noComparisonReason) {
    const derived = deriveNoComparisonReason(recordToAppend);
    if (derived) {
      recordToAppend.noComparisonReason = derived;
    } else if (derived === 'unknown') {
      recordToAppend.noComparisonReason = 'unknown';
      console.warn(`[HOK-2798] Challenge record has unknown no-comparison reason: ${recordToAppend.challengePairId}`);
    }
  }

  // Warn once per session if reason is unknown
  if (recordToAppend.noComparisonReason === 'unknown' && !global.wavemill_unknown_reason_warned) {
    console.warn('[HOK-2798] Appending record with unknown no-comparison reason');
    (global as any).wavemill_unknown_reason_warned = true;
  }

  appendJsonlRecord(resolveRecordsFile(dir), recordToAppend);
}

export function isDecisiveChallengeComparison(record: Pick<ChallengeComparison, 'comparisonOutcome' | 'primaryCompleted' | 'challengerCompleted' | 'armFailures' | 'terminalReason' | 'invalidChallenge' | 'quarantined'>): boolean {
  const outcome = record.comparisonOutcome;
  // HOK-2970: a `forfeit` whose losing arm was actually `invalid_challenge`
  // must never be treated as decisive by the merge lane or by stage-attribution
  // training. New records use `invalid_challenge` directly (see
  // `buildInvalidChallengeArmComparison`); this guard catches legacy pre-fix
  // rows still on disk before the quarantine sweep has been applied, and any
  // row corrected by that sweep.
  if (record.invalidChallenge === true) {
    return false;
  }
  if (record.quarantined) {
    return false;
  }
  if (
    record.terminalReason === 'eval_hard_failed'
    || record.terminalReason === 'primary_eval_hard_failed'
    || record.terminalReason === 'challenger_eval_hard_failed'
    || record.terminalReason === 'both_eval_hard_failed'
  ) {
    return true;
  }
  const completionFieldsPresent =
    Object.prototype.hasOwnProperty.call(record, 'primaryCompleted')
    || Object.prototype.hasOwnProperty.call(record, 'challengerCompleted');
  if (!completionFieldsPresent) {
    return true;
  }
  if (
    (outcome === 'forfeit' || outcome === 'double-forfeit')
    && record.primaryCompleted !== true
    && record.challengerCompleted !== true
    && (record.armFailures?.length ?? 0) === 0
  ) {
    return false;
  }
  return true;
}

function stageResultFileName(stage: StageName): ChallengeProvenanceSource {
  if (stage === 'planning') return '.planning-result.json';
  if (stage === 'coding') return '.coding-result.json';
  if (stage === 'review') return '.review-result.json';
  throw new Error(`Unsupported challenge provenance stage: ${stage}`);
}

function emptyStageProvenance(
  stage: StageName,
  source: ChallengeProvenanceSource,
  consultedArtifactPaths: string[],
): ChallengeExecutedStageProvenance {
  const role = STAGE_ROLES[stage];
  if (!role) {
    throw new Error(`Unsupported challenge provenance stage: ${stage}`);
  }
  return {
    stage,
    role,
    model: '',
    agent: '',
    status: source === 'malformed-artifact' ? 'malformed' : 'missing',
    source,
    consultedArtifactPaths,
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pinnedReviewExecutedIdentity(result: StageResult): { model: string; requestedModel?: string; agent?: string } | null {
  const artifacts = stringRecord(result.artifacts);
  const identity = stringRecord(artifacts?.reviewExecutedIdentity);
  const substantive = stringRecord(identity?.substantiveAnalysis);
  if (!substantive || substantive.pinned !== true) return null;
  const model = normalizeUnknown(substantive.resolvedModel);
  if (!model) return null;
  return {
    model,
    requestedModel: normalizeUnknown(substantive.requestedModel) || undefined,
    agent: normalizeUnknown(substantive.agent) || undefined,
  };
}

function parseStageArtifact(
  stage: StageName,
  artifactPath: string,
  repoDir?: string,
): ChallengeExecutedStageProvenance {
  const consultedArtifactPaths = [artifactPath];
  const defaultSource = stageResultFileName(stage);
  if (!existsSync(artifactPath)) {
    return emptyStageProvenance(stage, 'missing', consultedArtifactPaths);
  }

  let parsed: StageResult;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf-8')) as StageResult;
  } catch {
    return {
      ...emptyStageProvenance(stage, 'malformed-artifact', consultedArtifactPaths),
      artifactPath,
    };
  }

  if (parsed?.stage !== stage || !parsed.status) {
    return {
      ...emptyStageProvenance(stage, 'malformed-artifact', consultedArtifactPaths),
      artifactPath,
    };
  }

  const hasExecutedModel = hasOwn(parsed, 'executedModel');
  const reviewIdentity = stage === 'review' ? pinnedReviewExecutedIdentity(parsed) : null;
  const rawModel = hasExecutedModel
    ? normalizeUnknown(parsed.executedModel)
    : reviewIdentity?.model ?? '';
  const rawIntendedModel = hasOwn(parsed, 'intendedModel')
    ? normalizeUnknown(parsed.intendedModel)
    : reviewIdentity?.requestedModel ?? normalizeUnknown(parsed.model);
  // A stage result stamped `source: "inherited"` was carried across a
  // challenge fork (HOK-2811). The file lives on the challenger's disk but
  // does not describe a run performed there — preserve model/agent/status
  // for provenance, but surface the inherited source rather than the
  // filename so readers can attribute the run to the shared prefix.
  const source: ChallengeProvenanceSource = parsed.source === 'inherited'
    ? 'inherited'
    : defaultSource;
  return {
    stage,
    role: STAGE_ROLES[stage] as ChallengeStageRole,
    model: canonicalizeChallengeModelId(rawModel, repoDir),
    rawModel,
    intendedModel: rawIntendedModel || null,
    agent: reviewIdentity?.agent ?? normalizeUnknown(parsed.agent),
    status: parsed.status,
    source,
    artifactPath,
    consultedArtifactPaths,
    executionEvidenceStatus: parsed.executionEvidence?.status ?? (reviewIdentity ? 'direct' : 'missing'),
    modelAttributionEligible: parsed.modelAttributionEligible ?? (reviewIdentity ? parsed.status === 'completed' : false),
    modelAttributionIneligibleReason: parsed.modelAttributionIneligibleReason,
  };
}

function evalPlanningFallback(
  evalRecord: EvalRecordLike | undefined,
  existing: ChallengeExecutedStageProvenance,
  repoDir?: string,
): ChallengeExecutedStageProvenance {
  if (existing.status !== 'missing') {
    return existing;
  }
  const executedPlanning = evalRecord?.executedPlanning;
  if (!executedPlanning || typeof executedPlanning !== 'object') {
    return existing;
  }
  const rawModel = normalizeUnknown(executedPlanning.model);
  const status = normalizeUnknown(executedPlanning.status);
  return {
    stage: 'planning',
    role: 'planner',
    model: canonicalizeChallengeModelId(rawModel, repoDir),
    rawModel,
    intendedModel: null,
    agent: normalizeUnknown(executedPlanning.agent),
    status: status === 'completed' ? 'completed' : (status as StageStatus || 'completed'),
    source: 'eval.executedPlanning',
    consultedArtifactPaths: existing.consultedArtifactPaths,
    executionEvidenceStatus: rawModel ? 'direct' : 'missing',
    modelAttributionEligible: status === 'completed' && Boolean(rawModel),
    ...(!rawModel ? { modelAttributionIneligibleReason: 'missing_execution_evidence' as const } : {}),
  };
}

export function resolveChallengeSideExecutionProvenance(input: {
  featureDir?: string;
  repoDir?: string;
  evalRecord?: EvalRecordLike;
}): ChallengeSideExecutionProvenance {
  const stagePath = (stage: StageName) => input.featureDir ? join(input.featureDir, stageResultFileName(stage)) : '';
  const planning = input.featureDir
    ? parseStageArtifact('planning', stagePath('planning'), input.repoDir)
    : emptyStageProvenance('planning', 'missing', []);
  const coding = input.featureDir
    ? parseStageArtifact('coding', stagePath('coding'), input.repoDir)
    : emptyStageProvenance('coding', 'missing', []);
  const review = input.featureDir
    ? parseStageArtifact('review', stagePath('review'), input.repoDir)
    : emptyStageProvenance('review', 'missing', []);

  return {
    planning: evalPlanningFallback(input.evalRecord, planning, input.repoDir),
    coding,
    review,
  };
}

export function challengeRoleForVariedDimensions(varied: VariedDimensions | undefined): ChallengeStageRole | undefined {
  if (!varied) return undefined;
  const roles: ChallengeStageRole[] = [];
  if (varied.planner) roles.push('planner');
  if (varied.coder) roles.push('coder');
  if (varied.reviewer) roles.push('reviewer');
  return roles.length === 1 ? roles[0] : undefined;
}

/**
 * List all roles that differ between primary and challenger.
 */
export function listVariedRoles(varied: VariedDimensions | undefined): ChallengeStageRole[] {
  if (!varied) return [];
  const roles: ChallengeStageRole[] = [];
  if (varied.planner) roles.push('planner');
  if (varied.coder) roles.push('coder');
  if (varied.reviewer) roles.push('reviewer');
  return roles;
}

/**
 * List all varied dimension names (roles and non-roles).
 */
export function getVariedDimensionNames(varied: VariedDimensions | undefined): string[] {
  if (!varied) return [];
  const dims: string[] = [];
  if (varied.planner) dims.push('planner');
  if (varied.coder) dims.push('coder');
  if (varied.reviewer) dims.push('reviewer');
  if (varied.planDepth) dims.push('planDepth');
  if (varied.codeDepth) dims.push('codeDepth');
  if (varied.reviewMode) dims.push('reviewMode');
  if (varied.routerVariant) dims.push('routerVariant');
  if (varied.plannerPromptVariant) dims.push('plannerPromptVariant');
  if (varied.reviewerPromptVariant) dims.push('reviewerPromptVariant');
  return dims;
}

/**
 * Check if more than one role varies, violating the one-variable invariant.
 */
export function hasMultiRoleVariation(varied: VariedDimensions | undefined): boolean {
  const roles = listVariedRoles(varied);
  return roles.length > 1;
}

/**
 * Check if a role varies alongside a non-role dimension (e.g., role + depth or role + mode).
 * This also violates the one-variable invariant.
 */
export function hasRoleAndNonRoleVariation(varied: VariedDimensions | undefined): boolean {
  if (!varied) return false;
  const roles = listVariedRoles(varied);
  if (roles.length === 0) return false;
  const nonRoles = [
    varied.planDepth,
    varied.codeDepth,
    varied.reviewMode,
    varied.routerVariant,
    varied.plannerPromptVariant,
    varied.reviewerPromptVariant,
  ];
  return nonRoles.some(Boolean);
}

/**
 * Check if the challenger's non-selected stages diverge from the primary's finalized route.
 * For an implementation-stage challenge, checks that planner and reviewer match.
 * Returns diverged dimensions if any are found.
 */
export function detectChallengerRouteNonSelectedDivergence(
  primaryRouting: ChallengeRoutingMeta | undefined,
  challengerRouting: ChallengeRoutingMeta | undefined,
  variedStage?: 'plan' | 'implementation' | 'review',
): string[] {
  if (!primaryRouting || !challengerRouting) return [];

  const diverged: string[] = [];

  // For each stage, check non-selected dimensions
  if (variedStage === 'plan') {
    // Coding and review are non-selected
    if (primaryRouting.coder !== challengerRouting.coder) diverged.push('coder');
    if (primaryRouting.codeDepth !== challengerRouting.codeDepth) diverged.push('codeDepth');
    if (primaryRouting.reviewer !== challengerRouting.reviewer) diverged.push('reviewer');
    if ((primaryRouting.reviewMode || primaryRouting.reviewRecommended) !== (challengerRouting.reviewMode || challengerRouting.reviewRecommended)) {
      diverged.push('reviewMode');
    }
  } else if (variedStage === 'implementation') {
    // Planning and review are non-selected
    if (primaryRouting.planner !== challengerRouting.planner) diverged.push('planner');
    if (primaryRouting.planDepth !== challengerRouting.planDepth) diverged.push('planDepth');
    if (primaryRouting.reviewer !== challengerRouting.reviewer) diverged.push('reviewer');
    if ((primaryRouting.reviewMode || primaryRouting.reviewRecommended) !== (challengerRouting.reviewMode || challengerRouting.reviewRecommended)) {
      diverged.push('reviewMode');
    }
  } else if (variedStage === 'review') {
    // Planning and coding are non-selected
    if (primaryRouting.planner !== challengerRouting.planner) diverged.push('planner');
    if (primaryRouting.planDepth !== challengerRouting.planDepth) diverged.push('planDepth');
    if (primaryRouting.coder !== challengerRouting.coder) diverged.push('coder');
    if (primaryRouting.codeDepth !== challengerRouting.codeDepth) diverged.push('codeDepth');
  }

  return diverged;
}

function stageForRole(role: ChallengeStageRole): StageName {
  return ROLE_STAGES[role];
}

export function modelForChallengeVariedStage(
  execution: ChallengeSideExecutionProvenance | undefined,
  challengeType: ChallengeType | undefined,
  fallbackModel: string,
): string {
  const role = challengeType === 'planner-only'
    ? 'planner'
    : challengeType === 'reviewer-only'
      ? 'reviewer'
      : challengeType === 'coder-only'
        ? 'coder'
        : undefined;
  if (!role || !execution) return fallbackModel || 'unknown';
  const stage = stageForRole(role);
  return execution[stage]?.model || fallbackModel || 'unknown';
}

function intendedModelForRole(routing: ChallengeRoutingMeta | undefined, role: ChallengeStageRole, fallbackCoder: string): string {
  if (!routing) return role === 'coder' ? fallbackCoder : '';
  if (role === 'planner') return routing.planner;
  if (role === 'reviewer') return routing.reviewer;
  return routing.coder || fallbackCoder;
}

function addStageValidationIssue(
  issues: ChallengeProvenanceValidationIssue[],
  side: 'primary' | 'challenger',
  stageProvenance: ChallengeExecutedStageProvenance,
  reason: ChallengeProvenanceValidationReason,
  intendedModel?: string,
): void {
  issues.push({
    side,
    stage: stageProvenance.stage,
    role: stageProvenance.role,
    reason,
    intendedModel,
    executedModel: stageProvenance.model,
    executedAgent: stageProvenance.agent,
    status: stageProvenance.status,
    artifactPath: stageProvenance.artifactPath,
    consultedArtifactPaths: stageProvenance.consultedArtifactPaths,
  });
}

function validateStageForSide(input: {
  side: 'primary' | 'challenger';
  provenance: ChallengeSideExecutionProvenance;
  routing?: ChallengeRoutingMeta;
  fallbackCoder: string;
  role: ChallengeStageRole;
  repoDir?: string;
  issues: ChallengeProvenanceValidationIssue[];
}): void {
  const stage = stageForRole(input.role);
  const stageProvenance = input.provenance[stage];
  const intendedModel = canonicalizeChallengeModelId(
    intendedModelForRole(input.routing, input.role, input.fallbackCoder),
    input.repoDir,
  );
  if (stageProvenance.status === 'missing') {
    addStageValidationIssue(input.issues, input.side, stageProvenance, 'missing-artifact', intendedModel);
    return;
  }
  if (stageProvenance.status === 'malformed') {
    addStageValidationIssue(input.issues, input.side, stageProvenance, 'malformed-artifact', intendedModel);
    return;
  }
  if (stageProvenance.status !== 'completed') {
    addStageValidationIssue(input.issues, input.side, stageProvenance, 'stage-not-completed', intendedModel);
    return;
  }
  if (!stageProvenance.model) {
    addStageValidationIssue(input.issues, input.side, stageProvenance, 'executed-model-missing', intendedModel);
    return;
  }
  if (
    stageProvenance.executionEvidenceStatus === 'contradicted'
    || stageProvenance.modelAttributionIneligibleReason === 'execution_contradicted'
  ) {
    addStageValidationIssue(input.issues, input.side, stageProvenance, 'execution-evidence-contradicted', intendedModel);
    return;
  }
  if (
    intendedModel
    && stageProvenance.model
    && !challengeModelIdsEquivalent(stageProvenance.model, intendedModel, input.repoDir)
  ) {
    addStageValidationIssue(input.issues, input.side, stageProvenance, 'executed-model-mismatch', intendedModel);
  }
}

function isFatalProvenanceIssue(issue: ChallengeProvenanceValidationIssue): boolean {
  return issue.reason !== 'executed-model-mismatch';
}

function materiallyDifferentExecution(
  primary: ChallengeExecutedStageProvenance,
  challenger: ChallengeExecutedStageProvenance,
  repoDir?: string,
): boolean {
  if (primary.status === 'missing' || challenger.status === 'missing') return false;
  if (primary.status === 'malformed' || challenger.status === 'malformed') return false;
  if (primary.agent !== challenger.agent) return true;
  if (primary.model === challenger.model) return false;
  return !challengeModelIdsEquivalent(primary.model, challenger.model, repoDir);
}

export function validateChallengeExecutionProvenance(input: {
  primaryExecution: ChallengeSideExecutionProvenance;
  challengerExecution: ChallengeSideExecutionProvenance;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryModel: string;
  challengerModel: string;
  variedDimensions?: VariedDimensions;
  variedStage?: 'plan' | 'implementation' | 'review';
  repoDir?: string;
}): ChallengeProvenanceValidation {
  const issues: ChallengeProvenanceValidationIssue[] = [];

  // Detect multi-role variation or role-plus-non-role variation (invariant violation)
  if (hasMultiRoleVariation(input.variedDimensions) || hasRoleAndNonRoleVariation(input.variedDimensions)) {
    const variedDims = getVariedDimensionNames(input.variedDimensions);
    const details = `Multiple varied dimensions: ${variedDims.join(', ')}`;
    return {
      valid: false,
      modelAttributionEligible: false,
      outcome: 'invalid_challenge',
      invalidChallengeDetails: details,
      issues,
    };
  }

  // Detect challenger's non-selected stage route divergence (phase 2 violation)
  const divergedDims = detectChallengerRouteNonSelectedDivergence(
    input.primaryRouting,
    input.challengerRouting,
    input.variedStage,
  );
  if (divergedDims.length > 0) {
    const details = `Challenger non-selected stages diverged from primary: ${divergedDims.join(', ')}`;
    return {
      valid: false,
      modelAttributionEligible: false,
      outcome: 'invalid_challenge',
      invalidChallengeDetails: details,
      issues,
    };
  }

  const role = challengeRoleForVariedDimensions(input.variedDimensions);

  if (role) {
    validateStageForSide({
      side: 'primary',
      provenance: input.primaryExecution,
      routing: input.primaryRouting,
      fallbackCoder: input.primaryModel,
      role,
      repoDir: input.repoDir,
      issues,
    });
    validateStageForSide({
      side: 'challenger',
      provenance: input.challengerExecution,
      routing: input.challengerRouting,
      fallbackCoder: input.challengerModel,
      role,
      repoDir: input.repoDir,
      issues,
    });
    const fatalIssues = issues.filter(isFatalProvenanceIssue);
    return {
      valid: fatalIssues.length === 0,
      modelAttributionEligible: issues.length === 0,
      outcome: fatalIssues.length === 0 ? undefined : 'invalid',
      challengedStage: stageForRole(role),
      challengedRole: role,
      issues,
    };
  }

  if (input.variedDimensions && !hasAnyVariedDimension(input.variedDimensions)) {
    for (const stage of ['planning', 'coding', 'review'] as const) {
      const primaryStage = input.primaryExecution[stage];
      const challengerStage = input.challengerExecution[stage];
      if (materiallyDifferentExecution(primaryStage, challengerStage, input.repoDir)) {
        issues.push({
          side: 'pair',
          stage,
          role: primaryStage.role,
          reason: 'same-intent-different-execution',
          executedModel: `primary=${primaryStage.model}; challenger=${challengerStage.model}`,
          executedAgent: `primary=${primaryStage.agent}; challenger=${challengerStage.agent}`,
          artifactPath: primaryStage.artifactPath || challengerStage.artifactPath,
          consultedArtifactPaths: [
            ...primaryStage.consultedArtifactPaths,
            ...challengerStage.consultedArtifactPaths,
          ],
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    modelAttributionEligible: issues.length === 0,
    outcome: issues.length === 0 ? undefined : 'inconclusive',
    issues,
  };
}

export function buildInvalidProvenanceComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryExecution: ChallengeSideExecutionProvenance;
  challengerExecution: ChallengeSideExecutionProvenance;
  provenanceValidation: ChallengeProvenanceValidation;
  variedDimensions?: VariedDimensions;
  challengeType?: ChallengeType;
  variedStage?: 'plan' | 'implementation' | 'review';
  timestamp?: string;
} & ComparisonRetentionInput): ChallengeComparison {
  const outcome = input.provenanceValidation.outcome ?? 'invalid';
  const reason = outcome === 'invalid_challenge'
    ? input.provenanceValidation.invalidChallengeDetails || 'multiple varied dimensions'
    : input.provenanceValidation.issues
      .map((issue) => {
        const side = issue.side === 'pair' ? 'pair' : `${issue.side} ${issue.role}`;
        const path = issue.artifactPath ? ` (${issue.artifactPath})` : '';
        const intended = issue.intendedModel ? ` intended=${issue.intendedModel}` : '';
        const executed = issue.executedModel ? ` executed=${issue.executedModel}` : '';
        return `${side}: ${issue.reason}${intended}${executed}${path}`;
      })
      .join('; ');

  let noComparisonReason: NoComparisonReason;
  let invalidChallengeReason: InvalidChallengeReason | undefined;
  if (outcome === 'invalid_challenge') {
    noComparisonReason = 'multiple-varied-roles';
    invalidChallengeReason = 'multiple-varied-roles';
  } else {
    noComparisonReason = outcome === 'invalid' ? 'provenance_invalid' : 'provenance_inconclusive';
  }

  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: input.primaryEvalScore,
    challengerEvalScore: input.challengerEvalScore,
    rationale: `Challenge comparison ${outcome}: ${reason || 'execution provenance did not validate'}.`,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    primaryExecution: input.primaryExecution,
    challengerExecution: input.challengerExecution,
    provenanceValidation: input.provenanceValidation,
    variedDimensions: input.variedDimensions,
    challengeType: input.challengeType,
    variedStage: input.variedStage,
    comparisonOutcome: outcome,
    invalidChallengeReason,
    invalidChallenge: outcome === 'invalid_challenge',
    invalidChallengeDetails: input.provenanceValidation.invalidChallengeDetails,
    terminalReason: 'provenance_validation_failed',
    noComparisonReason,
    ...comparisonRetentionFields(input),
  };
}

export function buildSkippedIdenticalComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  timestamp?: string;
} & ComparisonRetentionInput): ChallengeComparison {
  const variedDimensions = detectVariedDimensions(input.primaryRouting, input.challengerRouting);
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: input.primaryEvalScore,
    challengerEvalScore: input.challengerEvalScore,
    winner: 'primary',
    rationale: 'Comparison skipped because primary and challenger used identical routing dimensions.',
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    variedDimensions,
    workflowInsight: 'No LLM comparison was run because both workflows resolved to identical routing dimensions.',
    comparisonOutcome: 'skipped',
    skipReason: 'identical-routing-dimensions',
    noComparisonReason: 'identical_routing_dimensions',
    cleanupPolicy: 'primary-wins-close-challenger',
    ...comparisonRetentionFields(input),
  };
}

export function buildInvalidChallengeComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  reason: 'stage_override_lost' | 'native_launch_fallback' | 'identical_effective_route' | 'operator_reroute' | 'state_vs_derived_side_mismatch' | 'missing_challenge_intent';
  details?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryAttestation?: unknown;
  challengerAttestation?: unknown;
  timestamp?: string;
} & ComparisonRetentionInput): ChallengeComparison {
  const variedDimensions = detectVariedDimensions(input.primaryRouting, input.challengerRouting);
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: input.primaryEvalScore,
    challengerEvalScore: input.challengerEvalScore,
    rationale: input.details || `Invalid challenge: ${input.reason}`,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    variedDimensions,
    comparisonOutcome: 'invalid_challenge',
    invalidChallenge: true,
    invalidChallengeReason: input.reason,
    noComparisonReason: input.reason as NoComparisonReason,
    ...(input.details ? { invalidChallengeDetails: input.details } : {}),
    ...(input.primaryAttestation ? { primaryAttestation: input.primaryAttestation } : {}),
    ...(input.challengerAttestation ? { challengerAttestation: input.challengerAttestation } : {}),
    workflowInsight: 'No LLM comparison was run because the selected challenge intent did not execute.',
    ...comparisonRetentionFields(input),
  };
}

type InconclusiveComparisonInput = {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number | null;
  challengerEvalScore: number | null;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryExecution?: ChallengeSideExecutionProvenance;
  challengerExecution?: ChallengeSideExecutionProvenance;
  provenanceValidation?: ChallengeProvenanceValidation;
  variedDimensions?: VariedDimensions;
  challengeType?: ChallengeType;
  variedStage?: 'plan' | 'implementation' | 'review';
  stageEvidenceMode?: StageEvidenceMode;
  timestamp?: string;
  diffAvailability?: ChallengeComparison['diffAvailability'];
  rationale: string;
  noComparisonReason: 'diff_unavailable' | 'eval_unscored';
} & ComparisonRetentionInput;

function buildInconclusiveComparison(input: InconclusiveComparisonInput): ChallengeComparison {
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: input.primaryEvalScore,
    challengerEvalScore: input.challengerEvalScore,
    rationale: input.rationale,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    primaryExecution: input.primaryExecution,
    challengerExecution: input.challengerExecution,
    provenanceValidation: input.provenanceValidation,
    variedDimensions: input.variedDimensions,
    challengeType: input.challengeType,
    variedStage: input.variedStage,
    stageEvidenceMode: input.stageEvidenceMode,
    comparisonOutcome: 'inconclusive',
    noComparisonReason: input.noComparisonReason,
    ...(input.diffAvailability ? { diffAvailability: input.diffAvailability } : {}),
    workflowInsight: 'No LLM comparison was run because required evaluation evidence was unavailable.',
    ...comparisonRetentionFields(input),
  };
}

export function buildDiffUnavailableComparison(
  input: Omit<InconclusiveComparisonInput, 'noComparisonReason' | 'rationale'> & { rationale?: string },
): ChallengeComparison {
  const unavailable: string[] = [];
  if (input.diffAvailability?.primary.available === false) {
    unavailable.push(`primary diff unavailable (${input.diffAvailability.primary.reason}): ${input.diffAvailability.primary.detail}`);
  }
  if (input.diffAvailability?.challenger.available === false) {
    unavailable.push(`challenger diff unavailable (${input.diffAvailability.challenger.reason}): ${input.diffAvailability.challenger.detail}`);
  }
  return buildInconclusiveComparison({
    ...input,
    noComparisonReason: 'diff_unavailable',
    rationale: input.rationale || `Comparison skipped because ${unavailable.join('; ') || 'a PR diff was unavailable'}. Judge not invoked.`,
  });
}

export function buildUnscoredEvalComparison(
  input: Omit<InconclusiveComparisonInput, 'noComparisonReason' | 'rationale'> & { rationale?: string; unscoredSides?: string[] },
): ChallengeComparison {
  return buildInconclusiveComparison({
    ...input,
    noComparisonReason: 'eval_unscored',
    rationale: input.rationale || `Comparison skipped because ${input.unscoredSides?.join(' and ') || 'one or more eval records'} were unscored fast-fail records. Judge not invoked.`,
  });
}

export function buildForfeitComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  winner: 'primary' | 'challenger';
  primaryCompleted?: boolean;
  challengerCompleted?: boolean;
  armFailures?: ChallengeArmFailure[];
  rationale: string;
  terminalReason: ChallengeTerminalReason;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  timestamp?: string;
  noComparisonReason?: NoComparisonReason;
} & ComparisonRetentionInput): ChallengeComparison {
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: null,
    challengerEvalScore: null,
    primaryCompleted: input.primaryCompleted ?? (input.winner === 'primary'),
    challengerCompleted: input.challengerCompleted ?? (input.winner === 'challenger'),
    ...(input.armFailures?.length ? { armFailures: input.armFailures } : {}),
    winner: input.winner,
    rationale: input.rationale,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    comparisonOutcome: 'forfeit',
    terminalReason: input.terminalReason,
    noComparisonReason: input.noComparisonReason || (input.terminalReason as NoComparisonReason),
    ...comparisonRetentionFields(input),
  };
}

export function buildDoubleForfeitComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryCompleted?: boolean;
  challengerCompleted?: boolean;
  armFailures?: ChallengeArmFailure[];
  rationale: string;
  terminalReason: ChallengeTerminalReason;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  timestamp?: string;
  noComparisonReason?: NoComparisonReason;
} & ComparisonRetentionInput): ChallengeComparison {
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: null,
    challengerEvalScore: null,
    primaryCompleted: input.primaryCompleted ?? false,
    challengerCompleted: input.challengerCompleted ?? false,
    ...(input.armFailures?.length ? { armFailures: input.armFailures } : {}),
    winner: 'primary',
    rationale: input.rationale,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    comparisonOutcome: 'double-forfeit',
    terminalReason: input.terminalReason,
    noComparisonReason: input.noComparisonReason || (input.terminalReason as NoComparisonReason),
    ...comparisonRetentionFields(input),
  };
}

/**
 * Auto-resolution stamp for a pair where one arm aborted after its eval was
 * already marked `invalidChallenge: true` (HOK-2970 / HOK-2958). Unlike
 * {@link buildForfeitComparison}, this records no winner: the surviving arm
 * cannot "win" a challenge that never had a valid opponent, so the pair is
 * an `invalid_challenge` and must not count as reviewer-stage evidence.
 *
 * `terminalReason` is preserved so debugging keeps the abort context.
 * `forkStage` and related retention fields propagate via
 * {@link comparisonRetentionFields}.
 */
export type InvalidChallengeArmReason =
  | 'primary_challenge_aborted_invalid'
  | 'challenger_challenge_aborted_invalid'
  | 'both_challenge_aborted_invalid';

export function buildInvalidChallengeArmComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryHarnessId?: string;
  challengerHarnessId?: string;
  primaryCompleted?: boolean;
  challengerCompleted?: boolean;
  armFailures?: ChallengeArmFailure[];
  /** Which arm carried the invalid_challenge eval when it aborted. */
  abortedSide: 'primary' | 'challenger' | 'both';
  /** Preserved terminal reason from the original abort. */
  terminalReason:
    | 'primary_challenge_aborted'
    | 'challenger_challenge_aborted'
    | 'both_challenge_aborted';
  /**
   * Reason drawn from the aborted eval (e.g. `missing_challenge_intent`); when
   * absent the builder falls back to `missing_challenge_intent`, matching the
   * root cause named by HOK-3006.
   */
  invalidChallengeReason?: InvalidChallengeReason;
  invalidChallengeDetails?: string;
  rationale?: string;
  timestamp?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
} & ComparisonRetentionInput): ChallengeComparison {
  const reason: InvalidChallengeReason = input.invalidChallengeReason ?? 'missing_challenge_intent';
  const sideLabel = input.abortedSide === 'both'
    ? 'both arms'
    : `the ${input.abortedSide} arm`;
  const rationale = input.rationale
    ?? `Challenge arm ${sideLabel} was aborted after its eval was marked invalid (${reason}); pair cannot decide a reviewer-stage winner.`;
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryHarnessId: input.primaryHarnessId,
    challengerHarnessId: input.challengerHarnessId,
    primaryEvalScore: null,
    challengerEvalScore: null,
    primaryCompleted: input.primaryCompleted,
    challengerCompleted: input.challengerCompleted,
    ...(input.armFailures?.length ? { armFailures: input.armFailures } : {}),
    rationale,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    comparisonOutcome: 'invalid_challenge',
    invalidChallenge: true,
    invalidChallengeReason: reason,
    ...(input.invalidChallengeDetails ? { invalidChallengeDetails: input.invalidChallengeDetails } : {}),
    terminalReason: input.terminalReason,
    noComparisonReason: reason as NoComparisonReason,
    workflowInsight: 'No reviewer-stage winner was decided because one or both arms aborted after their eval was marked invalid.',
    ...comparisonRetentionFields(input),
  };
}

function meanSideDimensionScore(
  dimensions: ChallengeComparisonDimensions,
  side: 'primary' | 'challenger',
): number {
  const scores = [
    dimensions.completeness[side],
    dimensions.correctness[side],
    dimensions.code_quality[side],
    dimensions.intervention_impact[side],
    dimensions.autonomy[side],
  ];
  return scores.reduce((sum, value) => sum + value, 0) / scores.length / 10;
}

export function detectJudgeDisagreement(input: {
  side: 'primary' | 'challenger';
  evalScore: number | null;
  dimensions: ChallengeComparisonDimensions;
}, threshold = JUDGE_DISAGREEMENT_THRESHOLD): string | undefined {
  if (typeof input.evalScore !== 'number' || !Number.isFinite(input.evalScore)) {
    return undefined;
  }
  const comparisonMean = meanSideDimensionScore(input.dimensions, input.side);
  const delta = Math.abs(input.evalScore - comparisonMean);
  if (delta < threshold) {
    return undefined;
  }
  return `${input.side}: eval score ${input.evalScore.toFixed(2)} vs comparison mean ${comparisonMean.toFixed(2)} (delta ${delta.toFixed(2)}) - judges disagree`;
}

export function readChallengeComparisons(dir?: string): StoredChallengeComparison[] {
  const filePath = resolveRecordsFile(dir);
  if (!existsSync(filePath)) {
    return [];
  }

  return readJsonlFile<StoredChallengeComparison>(filePath);
}

export function readActiveChallengeComparisons(dir?: string): StoredChallengeComparison[] {
  const evalsDir = resolve(dir || DEFAULT_EVALS_DIR);
  const voids = readChallengeRecordVoids(evalsDir);
  return readChallengeComparisons(evalsDir).filter((record) => !isChallengeRecordVoided({
    challengePairId: record.challengePairId,
    recordTimestamp: record.timestamp,
    voids,
  }));
}

export function readDecisiveChallengeComparisons(dir?: string): StoredChallengeComparison[] {
  return readActiveChallengeComparisons(dir)
    .filter((record) => isDecisiveChallengeComparison(record));
}
