/**
 * Native agent certification contract.
 *
 * Defines the shared schema, phase ordering, TTL policy, and eligibility
 * helpers for native provider/model phase certification artifacts.
 *
 * ## Storage path contract
 *
 * `.wavemill/native-agent-certifications/<provider>/<model>/<suite-version>.json`
 *
 * ## Phase ordering
 *
 * Phases are ordered: read-only < patch < workflow
 * A higher certification satisfies all lower required phases.
 *
 * ## TTL policy
 *
 * Default TTL is 60 days from `certifiedAt`. If `expiresAt` is present on
 * the artifact, it takes precedence over the derived TTL.
 *
 * @module native-agent/certification/schema
 */

import type { FailureClass } from './scenarios.ts';

export const CERTIFICATION_SCHEMA_VERSION = 3 as const;
export const HISTORICAL_CERTIFICATION_SCHEMA_VERSION = 2 as const;

/** Path prefix relative to repo root */
export const CERTIFICATION_BASE_PATH = '.wavemill/native-agent-certifications' as const;

/**
 * Default certification TTL in days.
 *
 * 60 days balances freshness against certification overhead. 30 days was
 * considered too frequent for low-churn providers; 90 days risks staleness
 * after provider API changes. See docs/native-certification-contract.md.
 */
export const CERTIFICATION_TTL_DAYS = 60 as const;

/** Ordered list of phases, from least to most permissive. */
export const PHASE_ORDER = ['read-only', 'patch', 'workflow'] as const;

export type CertificationPhase = (typeof PHASE_ORDER)[number];

/**
 * Freshness window for the live coding canary.
 *
 * Deliberately much shorter than {@link CERTIFICATION_TTL_DAYS}: the canary
 * proves live structured mutation-tool behavior against the current provider
 * deployment, which drifts faster than deterministic harness conformance.
 */
export const LIVE_CODING_CANARY_TTL_DAYS = 14 as const;

/** Canary scenario identifier persisted in artifacts. */
export const LIVE_CODING_CANARY_SCENARIO_ID = 'live.coding.mutation-canary.v1' as const;

export type LiveCodingCanaryStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped';

/**
 * Stable canary failure/inconclusive reasons.
 *
 * - `protocol_failure`            — zero structured mutation tool calls (e.g. textual
 *                                   `[apply_patch ...]` prose instead of a tool call)
 * - `missing_completion_artifact` — mutation happened but no valid `.coding-complete`
 * - `wrong_mutation`              — sentinel file does not contain the exact expected bytes
 * - `extra_repository_change`     — out-of-scope file created/modified in the canary repo
 * - `provider_transient_error`    — 429/5xx/timeout; inconclusive, safe to retry
 * - `provider_config_error`       — auth/model configuration problem; inconclusive
 * - `budget_exceeded`             — a wall-clock/turn/tool-call/token/cost limit fired
 * - `not_live`                    — result produced through a non-live path (dry-run/injection)
 * - `identity_mismatch`           — canary evidence does not match the certification subject
 * - `internal_error`              — canary harness itself failed; inconclusive
 */
export type LiveCodingCanaryFailureReason =
  | 'protocol_failure'
  | 'missing_completion_artifact'
  | 'wrong_mutation'
  | 'extra_repository_change'
  | 'provider_transient_error'
  | 'provider_config_error'
  | 'budget_exceeded'
  | 'not_live'
  | 'identity_mismatch'
  | 'internal_error';

export type LiveCodingCanaryLimitKind = 'wall_clock' | 'turns' | 'tool_calls' | 'tokens' | 'cost';

/** Hard budgets configured for the live canary run. */
export interface LiveCodingCanaryLimits {
  maxWallClockMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  /** Omitted when model pricing is unavailable (token/wall-clock bounds still apply). */
  maxCostUsd?: number;
}

/** Observed usage totals for the live canary run. */
export interface LiveCodingCanaryUsage {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
  /** Omitted when cost accounting was unavailable — never recorded as zero in that case. */
  costUsd?: number;
}

