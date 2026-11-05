import { getHokusaiSubmissionConfig, getHokusaiSubmissionEnableSources } from './config.ts';
import {
  buildTechnicalTaskRouterRowV4,
  type ModelEvidence,
  type RedactedEvalContributionProjectionV4,
  type RouteRole,
  type StageExecutionProjection,
} from './hokusai-contribution-builder.ts';

/** Projection-side `comparison_group` shape (camelCase per @hokusai/core). */
interface ComparisonGroupProjection {
  id: string;
  roleVaried: RouteRole;
}
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution, type HokusaiQueueProvenance } from './hokusai-queue.ts';
import { formatSubmissionSwitches, getSubmissionSwitchReport } from './hokusai-consent.ts';
import {
  getOrCreateRedactionSalt,
  redactHokusaiSubmission,
  redactPairId,
  redactSessionIds,
  redactStageTaskCost,
} from './hokusai-redaction.ts';
import {
  toHokusaiInput,
  toHokusaiSubmission,
  type HokusaiAvailableModels,
  type HokusaiSubmission,
  type HokusaiTaskDescriptor,
} from './hokusai-schema.ts';
import { appendTriggerLogEntry } from './hokusai-trigger-log.ts';
import { errorMessage } from './error-utils.ts';
import type { EvalRecord, EvalRecordChallengeStage } from './eval-schema.ts';
import {
  routingOutcomeForProjection,
  type StageRouteOverride,
} from './route-override-record.ts';
import {
  isRepairStageKind,
  resolveRepairStageExecutedModel,
  resolveStageExecutedModel,
  type ExecutedModelEvidenceSource,
  type ExecutedModelEvidenceStatus,
} from './executed-model-resolver.ts';
import {
  groupByExecutionStage,
  groupByHarness,
  locateOwnershipRows,
  type ExecutionStage,
  type SessionHarness,
  type SessionOwnershipRow,
} from './session-ownership.ts';
import { meterWorkflowCost, type MeteredWorkflowCost } from './sdk-task-cost/meter.ts';
import type { TaskCostSummaryV1 } from './sdk-task-cost/contract.ts';

export interface TriggerHokusaiSubmissionOptions {
  repoDir: string;
  configDir?: string;
  redactionSalt?: string;
  launchPriorityValidation?: LaunchPriorityValidationContext;
  promotedBackfill?: PromotedBackfillContext;
  /**
   * Pre-measured cost evidence. Callers that already ran `meterWorkflowCost`
   * (eval orchestrator, post-completion hook) hand their result here so this
   * trigger never re-meters. Absent means the trigger does its own best-effort
   * read of the live / archived ownership record and metering.
   */
  meteredCost?: MeteredWorkflowCost;
  /**
   * Worktree used to read the ownership record when `meteredCost` is absent.
   * Defaults to `repoDir`.
   */
  worktreePath?: string;
  /** Branch name used only in diagnostic messages. */
  branchName?: string;
}

export interface PromotedBackfillContext {
  manifestId: string;
  fromRevision: number;
  toRevision: number;
  finalFingerprint?: string;
  reconciliationReportHash: string;
}

export type HokusaiSubmissionTriggerResult =
  | { status: 'disabled'; source: 'repo_config' | 'consent'; detail: string }
  | { status: 'not_eligible'; reasons: string[] }
  | { status: 'enqueued'; entryId?: string; idempotencyKey?: string; drainStarted: boolean }
  | { status: 'duplicate'; drainStarted: false }
  | { status: 'failed'; error: string };

export function formatHokusaiSubmissionTriggerResult(result: HokusaiSubmissionTriggerResult): string {
  switch (result.status) {
    case 'disabled':
      return `disabled (${result.source}: ${result.detail})`;
    case 'not_eligible':
      return `not eligible (${result.reasons.join(', ') || 'no reason provided'})`;
    case 'enqueued':
      return `enqueued${result.entryId ? ` entry=${result.entryId}` : ''}${result.drainStarted ? ' drain=started' : ''}`;
    case 'duplicate':
      return 'duplicate';
    case 'failed':
      return `failed (${result.error})`;
  }
}

