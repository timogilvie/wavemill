/**
 * SDK cost-migration comparator and release gate (HOK-3076).
 *
 * Runs the legacy engine and the SDK bridge on the same inputs, reduces both
 * outcomes to one like-for-like view (total, per-model tokens and dollars,
 * session/turn counts, coverage, pricing entries, status), and classifies
 * every difference as an SDK bug, a legacy bug, an intentional contract
 * change, or unpriced data. A difference no rule explains is `unexplained`
 * and fails the gate, as does any `sdk_bug` and any coverage invariant
 * violation (a partial/unavailable cost reported as complete or known-zero).
 *
 * Inputs never leave the machine: fixture cases are materialized into a temp
 * sandbox, and the historical mode reads only the cost fields of local eval
 * records — no transcript text is read or emitted.
 *
 * @module cost-migration
 */

import {
  captureCaseOutcomes,
  deepDiff,
  legacyEngine,
  sdkEngine,
  type CostParityCaseOutcomes,
} from './cost-parity.ts';
import type { CostParityCase, CostParityManifest } from '../fixtures/cost-parity/schema.ts';
import type { EvalRecord } from './eval-schema.ts';
import {
  projectTaskCostSummaryToWorkflowCost,
  selectPrimaryTaskCostSummary,
  type TaskCostSummaryV1,
} from './sdk-task-cost/index.ts';
import { toTaskCostModel } from './sdk-task-cost/events-from-session.ts';
import type { PricingTable, WorkflowCostOutcome } from './workflow-cost.ts';

export const COST_MIGRATION_REPORT_SCHEMA_VERSION = 'cost_migration_report/v1';

export type CostDifferenceClassification =
  | 'sdk_bug'
  | 'legacy_bug'
  | 'intentional_contract_change'
  | 'unpriced_data'
  | 'unexplained';

/** Classifications that keep the release gate closed. */
const BLOCKING_CLASSIFICATIONS: ReadonlySet<CostDifferenceClassification> = new Set(['sdk_bug', 'unexplained']);

/** Like-for-like projection of one engine's outcome. Paths mirror `WorkflowCostResult`. */
export interface ComparableCostView {
  status: WorkflowCostOutcome['status'];
  totalCostUsd?: number;
  sessionCount?: number;
  turnCount?: number;
  models?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  }>;
  pricingModels?: string[];
  attribution?: {
    coverage: string;
    reason: string | null;
    pricedSessions: number;
    unpricedSessions: number;
    models: Record<string, {
      provider: string;
      priced: boolean;
      costUsd: number | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }>;
  };
}

export interface CostMigrationDifference {
  path: string;
  legacy: unknown;
  sdk: unknown;
  classification: CostDifferenceClassification;
  /** Rule or expected-fix id that explained the difference. */
  ruleId?: string;
  rationale?: string;
}

/** The SDK summary fields a reviewer needs; never transcript or path data. */
export interface CostMigrationSdkEvidence {
  harness: string;
  coverage: string;
  total_cost_usd: number | null;
  cost_source: string;
  cost_basis: string;
  pricing_source: string;
  pricing_revision: string | null;
  diagnostics: string[];
}

export type CostMigrationVerdict = 'match' | 'approved' | 'fail';

export interface CostMigrationCaseReport {
  caseId: string;
  source: 'fixture' | 'history';
  legacy: ComparableCostView;
  sdk: ComparableCostView;
  sdkSummary: CostMigrationSdkEvidence | null;
  differences: CostMigrationDifference[];
  invariantViolations: string[];
  verdict: CostMigrationVerdict;
}

export interface CostMigrationReport {
  schemaVersion: typeof COST_MIGRATION_REPORT_SCHEMA_VERSION;
  cases: CostMigrationCaseReport[];
  totals: Record<CostMigrationVerdict, number> & { differences: Record<CostDifferenceClassification, number> };
  gate: { passed: boolean; exitCode: 0 | 1; reasons: string[] };
}

