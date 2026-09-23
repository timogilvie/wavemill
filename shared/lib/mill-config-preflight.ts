import { resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import type { ModelRegistry } from './model-registry.ts';
import {
  type RemovedModelSettingInventoryItem,
  scanForbiddenModelSettings,
} from './model-settings-migrator.ts';
import {
  isCertificationAutoRemediationTrigger,
  runCertificationAutoRemediation,
  runCanaryCohortRemediation,
  type AutoRemediationResult,
  type CanaryCohortRemediationResult,
} from './native-agent/certification/auto-remediate.ts';
import {
  evaluateSuiteCoverage,
  type SuiteCoverageResult,
} from './native-agent/certification/coverage.ts';
import {
  evaluateCohortHealth,
  type CohortHealthSummary,
} from './native-agent/certification/canary-cohort.ts';
import type { certifySelectedNativeAgents } from '../../tools/native-agent-certify.ts';

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
  };
  canaryCohortHealth?: CohortHealthSummary;
  canaryCohortRemediation?: Pick<
    CanaryCohortRemediationResult,
    'attempted' | 'mode'
  > & {
    remediationLog: string[];
  };
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
    && (
      isCertificationAutoRemediationTrigger(certificationCoverage.status)
      || certificationCoverage.modelsInRenewalWindow.length > 0
    )
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
    certificationRemediation = {
      attempted: remediation.attempted,
      mode: remediation.mode,
      targets: remediation.targets,
      published: remediation.published,
      failed: remediation.failed,
      skipped: remediation.skipped,
      remediationLog,
    };
    certificationCoverage = evaluateSuiteCoverage({
      repoDir: absRepoDir,
      registry: options.registry,
      root: options.certificationRoot,
      now: options.now?.(),
      renewalWindowDays,
    });
  }

  const certificationCoverageBlocked = certificationCoverage?.status === 'bump-without-publish'
    || certificationCoverage?.status === 'identity-drift';
  const certificationStaleBlocked = certificationCoverage?.status === 'stale';
  const certificationEmptyBlocked = certificationCoverage?.status === 'empty-store'
    && certificationCoverage.nativeModelCount > 0;

  // Canary cohort evaluation and bounded remediation
  const canaryCohort = config?.nativeAgent?.certification?.canaryCohort;
  let canaryCohortHealth: CohortHealthSummary | undefined;
  let canaryCohortRemediation: MillConfigPreflightReport['canaryCohortRemediation'];

  if (canaryCohort && canaryCohort.identities.length > 0) {
    const cohortRegistry = options.registry ?? undefined;
    canaryCohortHealth = evaluateCohortHealth(canaryCohort, cohortRegistry ?? (await import('./model-registry.ts')).getEffectiveRegistry(absRepoDir), {
      root: options.certificationRoot,
      now: options.now?.(),
    });

    const cohortRefreshEnabled = canaryCohort.refreshEnabled !== false;
    if (
      canaryCohortHealth.belowMinimum
      && cohortRefreshEnabled
      && autoRemediationEnabled
    ) {
      const cohortLog: string[] = [];
      const cohortRemediation = await runCanaryCohortRemediation({
        registry: options.registry,
        repoDir: absRepoDir,
        cohort: canaryCohort,
        root: options.certificationRoot,
        env,
        now: options.now,
        log: (line) => cohortLog.push(line),
        attemptCachePath: options.attemptCachePath,
      });
      canaryCohortRemediation = {
        attempted: cohortRemediation.attempted,
        mode: cohortRemediation.mode,
        remediationLog: cohortLog,
      };
      canaryCohortHealth = cohortRemediation.cohortHealth;
    }
  }

  const canaryCohortBlocked = canaryCohortHealth?.belowMinimum === true;

  const report: MillConfigPreflightReport = {
    repoDir: absRepoDir,
    removedFields,
    validationError,
    migrationCommand: MILL_CONFIG_MIGRATION_COMMAND,
    ...(certificationCoverage ? { certificationCoverage } : {}),
    ...(certificationRemediation ? { certificationRemediation } : {}),
    ...(canaryCohortHealth ? { canaryCohortHealth } : {}),
    ...(canaryCohortRemediation ? { canaryCohortRemediation } : {}),
  };

  return {
    ok: removedFields.length === 0
      && validationError === null
      && !certificationCoverageBlocked
      && !certificationStaleBlocked
      && !certificationEmptyBlocked
      && !canaryCohortBlocked,
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
    const sample = coverage.ineligibleModels.slice(0, 6).map((m) => m.registryKey).join(', ');
    const more = coverage.ineligibleModels.length > 6
      ? ` (+${coverage.ineligibleModels.length - 6} more)`
      : '';
    lines.push(
      '',
      'Native certification identity drift:',
      `  ERROR: ${coverage.artifactCountForRequiredSuite} artifact(s) are present at suite '${coverage.requiredSuiteVersion}',`,
      `  but ${coverage.identityDriftCount} model(s) no longer match their certified subject and only`,
      `  ${coverage.eligibleModelCount} remain launchable. Store: ${coverage.root}`,
      `  Affected: ${sample}${more}`,
      "  This is what a change to shared/fixtures/model_30_launch_priority_models.v1.json does:",
      '  it moves catalogHash, which invalidates every stored artifact on this machine at once.',
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

  if (report.canaryCohortHealth?.belowMinimum) {
    const h = report.canaryCohortHealth;
    lines.push(
      '',
      'Native canary cohort readiness:',
      `  ERROR: Only ${h.codingReadyCount} of ${h.identities.length} cohort identities are coding-ready (minimum: ${h.minimumReady}).`,
    );
    for (const id of h.identities) {
      const status = id.codingReady ? 'ready' : `not-ready (${id.reason ?? 'unknown'})`;
      lines.push(`    ${id.provider}/${id.model}: ${status}`);
    }
    lines.push(
      '  Run: npx tsx tools/native-agent-certify.ts --refresh-cohort',
      '  Automatic refresh can be disabled by setting canaryCohort.refreshEnabled: false.',
    );
  }

  if (report.canaryCohortRemediation) {
    const r = report.canaryCohortRemediation;
    lines.push(
      '',
      'Canary cohort auto-remediation:',
      `  mode=${r.mode} attempted=${r.attempted ? 'yes' : 'no'}`,
    );
    for (const line of r.remediationLog) {
      lines.push(`  ${line}`);
    }
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

function normalizeRenewalWindowDays(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 7;
  }
  return Math.max(0, Math.min(30, Math.trunc(value)));
}
