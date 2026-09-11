import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ChallengeEvalStage,
  ChallengeStageEval,
  ChallengeStageEvidenceItem,
  EvalExecutedPlanning,
  EvalPhaseDurations,
  PlanningExecutionOutcome,
  EvalRecord,
  EvalRouting,
  RoutePrediction,
  RoutingDecision,
} from './eval-schema.ts';
import type { ExecutedIdentity, ReviewExecutedIdentitySet } from './challenge-execution-contract.ts';

const MAX_SNIPPET_CHARS = 320;

interface GatheredStageArtifactsLike {
  planContent?: string;
  selfReviewSummary?: string;
  routingDecision?: RoutingDecision;
  routing?: EvalRouting;
  routePrediction?: RoutePrediction;
  executedPlanning?: EvalExecutedPlanning;
  planningExecutionOutcome?: PlanningExecutionOutcome;
  phaseDurations?: EvalPhaseDurations;
}

export interface BuildChallengeStageEvalInput {
  repoDir: string;
  issueId?: string;
  branchName?: string;
  worktreePath?: string;
  challengeStage?: 'plan' | 'implementation' | 'review';
  record: EvalRecord;
  stageArtifacts: GatheredStageArtifactsLike;
}

type StageResultShape = {
  status?: string;
  failureReason?: string | null;
  agent?: string;
  model?: string;
  notes?: string;
  artifacts?: {
    type?: string;
    bounds?: {
      maxTurns?: unknown;
      maxToolCalls?: unknown;
      maxWallClockMs?: unknown;
    };
    usage?: {
      turnsCompleted?: unknown;
      toolCallsExecuted?: unknown;
      wallClockMs?: unknown;
      totalInputTokens?: unknown;
      totalOutputTokens?: unknown;
      totalCostUsd?: unknown;
    };
    planArtifactValid?: unknown;
    approvalReady?: unknown;
    findingsCount?: unknown;
    blockingIssues?: unknown;
    exitCode?: unknown;
    verdict?: unknown;
    iterations?: unknown;
    blockerCount?: unknown;
    warningCount?: unknown;
    dismissedBlockers?: unknown;
    reviewToolError?: unknown;
    prNumber?: unknown;
    prUrl?: unknown;
    review?: {
      exitCode?: unknown;
      verdict?: unknown;
      iterations?: unknown;
      blockerCount?: unknown;
      blockingCount?: unknown;
      warningCount?: unknown;
      dismissedBlockers?: unknown;
      reviewToolError?: unknown;
      findingCount?: unknown;
    };
    /** Per-iteration local review evidence (HOK-2969); shape validated defensively before use. */
    reviewIterations?: unknown;
    /** Executed identity envelope for the review stage (HOK-2969); shape validated defensively before use. */
    reviewExecutedIdentity?: unknown;
  };
};

function truncate(value: string | undefined, maxChars: number = MAX_SNIPPET_CHARS): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function addEvidence(
  evidence: ChallengeStageEvidenceItem[],
  label: string,
  summary: string | undefined,
  source?: string,
): void {
  const trimmed = truncate(summary);
  if (!trimmed) return;
  evidence.push(source ? { label, summary: trimmed, source } : { label, summary: trimmed });
}

function deriveSlug(branchName: string | undefined, worktreePath: string | undefined): string | undefined {
  const fromBranch = branchName?.replace(/^(task|bug)\//, '').trim();
  if (fromBranch) {
    return fromBranch;
  }
  const base = worktreePath ? path.basename(worktreePath).trim() : '';
  return base || undefined;
}

function readStageResult(
  repoDir: string,
  issueId: string | undefined,
  slug: string | undefined,
  worktreePath: string | undefined,
  stage: 'planning' | 'review',
): StageResultShape | null | undefined {
  const fileName = `.${stage}-result.json`;
  const archiveName = `${stage}-result.json`;
  const candidates: string[] = [];

  if (slug) {
    for (const root of [worktreePath, repoDir]) {
      if (!root) continue;
      for (const dir of ['features', 'bugs']) {
        candidates.push(path.join(root, dir, slug, fileName));
      }
    }
  }

  if (issueId) {
    candidates.push(path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, fileName));
    candidates.push(path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, archiveName));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as StageResultShape;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  return undefined;
}