// ────────────────────────────────────────────────────────────────
// View
// ────────────────────────────────────────────────────────────────

export function toComparableCostView(outcome: WorkflowCostOutcome): ComparableCostView {
  // Failure reason text and diagnostics are engine-specific prose, not cost.
  if (outcome.status !== 'success') return { status: outcome.status };
  const models: NonNullable<ComparableCostView['models']> = {};
  for (const [modelId, usage] of Object.entries(outcome.models)) {
    models[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
    };
  }
  const view: ComparableCostView = {
    status: outcome.status,
    totalCostUsd: outcome.totalCostUsd,
    sessionCount: outcome.sessionCount,
    turnCount: outcome.turnCount,
    models,
    pricingModels: Object.keys(outcome.pricingUsed ?? {}).sort(),
  };
  if (outcome.attribution) {
    view.attribution = {
      coverage: outcome.attribution.coverage,
      reason: outcome.attribution.reason ?? null,
      pricedSessions: outcome.attribution.pricedSessions,
      unpricedSessions: outcome.attribution.unpricedSessions,
      models: Object.fromEntries(outcome.attribution.models.map((model) => [
        model.modelId,
        {
          provider: model.provider,
          priced: model.priced,
          costUsd: model.costUsd ?? null,
          inputTokens: model.inputTokens ?? 0,
          outputTokens: model.outputTokens ?? 0,
          cacheReadTokens: model.cacheReadTokens ?? 0,
          cacheCreationTokens: model.cacheCreationTokens ?? 0,
        },
      ])),
    };
  }
  return view;
}

function sdkEvidence(summary: TaskCostSummaryV1 | null | undefined): CostMigrationSdkEvidence | null {
  if (!summary) return null;
  return {
    harness: summary.harness,
    coverage: summary.coverage,
    total_cost_usd: summary.total_cost_usd,
    cost_source: summary.cost_source,
    cost_basis: summary.cost_basis,
    pricing_source: summary.pricing_source,
    pricing_revision: summary.pricing_revision ?? null,
    diagnostics: [...summary.diagnostics],
  };
}

// ────────────────────────────────────────────────────────────────
// Classification rules
// ────────────────────────────────────────────────────────────────

interface RuleContext {
  legacy: ComparableCostView;
  sdk: ComparableCostView;
  summary: CostMigrationSdkEvidence | null;
}

interface DifferenceRule {
  id: string;
  classification: Exclude<CostDifferenceClassification, 'unexplained'>;
  rationale: string;
  matches(path: string, ctx: RuleContext): boolean;
}

const COVERAGE_PATHS = new Set(['attribution.coverage', 'attribution.reason']);
const KNOWN_COVERAGES = new Set(['complete', 'known_zero']);

/**
 * Reviewed difference rules. Every rule is documented in
 * `shared/fixtures/cost-parity/README.md` ("SDK migration gate"); add a rule
 * only with that documentation and a test in `cost-migration.test.ts`.
 */
