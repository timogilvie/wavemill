import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMintEligibilityConfig } from './config.ts';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  validateContributionRow,
  type ContributionRow,
  type TechnicalTaskRouterContributionRowV1,
  type TechnicalTaskRouterContributionRowV2,
} from './hokusai-contribution-schema.ts';
import {
  type HokusaiDomain,
  mapTaskTypeToModel30,
  type HokusaiModel30EstimatedComplexity,
  type HokusaiModel30TaskType,
} from './hokusai-schema.ts';
import { resolveHokusaiQueuePaths, type HokusaiQueuePaths } from './hokusai-queue-paths.ts';
import type { HokusaiQueueEnvelope } from './hokusai-queue.ts';

export const DEFAULT_AUDIT_COVERAGE_THRESHOLD = 0.8;
export const DEFAULT_AUDIT_MAX_INVALID_RATE = 0.2;
export const DEFAULT_AUDIT_LOW_BUDGET_THRESHOLD_USD = 5;
export const DEFAULT_AUDIT_SPARSE_CELL_MIN_EVIDENCE = 2;

const ACCEPTED_SCORER_REFS = new Set([
  'technical_task_router.success_under_budget/v1',
  'technical_task_router.benchmark_score/v1',
  'technical_task_router.benchmark_score/v2',
]);

const REQUIRED_SCENARIOS = [
  'production',
  'challenger-present',
  'dominant-model-removed',
  'low-budget',
  'sparse-cell',
] as const;

type RequiredScenarioName = typeof REQUIRED_SCENARIOS[number];
type AuditLineSource = 'export' | 'queue';
// HOK-3415: Wavemill writes v4 rows; v1/v2 (and the historical submit_data
// shape) remain here so audit can read pre-cutover rows the queue still
// holds. `submit_data` is kept for incoming queue entries and is not
// produced by any writer.
type RowShape =
  | 'submit_data'
  | 'technical_task_router_row/v1'
  | 'technical_task_router_row/v2'
  | 'technical_task_router_row/v4';
type CoverageRole = 'planner' | 'coder' | 'reviewer';
type TechnicalTaskRouterBenchmarkRow =
  | TechnicalTaskRouterContributionRowV1
  | TechnicalTaskRouterContributionRowV2;
type ThresholdMode = 'warn' | 'fail';

export interface AuditThresholds {
  coverageThreshold: number;
  maxInvalidRate: number;
  lowBudgetThresholdUsd: number;
  sparseCellMinEvidence: number;
  thresholdMode: ThresholdMode;
}

export interface HokusaiAuditOptions {
  repoDir?: string;
  inputPath?: string;
  queue?: boolean;
  coverageThreshold?: number;
  maxInvalidRate?: number;
  lowBudgetThresholdUsd?: number;
  sparseCellMinEvidence?: number;
  thresholdMode?: ThresholdMode;
}

export interface AuditDiagnostic {
  line: number;
  severity: 'warning' | 'error';
  code: string;
  message: string;
}

export interface AuditConformanceSummary {
  source: AuditLineSource;
  path: string;
  totalLines: number;
  parsedLines: number;
  benchmarkRows: number;
  valid: number;
  invalid: number;
  unsupportedShape: number;
  malformedJson: number;
  v2CompliantRows: number;
  legacyRows: number;
  nonConformantRows: number;
  invalidRate: number;
  passed: boolean;
  diagnostics: AuditDiagnostic[];
}

export interface AuditGroupingSummary {
  taskType: string;
  domain: string;
  complexity: string;
  maxCostUsd?: number | null;
  rowCount: number;
}

export interface CandidateCoverageCell {
  grouping: 'descriptor' | 'model30';
  role: CoverageRole;
  taskType: string;
  domain: string;
  complexity: string;
  currentCandidates: string[];
  evidenceByCandidate: Record<string, number>;
  zeroEvidenceCandidates: string[];
  candidatesWithEvidence: number;
  coverage: number;
  evidenceRowCount: number;
}

