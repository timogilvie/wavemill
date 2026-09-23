import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectLeastUsedChallenger, type ChallengeSelectionReason } from './challenge-coverage-selector.ts';
import { getChallengeModelPoolFromConfig } from './challenge-mode.ts';
import type { EvalRecord, EvalRouteArtifact } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { readRouteLifecycleArtifacts, type RouteArtifactSnapshot } from './route-artifact.ts';
import type {
  OpenRouterDoctorCell,
  OpenRouterDoctorModelReport,
  OpenRouterDoctorReport,
  OpenRouterDoctorStage,
  OpenRouterDoctorReasonCode,
} from './openrouter-doctor.ts';

export interface RecentSelection {
  model: string;
  stage: OpenRouterDoctorStage;
  source: string;
  timestamp?: string;
  order: number;
}

export interface ZeroTrafficCell {
  modelId: string;
  stage: OpenRouterDoctorStage;
  observedSelections: number;
}

export interface ZeroTrafficNextChallengeModel {
  primaryModel: string | null;
  model: string | null;
  coverageCount: number;
  selectionReason: ChallengeSelectionReason | 'no-recent-primary-model' | 'no-eligible-candidate';
  eligibleCandidates: string[];
}

export interface ZeroTrafficAlert {
  lookback: number;
  observedSelections: number;
  eligibleOpenRouterCount: number;
  zeroTrafficCells: ZeroTrafficCell[];
  nextChallengeModel: ZeroTrafficNextChallengeModel | null;
  topBlockingReason: OpenRouterDoctorReasonCode | null;
  headline: string;
  details: string[];
}

interface CollectRecentSelectionsOptions {
  repoDir: string;
}

interface DetectZeroTrafficOptions {
  repoDir: string;
  report: OpenRouterDoctorReport;
  lookback?: number;
  recentSelections?: RecentSelection[];
}

const DOCTOR_STAGES: readonly OpenRouterDoctorStage[] = ['planner', 'coder', 'reviewer'];
const CHALLENGE_STAGE_BY_DOCTOR_STAGE: Record<OpenRouterDoctorStage, 'plan' | 'implementation' | 'review'> = {
  planner: 'plan',
  coder: 'implementation',
  reviewer: 'review',
};
const DOCTOR_STAGE_BY_CHALLENGE_STAGE: Record<'plan' | 'implementation' | 'review', OpenRouterDoctorStage> = {
  plan: 'planner',
  implementation: 'coder',
  review: 'reviewer',
};