export const hokusaiSubmissionTriggerDeps = {
  getHokusaiSubmissionConfig,
  getHokusaiSubmissionEnableSources,
  getSubmissionSwitchReport,
  appendTriggerLogEntry,
  toHokusaiSubmission,
  redactHokusaiSubmission,
  buildTechnicalTaskRouterRowV4,
  enqueueContribution,
  drainContributionQueue,
  meterWorkflowCost,
  locateOwnershipRows,
  resolveStageExecutedModel,
  resolveRepairStageExecutedModel,
};

function toBudgetCompliant(submission: HokusaiSubmission): boolean {
  const actualCostUsd = submission.observed_outcomes.actual_cost_usd;
  if (typeof actualCostUsd !== 'number' || !Number.isFinite(actualCostUsd)) {
    return false;
  }

  const maxCostUsd = submission.constraints.max_cost_usd;
  if (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd)) {
    return true;
  }
  return actualCostUsd <= maxCostUsd;
}

export interface LaunchPriorityValidationContext {
  catalogGeneratedAt?: string;
  catalogSourceHash?: string;
  launchPriorityListVersion?: string;
  launchPriorityFixtureHash?: string;
}

/**
 * Challenge stage name → v4 `comparison_group.role_varied` (HOK-3415). A
 * historical `unrecoverable` stage (stage lost in backfill) omits the whole
 * block: a comparison with no varied role is unusable.
 */
const CHALLENGE_STAGE_TO_ROLE: Partial<Record<EvalRecordChallengeStage, RouteRole>> = {
  plan: 'planner',
  implementation: 'coder',
  review: 'reviewer',
};

/**
 * `executed-model-resolver` evidence source → v4 `model_evidence`. Repair
 * stages (`launch-record`) map to `requested_only`, matching the HOK-3415
 * invariant that a repair stage has no independent execution record to verify.
 */
function toModelEvidence(
  evidenceStatus: ExecutedModelEvidenceStatus,
  evidenceSource: ExecutedModelEvidenceSource | 'launch-record' | 'unknown',
): ModelEvidence {
  if (evidenceStatus !== 'direct') return 'requested_only';
  if (evidenceSource === 'provider-response' || evidenceSource === 'native-runtime') {
    return 'provider_response';
  }
  if (
    evidenceSource === 'claude-session'
    || evidenceSource === 'codex-session'
    || evidenceSource === 'session-stream'
  ) {
    return 'session_telemetry';
  }
  // Launch-record evidence is intent, not execution; a repair stage advertises
  // it as `requested_only` so Hokusai never confuses it with verified execution.
  return 'requested_only';
}

const HARNESS_LABEL: Record<SessionHarness, string> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  native: 'native',
};

interface ResolvedStageExecution {
  stage: ExecutionStage;
  harness: SessionHarness;
  executedModel: string;
  modelEvidence: ModelEvidence;
  summaries: TaskCostSummaryV1[];
  sessionIds: string[];
}

/**
 * Build one stage execution per `(stage, harness)` for one execution stage's
 * owned rows (`executionStageForRow`): the v4 contract splits a stage that
 * spans harnesses into one entry per harness. A helper session counts in the
 * stage it served; a repair stage is its own stage (HOK-3415).
 */
