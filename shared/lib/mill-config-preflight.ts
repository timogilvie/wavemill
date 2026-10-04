import { resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import { listCoderCanaryGaps, type CoderCanaryGap } from './launchable-models.ts';
import type { ModelRegistry } from './model-registry.ts';
import {
  type RemovedModelSettingInventoryItem,
  scanForbiddenModelSettings,
} from './model-settings-migrator.ts';
import {
  hasCertificationAutoRemediationWork,
  runCertificationAutoRemediation,
  type AutoRemediationResult,
} from './native-agent/certification/auto-remediate.ts';
import {
  evaluateSuiteCoverage,
  type IneligibleModel,
  type SuiteCoverageResult,
} from './native-agent/certification/coverage.ts';
import {
  REIDENTIFICATION_CAUSE_LABELS,
  type ReidentificationCause,
} from './native-agent/certification/catalog-hash-migration.ts';
import {
  evaluateCanaryCohortHealth,
  refreshCanaryCohort,
  renderCanaryCohortHealth,
  resolveCanaryCohort,
  type CanaryCohortHealth,
  type CohortRefreshMemberOutcome,
} from './native-agent/certification/canary-cohort.ts';
import type { certifyNativeAgent, certifySelectedNativeAgents } from '../../tools/native-agent-certify.ts';

export const MILL_CONFIG_MIGRATION_COMMAND = 'wavemill config migrate-model-settings';

export interface MillConfigPreflightReport {
  repoDir: string;
  removedFields: RemovedModelSettingInventoryItem[];
  validationError: string | null;
  migrationCommand: string;
  certificationCoverage?: SuiteCoverageResult;
  certificationRemediation?: Pick<
    AutoRemediationResult,
    'attempted' | 'mode' | 'targets' | 'published' | 'failed' | 'skipped'
  > & {
    remediationLog: string[];
    /**
     * Models re-identified before remediation ran, with their cause
     * (HOK-3159), so the report names one cause instead of N re-certifications.
     */
    reidentified?: IneligibleModel[];
  };
  /** Live-coding canary cohort health (HOK-3062). Present when a cohort is configured. */
  canaryCohortHealth?: CanaryCohortHealth;
  canaryCohortRefresh?: {
    attempted: number;
    outcomes: CohortRefreshMemberOutcome[];
    refreshLog: string[];
  };
  /**
   * Advisory only (HOK-3142): router-eligible native coders the coding launch
   * gate refuses for a live-canary reason. Never affects `ok`.
   */
  coderCanaryGaps?: CoderCanaryGap[];
}

export interface MillConfigPreflightResult {
  ok: boolean;
  report: MillConfigPreflightReport;
}

export interface MillConfigPreflightOptions {
  json?: boolean;
  registry?: ModelRegistry;
  certificationRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  certifyFn?: typeof certifySelectedNativeAgents;
  attemptCachePath?: string;
  /** Test seam for the cohort canary refresh certify pipeline. */
  canaryCertifyFn?: typeof certifyNativeAgent;
  canaryAttemptCachePath?: string;
}

function validationMessage(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }
  if (!err.message.startsWith('Config validation failed:')) {
    return null;
  }
  return err.message;
}

