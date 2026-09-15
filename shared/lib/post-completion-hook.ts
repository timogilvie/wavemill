/**
 * Post-completion hook for wavemill workflows.
 *
 * Automatically triggers eval after a workflow finishes (PR created).
 * Non-blocking: eval failures log a warning but never fail the workflow.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildUnscoredEvalRecord, evaluateTask, isJudgeResponseRecoveryError } from './eval.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { resolveEvalsDir, resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import { execShellCommand } from './shell-utils.ts';
import { detectAndFormatInterventions } from './intervention-detector.ts';
import { computeWorkflowCost, loadPricingTable } from './workflow-cost.ts';
import { collectExecutionEconomics } from './execution-economics.ts';
import { getDeepSeekProviderMetadata } from './deepseek-provider.ts';
import { runEvalAnalysis } from './eval-analysis.ts';
import { callHeadlessLLM } from './headless-llm.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { formatLintResults, lintSubsystemSpecs } from './context-linter.ts';
import { updateAffectedSubsystems } from './subsystem-updater.ts';
import { detectAffectedSubsystems } from './subsystem-mapper.ts';
import { gatherEvalContext, gatherStageArtifacts } from './eval-context-gatherer.ts';
import { fetchRoutingCompleteRawWithArchive } from './eval-context-gatherer.ts';
import {
  attachChallengeExecutionMetadata,
  attachPhaseDurations,
  attachStageOutcomes,
  enrichTrainingMetadata,
  buildVerificationTelemetryFromArtifact,
} from './eval-record-builder.ts';
import { buildChallengeStageEval, extractReviewExecutedIdentity } from './stage-eval-evidence.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { getEvalContextUpdatesConfig, getMaxCostUsd } from './config.ts';
import { runConfiguredHarnessRetentionReplay } from './harness-replay.ts';
import { formatHokusaiSubmissionTriggerResult, triggerHokusaiSubmission } from './hokusai-submission-trigger.ts';
import { readAndValidateArtifact } from './pre-pr-verification.ts';
import { getPrePrVerificationConfig } from './config.ts';
import type { PrePrVerificationConfig } from './pre-pr-verification-types.ts';
import { getConfiguredModelsForDescriptor } from './model-registry.ts';
import { getCurrentOperatingMode } from './operating-mode.ts';
import { finalizeEvalSuccess } from './eval-success-policy.ts';
import {
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
  clearCandidateFeaturesCache,
} from './outcome-collectors.ts';
import type { CandidateFeatureContract } from './candidate-features.ts';
import {
  buildRouteLifecycleProvenance,
  deriveRouteDecisionSource,
  readRouteLifecycleArtifacts,
} from './route-artifact.ts';
import { printEvalSummary, formatDifficultyDisplay, formatTaskContextDisplay, formatRepoContextDisplay, formatInterventionDisplay } from './eval-summary-printer.ts';
import { errorMessage } from './error-utils.ts';
import { resolvePrIdentityMetadata } from './pr-comparison.ts';
import type {
  EvalExecutedPlanning,
  EvalExecutionEconomics,
  EvalPhaseDurations,
  EvalRecord,
  EvalRouteProvenance,
  EvalRouting,
  InterventionRecord,
  PlanningExecutionOutcome,
  RoutePrediction,
  RoutingDecision,
  TaskContext,
  RepoContext,
  Outcomes,
} from './eval-schema.ts';
import type { DifficultyAnalysis } from './difficulty-analyzer.ts';
import type { ChallengeRouteContext } from './challenge-mode.ts';
import type { WorkflowCostOutcome } from './workflow-cost.ts';
import type { InterventionSummary } from './intervention-detector.ts';
import type { OperatingMode } from './operating-mode.ts';
import {
  attestEvalRecordChallengeExecution,
  enforceChallengeIntentPresence,
  loadChallengeIntentFromFeatureDir,
  loadChallengeIntentFromState,
  resolveChallengeSide,
  type ChallengeExecutionIntent,
} from './challenge-execution-contract.ts';

function isFiniteNonNegativeBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function resolvePostCompletionBudget(input: Pick<PostCompletionEnrichmentInput, 'repoDir' | 'issueId' | 'branchName' | 'worktreePath' | 'record'>): number | undefined {
  const slug = input.branchName?.replace(/^(task|bug)\//, '') || input.issueId?.toLowerCase() || '';
  const routingComplete = slug
    ? fetchRoutingCompleteRawWithArchive(input.repoDir, slug, input.issueId || '', input.worktreePath)
    : null;
  return [
    input.record.constraints?.maxCostUsd,
    routingComplete?.maxCostUsd,
    routingComplete?.constraints?.maxCostUsd,
    getMaxCostUsd(input.repoDir),
  ].find(isFiniteNonNegativeBudget);
}

function loadPostCompletionChallengeIntent(input: PostCompletionEnrichmentInput): ChallengeExecutionIntent | undefined {
  const slug = input.branchName?.replace(/^(task|bug)\//, '') || input.issueId?.toLowerCase() || '';
  if (!input.challengePairId) return undefined;
  const stateIntent = loadChallengeIntentFromState(input.repoDir, input.issueId, input.challengePairId);
  if (stateIntent) return stateIntent;
  if (input.worktreePath && slug) {
    for (const dir of ['features', 'bugs']) {
      const intent = loadChallengeIntentFromFeatureDir(path.join(input.worktreePath, dir, slug));
      if (intent) return intent;
    }
  }
  return undefined;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PostCompletionContext {
  issueId?: string;
  prNumber?: string;
  prUrl?: string;
  workflowType: string;
  repoDir?: string;
  branchName?: string;
  worktreePath?: string;
  agentType?: string;
  solutionModel?: string;
  challengePairId?: string;
  /** Authoritative side from the task key; the Linear issueId cannot distinguish arms. */
  challengeSide?: 'primary' | 'challenger';
  challengeStage?: 'plan' | 'implementation' | 'review';
  onPersisted?: () => void;
}

interface PostCompletionOutcomeInput {
  prNumber?: string;
  branchName?: string;
  repoDir: string;
  worktreePath?: string;
  agentType?: string;
  issueId?: string;
  interventionSummary: InterventionSummary;
}

export type ContextUpdateWarningReason =
  | 'timeout'
  | 'error'
  | 'skipped-config'
  | 'skipped-env'
  | 'skipped-operating-mode';