/**
 * Compact, content-minimized evidence for the canary verdict.
 *
 * Contains hashes, counts, and repo-relative paths only — never raw prompts,
 * transcripts, file contents, or provider credentials.
 */
export interface LiveCodingCanaryEvidence {
  /** Count of successful structured mutation tool invocations (tool events, not prose). */
  structuredMutationToolCalls: number;
  /** Distinct mutation tool names observed as structured tool events. */
  mutationToolNames: string[];
  /** SHA-256 of the exact expected sentinel content. */
  expectedSentinelHash: string;
  /** SHA-256 of the sentinel content found after the run, when readable. */
  actualSentinelHash?: string;
  /** Repo-relative paths changed in the canary repository. */
  changedPaths: string[];
  /** Whether a completion artifact was present and parsed by the completion normalizer. */
  completionArtifactPresent: boolean;
  /** SHA-256 of the canonical completion artifact content, when present. */
  completionArtifactHash?: string;
}

/** Non-authoritative record of a transient attempt that did not replace prior evidence. */
export interface LiveCodingCanaryAttemptNote {
  ranAt: string;
  status: Extract<LiveCodingCanaryStatus, 'inconclusive'>;
  reason: LiveCodingCanaryFailureReason;
  detail?: string;
}

/**
 * Result of one live coding canary evaluation for a provider/model/suite identity.
 *
 * Embedded in {@link NativeCertificationArtifact} as `liveCanary`. The coding
 * eligibility gate requires `status === 'pass'`, `isLive === true`, freshness,
 * and a full identity match — anything else fails closed.
 */
export interface LiveCodingCanaryResult {
  scenarioId: string;
  status: LiveCodingCanaryStatus;
  /**
   * True only when the canary invoked the real provider adapter over the
   * production tool path. Injected loop runners, scripted providers, and
   * dry-runs must record `false`; a non-live result can never grant coding
   * eligibility regardless of status.
   */
  isLive: boolean;
  /** The launch phase this canary certifies. Always 'coding' for this scenario. */
  phase: 'coding';
  /** Canonical storage provider segment (matches the owning artifact). */
  provider: string;
  /** Canonical storage model segment (matches the owning artifact). */
  model: string;
  /** Resolved provider-native wire model ID at canary time. */
  providerNativeId: string;
  /** Registry identity fingerprint at canary time. */
  identityFingerprint: string;
  /** Catalog hash corroborating the provider-native identity at canary time. */
  catalogHash: string;
  /** Certification suite version this canary belongs to. */
  suiteVersion: string;
  /** ISO 8601 datetime the canary run completed. */
  ranAt: string;
  /** Optional explicit expiry; takes precedence over the derived canary TTL. */
  expiresAt?: string;
  limits: LiveCodingCanaryLimits;
  usage?: LiveCodingCanaryUsage;
  /** Present for `fail`/`inconclusive`/`skipped` results. */
  reason?: LiveCodingCanaryFailureReason;
  /** Which budget fired, when `reason` is `budget_exceeded`. */
  limitExceeded?: LiveCodingCanaryLimitKind;
  /** Short redacted diagnostic. Never raw provider output or local absolute paths. */
  detail?: string;
  evidence?: LiveCodingCanaryEvidence;
  /** Total canary attempts made by the run that produced this result. */
  attempts?: number;
  /** Most recent transient attempt that was not allowed to overwrite this result. */
  lastInconclusiveAttempt?: LiveCodingCanaryAttemptNote;
}

/**
 * Result of a single scenario execution within a certification run.
 */
export interface ScenarioResult {
  /** Stable scenario identifier within the suite */
  scenarioId: string;
  /** Whether this scenario passed */
  passed: boolean;
  /** Optional human-readable failure message */
  failureMessage?: string;
  /** Number of attempts made before final result */
  retryCount?: number;
  /** Total attempts executed, including the initial attempt */
  attempts?: number;
  /** Final outcome kind from the last attempt */
  finalAttemptStatus?: 'pass' | 'fail' | 'unsupported' | 'provider-flake';
  /** Failure classification for non-passing scenarios */
  failureClass?: FailureClass;
}