function stageExecutionsForStage(
  input: {
    stage: ExecutionStage;
    rows: SessionOwnershipRow[];
    summariesByStage: Map<ExecutionStage, TaskCostSummaryV1[]>;
    featureDir: string;
    worktreePath: string;
    branchName: string;
    repoDir: string;
  },
): ResolvedStageExecution[] {
  const { stage, rows } = input;
  if (rows.length === 0) return [];

  const results: ResolvedStageExecution[] = [];
  for (const [harness, harnessRows] of groupByHarness(rows)) {
    const summaries = pickSummariesForHarness(input.summariesByStage.get(stage) ?? [], harness);
    const resolved = resolveExecutedModelForStage({
      stage,
      rows: harnessRows,
      featureDir: input.featureDir,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      repoDir: input.repoDir,
    });
    if (!resolved.executedModel) {
      // No model could be established at all — skip the entry so the row
      // never ships a stage with an empty `executed_model`. The sibling
      // entries (if any) are still emitted, and a task with no resolvable
      // stage falls out through the `stageExecutions.length === 0` guard.
      continue;
    }
    results.push({
      stage,
      harness,
      executedModel: resolved.executedModel,
      modelEvidence: toModelEvidence(resolved.evidenceStatus, resolved.evidenceSource),
      summaries,
      sessionIds: harnessRows.map((row) => row.sessionRef),
    });
  }
  return results;
}

/**
 * Pick the task-cost summaries that match a harness. The meter's per-stage
 * group may span harnesses (rare but possible); the v4 contract asks for one
 * summary per `(stage, harness)` pair.
 */
function pickSummariesForHarness(
  summaries: readonly TaskCostSummaryV1[],
  harness: SessionHarness,
): TaskCostSummaryV1[] {
  const label = HARNESS_LABEL[harness];
  return summaries.filter((summary) => summary.harness === label);
}

interface ResolvedStageModel {
  executedModel: string | null;
  evidenceStatus: ExecutedModelEvidenceStatus;
  evidenceSource: ExecutedModelEvidenceSource | 'launch-record' | 'unknown';
}

function resolveExecutedModelForStage(input: {
  stage: ExecutionStage;
  rows: SessionOwnershipRow[];
  featureDir: string;
  worktreePath: string;
  branchName: string;
  repoDir: string;
}): ResolvedStageModel {
  const fallbackModel = latestLaunchModel(input.rows);

  if (isRepairStageKind(input.stage)) {
    const repair = hokusaiSubmissionTriggerDeps.resolveRepairStageExecutedModel({
      featureDir: input.featureDir,
      kind: input.stage,
      ownership: input.rows,
    });
    return {
      executedModel: repair.executedModel ?? fallbackModel,
      evidenceStatus: repair.evidenceStatus,
      evidenceSource: repair.evidenceSource,
    };
  }

  const resolved = hokusaiSubmissionTriggerDeps.resolveStageExecutedModel({
    featureDir: input.featureDir,
    stage: input.stage,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    repoDir: input.repoDir,
  });
  return {
    executedModel: resolved.executedModel ?? fallbackModel,
    evidenceStatus: resolved.evidenceStatus,
    evidenceSource: resolved.evidenceSource as ResolvedStageModel['evidenceSource'],
  };
}

function latestLaunchModel(rows: readonly SessionOwnershipRow[]): string | null {
  if (rows.length === 0) return null;
  const latest = rows.reduce((max, row) => (
    Date.parse(row.launchedAt) > Date.parse(max.launchedAt) ? row : max
  ));
  return latest.model || null;
}

/**
 * Build the v4 projection for one eval record. Returns `null` when the task
 * has no measurable stage execution (no owned sessions) — the trigger turns
 * that into a `not_eligible` outcome rather than throwing. HOK-3415.
 */
