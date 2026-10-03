/**
 * Routing health checks for the workflow router.
 *
 * Provides a lightweight diagnostic surface for verifying that routing has
 * enough local data to operate and for previewing a sample route decision.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWavemillConfig, getHokusaiRouterConfig } from './config.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import type { EvalRecord } from './eval-schema.ts';
import { loadRouterConfig } from './model-router.ts';
import { loadStageAwareEvalRecords } from './stage-aware-router.ts';
import { routeWorkflow, routeWorkflowStageAware, summarizeWorkflowRoute, type WorkflowRouteDecision } from './workflow-router.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { resolveGlobalAggregatedEvalsPath } from './evals-paths.ts';
import { resolveWavemillToolPath } from './native-agent/install-paths.ts';

const DEFAULT_SAMPLE_PROMPT = 'Fix a workflow routing failure, add diagnostics, and cover the edge cases with tests.';
const MILL_ROUTE_TOOL = resolveWavemillToolPath('route-task.ts');
const LOCAL_EVALS_PATH = '.wavemill/evals/evals.jsonl';
const BACKFILLED_EVALS_PATH = '.wavemill/evals/aggregated-evals.backfilled.jsonl';
const AGGREGATED_EVALS_PATH = '.wavemill/evals/aggregated-evals.jsonl';

export interface RoutingHealthSource {
  kind: 'local' | 'backfilled' | 'aggregated';
  path: string;
  exists: boolean;
  recordCount: number;
  modelCount: number;
  latestTimestamp: string | null;
  ageDays: number | null;
}

export interface RoutingHealthReport {
  status: 'ok' | 'warn';
  repoDir: string;
  routerEnabled: boolean;
  configuredMode: string;
  effectiveMode: 'heuristic' | 'stage-aware';
  minRecords: number;
  minModels: number;
  routeToolPresent: boolean;
  mergedRecordCount: number;
  mergedModelCount: number;
  stageAwareReady: boolean;
  samplePrompt: string;
  sampleDecision: WorkflowRouteDecision;
  sampleSummary: string;
  warnings: string[];
  sources: RoutingHealthSource[];
}

function latestTimestamp(records: EvalRecord[]): string | null {
  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort();
  return timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
}

function timestampAgeDays(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)));
}

function readSource(kind: RoutingHealthSource['kind'], filePath: string): RoutingHealthSource {
  if (!existsSync(filePath)) {
    return {
      kind,
      path: filePath,
      exists: false,
      recordCount: 0,
      modelCount: 0,
      latestTimestamp: null,
      ageDays: null,
    };
  }

  const records = readJsonlFile<EvalRecord>(filePath);
  const latest = latestTimestamp(records);
  return {
    kind,
    path: filePath,
    exists: true,
    recordCount: records.length,
    modelCount: new Set(records.map((record) => record.modelId).filter(Boolean)).size,
    latestTimestamp: latest,
    ageDays: timestampAgeDays(latest),
  };
}

function collectWarnings(params: {
  routerEnabled: boolean;
  configuredMode: string;
  minRecords: number;
  minModels: number;
  routeToolPresent: boolean;
  mergedRecordCount: number;
  mergedModelCount: number;
  stageAwareReady: boolean;
  sources: RoutingHealthSource[];
  repoDir: string;
}): string[] {
  const warnings: string[] = [];
  const hokusaiConfig = getHokusaiRouterConfig(params.repoDir);

  if (!params.routerEnabled) {
    warnings.push('Router is disabled in config.');
  }

  if (!params.routeToolPresent) {
    warnings.push(`Route tool missing at ${MILL_ROUTE_TOOL}.`);
  }

  if (!params.stageAwareReady) {
    warnings.push(
      `Stage-aware routing is below threshold: ${params.mergedRecordCount}/${params.minRecords} records and ${params.mergedModelCount}/${params.minModels} models.`,
    );
  }

  for (const source of params.sources) {
    if (!source.exists) {
      warnings.push(`Missing ${source.kind} eval source: ${source.path}`);
      continue;
    }
    if (source.ageDays !== null && source.ageDays > 30) {
      warnings.push(`${source.kind} eval data is stale (${source.ageDays} days old).`);
    }
  }

  if (params.configuredMode === 'hokusai' && !hokusaiConfig.endpoint) {
    warnings.push('Router mode is hokusai but no Hokusai endpoint is configured.');
  }

  return warnings;
}

function withRepoCwd<T>(repoDir: string, fn: () => T): T {
  const originalCwd = process.cwd();
  process.chdir(repoDir);
  try {
    return fn();
  } finally {
    process.chdir(originalCwd);
  }
}

export async function checkRoutingHealth(
  repoDir = process.cwd(),
  samplePrompt = DEFAULT_SAMPLE_PROMPT,
): Promise<RoutingHealthReport> {
  const resolvedRepoDir = resolve(repoDir);
  const config = loadWavemillConfig(resolvedRepoDir);
  const routerConfig = loadRouterConfig(resolvedRepoDir);
  const configuredMode = routerConfig.mode || 'heuristic';
  const minRecords = routerConfig.minRecords ?? 20;
  const minModels = routerConfig.minModels ?? 2;
  const sources: RoutingHealthSource[] = [
    readSource('local', resolve(resolvedRepoDir, LOCAL_EVALS_PATH)),
    readSource('backfilled', resolveFromMainRepo(BACKFILLED_EVALS_PATH, resolvedRepoDir)),
    readSource('aggregated', resolveFromMainRepo(AGGREGATED_EVALS_PATH, resolvedRepoDir)),
    readSource('aggregated', resolveGlobalAggregatedEvalsPath()),
  ];

  const mergedRecords = loadStageAwareEvalRecords({ repoDir: resolvedRepoDir });
  const mergedModelCount = new Set(mergedRecords.map((record) => record.modelId).filter(Boolean)).size;
  const mergedRecordCount = mergedRecords.length;
  const stageAwareReady = mergedRecordCount >= minRecords && mergedModelCount >= minModels;
  const effectiveMode = stageAwareReady ? 'stage-aware' : 'heuristic';
  const routeToolPresent = existsSync(MILL_ROUTE_TOOL);

  const sampleDecision = withRepoCwd(
    resolvedRepoDir,
    () => (stageAwareReady
      ? routeWorkflowStageAware(samplePrompt, { repoDir: resolvedRepoDir })
      : routeWorkflow(samplePrompt, { repoDir: resolvedRepoDir })),
  );

  const warnings = collectWarnings({
    routerEnabled: config.router?.enabled !== false,
    configuredMode,
    minRecords,
    minModels,
    routeToolPresent,
    mergedRecordCount,
    mergedModelCount,
    stageAwareReady,
    sources,
    repoDir: resolvedRepoDir,
  });

  return {
    status: warnings.length > 0 ? 'warn' : 'ok',
    repoDir: resolvedRepoDir,
    routerEnabled: config.router?.enabled !== false,
    configuredMode,
    effectiveMode,
    minRecords,
    minModels,
    routeToolPresent,
    mergedRecordCount,
    mergedModelCount,
    stageAwareReady,
    samplePrompt,
    sampleDecision,
    sampleSummary: summarizeWorkflowRoute(sampleDecision, resolvedRepoDir),
    warnings,
    sources,
  };
}

export function formatRoutingHealth(report: RoutingHealthReport): string {
  const lines = [
    `Routing health: ${report.status}`,
    `Configured mode: ${report.configuredMode}`,
    `Effective mode: ${report.effectiveMode}`,
    `Router enabled: ${report.routerEnabled ? 'yes' : 'no'}`,
    `Route tool present: ${report.routeToolPresent ? 'yes' : 'no'}`,
    `Merged eval data: ${report.mergedRecordCount} records across ${report.mergedModelCount} models (min ${report.minRecords}/${report.minModels})`,
    '',
    'Sources:',
  ];

  for (const source of report.sources) {
    const freshness = source.exists && source.ageDays !== null ? `${source.ageDays}d old` : 'n/a';
    lines.push(
      `- ${source.kind}: ${source.exists ? 'present' : 'missing'}; ${source.recordCount} records; ${source.modelCount} models; latest=${source.latestTimestamp || 'n/a'}; age=${freshness}`,
    );
  }

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push('', 'Sample route:', report.sampleSummary);
  return lines.join('\n');
}
