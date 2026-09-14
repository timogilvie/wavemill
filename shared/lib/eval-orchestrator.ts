/**
 * Eval Orchestrator
 *
 * Orchestrates complete workflow evaluation:
 * 1. Context gathering (issue, PR, auto-detection)
 * 2. Intervention detection
 * 3. Difficulty/task/repo analysis
 * 4. Outcome collection
 * 5. LLM judging
 * 6. Record enrichment
 * 7. Persistence
 *
 * @module eval-orchestrator
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { errorMessage } from './error-utils.ts';
import { finalizeEvalSuccess } from './eval-success-policy.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { getDeepSeekProviderMetadata } from './deepseek-provider.ts';
import { getNativeProviderMetadata } from './session-adapters.ts';
import {
  autoDetectContext,
  resolveContextGaps,
  computeWallClockSeconds,
  gatherEvalContext,
  gatherStageArtifacts,
  fetchRoutingCompleteRawWithArchive,
} from './eval-context-gatherer.ts';
import { buildRouteLifecycleProvenance, readRouteLifecycleArtifacts } from './route-artifact.ts';
import { resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  toInterventionRecords,
  formatForJudge,
  loadPenalties,
} from './intervention-detector.ts';
import { runEvalAnalysis } from './eval-analysis.ts';
import {
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
} from './outcome-collectors.ts';
import { buildUnscoredEvalRecord, evaluateTask } from './eval.ts';
import {
  attachChallengeExecutionMetadata,
  attachPhaseDurations,
  attachStageOutcomes,
  attachTraceId,
  enrichTrainingMetadata,
} from './eval-record-builder.ts';
import { loadFeatureOutcomeDiagnostics } from './feature-outcome-consumer.ts';
import { loadTraceContext, appendTraceEvent } from './trace-event.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { resolvePrIdentityMetadata } from './pr-comparison.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import {
  attestEvalRecordChallengeExecution,
  enforceChallengeIntentPresence,
  loadChallengeIntentFromFeatureDir,
  loadChallengeIntentFromState,
  resolveChallengeSide,
  type ChallengeExecutionIntent,
} from './challenge-execution-contract.ts';
import { getMaxCostUsd } from './config.ts';
import { formatHokusaiSubmissionTriggerResult, triggerHokusaiSubmission } from './hokusai-submission-trigger.ts';
import { getConfiguredModelsForDescriptor } from './model-registry.ts';
import { computeWorkflowCostWithExactPricing, loadPricingTable, type WorkflowCostOutcome } from './workflow-cost.ts';
import { collectExecutionEconomics } from './execution-economics.ts';
import type {
  EvalRecord,
  EvalRouteProvenance,
  Outcomes,
  EvalConstraints,
  PlanCritique,
} from './eval-schema.ts';
import type { RoutingCompleteData } from './eval-context-gatherer.ts';

export const evalOrchestratorDeps = {
  autoDetectContext,
  resolveContextGaps,
  computeWallClockSeconds,
  gatherEvalContext,
  gatherStageArtifacts,
  detectAllInterventions,
  toInterventionMeta,
  toInterventionRecords,
  formatForJudge,
  loadPenalties,
  runEvalAnalysis,
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
  evaluateTask,
  buildUnscoredEvalRecord,
  buildTaskDescriptor,
  appendEvalRecord,
  triggerHokusaiSubmission,
  computeWorkflowCost: computeWorkflowCostWithExactPricing,
  collectExecutionEconomics,
  loadPricingTable,
  execShellCommand,
};

function resolveEvalConstraints(
  routingComplete: RoutingCompleteData | null,
  repoDir: string,
): EvalConstraints | undefined {
  const candidates = [
    routingComplete?.maxCostUsd,
    routingComplete?.constraints?.maxCostUsd,
    getMaxCostUsd(repoDir),
  ];
  const maxCostUsd = candidates.find((value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ));
  return typeof maxCostUsd === 'number' ? { maxCostUsd } : undefined;
}

function resolveExecutionModel(solutionModel: string | undefined, routingDecision: unknown): string | undefined {
  if (solutionModel) {
    return solutionModel;
  }

  const chosen = (routingDecision as { chosen?: { modelId?: string } | number; candidates?: Array<{ modelId?: string }> } | undefined)?.chosen;
  if (typeof chosen === 'object' && chosen?.modelId) {
    return chosen.modelId;
  }
  if (typeof chosen === 'number') {
    return (routingDecision as { candidates?: Array<{ modelId?: string }> } | undefined)?.candidates?.[chosen]?.modelId;
  }

  return undefined;
}

function resolveExecutionModelWithArtifacts(
  solutionModel: string | undefined,
  routingDecision: unknown,
  stageExecutionModel: string | undefined,
): string | undefined {
  return resolveExecutionModel(solutionModel, routingDecision) ?? stageExecutionModel;
}

function deriveRouteProvenance(
  repoDir: string,
  branch: string,
  issueId: string,
  worktreePath?: string,
): EvalRouteProvenance | null {
  const slug = branch.replace(/^(task|bug)\//, '') || issueId.toLowerCase();
  if (!slug && !issueId) {
    return null;
  }

  const featureDir = slug && worktreePath
    ? path.join(worktreePath, 'features', slug)
    : undefined;
  const archiveDir = resolveRouteArtifactArchiveDir(issueId, repoDir);

  return buildRouteLifecycleProvenance(
    readRouteLifecycleArtifacts(featureDir, archiveDir),
    repoDir,
  );
}

function deriveChallengeFeatureDir(worktreePath: string | undefined, slug: string): string | undefined {
  if (!worktreePath || !slug) return undefined;
  for (const dir of ['features', 'bugs']) {
    const featureDir = path.join(worktreePath, dir, slug);
    try {
      return featureDir;
    } catch {
      continue;
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Options for running evaluation.
 */
