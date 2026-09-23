import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChallengeStage } from './challenge-mode.ts';
import type { ChallengeRoutingMeta, NoComparisonReason } from './challenge-comparison.ts';
import type { EvalRecord, EvalRouting } from './eval-schema.ts';
import { resolveEffectiveChallengeRole } from './challenge-role-utils.ts';

export type ChallengeValidity = 'valid' | 'invalid_challenge' | 'identical_control';
export const INVALID_CHALLENGE_REASONS = [
  'stage_override_lost',
  'native_launch_fallback',
  'identical_effective_route',
  'state_vs_derived_side_mismatch',
  'operator_reroute',
  'missing_challenge_intent',
  'multiple-varied-roles',
] as const;
export type InvalidChallengeReason =
  | 'stage_override_lost'
  | 'native_launch_fallback'
  | 'identical_effective_route'
  | 'state_vs_derived_side_mismatch'
  | 'operator_reroute'
  /**
   * The record belongs to a challenge pair but carries no intent, so there is
   * nothing to attest against. Absence used to read as success: the record
   * stayed training-eligible with no verdict at all, which is how an arm whose
   * selected model had been replaced still counted as clean evidence.
   */
  | 'missing_challenge_intent'
  /**
   * The pair violates the one-variable invariant: more than one role differs
   * (planner/coder/reviewer), or a role differs alongside a non-role dimension
   * (depth, mode, variant). This invalidates the challenge at launch time.
   */
  | 'multiple-varied-roles';

export type DeliveryVerdictOutcome = 'primary' | 'challenger' | 'tie' | null;

export interface DeliveryVerdict {
  /** Which arm's PR was accepted as the delivered contribution. */
  outcome: DeliveryVerdictOutcome;
  /** Stable reason code when no arm delivered. */
  reason?: NoComparisonReason;
  /** URL of the delivered PR when outcome is primary or challenger. */
  prUrl?: string;
  /** True when the primary PR was accepted through the merge lane. */
  primaryMerged?: boolean;
  /** Producer that stamped the verdict. */
  source: 'final-pr-arbiter' | 'auto-primary' | 'operator' | 'derived-from-comparison';
  /** Human-readable context; not a training target. */
  rationale?: string;
}

export type StageAttributionStatus = 'valid' | 'invalid' | 'insufficient_evidence';
export type StageAttributionOutcome = 'primary' | 'challenger' | 'tie' | null;

export const STAGE_ATTRIBUTION_REASON_CODES = [
  ...INVALID_CHALLENGE_REASONS,
  'divergent_pre_stage_inputs',
  'unverified_fork_commit',
  'missing_fork_identity',
  'plan_hash_mismatch',
  'prompt_hash_mismatch',
  'task_packet_hash_mismatch',
  'tool_config_hash_mismatch',
  'missing_direct_review_evidence',
  'inferred_evidence_only',
  'executed_identity_conflict',
  'executed_identity_missing',
  'inherited_stage_evidence_only',
  'presentation_order_bias_unresolved',
  'insufficient_review_iterations',
  'insufficient_evidence_other',
] as const;

export type StageAttributionReasonCode = typeof STAGE_ATTRIBUTION_REASON_CODES[number];

export interface StageAttribution {
  /** Causal-attribution status for the varied stage. */
  status: StageAttributionStatus;
  /** Winning arm when valid; null when invalid or insufficient. */
  outcome: StageAttributionOutcome;
  /** Varied stage this attribution describes. */
  stage: ChallengeStage;
  /** Stable, deduplicated reason codes that explain non-valid status. */
  reasonCodes: StageAttributionReasonCode[];
  /** Human-readable context; not a training target. */
  reasonDetails?: string;
  /** Model whose stage output won when outcome is primary or challenger. */
  winningStageModel?: string;
  /** Model whose stage output lost when outcome is primary or challenger. */
  losingStageModel?: string;
  /** Provenance for the evidence used to decide the attribution. */
  evidenceProvenance: 'direct' | 'inferred' | 'insufficient';
  /** True when direct evidence was present but divergent inputs made it unusable. */
  divergentInputsSuppressedDirectEvidence?: boolean;
  /** Timestamp when the attribution was decided. */
  decidedAt?: string;
  /** Producer/version stamp for the component that decided attribution. */
  producer?: string;
}

export interface ForkIdentity {
  /** The stage at which the pair forked; null for independently launched pairs. */
  stage: ChallengeStage | null;
  /** Git commit both arms share at the fork point; null when no shared prefix. */
  commit: string | null;
  /** Git tree object id at the fork point. */
  tree: string | null;
  /** SHA-256 over the task packet content at fork time. */
  taskPacketHash: string | null;
  /** SHA-256 over the plan artifact at fork time. */
  planHash: string | null;
  /** SHA-256 over the prompt artifact at fork time. */
  promptHash: string | null;
  /** SHA-256 over the tool-configuration snapshot at fork time. */
  toolConfigHash: string | null;
  /** Whether the challenger inherited pre-fork artifacts from the primary arm. */
  sharedPrefix?: boolean;
  /** Stages the primary arm inherited from pre-fork execution. */
  primaryInheritedStages?: ChallengeStage[];
  /** Stages the challenger arm inherited from pre-fork execution. */
  challengerInheritedStages?: ChallengeStage[];
  /** Producer identity for this fork envelope. */
  producer?: string;
  /** Producer schema/version stamp. */
  producerVersion?: string;
}

export type ExecutedIdentityRole =
  | 'review_orchestrator'
  | 'substantive_analysis'
  | 'remediation';

export interface ExecutedIdentity {
  role: ExecutedIdentityRole;
  /** Model the router requested. */
  requestedModel: string;
  /** Model that actually ran. */
  resolvedModel: string;
  /** Agent runner that executed the role. */
  agent?: string;
  /** Where the identity was observed. */
  source: 'route' | 'artifact' | 'inherited' | 'derived' | 'unknown';
  /** Reason for requested/resolved divergence, if any. */
  fallbackReason?: string;
  /** True when the observed identity was pinned to durable evidence. */
  pinned: boolean;
  /** Populated when two sources disagree about the executed identity. */
  conflict?: {
    otherSource: ExecutedIdentity['source'];
    otherResolvedModel: string;
    detail: string;
  };
}

export interface ReviewExecutedIdentitySet {
  orchestrator: ExecutedIdentity;
  substantiveAnalysis: ExecutedIdentity;
  /** Some review passes have no remediation model. */
  remediation?: ExecutedIdentity | null;
}

export interface ChallengeSideIntent {
  pairId: string;
  side: 'primary' | 'challenger';
  challengeStage: ChallengeStage;
  expectedStageModel: string;
  expectedStageAgent?: string;
  expectedRoute: ChallengeRoutingMeta;
  inheritedStages?: ChallengeStage[];
}

export type ChallengeDecisionSource = 'bootstrap' | 'expanded' | 'preserved';
export type ChallengeSelectionPath = 'recommendation-driven' | 'random-roll' | string;

/**
 * The pending-arm lifecycle (HOK-2811, HOK-3065).
 *
 * `challengeArms[]` records advance through this machine before a deferred
 * challenger becomes a live task. Two states can hold a *pending* arm:
 *
 *   - `awaiting_fork` — a reviewer-stage challenger waiting for the primary's
 *     coding to finish so it can fork at the coding-complete commit (HOK-2811).
 *   - `awaiting_expanded_route` — a planner-stage challenger whose selection was
 *     sealed at launch but whose non-varied route cannot be resolved until the
 *     expanded task packet exists (HOK-3065). It materialises at t=0 once the
 *     expanded route is available.
 *
 * The two must never be conflated: a reviewer arm forks off completed work,
 * while a planner arm forks off the base so both sides plan independently.
 */
