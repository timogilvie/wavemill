import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import {
  auditLaunchPriorityCoverage,
  type AuditOptions,
  type Blocker as AuditBlocker,
  type CoverageStatus,
  type LaunchPriorityRole,
  type ModelRoleEvidence,
  type SamplingPlanEntry,
} from './launch-priority-audit.ts';
import { buildSubmitDataContributionRow } from './hokusai-contribution-builder.ts';
import { validateContributionRow } from './hokusai-contribution-schema.ts';
import { redactHokusaiSubmission } from './hokusai-redaction.ts';
import {
  buildHokusaiContributionProjection,
  type LaunchPriorityValidationContext,
} from './hokusai-submission-trigger.ts';
import { toHokusaiSubmission } from './hokusai-schema.ts';
import {
  buildCatalogSnapshot,
  fetchOpenRouterModels,
  hashLaunchPriorityFixture,
  loadLaunchPriorityFixture,
  resolveWavemillAliasFromOpenRouterId,
  normalizeCatalog,
  type CatalogBlocker,
  type LaunchPriorityFixture,
  type LaunchPriorityModel,
  type ModelFamily,
  type ModelStatus,
  type NormalizedCatalog,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import { runOpenRouterSmoke } from './openrouter-smoke.ts';
import type { BlockerCategory, OpenRouterTransport } from './openrouter-runtime.ts';

const ROLE_ORDER: readonly LaunchPriorityRole[] = ['planning', 'coding', 'review'];
const FAMILY_CHECK_ORDER: readonly Extract<ModelFamily, 'qwen' | 'deepseek' | 'kimi'>[] = ['qwen', 'deepseek', 'kimi'];
const DEFAULT_REDACTION_SALT = 'launch-validation-redaction-salt';
const DEFAULT_ANCHOR_SHARE_THRESHOLD = 0.45;
const SCHEMA_VERSION = '1' as const;

export type LaunchValidationMode = 'fixture' | 'live';

export interface LaunchValidationOptions {
  repoDir?: string;
  fixturePath?: string;
  fixture?: LaunchPriorityFixture;
  catalogSnapshot?: NormalizedCatalog;
  evalRecords?: EvalRecord[];
  smokeMode?: LaunchValidationMode;
  prompt?: string;
  apiKey?: string;
  transport?: OpenRouterTransport;
  coverageTargetPerRole?: number;
  maxAttempts?: number;
  now?: Date;
  redactionSalt?: string;
  anchorShareThreshold?: number;
  checkNativeCertification?: AuditOptions['checkNativeCertification'];
  quotaStatus?: AuditOptions['quotaStatus'];
  costOfModel?: AuditOptions['costOfModel'];
}

export interface LaunchValidationProvenance {
  launchPriorityList: {
    version: string;
    schemaVersion: string;
    sourceHash: string;
    modelCount: number;
  };
  catalogSnapshot: {
    schemaVersion: string;
    generatedAt: string;
    sourceHash: string;
    entries: number;
    blockers: number;
  };
}

export interface LaunchValidationBlocker {
  source: 'smoke' | 'audit';
  code: string;
  role?: LaunchPriorityRole;
  detail: string;
}

export interface LaunchValidationSmokeResult {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  launchPriorityStatus: Exclude<ModelStatus, 'deprecated'>;
  priorityTier: number;
  status: 'ok' | 'blocker';
  blockerSource?: 'catalog' | 'smoke';
  category?: BlockerCategory;
  code?: string;
  detail?: string;
  costUsd?: number | null;
}

export interface LaunchValidationRoleSummary {
  role: LaunchPriorityRole;
  directEvidenceCount: number;
  availablePoolExposureCount: number;
  evalAttempts: number;
  evalSuccesses: number;
  evalFailures: number;
  blockers: AuditBlocker[];
  coverageStatus: CoverageStatus;
}

export interface LaunchValidationModelSummary {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  launchPriorityStatus: Exclude<ModelStatus, 'deprecated'>;
  priorityTier: number;
  smoke: LaunchValidationSmokeResult;
  roles: LaunchValidationRoleSummary[];
  combinedBlockers: LaunchValidationBlocker[];
}

export interface FamilyValidationCheck {
  family: Extract<ModelFamily, 'qwen' | 'deepseek' | 'kimi'>;
  challengerAlias: string | null;
  status: 'satisfied' | 'blocked' | 'missing';
  evalSuccesses: number;
  reason: string;
}

export interface CoverageAnchorDiagnostic {
  wavemillAlias: string;
  role: LaunchPriorityRole;
  directEvidenceCount: number;
  share: number;
  threshold: number;
}

export interface HokusaiCoverageCell {
  wavemillAlias: string;
  role: LaunchPriorityRole;
  rowCount: number;
  successRowCount: number;
  belowTarget: boolean;
}

export interface HokusaiExportDiagnostics {
  status: 'ok' | 'partial' | 'failed';
  eligibleEvalRecords: number;
  skippedNotEligible: number;
  validRows: number;
  invalidRows: number;
  rowsMissingLaunchAlias: number;
  provenancePreview: Record<string, string>;
  coverage: {
    cells: HokusaiCoverageCell[];
    overrepresentedAnchors: CoverageAnchorDiagnostic[];
    underSampledLaunchTargets: HokusaiCoverageCell[];
  };
  issues: string[];
}

export interface LaunchValidationReport {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  mode: LaunchValidationMode;
  provenance: LaunchValidationProvenance;
  smoke: {
    prompt: string;
    summary: {
      total: number;
      ok: number;
      blocker: number;
      byCode: Record<string, number>;
    };
    models: LaunchValidationSmokeResult[];
  };
  groupedAudit: {
    coverageTargetPerRole: number;
    zeroEvidence: string[];
    belowTarget: string[];
    samplingPlan: SamplingPlanEntry[];
    models: LaunchValidationModelSummary[];
  };
  familyChecks: FamilyValidationCheck[];
  coverageDiagnostics: {
    anchorShareThreshold: number;
    overrepresentedAnchors: CoverageAnchorDiagnostic[];
    underSampledLaunchTargets: SamplingPlanEntry[];
  };
  hokusai: HokusaiExportDiagnostics;
}

export interface LaunchValidationDeps {
  fetchCatalog: typeof fetchOpenRouterModels;
  runSmoke: typeof runOpenRouterSmoke;
}

const defaultDeps: LaunchValidationDeps = {
  fetchCatalog: fetchOpenRouterModels,
  runSmoke: runOpenRouterSmoke,
};

interface ActiveLaunchModel extends LaunchPriorityModel {
  status: Exclude<ModelStatus, 'deprecated'>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fixtureHash(fixture: LaunchPriorityFixture, fixturePath?: string): string {
  if (fixturePath) {
    return hashLaunchPriorityFixture(fixturePath);
  }
  return createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
}

function launchPriorityVersion(fixture: LaunchPriorityFixture, fixturePath?: string): string {
  return fixturePath ? basename(fixturePath) : `launch-priority-fixture.v${fixture.schemaVersion}.json`;
}

function createFixtureCatalog(fixture: LaunchPriorityFixture): Map<string, OpenRouterModel> {
  return new Map(
    fixture.models
      .filter((model) => model.status !== 'deprecated')
      .map((model) => [
        model.openrouterId,
        {
          id: model.openrouterId,
          context_length: 200_000,
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ]),
  );
}

function readEvalRecords(repoDir: string | undefined, records: EvalRecord[] | undefined): EvalRecord[] {
  if (records) {
    return records;
  }

  const evalsPath = join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');
  if (!existsSync(evalsPath)) {
    return [];
  }

  const content = readFileSync(evalsPath, 'utf-8');
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      JSON.parse(line);
    } catch {
      console.warn(`Skipping malformed eval JSONL line ${index + 1} in ${evalsPath}`);
    }
  }

  return readJsonlFile<EvalRecord>(evalsPath);
}

function filterActiveLaunchModels(fixture: LaunchPriorityFixture): ActiveLaunchModel[] {
  return fixture.models
    .filter((model): model is ActiveLaunchModel => model.status !== 'deprecated')
    .sort((left, right) => left.priorityTier - right.priorityTier || left.wavemillAlias.localeCompare(right.wavemillAlias));
}

function roleOrder(role: LaunchPriorityRole): number {
  return ROLE_ORDER.indexOf(role);
}

function modelAttemptTotals(model: LaunchValidationModelSummary): { attempts: number; successes: number } {
  return model.roles.reduce((totals, role) => ({
    attempts: totals.attempts + role.evalAttempts,
    successes: totals.successes + role.evalSuccesses,
  }), { attempts: 0, successes: 0 });
}

function smokeBlockerForCatalog(model: ActiveLaunchModel, blocker: CatalogBlocker): LaunchValidationSmokeResult {
  return {
    wavemillAlias: model.wavemillAlias,
    openrouterId: model.openrouterId,
    family: model.family,
    launchPriorityStatus: model.status,
    priorityTier: model.priorityTier,
    status: 'blocker',
    blockerSource: 'catalog',
    code: blocker.reason,
    detail: blocker.detail,
  };
}

function buildSmokeResults(
  activeModels: ActiveLaunchModel[],
  snapshot: NormalizedCatalog,
  reports: Awaited<ReturnType<typeof runOpenRouterSmoke>>,
): LaunchValidationSmokeResult[] {
  const blockerByAlias = new Map(snapshot.blockers.map((blocker) => [blocker.wavemillAlias, blocker]));
  const reportByAlias = new Map(reports.map((report) => [report.modelId, report]));

  return activeModels.map((model) => {
    const catalogBlocker = blockerByAlias.get(model.wavemillAlias);
    if (catalogBlocker) {
      return smokeBlockerForCatalog(model, catalogBlocker);
    }

    const smokeReport = reportByAlias.get(model.wavemillAlias);
    if (!smokeReport) {
      return {
        wavemillAlias: model.wavemillAlias,
        openrouterId: model.openrouterId,
        family: model.family,
        launchPriorityStatus: model.status,
        priorityTier: model.priorityTier,
        status: 'blocker',
        blockerSource: 'smoke',
        code: 'missing-smoke-report',
        detail: `${model.wavemillAlias} did not produce a smoke result.`,
      };
    }

    return {
      wavemillAlias: model.wavemillAlias,
      openrouterId: model.openrouterId,
      family: model.family,
      launchPriorityStatus: model.status,
      priorityTier: model.priorityTier,
      status: smokeReport.status,
      ...(smokeReport.status === 'blocker'
        ? {
          blockerSource: 'smoke' as const,
          category: smokeReport.category,
          code: smokeReport.category,
          detail: smokeReport.detail,
        }
        : { costUsd: smokeReport.costUsd ?? null }),
    };
  });
}

function dedupeBlockers(blockers: LaunchValidationBlocker[]): LaunchValidationBlocker[] {
  const seen = new Set<string>();
  const deduped: LaunchValidationBlocker[] = [];
  for (const blocker of blockers) {
    const key = JSON.stringify([blocker.source, blocker.code, blocker.role ?? '', blocker.detail]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(blocker);
  }
  return deduped;
}

function buildModelSummaries(
  activeModels: ActiveLaunchModel[],
  auditRows: ModelRoleEvidence[],
  smokeResults: LaunchValidationSmokeResult[],
): LaunchValidationModelSummary[] {
  const smokeByAlias = new Map(smokeResults.map((result) => [result.wavemillAlias, result]));
  const rowsByAlias = new Map<string, ModelRoleEvidence[]>();

  for (const row of auditRows) {
    if (!rowsByAlias.has(row.wavemillAlias)) {
      rowsByAlias.set(row.wavemillAlias, []);
    }
    rowsByAlias.get(row.wavemillAlias)!.push(row);
  }

  return activeModels.map((model) => {
    const rows = [...(rowsByAlias.get(model.wavemillAlias) ?? [])]
      .sort((left, right) => roleOrder(left.role) - roleOrder(right.role));
    const smoke = smokeByAlias.get(model.wavemillAlias) ?? {
      wavemillAlias: model.wavemillAlias,
      openrouterId: model.openrouterId,
      family: model.family,
      launchPriorityStatus: model.status,
      priorityTier: model.priorityTier,
      status: 'blocker',
      blockerSource: 'smoke',
      code: 'missing-smoke-report',
      detail: `${model.wavemillAlias} did not produce a smoke result.`,
    } satisfies LaunchValidationSmokeResult;

    const combinedBlockers = dedupeBlockers([
      ...(smoke.status === 'blocker'
        ? [{
          source: 'smoke' as const,
          code: smoke.code ?? 'smoke-blocker',
          detail: smoke.detail ?? `${smoke.wavemillAlias} smoke failed`,
        }]
        : []),
      ...rows.flatMap((row) =>
        row.blockers.map((blocker) => ({
          source: 'audit' as const,
          code: blocker.reason,
          role: blocker.role,
          detail: blocker.detail ?? blocker.reason,
        }))),
    ]);

    return {
      wavemillAlias: model.wavemillAlias,
      openrouterId: model.openrouterId,
      family: model.family,
      launchPriorityStatus: model.status,
      priorityTier: model.priorityTier,
      smoke,
      roles: rows.map((row) => ({
        role: row.role,
        directEvidenceCount: row.directEvidenceCount,
        availablePoolExposureCount: row.availablePoolExposureCount,
        evalAttempts: row.evalAttempts,
        evalSuccesses: row.evalSuccesses,
        evalFailures: Math.max(0, row.evalAttempts - row.evalSuccesses),
        blockers: row.blockers,
        coverageStatus: row.status,
      })),
      combinedBlockers,
    };
  });
}

function buildFamilyChecks(
  models: LaunchValidationModelSummary[],
  snapshot: NormalizedCatalog,
): FamilyValidationCheck[] {
  const priceByAlias = new Map(snapshot.entries.map((entry) => [entry.wavemillAlias, entry.pricing.inputPerMTok]));

  return FAMILY_CHECK_ORDER.map((family) => {
    const candidates = models
      .filter((model) => model.family === family)
      .sort((left, right) =>
        (priceByAlias.get(left.wavemillAlias) ?? Number.POSITIVE_INFINITY)
        - (priceByAlias.get(right.wavemillAlias) ?? Number.POSITIVE_INFINITY)
        || left.priorityTier - right.priorityTier
        || left.wavemillAlias.localeCompare(right.wavemillAlias));

    const satisfied = candidates.find((model) => modelAttemptTotals(model).successes > 0);
    if (satisfied) {
      return {
        family,
        challengerAlias: satisfied.wavemillAlias,
        status: 'satisfied',
        evalSuccesses: modelAttemptTotals(satisfied).successes,
        reason: `${satisfied.wavemillAlias} has successful Wavemill execution evidence.`,
      };
    }

    const first = candidates[0];
    if (!first) {
      return {
        family,
        challengerAlias: null,
        status: 'missing',
        evalSuccesses: 0,
        reason: `No ${family} launch-priority challenger is configured.`,
      };
    }

    const blocked = candidates.every((model) => model.combinedBlockers.length > 0);
    return {
      family,
      challengerAlias: first.wavemillAlias,
      status: blocked ? 'blocked' : 'missing',
      evalSuccesses: 0,
      reason: blocked
        ? `${first.wavemillAlias} is blocked externally: ${first.combinedBlockers[0]?.detail ?? 'blocked'}`
        : `${first.wavemillAlias} still lacks successful Wavemill execution evidence.`,
    };
  });
}

function buildAnchorDiagnostics(
  rows: Array<{ wavemillAlias: string; role: LaunchPriorityRole; directEvidenceCount: number }>,
  minimumCount: number,
  threshold: number,
): CoverageAnchorDiagnostic[] {
  const totals = new Map<LaunchPriorityRole, number>();
  for (const row of rows) {
    totals.set(row.role, (totals.get(row.role) ?? 0) + row.directEvidenceCount);
  }

  return rows
    .map((row) => {
      const total = totals.get(row.role) ?? 0;
      const share = total > 0 ? row.directEvidenceCount / total : 0;
      return { ...row, share, threshold };
    })
    .filter((row) => row.directEvidenceCount >= minimumCount && row.share >= threshold)
    .sort((left, right) => right.share - left.share || right.directEvidenceCount - left.directEvidenceCount || left.wavemillAlias.localeCompare(right.wavemillAlias));
}

function asStringRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function fieldAlias(value: unknown, activeModels: ActiveLaunchModel[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  if (activeModels.some((model) => model.wavemillAlias === trimmed)) {
    return trimmed;
  }
  const byOpenRouterId = activeModels.find((model) => model.openrouterId === trimmed);
  if (byOpenRouterId) {
    return byOpenRouterId.wavemillAlias;
  }
  return resolveWavemillAliasFromOpenRouterId(trimmed) ?? null;
}

function resolveRoleAlias(
  inputs: Record<string, unknown> | null,
  role: LaunchPriorityRole,
  activeModels: ActiveLaunchModel[],
): string | null {
  if (!inputs) {
    return null;
  }

  if (role === 'coding') {
    return fieldAlias(inputs.coder_model_alias, activeModels)
      ?? fieldAlias(inputs.coder_attempted_model, activeModels)
      ?? fieldAlias(inputs.coder_model, activeModels);
  }
  if (role === 'planning') {
    return fieldAlias(inputs.planner_model, activeModels);
  }
  return fieldAlias(inputs.reviewer_model, activeModels);
}

function launchPriorityValidationContext(provenance: LaunchValidationProvenance): LaunchPriorityValidationContext {
  return {
    catalogGeneratedAt: provenance.catalogSnapshot.generatedAt,
    catalogSourceHash: provenance.catalogSnapshot.sourceHash,
    launchPriorityListVersion: provenance.launchPriorityList.version,
    launchPriorityFixtureHash: provenance.launchPriorityList.sourceHash,
  };
}

function buildHokusaiDiagnostics(
  records: EvalRecord[],
  activeModels: ActiveLaunchModel[],
  coverageTargetPerRole: number,
  anchorShareThreshold: number,
  provenance: LaunchValidationProvenance,
  redactionSalt: string,
): HokusaiExportDiagnostics {
  const roleKeys = new Map(
    activeModels.flatMap((model) =>
      model.roleEligibility.map((role) => [`${model.wavemillAlias}:${role}`, { model, role }] as const)),
  );
  const counts = new Map<string, { rows: number; successes: number }>();
  const issues: string[] = [];
  let eligibleEvalRecords = 0;
  let skippedNotEligible = 0;
  let validRows = 0;
  let invalidRows = 0;
  let rowsMissingLaunchAlias = 0;
  let provenancePreview: Record<string, string> = {};

  for (const record of records) {
    const submission = toHokusaiSubmission(record);
    if (!submission.ok) {
      skippedNotEligible += 1;
      continue;
    }

    eligibleEvalRecords += 1;
    try {
      const redacted = redactHokusaiSubmission(submission.submission, { salt: redactionSalt });
      // HOK-3370 note: head-move authorship is attached on the real
      // submission path (hokusai-submission-trigger.ts); this diagnostics
      // preview has no repoDir to resolve the record from.
      const projection = buildHokusaiContributionProjection(
        redacted,
        record.timestamp,
        record,
        launchPriorityValidationContext(provenance),
      );
      const row = validateContributionRow(buildSubmitDataContributionRow(projection));
      validRows += 1;

      const rowObject = asStringRecord(row);
      const inputs = asStringRecord(rowObject?.inputs);
      const successful = rowObject?.success_under_budget === true;

      if (Object.keys(provenancePreview).length === 0 && inputs) {
        provenancePreview = Object.fromEntries(
          Object.entries(inputs)
            .filter(([key, value]) => key.startsWith('launch_priority_') && typeof value === 'string')
            .map(([key, value]) => [key, value as string]),
        );
      }

      let hadAlias = false;
      for (const role of ROLE_ORDER) {
        const alias = resolveRoleAlias(inputs, role, activeModels);
        if (!alias) {
          continue;
        }
        hadAlias = true;
        const key = `${alias}:${role}`;
        const counter = counts.get(key) ?? { rows: 0, successes: 0 };
        counter.rows += 1;
        if (successful) {
          counter.successes += 1;
        }
        counts.set(key, counter);
      }
      if (!hadAlias) {
        rowsMissingLaunchAlias += 1;
      }
    } catch (error) {
      invalidRows += 1;
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const cells: HokusaiCoverageCell[] = [...roleKeys.entries()]
    .map(([key, { model, role }]) => {
      const counter = counts.get(key) ?? { rows: 0, successes: 0 };
      return {
        wavemillAlias: model.wavemillAlias,
        role,
        rowCount: counter.rows,
        successRowCount: counter.successes,
        belowTarget: counter.rows < coverageTargetPerRole,
      };
    })
    .sort((left, right) => left.wavemillAlias.localeCompare(right.wavemillAlias) || roleOrder(left.role) - roleOrder(right.role));

  const overrepresentedAnchors = buildAnchorDiagnostics(
    cells.map((cell) => ({
      wavemillAlias: cell.wavemillAlias,
      role: cell.role,
      directEvidenceCount: cell.rowCount,
    })),
    coverageTargetPerRole,
    anchorShareThreshold,
  );

  const underSampledLaunchTargets = cells.filter((cell) => cell.belowTarget);
  const status = invalidRows > 0
    ? 'partial'
    : validRows > 0
      ? 'ok'
      : 'failed';

  return {
    status,
    eligibleEvalRecords,
    skippedNotEligible,
    validRows,
    invalidRows,
    rowsMissingLaunchAlias,
    provenancePreview,
    coverage: {
      cells,
      overrepresentedAnchors,
      underSampledLaunchTargets,
    },
    issues,
  };
}

async function resolveCatalogSnapshot(
  options: LaunchValidationOptions,
  deps: LaunchValidationDeps,
  fixture: LaunchPriorityFixture,
  fixturePath: string | undefined,
  generatedAt: string,
): Promise<NormalizedCatalog> {
  if (options.catalogSnapshot) {
    return options.catalogSnapshot;
  }

  const sourceHash = fixtureHash(fixture, fixturePath);
  if ((options.smokeMode ?? 'fixture') === 'fixture') {
    const normalized = normalizeCatalog(fixture.models, createFixtureCatalog(fixture), { resolvedAt: generatedAt });
    return buildCatalogSnapshot(normalized.entries, normalized.blockers, sourceHash, { generatedAt });
  }

  const models = await deps.fetchCatalog();
  const normalized = normalizeCatalog(fixture.models, models, { resolvedAt: generatedAt });
  return buildCatalogSnapshot(normalized.entries, normalized.blockers, sourceHash, { generatedAt });
}

export async function generateLaunchValidationReport(
  options: LaunchValidationOptions = {},
  deps: LaunchValidationDeps = defaultDeps,
): Promise<LaunchValidationReport> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const fixturePath = options.fixturePath;
  const fixture = options.fixture ?? loadLaunchPriorityFixture(fixturePath);
  const activeModels = filterActiveLaunchModels(fixture);
  const snapshot = await resolveCatalogSnapshot(options, deps, fixture, fixturePath, generatedAt);
  const records = readEvalRecords(options.repoDir, options.evalRecords);
  const smokePrompt = options.prompt ?? 'ping';
  const coverageTargetPerRole = options.coverageTargetPerRole ?? 3;
  const anchorShareThreshold = options.anchorShareThreshold ?? DEFAULT_ANCHOR_SHARE_THRESHOLD;
  const smokeReports = await deps.runSmoke({
    entries: snapshot.entries,
    transport: (options.smokeMode ?? 'fixture') === 'fixture' ? async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: 'pong' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
        json: async () => ({
          choices: [{ message: { content: 'pong' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
      } as Response)
      : options.transport,
    apiKey: (options.smokeMode ?? 'fixture') === 'fixture' ? 'fixture-key' : options.apiKey,
    prompt: smokePrompt,
  });
  const smoke = buildSmokeResults(activeModels, snapshot, smokeReports);
  const audit = auditLaunchPriorityCoverage({
    catalog: snapshot,
    evalRecords: records,
    repoDir: options.repoDir,
    coverageTargetPerRole,
    maxAttempts: options.maxAttempts,
    now,
    checkNativeCertification: options.checkNativeCertification,
    quotaStatus: options.quotaStatus,
    costOfModel: options.costOfModel,
  });
  const models = buildModelSummaries(
    activeModels,
    audit.models.filter((row) => row.launchPriorityStatus !== 'deprecated'),
    smoke,
  );
  const overrepresentedAnchors = buildAnchorDiagnostics(
    models.flatMap((model) => model.roles.map((role) => ({
      wavemillAlias: model.wavemillAlias,
      role: role.role,
      directEvidenceCount: role.directEvidenceCount,
    }))),
    coverageTargetPerRole,
    anchorShareThreshold,
  );

  const provenance: LaunchValidationProvenance = {
    launchPriorityList: {
      version: launchPriorityVersion(fixture, fixturePath),
      schemaVersion: fixture.schemaVersion,
      sourceHash: fixtureHash(fixture, fixturePath),
      modelCount: activeModels.length,
    },
    catalogSnapshot: {
      schemaVersion: snapshot.schemaVersion,
      generatedAt: snapshot.generatedAt,
      sourceHash: snapshot.sourceHash,
      entries: snapshot.entries.length,
      blockers: snapshot.blockers.length,
    },
  };
  const hokusai = buildHokusaiDiagnostics(
    records,
    activeModels,
    coverageTargetPerRole,
    anchorShareThreshold,
    provenance,
    options.redactionSalt ?? DEFAULT_REDACTION_SALT,
  );

  const byCode: Record<string, number> = {};
  for (const result of smoke) {
    if (result.status !== 'blocker') {
      continue;
    }
    const code = result.code ?? result.category ?? 'unknown-blocker';
    byCode[code] = (byCode[code] ?? 0) + 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    mode: options.smokeMode ?? 'fixture',
    provenance,
    smoke: {
      prompt: smokePrompt,
      summary: {
        total: smoke.length,
        ok: smoke.filter((result) => result.status === 'ok').length,
        blocker: smoke.filter((result) => result.status === 'blocker').length,
        byCode,
      },
      models: smoke,
    },
    groupedAudit: {
      coverageTargetPerRole,
      zeroEvidence: audit.zeroEvidence,
      belowTarget: audit.belowTarget,
      samplingPlan: audit.samplingPlan,
      models,
    },
    familyChecks: buildFamilyChecks(models, snapshot),
    coverageDiagnostics: {
      anchorShareThreshold,
      overrepresentedAnchors,
      underSampledLaunchTargets: audit.samplingPlan,
    },
    hokusai,
  };
}
