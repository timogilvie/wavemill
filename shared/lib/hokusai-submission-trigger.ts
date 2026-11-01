import { getHokusaiSubmissionConfig, getHokusaiSubmissionEnableSources } from './config.ts';
import { buildSubmitDataContributionRow, type RedactedEvalContributionProjection } from './hokusai-contribution-builder.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution, type HokusaiQueueProvenance } from './hokusai-queue.ts';
import { formatSubmissionSwitches, getSubmissionSwitchReport } from './hokusai-consent.ts';
import { redactHokusaiSubmission } from './hokusai-redaction.ts';
import { toHokusaiSubmission, type HokusaiSubmission } from './hokusai-schema.ts';
import { appendTriggerLogEntry } from './hokusai-trigger-log.ts';
import { errorMessage } from './error-utils.ts';
import type { EvalRecord } from './eval-schema.ts';
import { routeRecordContributionInputs } from './route-override-record.ts';

export interface TriggerHokusaiSubmissionOptions {
  repoDir: string;
  configDir?: string;
  redactionSalt?: string;
  launchPriorityValidation?: LaunchPriorityValidationContext;
  promotedBackfill?: PromotedBackfillContext;
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
  buildSubmitDataContributionRow,
  enqueueContribution,
  drainContributionQueue,
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

function toLaunchPriorityInputs(
  launchPriorityValidation: LaunchPriorityValidationContext | undefined,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (launchPriorityValidation?.catalogGeneratedAt) {
    inputs.launch_priority_catalog_generated_at = launchPriorityValidation.catalogGeneratedAt;
  }
  if (launchPriorityValidation?.catalogSourceHash) {
    inputs.launch_priority_catalog_source_hash = launchPriorityValidation.catalogSourceHash;
  }
  if (launchPriorityValidation?.launchPriorityListVersion) {
    inputs.launch_priority_list_version = launchPriorityValidation.launchPriorityListVersion;
  }
  if (launchPriorityValidation?.launchPriorityFixtureHash) {
    inputs.launch_priority_fixture_hash = launchPriorityValidation.launchPriorityFixtureHash;
  }
  return inputs;
}

export function buildHokusaiContributionProjection(
  submission: HokusaiSubmission,
  observedAt: string,
  record?: EvalRecord,
  launchPriorityValidation?: LaunchPriorityValidationContext,
): RedactedEvalContributionProjection {
  const fod = record?.featureOutcomeDiagnostics ?? undefined;

  const projection: RedactedEvalContributionProjection = {
    taskId: submission.task_id,
    runId: submission.run_id,
    harness: 'wavemill',
    observedAt,
    observedSuccess: submission.observed_outcomes.completed_successfully,
    budgetCompliant: toBudgetCompliant(submission),
    actualCostUsd: submission.observed_outcomes.actual_cost_usd,
    wallClockSeconds: submission.observed_outcomes.actual_time_seconds ?? undefined,
    inputs: {
      schema_version: submission.schema_version,
      planner_model: submission.route_taken.planner_model,
      coder_model: submission.route_taken.coder_model,
      reviewer_model: submission.route_taken.reviewer_model,
      intervention_count: submission.observed_outcomes.intervention_count,
      rubric_version: submission.rubric_signals?.rubric_version,
      rubric_mean_score: submission.rubric_signals?.mean_score,
      determinative_boundary: submission.rubric_signals?.determinative_boundary,
      ...(record?.attempted_model
        ? { coder_attempted_model: record.attempted_model }
        : {}),
      ...(record?.model_alias
        ? { coder_model_alias: record.model_alias }
        : {}),
      ...toLaunchPriorityInputs(launchPriorityValidation),
      // HOK-3363: the join key Hokusai logged its prediction under, plus every
      // override of that prediction, so the outcome is attributed to what
      // Hokusai recommended rather than to whatever ran.
      ...routeRecordContributionInputs(
        record?.routeProvenance?.stageRoutes,
        record?.routeProvenance?.hokusaiInferenceLogId,
      ),
    },
    // Feature outcome artifact diagnostics (HOK-2262)
    // Only safe scalar/enum/array-of-string fields; no raw paths or issue IDs
    ...(fod?.eligibilityDiagnostic !== undefined
      ? { outcomeDiagnostic: fod.eligibilityDiagnostic }
      : {}),
    ...(fod !== undefined
      ? {
        outcomeSource: (
          fod.used
            ? 'feature_outcome_artifact'
            : fod.present
              ? 'unknown'
              : 'reconstructed'
        ) as const,
      }
      : {}),
    ...(fod !== undefined
      ? { outcomeArtifactPresent: fod.present }
      : {}),
    ...(fod !== undefined
      ? { outcomeArtifactValid: fod.valid }
      : {}),
    ...(fod !== undefined
      ? { outcomeArtifactUsed: fod.used }
      : {}),
    ...(fod?.missingFields !== undefined
      ? { outcomeMissingFields: fod.missingFields }
      : {}),
    ...(fod?.invalidFields !== undefined
      ? { outcomeInvalidFields: fod.invalidFields }
      : {}),
    ...(fod?.reason !== undefined && fod.reason !== 'loaded'
      ? { outcomeFailureReason: fod.reason }
      : {}),
  };

  return projection;
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
    const row = hokusaiSubmissionTriggerDeps.buildSubmitDataContributionRow(
      buildHokusaiContributionProjection(
        redactedSubmission,
        record.timestamp,
        record,
        options.launchPriorityValidation,
      ),
    );
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