export interface CertificationSubject {
  /** Stable registry key that owns this certification */
  registryKey: string;
  /** Native provider used by the Pi/native transport */
  nativeProvider: string;
  /** Provider namespace in the wire model ID, e.g. "qwen" for OpenRouter */
  providerId: string;
  /** Provider model segment in the wire model ID */
  providerModelId: string;
  /** Canonical provider-native wire model ID */
  providerNativeId: string;
  /** Immutable registry identity revision */
  identityRevision: number;
  /** Immutable registry identity fingerprint for this revision */
  identityFingerprint: string;
  /** Catalog hash that corroborated the provider-native identity */
  catalogHash: string;
}

export interface LiveSmokeEvidence {
  requestedWireId: string;
  providerReturnedModel?: string;
  catalogHash: string;
  succeededAt: string;
}

/**
 * Pinned alias target recorded by `wavemill native-agent certify` for a
 * rolling provider alias (e.g. OpenRouter `~google/gemini-pro-latest`). The
 * runtime verifies every assistant turn's `response.model` against
 * {@link resolvedTarget.model}; a different reported model invalidates the
 * certificate and blocks the launch. Required for alias subjects (the write
 * validator rejects an alias artifact without it); legacy non-alias
 * artifacts parse without it (HOK-3143).
 */
export interface ResolvedCertificationTarget {
  /** The wire id originally sent to the provider (e.g. `~google/gemini-pro-latest`). */
  requestedWireId: string;
  /** The concrete model id the provider pinned at certify time. */
  model: string;
  /** ISO 8601 timestamp when the resolution was observed. */
  observedAt: string;
  /** Source of this resolution — only `provider-response` is accepted today. */
  source: 'provider-response';
  /** Optional provider response id corroborating the resolution. */
  responseId?: string;
}

export type IdentityInvalidationSource = 'runtime' | 'certification';

/**
 * Durable identity-invalidation record on a certification artifact.
 *
 * Written when the runtime (or a certify-time live canary) observes a
 * provider-reported model that disagrees with the pinned identity. Fail-closed:
 * once present, {@link evaluateEligibility} returns `identity-invalidated` and
 * the launch gate refuses the certificate until re-certification writes a new
 * artifact.
 *
 * Idempotent: the first writer wins. A concurrent challenge arm observing
 * the same mismatch will leave the record untouched.
 */
export interface IdentityInvalidation {
  invalidatedAt: string;
  reason: 'identity_mismatch';
  expectedModel: string;
  /** The provider-reported model id when invalidation was recorded. */
  observedModel: string;
  requestedWireId: string;
  source: IdentityInvalidationSource;
  phase?: string;
  session?: string;
  issue?: string;
}

export interface HistoricalNativeCertificationArtifact {
  schemaVersion: typeof HISTORICAL_CERTIFICATION_SCHEMA_VERSION;
  provider: string;
  model: string;
  phase: CertificationPhase;
  suiteVersion: string;
  certifiedAt: string;
  expiresAt?: string;
  scenarios: ScenarioResult[];
  knownLimitations?: string[];
  totalRetryCount?: number;
}

/**
 * A native agent certification artifact.
 *
 * Stored at `.wavemill/native-agent-certifications/<provider>/<model>/<suite-version>.json`.
 * Written after a full certification run; evaluated by downstream consumers
 * before allowing native agent use in a phase.
 */