export interface CandidateCoverageSummary {
  threshold: number;
  cells: CandidateCoverageCell[];
  belowThreshold: CandidateCoverageCell[];
}

export interface ScenarioShare {
  scenario: RequiredScenarioName;
  numerator: number;
  denominator: number;
  share: number;
}

export interface HokusaiAuditReport {
  source: {
    kind: AuditLineSource;
    path: string;
  };
  thresholds: AuditThresholds;
  conformance: AuditConformanceSummary;
  candidatePoolCoverage: CandidateCoverageSummary;
  groupings: {
    descriptor: AuditGroupingSummary[];
    model30: AuditGroupingSummary[];
  };
  scenarioShares: ScenarioShare[];
  warnings: string[];
  failures: string[];
}

interface LoadedAuditLine {
  line: number;
  source: AuditLineSource;
  raw: unknown;
  shape: RowShape | 'unknown';
}

interface AuditedBenchmarkRow {
  line: number;
  shape: 'technical_task_router_row/v1' | 'technical_task_router_row/v2';
  row: TechnicalTaskRouterBenchmarkRow & Record<string, unknown>;
  descriptorGrouping: DescriptorGrouping;
  model30Grouping: Model30Grouping;
  explicitScenarios: Set<RequiredScenarioName>;
}

interface DescriptorGrouping {
  taskType: string;
  domain: string;
  complexity: string;
}

interface Model30Grouping {
  taskType: HokusaiModel30TaskType;
  domain: Exclude<HokusaiDomain, 'unknown'> | 'unknown';
  complexity: HokusaiModel30EstimatedComplexity | 'unknown';
  maxCostUsd: number | null;
}

interface ParsedLineResult {
  line: number;
  parsed?: unknown;
  malformed?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeThresholdMode(value: string | undefined): ThresholdMode {
  return value === 'fail' ? 'fail' : 'warn';
}

function createThresholds(options: HokusaiAuditOptions): AuditThresholds {
  const mintConfig = getMintEligibilityConfig(options.repoDir);
  return {
    coverageThreshold: options.coverageThreshold ?? mintConfig?.coverageThreshold ?? DEFAULT_AUDIT_COVERAGE_THRESHOLD,
    maxInvalidRate: options.maxInvalidRate ?? mintConfig?.maxInvalidRouteRate ?? DEFAULT_AUDIT_MAX_INVALID_RATE,
    lowBudgetThresholdUsd: options.lowBudgetThresholdUsd ?? DEFAULT_AUDIT_LOW_BUDGET_THRESHOLD_USD,
    sparseCellMinEvidence: options.sparseCellMinEvidence ?? DEFAULT_AUDIT_SPARSE_CELL_MIN_EVIDENCE,
    thresholdMode: normalizeThresholdMode(options.thresholdMode),
  };
}

function resolveAuditSource(options: HokusaiAuditOptions): { source: AuditLineSource; path: string } {
  if (options.inputPath) {
    return {
      source: 'export',
      path: resolve(options.inputPath),
    };
  }

  const paths: HokusaiQueuePaths = resolveHokusaiQueuePaths(options.repoDir);
  return {
    source: 'queue',
    path: paths.pendingPath,
  };
}

function parseJsonl(content: string): ParsedLineResult[] {
  return content.split('\n').flatMap((line, index) => {
    if (!line.trim()) {
      return [];
    }

    try {
      return [{ line: index + 1, parsed: JSON.parse(line) as unknown }];
    } catch (error) {
      return [{
        line: index + 1,
        malformed: error instanceof Error ? error.message : 'Failed to parse JSON',
      }];
    }
  });
}

function getRowShape(value: unknown): RowShape | 'unknown' {
  if (!isPlainObject(value)) {
    return 'unknown';
  }

  if (value.schemaVersion === '1.0' && 'row' in value) {
    const envelope = value as Partial<HokusaiQueueEnvelope>;
    if (
      envelope.rowShape === 'submit_data'
      || envelope.rowShape === 'technical_task_router_row/v1'
      || envelope.rowShape === 'technical_task_router_row/v4'
    ) {
      return envelope.rowShape;
    }
  }

  if (value.schema_version === 'technical_task_router_row/v1') {
    return 'technical_task_router_row/v1';
  }

  if (value.schema_version === 'technical_task_router_row/v4') {
    return 'technical_task_router_row/v4';
  }

  if (!('schema_version' in value) && typeof value.success_under_budget === 'boolean') {
    return 'submit_data';
  }

  return 'unknown';
}

function loadAuditLines(options: HokusaiAuditOptions): {
  source: AuditLineSource;
  path: string;
  lines: LoadedAuditLine[];
  malformed: AuditDiagnostic[];
} {
  const { source, path } = resolveAuditSource(options);
  if (!existsSync(path)) {
    return { source, path, lines: [], malformed: [] };
  }

  const content = readFileSync(path, 'utf-8');
  const parsed = parseJsonl(content);
  const lines: LoadedAuditLine[] = [];
  const malformed: AuditDiagnostic[] = [];

  for (const entry of parsed) {
    if (entry.malformed) {
      malformed.push({
        line: entry.line,
        severity: 'error',
        code: 'malformed_json',
        message: entry.malformed,
      });
      continue;
    }

    const raw = entry.parsed;
    lines.push({
      line: entry.line,
      source,
      raw,
      shape: getRowShape(raw),
    });
  }

  return { source, path, lines, malformed };
}

function unwrapContribution(raw: unknown): ContributionRow | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  if (raw.schemaVersion === '1.0' && 'row' in raw) {
    return raw.row as ContributionRow;
  }