export async function runMillConfigPreflight(
  repoDir: string,
  options: MillConfigPreflightOptions = {},
): Promise<MillConfigPreflightResult> {
  const absRepoDir = resolve(repoDir);
  const removedFields = scanForbiddenModelSettings(absRepoDir);
  let validationError: string | null = null;
  let config: ReturnType<typeof loadWavemillConfig> | undefined;

  try {
    config = loadWavemillConfig(absRepoDir);
  } catch (err) {
    const message = validationMessage(err);
    if (!message) {
      throw err;
    }
    validationError = message;
  }

  const env = options.env ?? process.env;
  const certificationConfig = config?.nativeAgent?.certification ?? {};
  const renewalWindowDays = normalizeRenewalWindowDays(certificationConfig.renewalWindowDays);
  const configAutoRemediate = certificationConfig.autoRemediate !== false;
  const autoRemediationEnabled = configAutoRemediate
    && env.WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE !== '1'
    && env.WAVEMILL_DRY_RUN !== '1'
    && env.WAVEMILL_MILL_DRY_RUN !== '1';
  let certificationCoverage = env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD === '1'
    ? undefined
    : evaluateSuiteCoverage({
      repoDir: absRepoDir,
      registry: options.registry,
      root: options.certificationRoot,
      now: options.now?.(),
      renewalWindowDays,
    });
  let certificationRemediation: MillConfigPreflightReport['certificationRemediation'];

  if (
    certificationCoverage
    && autoRemediationEnabled
    && hasCertificationAutoRemediationWork(certificationCoverage)
  ) {
    const remediationLog: string[] = [];
    const remediation = await runCertificationAutoRemediation({
      registry: options.registry,
      repoDir: absRepoDir,
      coverage: certificationCoverage,
      root: options.certificationRoot,
      env,
      now: options.now,
      renewalWindowDays,
      log: (line) => remediationLog.push(line),
      certifyFn: options.certifyFn,
      attemptCachePath: options.attemptCachePath,
    });
    const reidentified = reidentifiedModels(certificationCoverage.ineligibleModels);
    certificationRemediation = {
      attempted: remediation.attempted,
      mode: remediation.mode,
      targets: remediation.targets,
      published: remediation.published,
      failed: remediation.failed,
      skipped: remediation.skipped,
      remediationLog,
      ...(reidentified.length > 0 ? { reidentified } : {}),
    };
    certificationCoverage = evaluateSuiteCoverage({
      repoDir: absRepoDir,
      registry: options.registry,
      root: options.certificationRoot,
      now: options.now?.(),
      renewalWindowDays,
    });
  }

  // Live-coding canary cohort (HOK-3062): evaluate health for the bounded,
  // reviewed cohort and run at most one bounded refresh attempt per member
  // remediation episode when automatic remediation is enabled and credentials
  // are available. Never expands beyond the configured cohort.
  let canaryCohortHealth: CanaryCohortHealth | undefined;
  let canaryCohortRefresh: MillConfigPreflightReport['canaryCohortRefresh'];
  if (validationError === null && env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD !== '1') {
    const cohort = resolveCanaryCohort({ repoDir: absRepoDir, registry: options.registry });
    if (cohort.members.length > 0 || cohort.invalid.length > 0) {
      canaryCohortHealth = await evaluateCanaryCohortHealth({
        repoDir: absRepoDir,
        cohort,
        registry: options.registry,
        certificationRoot: options.certificationRoot,
        now: options.now?.(),
        attemptCachePath: options.canaryAttemptCachePath,
      });
      const canaryRefreshEnabled = autoRemediationEnabled
        && cohort.autoRefreshEnabled
        && env.WAVEMILL_SKIP_CANARY_AUTO_REFRESH !== '1';
      const hasRefreshTargets = canaryCohortHealth.members.some((member) =>
        member.state === 'missing'
        || member.state === 'stale'
        || member.state === 'renewal-due'
        || member.state === 'identity-invalidated'
        || member.state === 'inconclusive');
      if (canaryRefreshEnabled && hasRefreshTargets) {
        const refreshLog: string[] = [];
        const certifyFn = options.canaryCertifyFn
          ?? (await import('../../tools/native-agent-certify.ts')).certifyNativeAgent;
        const refresh = await refreshCanaryCohort({
          repoDir: absRepoDir,
          certifyFn,
          registry: options.registry,
          certificationRoot: options.certificationRoot,
          env,
          now: options.now,
          respectAttemptGuard: true,
          attemptCachePath: options.canaryAttemptCachePath,
          log: (line) => refreshLog.push(line),
        });
        canaryCohortRefresh = {
          attempted: refresh.attempted,
          outcomes: refresh.outcomes,
          refreshLog,
        };
        canaryCohortHealth = refresh.health;
      }
    }
  }

  // Advisory: never gating, and a failure to compute it never blocks startup.
  let coderCanaryGaps: CoderCanaryGap[] = [];
  if (validationError === null && env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD !== '1') {
    try {
      coderCanaryGaps = listCoderCanaryGaps({
        repoDir: absRepoDir,
        registry: options.registry,
        certificationRoot: options.certificationRoot,
        now: options.now?.(),
      });
    } catch {
      coderCanaryGaps = [];
    }
  }

  const certificationCoverageBlocked = certificationCoverage?.status === 'bump-without-publish'
    || certificationCoverage?.status === 'identity-drift';
  const certificationStaleBlocked = certificationCoverage?.status === 'stale';
  const certificationEmptyBlocked = certificationCoverage?.status === 'empty-store'
    && certificationCoverage.nativeModelCount > 0;

  const report: MillConfigPreflightReport = {
    repoDir: absRepoDir,
    removedFields,
    validationError,
    migrationCommand: MILL_CONFIG_MIGRATION_COMMAND,
    ...(certificationCoverage ? { certificationCoverage } : {}),
    ...(certificationRemediation ? { certificationRemediation } : {}),
    ...(canaryCohortHealth ? { canaryCohortHealth } : {}),
    ...(canaryCohortRefresh ? { canaryCohortRefresh } : {}),
    ...(coderCanaryGaps.length > 0 ? { coderCanaryGaps } : {}),
  };

  return {
    ok: removedFields.length === 0
      && validationError === null
      && !certificationCoverageBlocked
      && !certificationStaleBlocked
      && !certificationEmptyBlocked,
    report,
  };
}

