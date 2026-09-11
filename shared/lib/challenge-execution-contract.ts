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
  | 'missing_challenge_intent';

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
  challengeRole?: unknown;
  challengeExecutionIntent?: ChallengeExecutionIntent;
  challengeIntent?: ChallengeExecutionIntent;
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