  return raw as ContributionRow;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());

  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function coerceScenarioNames(value: unknown): Set<RequiredScenarioName> {
  const accepted = new Set<RequiredScenarioName>();
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

  for (const entry of values) {
    if (typeof entry !== 'string') {
      continue;
    }

    if ((REQUIRED_SCENARIOS as readonly string[]).includes(entry)) {
      accepted.add(entry as RequiredScenarioName);
    }
  }

  return accepted;
}

function extractExplicitScenarios(row: Record<string, unknown>): Set<RequiredScenarioName> {
  const candidates = [
    row.scenario,
    row.scenarios,
    isPlainObject(row.audit_metadata) ? row.audit_metadata.scenario : undefined,
    isPlainObject(row.audit_metadata) ? row.audit_metadata.scenarios : undefined,
    isPlainObject(row.benchmark_metadata) ? row.benchmark_metadata.scenario : undefined,
    isPlainObject(row.benchmark_metadata) ? row.benchmark_metadata.scenarios : undefined,
  ];

  for (const value of candidates) {
    const scenarios = coerceScenarioNames(value);
    if (scenarios.size > 0) {
      return scenarios;
    }
  }

  return new Set();
}

function getDescriptorGrouping(row: TechnicalTaskRouterBenchmarkRow): DescriptorGrouping {
  return {
    taskType: row.task_descriptor.task_type,
    domain: row.task_descriptor.domain,
    complexity: String(row.task_descriptor.complexity),
  };
}

function toModel30Complexity(complexity: number): HokusaiModel30EstimatedComplexity | 'unknown' {
  if (!Number.isFinite(complexity)) {
    return 'unknown';
  }

  if (complexity >= 7) return 'high';
  if (complexity >= 3) return 'medium';
  return 'low';
}

function getModel30Grouping(row: TechnicalTaskRouterBenchmarkRow): Model30Grouping {
  return {
    taskType: mapTaskTypeToModel30(row.task_descriptor.task_type, {
      hasMigration: row.task_descriptor.is_migration,
    }),
    domain: row.task_descriptor.domain === 'unknown' ? 'unknown' : row.task_descriptor.domain,
    complexity: toModel30Complexity(row.task_descriptor.complexity),
    maxCostUsd: typeof row.budget_usd === 'number' && Number.isFinite(row.budget_usd) ? row.budget_usd : null,
  };
}

