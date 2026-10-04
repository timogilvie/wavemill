import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getScoreBand,
  SCHEMA_VERSION,
  type EvalRecord,
  type EvalRouting,
  type EvalSubagentModelEconomicsPolicyReport,
  type RoutePrediction,
  type WavemillRouterMeasurementPolicy,
} from '../../../shared/lib/eval-schema.ts';
import { isEvalSuccess } from '../../../shared/lib/eval-success-policy.ts';
import { appendEvalRecord, readEvalRecords } from '../../../shared/lib/eval-persistence.ts';
import { buildRoutePrediction } from '../../../shared/lib/route-artifact.ts';
import { routeBatch, type RouteBatchOptions, type RouteBatchResult } from '../../../shared/lib/route-batch.ts';
import { meetsMintEligibility, type MintEligibilityEvaluation } from '../../../shared/lib/eval-aggregator.ts';
import { getMintEligibilityConfig } from '../../../shared/lib/config.ts';
import { buildTaskDescriptor } from '../../../shared/lib/task-descriptor-builder.ts';
import { partitionEvidence } from '../../../shared/lib/model-evidence-policy.ts';
import {
  scoreWavemillSuccessRateUnderBudget,
  type WavemillRouterScoreRecord,
  type WavemillRouterScoreResult,
} from '../scorers/wavemill/success-rate-under-budget.ts';
import {
  scorePatchSelection,
  type PatchSelectionScoreRecord,
  type PatchSelectionScoreResult,
} from '../scorers/wavemill/patch-selection.ts';
import {
  buildSubagentEconomicsReport,
  runSubagentEconomicsShadowPolicy,
  type SubagentEconomicsReport,
  type SubagentEconomicsWorkflowReport,
} from '../../../shared/lib/subagent-economics-policy.ts';
import type { WorkflowRouteDecision } from '../../../shared/lib/workflow-router.ts';
import {
  loadPatchSelectionCorpus,
  type LoadPatchSelectionCorpusOptions,
} from '../../../shared/fixtures/harness-replay/patch-selection-v1/loader.ts';

interface ParsedRouteArtifact {
  issueId?: string;
  prompt?: string;
  inputHash?: string;
  routeValid: boolean;
  routeSource: string;
  routePriority: number;
  routePath: string;
  routeDecision?: {
    planner: string;
    coder: string;
    reviewer: string;
    maxCostUsd?: number | null;
    operatingMode?: RouteBatchOptions['operatingMode'];
    routeMode?: RouteBatchOptions['mode'];
  };
  routePrediction?: RoutePrediction;
  error?: string;
}

interface ArtifactGroup {
  issueId?: string;
  inputHash?: string;
  routePath: string;
  prompt?: string;
  routeValid: boolean;
  routeDecision?: ParsedRouteArtifact['routeDecision'];
  routePrediction?: RoutePrediction;
}

export interface WavemillRouterEvalInputRecord extends WavemillRouterScoreRecord {
  issueId?: string;
  joinKey: string;
  routePath?: string;
  routeDecision?: ParsedRouteArtifact['routeDecision'];
  evalRecordId?: string;
}

export interface RunWavemillRouterEvalOptions {
  repoDir: string;
  policy: WavemillRouterMeasurementPolicy;
  modelsAvailable?: string[];
  evalsDir?: string;
  artifactsDir?: string;
  persist?: boolean;
  routeBatchImpl?: (
    tasks: Array<{ issueId?: string; prompt?: string; file?: string }>,
    options?: RouteBatchOptions,
  ) => Promise<RouteBatchResult[]>;
  // Patch-selection corpus evaluation options
  patchSelectionManifestPath?: string;
  patchSelectionSplit?: 'train' | 'held-out' | 'all';
}

export interface RunWavemillRouterEvalResult {
  score: WavemillRouterScoreResult;
  hemRecord: EvalRecord;
  mintEligibility: MintEligibilityEvaluation;
  records: WavemillRouterEvalInputRecord[];
  subagentModelEconomicsPolicy?: SubagentEconomicsReport;
  excludedEvidence: {
    count: number;
    reasonCounts: Record<string, number>;
  };
}

