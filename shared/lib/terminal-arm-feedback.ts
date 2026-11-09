/** Recover completion feedback from retained execution facts, never launch intent. */
import { readFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { classifyArmFault, isModelQualitySignal, parseAbortFailureKind } from './arm-failure-taxonomy.ts';
import { parseBudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';
import { resolveNativeStageTimeSplit } from './native-agent/stage-time-split.ts';
import { normalizeChallengeStage } from './challenge-route-check.ts';
import { resolveTaskArtifact } from './task-artifact-lookup.ts';
import { resolveStageExecutedModel } from './executed-model-resolver.ts';
import { readRouteLifecycleArtifacts } from './route-artifact.ts';
import { applyChallengeOverride } from './route-override-record.ts';
import { convertToRoutingDecision, type RoutingCompleteData } from './eval-context-gatherer.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { attachEligibility, attachWorkflowCostMetadata, attachTaskCostSummaries, attachModelIdentityAttribution } from './eval-record-builder.ts';
import { getEffectiveRegistry, resolveModelRegistryKey } from './model-registry.ts';
import { meterWorkflowCost, type MeteredWorkflowCost } from './sdk-task-cost/meter.ts';

export interface TerminalArmFeedbackOptions {
  repoDir: string;
  worktreePath?: string;
  featureDir?: string;
  branchName?: string;
  meteredCost?: MeteredWorkflowCost;
}

/**
 * A terminated arm has no output-quality score. It can still supply completion
 * evidence once its cause, executed model, route and owned-session costs are
 * established. Leave the original reward-ineligible eval immutable. Missing or
 * contradictory evidence keeps the original hold; normal submissions are unchanged.
 */
export async function prepareTerminalArmFeedback(
  record: EvalRecord,
  options: TerminalArmFeedbackOptions,
): Promise<{ record: EvalRecord; meteredCost?: MeteredWorkflowCost; featureDir?: string }> {
  const unchanged = { record, meteredCost: options.meteredCost };
  if (record.nonRewardReason?.code !== 'arm-terminated' || record.outcomes?.success !== false || !record.issueId) return unchanged;
  try {
    const lookup = { issueId: record.issueId, repoDir: options.repoDir, slug: options.featureDir ? basename(options.featureDir) : undefined, worktreeDir: options.worktreePath ?? (options.featureDir ? resolve(options.featureDir, '../..') : undefined) };
    const artifact = resolveTaskArtifact({ ...lookup, artifactName: '.challenge-aborted.json' });
    if (!artifact) return unchanged;
    const featureDir = dirname(artifact.path);
    const termination = JSON.parse(readFileSync(artifact.path, 'utf8'));
    const stage = normalizeChallengeStage(termination.stage);
    if (!stage) return unchanged;
    const ownershipStage = stage === 'plan' ? 'planning' : stage === 'review' ? 'review' : 'coding';
    const budgetExhausted = parseBudgetExhaustedFact(termination.budgetExhausted);
    const failureKind = parseAbortFailureKind(termination.reason);
    if (!failureKind) return unchanged;
    const faultClass = classifyArmFault({ failureKind, detail: termination.detail, budgetExhausted,
      timeSplit: resolveNativeStageTimeSplit(budgetExhausted, { featureDir }) ?? undefined });
    if (!isModelQualitySignal(faultClass)) return unchanged;
    const worktreePath = lookup.worktreeDir ?? options.repoDir;
    const branchName = options.branchName ?? '';
    const evidence = resolveStageExecutedModel({ featureDir, stage: ownershipStage, worktreePath, branchName, repoDir: options.repoDir });
    if (evidence.evidenceStatus !== 'direct' || !evidence.executedModel) return unchanged;
    const registry = getEffectiveRegistry(options.repoDir);
    const modelKey = (model: string) => resolveModelRegistryKey(registry, model) ?? model;
    if (modelKey(evidence.executedModel) !== modelKey(record.modelId) || modelKey(evidence.executedModel) !== modelKey(termination.model ?? '')) return unchanged;
    const routes = readRouteLifecycleArtifacts(featureDir);
    const routeArtifact = resolveTaskArtifact({ ...lookup, artifactName: '.routing-complete' });
    if (!routeArtifact) return unchanged;
    const active = JSON.parse(readFileSync(routeArtifact.path, 'utf8')) as RoutingCompleteData;
    if (!active?.planner || !active.coder || !active.reviewer) return unchanged;
    const role = stage === 'plan' ? 'planner' : stage === 'review' ? 'reviewer' : 'coder';
    const packet = resolveTaskArtifact({ ...lookup, artifactName: 'task-packet.md' });
    if (!packet) return unchanged;
    const meteredCost = options.meteredCost ?? await meterWorkflowCost({ worktreePath, branchName,
      repoDir: options.repoDir, issueId: record.issueId, slug: lookup.slug, label: 'Terminal arm feedback', exactPricing: {} });
    const measured = meteredCost.outcome;
    if (measured.status !== 'success') return unchanged;
    const executionRoute = { ...active, ...(routes.expanded ? { planner: routes.expanded.planner ?? active.planner, coder: routes.expanded.coder, reviewer: routes.expanded.reviewer } : {}), [role]: evidence.executedModel };
    const stageRoutes = applyChallengeOverride(routes.expanded?.stageRoutes ?? routes.active?.stageRoutes, {
      selectedStage: stage, pairId: record.challengePairId ?? record.issueId,
      primaryVariedModel: (routes.expanded ?? active)[role] ?? active[role],
      challengerVariedModel: evidence.executedModel,
    }, record.challengeSide ?? 'primary', record.timestamp);
    const recovered: EvalRecord = {
      ...record,
      originalPrompt: readFileSync(packet.path, 'utf8'),
      challengeStage: stage,
      routingDecision: convertToRoutingDecision(executionRoute),
      taskDescriptor: buildTaskDescriptor({ originalPrompt: readFileSync(packet.path, 'utf8'), routingComplete: executionRoute,
        maxCostUsd: active.constraints?.maxCostUsd ?? active.maxCostUsd ?? undefined, budgetSource: active.constraints?.budgetSource }),
      constraints: active.constraints,
      routeProvenance: { activeRoute: { planner: executionRoute.planner, coder: executionRoute.coder, reviewer: executionRoute.reviewer, codeDepth: active.codeDepth ?? 'medium', reviewMode: active.reviewMode ?? 'llm' }, ...(stageRoutes ? { stageRoutes } : {}),
        hokusaiInferenceLogId: routes.expanded?.hokusaiInferenceLogId ?? routes.active?.hokusaiInferenceLogId },
    };
    attachWorkflowCostMetadata(recovered, measured);
    attachTaskCostSummaries(recovered, meteredCost.summaries);
    attachModelIdentityAttribution(recovered, registry);
    attachEligibility(recovered);
    return { record: recovered, meteredCost, featureDir };
  } catch {
    return unchanged;
  }
}