function extractCandidatePool(
  row: TechnicalTaskRouterBenchmarkRow & Record<string, unknown>,
  role: CoverageRole,
): string[] {
  const sources: unknown[] = [];
  const rootPools = isPlainObject(row.candidate_pools) ? row.candidate_pools : undefined;
  const auditPools = isPlainObject(row.audit_metadata) && isPlainObject(row.audit_metadata.candidate_pools)
    ? row.audit_metadata.candidate_pools
    : undefined;
  const currentPools = isPlainObject(row.current_candidate_pools) ? row.current_candidate_pools : undefined;
  const availableModels = isPlainObject(row.available_models) ? row.available_models : undefined;

  if (rootPools) {
    sources.push(rootPools[role]);
    if (isPlainObject(rootPools.current)) {
      sources.push(rootPools.current[role]);
    }
  }
  if (auditPools) {
    sources.push(auditPools[role]);
    if (isPlainObject(auditPools.current)) {
      sources.push(auditPools.current[role]);
    }
  }
  if (currentPools) {
    sources.push(currentPools[role]);
  }
  if (availableModels) {
    sources.push(availableModels[`${role}_models`]);
  }
  sources.push(row.allowed_models);

  for (const source of sources) {
    const pool = coerceStringArray(source);
    if (pool) {
      return pool;
    }
  }

  return [];
}

function recordGroupingCount<T extends { rowCount: number }>(
  map: Map<string, T>,
  key: string,
  value: Omit<T, 'rowCount'>,
): void {
  const current = map.get(key);
  if (current) {
    current.rowCount += 1;
    return;
  }

  map.set(key, { ...value, rowCount: 1 } as T);
}

function buildCoverageCells(
  rows: AuditedBenchmarkRow[],
  grouping: 'descriptor' | 'model30',
): CandidateCoverageCell[] {
  const accumulator = new Map<string, CandidateCoverageCell>();

  for (const entry of rows) {
    const group = grouping === 'descriptor' ? entry.descriptorGrouping : entry.model30Grouping;

    for (const role of ['planner', 'coder', 'reviewer'] as const) {
      const currentCandidates = extractCandidatePool(entry.row, role);
      const key = [
        grouping,
        role,
        group.taskType,
        group.domain,
        group.complexity,
      ].join('|');
      const selected = entry.row.selected_models[role];
      const existing = accumulator.get(key) ?? {
        grouping,
        role,
        taskType: group.taskType,
        domain: group.domain,
        complexity: group.complexity,
        currentCandidates: [],
        evidenceByCandidate: {},
        zeroEvidenceCandidates: [],
        candidatesWithEvidence: 0,
        coverage: 0,
        evidenceRowCount: 0,
      };

      if (selected) {
        existing.evidenceRowCount += 1;
        existing.evidenceByCandidate[selected] = (existing.evidenceByCandidate[selected] ?? 0) + 1;
      }

      for (const candidate of currentCandidates) {
        if (!existing.currentCandidates.includes(candidate)) {
          existing.currentCandidates.push(candidate);
        }
      }

      accumulator.set(key, existing);
    }
  }

  const cells = [...accumulator.values()];
  for (const cell of cells) {
    cell.currentCandidates.sort();
    cell.zeroEvidenceCandidates = cell.currentCandidates.filter((candidate) => !cell.evidenceByCandidate[candidate]);
    cell.candidatesWithEvidence = cell.currentCandidates.filter((candidate) => cell.evidenceByCandidate[candidate] > 0).length;
    cell.coverage = cell.currentCandidates.length > 0
      ? cell.candidatesWithEvidence / cell.currentCandidates.length
      : 0;
  }

  return cells.sort((a, b) =>
    a.grouping.localeCompare(b.grouping)
    || a.role.localeCompare(b.role)
    || a.taskType.localeCompare(b.taskType)
    || a.domain.localeCompare(b.domain)
    || a.complexity.localeCompare(b.complexity)
  );
}