export interface ContextUpdateOutcome {
  ran: boolean;
  reason?: ContextUpdateWarningReason;
  durationMs: number;
  retryCount: number;
  errorMessage?: string;
  operatingMode: OperatingMode;
}

interface ContextUpdateWarningRecord {
  timestamp: string;
  evalId: string;
  issueId?: string;
  reason: ContextUpdateWarningReason;
  operatingMode: OperatingMode;
  durationMs: number;
  retryCount: number;
  errorMessage?: string;
}

interface ContextUpdateExecutionOptions {
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
}

function defaultReviewOutcome(interventionSummary: InterventionSummary) {
  return {
    humanReviewRequired: interventionSummary.interventions.some(
      (entry) => entry.type === 'review_comment' && entry.count > 0
    ),
    rounds: 0,
    approvals: 0,
    changeRequests: 0,
  };
}

function safeCollectOutcome<T>(
  label: string,
  fallback: T,
  collector: () => T,
): T {
  try {
    return collector();
  } catch (err) {
    console.warn(`Post-completion eval: failed to collect ${label} outcome - ${errorMessage(err)}`);
    return fallback;
  }
}

function persistJudgeFailureArtifact(
  repoDir: string,
  issueId: string | undefined,
  error: import('./eval.ts').JudgeResponseRecoveryError,
): string {
  const issueSegment = issueId || 'unknown-issue';
  const artifactDir = join(resolveEvalsDir(undefined, repoDir).dir, 'artifacts', issueSegment);
  mkdirSync(artifactDir, { recursive: true });
  const filename = `judge-json-failure-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.log`;
  const artifactPath = join(artifactDir, filename);
  const tmpPath = join(artifactDir, `.tmp-${filename}`);
  const payload = [
    `timestamp: ${new Date().toISOString()}`,
    `issueId: ${issueId || ''}`,
    `error: ${error.message}`,
    `firstAttempt.parseError: ${error.firstAttempt.parseError}`,
    `firstAttempt.repairError: ${error.firstAttempt.repairError || ''}`,
    `retryAttempt.parseError: ${error.retryAttempt?.parseError || ''}`,
    `retryAttempt.repairError: ${error.retryAttempt?.repairError || ''}`,
    '',
    '--- first-attempt-raw ---',
    error.firstAttempt.rawText,
    '',
    '--- retry-attempt-raw ---',
    error.retryRawText || '',
    '',
  ].join('\n');
  writeFileSync(tmpPath, payload, 'utf8');
  renameSync(tmpPath, artifactPath);
  return artifactPath;
}

export const postCompletionHookDeps = {
  gatherEvalContext,
  gatherStageArtifacts,
  collectExecutionEconomics,
  execShellCommand,
  detectAndFormatInterventions,
  runEvalAnalysis,
  evaluateTask,
  buildUnscoredEvalRecord,
  appendEvalRecord,
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
  getEvalContextUpdatesConfig,
  getCurrentOperatingMode,
  triggerHokusaiSubmission,
  runHarnessRetentionReplay: runConfiguredHarnessRetentionReplay,
  runContextUpdateWork: updateProjectContext,
  appendContextUpdateWarning,
};

async function triggerHokusaiSubmissionAfterPersistence(record: EvalRecord, repoDir: string): Promise<void> {
  try {
    const result = await postCompletionHookDeps.triggerHokusaiSubmission(record, { repoDir });
    console.log(`Post-completion eval: Hokusai submission ${formatHokusaiSubmissionTriggerResult(result)}`);
  } catch (error) {
    console.warn(`Post-completion eval: Hokusai submission failed (${errorMessage(error)})`);
  }
}

/**
 * Wavemill enrichment layer for `candidate_features/v1`.
 *
 * The extractor in `candidate-features.ts` intentionally knows nothing about
 * wavemill state so it can run against a bare checkout. Inside wavemill,
 * this local helper translates the selected-task record and available
 * workflow artifacts into a `CandidateFeatureContract`, so Intent (via the
 * `deriveTaskDescriptor` bridge on the task text) and bounded Provenance
 * fields (`self_review_iterations`, `human_intervention_count`,
 * `agent_iterations`) are populated when collectors run in-workflow.
 *
 * Kept inside the wavemill-only post-completion module so `Arbiter S4` can
 * lift `candidate-features.ts` into `@hokusai/scan` without pulling any
 * workflow state through with it.
 */
export function buildWavemillCandidateContract(inputs: {
  featureDir?: string;
  selectedTask?: { title?: string; description?: string };
  reviewResult?: { artifacts?: { iterations?: unknown } };
  humanInterventionCount?: number;
  agentIterations?: number;
}): CandidateFeatureContract | undefined {
  const selectedTask = inputs.selectedTask ?? readWavemillJson(inputs.featureDir, 'selected-task.json') as
    | { title?: string; description?: string } | undefined;
  const reviewResult = inputs.reviewResult ?? readWavemillJson(inputs.featureDir, '.review-result.json') as
    | { artifacts?: { iterations?: unknown } } | undefined;

  const parts: string[] = [];
  if (typeof selectedTask?.title === 'string' && selectedTask.title.trim()) parts.push(selectedTask.title.trim());
  if (typeof selectedTask?.description === 'string' && selectedTask.description.trim()) {
    parts.push(selectedTask.description.trim());
  }
  const taskText = parts.length > 0 ? parts.join('\n\n') : undefined;

  const iterationsRaw = reviewResult?.artifacts?.iterations;
  const selfReviewIterations = typeof iterationsRaw === 'number' && Number.isInteger(iterationsRaw) && iterationsRaw >= 0
    ? iterationsRaw
    : null;

  const contract: CandidateFeatureContract = {};
  if (taskText) contract.taskText = taskText;

  const provenance: NonNullable<CandidateFeatureContract['provenance']> = {};
  if (selfReviewIterations !== null) provenance.self_review_iterations = selfReviewIterations;
  if (typeof inputs.agentIterations === 'number' && inputs.agentIterations >= 0) {
    provenance.agent_iterations = inputs.agentIterations;
  }
  if (typeof inputs.humanInterventionCount === 'number' && inputs.humanInterventionCount >= 0) {
    provenance.human_intervention_count = inputs.humanInterventionCount;
  }
  if (Object.keys(provenance).length > 0) contract.provenance = provenance;

  return Object.keys(contract).length > 0 ? contract : undefined;
}