function summarizePlanningResult(result: StageResultShape | null | undefined): string | undefined {
  if (!result) return undefined;
  const parts = [
    result.status ? `status=${result.status}` : '',
    result.model ? `model=${result.model}` : '',
    result.agent ? `agent=${result.agent}` : '',
    truncate(result.notes, 120) ? `notes=${truncate(result.notes, 120)}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function exceedsBound(usage: unknown, bound: unknown): boolean {
  return typeof usage === 'number'
    && Number.isFinite(usage)
    && typeof bound === 'number'
    && Number.isFinite(bound)
    && usage >= bound;
}

function summarizePlanningExecutionOutcome(result: StageResultShape | null | undefined): string | undefined {
  if (!result) return undefined;
  const artifacts = result.artifacts;
  const bounds = artifacts?.bounds;
  const usage = artifacts?.usage;
  const exceeded = [
    exceedsBound(usage?.turnsCompleted, bounds?.maxTurns) ? 'turns' : '',
    exceedsBound(usage?.toolCallsExecuted, bounds?.maxToolCalls) ? 'tool_calls' : '',
    exceedsBound(usage?.wallClockMs, bounds?.maxWallClockMs) ? 'wall_clock' : '',
  ].filter(Boolean);
  const parts = [
    result.status ? `status=${result.status}` : '',
    result.model ? `model=${result.model}` : '',
    result.agent ? `agent=${result.agent}` : '',
    result.failureReason ? `failureReason=${result.failureReason}` : '',
    typeof artifacts?.planArtifactValid === 'boolean' ? `planValid=${artifacts.planArtifactValid}` : '',
    typeof artifacts?.approvalReady === 'boolean' ? `approvalReady=${artifacts.approvalReady}` : '',
    typeof bounds?.maxTurns === 'number' ? `maxTurns=${bounds.maxTurns}` : '',
    typeof usage?.turnsCompleted === 'number' ? `turnsCompleted=${usage.turnsCompleted}` : '',
    typeof bounds?.maxToolCalls === 'number' ? `maxToolCalls=${bounds.maxToolCalls}` : '',
    typeof usage?.toolCallsExecuted === 'number' ? `toolCallsExecuted=${usage.toolCallsExecuted}` : '',
    typeof bounds?.maxWallClockMs === 'number' ? `maxWallClockMs=${bounds.maxWallClockMs}` : '',
    typeof usage?.wallClockMs === 'number' ? `wallClockMs=${usage.wallClockMs}` : '',
    exceeded.length > 0 ? `boundsExceeded=${exceeded.join('|')}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizeReviewResult(result: StageResultShape | null | undefined): string | undefined {
  if (!result) return undefined;
  const review = result.artifacts?.review;
  const findings = typeof result.artifacts?.findingsCount === 'number'
    ? `findings=${result.artifacts.findingsCount}`
    : typeof review?.findingCount === 'number'
      ? `findings=${review.findingCount}`
      : '';
  const blockers = typeof result.artifacts?.blockerCount === 'number'
    ? `blockers=${result.artifacts.blockerCount}`
    : typeof result.artifacts?.blockingIssues === 'number'
      ? `blockers=${result.artifacts.blockingIssues}`
      : typeof review?.blockerCount === 'number'
        ? `blockers=${review.blockerCount}`
        : typeof review?.blockingCount === 'number'
          ? `blockers=${review.blockingCount}`
          : '';
  const exitCode = typeof result.artifacts?.exitCode === 'number'
    ? `exitCode=${result.artifacts.exitCode}`
    : typeof review?.exitCode === 'number'
      ? `exitCode=${review.exitCode}`
      : '';
  const verdict = typeof result.artifacts?.verdict === 'string'
    ? `verdict=${result.artifacts.verdict}`
    : typeof review?.verdict === 'string'
      ? `verdict=${review.verdict}`
      : '';
  const iterations = typeof result.artifacts?.iterations === 'number'
    ? `iterations=${result.artifacts.iterations}`
    : typeof review?.iterations === 'number'
      ? `iterations=${review.iterations}`
      : '';
  const warnings = typeof result.artifacts?.warningCount === 'number'
    ? `warnings=${result.artifacts.warningCount}`
    : typeof review?.warningCount === 'number'
      ? `warnings=${review.warningCount}`
    : '';
  // Dismissed blockers (HOK-2932): readiness credited through documented
  // dismissals must be visible in eval records, justification included.
  const dismissedEntries = Array.isArray(result.artifacts?.dismissedBlockers)
    ? result.artifacts.dismissedBlockers
    : Array.isArray(review?.dismissedBlockers)
      ? review.dismissedBlockers
      : [];
  const dismissed = dismissedEntries.length > 0
    ? `dismissedBlockers=${dismissedEntries.length}`
    : '';
  const dismissalJustifications = dismissedEntries
    .map((entry) => (entry && typeof entry === 'object' && typeof (entry as { justification?: unknown }).justification === 'string'
      ? (entry as { justification: string }).justification
      : ''))
    .filter(Boolean)
    .join(' | ');
  const dismissalDetail = dismissalJustifications
    ? `dismissalJustifications=${truncate(dismissalJustifications, 240)}`
    : '';
  const toolError = typeof result.artifacts?.reviewToolError === 'string'
    ? `toolError=${truncate(result.artifacts.reviewToolError, 120)}`
    : typeof review?.reviewToolError === 'string'
      ? `toolError=${truncate(review.reviewToolError, 120)}`
    : '';
  const parts = [
    result.status ? `status=${result.status}` : '',
    result.model ? `model=${result.model}` : '',
    exitCode,
    verdict,
    iterations,
    findings,
    blockers,
    dismissed,
    dismissalDetail,
    warnings,
    toolError,
    truncate(result.notes, 120) ? `notes=${truncate(result.notes, 120)}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function summarizeRouting(stageArtifacts: GatheredStageArtifactsLike): string | undefined {
  const planner = stageArtifacts.routing?.planner?.resolvedModelId;
  const coder = stageArtifacts.routing?.coder?.resolvedModelId;
  const reviewer = stageArtifacts.routing?.reviewer?.resolvedModelId;
  const routeMode = stageArtifacts.routingDecision?.routeMode;
  const parts = [
    planner ? `planner=${planner}` : '',
    coder ? `coder=${coder}` : '',
    reviewer ? `reviewer=${reviewer}` : '',
    routeMode ? `routeMode=${routeMode}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizePlanCritique(record: EvalRecord): string | undefined {
  const critique = record.metadata?.planCritique as Record<string, { score?: number }> | undefined;
  if (!critique) return undefined;
  const parts = [
    typeof critique.component_boundaries?.score === 'number' ? `boundaries=${critique.component_boundaries.score.toFixed(2)}` : '',
    typeof critique.invariant_coverage?.score === 'number' ? `invariants=${critique.invariant_coverage.score.toFixed(2)}` : '',
    typeof critique.approach_soundness?.score === 'number' ? `approach=${critique.approach_soundness.score.toFixed(2)}` : '',
    typeof critique.missed_patches?.score === 'number' ? `patches=${critique.missed_patches.score.toFixed(2)}` : '',
    typeof critique.overall?.score === 'number' ? `overall=${critique.overall.score.toFixed(2)}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizeStageScore(record: EvalRecord, stage: ChallengeEvalStage): string | undefined {
  const stageScore = record.metadata?.stageScores?.[stage] as { score?: number; rationale?: string } | undefined;
  if (!stageScore) return undefined;
  const parts = [
    typeof stageScore.score === 'number' ? `score=${stageScore.score.toFixed(2)}` : '',
    truncate(stageScore.rationale, 160) ? `rationale=${truncate(stageScore.rationale, 160)}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function summarizeReviewOutcome(record: EvalRecord): string | undefined {
  const review = record.outcomes?.review;
  if (!review) return undefined;
  return [
    `rounds=${review.rounds}`,
    `approvals=${review.approvals}`,
    `changeRequests=${review.changeRequests}`,
    typeof review.selfReviewBlockers === 'number' ? `selfReviewBlockers=${review.selfReviewBlockers}` : '',
    typeof review.selfReviewWarnings === 'number' ? `selfReviewWarnings=${review.selfReviewWarnings}` : '',
  ].filter(Boolean).join(', ');
}

function summarizeInterventions(record: EvalRecord): string | undefined {
  const interventions = record.interventions || [];
  if (interventions.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const intervention of interventions) {
    counts.set(intervention.type, (counts.get(intervention.type) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${type}=${count}`)
    .join(', ');
}

function directFallbackReason(parts: string[]): string {
  return `Missing ${parts.join(' and ')}`;
}

function buildPlannerStageEval(
  input: BuildChallengeStageEvalInput,
  slug: string | undefined,
): ChallengeStageEval {
  const evidence: ChallengeStageEvidenceItem[] = [];
  const planningResult = readStageResult(input.repoDir, input.issueId, slug, input.worktreePath, 'planning');
  const planContent = truncate(input.stageArtifacts.planContent);

  addEvidence(evidence, 'plan_text', planContent, 'plan.md');
  addEvidence(evidence, 'planning_result', summarizePlanningResult(planningResult), '.planning-result.json');
  addEvidence(
    evidence,
    'planning_execution_outcome',
    summarizePlanningExecutionOutcome(planningResult),
    '.planning-result.json',
  );
  addEvidence(evidence, 'routing', summarizeRouting(input.stageArtifacts), '.routing-complete');
  addEvidence(evidence, 'plan_critique', summarizePlanCritique(input.record), 'judge.planCritique');
  addEvidence(evidence, 'interventions', summarizeInterventions(input.record), 'interventions');
  if (input.stageArtifacts.executedPlanning) {
    addEvidence(
      evidence,
      'executed_planning',
      [
        input.stageArtifacts.executedPlanning.status ? `status=${input.stageArtifacts.executedPlanning.status}` : '',
        input.stageArtifacts.executedPlanning.model ? `model=${input.stageArtifacts.executedPlanning.model}` : '',
        input.stageArtifacts.executedPlanning.agent ? `agent=${input.stageArtifacts.executedPlanning.agent}` : '',
      ].filter(Boolean).join(', '),
      input.stageArtifacts.executedPlanning.source,
    );
  }

  const missing: string[] = [];
  if (!planContent) missing.push('plan.md');
  if (!planningResult) missing.push('.planning-result.json');

  if (missing.length === 0) {
    return {
      stage: 'plan',
      provenance: 'direct',
      summary: 'Direct planning evidence captured from plan text and planning result artifacts.',
      evidence,
    };
  }

  addEvidence(evidence, 'inferred_plan_score', summarizeStageScore(input.record, 'plan'), 'metadata.stageScores.plan');

  return {
    stage: 'plan',
    provenance: 'inferred',
    summary: 'Planning comparison fell back to inferred evidence because direct planning artifacts were incomplete.',
    fallbackReason: directFallbackReason(missing),
    evidence,
  };
}

// ────────────────────────────────────────────────────────────────
// Review Executed-Identity / Iteration Evidence Helpers (HOK-2969)
// ────────────────────────────────────────────────────────────────

type RawReviewIteration = {
  iteration?: unknown;
  findings?: unknown;
};

function rawReviewIterations(result: StageResultShape | null | undefined): RawReviewIteration[] {
  const candidate = result?.artifacts?.reviewIterations;
  return Array.isArray(candidate) ? candidate as RawReviewIteration[] : [];
}

/**
 * Iteration evidence is complete when at least one iteration was recorded
 * and every iteration carries a findings array (possibly empty) — a review
 * that genuinely found nothing still has to show it looked.
 */
function reviewIterationsAreComplete(result: StageResultShape | null | undefined): boolean {
  const iterations = rawReviewIterations(result);
  if (iterations.length === 0) return false;
  return iterations.every((entry) => typeof entry.iteration === 'number' && Array.isArray(entry.findings));
}

function summarizeReviewIterations(result: StageResultShape | null | undefined): string | undefined {
  const iterations = rawReviewIterations(result);
  if (iterations.length === 0) return undefined;
  const findingCount = iterations.reduce(
    (sum, entry) => sum + (Array.isArray(entry.findings) ? entry.findings.length : 0),
    0,
  );
  return `iterationCount=${iterations.length}, findingCount=${findingCount}, complete=${reviewIterationsAreComplete(result)}`;
}

type RawExecutedIdentity = {
  role?: unknown;
  requestedModel?: unknown;
  resolvedModel?: unknown;
  agent?: unknown;
  source?: unknown;
  fallbackReason?: unknown;
  pinned?: unknown;
  conflict?: unknown;
};

type RawReviewExecutedIdentitySet = {
  orchestrator?: RawExecutedIdentity;
  substantiveAnalysis?: RawExecutedIdentity;
  remediation?: RawExecutedIdentity | null;
};

function isRawExecutedIdentity(value: unknown): value is RawExecutedIdentity {
  return typeof value === 'object' && value !== null;
}

function isValidExecutedIdentity(value: RawExecutedIdentity | undefined): value is RawExecutedIdentity {
  return Boolean(value)
    && typeof value?.role === 'string'
    && typeof value?.requestedModel === 'string'
    && typeof value?.resolvedModel === 'string'
    && typeof value?.pinned === 'boolean';
}

function rawReviewExecutedIdentity(result: StageResultShape | null | undefined): RawReviewExecutedIdentitySet | undefined {
  const candidate = result?.artifacts?.reviewExecutedIdentity;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const record = candidate as Record<string, unknown>;
  return {
    orchestrator: isRawExecutedIdentity(record.orchestrator) ? record.orchestrator : undefined,
    substantiveAnalysis: isRawExecutedIdentity(record.substantiveAnalysis) ? record.substantiveAnalysis : undefined,
    remediation: record.remediation === null
      ? null
      : isRawExecutedIdentity(record.remediation) ? record.remediation : undefined,
  };
}

/**
 * Fully pinned means both required roles validated as complete identities,
 * every present identity is pinned, and none carries a recorded conflict —
 * missing or conflicting identity must never read as pinned (HOK-2969).
 */
function reviewExecutedIdentityIsPinned(result: StageResultShape | null | undefined): boolean {
  const identity = rawReviewExecutedIdentity(result);
  if (!isValidExecutedIdentity(identity?.orchestrator) || !isValidExecutedIdentity(identity?.substantiveAnalysis)) {
    return false;
  }
  const items = [
    identity!.orchestrator!,
    identity!.substantiveAnalysis!,
    ...(identity!.remediation ? [identity!.remediation] : []),
  ];
  return items.every((item) => item.pinned === true && !item.conflict);
}

function summarizeReviewExecutedIdentity(result: StageResultShape | null | undefined): string | undefined {
  const identity = rawReviewExecutedIdentity(result);
  if (!identity?.orchestrator && !identity?.substantiveAnalysis) return undefined;
  const describe = (label: string, item: RawExecutedIdentity | undefined | null): string => {
    if (!item) return '';
    const model = typeof item.resolvedModel === 'string' ? item.resolvedModel : 'unknown';
    return `${label}=${model}(pinned=${item.pinned === true}${item.conflict ? ',conflict' : ''})`;
  };
  return [
    describe('orchestrator', identity.orchestrator),
    describe('analysis', identity.substantiveAnalysis),
    identity.remediation ? describe('remediation', identity.remediation) : '',
  ].filter(Boolean).join(', ');
}

/**
 * Read and validate the review stage's executed-identity envelope for use
 * outside this module's `ChallengeStageEval` summaries (e.g. attaching
 * `EvalRecord.reviewExecutedIdentity` from `post-completion-hook.ts`).
 * Returns `undefined` rather than a partial/malformed set — a consumer must
 * never treat an invalid envelope as present identity evidence.
 */
export function extractReviewExecutedIdentity(input: {
  repoDir: string;
  issueId?: string;
  branchName?: string;
  worktreePath?: string;
}): ReviewExecutedIdentitySet | undefined {
  const slug = deriveSlug(input.branchName, input.worktreePath);
  const result = readStageResult(input.repoDir, input.issueId, slug, input.worktreePath, 'review');
  const raw = rawReviewExecutedIdentity(result);
  if (!isValidExecutedIdentity(raw?.orchestrator) || !isValidExecutedIdentity(raw?.substantiveAnalysis)) {
    return undefined;
  }
  return {
    orchestrator: raw!.orchestrator as unknown as ExecutedIdentity,
    substantiveAnalysis: raw!.substantiveAnalysis as unknown as ExecutedIdentity,
    ...(raw!.remediation === null
      ? { remediation: null }
      : isValidExecutedIdentity(raw!.remediation)
        ? { remediation: raw!.remediation as unknown as ExecutedIdentity }
        : {}),
  };
}

function buildReviewerStageEval(
  input: BuildChallengeStageEvalInput,
  slug: string | undefined,
): ChallengeStageEval {
  const evidence: ChallengeStageEvidenceItem[] = [];
  const reviewResult = readStageResult(input.repoDir, input.issueId, slug, input.worktreePath, 'review');
  const selfReviewSummary = truncate(input.stageArtifacts.selfReviewSummary);

  addEvidence(evidence, 'self_review_summary', selfReviewSummary, 'review-log');
  addEvidence(evidence, 'review_result', summarizeReviewResult(reviewResult), '.review-result.json');
  addEvidence(evidence, 'review_outcome', summarizeReviewOutcome(input.record), 'outcomes.review');
  addEvidence(evidence, 'interventions', summarizeInterventions(input.record), 'interventions');
  if (input.stageArtifacts.phaseDurations?.review !== undefined) {
    addEvidence(
      evidence,
      'review_duration',
      `reviewSeconds=${input.stageArtifacts.phaseDurations.review}`,
      '.review-result.json',
    );
  }
  addEvidence(evidence, 'review_iterations', summarizeReviewIterations(reviewResult), '.review-result.json');
  addEvidence(evidence, 'review_identity', summarizeReviewExecutedIdentity(reviewResult), '.review-result.json');

  // Reviewer-stage direct provenance requires complete per-iteration local
  // evidence and a fully pinned executed identity, not just presence of a
  // review-result artifact — a challenge cannot prove which model performed
  // substantive analysis from a summary alone (HOK-2969, Arbiter P2.4f).
  const missing: string[] = [];
  if (!selfReviewSummary) missing.push('self-review summary');
  if (!reviewResult) missing.push('.review-result.json');
  if (reviewResult && !reviewIterationsAreComplete(reviewResult)) missing.push('complete review iteration evidence');
  if (reviewResult && !reviewExecutedIdentityIsPinned(reviewResult)) missing.push('pinned reviewer execution identity');

  if (missing.length === 0) {
    return {
      stage: 'review',
      provenance: 'direct',
      summary: 'Direct review evidence captured from self-review output, review result artifacts, complete iteration evidence, and a pinned executed identity.',
      evidence,
    };
  }

  addEvidence(evidence, 'inferred_review_score', summarizeStageScore(input.record, 'review'), 'metadata.stageScores.review');

  return {
    stage: 'review',
    provenance: 'inferred',
    summary: 'Review comparison fell back to inferred evidence because direct review artifacts were incomplete.',
    fallbackReason: directFallbackReason(missing),
    evidence,
  };
}

export function buildChallengeStageEval(input: BuildChallengeStageEvalInput): ChallengeStageEval | undefined {
  if (input.challengeStage !== 'plan' && input.challengeStage !== 'review') {
    return undefined;
  }

  const slug = deriveSlug(input.branchName, input.worktreePath);
  return input.challengeStage === 'plan'
    ? buildPlannerStageEval(input, slug)
    : buildReviewerStageEval(input, slug);
}