function inferScenarios(
  row: AuditedBenchmarkRow,
  thresholds: AuditThresholds,
  sparseDescriptorKeys: Set<string>,
  sparseModel30Keys: Set<string>,
): Set<RequiredScenarioName> {
  const scenarios = new Set<RequiredScenarioName>(row.explicitScenarios);

  if (
    typeof row.row.budget_usd === 'number'
    && Number.isFinite(row.row.budget_usd)
    && row.row.budget_usd <= thresholds.lowBudgetThresholdUsd
  ) {
    scenarios.add('low-budget');
  }

  const descriptorKey = [
    row.descriptorGrouping.taskType,
    row.descriptorGrouping.domain,
    row.descriptorGrouping.complexity,
  ].join('|');
  const model30Key = [
    row.model30Grouping.taskType,
    row.model30Grouping.domain,
    row.model30Grouping.complexity,
  ].join('|');
  if (sparseDescriptorKeys.has(descriptorKey) || sparseModel30Keys.has(model30Key)) {
    scenarios.add('sparse-cell');
  }

  if (scenarios.size === 0) {
    scenarios.add('production');
  }

  return scenarios;
}

function buildSparseCellKeys(
  rows: AuditedBenchmarkRow[],
  thresholds: AuditThresholds,
): { descriptor: Set<string>; model30: Set<string> } {
  const descriptorCounts = new Map<string, number>();
  const model30Counts = new Map<string, number>();

  for (const row of rows) {
    const descriptorKey = [
      row.descriptorGrouping.taskType,
      row.descriptorGrouping.domain,
      row.descriptorGrouping.complexity,
    ].join('|');
    descriptorCounts.set(descriptorKey, (descriptorCounts.get(descriptorKey) ?? 0) + 1);

    const model30Key = [
      row.model30Grouping.taskType,
      row.model30Grouping.domain,
      row.model30Grouping.complexity,
    ].join('|');
    model30Counts.set(model30Key, (model30Counts.get(model30Key) ?? 0) + 1);
  }

  return {
    descriptor: new Set(
      [...descriptorCounts.entries()]
        .filter(([, count]) => count < thresholds.sparseCellMinEvidence)
        .map(([key]) => key),
    ),
    model30: new Set(
      [...model30Counts.entries()]
        .filter(([, count]) => count < thresholds.sparseCellMinEvidence)
        .map(([key]) => key),
    ),
  };
}

function buildScenarioShares(rows: AuditedBenchmarkRow[], thresholds: AuditThresholds): ScenarioShare[] {
  const sparse = buildSparseCellKeys(rows, thresholds);
  const counts = new Map<RequiredScenarioName, number>(REQUIRED_SCENARIOS.map((name) => [name, 0]));

  for (const row of rows) {
    const scenarios = inferScenarios(row, thresholds, sparse.descriptor, sparse.model30);
    for (const scenario of scenarios) {
      counts.set(scenario, (counts.get(scenario) ?? 0) + 1);
    }
  }

  const denominator = rows.length;
  return REQUIRED_SCENARIOS.map((scenario) => {
    const numerator = counts.get(scenario) ?? 0;
    return {
      scenario,
      numerator,
      denominator,
      share: denominator > 0 ? numerator / denominator : 0,
    };
  });
}

function isV2CompliantBenchmarkRow(
  row: TechnicalTaskRouterBenchmarkRow & Record<string, unknown>,
): { ok: true; legacy: boolean } | { ok: false; reason: string } {
  if (!ACCEPTED_SCORER_REFS.has(row.scorer_ref ?? '')) {
    return {
      ok: false,
      reason: `Unsupported scorer_ref "${row.scorer_ref ?? 'missing'}"`,
    };
  }

  if (!Array.isArray(row.allowed_models) || row.allowed_models.length === 0) {
    return {
      ok: false,
      reason: 'allowed_models must contain at least one model',
    };
  }

  const selected = row.selected_models;
  if (!selected.coder || !selected.reviewer) {
    return {
      ok: false,
      reason: 'selected_models must include coder and reviewer',
    };
  }

  const scenarios = [
    row.scenario,
    row.scenarios,
    isPlainObject(row.audit_metadata) ? row.audit_metadata.scenario : undefined,
    isPlainObject(row.audit_metadata) ? row.audit_metadata.scenarios : undefined,
  ];
  for (const value of scenarios) {
    if (value == null) {
      continue;
    }

    const explicit = Array.isArray(value) ? value : [value];
    for (const entry of explicit) {
      if (typeof entry !== 'string' || !(REQUIRED_SCENARIOS as readonly string[]).includes(entry)) {
        return {
          ok: false,
          reason: `Unsupported scenario name "${String(entry)}"`,
        };
      }
    }
  }

  return {
    ok: true,
    legacy: row.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2
      && row.scorer_ref !== 'technical_task_router.benchmark_score/v2',
  };
}