export function formatMillConfigPreflightReport(report: MillConfigPreflightReport): string {
  const lines = [
    'Mill preflight failed.',
    '',
    `Repository: ${report.repoDir}`,
  ];

  if (report.removedFields.length > 0) {
    lines.push('', 'Removed repo-local model fields:');
    for (const item of report.removedFields) {
      const modelList = item.modelIds.length > 0 ? ` models=${item.modelIds.join(',')}` : '';
      lines.push(`  ${item.file}: ${item.path} - ${item.summary}${modelList}`);
    }
  }

  if (report.validationError) {
    lines.push('', 'TypeScript config validation error:', report.validationError);
  }

  if (report.certificationCoverage?.status === 'bump-without-publish') {
    const coverage = report.certificationCoverage;
    const otherSuites = Object.entries(coverage.artifactCountByOtherSuite)
      .map(([suiteVersion, count]) => `${count} ${suiteVersion}`)
      .join(', ');
    lines.push(
      '',
      'Native certification suite coverage:',
      `  ERROR: certificationSuiteVersion is '${coverage.requiredSuiteVersion}' but the global store (${coverage.root}) has 0 matching artifacts${otherSuites ? ` (${otherSuites} found)` : ''}.`,
      '  The suite version was bumped without republishing the matrix.',
      `  Run: ${coverage.remediationCommand}`,
      '  Auto-remediation can be disabled with WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1.',
      '  To skip only this guard, set WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1.',
    );
  }

  if (report.certificationCoverage?.status === 'identity-drift') {
    const coverage = report.certificationCoverage;
    const drifted = reidentifiedModels(coverage.ineligibleModels);
    lines.push(
      '',
      'Native certification identity drift:',
      `  ERROR: ${coverage.artifactCountForRequiredSuite} artifact(s) are present at suite '${coverage.requiredSuiteVersion}',`,
      `  but ${coverage.identityDriftCount} model(s) no longer match their certified subject and only`,
      `  ${coverage.eligibleModelCount} remain launchable. Store: ${coverage.root}`,
      ...formatReidentificationCauses(drifted.length > 0 ? drifted : coverage.ineligibleModels),
      `  Run: ${coverage.remediationCommand}`,
      '  Auto-remediation can be disabled with WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1.',
      '  To skip only this guard, set WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1.',
    );
  }

  if (report.certificationCoverage?.status === 'stale') {
    const coverage = report.certificationCoverage;
    const sample = coverage.staleModels.slice(0, 6).map((m) => m.registryKey).join(', ');
    const more = coverage.staleModels.length > 6
      ? ` (+${coverage.staleModels.length - 6} more)`
      : '';
    lines.push(
      '',
      'Native certification staleness:',
      `  ERROR: ${coverage.staleCount} model(s) have expired certification artifacts for suite '${coverage.requiredSuiteVersion}'.`,
      `  ${coverage.eligibleModelCount} remain launchable. Store: ${coverage.root}`,
      `  Affected: ${sample}${more}`,
      `  Run: ${coverage.remediationCommand}`,
      '  Auto-remediation can be disabled with WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1.',
      '  To skip only this guard, set WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1.',
    );
  }

  if (report.certificationCoverage?.status === 'empty-store') {
    const coverage = report.certificationCoverage;
    lines.push(
      '',
      'Native certification suite coverage:',
      `  ERROR: the global store (${coverage.root}) has no native certification artifacts for suite '${coverage.requiredSuiteVersion}'.`,
      `  Run: ${coverage.remediationCommand}`,
      '  Auto-remediation can be disabled with WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1.',
      '  To skip only this guard, set WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1.',
    );
  }

  if (report.certificationRemediation) {
    lines.push('', formatCertificationRemediationReport(report));
  }

  if (report.canaryCohortHealth) {
    lines.push('', formatCanaryCohortReport(report));
  }

  if (report.coderCanaryGaps?.length) {
    lines.push('', formatCoderCanaryGapReport(report));
  }

  if (report.removedFields.length > 0 || report.validationError) {
    lines.push(
      '',
      'Run the migration once from the repository root:',
      `  ${report.migrationCommand}`,
      '',
      'Preview first with:',
      `  ${report.migrationCommand} --dry-run`,
    );
  }

  return lines.join('\n');
}