export interface EvalOptions {
  /** Linear issue ID (optional, auto-detected if not provided) */
  issueId?: string;
  /** GitHub PR number (optional, auto-detected if not provided) */
  prNumber?: string;
  /** PR URL (optional) */
  prUrl?: string;
  /** Repository directory */
  repoDir: string;
  /** Agent type (claude, codex, etc.) */
  agentType?: string;
  /** Solution model used by the agent */
  solutionModel?: string;
  /** Routing decision metadata (optional) */
  routingDecision?: any;
  /** Override eval model (optional) */
  evalModel?: string;
  /** Shared challenge pair identifier */
  challengePairId?: string;
  /** Worktree path (optional, for artifact discovery) */
  worktreePath?: string;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Run complete evaluation workflow.
 *
 * Orchestrates:
 * - Context gathering (auto-detect or explicit)
 * - Intervention detection
 * - Difficulty/task/repo analysis
 * - Outcome collection (CI, tests, review, rework, delivery)
 * - LLM judging
 * - Record enrichment
 * - Persistence to eval store
 *
 * @param options - Evaluation options
 * @returns Complete eval record
 *
 * @example
 * ```typescript
 * const record = await runEvaluation({
 *   issueId: 'HOK-123',
 *   prNumber: '456',
 *   repoDir: process.cwd(),
 *   agentType: 'claude',
 * });
 * console.log(`Score: ${record.score}`);
 * ```
 */
export async function runEvaluation(options: EvalOptions): Promise<EvalRecord> {
  const {
    issueId: explicitIssueId,
    prNumber: explicitPrNumber,
    prUrl: explicitPrUrl,
    repoDir,
    agentType = 'claude',
    solutionModel,
    routingDecision,
    evalModel,
    challengePairId: explicitChallengePairId,
    worktreePath: explicitWorktreePath,
  } = options;

  // 1. Gather context (auto-detect or explicit)
  console.log('Gathering workflow context...');

  let issueId = explicitIssueId || '';
  let prNumber = explicitPrNumber || '';
  let branch = '';
  let prUrl = explicitPrUrl || '';

  // Auto-detect if not explicitly provided
  let challengePairId = explicitChallengePairId;
  let worktreePath = explicitWorktreePath;
  if (!issueId && !prNumber) {
    const detected = evalOrchestratorDeps.autoDetectContext(repoDir);
    issueId = detected.issueId;
    prNumber = detected.prNumber;
    branch = detected.branch;
    prUrl = detected.prUrl;
  } else {
    // Explicit issue/PR still needs branch, prUrl, worktree and challenge
    // identity resolved — eligibility and challenge pairing depend on them.
    const gaps = evalOrchestratorDeps.resolveContextGaps({ repoDir, issueId, prNumber });
    branch = branch || gaps.branch;
    prUrl = prUrl || gaps.prUrl;
    challengePairId = challengePairId || gaps.challengePairId || undefined;
    worktreePath = worktreePath || gaps.worktree || undefined;
  }

  const evalContext = evalOrchestratorDeps.gatherEvalContext({
    issueId,
    prNumber,
    prUrl,
    repoDir,
  });

  // Gather stage artifacts for judge attribution (search worktree first if provided)
  const stageArtifacts = evalOrchestratorDeps.gatherStageArtifacts(repoDir, issueId, branch, worktreePath);
  const phaseDurations = stageArtifacts.phaseDurations;

  if (issueId) console.log(`  Issue: ${issueId}`);
  if (prNumber) console.log(`  PR: #${prNumber}`);
  if (evalContext.prDiff) {
    const lines = evalContext.prDiff.split('\n').length;
    console.log(`  Diff: ${lines} lines`);
  }

  // 2. Apply model override if specified
  if (evalModel) {
    process.env.EVAL_MODEL = evalModel;
  }

  // 3. Detect intervention events
  console.log('\nDetecting intervention events...');

  // Ensure we have branch name for intervention detection
  if (!branch) {
    try {
      branch = evalOrchestratorDeps.execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();
    } catch {
      // Best-effort
    }
  }

  const wallClockSeconds: number | null =
    phaseDurations?.total && phaseDurations.total > 0
      ? phaseDurations.total
      : branch
        ? evalOrchestratorDeps.computeWallClockSeconds(repoDir, branch)
        : null;

  const runInterventionAnalysis = () =>
    Promise.resolve().then(() => {
      const interventionSummary = evalOrchestratorDeps.detectAllInterventions({
        prNumber,
        branchName: branch,
        baseBranch: 'main',
        repoDir,
        worktreePath,
        agentType,
        issueId,
      });

      const interventionMeta = evalOrchestratorDeps.toInterventionMeta(interventionSummary);
      const interventionRecords = evalOrchestratorDeps.toInterventionRecords(interventionSummary);
      const penalties = evalOrchestratorDeps.loadPenalties(repoDir);
      const interventionText = evalOrchestratorDeps.formatForJudge(interventionSummary, penalties);

      const totalInterventions = interventionSummary.interventions.reduce(
        (sum, e) => sum + e.count,
        0
      );
      console.log(
        `  Detected ${totalInterventions} intervention event(s) ` +
          `(weighted penalty: ${interventionSummary.totalInterventionScore})`
      );

      return {
        interventionSummary,
        interventionMeta,
        interventionRecords,
        interventionText,
      };
    });

  const [
    {
      interventionSummary,
      interventionMeta,
      interventionRecords,
      interventionText,
    },
    { difficultyData, repoContextData, taskContextData },
  ] = await Promise.all([
    runInterventionAnalysis(),
    evalOrchestratorDeps.runEvalAnalysis({
      prDiff: evalContext.prDiff,
      prNumber,
      repoDir,
      issueData: evalContext.issueData,
      logPrefix: '\n',
    }),
  ]);

  // 7. Collect outcome components
  console.log('\nCollecting outcome components...');
  const outcomes: Outcomes = {
    success: false, // Will be set after scoring based on score threshold
    ci: prNumber
      ? evalOrchestratorDeps.collectCiOutcome(prNumber, repoDir)
      : undefined,
    tests:
      prNumber && branch
        ? evalOrchestratorDeps.collectTestsOutcome(prNumber, branch, 'main', repoDir)
        : undefined,
    staticAnalysis:
      prNumber && branch
        ? evalOrchestratorDeps.collectStaticAnalysisOutcome(prNumber, branch, 'main', repoDir)
        : undefined,
    review: prNumber
      ? evalOrchestratorDeps.collectReviewOutcome(prNumber, interventionSummary, repoDir, undefined, issueId, branch)
      : {
          humanReviewRequired: interventionSummary.interventions.some(
            (e) => e.type === 'review_comment' && e.count > 0
          ),
          rounds: 0,
          approvals: 0,
          changeRequests: 0,
        },
    rework: evalOrchestratorDeps.collectReworkOutcome(repoDir, branch, agentType, repoDir),
    delivery: prNumber
      ? evalOrchestratorDeps.collectDeliveryOutcome(prNumber, repoDir)
      : {
          prCreated: false,
          merged: false,
        },
  };

  console.log(
    `  CI: ${outcomes.ci?.ran ? (outcomes.ci.passed ? 'passed' : 'failed') : 'not run'}`
  );
  console.log(`  Tests: ${outcomes.tests?.added ? 'added' : 'none added'}`);
  console.log(
    `  Review: ${outcomes.review.approvals} approvals, ${outcomes.review.changeRequests} change requests`
  );
  console.log(`  Rework: ${outcomes.rework.agentIterations} iterations`);
  console.log(
    `  Delivery: ${outcomes.delivery.merged ? 'merged' : outcomes.delivery.prCreated ? 'PR created' : 'no PR'}`
  );

  // 8. Invoke judge via shared evaluateTask()
  console.log('\nInvoking LLM judge...');
  // Use explicitly provided routing decision, or fall back to auto-loaded one
  const effectiveRoutingDecision = routingDecision ?? stageArtifacts.routingDecision;

  const evalInput = {
    taskPrompt: evalContext.taskPrompt,
    prReviewOutput: evalContext.prDiff,
    interventions: interventionMeta,
    interventionRecords,
    interventionText,
    issueId: issueId || undefined,
    prUrl: prUrl || undefined,
    timeSeconds: wallClockSeconds,
    routingDecision: effectiveRoutingDecision,
    taskPacket: stageArtifacts.taskPacket,
    planContent: stageArtifacts.planContent,
    selfReviewSummary: stageArtifacts.selfReviewSummary,
    metadata: { interventionSummary },
  };
  const record = prNumber && evalContext.prDiffAvailability?.available === false
    ? await evalOrchestratorDeps.buildUnscoredEvalRecord(
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
    : await evalOrchestratorDeps.evaluateTask(evalInput, outcomes);

  // 9. Set success flag based on score threshold
  if (record.outcomes) {
    record.outcomes.success = finalizeEvalSuccess(record, { repoDir });
  }
  attachPhaseDurations(record, phaseDurations);

  // Pre-populate stageOutcomes so buildTaskDescriptor can embed them in the descriptor.
  // enrichTrainingMetadata calls attachStageOutcomes again as part of its comprehensive
  // enrichment pass; attachStageOutcomes is idempotent (overwrites, never appends).
  attachStageOutcomes(
    record,
    record.metadata?.stageScores as Record<string, { score: number; rationale: string }> | undefined,
    record.metadata?.planCritique as PlanCritique | undefined,
  );

  // 9b. Compute workflow cost metadata before building the descriptor so both
  // eval entrypoints describe the same run with the same cost context.
  let workflowCostOutcome: WorkflowCostOutcome | null = null;
  if (worktreePath && branch) {
    try {
      const pricingTable = evalOrchestratorDeps.loadPricingTable(repoDir);
      workflowCostOutcome = await evalOrchestratorDeps.computeWorkflowCost({
        worktreePath,
        branchName: branch,
        repoDir,
        pricingTable,
        agentType,
        issueId,
      });
    } catch (err) {
      const errorMsg = errorMessage(err);
      console.warn(`Warning: failed to compute workflow cost: ${errorMsg}`);
      workflowCostOutcome = {
        status: 'adapter_error',
        reason: errorMsg,
        diagnostics: {
          worktreePath,
          branchName: branch,
          agentType,
        },
      };
    }
  } else {
    const missingParams = [];
    if (!worktreePath) {
      missingParams.push('worktreePath');
    }
    if (!branch) {
      missingParams.push('branchName');
    }
    workflowCostOutcome = {
      status: 'skipped',
      reason: `Required parameters missing: ${missingParams.join(', ')}`,
      diagnostics: {
        worktreePath,
        branchName: branch,
        agentType,
      },
    };
  }

  // 9c. Collect normalized execution economics (HOK-2958): fail-soft,
  // observation-only, mirroring the post-completion hook.
  let executionEconomics: Awaited<ReturnType<typeof collectExecutionEconomics>> | null = null;
  if (worktreePath && branch) {
    try {
      executionEconomics = await evalOrchestratorDeps.collectExecutionEconomics({
        worktreePath,
        branchName: branch,
        repoDir,
        issueId,
        routing: stageArtifacts.routing ?? null,
        stageResultsDir: stageArtifacts.stageResultsDir ?? null,
      });
    } catch (err) {
      console.warn(`Warning: failed to collect execution economics: ${errorMessage(err)}`);
    }
  }

  const resolvedWorkflowCost = workflowCostOutcome?.status === 'success'
    ? workflowCostOutcome.totalCostUsd
    : undefined;
  const resolvedWorkflowTokenUsage = workflowCostOutcome?.status === 'success'
    ? workflowCostOutcome.models
    : undefined;

  // 9c. Build task descriptor for router training (HOK-1120)
  let taskDescriptor = null;
  let evalConstraints: EvalConstraints | undefined;
  const executionModel = resolveExecutionModelWithArtifacts(
    solutionModel,
    effectiveRoutingDecision,
    stageArtifacts.executionModel,
  );

  // Resolve provider metadata: prefer native when agentType is native; fall back to DeepSeek.
  // 'native' is the eval-layer canonical agent value (as written to stage-result.agent);
  // routing-config sub-types like 'native-openai' / 'native-openrouter' are normalized to
  // 'native' before reaching this layer.
  let providerMetadata: { provider: string; endpoint?: string } | null = null;
  if (agentType === 'native' && worktreePath) {
    providerMetadata = getNativeProviderMetadata(worktreePath, repoDir);
  }
  if (!providerMetadata) {
    providerMetadata = getDeepSeekProviderMetadata(executionModel, repoDir);
  }
  const slug = branch.replace(/^(task|bug)\//, '') || issueId.toLowerCase();
  let challengeIntent: ChallengeExecutionIntent | undefined;
  // Declared at function scope: it is read much later, where the attestation is
  // finalised. It used to be declared inside the block below, which threw a
  // ReferenceError as soon as an attestation existed to test it against.
  let challengeEvidenceInvalid: { reason: string; detail?: string } | undefined;
  challengeIntent = loadChallengeIntentFromState(repoDir, issueId, challengePairId);
  if (challengePairId && slug) {
    const challengeFeatureDir = deriveChallengeFeatureDir(worktreePath, slug);
    challengeIntent ??= challengeFeatureDir ? loadChallengeIntentFromFeatureDir(challengeFeatureDir) : undefined;
    if (challengeFeatureDir) {
      const invalidPath = path.join(challengeFeatureDir, '.challenge-evidence-invalid.json');
      if (existsSync(invalidPath)) {
        try {
          const invalid = JSON.parse(readFileSync(invalidPath, 'utf-8')) as { reason?: unknown; detail?: unknown };
          const reason = typeof invalid.reason === 'string' && invalid.reason.trim() ? invalid.reason.trim() : 'operator_reroute';
          challengeEvidenceInvalid = {
            reason,
            ...(typeof invalid.detail === 'string' && invalid.detail.trim() ? { detail: invalid.detail.trim() } : {}),
          };
        } catch {
          challengeEvidenceInvalid = { reason: 'operator_reroute', detail: 'challenge evidence invalidation marker is malformed' };
        }
      }
    }
  }
  const challengeSide = resolveChallengeSide({
    repoDir,
    slug,
    issueId,
    challengePairId,
  });
  // Persist the live head observed at evaluation time.  A later reader must
  // never substitute the PR's then-current head for this immutable fact.
  let evaluatedPrHeadSha: string | undefined;
  if (prNumber || prUrl) {
    try {
      evaluatedPrHeadSha = resolvePrIdentityMetadata(prNumber || prUrl, repoDir).head_sha;
    } catch (error) {
      console.warn(`Warning: could not resolve evaluated PR head: ${errorMessage(error)}`);
    }
  }
  // Some programmatic eval callers already attached pre-PR verification
  // telemetry before orchestration. It is immutable evidence, unlike a later
  // live PR lookup, so it is the only permitted fallback.
  evaluatedPrHeadSha ??= record.verificationTelemetry?.checked_shas?.head;
  try {
    // Derive feature slug from branch or issue ID
    // Fetch raw routing data
    const routingComplete = slug
      ? fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId, worktreePath)
      : null;
    evalConstraints = resolveEvalConstraints(routingComplete, repoDir);

    // Build descriptor from all gathered context
    taskDescriptor = evalOrchestratorDeps.buildTaskDescriptor({
      originalPrompt: evalContext.taskPrompt,
      prDiff: evalContext.prDiff,
      taskContext: taskContextData || undefined,
      repoContext: repoContextData || undefined,
      difficultySignals: difficultyData?.difficultySignals || undefined,
      routingDecision: effectiveRoutingDecision || undefined,
      routingComplete: routingComplete || undefined,
      stageOutcomes: record.stageOutcomes || undefined,
      workflowCost: resolvedWorkflowCost,
      workflowTokenUsage: resolvedWorkflowTokenUsage,
      score: record.score || undefined,
      timeSeconds: record.timeSeconds || undefined,
      interventionCount: record.interventionCount || undefined,
      interventions: interventionRecords || undefined,
      modelsAvailable: getConfiguredModelsForDescriptor(repoDir),
      objective: 'balanced',
      maxCostUsd: evalConstraints?.maxCostUsd,
    });
  } catch (err) {
    const errorMsg = errorMessage(err);
    console.warn(`Warning: failed to build task descriptor: ${errorMsg}`);
  }

  if (executionModel) {
    record.modelId = executionModel;
    record.modelVersion = executionModel;
  }

  // 9d. Load feature outcome artifact diagnostics (HOK-2262) — best-effort
  let featureOutcomeDiagnostics = null;
  try {
    const fSlug = branch.replace(/^(task|bug)\//, '') || issueId.toLowerCase();
    const featureDirs: string[] = [];
    if (worktreePath && fSlug) {
      featureDirs.push(
        path.join(worktreePath, 'features', fSlug),
        path.join(worktreePath, 'bugs', fSlug),
      );
    }
    if (repoDir && fSlug) {
      featureDirs.push(
        path.join(repoDir, 'features', fSlug),
        path.join(repoDir, 'bugs', fSlug),
      );
    }
    const archiveDir = issueId ? resolveRouteArtifactArchiveDir(issueId, repoDir) : undefined;

    // Build a reconstructed comparison shape from current eval state
    const reconstructed = {
      completed: record.outcomes?.success,
      merged: record.outcomes?.delivery?.merged,
      ciPassed: record.outcomes?.ci?.passed ?? null,
      reviewPassed: (() => {
        const r = record.outcomes?.review;
        if (!r) return null;
        return r.changeRequests === 0 && r.approvals > 0 ? true : r.changeRequests > 0 ? false : null;
      })(),
      manualIntervention: record.interventionRequired,
      interventionCount: record.interventionCount,
      evalScore: record.score,
      costUsd: typeof record.workflowCost === 'number' ? record.workflowCost : null,
      durationSeconds: typeof record.timeSeconds === 'number' ? record.timeSeconds : null,
    };

    // Try each feature directory until diagnostics are loaded
    let resolved = false;
    for (const featureDir of featureDirs) {
      const diag = loadFeatureOutcomeDiagnostics({ featureDir, archiveDir, reconstructed });
      if (diag.present) {
        featureOutcomeDiagnostics = diag;
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      // Artifact absent — still record that we looked
      featureOutcomeDiagnostics = loadFeatureOutcomeDiagnostics({ archiveDir, reconstructed });
    }
  } catch (err) {
    // Never fail eval due to diagnostic loading errors
    console.warn(`Warning: failed to load feature outcome diagnostics: ${errorMessage(err)}`);
  }

  // 10. Enrich record with metadata
  enrichTrainingMetadata(record, {
    agentType,
    provider: providerMetadata?.provider,
    endpoint: providerMetadata?.endpoint,
    challengePairId,
    challengeSide: challengeSide.side,
    evaluatedPrHeadSha,
    challengeIntent,
    routeProvenance: deriveRouteProvenance(repoDir, branch, issueId, worktreePath),
    executedPlanning: stageArtifacts.executedPlanning,
    planningExecutionOutcome: stageArtifacts.planningExecutionOutcome,
    phaseDurations,
    routePrediction: stageArtifacts.routePrediction,
    routing: stageArtifacts.routing,
    difficulty: difficultyData,
    taskContext: taskContextData,
    repoContext: repoContextData,
    workflowCost: workflowCostOutcome,
    executionEconomics,
    taskDescriptor,
    constraints: evalConstraints,
    featureOutcomeDiagnostics,
  });
  const attestation = attestEvalRecordChallengeExecution(record);
  if (attestation && challengeEvidenceInvalid) {
    attestation.validity = 'invalid_challenge';
    attestation.invalidReason = challengeEvidenceInvalid.reason === 'operator_reroute'
      ? 'operator_reroute'
      : 'operator_reroute';
    attestation.invalidDetails = challengeEvidenceInvalid.detail
      ?? `Challenge evidence was invalidated by ${challengeEvidenceInvalid.reason}.`;
  }
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

  if (enforceChallengeIntentPresence(record, challengePairId)) {
    console.warn(
      `Warning: challenge record for ${issueId} (pair ${challengePairId}) has no persisted intent; marking invalid rather than training-eligible.`,
    );
  }

  // 10a. Attach trace correlation ID (HOK-2259) — best-effort
  let traceCtx = null;
  if (worktreePath && slug) {
    for (const dir of ['features', 'bugs']) {
      const featureDir = path.join(worktreePath, dir, slug);
      traceCtx = loadTraceContext(featureDir);
      if (traceCtx) {
        break;
      }
    }
  }
  if (traceCtx) {
    attachTraceId(record, traceCtx.traceId);
  }

  // 11. Persist eval record to disk
  let persisted = false;
  try {
    evalOrchestratorDeps.appendEvalRecord(record, { repoDir });
    persisted = true;
  } catch (err) {
    const errorMsg = errorMessage(err);
    console.error(`Warning: failed to persist eval record: ${errorMsg}`);
  }

  // 11a. Emit eval_recorded trace event (HOK-2259) — best-effort
  if (persisted && traceCtx) {
    appendTraceEvent(traceCtx, {
      phase: 'eval',
      event: 'eval_recorded',
      status: 'ok',
      meta: {
        evalId: record.id,
        score: record.score,
        scoreBand: record.scoreBand,
        interventionCount: record.interventionCount,
      },
    }).catch(() => undefined);
  }

  if (persisted) {
    try {
      const result = await evalOrchestratorDeps.triggerHokusaiSubmission(record, { repoDir });
      console.log(`[hokusai] submission ${formatHokusaiSubmissionTriggerResult(result)}`);
    } catch (error) {
      console.warn(`[hokusai] failed to trigger submission: ${errorMessage(error)}`);
    }
  }

  return record;
}
