/**
 * Bounded live-coding-canary cohort (HOK-3062).
 *
 * Turns the live coding canary gate (HOK-2943) into an operational source of
 * coding-ready native models: a small, reviewed set of configured identities
 * whose live mutation canaries are kept fresh on the machine/store the mill
 * actually uses.
 *
 * ## Contracts
 *
 * - Only configured cohort members are ever auto-refreshed — never the whole
 *   registry. Validation is fail-closed: unknown, disabled, provisional,
 *   provider-mismatched, or coding-excluded entries are reported and skipped.
 * - Refresh targets are members whose canary is missing, stale, inside the
 *   renewal window, identity-invalidated, or transiently inconclusive.
 *   A definitive `fail` or `not-live` verdict is never auto-retried; it
 *   requires operator review.
 * - One bounded refresh attempt per (identity fingerprint, catalog hash,
 *   suite version, expiry episode). A second automatic pass in the same
 *   episode reports the manual remediation command instead of spending a
 *   provider call. The manual CLI path bypasses the guard.
 * - Attempt records persist only redacted, bounded metadata — no credentials,
 *   raw transcripts, or unbounded tool results.
 * - Eligibility semantics are unchanged: refresh goes through the existing
 *   certify pipeline, which preserves a previous unexpired identity-matching
 *   pass when a refresh is transiently inconclusive or skipped.
 *
 * @module native-agent/certification/canary-cohort
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mutateJsonState } from '../../state-mutex.ts';
import {
  getNativeAgentConfig,
  type CanaryCohortMemberConfig,
  type NativeCertificationConfig,
} from '../../config.ts';
import { resolveEnvValue } from '../../env-file.ts';
import { findModelExclusion } from '../../model-exclusions.ts';
import {
  getEffectiveRegistry,
  resolveModelIdentity,
  type ModelRegistry,
  type NativeProviderName,
} from '../../model-registry.ts';
import {
  OPENAI_DEFAULT_API_KEY_ENV,
  OPENROUTER_DEFAULT_API_KEY_ENV,
} from '../providers.ts';
import { resolveCertificationSubject } from './identity.ts';
import { loadGlobalCertification } from './loader.ts';
import { resolveCertificationStorage } from './storage.ts';
import { writeGlobalCertification } from './store.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './scenarios.ts';
import {
  evaluateLiveCodingCanaryEligibility,
  isRevisionAwareArtifact,
  LIVE_CODING_CANARY_TTL_DAYS,
  type LiveCodingCanaryLimits,
  type LiveCodingCanaryStatus,
  type NativeCertificationArtifact,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CANARY_COHORT_REFRESH_COMMAND =
  'npx tsx tools/native-agent-certify.ts --refresh-canary-cohort';

export const DEFAULT_MIN_CODING_READY = 2;
export const DEFAULT_CANARY_RENEWAL_WINDOW_DAYS = 3;
const ATTEMPT_CACHE_FILENAME = '.canary-refresh-attempts.json';
const MAX_ATTEMPT_REASON_LENGTH = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cohort resolution
// ---------------------------------------------------------------------------

export interface CanaryCohortMember {
  provider: NativeProviderName;
  model: string;
}

export interface InvalidCohortEntry {
  provider: string;
  model: string;
  reason: string;
}

export interface ResolvedCanaryCohort {
  members: CanaryCohortMember[];
  invalid: InvalidCohortEntry[];
  minCodingReady: number;
  renewalWindowDays: number;
  autoRefreshEnabled: boolean;
}

export interface ResolveCanaryCohortOptions {
  repoDir: string;
  registry?: ModelRegistry;
  /** Test seam: overrides the certification config loaded from repoDir. */
  config?: NativeCertificationConfig;
}

/**
 * Resolve and validate the configured canary cohort against the effective
 * registry. Only verified, native-capable, non-disabled, non-excluded
 * canonical identities qualify; everything else lands in `invalid` with a
 * concrete reason. Entries are deduplicated by provider/model.
 */
