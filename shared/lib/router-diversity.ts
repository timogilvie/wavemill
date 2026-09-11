/**
 * Router diversity reporting.
 *
 * Aggregates per-model-per-stage usage from eval records to make routing
 * concentration visible: model share per stage over a recent window,
 * cumulative coverage versus a per-cell target, and routing-mode breakdown.
 *
 * @module router-diversity
 */

import type { EvalRecord } from './eval-schema.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';
import { recordStageModel } from './challenge-scheduler.ts';
import { stageInherited } from './challenge-execution-contract.ts';
import { getRouterConfig } from './config.ts';
import { getConfiguredModelsForDescriptorStage } from './model-registry.ts';
import { loadStageAwareEvalRecords } from './stage-aware-router.ts';

export const DIVERSITY_STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];

const STAGE_TO_ROLE: Record<ChallengeStage, 'planner' | 'coder' | 'reviewer'> = {
  plan: 'planner',
  implementation: 'coder',
  review: 'reviewer',
};

export const DEFAULT_COVERAGE_TARGET = 15;
export const DEFAULT_MAX_STAGE_SHARE = 0.7;
export const DEFAULT_WINDOW = 50;

export interface CoverageConfig {
  minRecordsPerModelStage?: number;
  maxStageShare?: number;
  window?: number;
}

export interface ResolvedCoverageConfig {
  minRecordsPerModelStage: number;
  maxStageShare: number;
  window: number;
}

export function resolveCoverageConfig(raw?: CoverageConfig): ResolvedCoverageConfig {
  return {
    minRecordsPerModelStage: Number.isInteger(raw?.minRecordsPerModelStage) && (raw?.minRecordsPerModelStage as number) > 0
      ? raw?.minRecordsPerModelStage as number
      : DEFAULT_COVERAGE_TARGET,
    maxStageShare: typeof raw?.maxStageShare === 'number' && Number.isFinite(raw.maxStageShare) && raw.maxStageShare > 0 && raw.maxStageShare <= 1
      ? raw.maxStageShare
      : DEFAULT_MAX_STAGE_SHARE,
    window: Number.isInteger(raw?.window) && (raw?.window as number) > 0
      ? raw?.window as number
      : DEFAULT_WINDOW,
  };
}

export interface StageShareEntry {
  model: string;
  count: number;
  share: number;
}

export interface DominanceWarning {
  stage: ChallengeStage;
  model: string;
  share: number;
  threshold: number;
}

export interface CoverageCell {
  model: string;
  stage: ChallengeStage;
  count: number;
  belowTarget: boolean;
}

export interface DiversityReport {
  recordsScanned: number;
  window: number;
  windowRecords: Record<ChallengeStage, number>;
  stageShares: Record<ChallengeStage, StageShareEntry[]>;
  dominanceWarnings: DominanceWarning[];
  coverageTarget: number;
  coverageCells: CoverageCell[];
  routingModes: Record<string, number>;
}