export function buildHokusaiV4Projection(
  submission: HokusaiSubmission,
  record: EvalRecord,
  meteredCost: MeteredWorkflowCost | null,
  options: Pick<TriggerHokusaiSubmissionOptions, 'repoDir' | 'worktreePath' | 'branchName' | 'configDir' | 'redactionSalt'>,
): RedactedEvalContributionProjectionV4 | null {
  const ownershipRows: readonly SessionOwnershipRow[] = meteredCost?.owned ?? [];
  if (ownershipRows.length === 0) return null;
  // Stage costs leave under the same redaction as the submission (HOK-2787):
  // the row's hashed task id, hashed session and event ids.
  const salt = options.redactionSalt ?? getOrCreateRedactionSalt(options.configDir);

  const featureDir = resolveFeatureDir(options, record, meteredCost);
  const summariesByStage = meteredCost?.summariesByStage ?? new Map<ExecutionStage, TaskCostSummaryV1[]>();

  const stageExecutions: StageExecutionProjection[] = [];
  for (const [stage, rows] of groupByExecutionStage(ownershipRows)) {
    const entries = stageExecutionsForStage({
      stage,
      rows,
      summariesByStage,
      featureDir,
      worktreePath: options.worktreePath ?? options.repoDir,
      branchName: options.branchName ?? '',
      repoDir: options.repoDir,
    });
    for (const entry of entries) {
      stageExecutions.push({
        stage: entry.stage,
        executedModel: entry.executedModel,
        modelEvidence: entry.modelEvidence,
        harness: HARNESS_LABEL[entry.harness],
        cost: {
          summaries: entry.summaries.map((summary) => redactStageTaskCost(summary, { taskId: submission.task_id, salt })),
        },
        ...(entry.sessionIds.length > 0 ? { sessionIds: redactSessionIds(entry.sessionIds, { salt }) } : {}),
      });
    }
  }

  if (stageExecutions.length === 0) return null;

  const fod = record.featureOutcomeDiagnostics;
  // The pair id is a task identifier (often the primary's issue id): it leaves
  // hashed like the row's task_id, identically for both arms.
  const rawComparisonGroup = buildComparisonGroup(record);
  const comparisonGroup = rawComparisonGroup
    ? { ...rawComparisonGroup, id: redactPairId(rawComparisonGroup.id, { salt }) }
    : null;
  const routingOutcome = routingOutcomeForProjection(
    record.routeProvenance?.stageRoutes,
    record.routeProvenance?.hokusaiInferenceLogId,
  );

  const { taskDescriptor, allowedModels, availableModels } = deriveTaskDescriptorFields(
    record,
    submission,
  );
  const projection: RedactedEvalContributionProjectionV4 = {
    taskId: submission.task_id,
    runId: submission.run_id,
    harness: 'wavemill',
    observedAt: record.timestamp,
    observedSuccess: submission.observed_outcomes.completed_successfully,
    budgetCompliant: toBudgetCompliant(submission),
    actualCostUsd: submission.observed_outcomes.actual_cost_usd,
    wallClockSeconds: submission.observed_outcomes.actual_time_seconds ?? undefined,
    taskDescriptor,
    allowedModels,
    availableModels,
    selectedModels: {
      planner: submission.route_taken.planner_model,
      coder: submission.route_taken.coder_model,
      reviewer: submission.route_taken.reviewer_model,
    },
    stageExecutions,
    ...(routingOutcome.inferenceLogId
      ? {
        inferenceLogId: routingOutcome.inferenceLogId,
        routeOverrides: toSdkRouteOverrides(routingOutcome.routeOverrides ?? []),
      }
      : {}),
    ...(comparisonGroup ? { comparisonGroup } : {}),
    // Feature outcome artifact diagnostics (HOK-2262). Kept on v4 as they
    // describe eval-side evidence, not row inputs.
    ...(fod?.eligibilityDiagnostic !== undefined
      ? { outcomeDiagnostic: fod.eligibilityDiagnostic }
      : {}),
    ...(fod !== undefined
      ? {
        outcomeSource: deriveOutcomeSource(fod.used, fod.present),
      }
      : {}),
    ...(fod !== undefined ? { outcomeArtifactPresent: fod.present } : {}),
    ...(fod !== undefined ? { outcomeArtifactValid: fod.valid } : {}),
    ...(fod !== undefined ? { outcomeArtifactUsed: fod.used } : {}),
    ...(fod?.missingFields !== undefined ? { outcomeMissingFields: fod.missingFields } : {}),
    ...(fod?.invalidFields !== undefined ? { outcomeInvalidFields: fod.invalidFields } : {}),
    ...(fod?.reason !== undefined && fod.reason !== 'loaded'
      ? { outcomeFailureReason: fod.reason }
      : {}),
  };

  return projection;
}

