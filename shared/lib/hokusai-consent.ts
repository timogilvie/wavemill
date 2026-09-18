import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  getHokusaiContributionsConfig,
  getHokusaiSubmissionConfig,
  getHokusaiSubmissionEnableSources,
  type HokusaiSubmissionEnableSources,
} from './config.ts';
import { errorMessage } from './error-utils.ts';
import { isLegacyUnscopedContributionEndpoint } from './hokusai-local-config.ts';
import { hokusaiQueueStatus } from './hokusai-queue.ts';

// Consent version history:
// - 1.0: initial opt-in consent for anonymized workflow outcome submission.
// - 1.1 (HOK-2787): names the vendor-telemetry and reviewer-evidence
//   exclusions explicitly. Bumping this invalidates prior consent, so users
//   re-confirm under the expanded text before any further submission.
export const CURRENT_CONSENT_VERSION = '1.1';

export const CONSENT_TEXT = `Hokusai data submission is strictly opt-in.

If enabled, Wavemill may submit anonymized workflow outcome data to Hokusai, including:
- task descriptors such as issue type and complexity estimates
- model selections for planner, coder, and reviewer stages
- cost and timing metrics
- success outcomes such as pass/fail and intervention counts

Wavemill does NOT submit:
- source code, diffs, patches, or file contents
- raw repository names after redaction
- commit messages or PR descriptions
- API keys or other secrets
- prompts, task text, or provider request/response payloads
- vendor telemetry identity fields such as user email, organization id,
  account UUID, raw session/account identifiers, or transcript paths
- reviewer evidence: raw review prompts, structured findings, reproduction
  evidence, or remediation patches (only derived reviewer metrics and
  validity/provenance fields may leave this machine)

Only locally derived features and aggregates leave this machine, and every
outbound field must pass a default-deny allowlist: unlisted string fields are
stripped before anything is queued for upload.

Participating earns token rewards that offset Hokusai routing costs.

You can disable data submission at any time with:
  wavemill hokusai disable`;

export interface HokusaiUserConfig {
  hokusai?: {
    enabled?: boolean;
    consentedAt?: string | null;
    consentVersion?: string | null;
    apiKey?: string | null;
    redactionSalt?: string | null;
  };
  [key: string]: unknown;
}

export interface ConsentState {
  enabled: boolean;
  consentedAt: string | null;
  consentVersion: string | null;
}

export interface SubmissionStatus extends ConsentState {
  currentVersion: string;
  endpoint: string | null;
  consentValid: boolean;
  submissionAllowed: boolean;
  userConfigPath: string;
}

export interface ContributionConsentStatus {
  consentValid: boolean;
  contributionsEnabled: boolean;
  submissionAllowed: boolean;
  userStoreEnabled: boolean;
  userConfigPath: string;
}

export interface SubmissionSwitchReport {
  sources: HokusaiSubmissionEnableSources;
  userStoreEnabled: boolean;
  userConfigPath: string;
  consentValid: boolean;
  contributionsEnabled: boolean;
  submissionAllowed: boolean;
  mismatch: string | null;
}

export type ContributionMode = 'uploading' | 'export-only' | 'disabled';

export interface ContributionStatus {
  consent: 'enabled' | 'disabled';
  queue: 'enabled' | 'disabled';
  uploadEndpoint: 'configured' | 'missing';
  mode: ContributionMode;
  pendingCount: number;
  deadLetterCount: number;
  endpointLooksUnscoped: boolean;
  endpoint?: string;
  warning?: string;
}

export interface EnableSubmissionOptions {
  configDir?: string;
  repoDir?: string;
  skipPrompt?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

function resolveConfigDir(configDir?: string): string {
  return configDir ?? join(homedir(), '.wavemill');
}

function resolveUserConfigPath(configDir?: string): string {
  return join(resolveConfigDir(configDir), 'config.json');
}

function resolveCurrentConsentVersion(repoDir?: string): string {
  return getHokusaiSubmissionConfig(repoDir).consentVersion || CURRENT_CONSENT_VERSION;
}

function resolveEndpoint(repoDir?: string): string | null {
  return getHokusaiSubmissionConfig(repoDir).endpoint || null;
}

function updateUserConfig(
  mutator: (config: HokusaiUserConfig) => void,
  configDir?: string,
): HokusaiUserConfig {
  const config = loadUserConfig(configDir);
  mutator(config);
  saveUserConfig(config, configDir);
  return config;
}

export function loadUserConfig(configDir?: string): HokusaiUserConfig {
  const configPath = resolveUserConfigPath(configDir);
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as HokusaiUserConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn(
      `Failed to parse user config at ${configPath}; ignoring it: ${errorMessage(error)}`,
    );
    return {};
  }
}