export interface NativeCertificationArtifact {
  /** Schema version for forward compatibility */
  schemaVersion: typeof CERTIFICATION_SCHEMA_VERSION;
  /** Revision-aware immutable certification subject */
  subject: CertificationSubject;
  /** Provider identifier (e.g. "anthropic", "openai", "openrouter") */
  provider: string;
  /** Model identifier (e.g. "claude-sonnet-4-6") */
  model: string;
  /** The certified phase level */
  phase: CertificationPhase;
  /** Suite version string that was run (matches the storage path segment) */
  suiteVersion: string;
  /** ISO 8601 datetime when certification was completed */
  certifiedAt: string;
  /**
   * Optional explicit expiry datetime (ISO 8601).
   * Takes precedence over the derived TTL from certifiedAt + CERTIFICATION_TTL_DAYS.
   */
  expiresAt?: string;
  /** Per-scenario results from the certification run */
  scenarios: ScenarioResult[];
  /** Optional known limitations or caveats for this certification */
  knownLimitations?: string[];
  /** Total retry count across all scenarios */
  totalRetryCount?: number;
  /** Live provider evidence required for provisional OpenRouter publication */
  liveSmokeEvidence?: LiveSmokeEvidence;
  /**
   * Live coding canary evidence. Optional for backward compatibility: older
   * artifacts parse without it, but coding eligibility fails closed until a
   * fresh, live, identity-matching pass is present.
   */
  liveCanary?: LiveCodingCanaryResult;
  /**
   * For rolling provider aliases (e.g. OpenRouter `~x/y`), the concrete
   * model id resolved at certify time. The runtime verifies each turn's
   * `response.model` against this and invalidates on drift (HOK-3143).
   * Required for alias subjects via `validateCertificationForWrite`; absent
   * for non-alias subjects.
   */
  resolvedTarget?: ResolvedCertificationTarget;
  /**
   * Durable identity-invalidation record. When present, the gate fails
   * closed with `identity-invalidated` until a fresh certification writes a
   * new artifact. Idempotent: first-writer-wins (HOK-3143).
   */
  identityInvalidation?: IdentityInvalidation;
}

export type AnyNativeCertificationArtifact =
  | HistoricalNativeCertificationArtifact
  | NativeCertificationArtifact;

export function isRevisionAwareArtifact(
  artifact: AnyNativeCertificationArtifact,
): artifact is NativeCertificationArtifact {
  return artifact.schemaVersion === CERTIFICATION_SCHEMA_VERSION && artifactHasSubject(artifact);
}

export function artifactHasSubject(
  artifact: AnyNativeCertificationArtifact,
): artifact is NativeCertificationArtifact {
  return 'subject' in artifact && typeof artifact.subject === 'object' && artifact.subject !== null;
}

/**
 * Return true if `actual` phase satisfies `required` phase.
 *
 * Phase ordering: read-only < patch < workflow.
 * A higher phase satisfies all lower required phases.
 */
export function phaseSatisfies(actual: CertificationPhase, required: CertificationPhase): boolean {
  return PHASE_ORDER.indexOf(actual) >= PHASE_ORDER.indexOf(required);
}

/**
 * Return true if the certification is fresh relative to `now`.
 *
 * If `expiresAt` is present, staleness is `now >= expiresAt`.
 * Otherwise staleness is derived from `certifiedAt + CERTIFICATION_TTL_DAYS`.
 */
export function isCertificationFresh(artifact: AnyNativeCertificationArtifact, now: Date): boolean {
  if (artifact.expiresAt) {
    return now < new Date(artifact.expiresAt);
  }
  const certifiedAt = new Date(artifact.certifiedAt);
  const expiryMs = certifiedAt.getTime() + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() < expiryMs;
}

/**
 * Return true if all required scenarios passed.
 *
 * A scenario is required when it exists in the results — any failed scenario
 * blocks eligibility. Suites with no scenarios are treated as not certified.
 */
export function allScenariosPassed(artifact: AnyNativeCertificationArtifact): boolean {
  if (artifact.scenarios.length === 0) {
    return false;
  }
  return artifact.scenarios.every(s => s.passed);
}

// ---------------------------------------------------------------------------
// Live coding canary eligibility helpers
// ---------------------------------------------------------------------------