/**
 * Convert Wavemill's richer `StageRouteOverride[]` (carries `triggers`,
 * `hokusai.requestId`, `pairId`, `actor`, …) to the SDK contract's
 * `RouteOverride[]`: `{ role, source, from, to, reason }`. HOK-3415 drops
 * local-only fields the SDK schema doesn't allow; Hokusai reads the role from
 * the Wavemill stage name (`planner | coder | reviewer`).
 */
function toSdkRouteOverrides(
  overrides: readonly StageRouteOverride[],
): Array<{ role: RouteRole; source: StageRouteOverride['source']; from: string; to: string; reason: string }> {
  return overrides.map((override) => ({
    role: override.stage,
    source: override.source,
    from: override.from,
    to: override.to,
    reason: override.reason,
  }));
}

function deriveOutcomeSource(
  used: boolean,
  present: boolean,
): 'feature_outcome_artifact' | 'reconstructed' | 'unknown' {
  if (used) return 'feature_outcome_artifact';
  if (present) return 'unknown';
  return 'reconstructed';
}

/**
 * Pull `taskDescriptor` / `allowedModels` / `availableModels` from the eval
 * record's `taskDescriptor` (the Wavemill router input) by threading it through
 * `toHokusaiInput`, which normalises the heuristic/learned signals into the
 * Hokusai taxonomy. The v4 builder (via v3) refuses a projection without these.
 */
function deriveTaskDescriptorFields(record: EvalRecord, submission: HokusaiSubmission): {
  taskDescriptor: HokusaiTaskDescriptor;
  allowedModels: string[];
  availableModels: HokusaiAvailableModels;
} {
  const input = toHokusaiInput(record.taskDescriptor, undefined, undefined, submission.task_id);
  const allowed = new Set<string>();
  allowed.add(submission.route_taken.planner_model);
  allowed.add(submission.route_taken.coder_model);
  allowed.add(submission.route_taken.reviewer_model);
  for (const model of input.available_models.planner_models) allowed.add(model);
  for (const model of input.available_models.coder_models) allowed.add(model);
  for (const model of input.available_models.reviewer_models) allowed.add(model);
  return {
    taskDescriptor: input.task_descriptor,
    allowedModels: [...allowed],
    availableModels: input.available_models,
  };
}

function buildComparisonGroup(record: EvalRecord): ComparisonGroupProjection | null {
  const pairId = record.challengePairId;
  const stage = record.challengeStage;
  if (!pairId || !stage) return null;
  const roleVaried = CHALLENGE_STAGE_TO_ROLE[stage];
  if (!roleVaried) return null;
  return { id: pairId, roleVaried };
}

/**
 * Prefer the live state dir recorded in the ownership-file candidates; fall
 * back to the worktree. The repair-stage resolver reads `.session-ownership`
 * and `.ready-result.json` from this directory.
 */
function resolveFeatureDir(
  options: Pick<TriggerHokusaiSubmissionOptions, 'repoDir' | 'worktreePath'>,
  record: EvalRecord,
  meteredCost: MeteredWorkflowCost | null,
): string {
  if (meteredCost && record.issueId) {
    const located = hokusaiSubmissionTriggerDeps.locateOwnershipRows({
      repoDir: options.repoDir,
      issueId: record.issueId,
    });
    const file = located.files[0];
    if (file) {
      const slash = file.lastIndexOf('/');
      if (slash >= 0) return file.slice(0, slash);
    }
  }
  return options.worktreePath ?? options.repoDir;
}

function warnHokusai(message: string, error: unknown): void {
  console.warn(`[hokusai] ${message}: ${errorMessage(error)}`);
}

function renderOptionalBool(value: boolean | undefined): string {
  return value === undefined ? 'unset' : String(value);
}