export const COST_MIGRATION_RULES: readonly DifferenceRule[] = [
  {
    id: 'M-1',
    classification: 'unpriced_data',
    rationale: 'Usage observed but nothing priced: the SDK labels it partial (usage without cost) where legacy said unavailable. Neither reports a dollar figure.',
    matches: (path, { legacy, sdk, summary }) => COVERAGE_PATHS.has(path)
      && summary?.cost_source === 'none'
      && legacy.attribution?.coverage === 'unavailable'
      && sdk.attribution?.coverage === 'partial',
  },
  {
    id: 'M-2',
    classification: 'intentional_contract_change',
    rationale: 'Native (Pi) usage cannot prove completeness: the parser coerces missing token fields to 0 and reports no reasoning dimension, so the SDK keeps native coverage partial instead of complete/known_zero.',
    matches: (path, { legacy, sdk, summary }) => COVERAGE_PATHS.has(path)
      && summary?.harness === 'native'
      && KNOWN_COVERAGES.has(legacy.attribution?.coverage ?? '')
      && sdk.attribution?.coverage === 'partial',
  },
  {
    id: 'M-3',
    classification: 'legacy_bug',
    rationale: 'EF-2: legacy counts every replayed Claude Code line as a turn; the SDK de-duplicates turns by (session, message id).',
    matches: (path, { legacy, sdk, summary }) => path === 'turnCount'
      && summary?.harness === 'claude-code'
      && (sdk.turnCount ?? 0) < (legacy.turnCount ?? 0),
  },
  {
    id: 'M-4',
    classification: 'intentional_contract_change',
    rationale: 'The SDK summary is keyed by harness, not upstream provider, so projected native attribution names the harness.',
    matches: (path, { summary }) => summary?.harness === 'native' && /^attribution\.models\..+\.provider$/.test(path),
  },
  {
    id: 'M-5',
    classification: 'intentional_contract_change',
    rationale: 'The SDK summary keeps no per-session pricing, so priced/unpriced counts are model segments rather than sessions (EF-5).',
    matches: (path) => path === 'attribution.pricedSessions' || path === 'attribution.unpricedSessions',
  },
  {
    id: 'M-6',
    classification: 'legacy_bug',
    rationale: 'EF-13: when a native route id differs from its canonical registry id, legacy workflowTokenUsage keeps a $0 raw-id entry and seeds the canonical entry from one session only, so per-model tokens are duplicated or short. The SDK keys each model once by canonical id and matches the legacy engine\'s own per-model attribution exactly.',
    matches: (path, { legacy, sdk, summary }) => summary?.harness === 'native'
      && path.startsWith('models.')
      && sdkModelsMatchLegacyAttribution(legacy, sdk),
  },
  {
    id: 'M-7',
    classification: 'intentional_contract_change',
    rationale: 'SDK model ids use a restricted charset, so a legacy key outside it (e.g. Claude Code\'s zero-usage `<synthetic>` placeholder) is re-keyed by the SDK sanitizer with an identical value.',
    matches: (path, { legacy, sdk }) => isSanitizedRekey(path, legacy, sdk),
  },
];

const MODEL_MAP_PATHS = ['models.', 'attribution.models.'] as const;

function modelMap(view: ComparableCostView, prefix: typeof MODEL_MAP_PATHS[number]): Record<string, unknown> | undefined {
  return prefix === 'models.' ? view.models : view.attribution?.models;
}