function summarizeReport(
  source: AuditLineSource,
  path: string,
  lines: LoadedAuditLine[],
  malformed: AuditDiagnostic[],
  thresholds: AuditThresholds,
): HokusaiAuditReport {
  const diagnostics: AuditDiagnostic[] = [...malformed];
  const benchmarkRows: AuditedBenchmarkRow[] = [];
  let valid = 0;
  let invalid = 0;
  let unsupportedShape = 0;
  let v2CompliantRows = 0;
  let legacyRows = 0;

  const descriptorGroupings = new Map<string, AuditGroupingSummary>();
  const model30Groupings = new Map<string, AuditGroupingSummary>();

  for (const line of lines) {
    const candidate = unwrapContribution(line.raw);
    if (!candidate) {
      unsupportedShape += 1;
      diagnostics.push({
        line: line.line,
        severity: 'error',
        code: 'unsupported_shape',
        message: 'Line does not match a supported contribution row shape',
      });
      continue;
    }

    let validated: ContributionRow;
    try {
      validated = validateContributionRow(candidate);
      valid += 1;
    } catch (error) {
      invalid += 1;
      diagnostics.push({
        line: line.line,
        severity: 'error',
        code: 'schema_validation_failed',
        message: error instanceof Error ? error.message : 'Contribution row validation failed',
      });
      continue;
    }

    if (
      !('schema_version' in validated)
      || (
        validated.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION
        && validated.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2
      )
    ) {
      continue;
    }

    const row = validated as TechnicalTaskRouterBenchmarkRow & Record<string, unknown>;
    const v2 = isV2CompliantBenchmarkRow(row);
    if (!v2.ok) {
      diagnostics.push({
        line: line.line,
        severity: 'error',
        code: 'v2_conformance_failed',
        message: v2.reason,
      });
    } else {
      v2CompliantRows += 1;
      if (v2.legacy) {
        legacyRows += 1;
      }
    }

    const descriptorGrouping = getDescriptorGrouping(row);
    const model30Grouping = getModel30Grouping(row);
    benchmarkRows.push({
      line: line.line,
      shape: row.schema_version,
      row,
      descriptorGrouping,
      model30Grouping,
      explicitScenarios: extractExplicitScenarios(row),
    });

    recordGroupingCount(descriptorGroupings, [
      descriptorGrouping.taskType,
      descriptorGrouping.domain,
      descriptorGrouping.complexity,
    ].join('|'), descriptorGrouping);

    recordGroupingCount(model30Groupings, [
      model30Grouping.taskType,
      model30Grouping.domain,
      model30Grouping.complexity,
      model30Grouping.maxCostUsd ?? 'none',
    ].join('|'), {
      taskType: model30Grouping.taskType,
      domain: model30Grouping.domain,
      complexity: model30Grouping.complexity,
      maxCostUsd: model30Grouping.maxCostUsd,
    });
  }

  const conformanceErrors = diagnostics.filter((entry) => entry.severity === 'error');
  const nonConformantRows = invalid + unsupportedShape + malformed.length + conformanceErrors.filter((entry) => entry.code === 'v2_conformance_failed').length;
  const totalLines = lines.length + malformed.length;
  const invalidRate = totalLines > 0 ? nonConformantRows / totalLines : 0;
  const candidatePoolCoverageCells = buildCoverageCells(benchmarkRows, 'descriptor');
  const model30CoverageCells = buildCoverageCells(benchmarkRows, 'model30');
  const coverageCells = [...candidatePoolCoverageCells, ...model30CoverageCells];
  const belowThreshold = coverageCells.filter((cell) =>
    cell.currentCandidates.length > 0 && cell.coverage < thresholds.coverageThreshold
  );
  const scenarioShares = buildScenarioShares(benchmarkRows, thresholds);

  const warnings: string[] = [];
  const failures: string[] = [];

  if (invalidRate > thresholds.maxInvalidRate) {
    const message = `Conformance invalid rate ${invalidRate.toFixed(3)} exceeds ${thresholds.maxInvalidRate.toFixed(3)}`;
    if (thresholds.thresholdMode === 'fail') {
      failures.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (belowThreshold.length > 0) {
    const message = `${belowThreshold.length} coverage cell(s) fell below ${thresholds.coverageThreshold.toFixed(3)}`;
    if (thresholds.thresholdMode === 'fail') {
      failures.push(message);
    } else {
      warnings.push(message);
    }
  }

  return {
    source: { kind: source, path },
    thresholds,
    conformance: {
      source,
      path,
      totalLines,
      parsedLines: lines.length,
      benchmarkRows: benchmarkRows.length,
      valid,
      invalid,
      unsupportedShape,
      malformedJson: malformed.length,
      v2CompliantRows,
      legacyRows,
      nonConformantRows,
      invalidRate,
      passed: failures.length === 0 && conformanceErrors.length === 0,
      diagnostics: diagnostics.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code)),
    },
    candidatePoolCoverage: {
      threshold: thresholds.coverageThreshold,
      cells: coverageCells,
      belowThreshold,
    },
    groupings: {
      descriptor: [...descriptorGroupings.values()],
      model30: [...model30Groupings.values()],
    },
    scenarioShares,
    warnings,
    failures,
  };
}