function repoConfigDisabledDetail(repoDir: string): string {
  const sources = hokusaiSubmissionTriggerDeps.getHokusaiSubmissionEnableSources(repoDir);
  return `hokusai.dataSubmission.enabled resolved false for repoDir=${repoDir} (base=${renderOptionalBool(sources.baseEnabled)} local=${renderOptionalBool(sources.localEnabled)})`;
}

function consentDisabledDetail(options: TriggerHokusaiSubmissionOptions, blockers: string[]): string {
  const report = hokusaiSubmissionTriggerDeps.getSubmissionSwitchReport(options);
  return `user consent store ${report.userConfigPath} blocked submissions (${blockers.join(', ') || 'unknown blocker'}); ${formatSubmissionSwitches(report)}; run 'wavemill hokusai enable'`;
}

function triggerLogEntry(
  record: EvalRecord,
  result: HokusaiSubmissionTriggerResult,
  options: TriggerHokusaiSubmissionOptions,
): Parameters<typeof appendTriggerLogEntry>[0] {
  return {
    at: new Date().toISOString(),
    ...(record.id ? { evalId: record.id } : {}),
    ...(record.issueId ? { issueId: record.issueId } : {}),
    status: result.status,
    ...(result.status === 'enqueued' && result.entryId ? { entryId: result.entryId } : {}),
    ...(result.status === 'enqueued' && result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}),
    ...(options.promotedBackfill?.manifestId ? { promotionManifestId: options.promotedBackfill.manifestId } : {}),
    ...(options.promotedBackfill?.reconciliationReportHash
      ? { reconciliationReportHash: options.promotedBackfill.reconciliationReportHash }
      : {}),
    ...(result.status === 'not_eligible' ? { reasons: result.reasons } : {}),
    ...(result.status === 'disabled' ? { source: result.source, detail: result.detail } : {}),
    ...(result.status === 'failed' ? { detail: result.error } : {}),
  };
}

function recordTriggerResult(
  record: EvalRecord,
  repoDir: string,
  result: HokusaiSubmissionTriggerResult,
  options: TriggerHokusaiSubmissionOptions,
): HokusaiSubmissionTriggerResult {
  try {
    hokusaiSubmissionTriggerDeps.appendTriggerLogEntry(triggerLogEntry(record, result, options), repoDir);
  } catch (error) {
    warnHokusai('failed to append trigger log', error);
  }
  return result;
}

function queueProvenanceFromRecord(
  record: EvalRecord,
  options: TriggerHokusaiSubmissionOptions,
): HokusaiQueueProvenance | undefined {
  if (!record.id) {
    return undefined;
  }
  const coderIdentity = record.modelIdentityAttribution?.roles.coder;
  const promotedBackfill = options.promotedBackfill;
  if (!promotedBackfill) {
    return {
      evalId: record.id,
      source: 'live',
      ...(coderIdentity?.identityRevision !== undefined ? { identityRevision: coderIdentity.identityRevision } : {}),
      ...(coderIdentity?.fingerprint ? { identityFingerprint: coderIdentity.fingerprint } : {}),
    };
  }
  return {
    evalId: record.id,
    source: 'promoted_backfill',
    identityRevision: promotedBackfill.toRevision,
    ...(promotedBackfill.finalFingerprint ?? coderIdentity?.fingerprint
      ? { identityFingerprint: promotedBackfill.finalFingerprint ?? coderIdentity?.fingerprint }
      : {}),
    promotionManifestId: promotedBackfill.manifestId,
    promotionFromRevision: promotedBackfill.fromRevision,
    promotionToRevision: promotedBackfill.toRevision,
    reconciliationReportHash: promotedBackfill.reconciliationReportHash,
  };
}

/**
 * Best-effort Hokusai submission trigger for completed eval records.
 *
 * The eval path should call this after persistence and await the enqueue
 * attempt. Upload is intentionally detached so evaluation completion remains
 * independent from endpoint latency or transient service failures.
 */