function recordTimestamp(record: EvalRecord): number {
  const parsed = Date.parse(record.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordRoutingMode(record: EvalRecord): string {
  const provenance = record.routeProvenance;
  return provenance?.routingMode
    || provenance?.activeRoute?.routingMode
    || provenance?.expandedRoute?.routingMode
    || provenance?.bootstrapRoute?.routingMode
    || 'unknown';
}

/**
 * Build the diversity report from eval records.
 *
 * Stage shares and routing-mode breakdown cover the most recent `window`
 * records (per stage, records lacking that stage's attribution are skipped).
 * Coverage counts are cumulative over all records, plus zero rows for
 * configured stage models that have produced no records yet.
 */
export function buildDiversityReport(
  records: EvalRecord[],
  options: {
    coverage: ResolvedCoverageConfig;
    configuredModels?: Partial<Record<ChallengeStage, string[]>>;
  },
): DiversityReport {
  const { coverage } = options;
  const sorted = [...records].sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
  const windowed = sorted.slice(0, coverage.window);

  const stageShares = {} as Record<ChallengeStage, StageShareEntry[]>;
  const windowRecords = {} as Record<ChallengeStage, number>;
  const dominanceWarnings: DominanceWarning[] = [];

  for (const stage of DIVERSITY_STAGES) {
    const counts = new Map<string, number>();
    for (const record of windowed) {
      if (stageInherited(record, stage)) {
        continue;
      }
      const model = recordStageModel(record, stage);
      if (!model) {
        continue;
      }
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    windowRecords[stage] = total;
    stageShares[stage] = [...counts.entries()]
      .map(([model, count]) => ({
        model,
        count,
        share: total > 0 ? count / total : 0,
      }))
      .sort((left, right) => right.count - left.count || left.model.localeCompare(right.model));

    for (const entry of stageShares[stage]) {
      if (total > 0 && entry.share > coverage.maxStageShare) {
        dominanceWarnings.push({
          stage,
          model: entry.model,
          share: entry.share,
          threshold: coverage.maxStageShare,
        });
      }
    }
  }

  // Cumulative coverage over all records, seeded with configured stage models
  // so zero-record models appear as below-target cells.
  const cumulative = new Map<ChallengeStage, Map<string, number>>(
    DIVERSITY_STAGES.map((stage) => [stage, new Map<string, number>()]),
  );
  for (const record of sorted) {
    for (const stage of DIVERSITY_STAGES) {
      if (stageInherited(record, stage)) {
        continue;
      }
      const model = recordStageModel(record, stage);
      if (!model) {
        continue;
      }
      const stageCounts = cumulative.get(stage)!;
      stageCounts.set(model, (stageCounts.get(model) ?? 0) + 1);
    }
  }

  const coverageCells: CoverageCell[] = [];
  for (const stage of DIVERSITY_STAGES) {
    const stageCounts = cumulative.get(stage)!;
    const models = new Set<string>([
      ...stageCounts.keys(),
      ...(options.configuredModels?.[stage] ?? []),
    ]);
    for (const model of [...models].sort()) {
      const count = stageCounts.get(model) ?? 0;
      coverageCells.push({
        model,
        stage,
        count,
        belowTarget: count < coverage.minRecordsPerModelStage,
      });
    }
  }

  const routingModes: Record<string, number> = {};
  for (const record of windowed) {
    const mode = recordRoutingMode(record);
    routingModes[mode] = (routingModes[mode] ?? 0) + 1;
  }

  return {
    recordsScanned: records.length,
    window: coverage.window,
    windowRecords,
    stageShares,
    dominanceWarnings,
    coverageTarget: coverage.minRecordsPerModelStage,
    coverageCells,
    routingModes,
  };
}

export function loadConfiguredStageModels(
  repoDir?: string,
): Partial<Record<ChallengeStage, string[]>> {
  const configured: Partial<Record<ChallengeStage, string[]>> = {};
  for (const stage of DIVERSITY_STAGES) {
    configured[stage] = getConfiguredModelsForDescriptorStage(repoDir, STAGE_TO_ROLE[stage]);
  }
  return configured;
}

/**
 * Load records and build the report using repo config for thresholds, with
 * CLI overrides taking precedence.
 */
export function generateDiversityReport(opts: {
  repoDir?: string;
  window?: number;
  minRecordsPerModelStage?: number;
  maxStageShare?: number;
} = {}): DiversityReport {
  const routerConfig = getRouterConfig(opts.repoDir);
  const coverage = resolveCoverageConfig({
    ...routerConfig.coverage,
    ...(opts.window !== undefined ? { window: opts.window } : {}),
    ...(opts.minRecordsPerModelStage !== undefined
      ? { minRecordsPerModelStage: opts.minRecordsPerModelStage }
      : {}),
    ...(opts.maxStageShare !== undefined ? { maxStageShare: opts.maxStageShare } : {}),
  });

  const records = loadStageAwareEvalRecords({ repoDir: opts.repoDir });
  return buildDiversityReport(records, {
    coverage,
    configuredModels: loadConfiguredStageModels(opts.repoDir),
  });
}

function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function formatDiversityReport(report: DiversityReport): string {
  const lines: string[] = [];
  lines.push(`Router diversity report — ${report.recordsScanned} eval records scanned, window ${report.window}`);
  lines.push('');

  for (const stage of DIVERSITY_STAGES) {
    const entries = report.stageShares[stage];
    lines.push(`Model share — ${stage} (last ${report.windowRecords[stage]} attributed records)`);
    if (entries.length === 0) {
      lines.push('  (no per-stage attribution in window)');
    } else {
      const width = Math.max(...entries.map((entry) => entry.model.length), 5);
      for (const entry of entries) {
        const flag = entry.share > 0 && report.dominanceWarnings.some(
          (warning) => warning.stage === stage && warning.model === entry.model,
        ) ? '  ⚠ dominant' : '';
        lines.push(`  ${entry.model.padEnd(width)}  ${String(entry.count).padStart(4)}  ${formatPercent(entry.share).padStart(6)}${flag}`);
      }
    }
    lines.push('');
  }

  lines.push(`Coverage vs target (${report.coverageTarget} records per model per stage)`);
  const cellModels = [...new Set(report.coverageCells.map((cell) => cell.model))].sort();
  const modelWidth = Math.max(...cellModels.map((model) => model.length), 5);
  lines.push(`  ${'model'.padEnd(modelWidth)}  ${'plan'.padStart(8)}  ${'impl'.padStart(8)}  ${'review'.padStart(8)}`);
  for (const model of cellModels) {
    const cellFor = (stage: ChallengeStage) => {
      const cell = report.coverageCells.find((entry) => entry.model === model && entry.stage === stage);
      if (!cell) return '-'.padStart(8);
      const value = `${cell.count}${cell.belowTarget ? '*' : ''}`;
      return value.padStart(8);
    };
    lines.push(`  ${model.padEnd(modelWidth)}  ${cellFor('plan')}  ${cellFor('implementation')}  ${cellFor('review')}`);
  }
  lines.push('  (* below coverage target)');
  lines.push('');

  lines.push('Routing modes (window)');
  const modes = Object.entries(report.routingModes).sort((left, right) => right[1] - left[1]);
  if (modes.length === 0) {
    lines.push('  (no records in window)');
  } else {
    for (const [mode, count] of modes) {
      lines.push(`  ${mode.padEnd(20)}  ${count}`);
    }
  }

  if (report.dominanceWarnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const warning of report.dominanceWarnings) {
      lines.push(`  ⚠ ${warning.model} holds ${formatPercent(warning.share)} of ${warning.stage} (threshold ${formatPercent(warning.threshold)})`);
    }
  }

  return lines.join('\n');
}