function normalizeModelId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function pushSelection(
  selections: RecentSelection[],
  seen: Set<string>,
  input: Omit<RecentSelection, 'order'>,
): void {
  const model = normalizeModelId(input.model);
  if (!model) {
    return;
  }

  const key = `${input.timestamp ?? ''}|${input.source}|${input.stage}|${model}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  selections.push({
    ...input,
    model,
    order: selections.length,
  });
}

function readJsonlTolerant<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  const records: T[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed JSONL entries.
    }
  }
  return records;
}

function extractRouteArtifactSelections(
  route: EvalRouteArtifact | RouteArtifactSnapshot | null | undefined,
  source: string,
  timestamp: string | undefined,
  selections: RecentSelection[],
  seen: Set<string>,
): void {
  if (!route) {
    return;
  }

  pushSelection(selections, seen, { model: route.planner, stage: 'planner', source, timestamp });
  pushSelection(selections, seen, { model: route.coder, stage: 'coder', source, timestamp });
  pushSelection(selections, seen, { model: route.reviewer, stage: 'reviewer', source, timestamp });
}

function extractEvalSelections(record: EvalRecord, selections: RecentSelection[], seen: Set<string>): void {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  pushSelection(selections, seen, {
    model: record.modelId,
    stage: 'coder',
    source: 'eval:modelId',
    timestamp,
  });

  const routing = record.routing;
  pushSelection(selections, seen, {
    model: routing?.planner?.resolvedModelId,
    stage: 'planner',
    source: 'eval:routing.planner',
    timestamp,
  });
  pushSelection(selections, seen, {
    model: routing?.coder?.resolvedModelId,
    stage: 'coder',
    source: 'eval:routing.coder',
    timestamp,
  });
  pushSelection(selections, seen, {
    model: routing?.reviewer?.resolvedModelId,
    stage: 'reviewer',
    source: 'eval:routing.reviewer',
    timestamp,
  });

  const taskStages = record.taskDescriptor?.stages;
  pushSelection(selections, seen, {
    model: taskStages?.plan?.model,
    stage: 'planner',
    source: 'eval:taskDescriptor.plan',
    timestamp,
  });
  pushSelection(selections, seen, {
    model: taskStages?.implementation?.model,
    stage: 'coder',
    source: 'eval:taskDescriptor.implementation',
    timestamp,
  });
  pushSelection(selections, seen, {
    model: taskStages?.review?.model,
    stage: 'reviewer',
    source: 'eval:taskDescriptor.review',
    timestamp,
  });

  extractRouteArtifactSelections(record.routeProvenance?.bootstrapRoute, 'eval:route.bootstrap', timestamp, selections, seen);
  extractRouteArtifactSelections(record.routeProvenance?.expandedRoute, 'eval:route.expanded', timestamp, selections, seen);
  extractRouteArtifactSelections(record.routeProvenance?.activeRoute, 'eval:route.active', timestamp, selections, seen);
  extractRouteArtifactSelections(record.challengeRouteContext?.bootstrapRoute, 'eval:challenge.bootstrap', timestamp, selections, seen);
  extractRouteArtifactSelections(record.challengeRouteContext?.expandedRoute, 'eval:challenge.expanded', timestamp, selections, seen);

  if (record.challengeStageEval?.stage === 'plan') {
    pushSelection(selections, seen, {
      model: record.routing?.planner?.resolvedModelId ?? record.taskDescriptor?.stages?.plan?.model,
      stage: 'planner',
      source: `eval:challengeStage:${record.challengeStageEval.provenance}`,
      timestamp,
    });
  }
  if (record.challengeStageEval?.stage === 'review') {
    pushSelection(selections, seen, {
      model: record.routing?.reviewer?.resolvedModelId ?? record.taskDescriptor?.stages?.review?.model,
      stage: 'reviewer',
      source: `eval:challengeStage:${record.challengeStageEval.provenance}`,
      timestamp,
    });
  }
}

function listImmediateDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

function collectRouteArtifactSelections(
  repoDir: string,
  selections: RecentSelection[],
  seen: Set<string>,
): void {
  const featureDirs = listImmediateDirectories(join(repoDir, 'features'));
  for (const featureDir of featureDirs) {
    const slug = featureDir.split('/').pop() ?? featureDir;
    const artifacts = readRouteLifecycleArtifacts(featureDir);
    extractRouteArtifactSelections(artifacts.active, `feature:${slug}:active`, undefined, selections, seen);
    extractRouteArtifactSelections(artifacts.expanded, `feature:${slug}:expanded`, undefined, selections, seen);
    extractRouteArtifactSelections(artifacts.bootstrap, `feature:${slug}:bootstrap`, undefined, selections, seen);
  }

  const archiveRoot = join(resolveEvalsDir(undefined, repoDir).dir, 'artifacts');
  const archiveDirs = listImmediateDirectories(archiveRoot);
  for (const archiveDir of archiveDirs) {
    const issue = archiveDir.split('/').pop() ?? archiveDir;
    const artifacts = readRouteLifecycleArtifacts(undefined, archiveDir);
    extractRouteArtifactSelections(artifacts.active, `archive:${issue}:active`, undefined, selections, seen);
    extractRouteArtifactSelections(artifacts.expanded, `archive:${issue}:expanded`, undefined, selections, seen);
    extractRouteArtifactSelections(artifacts.bootstrap, `archive:${issue}:bootstrap`, undefined, selections, seen);
  }
}

export function collectRecentSelections(options: CollectRecentSelectionsOptions): RecentSelection[] {
  const repoDir = resolve(options.repoDir);
  const seen = new Set<string>();
  const selections: RecentSelection[] = [];
  const evalsFile = join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');
  const records = readJsonlTolerant<EvalRecord>(evalsFile)
    .sort((left, right) => {
      const leftTs = typeof left.timestamp === 'string' ? left.timestamp : '';
      const rightTs = typeof right.timestamp === 'string' ? right.timestamp : '';
      return rightTs.localeCompare(leftTs);
    });

  for (const record of records) {
    extractEvalSelections(record, selections, seen);
  }

  collectRouteArtifactSelections(repoDir, selections, seen);

  return selections.sort((left, right) => {
    if (left.timestamp && right.timestamp) {
      const byTimestamp = right.timestamp.localeCompare(left.timestamp);
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
    } else if (left.timestamp) {
      return -1;
    } else if (right.timestamp) {
      return 1;
    }

    return left.order - right.order;
  });
}

function candidateModels(report: OpenRouterDoctorReport): Set<string> {
  const models = new Set<string>();
  for (const entry of report.models) {
    for (const candidate of [entry.id, entry.alias, entry.nativeProviderId, entry.registryModelId]) {
      if (candidate) {
        models.add(candidate);
      }
    }
  }
  return models;
}

function countSelectionsForCell(
  entry: OpenRouterDoctorModelReport,
  cell: OpenRouterDoctorCell,
  observed: readonly RecentSelection[],
): number {
  const keys = new Set([entry.id, entry.alias, entry.nativeProviderId, entry.registryModelId].filter(Boolean));
  return observed.filter((selection) => selection.stage === cell.stage && keys.has(selection.model)).length;
}

function topBlockingReason(report: OpenRouterDoctorReport): OpenRouterDoctorReasonCode | null {
  return report.summary.topBlockingReasons[0]?.reason ?? null;
}

function resolveNextChallengeModel(
  repoDir: string,
  report: OpenRouterDoctorReport,
  observed: readonly RecentSelection[],
): ZeroTrafficNextChallengeModel | null {
  const challengePool = getChallengeModelPoolFromConfig(repoDir, 'implementation');
  const primaryModel = observed.find((selection) => selection.stage === 'coder')?.model ?? null;
  if (!primaryModel) {
    return {
      primaryModel: null,
      model: null,
      coverageCount: 0,
      selectionReason: 'no-recent-primary-model',
      eligibleCandidates: [],
    };
  }

  const eligibleCandidates = challengePool.filter((candidate) =>
    report.models.some((entry) =>
      [entry.id, entry.alias, entry.nativeProviderId, entry.registryModelId].includes(candidate)
      && entry.cells.some((cell) => cell.stage === 'coder' && cell.eligible)
    )
  );

  const selection = selectLeastUsedChallenger({
    stage: CHALLENGE_STAGE_BY_DOCTOR_STAGE.coder,
    primaryModel,
    candidates: challengePool,
    coverage: (model, stage) => observed.filter((selection) =>
      selection.model === model
      && selection.stage === DOCTOR_STAGE_BY_CHALLENGE_STAGE[stage]
    ).length,
    rotationSeed: `openrouter-doctor:${repoDir}:implementation`,
  });

  if (!selection.model) {
    return {
      primaryModel,
      model: null,
      coverageCount: 0,
      selectionReason: 'no-eligible-candidate',
      eligibleCandidates,
    };
  }

  return {
    primaryModel,
    model: selection.model,
    coverageCount: selection.coverageCount,
    selectionReason: selection.selectionReason,
    eligibleCandidates,
  };
}

export function detectZeroTraffic(options: DetectZeroTrafficOptions): ZeroTrafficAlert | null {
  const lookback = Number.isInteger(options.lookback) && (options.lookback as number) > 0
    ? options.lookback as number
    : 20;
  const recentSelections = options.recentSelections ?? collectRecentSelections({ repoDir: options.repoDir });
  const observed = recentSelections.slice(0, lookback);
  const configuredModels = candidateModels(options.report);

  if (options.report.summary.configuredModelCount === 0 || configuredModels.size === 0) {
    return null;
  }

  if (observed.some((selection) => configuredModels.has(selection.model))) {
    return null;
  }

  const eligibleOpenRouterCount = options.report.summary.eligibleModelCount;
  const zeroTrafficCells: ZeroTrafficCell[] = [];
  for (const entry of options.report.models) {
    for (const cell of entry.cells) {
      const observedSelections = countSelectionsForCell(entry, cell, observed);
      if (observedSelections === 0) {
        zeroTrafficCells.push({
          modelId: entry.id,
          stage: cell.stage,
          observedSelections,
        });
      }
    }
  }

  const blockingReason = topBlockingReason(options.report);
  const nextChallengeModel = resolveNextChallengeModel(options.repoDir, options.report, observed);
  const headline = observed.length === 0
    ? 'OpenRouter is configured, but recent route/eval history is unavailable.'
    : eligibleOpenRouterCount === 0
      ? `OpenRouter is configured, but no eligible candidates remain across the last ${lookback} checks.`
      : `OpenRouter is configured, but the last ${lookback} recent selections used no OpenRouter/native model.`;
  const details: string[] = [];

  if (eligibleOpenRouterCount === 0 && blockingReason) {
    details.push(`Top blocker: ${blockingReason}.`);
  } else {
    details.push(`Eligible configured models: ${eligibleOpenRouterCount}.`);
  }

  if (nextChallengeModel?.model) {
    details.push(`Next challenge candidate: ${nextChallengeModel.model} (${nextChallengeModel.selectionReason}).`);
  } else if (nextChallengeModel?.selectionReason === 'no-recent-primary-model') {
    details.push('Next challenge candidate unavailable: no recent primary implementation selection was found.');
  }

  return {
    lookback,
    observedSelections: observed.length,
    eligibleOpenRouterCount,
    zeroTrafficCells,
    nextChallengeModel,
    topBlockingReason: blockingReason,
    headline,
    details,
  };
}

export function renderZeroTrafficAlert(alert: ZeroTrafficAlert): string {
  return [alert.headline, ...alert.details.map((detail) => `  ${detail}`)].join('\n');
}