/**
 * Resolve `features/<slug>/` for a wavemill worktree, matching
 * `basename(worktreePath)` against a directory under `repoDir/features/`.
 */
export function resolveWavemillFeatureDir(
  worktreePath: string | undefined,
  repoDir: string,
): string | undefined {
  if (!worktreePath) return undefined;
  const slug = basename(worktreePath);
  if (!slug) return undefined;
  const candidate = join(repoDir, 'features', slug);
  return existsSync(candidate) ? candidate : undefined;
}

function readWavemillJson(featureDir: string | undefined, name: string): unknown {
  if (!featureDir) return undefined;
  const path = join(featureDir, name);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: unknown) {
    console.warn(`[wavemill-adapter] Failed to read ${name}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function collectPostCompletionOutcomes(input: PostCompletionOutcomeInput): Outcomes {
  const {
    prNumber,
    branchName,
    repoDir,
    worktreePath,
    agentType,
    issueId,
    interventionSummary,
  } = input;
  const reviewFallback = defaultReviewOutcome(interventionSummary);
  // Build the wavemill enrichment contract once so both Tests and Static
  // paths share the same Intent + Provenance signals (Intent via
  // `deriveTaskDescriptor` on the selected-task text, self-review iterations
  // from `.review-result.json`, and the intervention summary's totals).
  const featureDir = resolveWavemillFeatureDir(worktreePath, repoDir);
  const contract = featureDir
    ? buildWavemillCandidateContract({
        featureDir,
        humanInterventionCount: interventionSummary?.interventions?.length ?? 0,
      })
    : undefined;

  try {
    return {
      success: false,
      ci: prNumber
        ? safeCollectOutcome('ci', { ran: false, passed: true, checks: [] }, () =>
            postCompletionHookDeps.collectCiOutcome(prNumber, repoDir))
        : undefined,
      tests: prNumber && branchName
        ? safeCollectOutcome('tests', { added: false }, () =>
            postCompletionHookDeps.collectTestsOutcome(
              prNumber, branchName, 'main', repoDir, worktreePath, contract,
            ))
        : undefined,
      staticAnalysis: prNumber && branchName
        ? safeCollectOutcome('static analysis', {}, () =>
            postCompletionHookDeps.collectStaticAnalysisOutcome(
              prNumber, branchName, 'main', repoDir, worktreePath, contract,
            ))
        : undefined,
      review: prNumber
        ? safeCollectOutcome('review', reviewFallback, () =>
            postCompletionHookDeps.collectReviewOutcome(
              prNumber,
              interventionSummary,
              repoDir,
              undefined,
              issueId,
              branchName,
            ))
        : reviewFallback,
      rework: branchName
        ? safeCollectOutcome('rework', { agentIterations: 0 }, () =>
            postCompletionHookDeps.collectReworkOutcome(worktreePath || repoDir, branchName, agentType, repoDir))
        : { agentIterations: 0 },
      delivery: prNumber
        ? safeCollectOutcome('delivery', { prCreated: false, merged: false }, () =>
            postCompletionHookDeps.collectDeliveryOutcome(prNumber, repoDir))
        : { prCreated: false, merged: false },
    };
  } finally {
    // Runs each cached entry's cleanup callback, which removes any disposable
    // `.static-collect-worktrees/pr-<N>-<pid>/` worktree created during head
    // resolution. Guarantees no worktree survives a normal or exceptional
    // collection exit (previously the callback was cached but never invoked).
    clearCandidateFeaturesCache();
  }
}

interface PostCompletionEnrichmentInput {
  repoDir: string;
  issueId?: string;
  branchName?: string;
  worktreePath?: string;
  agentType?: string;
  challengePairId?: string;
  /** Authoritative side from the task key; the Linear issueId cannot distinguish arms. */
  challengeSide?: 'primary' | 'challenger';
  challengeStage?: 'plan' | 'implementation' | 'review';
  originalPrompt: string;
  prDiff: string;
  record: EvalRecord;
  difficultyData: DifficultyAnalysis | null;
  taskContextData: TaskContext | null;
  repoContextData: RepoContext | null;
  costOutcome: WorkflowCostOutcome | null;
  /** Normalized external-harness execution economics (HOK-2958). */
  executionEconomics?: EvalExecutionEconomics[] | null;
  interventionRecords: InterventionRecord[];
  routingDecision?: RoutingDecision;
  routing?: EvalRouting | null;
  routePrediction?: RoutePrediction | null;
  executedPlanning?: EvalExecutedPlanning | null;
  planningExecutionOutcome?: PlanningExecutionOutcome | null;
  phaseDurations?: EvalPhaseDurations | null;
  planContent?: string;
  selfReviewSummary?: string;
}

function resolveRouteArtifactDirs(
  repoDir: string,
  branchName: string | undefined,
  worktreePath: string | undefined,
  issueId: string | undefined,
): { featureDir?: string; archiveDir?: string } {
  const slugFromBranch = branchName?.replace(/^(task|bug)\//, '');
  const slug = slugFromBranch && slugFromBranch !== branchName
    ? slugFromBranch
    : worktreePath
      ? path.basename(worktreePath)
      : '';

  return {
    ...(slug && worktreePath ? { featureDir: join(worktreePath, 'features', slug) } : {}),
    ...(issueId ? { archiveDir: resolveRouteArtifactArchiveDir(issueId, repoDir) } : {}),
  };
}

function deriveChallengeRouteContext(
  repoDir: string,
  issueId: string | undefined,
  branchName: string | undefined,
  worktreePath: string | undefined,
): ChallengeRouteContext | null {
  const { featureDir, archiveDir } = resolveRouteArtifactDirs(repoDir, branchName, worktreePath, issueId);
  const { bootstrap, expanded, active } = readRouteLifecycleArtifacts(featureDir, archiveDir);
  if (!bootstrap && !expanded) {
    return null;
  }

  const decisionSource = deriveRouteDecisionSource({ bootstrap, expanded, active }, repoDir) ?? 'bootstrap';

  return {
    decisionSource,
    ...(bootstrap ? { bootstrapRoute: bootstrap } : {}),
    ...(expanded ? { expandedRoute: expanded } : {}),
    ...(decisionSource === 'preserved'
      ? { refreshRationale: 'expanded route matches bootstrap on coder class/depth' }
      : {}),
  };
}

function deriveRouteProvenance(
  repoDir: string,
  issueId: string | undefined,
  branchName: string | undefined,
  worktreePath: string | undefined,
): EvalRouteProvenance | null {
  const { featureDir, archiveDir } = resolveRouteArtifactDirs(repoDir, branchName, worktreePath, issueId);
  return buildRouteLifecycleProvenance(readRouteLifecycleArtifacts(featureDir, archiveDir), repoDir);
}

function loadVerificationTelemetry(stateDir: string, repoDir: string): ReturnType<typeof buildVerificationTelemetryFromArtifact> | null {
  try {
    const artifactPath = join(stateDir, '.wavemill/pre-pr-verification/artifact.json');
    const { artifact } = readAndValidateArtifact(artifactPath);

    if (!artifact) {
      return null;
    }

    // Load real config to determine source (github-enforced vs explicit)
    const realConfig = getPrePrVerificationConfig(repoDir);
    const config: PrePrVerificationConfig = realConfig || {
      enabled: true,
      required: false,
      source: 'explicit',
      recipe: { commands: [] },
    };

    return buildVerificationTelemetryFromArtifact(artifact, config);
  } catch (err) {
    // Best-effort: silently ignore if artifact can't be loaded
    return null;
  }
}

export function buildTaskDescriptorForPostCompletion(
  input: Omit<PostCompletionEnrichmentInput, 'agentType' | 'challengePairId'>,
) {
  attachStageOutcomes(
    input.record,
    input.record.metadata?.stageScores as Record<string, { score: number; rationale: string }> | undefined,
  );

  const slug = input.branchName?.replace(/^(task|bug)\//, '') || input.issueId?.toLowerCase() || '';
  const routingComplete = slug
    ? fetchRoutingCompleteRawWithArchive(input.repoDir, slug, input.issueId || '', input.worktreePath)
    : null;
  const workflowCost = input.costOutcome?.status === 'success'
    ? input.costOutcome.totalCostUsd
    : input.record.workflowCost;
  const workflowTokenUsage = input.costOutcome?.status === 'success'
    ? input.costOutcome.models
    : input.record.workflowTokenUsage;
  const maxCostUsd = resolvePostCompletionBudget(input);

  return buildTaskDescriptor({
    originalPrompt: input.originalPrompt,
    prDiff: input.prDiff,
    taskContext: input.taskContextData || undefined,
    repoContext: input.repoContextData || undefined,
    difficultySignals: input.difficultyData?.difficultySignals || undefined,
    routingDecision: input.routingDecision || undefined,
    routingComplete: routingComplete || undefined,
    stageOutcomes: input.record.stageOutcomes || undefined,
    workflowCost: workflowCost || undefined,
    workflowTokenUsage: workflowTokenUsage || undefined,
    score: input.record.score || undefined,
    timeSeconds: input.record.timeSeconds || undefined,
    interventionCount: input.record.interventionCount || undefined,
    interventions: input.interventionRecords || undefined,
    rubricEval: input.record.rubricEval || undefined,
    modelsAvailable: getConfiguredModelsForDescriptor(input.repoDir),
    objective: 'balanced',
    maxCostUsd,
  });
}

export function enrichPostCompletionRecord(
  record: EvalRecord,
  input: PostCompletionEnrichmentInput,
): void {
  let taskDescriptor = null;
  try {
    taskDescriptor = buildTaskDescriptorForPostCompletion(input);
  } catch (err) {
    const errorMsg = errorMessage(err);
    console.warn(`Post-completion eval: failed to build task descriptor — ${errorMsg}`);
  }
  const challengeSide = resolveChallengeSide({
    repoDir: input.repoDir,
    branchName: input.branchName,
    issueId: input.issueId,
    challengePairId: input.challengePairId,
    explicitSide: input.challengeSide,
  });
  const challengeIntent = loadPostCompletionChallengeIntent(input);
  const verificationTelemetry = loadVerificationTelemetry(input.worktreePath || input.repoDir, input.repoDir);
  let evaluatedPrHeadSha: string | undefined;
  const prIdentity = record.prUrl;
  if (prIdentity) {
    try {
      evaluatedPrHeadSha = resolvePrIdentityMetadata(prIdentity, input.repoDir).head_sha;
    } catch (error) {
      // Verification telemetry is still immutable evidence when live GitHub
      // metadata is unavailable at persistence time.
      evaluatedPrHeadSha = verificationTelemetry?.checked_shas?.head;
      console.warn(`Post-completion eval: could not resolve evaluated PR head — ${errorMessage(error)}`);
    }
  }

  // Load task scorer result artifact (HOK-2845) — best effort
  let taskScorerResult = null;
  try {
    const { featureDir } = resolveRouteArtifactDirs(input.repoDir, input.branchName, input.worktreePath, input.issueId);
    if (featureDir) {
      const scorerPath = join(featureDir, '.task-scorer-result.json');
      if (existsSync(scorerPath)) {
        const raw = JSON.parse(readFileSync(scorerPath, 'utf-8'));
        if (raw && typeof raw.decision === 'string' && typeof raw.confidence === 'number') {
          taskScorerResult = raw;
        }
      }
    }
  } catch {
    // Scorer result unavailable — not an error
  }

  enrichTrainingMetadata(record, {
    agentType: input.agentType,
    provider: getDeepSeekProviderMetadata(record.modelId, input.repoDir)?.provider,
    endpoint: getDeepSeekProviderMetadata(record.modelId, input.repoDir)?.endpoint,
    taskScorerResult,
    challengePairId: input.challengePairId,
    challengeSide: challengeSide.side,
    evaluatedPrHeadSha,
    challengeIntent,
    challengeStageEval: buildChallengeStageEval({
      repoDir: input.repoDir,
      issueId: input.issueId,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
      challengeStage: input.challengeStage,
      record,
      stageArtifacts: {
        planContent: input.planContent,
        selfReviewSummary: input.selfReviewSummary,
        routingDecision: input.routingDecision,
        routing: input.routing || undefined,
        routePrediction: input.routePrediction || undefined,
        executedPlanning: input.executedPlanning || undefined,
        planningExecutionOutcome: input.planningExecutionOutcome || undefined,
        phaseDurations: input.phaseDurations || undefined,
      },
    }),
    // Local executed review identity for this arm, when a `.review-result.json`
    // carries a valid envelope (HOK-2969, Arbiter P2.4f). Additive: undefined
    // for runs without a native review identity to report.
    reviewExecutedIdentity: extractReviewExecutedIdentity({
      repoDir: input.repoDir,
      issueId: input.issueId,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
    }),
    routeProvenance: deriveRouteProvenance(
      input.repoDir,
      input.issueId,
      input.branchName,
      input.worktreePath,
    ),
    executedPlanning: input.executedPlanning,
    planningExecutionOutcome: input.planningExecutionOutcome,
    verificationTelemetry,
    phaseDurations: input.phaseDurations,
    routePrediction: input.routePrediction,
    routing: input.routing,
    challengeRouteContext: input.challengePairId
      ? deriveChallengeRouteContext(input.repoDir, input.issueId, input.branchName, input.worktreePath)
      : null,
    difficulty: input.difficultyData,
    taskContext: input.taskContextData,
    repoContext: input.repoContextData,
    workflowCost: input.costOutcome,
    executionEconomics: input.executionEconomics,
    taskDescriptor,
    constraints: (() => {
      const maxCostUsd = resolvePostCompletionBudget(input);
      return typeof maxCostUsd === 'number' ? { maxCostUsd } : undefined;
    })(),
  });
  const attestation = attestEvalRecordChallengeExecution(record);
  attachChallengeExecutionMetadata(record, {
    side: record.challengeSide,
    intent: record.challengeIntent,
    evidence: attestation,
  });
  if (challengeSide.invalidReason) {
    record.challengeDivergenceReason = challengeSide.invalidReason;
    record.invalidChallenge = true;
    record.trainingEligible = false;
    record.nonRewardReason = {
      code: 'INVALID_CHALLENGE',
      message: `Invalid challenge: ${challengeSide.invalidReason}`,
    };
  }
  // Same fail-closed rule the eval orchestrator applies: a challenge
  // participant with no intent cannot be attested, so it must not pass as
  // training-eligible evidence just because the attestation was silent.
  if (enforceChallengeIntentPresence(record, input.challengePairId)) {
    console.warn(
      `Warning: challenge record for ${input.issueId} (pair ${input.challengePairId}) has no persisted intent; marking invalid rather than training-eligible.`,
    );
  }
}

/**
 * Run the post-completion eval hook.
 *
 * Callers are responsible for gating on autoEval before invoking this function
 * (e.g. the mill script checks AUTO_EVAL, the workflow command calls explicitly).
 *
 * - Gathers context (issue details, PR diff).
 * - Invokes the LLM judge via evaluateTask().
 * - Persists the result via appendEvalRecord() from eval-persistence.
 * - Never throws: all errors are caught and logged as warnings.
 * - Returns true only after the eval record has been persisted.
 */
export async function runPostCompletionEval(ctx: PostCompletionContext): Promise<boolean> {
  const repoDir = ctx.repoDir || process.cwd();
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';
  let persisted = false;

  // Always log that we entered this function (for debugging)
  console.log('Post-completion eval: DEBUG_COST=' + (debug ? 'enabled' : 'disabled'));

  // Log received context for diagnostics
  if (debug) {
    console.log('[DEBUG_COST] ========================================');
    console.log('[DEBUG_COST] runPostCompletionEval() called with context:');
    console.log(`[DEBUG_COST]   issueId: ${ctx.issueId || '(undefined)'}`);
    console.log(`[DEBUG_COST]   prNumber: ${ctx.prNumber || '(undefined)'}`);
    console.log(`[DEBUG_COST]   prUrl: ${ctx.prUrl || '(undefined)'}`);
    console.log(`[DEBUG_COST]   workflowType: ${ctx.workflowType}`);
    console.log(`[DEBUG_COST]   repoDir: ${repoDir}`);
    console.log(`[DEBUG_COST]   branchName: ${ctx.branchName || '(undefined)'}`);
    console.log(`[DEBUG_COST]   worktreePath: ${ctx.worktreePath || '(undefined)'}`);
    console.log(`[DEBUG_COST]   agentType: ${ctx.agentType || '(undefined)'}`);
    console.log(`[DEBUG_COST]   challengeStage: ${ctx.challengeStage || '(undefined)'}`);
    console.log('[DEBUG_COST] ========================================');
  }

  if (!ctx.issueId && !ctx.prNumber) {
    console.warn('Post-completion eval: skipped (no issue ID or PR number provided)');
    return false;
  }

  try {
    console.log('Post-completion eval: gathering context...');

    // 1. Gather eval context (issue + PR data)
    const evalContext = postCompletionHookDeps.gatherEvalContext({
      issueId: ctx.issueId,
      prNumber: ctx.prNumber,
      prUrl: ctx.prUrl,
      repoDir,
    });

    // 2. Gather stage artifacts for judge attribution
    let branchName = ctx.branchName || '';
    if (!branchName) {
      try {
        branchName = execShellCommand('git branch --show-current', {
          encoding: 'utf-8', cwd: repoDir,
        }).trim();
      } catch { /* best-effort */ }
    }

    const stageArtifacts = postCompletionHookDeps.gatherStageArtifacts(
      repoDir,
      ctx.issueId || '',
      branchName,
      ctx.worktreePath
    );
    const phaseDurations = stageArtifacts.phaseDurations;
    const timeSeconds =
      typeof phaseDurations?.total === 'number'
      && Number.isFinite(phaseDurations.total)
      && phaseDurations.total >= 0
        ? phaseDurations.total
        : null;

    // 3. Detect all interventions
    console.log('Post-completion eval: detecting interventions...');

    const interventionData = postCompletionHookDeps.detectAndFormatInterventions({
      prNumber: ctx.prNumber,
      branchName,
      baseBranch: 'main',
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
      issueId: ctx.issueId,
    });

    console.log(`Post-completion eval: ${formatInterventionDisplay(interventionData.totalCount)}`);

    // 3. Run independent analyses in parallel (non-blocking, failures logged as warnings)
    const { difficultyData, repoContextData, taskContextData } = await postCompletionHookDeps.runEvalAnalysis({
      prDiff: evalContext.prDiff,
      prNumber: ctx.prNumber,
      repoDir,
      issueData: evalContext.issueData,
      logPrefix: 'Post-completion eval: ',
      formatters: {
        difficulty: formatDifficultyDisplay,
        repoContext: formatRepoContextDisplay,
        taskContext: formatTaskContextDisplay,
      },
    });

    const outcomes = collectPostCompletionOutcomes({
      prNumber: ctx.prNumber,
      branchName,
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
      issueId: ctx.issueId,
      interventionSummary: interventionData.summary,
    });

    // 4. Run eval judge
    console.log('Post-completion eval: invoking LLM judge...');
    const evalInput = {
      taskPrompt: evalContext.taskPrompt,
      prReviewOutput: evalContext.prDiff,
      interventions: interventionData.meta,
      interventionRecords: interventionData.records,
      interventionText: interventionData.text,
      issueId: ctx.issueId || undefined,
      prUrl: evalContext.prUrl || undefined,
      timeSeconds,
      metadata: { workflowType: ctx.workflowType, hookTriggered: true, interventionSummary: interventionData.summary },
      taskPacket: stageArtifacts.taskPacket,
      planContent: stageArtifacts.planContent,
      selfReviewSummary: stageArtifacts.selfReviewSummary,
      routingDecision: stageArtifacts.routingDecision,
    };
    const record = ctx.prNumber && evalContext.prDiffAvailability?.available === false
      ? await postCompletionHookDeps.buildUnscoredEvalRecord(
          {
            ...evalInput,
            metadata: {
              ...evalInput.metadata,
              prDiffUnavailable: {
                reason: evalContext.prDiffAvailability.reason,
                detail: evalContext.prDiffAvailability.detail,
                attempts: evalContext.prDiffAvailability.attempts,
              },
            },
          },
          {
            failureReason: 'pr_diff_unavailable',
            rationale: `PR diff could not be retrieved (${evalContext.prDiffAvailability.reason}): ${evalContext.prDiffAvailability.detail}. Judge not invoked.`,
            nonRewardReason: {
              code: 'pr_diff_unavailable',
              message: `PR diff could not be retrieved: ${evalContext.prDiffAvailability.reason}`,
            },
          },
          outcomes,
        )
      : await postCompletionHookDeps.evaluateTask(evalInput, outcomes);

    const executionModel = ctx.solutionModel || stageArtifacts.executionModel;
    if (executionModel) {
      record.modelId = executionModel;
      record.modelVersion = executionModel;
    }
    if (record.outcomes) {
      record.outcomes.success = finalizeEvalSuccess(record, { repoDir });
    }
    attachPhaseDurations(record, phaseDurations);

    // 5. Compute workflow cost
    let costOutcome: ReturnType<typeof computeWorkflowCost> | null = null;
    let executionEconomics: EvalExecutionEconomics[] | null = null;
    if (ctx.worktreePath && branchName) {
      console.log('Post-completion eval: computing workflow cost...');

      if (debug) {
        console.log('[DEBUG_COST] Cost computation parameters:');
        console.log(`[DEBUG_COST]   worktreePath: ${ctx.worktreePath}`);
        console.log(`[DEBUG_COST]   branchName: ${branchName}`);
        console.log(`[DEBUG_COST]   agentType: ${ctx.agentType || 'claude'}`);
      }

      try {
        const wavemillConfigDir = resolve(__dirname, '../..');
        const pricingTable = loadPricingTable(wavemillConfigDir);

        if (debug) {
          console.log(`[DEBUG_COST]   Loaded pricing for ${Object.keys(pricingTable).length} model(s)`);
        }

        costOutcome = computeWorkflowCost({
          worktreePath: ctx.worktreePath,
          branchName,
          repoDir,
          issueId: ctx.issueId,
          pricingTable,
          agentType: ctx.agentType,
        });

        if (costOutcome.status === 'success') {
          const coverage = costOutcome.attribution
            ? `, coverage ${costOutcome.attribution.coverage}`
            : '';
          console.log(
            `Post-completion eval: workflow cost $${costOutcome.totalCostUsd.toFixed(4)} ` +
            `(${costOutcome.turnCount} turns across ${costOutcome.sessionCount} session(s)${coverage})`
          );
        } else {
          console.warn(
            `Post-completion eval: workflow cost computation failed (${costOutcome.status}) — ${costOutcome.reason}`
          );
          if (!debug) {
            console.log('Post-completion eval: run with DEBUG_COST=1 for detailed diagnostics');
          }
        }
        // Normalized execution-economics collection (HOK-2958): fail-soft,
        // observation-only — never influences routing or the workflow.
        try {
          executionEconomics = await postCompletionHookDeps.collectExecutionEconomics({
            worktreePath: ctx.worktreePath,
            branchName,
            repoDir,
            issueId: ctx.issueId,
            routing: stageArtifacts.routing ?? null,
            stageResultsDir: stageArtifacts.stageResultsDir ?? null,
            pricingTable,
          });
          if (executionEconomics.length > 0) {
            const summary = executionEconomics
              .map((block) => `${block.harness}: ${block.sessionCount} session(s), ${block.turnCount} turn(s), coverage ${block.coverage}`)
              .join('; ');
            console.log(`Post-completion eval: execution economics — ${summary}`);
          }
        } catch (economicsErr: unknown) {
          console.warn(`Post-completion eval: execution economics collection failed — ${errorMessage(economicsErr)}`);
        }
      } catch (costErr: unknown) {
        const costMsg = errorMessage(costErr);
        console.warn(`Post-completion eval: workflow cost computation failed — ${costMsg}`);
      }
    } else {
      // Create skipped outcome with diagnostics
      const missingParams = [];
      if (!ctx.worktreePath) missingParams.push('worktreePath');
      if (!branchName) missingParams.push('branchName');

      costOutcome = {
        status: 'skipped',
        reason: `Required parameters missing: ${missingParams.join(', ')}`,
        diagnostics: {
          worktreePath: ctx.worktreePath,
          branchName,
          agentType: ctx.agentType || 'claude',
        },
      };

      if (debug) {
        console.log('[DEBUG_COST] Skipping cost computation - missing: ' + missingParams.join(', '));
      }
      console.log('Post-completion eval: skipping workflow cost (missing worktreePath or branchName)');
    }

    // 6. Enrich record with all metadata
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: ctx.issueId,
      branchName,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
      challengePairId: ctx.challengePairId,
      challengeSide: ctx.challengeSide,
      challengeStage: ctx.challengeStage,
      originalPrompt: evalContext.taskPrompt,
      prDiff: evalContext.prDiff,
      record,
      difficultyData,
      taskContextData,
      repoContextData,
      costOutcome,
      executionEconomics,
      interventionRecords: interventionData.records,
      routingDecision: stageArtifacts.routingDecision,
      routing: stageArtifacts.routing,
      routePrediction: stageArtifacts.routePrediction,
      executedPlanning: stageArtifacts.executedPlanning,
      planningExecutionOutcome: stageArtifacts.planningExecutionOutcome,
      phaseDurations,
      planContent: stageArtifacts.planContent,
      selfReviewSummary: stageArtifacts.selfReviewSummary,
    });

    if (record.challengeStageEval) {
      console.log(
        `Post-completion eval: challenge stage evidence stage=${record.challengeStageEval.stage} provenance=${record.challengeStageEval.provenance}`
      );
    }

    // 7. Persist
    const { dir: evalsDir } = resolveEvalsDir(undefined, repoDir);
    postCompletionHookDeps.appendEvalRecord(record, { dir: evalsDir, repoDir });
    persisted = true;
    ctx.onPersisted?.();

    // 8. Enqueue Hokusai contribution before optional post-eval work.
    await triggerHokusaiSubmissionAfterPersistence(record, repoDir);

    // 9. Run retention replay before mutating project context/subsystem memory.
    const retentionReport = await postCompletionHookDeps.runHarnessRetentionReplay(repoDir);
    if (retentionReport) {
      console.log(
        `Post-completion eval: harness retention ${retentionReport.verdict} ` +
        `(D=${retentionReport.D}, tolerance=${retentionReport.tolerance}, mode=${retentionReport.mode})`
      );
      if (retentionReport.reportPath) {
        console.log(`Post-completion eval: harness retention report ${retentionReport.reportPath}`);
      }
      if (retentionReport.mode === 'enforce' && retentionReport.verdict !== 'pass') {
        console.warn('Post-completion eval: context updates skipped because harness retention replay failed');
        printEvalSummary(record);
        return true;
      }
    }

    // 10. Run bounded best-effort project context and subsystem updates
    await runPostEvalContextUpdates(ctx, record, evalContext.prDiff, evalContext.taskPrompt);

    // 11. Print summary
    printEvalSummary(record);
    return true;
  } catch (error: unknown) {
    let message = errorMessage(error);
    if (isJudgeResponseRecoveryError(error)) {
      try {
        const artifactPath = persistJudgeFailureArtifact(repoDir, ctx.issueId, error);
        message = `${message}; raw judge output saved to ${artifactPath}`;
      } catch (artifactError) {
        message = `${message}; also failed to persist judge artifact (${errorMessage(artifactError)})`;
      }
    }
    console.warn(`Post-completion eval: failed (workflow unaffected) — ${message}`);
    return persisted;
  }
}

function makeContextUpdateTimeoutError(timeoutMs: number): Error {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const error = new Error(`post-eval context updates timed out after ${seconds}s`);
  error.name = 'TimeoutError';
  return error;
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === 'TimeoutError' || /timed out/i.test(err.message);
}

function buildContextUpdateWarningRecord(
  ctx: PostCompletionContext,
  record: EvalRecord,
  outcome: ContextUpdateOutcome,
): ContextUpdateWarningRecord | null {
  if (!outcome.reason) {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    evalId: record.id,
    issueId: ctx.issueId,
    reason: outcome.reason,
    operatingMode: outcome.operatingMode,
    durationMs: outcome.durationMs,
    retryCount: outcome.retryCount,
    ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
  };
}

export async function appendContextUpdateWarning(
  repoDir: string,
  warning: ContextUpdateWarningRecord,
): Promise<void> {
  try {
    const { dir: evalsDir } = resolveEvalsDir(undefined, repoDir);
    mkdirSync(evalsDir, { recursive: true });
    appendFileSync(join(evalsDir, 'eval-context-update-warnings.jsonl'), `${JSON.stringify(warning)}\n`, 'utf-8');
  } catch (err) {
    console.warn(`Post-completion eval: failed to persist context update warning - ${errorMessage(err)}`);
  }
}

export async function runPostEvalContextUpdates(
  ctx: PostCompletionContext,
  record: EvalRecord,
  prDiff: string,
  issueContext: string,
): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();
  const operatingMode = postCompletionHookDeps.getCurrentOperatingMode(repoDir);
  const config = postCompletionHookDeps.getEvalContextUpdatesConfig(repoDir);
  const executionOptions: ContextUpdateExecutionOptions = {
    timeoutMs: config.timeoutSeconds * 1000,
    maxRetries: config.maxRetries,
  };

  let outcome: ContextUpdateOutcome | null = null;

  if (process.env.WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES === '1') {
    outcome = {
      ran: false,
      reason: 'skipped-env',
      durationMs: 0,
      retryCount: 0,
      operatingMode,
    };
  } else if (config.enabled === false) {
    outcome = {
      ran: false,
      reason: 'skipped-config',
      durationMs: 0,
      retryCount: 0,
      operatingMode,
    };
  } else if (operatingMode === 'constrained' || operatingMode === 'survival') {
    outcome = {
      ran: false,
      reason: 'skipped-operating-mode',
      durationMs: 0,
      retryCount: 0,
      operatingMode,
    };
  } else {
    const startedAt = Date.now();
    const attempts = executionOptions.maxRetries + 1;
    let attempt = 0;

    while (attempt < attempts) {
      attempt += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(makeContextUpdateTimeoutError(executionOptions.timeoutMs)),
        executionOptions.timeoutMs,
      );
      try {
        await postCompletionHookDeps.runContextUpdateWork(ctx, prDiff, issueContext, {
          ...executionOptions,
          signal: controller.signal,
        });
        outcome = {
          ran: true,
          durationMs: Date.now() - startedAt,
          retryCount: attempt - 1,
          operatingMode,
        };
        break;
      } catch (err) {
        const timeoutReason = controller.signal.reason;
        const timedOut = controller.signal.aborted || isTimeoutError(err) || isTimeoutError(timeoutReason);
        if (attempt >= attempts) {
          outcome = {
            ran: true,
            reason: timedOut ? 'timeout' : 'error',
            durationMs: Date.now() - startedAt,
            retryCount: attempt - 1,
            errorMessage: errorMessage(timedOut && timeoutReason ? timeoutReason : err),
            operatingMode,
          };
          break;
        }
        console.warn(
          `Post-completion eval: context update attempt ${attempt}/${attempts} failed - ${errorMessage(err)}`
        );
      } finally {
        clearTimeout(timeoutId);
        controller.abort();
      }
    }
  }

  if (!outcome || !outcome.reason) {
    return;
  }

  const warning = buildContextUpdateWarningRecord(ctx, record, outcome);
  if (warning) {
    await postCompletionHookDeps.appendContextUpdateWarning(repoDir, warning);
  }

  const details = outcome.errorMessage ? ` - ${outcome.errorMessage}` : '';
  console.warn(`Post-completion eval: context updates ${outcome.reason}${details}`);
}

/**
 * Update project context after PR merge.
 *
 * Analyzes the PR diff and generates a summary to append to project-context.md.
 */
async function updateProjectContext(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string,
  executionOptions: ContextUpdateExecutionOptions,
): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();
  const contextPath = join(repoDir, '.wavemill', 'project-context.md');

  // Skip if project-context.md doesn't exist (not initialized)
  if (!existsSync(contextPath)) {
    console.log('Project context: skipped (not initialized — run init-project-context.ts)');
    return;
  }

  console.log('Project context: generating update...');

  // Generate summary using Claude CLI
  const summary = await generateContextUpdate({
    issueId: ctx.issueId || 'Unknown',
    prUrl: ctx.prUrl || '',
    prDiff,
    issueContext,
    timeoutMs: executionOptions.timeoutMs,
    maxRetries: 0,
    signal: executionOptions.signal,
  });

  // Append to project-context.md
  appendContextUpdate(contextPath, summary);

  console.log('Project context: updated successfully');

  // Update subsystem specs (cold memory)
  await updateSubsystemSpecs(ctx, prDiff, issueContext, repoDir, executionOptions);

  const lintResults = await lintSubsystemSpecs(repoDir, {
    rules: ['orphaned-spec', 'missing-spec'],
  });
  if (lintResults.length > 0) {
    console.log('\nSpec lint results:');
    console.log(formatLintResults(lintResults));
  }
}

/**
 * Update subsystem specs after PR merge.
 *
 * Detects affected subsystems and updates their specifications.
 * Non-blocking: failures log warnings but don't fail the workflow.
 */
async function updateSubsystemSpecs(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string,
  repoDir: string,
  executionOptions: ContextUpdateExecutionOptions,
): Promise<void> {
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Skip if context directory doesn't exist
  if (!existsSync(contextDir)) {
    console.log('Subsystem update: skipped (no subsystem specs found)');
    return;
  }

  // Detect subsystems
  console.log('Subsystem update: detecting subsystems...');
  const subsystems = detectSubsystems(repoDir, {
    minFiles: 3,
    useGitAnalysis: false, // Skip git analysis for speed
    maxSubsystems: 20,
  });

  if (subsystems.length === 0) {
    console.log('Subsystem update: no subsystems detected');
    return;
  }

  // Extract issue title from context
  const titleMatch = issueContext.match(/^#\s*[A-Z]+-\d+:\s*(.+)$/m);
  const issueTitle = titleMatch ? titleMatch[1] : 'Unknown';

  // Detect affected subsystems before updating
  const affectedSubsystems = detectAffectedSubsystems(prDiff, subsystems, repoDir);

  // Knowledge gap detection: warn if PR has significant changes but no subsystems matched
  if (affectedSubsystems.length === 0) {
    const prSize = prDiff.split('\n').length;
    if (prSize > 100) {
      console.log('');
      console.log('⚠️  KNOWLEDGE GAP: No subsystem specs matched this PR');
      console.log(`   PR has ${prSize} lines of changes, but no subsystem docs were updated`);
      console.log('   This may indicate:');
      console.log('   - New subsystem(s) introduced in this PR');
      console.log('   - Subsystem specs are incomplete or missing');
      console.log('');
      console.log('   Recommendation: Run the following to create/update subsystem docs:');
      console.log('     wavemill context init --force');
      console.log('');
      console.log('   This enables "persistent downstream acceleration" for future tasks');
      console.log('   (per Codified Context paper, Case Study 3)');
      console.log('');
    }
  }

  // Update affected subsystems
  await updateAffectedSubsystems(subsystems, {
    issueId: ctx.issueId || 'Unknown',
    issueTitle,
    prUrl: ctx.prUrl || '',
    prDiff,
    issueDescription: issueContext,
    repoDir,
  }, {
    timeoutMs: executionOptions.timeoutMs,
    maxRetries: 0,
    signal: executionOptions.signal,
  });
}

/**
 * Generate a context update summary from PR diff using Claude CLI.
 */
async function generateContextUpdate(opts: {
  issueId: string;
  prUrl: string;
  prDiff: string;
  issueContext: string;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const promptPath = resolve(__dirname, '../../tools/prompts/context-update-template.md');
  const promptTemplate = readFileSync(promptPath, 'utf-8');

  // Extract issue title from context
  const titleMatch = opts.issueContext.match(/^#\s*[A-Z]+-\d+:\s*(.+)$/m);
  const issueTitle = titleMatch ? titleMatch[1] : 'Unknown';

  // Fill in template placeholders
  const timestamp = new Date().toISOString();
  const prompt = promptTemplate
    .replace('{TIMESTAMP}', timestamp)
    .replace('{ISSUE_ID}', opts.issueId)
    .replace('{ISSUE_TITLE}', issueTitle)
    .replace('{PR_URL}', opts.prUrl)
    .replace('{ISSUE_DESCRIPTION}', opts.issueContext)
    .replace('{PR_DIFF}', opts.prDiff.substring(0, 50000)); // Limit diff size

  const result = await callHeadlessLLM(prompt, {
    mode: 'stream',
    taskType: 'classify',
    timeout: opts.timeoutMs ?? 300_000,
    activityTimeout: opts.timeoutMs ?? 60_000,
    retry: (opts.maxRetries ?? 1) > 0,
    maxRetries: opts.maxRetries ?? 1,
    signal: opts.signal,
    noTools: true,
    systemInstruction:
      'You have NO tools available. Output ONLY the markdown summary in the exact format specified. No conversational text, no preamble, no XML tags. Start directly with the heading.',
  });

  return result.text;
}

/**
 * Append a context update to project-context.md.
 */
function appendContextUpdate(contextPath: string, summary: string): void {
  const update = `\n\n${summary}\n\n---`;
  appendFileSync(contextPath, update, 'utf-8');
}