const ROUTE_FILE_PRIORITY: Array<{ pattern: RegExp; priority: number; source: string }> = [
  { pattern: /(?:^|\/)\.routing-complete$/, priority: 0, source: 'routing-complete' },
  { pattern: /(?:^|\/)routing-complete\.json$/, priority: 1, source: 'routing-complete-archive' },
  { pattern: /(?:^|\/)\.post-expansion-route\.json$/, priority: 2, source: 'post-expansion' },
  { pattern: /(?:^|\/)post-expansion-route\.json$/, priority: 3, source: 'post-expansion-archive' },
  { pattern: /(?:^|\/)\.initial-route\.json$/, priority: 4, source: 'initial-route' },
  { pattern: /(?:^|\/)initial-route\.json$/, priority: 5, source: 'initial-route-archive' },
];

function filePriority(filePath: string): { priority: number; source: string } {
  for (const entry of ROUTE_FILE_PRIORITY) {
    if (entry.pattern.test(filePath)) {
      return { priority: entry.priority, source: entry.source };
    }
  }
  return { priority: 10, source: basename(filePath) };
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

function discoverArtifactFiles(repoDir: string, artifactsDir?: string): string[] {
  if (artifactsDir) {
    return walkFiles(resolve(repoDir, artifactsDir));
  }

  const roots = [
    join(repoDir, 'features'),
    join(repoDir, 'bugs'),
    join(repoDir, '.wavemill', 'evals', 'artifacts'),
  ];

  return roots.flatMap((root) => walkFiles(root)).filter((filePath) =>
    ROUTE_FILE_PRIORITY.some((entry) => entry.pattern.test(filePath)),
  );
}

function parseRouteMode(value: unknown): RouteBatchOptions['mode'] | undefined {
  if (value === 'heuristic-fallback') {
    return 'heuristic';
  }
  if (value === 'heuristic' || value === 'auto' || value === 'stage-aware' || value === 'hokusai') {
    return value;
  }
  return undefined;
}

function parseOperatingMode(value: unknown): RouteBatchOptions['operatingMode'] | undefined {
  if (value === 'normal' || value === 'constrained' || value === 'survival') {
    return value;
  }
  return undefined;
}

function extractPrompt(data: Record<string, unknown>): string | undefined {
  const task = data.task;
  if (typeof data.prompt === 'string' && data.prompt.trim().length > 0) {
    return data.prompt;
  }
  if (task && typeof task === 'object') {
    const prompt =
      (task as Record<string, unknown>).prompt
      ?? (task as Record<string, unknown>).taskPrompt
      ?? (task as Record<string, unknown>).originalPrompt;
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      return prompt;
    }
  }
  return undefined;
}

function extractIssueId(data: Record<string, unknown>, routePath: string): string | undefined {
  if (typeof data.issueId === 'string' && data.issueId.trim().length > 0) {
    return data.issueId;
  }
  if (data.task && typeof data.task === 'object') {
    const taskIssueId = (data.task as Record<string, unknown>).issueId;
    if (typeof taskIssueId === 'string' && taskIssueId.trim().length > 0) {
      return taskIssueId;
    }
  }

  const segments = routePath.split(/[\\/]/);
  const artifactsIndex = segments.lastIndexOf('artifacts');
  if (artifactsIndex >= 0 && segments[artifactsIndex + 1]) {
    return segments[artifactsIndex + 1];
  }

  return undefined;
}