export function auditHokusaiContributions(options: HokusaiAuditOptions = {}): HokusaiAuditReport {
  const thresholds = createThresholds(options);
  const { source, path, lines, malformed } = loadAuditLines(options);
  return summarizeReport(source, path, lines, malformed, thresholds);
}

export function renderHokusaiAuditReport(report: HokusaiAuditReport): string {
  const lines: string[] = [];
  lines.push(`Source: ${report.source.kind} ${report.source.path}`);
  lines.push(
    `Conformance: ${report.conformance.passed ? 'pass' : 'check'} `
    + `(valid=${report.conformance.valid} invalid=${report.conformance.invalid} `
    + `unsupported=${report.conformance.unsupportedShape} malformed=${report.conformance.malformedJson} `
    + `v2=${report.conformance.v2CompliantRows}/${report.conformance.benchmarkRows})`,
  );
  lines.push(
    `Coverage: ${report.candidatePoolCoverage.belowThreshold.length} below threshold `
    + `(threshold=${report.thresholds.coverageThreshold.toFixed(2)})`,
  );
  lines.push(
    `Scenario shares: ${report.scenarioShares.map((entry) =>
      `${entry.scenario}=${entry.numerator}/${entry.denominator}`
    ).join(' ')}`,
  );

  if (report.failures.length > 0) {
    lines.push(`Failures: ${report.failures.join('; ')}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`Warnings: ${report.warnings.join('; ')}`);
  }

  const zeroEvidenceCells = report.candidatePoolCoverage.cells.filter((cell) => cell.zeroEvidenceCandidates.length > 0);
  if (zeroEvidenceCells.length > 0) {
    const sample = zeroEvidenceCells.slice(0, 5).map((cell) =>
      `${cell.grouping}/${cell.role}/${cell.taskType}/${cell.domain}/${cell.complexity}: ${cell.zeroEvidenceCandidates.join(',')}`
    );
    lines.push(`Zero-evidence candidates: ${sample.join(' | ')}`);
  }

  return `${lines.join('\n')}\n`;
}
