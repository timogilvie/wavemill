#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import {
  pickChallengeModelsWithReason,
  pickChallengeWorkflowsWithContextAndReason,
  pickChallengeWorkflowsWithReason,
  getChallengeModelPool,
  canRunChallenge,
  chooseChallengeStage,
  decideChallengeLaunch,
  extractChallengeRecommendation,
  variedModelForStage,
  buildChallengeExecutionIntent,
  type ChallengeNativeRejection,
  type ChallengeStage,
} from '../shared/lib/challenge-mode.ts';
import type { ModelExclusionDiagnostic } from '../shared/lib/model-exclusions.ts';
import { buildEvalSummary, modelStageCount } from '../shared/lib/challenge-scheduler.ts';
import { resolveAgent, tryResolveAgent } from '../shared/lib/model-router.ts';
import { readBothRouteArtifacts } from '../shared/lib/route-artifact.ts';
import { readTaskPromptFromFile } from '../shared/lib/workflow-router.ts';
import { buildChallengeUnavailable } from '../shared/lib/challenge-unavailable.ts';
import {
  buildSelectionHealthDiagnostic,
  buildSelectionHealthEvidence,
  claimReservation,
  computeSelectionExclusions,
  normalizeSelectionHealthConfig,
  readSelectionHealth,
  type CircuitExclusion,
  type ReservationExclusion,
  type SelectionHealthDiagnostic,
} from '../shared/lib/challenge-selection-health.ts';