/** True when `path` names a whole model entry that differs only by SDK model-id sanitization. */
function isSanitizedRekey(path: string, legacy: ComparableCostView, sdk: ComparableCostView): boolean {
  const prefix = [...MODEL_MAP_PATHS].reverse().find((candidate) => path.startsWith(candidate));
  if (!prefix) return false;
  const key = path.slice(prefix.length);
  const legacyMap = modelMap(legacy, prefix) ?? {};
  const sdkMap = modelMap(sdk, prefix) ?? {};
  const same = (legacyKey: string) => {
    const sdkKey = toTaskCostModel(legacyKey);
    return sdkKey !== legacyKey
      && !(sdkKey in legacyMap)
      && !(legacyKey in sdkMap)
      && JSON.stringify(legacyMap[legacyKey]) === JSON.stringify(sdkMap[sdkKey]);
  };
  if (key in legacyMap && !(key in sdkMap)) return same(key);
  if (key in sdkMap && !(key in legacyMap)) {
    return Object.keys(legacyMap).some((legacyKey) => toTaskCostModel(legacyKey) === key && same(legacyKey));
  }
  return false;
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;

/**
 * True when every SDK `models` entry equals the legacy engine's per-model
 * attribution (tokens and dollars) — i.e. only legacy's `models` view is off.
 */
function sdkModelsMatchLegacyAttribution(legacy: ComparableCostView, sdk: ComparableCostView): boolean {
  const attributed = legacy.attribution?.models;
  if (!sdk.models || !attributed) return false;
  const sdkModels = Object.entries(sdk.models);
  return sdkModels.length === Object.keys(attributed).length && sdkModels.every(([modelId, usage]) => {
    const expected = attributed[modelId];
    return expected !== undefined
      && TOKEN_FIELDS.every((field) => expected[field] === usage[field])
      && Math.abs((expected.costUsd ?? 0) - usage.costUsd) <= 1e-9;
  });
}

/** Manifest expected fixes (`sync.outcome.*`) whose `expected` the SDK now delivers. */
function expectedFixFor(caseItem: CostParityCase | undefined, path: string, sdkValue: unknown) {
  const fix = caseItem?.expectations.expectedFixes?.find((candidate) => candidate.path === `sync.outcome.${path}`);
  if (!fix || fix.expected === undefined) return undefined;
  return JSON.stringify(fix.expected) === JSON.stringify(sdkValue) ? fix : undefined;
}

function classifyDifference(
  diff: { path: string; baseline: unknown; candidate: unknown },
  ctx: RuleContext,
  caseItem?: CostParityCase,
): CostMigrationDifference {
  const base = { path: diff.path, legacy: diff.baseline, sdk: diff.candidate };
  const fix = expectedFixFor(caseItem, diff.path, diff.candidate);
  if (fix) return { ...base, classification: 'legacy_bug', ruleId: fix.id, rationale: fix.rationale };
  const rule = COST_MIGRATION_RULES.find((candidate) => candidate.matches(diff.path, ctx));
  if (rule) return { ...base, classification: rule.classification, ruleId: rule.id, rationale: rule.rationale };
  return { ...base, classification: 'unexplained' };
}

/** Coverage invariants that no rule may waive. */
function invariantViolations(ctx: RuleContext): string[] {
  const violations: string[] = [];
  const sdkCoverage = ctx.sdk.attribution?.coverage;
  if (sdkCoverage && KNOWN_COVERAGES.has(sdkCoverage) && ctx.summary?.total_cost_usd === null) {
    violations.push(`sdk coverage ${sdkCoverage} with an unresolved SDK total`);
  }
  if (sdkCoverage && KNOWN_COVERAGES.has(sdkCoverage) && ctx.summary && !KNOWN_COVERAGES.has(ctx.summary.coverage)) {
    violations.push(`projection promoted SDK coverage ${ctx.summary.coverage} to ${sdkCoverage}`);
  }
  const legacyCoverage = ctx.legacy.attribution?.coverage;
  if (legacyCoverage && !KNOWN_COVERAGES.has(legacyCoverage) && sdkCoverage && KNOWN_COVERAGES.has(sdkCoverage)) {
    violations.push(`legacy ${legacyCoverage} cost became ${sdkCoverage}`);
  }
  return violations;
}

// ────────────────────────────────────────────────────────────────
// Comparison
// ────────────────────────────────────────────────────────────────

export interface CompareCostOutcomesInput {
  caseId: string;
  source: CostMigrationCaseReport['source'];
  legacy: WorkflowCostOutcome;
  sdk: WorkflowCostOutcome;
  summary: TaskCostSummaryV1 | null | undefined;
  /** Fixture case, for its documented expected fixes. */
  caseItem?: CostParityCase;
}

export function compareCostOutcomes(input: CompareCostOutcomesInput): CostMigrationCaseReport {
  const ctx: RuleContext = {
    legacy: toComparableCostView(input.legacy),
    sdk: toComparableCostView(input.sdk),
    summary: sdkEvidence(input.summary),
  };
  const differences = deepDiff(ctx.legacy, ctx.sdk).map((diff) => classifyDifference(diff, ctx, input.caseItem));
  const violations = invariantViolations(ctx);
  const blocked = violations.length > 0 || differences.some((diff) => BLOCKING_CLASSIFICATIONS.has(diff.classification));
  return {
    caseId: input.caseId,
    source: input.source,
    legacy: ctx.legacy,
    sdk: ctx.sdk,
    sdkSummary: ctx.summary,
    differences,
    invariantViolations: violations,
    verdict: blocked ? 'fail' : differences.length > 0 ? 'approved' : 'match',
  };
}

export function buildCostMigrationReport(cases: CostMigrationCaseReport[]): CostMigrationReport {
  const totals: CostMigrationReport['totals'] = {
    match: 0,
    approved: 0,
    fail: 0,
    differences: { sdk_bug: 0, legacy_bug: 0, intentional_contract_change: 0, unpriced_data: 0, unexplained: 0 },
  };
  const reasons: string[] = [];
  for (const caseReport of cases) {
    totals[caseReport.verdict]++;
    for (const diff of caseReport.differences) totals.differences[diff.classification]++;
    for (const violation of caseReport.invariantViolations) reasons.push(`${caseReport.caseId}: ${violation}`);
    for (const diff of caseReport.differences) {
      if (BLOCKING_CLASSIFICATIONS.has(diff.classification)) {
        reasons.push(`${caseReport.caseId}: ${diff.classification} difference at ${diff.path}`);
      }
    }
  }
  if (cases.length === 0) reasons.push('no cases compared');
  const passed = reasons.length === 0;
  return {
    schemaVersion: COST_MIGRATION_REPORT_SCHEMA_VERSION,
    cases,
    totals,
    gate: { passed, exitCode: passed ? 0 : 1, reasons },
  };
}

/** Run both engines over every manifest case and compare them. */
export async function compareCostParityCorpus(manifest: CostParityManifest): Promise<CostMigrationReport> {
  const cases: CostMigrationCaseReport[] = [];
  for (const caseItem of manifest.cases) {
    const outcomes: CostParityCaseOutcomes = await captureCaseOutcomes(caseItem);
    cases.push(compareCostOutcomes({
      caseId: caseItem.id,
      source: 'fixture',
      legacy: outcomes.legacy.outcome,
      sdk: outcomes.sdk.outcome,
      summary: outcomes.sdk.summary,
      caseItem,
    }));
  }
  return buildCostMigrationReport(cases);
}

// ────────────────────────────────────────────────────────────────
// Historical sample
// ────────────────────────────────────────────────────────────────

type HistoricalCostRecord = Pick<
  EvalRecord,
  'id' | 'agentType' | 'workflowCost' | 'workflowCostStatus' | 'workflowTokenUsage'
  | 'workflowCostAttribution' | 'pricingSnapshot' | 'taskCostSummary'
>;

/**
 * Rebuild the legacy outcome an eval record persisted. Only records with
 * attribution are comparable: older records lack the session/turn counts.
 */
function legacyOutcomeFromRecord(record: HistoricalCostRecord): WorkflowCostOutcome | null {
  const attribution = record.workflowCostAttribution;
  if (record.workflowCostStatus !== 'success' || !attribution) return null;
  return {
    status: 'success',
    totalCostUsd: record.workflowCost ?? 0,
    models: record.workflowTokenUsage ?? {},
    sessionCount: attribution.sessions,
    turnCount: attribution.turns,
    pricingUsed: record.pricingSnapshot ?? {},
    attribution,
  };
}

/**
 * Compare the persisted legacy cost against the persisted shadow SDK summary
 * for the most recent `limit` local eval records that carry both. Reads only
 * cost fields; record ids are the only identifiers emitted.
 */
export function compareHistoricalEvalRecords(
  records: readonly HistoricalCostRecord[],
  options: { limit: number },
): { cases: CostMigrationCaseReport[]; skipped: number } {
  const cases: CostMigrationCaseReport[] = [];
  let skipped = 0;
  for (const record of [...records].reverse()) {
    if (cases.length >= options.limit) break;
    const summaries = Array.isArray(record.taskCostSummary) ? record.taskCostSummary : null;
    const legacy = legacyOutcomeFromRecord(record);
    const summary = selectPrimaryTaskCostSummary(summaries, record.agentType);
    if (!legacy || !summary) {
      skipped++;
      continue;
    }
    // Same pricing snapshot on both sides isolates accounting from price drift.
    const sdk = projectTaskCostSummaryToWorkflowCost(summary, { pricingTable: record.pricingSnapshot ?? {} });
    cases.push(compareCostOutcomes({ caseId: record.id, source: 'history', legacy, sdk, summary }));
  }
  return { cases, skipped };
}

/** One historical task whose local session files are re-scanned by both engines. */
export interface LocalSessionSampleEntry {
  /** Label emitted in the report; never a path. */
  id: string;
  worktreePath: string;
  branchName: string;
  issueId?: string;
  agentType?: string;
}

/**
 * Re-run both engines on the local session files of up to `limit` past
 * tasks. Sessions are read in place (Claude/Codex homes, worktree run dirs)
 * with one shared pricing table; only the comparable cost view is reported.
 */
export async function compareLocalSessionSample(
  entries: readonly LocalSessionSampleEntry[],
  options: { limit: number; repoDir: string; pricingTable: PricingTable },
): Promise<CostMigrationCaseReport[]> {
  const cases: CostMigrationCaseReport[] = [];
  for (const entry of entries.slice(0, options.limit)) {
    const args = {
      worktreePath: entry.worktreePath,
      branchName: entry.branchName,
      repoDir: options.repoDir,
      pricingTable: options.pricingTable,
      agentType: entry.agentType ?? 'claude',
      issueId: entry.issueId ?? '',
    };
    const legacy = await legacyEngine(args);
    const sdk = await sdkEngine(args);
    cases.push(compareCostOutcomes({
      caseId: entry.id,
      source: 'history',
      legacy: legacy.outcome,
      sdk: sdk.outcome,
      summary: sdk.summary,
    }));
  }
  return cases;
}

// ────────────────────────────────────────────────────────────────
// Formatting
// ────────────────────────────────────────────────────────────────

function formatValue(value: unknown): string {
  return value === undefined ? '—' : JSON.stringify(value).slice(0, 60);
}

export function formatCostMigrationReport(report: CostMigrationReport): string {
  const lines: string[] = [];
  for (const caseReport of report.cases) {
    const total = (view: ComparableCostView) => view.totalCostUsd === undefined ? view.status : `$${view.totalCostUsd.toFixed(6)}`;
    const coverage = caseReport.sdkSummary
      ? ` coverage ${caseReport.legacy.attribution?.coverage ?? '—'}→${caseReport.sdkSummary.coverage}`
      : '';
    lines.push(
      `${caseReport.verdict.toUpperCase().padEnd(8)} ${caseReport.caseId} [${caseReport.source}] ` +
      `legacy ${total(caseReport.legacy)} / sdk ${total(caseReport.sdk)}${coverage}`,
    );
    for (const diff of caseReport.differences) {
      lines.push(
        `    ${diff.classification}${diff.ruleId ? ` (${diff.ruleId})` : ''} ${diff.path}: ` +
        `${formatValue(diff.legacy)} → ${formatValue(diff.sdk)}`,
      );
    }
    for (const violation of caseReport.invariantViolations) lines.push(`    invariant: ${violation}`);
  }
  const { totals } = report;
  lines.push('');
  lines.push(
    `${report.cases.length} case(s): ${totals.match} match, ${totals.approved} approved, ${totals.fail} fail; ` +
    `differences: ${Object.entries(totals.differences).map(([key, count]) => `${key}=${count}`).join(', ')}`,
  );
  lines.push(report.gate.passed
    ? 'Release gate: PASS'
    : `Release gate: FAIL\n${report.gate.reasons.map((reason) => `  - ${reason}`).join('\n')}`);
  return lines.join('\n');
}