function parseRouteArtifact(routePath: string): ParsedRouteArtifact {
  const { priority, source } = filePriority(routePath);
  let raw: string;

  try {
    raw = readFileSync(routePath, 'utf-8');
  } catch (error) {
    return {
      routeValid: false,
      routeSource: source,
      routePriority: priority,
      routePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    return {
      routeValid: false,
      routeSource: source,
      routePriority: priority,
      routePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const planner = data.planner;
  const coder = data.coder;
  const reviewer = data.reviewer;
  const issueId = extractIssueId(data, routePath);
  const prompt = extractPrompt(data);
  const provenance = data.provenance && typeof data.provenance === 'object'
    ? (data.provenance as Record<string, unknown>)
    : undefined;
  const routeConstraints = data.constraints && typeof data.constraints === 'object'
    ? (data.constraints as Record<string, unknown>)
    : undefined;
  const maxCostUsd = typeof data.maxCostUsd === 'number'
    ? data.maxCostUsd
    : typeof routeConstraints?.maxCostUsd === 'number'
      ? routeConstraints.maxCostUsd
      : undefined;

  if (
    typeof planner !== 'string'
    || typeof coder !== 'string'
    || typeof reviewer !== 'string'
  ) {
    return {
      issueId,
      prompt,
      inputHash: typeof provenance?.inputHash === 'string' ? provenance.inputHash : undefined,
      routeValid: false,
      routeSource: source,
      routePriority: priority,
      routePath,
      routePrediction: buildRoutePrediction(data),
      error: 'missing required planner/coder/reviewer strings',
    };
  }

  return {
    issueId,
    prompt,
    inputHash: typeof provenance?.inputHash === 'string' ? provenance.inputHash : undefined,
    routeValid: true,
    routeSource: source,
    routePriority: priority,
    routePath,
    routeDecision: {
      planner,
      coder,
      reviewer,
      maxCostUsd,
      operatingMode: parseOperatingMode(provenance?.routerMode),
      routeMode: parseRouteMode(data.routingMode),
    },
    routePrediction: buildRoutePrediction(data),
  };
}

function artifactGroupKey(artifact: ParsedRouteArtifact): string {
  if (artifact.issueId) {
    return `issue:${artifact.issueId}`;
  }
  if (artifact.inputHash) {
    return `hash:${artifact.inputHash}`;
  }
  return `path:${artifact.routePath}`;
}

function groupArtifacts(artifacts: ParsedRouteArtifact[]): {
  grouped: ArtifactGroup[];
  invalidRecords: WavemillRouterEvalInputRecord[];
} {
  const grouped = new Map<string, ArtifactGroup>();
  const invalidRecords: WavemillRouterEvalInputRecord[] = [];

  for (const artifact of artifacts) {
    if (!artifact.routeValid) {
      invalidRecords.push({
        issueId: artifact.issueId,
        joinKey: artifactGroupKey(artifact),
        route_valid: false,
        routePath: artifact.routePath,
      });
      continue;
    }

    const key = artifactGroupKey(artifact);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        issueId: artifact.issueId,
        inputHash: artifact.inputHash,
        routePath: artifact.routePath,
        prompt: artifact.prompt,
        routeValid: true,
        routeDecision: artifact.routeDecision,
        routePrediction: artifact.routePrediction,
      });
      continue;
    }

    const existingPriority = filePriority(existing.routePath).priority;
    if (artifact.routePriority < existingPriority) {
      existing.routePath = artifact.routePath;
      existing.routeDecision = artifact.routeDecision;
      existing.routePrediction = artifact.routePrediction;
      existing.routeValid = true;
    }
    if (!existing.prompt && artifact.prompt) {
      existing.prompt = artifact.prompt;
    }
    if (!existing.inputHash && artifact.inputHash) {
      existing.inputHash = artifact.inputHash;
    }
    if (!existing.issueId && artifact.issueId) {
      existing.issueId = artifact.issueId;
    }
  }

  return {
    grouped: [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, value]) => value),
    invalidRecords,
  };
}

function completionSuccess(record: EvalRecord): boolean | undefined {
  if (record.outcomes && typeof record.outcomes.success === 'boolean') {
    return record.outcomes.success;
  }
  if (typeof record.score === 'number') {
    return isEvalSuccess(record);
  }
  return undefined;
}

function maxBudgetForRecord(
  evalRecord: EvalRecord | undefined,
  artifact: ArtifactGroup,
): number | undefined {
  const fromConstraints = evalRecord?.constraints?.maxCostUsd;
  if (typeof fromConstraints === 'number' && Number.isFinite(fromConstraints) && fromConstraints >= 0) {
    return fromConstraints;
  }

  const fromRoute = artifact.routeDecision?.maxCostUsd;
  if (typeof fromRoute === 'number' && Number.isFinite(fromRoute) && fromRoute >= 0) {
    return fromRoute;
  }

  return undefined;
}