/**
 * Best-effort metering for a caller that did not hand in its own result
 * (backfill, replay): the one cost engine over the task's live or archived
 * session-ownership record (HOK-3328). A measurement failure is `null`, which
 * leaves the row without stage executions (`not_eligible`), never a throw.
 */
async function meterForSubmission(
  record: EvalRecord,
  options: TriggerHokusaiSubmissionOptions,
): Promise<MeteredWorkflowCost | null> {
  if (!record.issueId) return null;
  try {
    return await hokusaiSubmissionTriggerDeps.meterWorkflowCost({
      worktreePath: options.worktreePath ?? options.repoDir,
      branchName: options.branchName ?? '',
      repoDir: options.repoDir,
      issueId: record.issueId,
      label: 'Hokusai submission',
    });
  } catch (error) {
    warnHokusai('cost metering failed', error);
    return null;
  }
}

export async function triggerHokusaiSubmission(
  record: EvalRecord,
  options: TriggerHokusaiSubmissionOptions,
): Promise<HokusaiSubmissionTriggerResult> {
  try {
    const config = hokusaiSubmissionTriggerDeps.getHokusaiSubmissionConfig(options.repoDir);
    if (config.enabled !== true) {
      return recordTriggerResult(record, options.repoDir, {
        status: 'disabled',
        source: 'repo_config',
        detail: repoConfigDisabledDetail(options.repoDir),
      }, options);
    }

    const submissionResult = hokusaiSubmissionTriggerDeps.toHokusaiSubmission(record);
    if (!submissionResult.ok) {
      return recordTriggerResult(record, options.repoDir, { status: 'not_eligible', reasons: submissionResult.reasons }, options);
    }

    const redactedSubmission = hokusaiSubmissionTriggerDeps.redactHokusaiSubmission(submissionResult.submission, {
      configDir: options.configDir,
      salt: options.redactionSalt,
    });
    const meteredCost = options.meteredCost ?? await meterForSubmission(record, options);
    const projection = buildHokusaiV4Projection(
      redactedSubmission,
      record,
      meteredCost,
      {
        repoDir: options.repoDir,
        worktreePath: options.worktreePath,
        branchName: options.branchName,
        configDir: options.configDir,
        redactionSalt: options.redactionSalt,
      },
    );
    if (!projection) {
      return recordTriggerResult(record, options.repoDir, {
        status: 'not_eligible',
        reasons: ['no_stage_executions'],
      }, options);
    }

    const row = hokusaiSubmissionTriggerDeps.buildTechnicalTaskRouterRowV4(projection);
    const enqueueResult = await hokusaiSubmissionTriggerDeps.enqueueContribution(row, {
      repoDir: options.repoDir,
      configDir: options.configDir,
      provenance: queueProvenanceFromRecord(record, options),
    });

    if (enqueueResult.status === 'disabled') {
      const detail = consentDisabledDetail(options, enqueueResult.blockers);
      console.warn(`[hokusai] submission disabled by consent gate: ${detail}`);
      return recordTriggerResult(record, options.repoDir, {
        status: 'disabled',
        source: 'consent',
        detail,
      }, options);
    }
    if (enqueueResult.status === 'duplicate') {
      return recordTriggerResult(record, options.repoDir, { status: 'duplicate', drainStarted: false }, options);
    }

    void hokusaiSubmissionTriggerDeps.drainContributionQueue({
      repoDir: options.repoDir,
      configDir: options.configDir,
    }).catch((error) => {
      warnHokusai('opportunistic drain failed', error);
    });
    return recordTriggerResult(record, options.repoDir, {
      status: 'enqueued',
      entryId: enqueueResult.entry?.entryId,
      idempotencyKey: enqueueResult.entry?.idempotencyKey,
      drainStarted: true,
    }, options);
  } catch (error) {
    warnHokusai('submission trigger failed', error);
    return recordTriggerResult(record, options.repoDir, { status: 'failed', error: errorMessage(error) }, options);
  }
}