export function saveUserConfig(config: HokusaiUserConfig, configDir?: string): void {
  const targetDir = resolveConfigDir(configDir);
  const configPath = resolveUserConfigPath(configDir);
  const tempPath = `${configPath}.tmp-${process.pid}`;

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, configPath);
}

export function getConsentState(configDir?: string): ConsentState {
  const hokusai = loadUserConfig(configDir).hokusai;
  return {
    enabled: hokusai?.enabled === true,
    consentedAt: hokusai?.consentedAt ?? null,
    consentVersion: hokusai?.consentVersion ?? null,
  };
}

export function isConsentValid(currentVersion: string, configDir?: string): boolean {
  const state = getConsentState(configDir);
  return Boolean(state.consentedAt && state.consentVersion === currentVersion);
}

export async function promptConsent(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  output.write(`${CONSENT_TEXT}\n\n`);
  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question('Enable Hokusai data submission? [y/N] ');
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export function recordConsent(version: string, configDir?: string): void {
  updateUserConfig((config) => {
    config.hokusai = {
      ...(config.hokusai || {}),
      consentedAt: new Date().toISOString(),
      consentVersion: version,
    };
  }, configDir);
}

export async function enableSubmission(options: EnableSubmissionOptions = {}): Promise<boolean> {
  const {
    configDir,
    repoDir,
    skipPrompt = false,
    input = process.stdin,
    output = process.stdout,
  } = options;

  const currentVersion = resolveCurrentConsentVersion(repoDir);
  const alreadyValid = isConsentValid(currentVersion, configDir);

  if (!alreadyValid && !skipPrompt) {
    const accepted = await promptConsent(input, output);
    if (!accepted) {
      updateUserConfig((config) => {
        config.hokusai = {
          ...(config.hokusai || {}),
          enabled: false,
        };
      }, configDir);
      return false;
    }
  }

  updateUserConfig((config) => {
    const hokusai = {
      ...(config.hokusai || {}),
      enabled: true,
    };

    if (!alreadyValid) {
      hokusai.consentedAt = new Date().toISOString();
      hokusai.consentVersion = currentVersion;
    }

    config.hokusai = hokusai;
  }, configDir);

  return true;
}

export function disableSubmission(configDir?: string): void {
  updateUserConfig((config) => {
    config.hokusai = {
      ...(config.hokusai || {}),
      enabled: false,
    };
  }, configDir);
}

export function getSubmissionStatus(options: { configDir?: string; repoDir?: string } = {}): SubmissionStatus {
  const state = getConsentState(options.configDir);
  const currentVersion = resolveCurrentConsentVersion(options.repoDir);
  const endpoint = resolveEndpoint(options.repoDir);
  const consentValid = isConsentValid(currentVersion, options.configDir);

  return {
    ...state,
    currentVersion,
    endpoint,
    consentValid,
    submissionAllowed: state.enabled && consentValid,
    userConfigPath: resolveUserConfigPath(options.configDir),
  };
}

export function getContributionConsentStatus(
  options: { configDir?: string; repoDir?: string } = {},
): ContributionConsentStatus {
  const status = getSubmissionStatus(options);
  const contributionsEnabled = getHokusaiContributionsConfig(options.repoDir).enabled === true;

  return {
    consentValid: status.consentValid,
    contributionsEnabled,
    submissionAllowed: status.submissionAllowed && contributionsEnabled,
    userStoreEnabled: status.enabled,
    userConfigPath: status.userConfigPath,
  };
}

function renderBool(value: boolean | undefined): string {
  return value === undefined ? 'unset' : String(value);
}

export function getSubmissionSwitchReport(
  options: { configDir?: string; repoDir?: string } = {},
): SubmissionSwitchReport {
  const sources = getHokusaiSubmissionEnableSources(options.repoDir);
  const consent = getContributionConsentStatus(options);
  let mismatch: string | null = null;

  if (sources.effectiveEnabled && !consent.submissionAllowed) {
    const blockers = contributionConsentBlockers(consent).join(', ');
    mismatch = `repo submission config is enabled but user-level contribution consent blocks submissions (${blockers || 'unknown blocker'}).`;
  } else if (!sources.effectiveEnabled && consent.submissionAllowed) {
    mismatch = 'user-level contribution consent allows submissions but repo submission config is disabled.';
  }

  return {
    sources,
    userStoreEnabled: consent.userStoreEnabled,
    userConfigPath: consent.userConfigPath,
    consentValid: consent.consentValid,
    contributionsEnabled: consent.contributionsEnabled,
    submissionAllowed: consent.submissionAllowed,
    mismatch,
  };
}

export function contributionConsentBlockers(status: ContributionConsentStatus): string[] {
  const blockers: string[] = [];
  if (!status.userStoreEnabled) {
    blockers.push('user_store_disabled');
  }
  if (!status.consentValid) {
    blockers.push('consent_invalid');
  }
  if (!status.contributionsEnabled) {
    blockers.push('contributions_config_disabled');
  }
  return blockers;
}

export function formatSubmissionSwitches(report: SubmissionSwitchReport): string {
  return `repo base=${renderBool(report.sources.baseEnabled)} local=${renderBool(report.sources.localEnabled)} effective=${report.sources.effectiveEnabled} | user store=${report.userStoreEnabled} consent=${report.consentValid ? 'valid' : 'invalid'} contributions=${report.contributionsEnabled}`;
}

export function isHokusaiContributionsEnabled(
  options: { configDir?: string; repoDir?: string } = {},
): boolean {
  return getContributionConsentStatus(options).submissionAllowed;
}

export function getContributionStatus(
  options: { configDir?: string; repoDir?: string } = {},
): ContributionStatus {
  const submissionStatus = getSubmissionStatus(options);
  const contributionsConfig = getHokusaiContributionsConfig(options.repoDir);
  const queueStatus = hokusaiQueueStatus(options);

  const consent: 'enabled' | 'disabled' = submissionStatus.enabled && submissionStatus.consentValid
    ? 'enabled'
    : 'disabled';
  const queue: 'enabled' | 'disabled' = contributionsConfig.enabled ? 'enabled' : 'disabled';
  const uploadEndpoint: 'configured' | 'missing' = contributionsConfig.endpoint
    ? 'configured'
    : 'missing';

  let mode: ContributionMode;
  if (!contributionsConfig.enabled || consent === 'disabled') {
    mode = 'disabled';
  } else if (contributionsConfig.endpoint) {
    mode = 'uploading';
  } else {
    mode = 'export-only';
  }

  const pendingCount = queueStatus.pendingCount;
  const deadLetterCount = queueStatus.deadLetterCount;
  const endpoint = contributionsConfig.endpoint ?? undefined;
  const endpointLooksUnscoped = endpoint !== undefined
    && isLegacyUnscopedContributionEndpoint(endpoint);
  const warnings: string[] = [];
  if (endpointLooksUnscoped) {
    warnings.push(
      `Contribution endpoint is the legacy unscoped path ${endpoint}.` +
      ` The Hokusai API is model-scoped at /api/v1/models/{model_id}/contributions;` +
      ` run \`wavemill hokusai migrate\` or \`wavemill hokusai configure\`.`,
    );
  }
  if (pendingCount > 0 && mode === 'export-only') {
    warnings.push(
      `${pendingCount} pending row${pendingCount === 1 ? '' : 's'} cannot upload because` +
      ` hokusai.contributions.endpoint is not configured.` +
      ` Add it to .wavemill-config.local.json or run \`wavemill hokusai configure\`.`,
    );
  } else if (pendingCount > 0 && mode === 'disabled') {
    warnings.push(`${pendingCount} pending row${pendingCount === 1 ? '' : 's'} are queued but contributions are disabled.`);
  }

  if (deadLetterCount > 0) {
    warnings.push(
      `${deadLetterCount} dead-lettered row${deadLetterCount === 1 ? '' : 's'} will not be retried.` +
      ` Inspect with \`hokusai-manage requeue --dead-letter --dry-run\` and requeue after fixing the cause.`,
    );
  }

  return {
    consent,
    queue,
    uploadEndpoint,
    mode,
    pendingCount,
    deadLetterCount,
    endpointLooksUnscoped,
    ...(endpoint ? { endpoint } : {}),
    warning: warnings.length > 0 ? warnings.join(' ') : undefined,
  };
}

export function getStatusDisplay(options: { configDir?: string; repoDir?: string } = {}): string {
  const status = getSubmissionStatus(options);
  const contrib = getContributionStatus(options);
  const switchReport = getSubmissionSwitchReport(options);
  const lines = [
    `Hokusai data submission: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Submission allowed: ${status.submissionAllowed ? 'yes' : 'no'}`,
    `Consent valid: ${status.consentValid ? 'yes' : 'no'}`,
    `Consent version: ${status.consentVersion ?? 'none'} (current: ${status.currentVersion})`,
    `Consented at: ${status.consentedAt ?? 'never'}`,
    `Endpoint: ${status.endpoint ?? 'not configured'}`,
    `Submission switches: ${formatSubmissionSwitches(switchReport)}`,
    '',
    `Consent: ${contrib.consent}`,
    `Contribution queue: ${contrib.queue}`,
    `Upload endpoint: ${contrib.uploadEndpoint}`,
    `Mode: ${contrib.mode}`,
  ];

  if (contrib.warning) {
    lines.unshift(`Warning: ${contrib.warning}`, '');
  }
  if (switchReport.mismatch) {
    lines.unshift(`Warning: ${switchReport.mismatch}`, '');
  }

  if (!status.submissionAllowed) {
    lines.push('Run `wavemill hokusai enable` to opt in, or `wavemill hokusai disable` to stay opted out.');
  }

  return lines.join('\n');
}