runTool({
  name: 'resolve-challenge-task',
  description: 'Resolve whether a mill task should run in challenge mode and return the launch plan.',
  options: {
    issue: { type: 'string', description: 'Task key / issue identifier' },
    slug: { type: 'string', description: 'Base task slug' },
    title: { type: 'string', description: 'Task title' },
    'force-model': { type: 'string', description: 'Explicit forced model; disables challenge mode when non-empty' },
    'primary-model': { type: 'string', description: 'Router-selected or forced primary model' },
    'remaining-slots': { type: 'string', description: 'Available mill slots before launch' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    file: { type: 'string', description: 'Task packet file path (for routing)' },
    'feature-dir': { type: 'string', description: 'Feature directory for reading route artifacts' },
    'pinned-stage': {
      type: 'string',
      description: 'Stage already chosen for this pair (plan|implementation|review); suppresses stage re-sampling',
    },
  },
  async run({ args }) {
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    const issue = args.issue as string;
    const slug = args.slug as string;
    const title = args.title as string;
    const forceModel = (args['force-model'] as string | undefined)?.trim() || undefined;
    const primaryModel = (args['primary-model'] as string | undefined)?.trim() || undefined;
    const remainingSlots = Number(args['remaining-slots'] || '1');
    const taskFile = args.file as string | undefined;
    const featureDir = args['feature-dir'] as string | undefined;
    const pinnedStage = normalizeChallengeStage(args['pinned-stage'] as string | undefined);

    if (!issue || !slug || !title) {
      throw new Error('--issue, --slug, and --title are required');
    }

    const config = loadWavemillConfig(repoDir);
    const challenge = config.challenge || {};
    const router = config.router || {};
    const selectionHealthConfig = normalizeSelectionHealthConfig(challenge.selectionHealth);
    const selectionHealthEnabled = selectionHealthConfig.enabled;
    let selectionHealthDiagnostic: SelectionHealthDiagnostic | undefined;
    let selectionHealthReservationExclusions: ReservationExclusion[] = [];
    let selectionHealthCircuitExclusions: CircuitExclusion[] = [];
    let selectionHealthProbeGranted: { model: string; provider: string; canonicalModel: string } | null = null;
    const selectionHealthOutput = () => selectionHealthEnabled
      ? {
          selectionHealth: buildSelectionHealthEvidence({
            config: selectionHealthConfig,
            excludedByReservation: selectionHealthReservationExclusions,
            excludedByCircuit: selectionHealthCircuitExclusions,
            probeGranted: selectionHealthProbeGranted,
          }),
          ...(selectionHealthDiagnostic ? { selectionHealthDiagnostic } : {}),
        }
      : {};
    const defaultAgent = router.defaultAgent || 'claude';
    const pool = getChallengeModelPool(challenge, router);
    const requestedRate = challenge.rate ?? 0.10;
    const strictWhenRequired = challenge.enabled === true && requestedRate >= 1;

    const singleAgentResolution = primaryModel
      ? tryResolveAgent(primaryModel, {}, defaultAgent, repoDir, 'coding')
      : undefined;
    const singleAgent = singleAgentResolution?.ok ? singleAgentResolution.agent : defaultAgent;

    const base = {
      issue,
      slug,
      title,
      mode: 'single',
      slotsRequired: 1,
      decisionSource: 'bootstrap',
      reason: 'challenge_disabled',
      single: {
        key: issue,
        issueId: issue,
        slug,
        branch: `task/${slug}`,
        role: 'primary',
        model: primaryModel || '',
        agent: singleAgent,
      },
    };
    const buildSingle = (
      reason: string,
      extra: Record<string, unknown> = {},
      diagnostics: {
        nativeCertificationRejections?: ChallengeNativeRejection[];
        modelExclusions?: ModelExclusionDiagnostic[];
      } = {},
    ) => ({
      ...base,
      reason,
      ...extra,
      ...selectionHealthOutput(),
      ...(diagnostics.nativeCertificationRejections?.length
        ? { nativeCertificationRejections: diagnostics.nativeCertificationRejections }
        : {}),
      ...(diagnostics.modelExclusions?.length ? { modelExclusions: diagnostics.modelExclusions } : {}),
      challengeExecutionIntent: buildChallengeExecutionIntent({
        pairId: issue,
        issueId: issue,
        decisionSource: (extra.decisionSource as 'bootstrap' | 'expanded' | 'preserved' | undefined) || 'bootstrap',
        selectionPath: extra.selectionPath as 'recommendation-driven' | 'random-roll' | undefined,
        challengeRecommendation: recommendationForIntent(extra.challengeRecommendation),
        noChallengeReason: reason,
        nativeCertificationRejections: diagnostics.nativeCertificationRejections,
        modelExclusions: diagnostics.modelExclusions,
        primary: {
          key: issue,
          role: 'primary',
          planner: { model: '', agent: '' },
          coder: { model: primaryModel || '', agent: singleAgent },
          reviewer: { model: '', agent: '' },
        },
      }),
    });

    if (forceModel) {
      console.log(JSON.stringify(buildSingle('forced_model')));
      return;
    }

    if (challenge.enabled !== true) {
      console.log(JSON.stringify(buildSingle('challenge_disabled')));
      return;
    }

    if (remainingSlots < 2) {
      console.log(JSON.stringify(buildSingle('insufficient_slots')));
      return;
    }

    if (!canRunChallenge(pool)) {
      if (strictWhenRequired) {
        console.log(JSON.stringify({
          issue,
          slug,
          title,
          ...buildChallengeUnavailable({
            requestedRate,
            pool,
            certifiedPool: [],
            primaryModel,
            repoDir,
            nativeCertificationRejections: [],
            modelExclusions: [],
          }),
          slotsRequired: 0,
          reason: 'challenge_unavailable',
        }));
        return;
      }
      console.log(JSON.stringify(buildSingle('insufficient_models')));
      return;
    }

    const routeArtifacts = featureDir
      ? readBothRouteArtifacts(featureDir)
      : { bootstrap: null, expanded: null };
    const recommendation = extractChallengeRecommendation(routeArtifacts);

    const launchDecision = decideChallengeLaunch({
      pool,
      primaryModel,
      rate: requestedRate,
      recommendationRate: challenge.recommendationRate,
      recommendation,
    });

    if (!launchDecision.launch) {
      console.log(JSON.stringify(buildSingle('roll_not_selected', {
        selectionPath: launchDecision.selectionPath,
        ...(launchDecision.recommendation ? { challengeRecommendation: launchDecision.recommendation } : {}),
      })));
      return;
    }

    const forcedChallengerModel = launchDecision.forcedChallengerModel;

    // A stage pinned by the caller wins outright. Re-sampling the stage on a
    // refresh is how an already-selected implementation-stage challenge (e.g.
    // a Qwen or Kimi coder arm) turned into an unrelated plan-stage pair: the
    // second roll is independent, so an open-weight coder had to win twice.
    // Otherwise a recommendation carrying a stage pins it, and failing that we
    // sample from the configured weights.
    const challengeStage = pinnedStage ?? chooseChallengeStage({
      weights: challenge.stageWeights,
      recommendedStage: launchDecision.recommendation?.stage,
    });
    const summary = buildEvalSummary(repoDir);
    const coverage = (model: string, stage: 'plan' | 'implementation' | 'review') =>
      modelStageCount(summary, model, stage);
    const rotationSeed = `${issue}|${challengeStage}`;
    const recommendedChallengerModel = launchDecision.recommendation?.challengerModel;

    const resolvePair = (candidatePool: string[]) => {
      let selectionFailureReason = 'selection_failed';
      let pair;
      let nativeCertificationRejections: ChallengeNativeRejection[] | undefined;
      let modelExclusions: ModelExclusionDiagnostic[] | undefined;

      const mergeDiagnostics = (selection: {
        nativeCertificationRejections?: ChallengeNativeRejection[];
        modelExclusions?: ModelExclusionDiagnostic[];
      }) => {
        nativeCertificationRejections = [
          ...(nativeCertificationRejections || []),
          ...(selection.nativeCertificationRejections || []),
        ];
        modelExclusions = [
          ...(modelExclusions || []),
          ...(selection.modelExclusions || []),
        ];
      };

      if (featureDir) {
        const selection = pickChallengeWorkflowsWithContextAndReason(candidatePool, {
          pairId: issue,
          issueId: issue,
          slug,
          prompt: title,
          primaryModel,
          forcedChallengerModel,
          challengeStage,
          agentMap: {},
          defaultAgent,
          repoDir,
          coverage,
          rotationSeed,
          recommendedChallengerModel,
        }, routeArtifacts);
        pair = selection.pair;
        selectionFailureReason = selection.failureReason || selectionFailureReason;
        nativeCertificationRejections = selection.nativeCertificationRejections;
        modelExclusions = selection.modelExclusions;
      }

      if (!pair && taskFile) {
        try {
          const prompt = readTaskPromptFromFile(taskFile);
          const selection = pickChallengeWorkflowsWithReason(pool, {
            pairId: issue,
            issueId: issue,
            slug,
            prompt,
            primaryModel,
            forcedChallengerModel,
            challengeStage,
            agentMap: {},
            defaultAgent,
            repoDir,
            coverage,
            rotationSeed,
            recommendedChallengerModel,
          });
          pair = selection.pair;
          selectionFailureReason = selection.failureReason || selectionFailureReason;
          mergeDiagnostics(selection);
        } catch (error) {
          // Fall back to model-only selection if task file is unreadable
          console.error(`Warning: Failed to read task file for routing: ${error}`);
          const selection = pickChallengeModelsWithReason(candidatePool, {
            pairId: issue,
            issueId: issue,
            slug,
            primaryModel,
            forcedChallengerModel,
            agentMap: {},
            defaultAgent,
            repoDir,
            coverage,
            rotationSeed,
            recommendedChallengerModel,
            strictWhenRequired,
            requestedRate,
          });
          pair = selection.pair;
          selectionFailureReason = selection.failureReason || selectionFailureReason;
          mergeDiagnostics(selection);
        }
      } else if (!pair) {
        // No task file provided - use model-only selection (backward compatibility)
        const selection = pickChallengeModelsWithReason(candidatePool, {
          pairId: issue,
          issueId: issue,
          slug,
          primaryModel,
          forcedChallengerModel,
          agentMap: {},
          defaultAgent,
          repoDir,
          coverage,
          rotationSeed,
          recommendedChallengerModel,
          strictWhenRequired,
          requestedRate,
        });
        pair = selection.pair;
        selectionFailureReason = selection.failureReason || selectionFailureReason;
        if (selection.challengeUnavailable) {
          nativeCertificationRejections = selection.nativeCertificationRejections;
          modelExclusions = selection.modelExclusions;
        }
        mergeDiagnostics(selection);
      }

      return { pair, selectionFailureReason, nativeCertificationRejections, modelExclusions };
    };

    const rememberSelectionHealthExclusions = (items: {
      reservations: ReservationExclusion[];
      circuits: CircuitExclusion[];
    }) => {
      const reservationKeys = new Set(selectionHealthReservationExclusions.map((item) =>
        `${item.provider}|${item.canonicalModel}|${item.stage}|${item.ownerIssueId}|${item.expiresAt}`,
      ));
      for (const item of items.reservations) {
        const key = `${item.provider}|${item.canonicalModel}|${item.stage}|${item.ownerIssueId}|${item.expiresAt}`;
        if (!reservationKeys.has(key)) {
          reservationKeys.add(key);
          selectionHealthReservationExclusions.push(item);
        }
      }
      const circuitKeys = new Set(selectionHealthCircuitExclusions.map((item) =>
        `${item.provider}|${item.canonicalModel}|${item.state}|${item.cooldownUntil ?? ''}`,
      ));
      for (const item of items.circuits) {
        const key = `${item.provider}|${item.canonicalModel}|${item.state}|${item.cooldownUntil ?? ''}`;
        if (!circuitKeys.has(key)) {
          circuitKeys.add(key);
          selectionHealthCircuitExclusions.push(item);
        }
      }
    };

    const resolvePairWithSelectionHealth = async () => {
      const healthOwner = { issueId: issue, pairId: issue };
      const healthExcludedModels = new Set<string>();
      let lastResult: ReturnType<typeof resolvePair> | null = null;
      const maxAttempts = Math.max(pool.length, 1);

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let candidatePool = pool;
        if (selectionHealthEnabled) {
          try {
            const snapshot = readSelectionHealth({ repoDir, config: selectionHealthConfig });
            const exclusions = computeSelectionExclusions({
              stage: challengeStage,
              candidates: pool,
              snapshot,
              owner: healthOwner,
              config: selectionHealthConfig,
              additionallyExcludedModels: healthExcludedModels,
            });
            rememberSelectionHealthExclusions({
              reservations: exclusions.excludedByReservation,
              circuits: exclusions.excludedByCircuit,
            });
            candidatePool = exclusions.eligible;
          } catch (error) {
            selectionHealthDiagnostic = buildSelectionHealthDiagnostic(error, {
              repoDir,
              config: selectionHealthConfig,
            });
            if (selectionHealthDiagnostic) {
              process.stderr.write(
                `Challenge selection health deferred for ${issue}: ${selectionHealthDiagnostic.code} (${selectionHealthDiagnostic.path}).\n`,
              );
              return {
                pair: null,
                selectionFailureReason: 'challenge_deferred_selection_health',
                nativeCertificationRejections: undefined,
                modelExclusions: undefined,
              };
            }
            throw error;
          }
        }

        const result = resolvePair(candidatePool);
        lastResult = result;
        if (!result.pair || !selectionHealthEnabled) {
          if (!result.pair && selectionHealthEnabled && (
            selectionHealthReservationExclusions.length > 0
            || selectionHealthCircuitExclusions.length > 0
            || healthExcludedModels.size > 0
          )) {
            return { ...result, selectionFailureReason: 'challenge_deferred_selection_health' };
          }
          return result;
        }

        const effectiveStage = result.pair.challengeStage || 'implementation';
        const challengerVaried = variedModelForStage(result.pair.challenger, effectiveStage);
        try {
          const claim = await claimReservation({
            repoDir,
            config: selectionHealthConfig,
            model: challengerVaried,
            stage: effectiveStage,
            owner: healthOwner,
          });
          if (claim.claimed) {
            selectionHealthProbeGranted = claim.probeGranted ?? null;
            return result;
          }
          healthExcludedModels.add(challengerVaried);
        } catch (error) {
          selectionHealthDiagnostic = buildSelectionHealthDiagnostic(error, {
            repoDir,
            config: selectionHealthConfig,
          });
          if (selectionHealthDiagnostic) {
            process.stderr.write(
              `Challenge selection health deferred for ${issue}: ${selectionHealthDiagnostic.code} (${selectionHealthDiagnostic.path}).\n`,
            );
            return { ...result, pair: null, selectionFailureReason: 'challenge_deferred_selection_health' };
          }
          throw error;
        }
      }

      return {
        pair: null,
        selectionFailureReason: selectionHealthEnabled
          ? 'challenge_deferred_selection_health'
          : (lastResult?.selectionFailureReason ?? 'selection_failed'),
        nativeCertificationRejections: lastResult?.nativeCertificationRejections,
        modelExclusions: lastResult?.modelExclusions,
      };
    };

    let {
      pair,
      selectionFailureReason,
      nativeCertificationRejections,
      modelExclusions,
    } = await resolvePairWithSelectionHealth();

    // Emit human-readable warnings for skipped native models (mirrors router reasoning output)
    if (nativeCertificationRejections && nativeCertificationRejections.length > 0) {
      const roleToStage: Record<string, string> = { planner: 'plan', coder: 'implementation', reviewer: 'review' };
      for (const rejection of nativeCertificationRejections) {
        const stage = roleToStage[rejection.role] || rejection.role;
        const details = [
          `launchPhase=${rejection.requestedLaunchPhase}`,
          `certPhase=${rejection.requestedPhase}`,
          `reason=${rejection.reason}`,
          `provider=${rejection.nativeProvider ?? 'unknown'}`,
        ];
        if (rejection.eligibleRoles) {
          details.push(`eligibleRoles=${rejection.eligibleRoles.join(',') || 'none'}`);
        }
        if (rejection.allowedNativeAgentPhases) {
          details.push(`allowedNativeAgentPhases=${rejection.allowedNativeAgentPhases.join(',') || 'none'}`);
        }
        process.stderr.write(
          `Challenge skipped native model ${rejection.modelId} for ${stage} stage (${details.join(', ')}).\n`,
        );
      }
    }

    if (!pair) {
      if (strictWhenRequired) {
        const unavailable = buildChallengeUnavailable({
          requestedRate,
          pool,
          primaryModel,
          repoDir,
          nativeCertificationRejections,
          modelExclusions,
        });
        console.log(JSON.stringify({
          issue,
          slug,
          title,
          ...unavailable,
          slotsRequired: 0,
          reason: 'challenge_unavailable',
          ...selectionHealthOutput(),
          selectionPath: launchDecision.selectionPath,
          ...(launchDecision.recommendation ? { challengeRecommendation: launchDecision.recommendation } : {}),
        }));
        return;
      }
      console.log(JSON.stringify(buildSingle(
        selectionFailureReason,
        {
          selectionPath: launchDecision.selectionPath,
          ...(launchDecision.recommendation ? { challengeRecommendation: launchDecision.recommendation } : {}),
        },
        { nativeCertificationRejections, modelExclusions },
      )));
      return;
    }

    // The pair may have fallen back to coder variation (no route context, or
    // route missing the requested stage model) — report the effective stage.
    const effectiveStage = pair.challengeStage || 'implementation';
    const challengerVaried = variedModelForStage(pair.challenger, effectiveStage);
    const challengerSource = pair.selectionReason || (
      forcedChallengerModel && challengerVaried === forcedChallengerModel
        ? 'recommendation'
        : 'random'
    );
    const routeFallbackReason = launchDecision.recommendation?.stage && launchDecision.recommendation.stage !== effectiveStage
      ? `recommended_stage_${launchDecision.recommendation.stage}_fell_back_to_${effectiveStage}`
      : undefined;
    const fallbackReason = routeFallbackReason;
    const challengeRecommendation = launchDecision.recommendation
      ? {
          reason: launchDecision.recommendation.reason,
          challengerModel: launchDecision.recommendation.challengerModel,
          defaultModel: launchDecision.recommendation.defaultModel,
          stage: launchDecision.recommendation.stage,
        }
      : undefined;
    const intent = buildChallengeExecutionIntent({
      pairId: pair.pairId,
      issueId: issue,
      selectedStage: effectiveStage,
      decisionSource: pair.routeContext?.decisionSource || 'bootstrap',
      selectionPath: launchDecision.selectionPath,
      challengerSource,
      selectionReason: pair.selectionReason,
      challengeRecommendation,
      routeContext: pair.routeContext,
      primary: pair.primary,
      challenger: pair.challenger,
      nativeCertificationRejections,
      modelExclusions,
      fallbackReason,
    });
    // `challengeIntent` is a byte-identical alias of the canonical intent, kept
    // for one release so in-flight tasks and older readers keep resolving. It is
    // NOT a second schema: emitting two independently-built objects under two
    // keys is exactly what let the rerouting merge read a shape it could not
    // parse and silently discard the selected arm.
    const challengeIntent = intent;

    console.log(JSON.stringify({
      issue,
      slug,
      title,
      mode: 'challenge',
      slotsRequired: 2,
      decisionSource: pair.routeContext?.decisionSource || 'bootstrap',
      reason: 'selected',
      ...selectionHealthOutput(),
      primaryModel,
      selectionPath: launchDecision.selectionPath,
      challengerSource,
      selectionReason: pair.selectionReason,
      coverageCount: pair.challengerCoverageCount,
      challengeStage: effectiveStage,
      ...(challengeRecommendation ? { challengeRecommendation } : {}),
      challengeIntent,
      ...(nativeCertificationRejections && nativeCertificationRejections.length > 0
        ? { nativeCertificationRejections }
        : {}),
      ...(modelExclusions && modelExclusions.length > 0
        ? { modelExclusions }
        : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
      challengeExecutionIntent: intent,
      routeContext: pair.routeContext,
      entries: [
        { ...pair.primary, variedModel: variedModelForStage(pair.primary, effectiveStage) },
        { ...pair.challenger, variedModel: challengerVaried },
      ],
    }));
  },
});

/**
 * Accept the stage aliases that leak in from shell state and route artifacts
 * (`planning`, `coding`, `reviewer`, …) and reject anything unrecognized so a
 * typo degrades to normal sampling rather than pinning a bogus stage.
 */
function normalizeChallengeStage(value: string | undefined): ChallengeStage | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'plan' || raw === 'planning' || raw === 'planner') return 'plan';
  if (raw === 'review' || raw === 'reviewer') return 'review';
  if (raw === 'implementation' || raw === 'coding' || raw === 'coder') return 'implementation';
  return undefined;
}

function recommendationForIntent(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const recommendation = value as Record<string, unknown>;
  return {
    ...(typeof recommendation.reason === 'string' ? { reason: recommendation.reason } : {}),
    ...(typeof recommendation.challengerModel === 'string'
      ? { challengerModel: recommendation.challengerModel }
      : {}),
    ...(typeof recommendation.defaultModel === 'string' ? { defaultModel: recommendation.defaultModel } : {}),
    ...(typeof recommendation.stage === 'string' ? { stage: recommendation.stage } : {}),
  };
}