/**
 * Return true while the canary is fresh relative to `now`.
 *
 * Boundary contract: valid strictly before expiry; invalid at or after expiry.
 * `expiresAt` takes precedence over the derived `ranAt + LIVE_CODING_CANARY_TTL_DAYS`.
 */
export function isLiveCodingCanaryFresh(canary: LiveCodingCanaryResult, now: Date): boolean {
  if (canary.expiresAt) {
    return now.getTime() < Date.parse(canary.expiresAt);
  }
  const ranAtMs = Date.parse(canary.ranAt);
  if (!Number.isFinite(ranAtMs)) {
    return false;
  }
  return now.getTime() < ranAtMs + LIVE_CODING_CANARY_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Return true when the canary's recorded identity matches the expected
 * certification subject, suite version, and the coding launch phase.
 *
 * A pass recorded for a different provider, canonical model, resolved
 * upstream model, identity fingerprint, catalog hash, suite version, or
 * phase never transfers.
 */
export function liveCodingCanaryMatchesSubject(
  canary: LiveCodingCanaryResult,
  expectedSubject: CertificationSubject,
  suiteVersion: string,
): boolean {
  return canary.phase === 'coding'
    && canary.suiteVersion === suiteVersion
    && canary.provider === expectedSubject.providerId
    && canary.model === expectedSubject.providerModelId
    && canary.providerNativeId === expectedSubject.providerNativeId
    && canary.identityFingerprint === expectedSubject.identityFingerprint
    && canary.catalogHash === expectedSubject.catalogHash;
}

export type LiveCodingCanaryIneligibilityReason =
  | 'missing'
  | 'failed'
  | 'inconclusive'
  | 'not-live'
  | 'stale'
  | 'identity-mismatch';

export type LiveCodingCanaryEligibility =
  | { eligible: true; canary: LiveCodingCanaryResult }
  | { eligible: false; reason: LiveCodingCanaryIneligibilityReason; canary?: LiveCodingCanaryResult };

/**
 * Evaluate whether an artifact's live canary evidence grants coding eligibility.
 *
 * Fail-closed ordering (first failure wins):
 * 1. Missing/legacy artifact or absent/skipped canary → `missing`
 * 2. Identity/suite/phase mismatch → `identity-mismatch`
 * 3. Non-live evidence → `not-live`
 * 4. Definitive failure → `failed`; transient → `inconclusive`
 * 5. Expired at or after the freshness boundary → `stale`
 *
 * When `expectedSubject` is omitted (legacy callers), the canary must still
 * match the owning artifact's storage identity and suite version.
 */
export function evaluateLiveCodingCanaryEligibility(
  artifact: AnyNativeCertificationArtifact,
  suiteVersion: string,
  now: Date,
  expectedSubject?: CertificationSubject,
): LiveCodingCanaryEligibility {
  if (!isRevisionAwareArtifact(artifact)) {
    return { eligible: false, reason: 'missing' };
  }
  const canary = artifact.liveCanary;
  if (!canary || canary.status === 'skipped') {
    return { eligible: false, reason: 'missing', ...(canary ? { canary } : {}) };
  }

  const subject = expectedSubject ?? artifact.subject;
  if (
    !liveCodingCanaryMatchesSubject(canary, subject, suiteVersion)
    || canary.provider !== artifact.provider
    || canary.model !== artifact.model
  ) {
    return { eligible: false, reason: 'identity-mismatch', canary };
  }

  if (canary.isLive !== true) {
    return { eligible: false, reason: 'not-live', canary };
  }

  if (canary.status === 'fail') {
    return { eligible: false, reason: 'failed', canary };
  }
  if (canary.status === 'inconclusive') {
    return { eligible: false, reason: 'inconclusive', canary };
  }

  if (!isLiveCodingCanaryFresh(canary, now)) {
    return { eligible: false, reason: 'stale', canary };
  }

  return { eligible: true, canary };
}