export function resolveCanaryCohort(options: ResolveCanaryCohortOptions): ResolvedCanaryCohort {
  const config = options.config ?? getNativeAgentConfig(options.repoDir).certification ?? {};
  const registry = options.registry ?? getEffectiveRegistry(options.repoDir);
  const configured: CanaryCohortMemberConfig[] = config.canaryCohort ?? [];

  const members: CanaryCohortMember[] = [];
  const invalid: InvalidCohortEntry[] = [];
  const seen = new Set<string>();

  for (const entry of configured) {
    const key = `${entry.provider}/${entry.model}`;
    if (seen.has(key)) {
      invalid.push({ ...entry, reason: 'duplicate cohort entry' });
      continue;
    }
    seen.add(key);

    const reason = validateCohortEntry(entry, registry, options.repoDir);
    if (reason) {
      invalid.push({ ...entry, reason });
      continue;
    }
    members.push({ provider: entry.provider, model: entry.model });
  }

  return {
    members,
    invalid,
    minCodingReady: normalizeCount(config.minCodingReady, DEFAULT_MIN_CODING_READY),
    renewalWindowDays: normalizeRenewalWindow(config.canaryRenewalWindowDays),
    autoRefreshEnabled: config.canaryAutoRefresh !== false,
  };
}

function validateCohortEntry(
  entry: CanaryCohortMemberConfig,
  registry: ModelRegistry,
  repoDir: string,
): string | undefined {
  const model = registry.models[entry.model];
  const capability = model?.nativeCapability;
  if (!model || !capability) {
    return 'not a registered native-capable model';
  }
  if (capability.readOnlyNative === 'unsupported') {
    return 'registry marks model unsupported for native execution';
  }
  if (capability.nativeProvider !== entry.provider) {
    return `registered with provider "${capability.nativeProvider}", not "${entry.provider}"`;
  }
  if (model.disabled === true) {
    return 'model is disabled in the registry';
  }
  if (resolveModelIdentity(registry, entry.model).status !== 'verified') {
    return 'model identity is not verified';
  }
  const exclusion = findModelExclusion(entry.model, 'coding', repoDir);
  if (exclusion) {
    return `model is excluded from coding (${exclusion.source ?? 'exclusion list'})`;
  }
  return undefined;
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function normalizeRenewalWindow(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CANARY_RENEWAL_WINDOW_DAYS;
  }
  return Math.max(0, Math.min(LIVE_CODING_CANARY_TTL_DAYS - 1, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// Cohort health
// ---------------------------------------------------------------------------

/** Canary lifecycle state of one cohort member, from stored evidence only. */
export type CohortMemberCanaryState =
  | 'ready'
  | 'renewal-due'
  | 'missing'
  | 'stale'
  | 'identity-invalidated'
  | 'inconclusive'
  | 'failed'
  | 'not-live';

/** States the automatic refresh path is allowed to act on. */
const REFRESH_TARGET_STATES: ReadonlySet<CohortMemberCanaryState> = new Set([
  'missing',
  'stale',
  'renewal-due',
  'identity-invalidated',
  'inconclusive',
]);

export interface CohortMemberStatus {
  provider: NativeProviderName;
  model: string;
  state: CohortMemberCanaryState;
  /** True when the member currently grants coding eligibility. */
  codingEligible: boolean;
  canaryStatus?: LiveCodingCanaryStatus;
  canaryRanAt?: string;
  /** ISO expiry of the current canary pass, when one exists. */
  canaryExpiresAt?: string;
  failureReason?: string;
  lastAttempt?: CanaryAttemptRecord;
}

export interface CanaryCohortHealth {
  configuredCount: number;
  invalidCount: number;
  codingReadyCount: number;
  minCodingReady: number;
  belowMinimum: boolean;
  /** Earliest canary expiry among currently eligible members. */
  nearestExpiryAt?: string;
  members: CohortMemberStatus[];
  invalid: InvalidCohortEntry[];
  remediationCommand: string;
}

export interface EvaluateCohortHealthOptions {
  repoDir: string;
  cohort: ResolvedCanaryCohort;
  registry?: ModelRegistry;
  certificationRoot?: string;
  now?: Date;
  suiteVersion?: string;
  attemptCachePath?: string;
}

/**
 * Evaluate stored canary evidence for every cohort member. Read-only: never
 * triggers a provider call.
 */
export async function evaluateCanaryCohortHealth(
  options: EvaluateCohortHealthOptions,
): Promise<CanaryCohortHealth> {
  const registry = options.registry ?? getEffectiveRegistry(options.repoDir);
  const now = options.now ?? new Date();
  const suiteVersion = options.suiteVersion ?? DEFAULT_CERTIFICATION_SUITE_VERSION;
  const attempts = await readAttemptCache(resolveAttemptCachePath(options));

  const members: CohortMemberStatus[] = [];
  for (const member of options.cohort.members) {
    const status = evaluateMemberStatus({
      member,
      registry,
      suiteVersion,
      now,
      renewalWindowDays: options.cohort.renewalWindowDays,
      certificationRoot: options.certificationRoot,
    });
    const lastAttempt = attempts[memberKey(member)];
    members.push(lastAttempt ? { ...status, lastAttempt } : status);
  }

  const eligible = members.filter((member) => member.codingEligible);
  const nearestExpiryAt = eligible
    .map((member) => member.canaryExpiresAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];

  return {
    configuredCount: options.cohort.members.length + options.cohort.invalid.length,
    invalidCount: options.cohort.invalid.length,
    codingReadyCount: eligible.length,
    minCodingReady: options.cohort.minCodingReady,
    belowMinimum: options.cohort.members.length + options.cohort.invalid.length > 0
      && eligible.length < options.cohort.minCodingReady,
    ...(nearestExpiryAt ? { nearestExpiryAt } : {}),
    members,
    invalid: options.cohort.invalid,
    remediationCommand: CANARY_COHORT_REFRESH_COMMAND,
  };
}

function evaluateMemberStatus(input: {
  member: CanaryCohortMember;
  registry: ModelRegistry;
  suiteVersion: string;
  now: Date;
  renewalWindowDays: number;
  certificationRoot?: string;
}): CohortMemberStatus {
  const { member, registry, suiteVersion, now } = input;
  const base = { provider: member.provider, model: member.model };

  let subject: ReturnType<typeof resolveCertificationSubject>;
  try {
    subject = resolveCertificationSubject({
      provider: member.provider,
      model: member.model,
      registry,
    });
  } catch (error) {
    return {
      ...base,
      state: 'missing',
      codingEligible: false,
      failureReason: truncate(`subject resolution failed: ${(error as Error).message}`),
    };
  }

  const loaded = loadGlobalCertification(
    subject.storageIdentity.provider,
    subject.storageIdentity.model,
    suiteVersion,
    input.certificationRoot ? { root: input.certificationRoot } : {},
  );
  if (!loaded.ok || !isRevisionAwareArtifact(loaded.artifact)) {
    return { ...base, state: 'missing', codingEligible: false };
  }

  const eligibility = evaluateLiveCodingCanaryEligibility(
    loaded.artifact,
    suiteVersion,
    now,
    subject.subject,
  );
  const canary = eligibility.canary;
  const canaryFields = canary
    ? {
      canaryStatus: canary.status,
      canaryRanAt: canary.ranAt,
      ...(canary.reason ? { failureReason: canary.reason } : {}),
    }
    : {};

  if (!eligibility.eligible) {
    const state: CohortMemberCanaryState = eligibility.reason === 'identity-mismatch'
      ? 'identity-invalidated'
      : eligibility.reason === 'stale'
        ? 'stale'
        : eligibility.reason === 'failed'
          ? 'failed'
          : eligibility.reason === 'inconclusive'
            ? 'inconclusive'
            : eligibility.reason === 'not-live'
              ? 'not-live'
              : 'missing';
    return { ...base, state, codingEligible: false, ...canaryFields };
  }

  const expiresAtMs = canary!.expiresAt
    ? Date.parse(canary!.expiresAt)
    : Date.parse(canary!.ranAt) + LIVE_CODING_CANARY_TTL_DAYS * DAY_MS;
  const canaryExpiresAt = new Date(expiresAtMs).toISOString();
  const renewalDue = expiresAtMs - now.getTime() <= input.renewalWindowDays * DAY_MS;

  return {
    ...base,
    state: renewalDue ? 'renewal-due' : 'ready',
    codingEligible: true,
    ...canaryFields,
    canaryExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Attempt guard (one bounded attempt per remediation episode)
// ---------------------------------------------------------------------------

export interface CanaryAttemptRecord {
  at: string;
  /** Hash binding the attempt to identity, suite, catalog, and expiry episode. */
  episodeKey: string;
  outcome: 'pass' | 'fail' | 'inconclusive' | 'skipped' | 'error';
  reason?: string;
}

interface AttemptCache {
  attempts: Record<string, CanaryAttemptRecord>;
}

const EMPTY_ATTEMPT_CACHE: AttemptCache = { attempts: {} };

function resolveAttemptCachePath(options: {
  attemptCachePath?: string;
  certificationRoot?: string;
}): string {
  return options.attemptCachePath
    ?? join(
      resolveCertificationStorage({ scope: 'global', root: options.certificationRoot }).root,
      ATTEMPT_CACHE_FILENAME,
    );
}

function memberKey(member: CanaryCohortMember): string {
  return `${member.provider}/${member.model}`;
}

/**
 * Episode key: a refresh episode ends when the identity, catalog, suite, or
 * the pass expiry that triggered remediation changes. A failed automatic
 * attempt therefore stays terminal for its episode instead of re-spending a
 * provider call every preflight.
 */
function buildEpisodeKey(input: {
  member: CanaryCohortMember;
  identityFingerprint: string;
  catalogHash: string;
  suiteVersion: string;
  status: CohortMemberStatus;
}): string {
  const episode = input.status.state === 'renewal-due'
    ? `renewal:${input.status.canaryExpiresAt ?? input.status.canaryRanAt ?? 'unknown'}`
    : input.status.state;
  return createHash('sha256')
    .update(
      [
        input.member.provider,
        input.member.model,
        input.identityFingerprint,
        input.catalogHash,
        input.suiteVersion,
        episode,
      ].join('\n'),
      'utf-8',
    )
    .digest('hex');
}

async function readAttemptCache(cachePath: string): Promise<Record<string, CanaryAttemptRecord>> {
  try {
    let attempts: Record<string, CanaryAttemptRecord> = {};
    await mutateJsonState<AttemptCache>(
      cachePath,
      (cache) => {
        attempts = cache.attempts ?? {};
        return cache;
      },
      { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
    );
    return attempts;
  } catch {
    return {};
  }
}

async function recordAttempt(
  cachePath: string,
  member: CanaryCohortMember,
  record: CanaryAttemptRecord,
): Promise<void> {
  try {
    await mutateJsonState<AttemptCache>(
      cachePath,
      (cache) => ({
        attempts: {
          ...(cache.attempts ?? {}),
          [memberKey(member)]: record,
        },
      }),
      { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
    );
  } catch {
    // Best-effort observability; a cache failure never blocks the refresh.
  }
}

async function clearAttempt(cachePath: string, member: CanaryCohortMember): Promise<void> {
  try {
    await mutateJsonState<AttemptCache>(
      cachePath,
      (cache) => {
        const attempts = { ...(cache.attempts ?? {}) };
        delete attempts[memberKey(member)];
        return { attempts };
      },
      { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
    );
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Cohort refresh
// ---------------------------------------------------------------------------

/**
 * Structural slice of `certifyNativeAgent` from tools/native-agent-certify.ts,
 * injected by callers to avoid a module cycle with the CLI entrypoint.
 */
export type CohortCertifyFn = (opts: {
  provider: NativeProviderName;
  model: string;
  phase: 'workflow';
  repoDir: string;
  liveCodingCanary: true;
  registry?: ModelRegistry;
  canaryLimits?: Partial<LiveCodingCanaryLimits>;
  loadPreviousArtifactFn?: (provider: string, model: string, suiteVersion: string) => NativeCertificationArtifact | undefined;
  writeCertificationFn?: (record: NativeCertificationArtifact) => string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}) => Promise<{
  harnessPassed: boolean;
  codingEligible: boolean;
  liveCanary?: {
    status: LiveCodingCanaryStatus;
    reason?: string;
    detail?: string;
    carriedForward?: boolean;
  };
}>;

export interface RefreshCanaryCohortOptions {
  repoDir: string;
  /** Runs the certify pipeline for one member (inject `certifyNativeAgent`). */
  certifyFn: CohortCertifyFn;
  registry?: ModelRegistry;
  certificationRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * When true (automatic/preflight path) each remediation episode gets at
   * most one attempt. The manual CLI path passes false.
   */
  respectAttemptGuard?: boolean;
  canaryLimits?: Partial<LiveCodingCanaryLimits>;
  attemptCachePath?: string;
  log?: (line: string) => void;
  /** Test seam: overrides the certification config loaded from repoDir. */
  config?: NativeCertificationConfig;
}

export interface CohortRefreshMemberOutcome {
  provider: NativeProviderName;
  model: string;
  /** Member state before the refresh decision. */
  state: CohortMemberCanaryState;
  action: 'refreshed' | 'skipped' | 'not-due';
  /** Canary outcome of a refreshed member. */
  result?: LiveCodingCanaryStatus | 'error';
  codingEligible: boolean;
  reason?: string;
}

export interface CohortRefreshResult {
  attempted: number;
  outcomes: CohortRefreshMemberOutcome[];
  /** Post-refresh cohort health. */
  health: CanaryCohortHealth;
}

/**
 * Idempotently refresh the bounded canary cohort against the production
 * certification store. Selects only members whose canary needs attention,
 * honors the per-episode attempt guard on the automatic path, and never
 * expands beyond the configured cohort.
 */
export async function refreshCanaryCohort(
  options: RefreshCanaryCohortOptions,
): Promise<CohortRefreshResult> {
  const registry = options.registry ?? getEffectiveRegistry(options.repoDir);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const respectGuard = options.respectAttemptGuard !== false;
  const suiteVersion = DEFAULT_CERTIFICATION_SUITE_VERSION;
  const cachePath = resolveAttemptCachePath(options);

  const cohort = resolveCanaryCohort({
    repoDir: options.repoDir,
    registry,
    ...(options.config ? { config: options.config } : {}),
  });
  for (const entry of cohort.invalid) {
    options.log?.(`[canary-cohort] invalid ${entry.provider}/${entry.model}: ${entry.reason}`);
  }

  const healthBefore = await evaluateCanaryCohortHealth({
    repoDir: options.repoDir,
    cohort,
    registry,
    certificationRoot: options.certificationRoot,
    now: now(),
    suiteVersion,
    attemptCachePath: cachePath,
  });

  const outcomes: CohortRefreshMemberOutcome[] = [];
  let attempted = 0;

  for (const status of healthBefore.members) {
    const member: CanaryCohortMember = { provider: status.provider, model: status.model };
    const base = {
      provider: member.provider,
      model: member.model,
      state: status.state,
      codingEligible: status.codingEligible,
    };

    if (!REFRESH_TARGET_STATES.has(status.state)) {
      const reason = status.state === 'ready'
        ? undefined
        : `state "${status.state}" requires operator review; not auto-retried`;
      outcomes.push({ ...base, action: 'not-due', ...(reason ? { reason } : {}) });
      continue;
    }

    const apiKeyEnv = resolveApiKeyEnv(member.provider, options.repoDir);
    if (!resolveEnvValue([apiKeyEnv], options.repoDir) && !env[apiKeyEnv]?.trim()) {
      outcomes.push({
        ...base,
        action: 'skipped',
        reason: `credentials unavailable (${apiKeyEnv} is not set)`,
      });
      continue;
    }

    const subject = resolveCertificationSubject({
      provider: member.provider,
      model: member.model,
      registry,
    });
    const episodeKey = buildEpisodeKey({
      member,
      identityFingerprint: subject.subject.identityFingerprint,
      catalogHash: subject.subject.catalogHash,
      suiteVersion,
      status,
    });

    if (respectGuard && status.lastAttempt?.episodeKey === episodeKey) {
      outcomes.push({
        ...base,
        action: 'skipped',
        reason: `already attempted this episode (${status.lastAttempt.outcome} at ${status.lastAttempt.at}); run: ${CANARY_COHORT_REFRESH_COMMAND}`,
      });
      continue;
    }

    attempted += 1;
    options.log?.(`[canary-cohort] refreshing ${memberKey(member)} (state=${status.state})`);
    try {
      const result = await options.certifyFn({
        provider: member.provider,
        model: member.model,
        phase: 'workflow',
        repoDir: options.repoDir,
        liveCodingCanary: true,
        registry,
        ...(options.canaryLimits ? { canaryLimits: options.canaryLimits } : {}),
        ...(options.certificationRoot ? storeOverrides(options.certificationRoot) : {}),
        env,
        now,
      });
      const canaryStatus = result.liveCanary?.status ?? 'skipped';
      if (result.codingEligible) {
        await clearAttempt(cachePath, member);
      } else {
        await recordAttempt(cachePath, member, {
          at: now().toISOString(),
          episodeKey,
          outcome: canaryStatus === 'pass' ? 'pass' : canaryStatus,
          ...(result.liveCanary?.reason ? { reason: truncate(result.liveCanary.reason) } : {}),
        });
      }
      outcomes.push({
        ...base,
        action: 'refreshed',
        result: canaryStatus,
        codingEligible: result.codingEligible,
        ...(result.liveCanary?.reason ? { reason: result.liveCanary.reason } : {}),
      });
    } catch (error) {
      const message = truncate((error as Error).message ?? String(error));
      await recordAttempt(cachePath, member, {
        at: now().toISOString(),
        episodeKey,
        outcome: 'error',
        reason: message,
      });
      outcomes.push({
        ...base,
        action: 'refreshed',
        result: 'error',
        codingEligible: false,
        reason: message,
      });
    }
  }

  const health = await evaluateCanaryCohortHealth({
    repoDir: options.repoDir,
    cohort,
    registry,
    certificationRoot: options.certificationRoot,
    now: now(),
    suiteVersion,
    attemptCachePath: cachePath,
  });

  return { attempted, outcomes, health };
}

function resolveApiKeyEnv(provider: NativeProviderName, repoDir: string): string {
  const providerConfig = getNativeAgentConfig(repoDir).providers?.[provider];
  return providerConfig?.apiKeyEnv?.trim()
    || (provider === 'openai' ? OPENAI_DEFAULT_API_KEY_ENV : OPENROUTER_DEFAULT_API_KEY_ENV);
}

/**
 * Route certify-pipeline reads and writes at an explicit store root, so a
 * refresh against a non-default root never splits evidence across stores.
 */
function storeOverrides(root: string): {
  loadPreviousArtifactFn: (provider: string, model: string, suiteVersion: string) => NativeCertificationArtifact | undefined;
  writeCertificationFn: (record: NativeCertificationArtifact) => string;
} {
  return {
    loadPreviousArtifactFn: (provider, model, suiteVersion) => {
      const loaded = loadGlobalCertification(provider, model, suiteVersion, { root });
      return loaded.ok && isRevisionAwareArtifact(loaded.artifact) ? loaded.artifact : undefined;
    },
    writeCertificationFn: (record) => writeGlobalCertification(record, { root }),
  };
}

function truncate(text: string): string {
  return text.length > MAX_ATTEMPT_REASON_LENGTH
    ? `${text.slice(0, MAX_ATTEMPT_REASON_LENGTH - 1)}…`
    : text;
}

// ---------------------------------------------------------------------------
// Operator rendering
// ---------------------------------------------------------------------------

/** Render the cohort health block for operator-facing output. */
export function renderCanaryCohortHealth(health: CanaryCohortHealth): string {
  const lines = [
    'Live coding canary cohort:',
    `  configured=${health.configuredCount} coding-ready=${health.codingReadyCount} minimum=${health.minCodingReady}`
    + (health.nearestExpiryAt ? ` nearest-expiry=${health.nearestExpiryAt}` : ''),
  ];
  for (const member of health.members) {
    const attempt = member.lastAttempt
      ? ` last-attempt=${member.lastAttempt.outcome}@${member.lastAttempt.at}`
      : '';
    const failure = member.failureReason ? ` reason=${member.failureReason}` : '';
    lines.push(
      `  ${member.provider}/${member.model}: ${member.state}`
      + ` eligible=${member.codingEligible ? 'yes' : 'no'}`
      + (member.canaryExpiresAt ? ` expires=${member.canaryExpiresAt}` : '')
      + failure + attempt,
    );
  }
  for (const entry of health.invalid) {
    lines.push(`  ${entry.provider}/${entry.model}: INVALID (${entry.reason})`);
  }
  if (health.belowMinimum) {
    lines.push(
      `  ALERT: coding-ready cohort (${health.codingReadyCount}) is below the configured minimum (${health.minCodingReady}).`,
      `  Run on the credentialed mill host: ${health.remediationCommand}`,
    );
  }
  return lines.join('\n');
}