export function formatCertificationRemediationReport(report: MillConfigPreflightReport): string {
  const remediation = report.certificationRemediation;
  if (!remediation) {
    return '';
  }
  const lines = [
    'Native certification auto-remediation:',
    `  mode=${remediation.mode} attempted=${remediation.attempted ? 'yes' : 'no'} targets=${remediation.targets.length}`,
    `  published=${remediation.published.length} failed=${remediation.failed.length} skipped=${remediation.skipped.length}`,
  ];
  if (remediation.reidentified?.length) {
    lines.push(
      `  ${remediation.reidentified.length} model(s) re-identified before remediation:`,
      ...formatReidentificationCauses(remediation.reidentified),
    );
  }
  for (const line of remediation.remediationLog) {
    lines.push(`  ${line}`);
  }
  for (const failure of remediation.failed.slice(0, 6)) {
    lines.push(`  failed: ${failure.provider}/${failure.model} - ${failure.reason}`);
  }
  if (remediation.failed.length > 6) {
    lines.push(`  (+${remediation.failed.length - 6} more failures)`);
  }
  return lines.join('\n');
}

/**
 * Format the live-coding canary cohort block (health, refresh outcomes, and
 * the below-minimum alert). Empty string when no cohort is configured.
 */
export function formatCanaryCohortReport(report: MillConfigPreflightReport): string {
  const health = report.canaryCohortHealth;
  if (!health) {
    return '';
  }
  const lines = [renderCanaryCohortHealth(health)];
  const refresh = report.canaryCohortRefresh;
  if (refresh) {
    lines.push(`  refresh attempted=${refresh.attempted}`);
    for (const line of refresh.refreshLog) {
      lines.push(`  ${line}`);
    }
    for (const outcome of refresh.outcomes) {
      if (outcome.action === 'not-due' && !outcome.reason) continue;
      lines.push(
        `  ${outcome.provider}/${outcome.model}: ${outcome.action}`
        + (outcome.result ? ` result=${outcome.result}` : '')
        + ` eligible=${outcome.codingEligible ? 'yes' : 'no'}`
        + (outcome.reason ? ` - ${outcome.reason}` : ''),
      );
    }
  }
  return lines.join('\n');
}

/**
 * Format the router-eligible coders that lack a passing live coding canary
 * (HOK-3142). Empty string when there are none.
 */
export function formatCoderCanaryGapReport(report: MillConfigPreflightReport): string {
  const gaps = report.coderCanaryGaps ?? [];
  if (gaps.length === 0) {
    return '';
  }
  return [
    `Coder live-canary gaps (advisory): ${gaps.length} router-eligible coder(s) cannot launch for coding and are skipped by routing:`,
    ...gaps.map((gap) => `  ${gap.modelId}: ${gap.certification}${gap.certifyCommand ? ` — run: ${gap.certifyCommand}` : ''}`),
  ].join('\n');
}

function reidentifiedModels(models: IneligibleModel[]): IneligibleModel[] {
  return models.filter((model) => (
    model.reason === 'identity-reidentified' || model.reason === 'identity-invalidated'
  ));
}

const SAMPLE_SIZE = 6;

function formatModelSample(keys: string[]): string {
  const more = keys.length > SAMPLE_SIZE ? ` (+${keys.length - SAMPLE_SIZE} more)` : '';
  return `${keys.slice(0, SAMPLE_SIZE).join(', ')}${more}`;
}

/**
 * Blast-radius summary for re-identified models (HOK-3159). One model keeps
 * the single `Affected:` line, annotated with its cause; several models are
 * grouped by cause so one shared root cause (e.g. a launch-priority fixture
 * edit) reads as one line rather than N separate re-certifications.
 */
export function formatReidentificationCauses(models: IneligibleModel[]): string[] {
  if (models.length === 0) return [];
  if (models.length === 1) {
    const [model] = models;
    const cause = model!.cause ? ` (${REIDENTIFICATION_CAUSE_LABELS[model!.cause]})` : '';
    return [`  Affected: ${model!.registryKey}${cause}`];
  }
  const byCause = new Map<ReidentificationCause, string[]>();
  for (const model of models) {
    const cause = model.cause ?? 'unknown';
    byCause.set(cause, [...(byCause.get(cause) ?? []), model.registryKey]);
  }
  const groups = [...byCause.entries()]
    .sort(([a, aKeys], [b, bKeys]) => bKeys.length - aKeys.length || a.localeCompare(b));
  return [
    '  Causes:',
    ...groups.map(([cause, keys]) => (
      `    - ${keys.length} model(s): ${REIDENTIFICATION_CAUSE_LABELS[cause]} — ${formatModelSample(keys)}`
    )),
  ];
}

function normalizeRenewalWindowDays(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 7;
  }
  return Math.max(0, Math.min(30, Math.trunc(value)));
}