export const CHALLENGE_ARM_LIFECYCLE_STATES = [
  'awaiting_fork',
  'awaiting_expanded_route',
  'materializing',
  'materialized',
  'cancelled',
  'exhausted',
] as const;
export type ChallengeArmLifecycleState = typeof CHALLENGE_ARM_LIFECYCLE_STATES[number];

/** The subset of lifecycle states that hold an un-materialised, pending arm. */
export const CHALLENGE_ARM_PENDING_STATES = ['awaiting_fork', 'awaiting_expanded_route'] as const;
export type ChallengeArmPendingState = typeof CHALLENGE_ARM_PENDING_STATES[number];

export function isChallengeArmLifecycleState(value: unknown): value is ChallengeArmLifecycleState {
  return typeof value === 'string'
    && (CHALLENGE_ARM_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isChallengeArmPendingState(value: unknown): value is ChallengeArmPendingState {
  return typeof value === 'string'
    && (CHALLENGE_ARM_PENDING_STATES as readonly string[]).includes(value);
}

/**
 * Immutable selection fields sealed at the moment the challenge lottery fires.
 *
 * These are the fields finalization/materialisation must preserve byte-for-byte
 * when it later enriches the sealed decision with the expanded route. Rerolling
 * any of them turns a sealed exploration run into an unrelated pair (or a
 * phantom one) — the exact failure HOK-3065 closes.
 */
export const SEALED_CHALLENGE_SELECTION_FIELDS = [
  'pairId',
  'selectedStage',
  'challengerVariedModel',
] as const;

/** Which routing key a stage varies. plan→planner, implementation→coder, review→reviewer. */
export const STAGE_TO_ROUTE_KEY: Record<ChallengeStage, keyof ChallengeRoutingMeta> = {
  plan: 'planner',
  implementation: 'coder',
  review: 'reviewer',
};

export interface ChallengeRuntimeStageRoute {
  model?: string;
  agent?: string;
}

export interface ChallengeRuntimeSideIntent {
  key?: string;
  role?: ChallengeSide;
  planner?: ChallengeRuntimeStageRoute;
  coder?: ChallengeRuntimeStageRoute;
  reviewer?: ChallengeRuntimeStageRoute;
  inheritedStages?: ChallengeStage[];
}

export interface ChallengeNativeCertificationRejection {
  modelId?: string;
  role?: string;
  requestedLaunchPhase?: string;
  requestedPhase?: string;
  certifiedPhase?: string;
  nativeCapability?: string;
  nativeProvider?: string;
  eligibleRoles?: readonly string[];
  allowedNativeAgentPhases?: readonly string[];
  requiredSuiteVersion?: string;
  reason: string;
  artifactPath?: string;
  apiKeyEnv?: string;
  field?: string;
}

export interface ChallengeModelExclusionDiagnostic {
  modelId: string;
  stage: string;
  source: string;
  reason?: string;
}

export interface ChallengeExecutionIntent {
  pairId: string;
  challengeStage?: ChallengeStage;
  schemaVersion?: string | number;
  issueId?: string;
  createdAt?: string;
  decisionSource?: ChallengeDecisionSource;
  selectedStage?: ChallengeStage;
  selectionPath?: ChallengeSelectionPath | readonly string[];
  challengerSource?: string;
  intentionallyIdentical?: boolean;
  routeContext?: unknown;
  selectionReason?: string;
  challengeRecommendation?: unknown;
  nativeCertificationRejections?: ChallengeNativeCertificationRejection[];
  modelExclusions?: ChallengeModelExclusionDiagnostic[];
  fallbackReason?: string;
  noChallengeReason?: string;
  primary?: ChallengeSideIntent | ChallengeRuntimeSideIntent;
  challenger?: ChallengeSideIntent | ChallengeRuntimeSideIntent;

  // Fork descriptor fields (P0.5 Phase 0, HOK-2794)
  forkStage?: ChallengeStage | null;
  forkCommit?: string | null;
  sharedPrefix?: boolean;
}

export interface ChallengeExecutionIntentProjection {
  pairId: string;
  challengeStage: ChallengeStage;
  intentionallyIdentical?: boolean;
  decisionSource?: ChallengeDecisionSource;
  selectedStage?: ChallengeStage;
  primary: ChallengeSideIntent;
  challenger: ChallengeSideIntent;
}

export type BuiltChallengeExecutionIntent = ChallengeExecutionIntent & ChallengeExecutionIntentProjection;

export interface ChallengeStageEvidence {
  stage: ChallengeStage;
  agent?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  fallbackReason?: string;
  source?: string;
}

export interface ChallengeExecutionAttestation {
  pairId: string;
  side: 'primary' | 'challenger';
  validity: ChallengeValidity;
  challengeStage: ChallengeStage;
  expectedStageModel: string;
  expectedStageAgent?: string;
  effectiveRoute?: ChallengeRoutingMeta;
  evidence: ChallengeStageEvidence[];
  invalidReason?: InvalidChallengeReason;
  invalidDetails?: string;
}

export type ChallengeSide = 'primary' | 'challenger';

export interface ChallengeSideResolution {
  side?: ChallengeSide;
  canonicalSide?: ChallengeSide;
  fallbackSide?: ChallengeSide;
  invalidReason?: InvalidChallengeReason;
  invalidDetails?: string;
}

type WorkflowChallengeTaskState = {
  slug?: unknown;
  branch?: unknown;
  challengePairId?: unknown;
  challengeStage?: unknown;
  challengeVariedStage?: unknown;
  challengeRole?: unknown;
  challengeExecutionIntent?: ChallengeExecutionIntent;
  challengeIntent?: ChallengeExecutionIntent;
  challengeArms?: WorkflowChallengeArmState[];
};

type WorkflowChallengeArmState = {
  key?: unknown;
  slug?: unknown;
  branch?: unknown;
  role?: unknown;
  variedStage?: unknown;
  executionIntent?: ChallengeExecutionIntent;
};

type WorkflowChallengeState = {
  tasks?: Record<string, WorkflowChallengeTaskState>;
};

export type ChallengeEntryLike = {
  model?: string;
  agent?: string;
  planner?: string;
  plannerAgent?: string;
  reviewer?: string;
  reviewerAgent?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asChallengeSide(value: unknown): ChallengeSide | undefined {
  return value === 'primary' || value === 'challenger' ? value : undefined;
}

function stateTaskKeys(issueId: string | undefined, challengePairId: string): string[] {
  return Array.from(new Set([
    issueId,
    issueId?.replace(/-/g, '_'),
    challengePairId,
    challengePairId.replace(/-/g, '_'),
    `${challengePairId}_c`,
    `${challengePairId.replace(/-/g, '_')}_c`,
    `${challengePairId}-challenger`,
    `${challengePairId.replace(/-/g, '_')}-challenger`,
  ].filter((key): key is string => Boolean(key))));
}

/**
 * Candidate workflow-state locations, most authoritative first.
 *
 * The mill writes `<repo>/.wavemill/workflow-state.json` (STATE_DIR defaults to
 * `<repo>/.wavemill` in wavemill-mill.sh). The `.wavemill/state/` variant was a
 * transcription error that made every lookup here miss, which in turn left eval
 * records without a challengeIntent and disabled execution attestation entirely.
 * Both are probed so an operator with a relocated STATE_DIR still resolves.
 */
function workflowStateCandidates(repoDir: string): string[] {
  return [
    path.join(repoDir, '.wavemill', 'workflow-state.json'),
    path.join(repoDir, '.wavemill', 'state', 'workflow-state.json'),
  ];
}

function loadWorkflowChallengeState(repoDir: string): WorkflowChallengeState | undefined {
  for (const statePath of workflowStateCandidates(repoDir)) {
    try {
      if (!existsSync(statePath)) continue;
      return JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowChallengeState;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function loadChallengeRoleFromState(
  repoDir: string,
  issueId: string | undefined,
  challengePairId?: string,
): ChallengeSide | undefined {
  if (!challengePairId) return undefined;
  const state = loadWorkflowChallengeState(repoDir);
  for (const key of stateTaskKeys(issueId, challengePairId)) {
    const task = state?.tasks?.[key];
    if (!task) continue;
    const role = asChallengeSide(task.challengeRole)
      ?? resolveEffectiveChallengeRole(key, challengePairId, task.challengeRole)
      ?? undefined;
    if (role) return role;
  }
  return undefined;
}

export function loadChallengeIntentFromState(
  repoDir: string,
  issueId: string | undefined,
  challengePairId?: string,
): ChallengeExecutionIntent | undefined {
  if (!challengePairId) return undefined;
  const state = loadWorkflowChallengeState(repoDir);
  for (const key of stateTaskKeys(issueId, challengePairId)) {
    const task = state?.tasks?.[key];
    const canonical = task?.challengeExecutionIntent;
    if (canonical) return canonical;
    /* legacy fallback */
    const legacy = task?.challengeIntent;
    if (legacy) return legacy;
  }
  return undefined;
}

function deriveChallengeSideFromBranch(
  slug: string | undefined,
  issueId: string | undefined,
  challengePairId?: string,
): ChallengeSide | undefined {
  if (!challengePairId) return undefined;
  const cleanSlug = slug?.replace(/^(task|bug)\//, '') || '';
  if (
    issueId === `${challengePairId}_c`
    || issueId === `${challengePairId}-challenger`
    || cleanSlug.endsWith('_c')
    || cleanSlug.endsWith('-challenger')
  ) {
    return 'challenger';
  }
  return cleanSlug || issueId ? 'primary' : undefined;
}

export function resolveChallengeSide(input: {
  repoDir: string;
  slug?: string;
  branchName?: string;
  issueId?: string;
  challengePairId?: string;
  /**
   * Authoritative side supplied by the launcher.
   *
   * `issueId` is the *Linear* issue, which both arms of a pair share, so it
   * cannot distinguish them: looking up `HOK-1234` resolves to the primary even
   * when the run is the challenger on `task/<slug>-challenger`. The branch then
   * derives `challenger`, the two disagree, and a valid pair is invalidated as
   * `state_vs_derived_side_mismatch`.
   *
   * The launcher knows the side from the task key, so prefer it over inference.
   */
  explicitSide?: ChallengeSide;
}): ChallengeSideResolution {
  if (!input.challengePairId) return {};
  const slug = input.slug ?? input.branchName;
  if (input.explicitSide) {
    return { side: input.explicitSide, canonicalSide: input.explicitSide };
  }
  const canonicalSide = loadChallengeRoleFromState(input.repoDir, input.issueId, input.challengePairId);
  const fallbackSide = deriveChallengeSideFromBranch(slug, input.issueId, input.challengePairId);
  if (canonicalSide) {
    const mismatch = fallbackSide && fallbackSide !== canonicalSide;
    return {
      side: canonicalSide,
      canonicalSide,
      fallbackSide,
      ...(mismatch
        ? {
          invalidReason: 'state_vs_derived_side_mismatch',
          invalidDetails: `Workflow state challengeRole=${canonicalSide}, branch-derived side=${fallbackSide}.`,
        }
        : {}),
    };
  }
  return { side: fallbackSide, fallbackSide };
}

function routeFromEntry(entry: ChallengeEntryLike): ChallengeRoutingMeta {
  return {
    planner: clean(entry.planner),
    coder: clean(entry.model),
    reviewer: clean(entry.reviewer),
    planDepth: clean(entry.planDepth),
    codeDepth: clean(entry.codeDepth),
    reviewMode: clean(entry.reviewMode),
  };
}

function stageModel(entry: ChallengeEntryLike, stage: ChallengeStage): string {
  if (stage === 'plan') return clean(entry.planner) || clean(entry.model);
  if (stage === 'review') return clean(entry.reviewer) || clean(entry.model);
  return clean(entry.model);
}

function stageAgent(entry: ChallengeEntryLike, stage: ChallengeStage): string | undefined {
  const value = stage === 'plan'
    ? clean(entry.plannerAgent) || clean(entry.agent)
    : stage === 'review'
      ? clean(entry.reviewerAgent) || clean(entry.agent)
      : clean(entry.agent);
  return value || undefined;
}

function stageFromIntent(intent: ChallengeExecutionIntent): ChallengeStage {
  return intent.challengeStage ?? intent.selectedStage ?? 'implementation';
}

/**
 * Derive the persisted projection for one side of a pair from its route entry.
 *
 * This is the single implementation of "what does the selected arm expect to
 * run". Every producer of a challenge intent must go through it — a second,
 * independently-written projection is what let the envelope and projection
 * schemas drift apart and silently disarm arm preservation during rerouting.
 */
export function projectEntryToSideIntent(input: {
  pairId: string;
  side: ChallengeSide;
  challengeStage: ChallengeStage;
  entry: ChallengeEntryLike;
}): ChallengeSideIntent {
  const agent = stageAgent(input.entry, input.challengeStage);
  return {
    pairId: input.pairId,
    side: input.side,
    challengeStage: input.challengeStage,
    expectedStageModel: stageModel(input.entry, input.challengeStage),
    ...(agent ? { expectedStageAgent: agent } : {}),
    expectedRoute: routeFromEntry(input.entry),
  };
}

function isProjectedSideIntent(value: unknown): value is ChallengeSideIntent {
  const side = value as Partial<ChallengeSideIntent> | null | undefined;
  return Boolean(
    side
    && typeof side === 'object'
    && (side.side === 'primary' || side.side === 'challenger')
    && typeof side.pairId === 'string'
    && typeof side.expectedStageModel === 'string'
    && side.expectedRoute
    && typeof side.expectedRoute === 'object',
  );
}

function stageRouteFromRuntimeSide(
  side: ChallengeRuntimeSideIntent | undefined,
  stage: ChallengeStage,
): ChallengeRuntimeStageRoute | undefined {
  if (!side) return undefined;
  if (stage === 'plan') return side.planner;
  if (stage === 'review') return side.reviewer;
  return side.coder;
}

function routeFromRuntimeSide(side: ChallengeRuntimeSideIntent | undefined): ChallengeRoutingMeta {
  return {
    planner: clean(side?.planner?.model),
    coder: clean(side?.coder?.model),
    reviewer: clean(side?.reviewer?.model),
    planDepth: '',
    codeDepth: '',
    reviewMode: '',
  };
}

function projectSideIntent(
  intent: ChallengeExecutionIntent,
  value: ChallengeSideIntent | ChallengeRuntimeSideIntent | undefined,
  side: ChallengeSide,
): ChallengeSideIntent | undefined {
  const stage = stageFromIntent(intent);
  if (isProjectedSideIntent(value)) {
    return {
      pairId: value.pairId,
      side: value.side,
      challengeStage: value.challengeStage,
      expectedStageModel: value.expectedStageModel,
      ...(value.expectedStageAgent ? { expectedStageAgent: value.expectedStageAgent } : {}),
      expectedRoute: value.expectedRoute,
    };
  }

  const runtimeSide = value as ChallengeRuntimeSideIntent | undefined;
  const selectedRoute = stageRouteFromRuntimeSide(runtimeSide, stage);
  const expectedStageModel = clean(selectedRoute?.model);
  if (!expectedStageModel) return undefined;
  const expectedStageAgent = clean(selectedRoute?.agent);
  return {
    pairId: intent.pairId,
    side,
    challengeStage: stage,
    expectedStageModel,
    ...(expectedStageAgent ? { expectedStageAgent } : {}),
    expectedRoute: routeFromRuntimeSide(runtimeSide),
  };
}

export function projectChallengeIntentForPersistence(
  intent: ChallengeExecutionIntent | null | undefined,
): ChallengeExecutionIntentProjection | undefined {
  if (!intent) return undefined;
  const challengeStage = stageFromIntent(intent);
  const primary = projectSideIntent(intent, intent.primary, 'primary');
  const challenger = projectSideIntent(intent, intent.challenger, 'challenger');
  if (!primary || !challenger) return undefined;

  return {
    pairId: intent.pairId,
    challengeStage,
    ...(intent.intentionallyIdentical ? { intentionallyIdentical: true } : {}),
    ...(intent.decisionSource ? { decisionSource: intent.decisionSource } : {}),
    ...(intent.selectedStage ? { selectedStage: intent.selectedStage } : {}),
    primary,
    challenger,
  };
}

export function buildChallengeExecutionIntent(input: {
  pairId: string;
  challengeStage: ChallengeStage;
  primary: ChallengeEntryLike;
  challenger: ChallengeEntryLike;
  routeContext?: unknown;
  selectionReason?: string;
  intentionallyIdentical?: boolean;
}): BuiltChallengeExecutionIntent {
  return {
    pairId: input.pairId,
    challengeStage: input.challengeStage,
    ...(input.intentionallyIdentical ? { intentionallyIdentical: true } : {}),
    ...(input.routeContext ? { routeContext: input.routeContext } : {}),
    ...(input.selectionReason ? { selectionReason: input.selectionReason } : {}),
    primary: projectEntryToSideIntent({
      pairId: input.pairId,
      side: 'primary',
      challengeStage: input.challengeStage,
      entry: input.primary,
    }),
    challenger: projectEntryToSideIntent({
      pairId: input.pairId,
      side: 'challenger',
      challengeStage: input.challengeStage,
      entry: input.challenger,
    }),
  };
}

export function routingMetaFromRawRoute(raw: unknown): ChallengeRoutingMeta | undefined {
  const data = raw as Record<string, unknown> | null | undefined;
  if (!data) return undefined;
  return {
    planner: clean(data.planner),
    coder: clean(data.coder),
    reviewer: clean(data.reviewer),
    planDepth: clean(data.planDepth),
    codeDepth: clean(data.codeDepth),
    reviewMode: clean(data.reviewMode ?? data.reviewRecommended),
  };
}

export function modelForChallengeStage(route: ChallengeRoutingMeta | undefined, stage: ChallengeStage): string {
  if (!route) return '';
  if (stage === 'plan') return clean(route.planner);
  if (stage === 'review') return clean(route.reviewer);
  return clean(route.coder);
}

function addReason(
  reasons: Set<StageAttributionReasonCode>,
  reason: StageAttributionReasonCode | undefined,
): void {
  if (reason) reasons.add(reason);
}

function identityItems(identity: ReviewExecutedIdentitySet | undefined): ExecutedIdentity[] {
  if (!identity) return [];
  return [
    identity.orchestrator,
    identity.substantiveAnalysis,
    ...(identity.remediation ? [identity.remediation] : []),
  ];
}

function hasIdentityConflict(identity: ReviewExecutedIdentitySet | undefined): boolean {
  return identityItems(identity).some((item) => Boolean(item.conflict));
}

function hasUnpinnedIdentity(identity: ReviewExecutedIdentitySet | undefined): boolean {
  return identityItems(identity).some((item) => item.pinned !== true);
}

/**
 * Build an {@link ExecutedIdentity} with consistent pin/fallback/conflict
 * semantics (HOK-2969, Arbiter P2.4f) so every producer (native review
 * provider selection, legacy review, review orchestration, remediation)
 * derives `pinned` the same way instead of each hand-rolling the rule.
 *
 * `pinned` is true only when a requested model was supplied, it matches the
 * resolved model exactly, and no conflict was recorded. A missing requested
 * model, a fallback, or a conflict all fail closed to `pinned: false`.
 */
export function buildExecutedIdentity(input: {
  role: ExecutedIdentityRole;
  /** Model that was asked for; undefined when no request could be made (fails closed). */
  requestedModel?: string;
  resolvedModel: string;
  agent?: string;
  source: ExecutedIdentity['source'];
  fallbackReason?: string;
  conflict?: ExecutedIdentity['conflict'];
}): ExecutedIdentity {
  const requested = clean(input.requestedModel);
  const resolved = clean(input.resolvedModel);
  const mismatch = Boolean(requested) && requested !== resolved;
  const pinned = Boolean(requested) && !mismatch && !input.conflict;
  return {
    role: input.role,
    requestedModel: requested || resolved,
    resolvedModel: resolved,
    ...(input.agent ? { agent: input.agent } : {}),
    source: input.source,
    ...(input.fallbackReason
      ? { fallbackReason: input.fallbackReason }
      : mismatch ? { fallbackReason: 'requested_model_unavailable' } : {}),
    pinned,
    ...(input.conflict ? { conflict: input.conflict } : {}),
  };
}

/** Exported for eval-assembly consumers that need the same fail-closed check outside folding. */
export function reviewExecutedIdentityHasConflict(identity: ReviewExecutedIdentitySet | undefined): boolean {
  return hasIdentityConflict(identity);
}

/** Exported for eval-assembly consumers that need the same fail-closed check outside folding. */
export function reviewExecutedIdentityIsFullyPinned(identity: ReviewExecutedIdentitySet | undefined): boolean {
  return Boolean(identity) && !hasUnpinnedIdentity(identity);
}

function addForkIdentityReasons(
  reasons: Set<StageAttributionReasonCode>,
  forkIdentity: ForkIdentity | undefined,
): void {
  if (!forkIdentity) {
    reasons.add('missing_fork_identity');
    return;
  }
  if (!forkIdentity.commit) reasons.add('unverified_fork_commit');
  const hashChecks: Array<[keyof ForkIdentity, StageAttributionReasonCode]> = [
    ['taskPacketHash', 'task_packet_hash_mismatch'],
    ['planHash', 'plan_hash_mismatch'],
    ['promptHash', 'prompt_hash_mismatch'],
    ['toolConfigHash', 'tool_config_hash_mismatch'],
  ];
  for (const [field, reason] of hashChecks) {
    if (!forkIdentity[field]) reasons.add(reason);
  }
  if (
    reasons.has('task_packet_hash_mismatch')
    || reasons.has('plan_hash_mismatch')
    || reasons.has('prompt_hash_mismatch')
    || reasons.has('tool_config_hash_mismatch')
  ) {
    reasons.add('divergent_pre_stage_inputs');
  }
}

function inheritedStageReason(
  stage: ChallengeStage,
  forkIdentity: ForkIdentity | undefined,
): StageAttributionReasonCode | undefined {
  if (!forkIdentity) return undefined;
  const inherited = [
    ...(forkIdentity.primaryInheritedStages ?? []),
    ...(forkIdentity.challengerInheritedStages ?? []),
  ];
  return inherited.includes(stage) ? 'inherited_stage_evidence_only' : undefined;
}

function attributionModel(attestation: ChallengeExecutionAttestation | undefined): string | undefined {
  return attestation?.expectedStageModel || undefined;
}

export function foldAttestationsIntoStageAttribution(input: {
  pairId: string;
  stage: ChallengeStage;
  primary?: ChallengeExecutionAttestation;
  challenger?: ChallengeExecutionAttestation;
  /** From ChallengeStageEval.provenance, if a stage eval was captured. */
  evidenceProvenance?: 'direct' | 'inferred';
  /** Pair-level fork identity used to prove matched pre-stage inputs. */
  forkIdentity?: ForkIdentity;
  /** Per-arm executed review identities used to detect pinning failures. */
  primaryReviewIdentity?: ReviewExecutedIdentitySet;
  challengerReviewIdentity?: ReviewExecutedIdentitySet;
  /**
   * False when either arm's local review artifact is missing complete
   * per-iteration evidence (findings, commands, reviewer delta). Direct
   * review-stage attribution requires complete iteration evidence, not just
   * a pinned identity (HOK-2969).
   */
  reviewIterationsComplete?: boolean;
  /** Winner as decided by the comparison judge, if any. */
  judgeWinner?: 'primary' | 'challenger' | 'tie' | null;
}): StageAttribution {
  const reasons = new Set<StageAttributionReasonCode>();
  const details: string[] = [];
  addForkIdentityReasons(reasons, input.forkIdentity);
  addReason(reasons, inheritedStageReason(input.stage, input.forkIdentity));

  for (const attestation of [input.primary, input.challenger]) {
    if (!attestation) {
      addReason(reasons, 'insufficient_evidence_other');
      details.push('challenge attestation missing');
      continue;
    }
    if (attestation.validity === 'invalid_challenge') {
      addReason(reasons, attestation.invalidReason ?? 'insufficient_evidence_other');
      if (attestation.invalidDetails) details.push(attestation.invalidDetails);
    } else if (attestation.validity === 'identical_control') {
      addReason(reasons, 'identical_effective_route');
    }
  }

  if (input.stage === 'review') {
    if (input.evidenceProvenance !== 'direct') {
      addReason(reasons, input.evidenceProvenance === 'inferred'
        ? 'inferred_evidence_only'
        : 'missing_direct_review_evidence');
    }
    if (!input.primaryReviewIdentity || !input.challengerReviewIdentity) {
      addReason(reasons, 'executed_identity_missing');
    }
    if (hasUnpinnedIdentity(input.primaryReviewIdentity) || hasUnpinnedIdentity(input.challengerReviewIdentity)) {
      addReason(reasons, 'executed_identity_missing');
    }
    if (hasIdentityConflict(input.primaryReviewIdentity) || hasIdentityConflict(input.challengerReviewIdentity)) {
      addReason(reasons, 'executed_identity_conflict');
    }
    if (input.reviewIterationsComplete === false) {
      addReason(reasons, 'insufficient_review_iterations');
    }
  }

  const directEvidenceSuppressed = input.evidenceProvenance === 'direct' && (
    reasons.has('divergent_pre_stage_inputs')
    || reasons.has('task_packet_hash_mismatch')
    || reasons.has('plan_hash_mismatch')
    || reasons.has('prompt_hash_mismatch')
    || reasons.has('tool_config_hash_mismatch')
  );
  if (directEvidenceSuppressed) {
    reasons.add('divergent_pre_stage_inputs');
  }

  const reasonCodes = [...reasons];
  if (reasonCodes.length > 0) {
    const insufficientOnly = reasonCodes.every((reason) => [
      'missing_direct_review_evidence',
      'inferred_evidence_only',
      'insufficient_review_iterations',
      'insufficient_evidence_other',
    ].includes(reason));
    return {
      status: insufficientOnly ? 'insufficient_evidence' : 'invalid',
      outcome: null,
      stage: input.stage,
      reasonCodes,
      ...(details.length > 0 ? { reasonDetails: details.join(' ') } : {}),
      evidenceProvenance: insufficientOnly ? 'insufficient' : (input.evidenceProvenance ?? 'insufficient'),
      ...(directEvidenceSuppressed ? { divergentInputsSuppressedDirectEvidence: true } : {}),
    };
  }

  const outcome = input.judgeWinner ?? 'tie';
  const primaryModel = attributionModel(input.primary);
  const challengerModel = attributionModel(input.challenger);
  return {
    status: 'valid',
    outcome,
    stage: input.stage,
    reasonCodes: [],
    ...(outcome === 'primary' && primaryModel ? { winningStageModel: primaryModel } : {}),
    ...(outcome === 'primary' && challengerModel ? { losingStageModel: challengerModel } : {}),
    ...(outcome === 'challenger' && challengerModel ? { winningStageModel: challengerModel } : {}),
    ...(outcome === 'challenger' && primaryModel ? { losingStageModel: primaryModel } : {}),
    evidenceProvenance: input.evidenceProvenance ?? 'inferred',
  };
}

export function isStageAttributionEligibleForCoverage(attribution: StageAttribution | undefined): boolean {
  return Boolean(
    attribution
    && attribution.status === 'valid'
    && attribution.outcome !== null
    && attribution.reasonCodes.length === 0
    && (attribution.evidenceProvenance === 'direct' || attribution.evidenceProvenance === 'inferred')
    && attribution.divergentInputsSuppressedDirectEvidence !== true,
  );
}

export function isStageAttributionEligibleForTraining(attribution: StageAttribution | undefined): boolean {
  return isStageAttributionEligibleForCoverage(attribution)
    && attribution?.evidenceProvenance === 'direct';
}

export function routesIdentical(a: ChallengeRoutingMeta | undefined, b: ChallengeRoutingMeta | undefined): boolean {
  if (!a || !b) return false;
  return a.planner === b.planner
    && a.coder === b.coder
    && a.reviewer === b.reviewer
    && a.planDepth === b.planDepth
    && a.codeDepth === b.codeDepth
    && a.reviewMode === b.reviewMode;
}

function sideIntentFromRecord(record: EvalRecord): ChallengeSideIntent | undefined {
  const intent = record.challengeIntent;
  if (!intent || !record.challengeSide) return undefined;
  return record.challengeSide === 'challenger' ? intent.challenger : intent.primary;
}

function stageRole(stage: ChallengeStage): keyof EvalRouting {
  return stage === 'plan' ? 'planner' : stage === 'review' ? 'reviewer' : 'coder';
}

export function attestEvalRecordChallengeExecution(record: EvalRecord): ChallengeExecutionAttestation | undefined {
  const sideIntent = sideIntentFromRecord(record);
  if (!sideIntent) return undefined;

  const effectiveRoute = record.challengeExecutionRoute
    ?? routingMetaFromRawRoute(record.routeProvenance?.activeRoute)
    ?? routingMetaFromRawRoute((record.taskDescriptor as { route?: unknown } | undefined)?.route);
  const role = stageRole(sideIntent.challengeStage);
  const routing = record.routing?.[role];
  const evidence: ChallengeStageEvidence[] = [];
  if (routing) {
    evidence.push({
      stage: sideIntent.challengeStage,
      requestedModel: String(routing.requestedSelector ?? ''),
      resolvedModel: routing.resolvedModelId,
      fallbackReason: routing.fallbackReason,
      source: 'routing.jsonl',
    });
  }
  if (sideIntent.challengeStage === 'plan' && record.executedPlanning) {
    evidence.push({
      stage: 'plan',
      agent: record.executedPlanning.agent,
      model: record.executedPlanning.model,
      source: record.executedPlanning.source,
    });
  } else if (sideIntent.challengeStage === 'implementation' && record.modelId) {
    evidence.push({
      stage: 'implementation',
      agent: record.agentType,
      model: record.modelId,
      source: 'eval.modelId',
    });
  } else if ((sideIntent.challengeStage === 'plan' || sideIntent.challengeStage === 'review') && record.challengeStageEval) {
    for (const item of record.challengeStageEval.evidence) {
      evidence.push({
        stage: sideIntent.challengeStage,
        source: item.source ?? record.challengeStageEval.provenance,
      });
    }
  }

  const expected = sideIntent.expectedStageModel;
  const routeModel = modelForChallengeStage(effectiveRoute, sideIntent.challengeStage);
  let invalidReason: InvalidChallengeReason | undefined;
  let invalidDetails: string | undefined;
  if (expected && routeModel && expected !== routeModel) {
    invalidReason = 'stage_override_lost';
    invalidDetails = `Expected ${sideIntent.challengeStage} model ${expected}, effective route has ${routeModel}.`;
  }

  const actualModel = evidence.find((item) => item.model)?.model
    ?? evidence.find((item) => item.resolvedModel)?.resolvedModel;
  const requestedModel = evidence.find((item) => item.requestedModel)?.requestedModel;
  const fallbackReason = evidence.find((item) => item.fallbackReason)?.fallbackReason;
  if (!invalidReason && expected && actualModel && actualModel !== expected) {
    invalidReason = requestedModel === expected || fallbackReason ? 'native_launch_fallback' : 'stage_override_lost';
    invalidDetails = `Expected ${sideIntent.challengeStage} model ${expected}, launch evidence has ${actualModel}.`;
  }

  return {
    pairId: sideIntent.pairId,
    side: sideIntent.side,
    validity: invalidReason ? 'invalid_challenge' : (record.challengeIntent?.intentionallyIdentical ? 'identical_control' : 'valid'),
    challengeStage: sideIntent.challengeStage,
    expectedStageModel: expected,
    ...(sideIntent.expectedStageAgent ? { expectedStageAgent: sideIntent.expectedStageAgent } : {}),
    ...(effectiveRoute ? { effectiveRoute } : {}),
    evidence,
    ...(invalidReason ? { invalidReason, invalidDetails } : {}),
  };
}

/**
 * Fail closed when a challenge participant carries no intent to attest against.
 *
 * `attestEvalRecordChallengeExecution` returns undefined without an intent, so
 * such a record previously landed with no verdict at all AND full training
 * eligibility — absence read as success. That is how an arm whose selected
 * model had already been replaced by rerouting still counted as clean
 * evidence for the model that actually ran.
 *
 * Returns true when the record was marked invalid.
 */
export function enforceChallengeIntentPresence(
  record: EvalRecord,
  challengePairId: string | undefined,
): boolean {
  if (!challengePairId || record.challengeIntent) {
    return false;
  }
  record.challengeDivergenceReason = 'missing_challenge_intent';
  record.invalidChallenge = true;
  record.trainingEligible = false;
  record.nonRewardReason = {
    code: 'INVALID_CHALLENGE',
    message: `Invalid challenge: no persisted intent for pair ${challengePairId}; cannot attest which stage was varied.`,
  };
  return true;
}

const CHALLENGE_STAGE_VALUES: ReadonlySet<ChallengeStage> = new Set(['plan', 'implementation', 'review']);

function isChallengeStageValue(value: unknown): value is ChallengeStage {
  return typeof value === 'string' && CHALLENGE_STAGE_VALUES.has(value as ChallengeStage);
}

/**
 * Stages this record's side inherited across a challenge fork.
 *
 * The `challengeIntent.<side>.inheritedStages` field is the P0.5 marker for
 * work the arm did not perform itself but carried forward from the shared
 * pre-fork prefix. Coverage counting must skip these — otherwise a coder
 * model would be credited for an implementation stage another workflow ran.
 *
 * Records without a challenge side or intent (independent pairs, historical
 * records) return an empty list so they stay countable as before.
 */
export function inheritedStagesForRecord(record: EvalRecord): ChallengeStage[] {
  const intent = record.challengeIntent as unknown as {
    primary?: { inheritedStages?: unknown };
    challenger?: { inheritedStages?: unknown };
  } | undefined;
  const side = record.challengeSide;
  if (!intent || (side !== 'primary' && side !== 'challenger')) return [];
  const raw = intent[side]?.inheritedStages;
  return Array.isArray(raw) ? raw.filter(isChallengeStageValue) : [];
}

/**
 * Map a challenge/diversity stage key to the corresponding intent stage.
 * `implementation` in coverage tables lines up with the intent's `implementation`.
 */
export function stageInherited(record: EvalRecord, stage: ChallengeStage): boolean {
  return inheritedStagesForRecord(record).includes(stage);
}

export function loadChallengeIntentFromFeatureDir(featureDir: string): ChallengeExecutionIntent | undefined {
  for (const file of ['challenge-intent.json', '.challenge-intent.json']) {
    const candidate = path.join(featureDir, file);
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as ChallengeExecutionIntent;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface ChallengedStageIntent {
  pairId: string;
  model: string;
  agent?: string;
}

export type ReviewStageChallengePinResolution =
  | ChallengedStageIntent
  | { pairId: string; unresolvable: true };

/**
 * Extract a side's expected model/agent for one stage, tolerating both the
 * persisted projection shape (`ChallengeSideIntent`, `expectedStageModel`)
 * and the raw runtime shape (`ChallengeRuntimeSideIntent`, per-stage route
 * objects) — `challenge-intent.json` has been observed in both forms across
 * launcher versions.
 */
function extractExpectedStage(
  side: ChallengeSideIntent | ChallengeRuntimeSideIntent | undefined,
  stage: ChallengeStage,
): { model?: string; agent?: string } {
  if (!side) return {};
  const projected = side as Partial<ChallengeSideIntent>;
  if (typeof projected.expectedStageModel === 'string' && projected.expectedStageModel.trim()) {
    return { model: projected.expectedStageModel.trim(), agent: clean(projected.expectedStageAgent) || undefined };
  }
  const route = stageRouteFromRuntimeSide(side as ChallengeRuntimeSideIntent, stage);
  const model = clean(route?.model);
  return model ? { model, agent: clean(route?.agent) || undefined } : {};
}

/**
 * Resolve the challenged model/agent for one stage of this worktree's own
 * arm, when this run is part of a reviewer-stage (or any-stage) challenge
 * pair and the local `challenge-intent.json` names it explicitly.
 *
 * Returns `undefined` when there is no feature-dir challenge intent, the
 * intent varies a different stage, or the side cannot be resolved — the
 * caller is expected to fail closed (unpinned) rather than guess, exactly as
 * a missing challenge context should never fabricate a pin (HOK-2969).
 */
export function resolveChallengedStageIntent(input: {
  repoDir: string;
  featureDir?: string;
  branchName?: string;
  issueId?: string;
  stage: ChallengeStage;
  /** Authoritative side when already known, bypassing branch/state inference. */
  explicitSide?: ChallengeSide;
}): ChallengedStageIntent | undefined {
  if (!input.featureDir) return undefined;
  const intent = loadChallengeIntentFromFeatureDir(input.featureDir);
  if (!intent) return undefined;
  const actualStage = stageFromIntent(intent);
  if (actualStage !== input.stage) return undefined;

  const resolution = resolveChallengeSide({
    repoDir: input.repoDir,
    branchName: input.branchName,
    issueId: input.issueId,
    challengePairId: intent.pairId,
    explicitSide: input.explicitSide,
  });
  if (!resolution.side) return undefined;

  const side = resolution.side === 'challenger' ? intent.challenger : intent.primary;
  const extracted = extractExpectedStage(side, input.stage);
  if (!extracted.model) return undefined;
  return { pairId: intent.pairId, model: extracted.model, agent: extracted.agent };
}

function challengeIntentIsCanonical(intent: ChallengeExecutionIntent | undefined): intent is ChallengeExecutionIntent {
  return Boolean(
    intent
    && Number(intent.schemaVersion) === 1
    && clean(intent.pairId)
    && clean(intent.issueId),
  );
}

function taskOrArmMatchesRun(input: {
  key: string;
  task: WorkflowChallengeTaskState;
  featureSlug?: string;
  branchName?: string;
}): { taskMatched: boolean; arm?: WorkflowChallengeArmState } {
  const branch = clean(input.branchName);
  const branchSlug = branch.replace(/^(task|bug)\//, '');
  const featureSlug = clean(input.featureSlug);
  const taskSlug = clean(input.task.slug);
  const taskBranch = clean(input.task.branch);
  const taskMatched = Boolean(
    (featureSlug && (input.key === featureSlug || taskSlug === featureSlug))
    || (branch && (input.key === branch || taskBranch === branch))
    || (branchSlug && (input.key === branchSlug || taskSlug === branchSlug))
  );

  const arm = (input.task.challengeArms ?? []).find((candidate) => {
    const armKey = clean(candidate.key);
    const armSlug = clean(candidate.slug);
    const armBranch = clean(candidate.branch);
    return Boolean(
      (featureSlug && (armKey === featureSlug || armSlug === featureSlug))
      || (branch && (armKey === branch || armBranch === branch))
      || (branchSlug && (armKey === branchSlug || armSlug === branchSlug))
    );
  });

  return { taskMatched, arm };
}

function taskHasReviewChallengeArm(task: WorkflowChallengeTaskState): boolean {
  return (task.challengeArms ?? []).some((arm) => clean(arm.variedStage) === 'review');
}

function taskIsReviewStageChallengeMember(
  task: WorkflowChallengeTaskState,
  arm?: WorkflowChallengeArmState,
): boolean {
  if (arm) return clean(arm.variedStage) === 'review';
  const taskStage = clean(task.challengeStage) || clean(task.challengeVariedStage);
  if (taskStage === 'review') return true;
  if (task.challengeExecutionIntent && stageFromIntent(task.challengeExecutionIntent) === 'review') return true;
  return taskHasReviewChallengeArm(task);
}

/**
 * Resolve the mandatory reviewer-stage challenge pin. Unlike
 * resolveChallengedStageIntent, this function treats known review-stage
 * challenge membership with no resolvable canonical intent as terminally
 * unresolvable so callers can fail closed instead of launching unpinned.
 */
export function resolveReviewStageChallengePin(input: {
  repoDir: string;
  featureDir?: string;
  branchName?: string;
}): ReviewStageChallengePinResolution | undefined {
  const filePin = resolveChallengedStageIntent({
    repoDir: input.repoDir,
    featureDir: input.featureDir,
    branchName: input.branchName,
    stage: 'review',
  });
  if (filePin) return filePin;

  const state = loadWorkflowChallengeState(input.repoDir);
  const featureSlug = input.featureDir ? path.basename(input.featureDir) : undefined;
  const tasks = state?.tasks ?? {};
  for (const [key, task] of Object.entries(tasks)) {
    const match = taskOrArmMatchesRun({
      key,
      task,
      featureSlug,
      branchName: input.branchName,
    });
    if (!match.taskMatched && !match.arm) continue;
    if (!taskIsReviewStageChallengeMember(task, match.arm)) continue;

    const pairId = clean(task.challengePairId)
      || clean(task.challengeExecutionIntent?.pairId)
      || clean(match.arm?.executionIntent?.pairId);
    if (!pairId) continue;

    const stateIntent = loadChallengeIntentFromState(input.repoDir, key, pairId);
    const armIntent = match.arm?.executionIntent;
    const intent = challengeIntentIsCanonical(stateIntent)
      ? stateIntent
      : challengeIntentIsCanonical(armIntent)
        ? armIntent
        : undefined;
    if (intent && stageFromIntent(intent) === 'review') {
      const explicitSide = asChallengeSide(match.arm?.role) ?? asChallengeSide(task.challengeRole);
      const resolution = resolveChallengeSide({
        repoDir: input.repoDir,
        slug: featureSlug,
        branchName: input.branchName,
        issueId: key,
        challengePairId: pairId,
        explicitSide,
      });
      const sideIntent = resolution.side === 'challenger' ? intent.challenger : intent.primary;
      const extracted = extractExpectedStage(sideIntent, 'review');
      if (extracted.model) {
        return { pairId, model: extracted.model, agent: extracted.agent };
      }
    }

    return { pairId, unresolvable: true };
  }

  return undefined;
}

// ────────────────────────────────────────────────────────────────
// HOK-3065 — sealed decision envelope + expanded-route resolution.
//
// A planner-stage challenge is decided by the launch lottery before the
// expanded task packet exists. The selection (stage, pair, challenger
// identity) is sealed at that moment; only the non-varied route fields wait on
// expansion. These helpers make the two halves explicit: `sealChallengeDecision`
// extracts the immutable selection, and `resolveSealedDecisionAgainstExpandedRoute`
// enriches it with the expanded route without ever rerolling the sealed choice.
// ────────────────────────────────────────────────────────────────

export interface SealedChallengeDecision {
  pairId: string;
  issueId?: string;
  /** The single stage this pair varies; sealed at selection, never re-sampled. */
  selectedStage: ChallengeStage;
  decisionSource?: ChallengeDecisionSource;
  selectionPath?: ChallengeSelectionPath | readonly string[];
  intentionallyIdentical?: boolean;
  /** The incumbent's varied-stage model as known at seal time (may be enriched later). */
  primaryVariedModel: string;
  primaryVariedAgent?: string;
  /** The challenger's varied-stage model — the experiment. This is immutable. */
  challengerVariedModel: string;
  challengerVariedAgent?: string;
}

export type ExpandedRouteCollapseReason =
  | 'sealed_intent_incomplete'
  | 'expanded_route_missing'
  | 'sealed_challenger_ineligible';

export interface ExpandedRouteMaterializeResult {
  status: 'materialize';
  variedStage: ChallengeStage;
  challengerVariedModel: string;
  intent: ChallengeExecutionIntent;
}

export interface ExpandedRouteCollapseResult {
  status: 'collapse';
  reason: ExpandedRouteCollapseReason;
  detail: string;
}

export type ExpandedRouteResolution = ExpandedRouteMaterializeResult | ExpandedRouteCollapseResult;

/**
 * Read one stage's {model, agent} from either side shape.
 *
 * The launcher persists the runtime envelope shape (`planner|coder|reviewer:
 * {model, agent}`); the eval/projection shape (`expectedStageModel` +
 * `expectedRoute`) also occurs on disk across launcher versions. Both are
 * tolerated so a sealed intent written by any version resolves.
 */
function readSideStageRoute(
  side: ChallengeSideIntent | ChallengeRuntimeSideIntent | undefined,
  stage: ChallengeStage,
): { model: string; agent: string } {
  if (!side) return { model: '', agent: '' };
  const runtime = stageRouteFromRuntimeSide(side as ChallengeRuntimeSideIntent, stage);
  if (runtime && clean(runtime.model)) {
    return { model: clean(runtime.model), agent: clean(runtime.agent) };
  }
  const projected = side as Partial<ChallengeSideIntent>;
  if (projected.challengeStage === stage && clean(projected.expectedStageModel)) {
    return { model: clean(projected.expectedStageModel), agent: clean(projected.expectedStageAgent) };
  }
  const routeModel = modelForChallengeStage(projected.expectedRoute, stage);
  return routeModel ? { model: routeModel, agent: '' } : { model: '', agent: '' };
}

function sideKey(side: ChallengeSideIntent | ChallengeRuntimeSideIntent | undefined): string {
  const value = (side as { key?: unknown } | undefined)?.key;
  return typeof value === 'string' ? value : '';
}

/**
 * Extract the immutable selection from a sealed intent, or undefined when the
 * intent is not a well-formed two-sided challenge.
 */
export function sealChallengeDecision(
  intent: ChallengeExecutionIntent | null | undefined,
): SealedChallengeDecision | undefined {
  if (!intent || !clean(intent.pairId) || !intent.primary || !intent.challenger) return undefined;
  const stage = stageFromIntent(intent);
  const primaryVaried = readSideStageRoute(intent.primary, stage);
  const challengerVaried = readSideStageRoute(intent.challenger, stage);
  if (!challengerVaried.model) return undefined;
  return {
    pairId: clean(intent.pairId),
    ...(clean(intent.issueId) ? { issueId: clean(intent.issueId) } : {}),
    selectedStage: stage,
    ...(intent.decisionSource ? { decisionSource: intent.decisionSource } : {}),
    ...(intent.selectionPath ? { selectionPath: intent.selectionPath } : {}),
    ...(intent.intentionallyIdentical ? { intentionallyIdentical: true } : {}),
    primaryVariedModel: primaryVaried.model,
    ...(primaryVaried.agent ? { primaryVariedAgent: primaryVaried.agent } : {}),
    challengerVariedModel: challengerVaried.model,
    ...(challengerVaried.agent ? { challengerVariedAgent: challengerVaried.agent } : {}),
  };
}

/**
 * Report which immutable selection fields differ between a sealed decision and
 * a candidate intent. An empty array means the candidate preserved the seal;
 * finalization must fail closed on any non-empty result rather than adopt the
 * candidate (HOK-3065 immutability invariant).
 */
export function sealedSelectionViolations(
  sealed: SealedChallengeDecision,
  candidate: ChallengeExecutionIntent | null | undefined,
): string[] {
  const candidateSeal = sealChallengeDecision(candidate);
  if (!candidateSeal) return ['sealed_intent_incomplete'];
  const violations: string[] = [];
  if (candidateSeal.pairId !== sealed.pairId) violations.push('pairId');
  if (candidateSeal.selectedStage !== sealed.selectedStage) violations.push('selectedStage');
  if (candidateSeal.challengerVariedModel !== sealed.challengerVariedModel) {
    violations.push('challengerVariedModel');
  }
  return violations;
}

/**
 * Enrich a sealed challenge decision with the expanded route.
 *
 * The varied stage's *challenger* model is preserved byte-for-byte (the sealed
 * experiment); the *primary* incumbent and every non-varied stage on both sides
 * are filled from the expanded route. The sealed stage, pair id, and challenger
 * identity are never re-sampled. When the sealed challenger is no longer
 * eligible the result is a typed `collapse` — the caller fails closed and aborts
 * the pair; a substitute challenger is never selected here (that decision
 * belongs to a fresh lottery, not to finalization).
 */
export function resolveSealedDecisionAgainstExpandedRoute(input: {
  sealed: ChallengeExecutionIntent | null | undefined;
  expandedRoute: ChallengeRoutingMeta | null | undefined;
  /** Current eligibility for the varied stage; when supplied the sealed challenger must be a member. */
  eligibleVariedModels?: Iterable<string>;
}): ExpandedRouteResolution {
  const sealedDecision = sealChallengeDecision(input.sealed);
  const intent = input.sealed;
  if (!sealedDecision || !intent || !intent.primary || !intent.challenger) {
    return {
      status: 'collapse',
      reason: 'sealed_intent_incomplete',
      detail: 'Sealed intent is missing a pair id or one of its two sides.',
    };
  }
  const stage = sealedDecision.selectedStage;
  const route = input.expandedRoute;
  const routeModel = (s: ChallengeStage): string => modelForChallengeStage(route ?? undefined, s);
  if (!routeModel(stage)) {
    return {
      status: 'collapse',
      reason: 'expanded_route_missing',
      detail: `Expanded route has no ${stage}-stage model to enrich the primary incumbent.`,
    };
  }

  if (input.eligibleVariedModels) {
    const eligible = new Set<string>();
    for (const model of input.eligibleVariedModels) eligible.add(clean(model));
    if (!eligible.has(sealedDecision.challengerVariedModel)) {
      return {
        status: 'collapse',
        reason: 'sealed_challenger_ineligible',
        detail: `Sealed ${stage}-stage challenger ${sealedDecision.challengerVariedModel} is no longer eligible; aborting rather than substituting.`,
      };
    }
  }

  const primarySealed = intent.primary;
  const challengerSealed = intent.challenger;
  const enrichStage = (s: ChallengeStage, sealedSide: typeof primarySealed): { model: string; agent: string } => ({
    model: routeModel(s),
    agent: readSideStageRoute(sealedSide, s).agent,
  });

  const primary: ChallengeRuntimeSideIntent = {
    ...(sideKey(primarySealed) ? { key: sideKey(primarySealed) } : {}),
    role: 'primary',
    planner: enrichStage('plan', primarySealed),
    coder: enrichStage('implementation', primarySealed),
    reviewer: enrichStage('review', primarySealed),
    inheritedStages: [],
  };

  const challengerStage = (s: ChallengeStage): { model: string; agent: string } => {
    if (s === stage) {
      return {
        model: sealedDecision.challengerVariedModel,
        agent: sealedDecision.challengerVariedAgent ?? readSideStageRoute(challengerSealed, s).agent,
      };
    }
    return enrichStage(s, challengerSealed);
  };
  const challenger: ChallengeRuntimeSideIntent = {
    ...(sideKey(challengerSealed) ? { key: sideKey(challengerSealed) } : {}),
    role: 'challenger',
    planner: challengerStage('plan'),
    coder: challengerStage('implementation'),
    reviewer: challengerStage('review'),
    inheritedStages: [],
  };

  const enriched: ChallengeExecutionIntent = {
    ...intent,
    schemaVersion: 1,
    decisionSource: 'preserved',
    selectedStage: stage,
    challengeStage: stage,
    primary,
    challenger,
  };

  // Self-check: enrichment must never touch the sealed selection. This catches a
  // future regression where filling non-varied fields accidentally rewrites the
  // stage, pair, or challenger identity — the exact class of bug HOK-3065 closes.
  const violations = sealedSelectionViolations(sealedDecision, enriched);
  if (violations.length > 0) {
    return {
      status: 'collapse',
      reason: 'sealed_intent_incomplete',
      detail: `Enrichment would have changed sealed selection field(s): ${violations.join(', ')}.`,
    };
  }

  return {
    status: 'materialize',
    variedStage: stage,
    challengerVariedModel: sealedDecision.challengerVariedModel,
    intent: enriched,
  };
}