function evalJoinKeys(record: EvalRecord): string[] {
  const keys: string[] = [];
  const inputHash = record.metadata?.inputHash;
  if (record.issueId && typeof inputHash === 'string' && inputHash.length > 0) {
    keys.push(`issue:${record.issueId}|hash:${inputHash}`);
  }
  if (record.issueId) {
    keys.push(`issue:${record.issueId}`);
  }
  keys.push(`record:${record.id}`);
  return keys;
}

function chooseEvalRecord(
  artifact: ArtifactGroup,
  evalByIssueAndHash: Map<string, EvalRecord>,
  evalByIssue: Map<string, EvalRecord>,
): EvalRecord | undefined {
  if (artifact.issueId && artifact.inputHash) {
    const exact = evalByIssueAndHash.get(`issue:${artifact.issueId}|hash:${artifact.inputHash}`);
    if (exact) {
      return exact;
    }
  }

  if (artifact.issueId) {
    return evalByIssue.get(`issue:${artifact.issueId}`);
  }

  return undefined;
}

function predictionForRecord(
  evalRecord: EvalRecord | undefined,
  artifact: ArtifactGroup,
): RoutePrediction | undefined {
  return evalRecord?.routePrediction ?? artifact.routePrediction;
}

async function routeArtifactBatch(
  artifacts: ArtifactGroup[],
  repoDir: string,
  modelsAvailable: string[] | undefined,
  modeOverride: RouteBatchOptions['mode'] | undefined,
  routeBatchImpl: NonNullable<RunWavemillRouterEvalOptions['routeBatchImpl']>,
): Promise<Map<string, WorkflowRouteDecision>> {
  const routable = artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter((entry) => Boolean(entry.artifact.prompt));
  const decisions = new Map<string, WorkflowRouteDecision>();

  if (routable.length === 0) {
    return decisions;
  }

  const groups = new Map<string, typeof routable>();
  for (const entry of routable) {
    const key = JSON.stringify({
      mode: modeOverride ?? entry.artifact.routeDecision?.routeMode,
      operatingMode: entry.artifact.routeDecision?.operatingMode,
      maxCostUsd: entry.artifact.routeDecision?.maxCostUsd,
    });
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  for (const [key, group] of groups.entries()) {
    const options = JSON.parse(key) as {
      mode?: RouteBatchOptions['mode'];
      operatingMode?: RouteBatchOptions['operatingMode'];
      maxCostUsd?: number;
    };
    const results = await routeBatchImpl(
      group.map(({ artifact }) => ({
        issueId: artifact.issueId,
        prompt: artifact.prompt as string,
      })),
      {
        repoDir,
        modelsAvailable,
        mode: options.mode,
        operatingMode: options.operatingMode,
        maxCostUsd: options.maxCostUsd,
      },
    );

    for (let index = 0; index < group.length; index += 1) {
      const decision = results[index]?.decision;
      if (decision) {
        decisions.set(group[index].artifact.routePath, decision);
      }
    }
  }

  return decisions;
}

function buildHemRecord(
  repoDir: string,
  policy: WavemillRouterMeasurementPolicy,
  score: WavemillRouterScoreResult,
  mintEligibility: MintEligibilityEvaluation,
  modelsAvailable?: string[],
  subagentModelEconomicsPolicy?: EvalSubagentModelEconomicsPolicyReport,
): EvalRecord {
  const aggregateScore = score.workflow_success_rate_under_budget;
  const constrainedModel = modelsAvailable?.length === 1 ? modelsAvailable[0] : undefined;
  const constrainedRouting: EvalRouting | undefined = constrainedModel
    ? {
        planner: {
          role: 'planner',
          requestedSelector: { kind: 'pinned', modelId: constrainedModel },
          resolvedModelId: constrainedModel,
          sourceLayer: 'wavemill-router-eval',
          resolutionSource: 'models-available',
        },
        coder: {
          role: 'coder',
          requestedSelector: { kind: 'pinned', modelId: constrainedModel },
          resolvedModelId: constrainedModel,
          sourceLayer: 'wavemill-router-eval',
          resolutionSource: 'models-available',
        },
        reviewer: {
          role: 'reviewer',
          requestedSelector: { kind: 'pinned', modelId: constrainedModel },
          resolvedModelId: constrainedModel,
          sourceLayer: 'wavemill-router-eval',
          resolutionSource: 'models-available',
        },
      }
    : undefined;

  return {
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: `Wavemill router eval (${policy})`,
    modelId: score.wavemill_router_scoring.scorer_id,
    modelVersion: 'v1',
    ...(constrainedModel ? { attempted_model: constrainedModel, model_alias: constrainedModel } : {}),
    score: aggregateScore,
    scoreBand: getScoreBand(aggregateScore).label,
    timeSeconds: null,
    timestamp: new Date().toISOString(),
    interventionRequired: score.wavemill_router_diagnostics.intervention_count > 0,
    interventionCount: score.wavemill_router_diagnostics.intervention_count,
    interventionDetails: [],
    rationale:
      `Wavemill router eval ${policy}: ` +
      `${score.wavemill_router_diagnostics.scoreable_records}/` +
      `${score.wavemill_router_diagnostics.total_records} scoreable records, ` +
      `success-under-budget=${aggregateScore}.`,
    agentType: 'wavemill-router-adapter',
    workflow_success_rate_under_budget: aggregateScore,
    wavemill_router_diagnostics: score.wavemill_router_diagnostics,
    wavemill_router_scoring: score.wavemill_router_scoring,
    metadata: {
      repoDir: relative(process.cwd(), repoDir) || '.',
      mintEligibility,
    },
    ...(constrainedRouting ? { routing: constrainedRouting } : {}),
    ...(subagentModelEconomicsPolicy ? { subagent_model_economics_policy: subagentModelEconomicsPolicy } : {}),
    taskDescriptor: buildTaskDescriptor({
      originalPrompt: `Wavemill router eval (${policy})`,
      score: aggregateScore,
      timeSeconds: undefined,
      interventionCount: score.wavemill_router_diagnostics.intervention_count,
      modelsAvailable: modelsAvailable && modelsAvailable.length > 0
        ? modelsAvailable
        : [score.wavemill_router_scoring.scorer_id],
      objective: 'balanced',
    }),
  };
}

export async function runWavemillRouterEval(
  options: RunWavemillRouterEvalOptions,
): Promise<RunWavemillRouterEvalResult> {
  const repoDir = resolve(options.repoDir);
  const persist = options.persist ?? true;
  const evidencePartition = partitionEvidence(
    readEvalRecords(options.evalsDir ? { dir: options.evalsDir } : undefined),
    'router_benchmark',
  );
  const evalRecords = evidencePartition.eligible;
  const artifacts = discoverArtifactFiles(repoDir, options.artifactsDir).map(parseRouteArtifact);
  const { grouped, invalidRecords } = groupArtifacts(artifacts);

  const evalByIssue = new Map<string, EvalRecord>();
  const evalByIssueAndHash = new Map<string, EvalRecord>();
  for (const record of evalRecords) {
    for (const key of evalJoinKeys(record)) {
      if (key.startsWith('issue:') && key.includes('|hash:')) {
        if (!evalByIssueAndHash.has(key)) {
          evalByIssueAndHash.set(key, record);
        }
      } else if (key.startsWith('issue:')) {
        if (!evalByIssue.has(key)) {
          evalByIssue.set(key, record);
        }
      }
    }
  }

  const matchedEvalIds = new Set<string>();
  const records: WavemillRouterEvalInputRecord[] = [...invalidRecords];
  const evalsByChallengePair = new Map<string, EvalRecord[]>();
  for (const record of evalRecords) {
    if (!record.challengePairId) {
      continue;
    }
    const existing = evalsByChallengePair.get(record.challengePairId) ?? [];
    existing.push(record);
    evalsByChallengePair.set(record.challengePairId, existing);
  }
  const shadowReports: SubagentEconomicsWorkflowReport[] = [];
  const batchRerouteDecisions = options.policy === 'challenge_prospective'
    ? await routeArtifactBatch(grouped, repoDir, options.modelsAvailable, undefined, options.routeBatchImpl ?? routeBatch)
    : new Map<string, WorkflowRouteDecision>();
  const batchShadowDecisions = options.policy === 'subagent_model_economics_shadow'
    ? await routeArtifactBatch(grouped, repoDir, options.modelsAvailable, 'stage-aware', options.routeBatchImpl ?? routeBatch)
    : new Map<string, WorkflowRouteDecision>();

  for (const artifact of grouped) {
    let routeDecision = artifact.routeDecision;
    let routeValid = Boolean(routeDecision);
    let proposedShadowDecision: WorkflowRouteDecision | null = null;

    if (options.policy === 'challenge_prospective') {
      const prospectiveDecision = batchRerouteDecisions.get(artifact.routePath);
      if (prospectiveDecision) {
        routeDecision = {
          planner: prospectiveDecision.planner,
          coder: prospectiveDecision.coder,
          reviewer: prospectiveDecision.reviewer,
          maxCostUsd: prospectiveDecision.constraints?.maxCostUsd,
          operatingMode: artifact.routeDecision?.operatingMode,
          routeMode: artifact.routeDecision?.routeMode,
        };
      } else {
        routeValid = false;
      }
    }

    const evalRecord = chooseEvalRecord(artifact, evalByIssueAndHash, evalByIssue);
    if (options.policy === 'subagent_model_economics_shadow') {
      proposedShadowDecision = batchShadowDecisions.get(artifact.routePath) ?? null;
    }
    const prediction = predictionForRecord(evalRecord, artifact);
    if (evalRecord) {
      matchedEvalIds.add(evalRecord.id);
    }

    if (options.policy === 'subagent_model_economics_shadow') {
      const pairedRecords = evalRecord?.challengePairId
        ? (evalsByChallengePair.get(evalRecord.challengePairId) ?? []).filter((record) => record.id !== evalRecord.id)
        : undefined;
      shadowReports.push(await runSubagentEconomicsShadowPolicy({
        repoDir,
        record: evalRecord,
        prompt: artifact.prompt,
        issueId: artifact.issueId,
        proposedDecision: proposedShadowDecision,
        modelsAvailable: options.modelsAvailable,
        maxCostUsd: maxBudgetForRecord(evalRecord, artifact),
        pairedRecords,
      }));
    }

    records.push({
      issueId: artifact.issueId,
      joinKey: artifact.issueId ? `issue:${artifact.issueId}` : `path:${artifact.routePath}`,
      route_valid: routeValid,
      routePath: artifact.routePath,
      routeDecision,
      evalRecordId: evalRecord?.id,
      completed_successfully: evalRecord ? completionSuccess(evalRecord) : undefined,
      actual_cost_usd: evalRecord?.workflowCost ?? evalRecord?.estimatedCost,
      max_cost_usd: maxBudgetForRecord(evalRecord, artifact),
      timing_ms:
        typeof evalRecord?.timeSeconds === 'number' && Number.isFinite(evalRecord.timeSeconds)
          ? Math.max(0, evalRecord.timeSeconds * 1000)
          : undefined,
      intervention_count:
        typeof evalRecord?.interventionCount === 'number'
          ? Math.max(0, evalRecord.interventionCount)
          : evalRecord?.interventions?.length,
      predicted_success: evalRecord?.routeCalibration?.predictedSuccess ?? prediction?.expectedSuccess,
      predicted_cost_usd: evalRecord?.routeCalibration?.predictedCostUsd ?? prediction?.expectedCostUsd,
      cost_error_usd: evalRecord?.routeCalibration?.costErrorUsd,
      success_delta: evalRecord?.routeCalibration?.successDelta,
    });
  }

  for (const evalRecord of evalRecords) {
    if (matchedEvalIds.has(evalRecord.id)) {
      continue;
    }

    records.push({
      issueId: evalRecord.issueId,
      joinKey: evalRecord.issueId ? `issue:${evalRecord.issueId}` : `record:${evalRecord.id}`,
      route_valid: false,
      evalRecordId: evalRecord.id,
      completed_successfully: completionSuccess(evalRecord),
      actual_cost_usd: evalRecord.workflowCost ?? evalRecord.estimatedCost,
      max_cost_usd:
        typeof evalRecord.constraints?.maxCostUsd === 'number'
          ? evalRecord.constraints.maxCostUsd
          : undefined,
      timing_ms:
        typeof evalRecord.timeSeconds === 'number' && Number.isFinite(evalRecord.timeSeconds)
          ? Math.max(0, evalRecord.timeSeconds * 1000)
          : undefined,
      intervention_count:
        typeof evalRecord.interventionCount === 'number'
          ? Math.max(0, evalRecord.interventionCount)
          : evalRecord.interventions?.length,
      predicted_success: evalRecord.routeCalibration?.predictedSuccess ?? evalRecord.routePrediction?.expectedSuccess,
      predicted_cost_usd: evalRecord.routeCalibration?.predictedCostUsd ?? evalRecord.routePrediction?.expectedCostUsd,
      cost_error_usd: evalRecord.routeCalibration?.costErrorUsd,
      success_delta: evalRecord.routeCalibration?.successDelta,
    });
  }

  const score = scoreWavemillSuccessRateUnderBudget(records, {
    measurementPolicy: options.policy,
  });
  const mintEligibility = meetsMintEligibility(
    score.wavemill_router_diagnostics,
    getMintEligibilityConfig(repoDir),
  );
  const subagentModelEconomicsPolicy = options.policy === 'subagent_model_economics_shadow'
    ? buildSubagentEconomicsReport(shadowReports)
    : undefined;
  const hemRecord = buildHemRecord(
    repoDir,
    options.policy,
    score,
    mintEligibility,
    options.modelsAvailable,
    subagentModelEconomicsPolicy,
  );

  if (persist) {
    appendEvalRecord(
      hemRecord,
      options.evalsDir ? { dir: options.evalsDir } : undefined,
    );
  }

  return {
    score,
    hemRecord,
    mintEligibility,
    records,
    ...(subagentModelEconomicsPolicy ? { subagentModelEconomicsPolicy } : {}),
    excludedEvidence: {
      count: evidencePartition.excluded.length,
      reasonCounts: evidencePartition.reasonCounts,
    },
  };
}

/**
 * Evaluate patch-selection accuracy against a replay corpus.
 * Loads instances from a manifest and scores a set of selections.
 */
export interface RunPatchSelectionEvalOptions {
  manifestPath: string;
  split?: 'train' | 'held-out' | 'all';
  modelsAvailable?: string[];
  repoDir: string;
  selections?: PatchSelectionSelections;
}

export interface PatchSelectionSelection {
  instanceId: string;
  selectedPatchOrId?: string;
  selectedCandidateId?: string;
  selectedPatch?: string;
}

export type PatchSelectionSelections =
  | Record<string, string | undefined>
  | PatchSelectionSelection[];

export interface RunPatchSelectionEvalResult {
  score: PatchSelectionScoreResult;
  hemRecord?: EvalRecord;
  loadInfo: ReturnType<typeof loadPatchSelectionCorpus>['splitInfo'];
}

function normalizePatchSelectionSelections(
  selections: PatchSelectionSelections | undefined,
): Map<string, string> {
  const normalized = new Map<string, string>();
  if (!selections) {
    return normalized;
  }

  if (Array.isArray(selections)) {
    for (const selection of selections) {
      const selectedPatchOrId =
        selection.selectedPatchOrId ??
        selection.selectedCandidateId ??
        selection.selectedPatch;
      if (selection.instanceId && selectedPatchOrId) {
        normalized.set(selection.instanceId, selectedPatchOrId);
      }
    }
    return normalized;
  }

  for (const [instanceId, selectedPatchOrId] of Object.entries(selections)) {
    if (selectedPatchOrId) {
      normalized.set(instanceId, selectedPatchOrId);
    }
  }
  return normalized;
}

/**
 * Score patch selections against the replay corpus.
 */
export async function runPatchSelectionEval(
  options: RunPatchSelectionEvalOptions,
): Promise<RunPatchSelectionEvalResult> {
  const corpus = loadPatchSelectionCorpus({
    manifestPath: options.manifestPath,
    split: options.split ?? 'train',
  });

  const selections = normalizePatchSelectionSelections(options.selections);
  const records: PatchSelectionScoreRecord[] = corpus.instances.map((instance) => ({
    instanceId: instance.id,
    selectedPatchOrId: selections.get(instance.id) ?? '',
    instance,
  }));

  const score = scorePatchSelection(records, {
    measurementPolicy: 'patch_selection',
  });

  return {
    score,
    loadInfo: corpus.splitInfo,
  };
}
