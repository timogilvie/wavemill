import { readCertification } from './store.ts';
import { buildLegacyRepoCertificationPath } from './storage.ts';
export { buildLegacyRepoCertificationPath } from './storage.ts';
import {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  allScenariosPassed,
  artifactHasSubject,
  isCertificationFresh,
  phaseSatisfies,
  evaluateLiveCodingCanaryEligibility,
  type AnyNativeCertificationArtifact,
  type CertificationSubject,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';
import {
  isRollingProviderAlias,
  isValidCertificationPathSegment,
  subjectsEqual,
} from './identity.ts';
import {
  buildScopedCertificationPath,
  type CertificationStorageOptions,
  type CertificationStorageScope,
} from './storage.ts';

/**
 * Stable reason codes returned when a certification is ineligible.
 *
 * All ineligibility paths return a structured reason rather than throwing,
 * so callers can fail closed without try/catch.
 */
export type IneligibilityReason =
  | 'missing'
  | 'malformed'
  | 'identity-reidentified'
  | 'identity-invalidated'
  | 'wrong-version'
  | 'stale'
  | 'phase-insufficient'
  | 'scenario-failure';

export type CertificationEligibility =
  | { eligible: true; artifact: AnyNativeCertificationArtifact }
  | { eligible: false; reason: IneligibilityReason; artifact?: AnyNativeCertificationArtifact };

export const isValidPathSegment = isValidCertificationPathSegment;

/**
 * Build the legacy repo-scoped storage path for a certification artifact.
 *
 * Path contract: `<repoDir>/.wavemill/native-agent-certifications/<provider>/<model>/<suiteVersion>.json`
 *
 * @throws {Error} if any segment fails the safety check
 */

/**
 * @deprecated Use buildLegacyRepoCertificationPath for legacy repo-scoped artifacts,
 * or buildScopedCertificationPath/buildGlobalCertificationPath with an explicit scope.
 */
export function buildCertificationPath(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
): string {
  return buildLegacyRepoCertificationPath(repoDir, provider, model, suiteVersion);
}

/**
 * Build the storage path for a shared global certification artifact.
 *
 * This reads the caller's process-wide global store unless `root` is provided.
 * Prefer passing `root` when correctness depends on the selected store.
 *
 * Path contract: `<global-root>/<provider>/<model>/<suiteVersion>.json`
 *
 * @throws {Error} if any segment fails the safety check
 */
export function buildGlobalCertificationPath(
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): string {
  return buildScopedCertificationPath({ ...options, scope: 'global' }, provider, model, suiteVersion);
}

/**
 * Parse provider, model, and suite version from an artifact path.
 *
 * Returns undefined when the path does not match the expected layout.
 */
export function parseCertificationPath(
  path: string,
): { provider: string; model: string; suiteVersion: string } | undefined {
  // Normalize separators for cross-platform safety
  const normalized = path.replace(/\\/g, '/');
  const marker = `${CERTIFICATION_BASE_PATH}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return undefined;

  const relative = normalized.slice(idx + marker.length);
  const parts = relative.split('/');
  // Expect: <provider>/<model>/<suiteVersion>.json
  if (parts.length !== 3) return undefined;

  const [provider, model, filename] = parts;
  if (!filename.endsWith('.json')) return undefined;

  const suiteVersion = filename.slice(0, -'.json'.length);
  if (
    !isValidPathSegment(provider)
    || !isValidPathSegment(model)
    || !isValidPathSegment(suiteVersion)
  ) {
    return undefined;
  }

  return { provider, model, suiteVersion };
}

/**
 * Load and structurally validate a certification artifact from disk.
 *
 * Returns a structured ineligibility result for missing files, parse
 * failures, and schema mismatches. Never throws on expected error paths.
 */
export function loadCertification(repoDir: string, provider: string, model: string, suiteVersion: string) {
  try { return loadCertificationFromPath(buildLegacyRepoCertificationPath(repoDir, provider, model, suiteVersion)); }
  catch { return { ok: false as const, reason: 'malformed' as const }; }
}

/** All readers use the store's canonical JSON schema; no lossy private parser. */
export function loadCertificationFromPath(path: string): { ok: true; artifact: AnyNativeCertificationArtifact } | { ok: false; reason: 'missing' | 'malformed' } {
  const result = readCertification(path);
  return result.ok ? result : { ok: false, reason: result.error.code === 'not-found' ? 'missing' : 'malformed' };
}

export type ScopedLoadCertificationResult =
  | { ok: true; artifact: AnyNativeCertificationArtifact; path: string; scope: CertificationStorageScope }
  | { ok: false; reason: 'missing' | 'malformed'; path?: string; scope: CertificationStorageScope };

export function loadGlobalCertification(
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): ScopedLoadCertificationResult {
  let path: string;
  try {
    path = buildGlobalCertificationPath(provider, model, suiteVersion, options);
  } catch {
    return { ok: false, reason: 'malformed', scope: 'global' };
  }
  const loaded = loadCertificationFromPath(path);
  return loaded.ok
    ? { ...loaded, path, scope: 'global' }
    : { ...loaded, path, scope: 'global' };
}

export function loadSharedCertificationWithLegacyFallback(
  repoDir: string | undefined,
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): ScopedLoadCertificationResult {
  void repoDir;
  return loadGlobalCertification(provider, model, suiteVersion, options);
}

/**
 * Evaluate whether a loaded certification artifact grants eligibility for a phase.
 *
 * Checks are applied in order; the first failure short-circuits:
 * 1. Schema version mismatch → `wrong-version`
 * 2. Suite version mismatch → `wrong-version`
 * 3. Staleness (TTL or expiresAt) → `stale`
 * 4. Phase insufficient → `phase-insufficient`
 * 5. Any scenario failure → `scenario-failure`
 *
 * Pass `now` to make TTL evaluation deterministic in tests.
 */
export function evaluateEligibility(
  artifact: AnyNativeCertificationArtifact,
  requiredSuiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
  expectedSubject?: CertificationSubject,
): CertificationEligibility {
  if (expectedSubject) {
    if (!artifactHasSubject(artifact) || !subjectsEqual(artifact.subject, expectedSubject)) {
      return { eligible: false, reason: 'identity-reidentified', artifact };
    }
    if (artifact.provider !== expectedSubject.providerId || artifact.model !== expectedSubject.providerModelId) {
      return { eligible: false, reason: 'identity-reidentified', artifact };
    }
  }

  if (artifact.schemaVersion !== CERTIFICATION_SCHEMA_VERSION) {
    return { eligible: false, reason: 'wrong-version', artifact };
  }

  // HOK-3143: a durable identity-invalidation record fails the gate until a
  // fresh certification writes a new artifact. Also fail-closed on an alias
  // subject that has no pinned resolvedTarget (an unpinned alias is never
  // launchable).
  if (artifactHasSubject(artifact)) {
    if (artifact.identityInvalidation) {
      return { eligible: false, reason: 'identity-invalidated', artifact };
    }
    if (
      isRollingProviderAlias(artifact.subject.providerNativeId)
      && !artifact.resolvedTarget
    ) {
      return { eligible: false, reason: 'identity-invalidated', artifact };
    }
  }

  if (artifact.suiteVersion !== requiredSuiteVersion) {
    return { eligible: false, reason: 'wrong-version', artifact };
  }

  if (!isCertificationFresh(artifact, now)) {
    return { eligible: false, reason: 'stale', artifact };
  }

  if (!phaseSatisfies(artifact.phase, requiredPhase)) {
    return { eligible: false, reason: 'phase-insufficient', artifact };
  }

  if (!allScenariosPassed(artifact)) {
    return { eligible: false, reason: 'scenario-failure', artifact };
  }

  if (artifactHasSubject(artifact) && artifact.subject.endpoint) {
    const observed = evaluateLiveCodingCanaryEligibility(artifact, requiredSuiteVersion, now, expectedSubject);
    if (!observed.eligible) return { eligible: false, reason: observed.reason === 'identity-mismatch' ? 'identity-reidentified' : 'scenario-failure', artifact };
  }

  return { eligible: true, artifact };
}

/**
 * Combined load + evaluate helper.
 *
 * Loads the artifact from disk and evaluates eligibility in one call.
 * All failure paths return a structured ineligibility result.
 */
export function checkCertificationEligibility(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
  expectedSubject?: CertificationSubject,
): CertificationEligibility {
  const loaded = loadCertification(repoDir, provider, model, suiteVersion);
  if (!loaded.ok) {
    return { eligible: false, reason: loaded.reason };
  }
  return evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now, expectedSubject);
}

export type ScopedCertificationEligibility = CertificationEligibility & {
  artifactPath?: string;
  storageScope?: CertificationStorageScope;
};

export function checkSharedCertificationEligibility(
  repoDir: string | undefined,
  provider: string,
  model: string,
  suiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
  expectedSubject?: CertificationSubject,
): ScopedCertificationEligibility {
  const loaded = loadSharedCertificationWithLegacyFallback(repoDir, provider, model, suiteVersion, { ...options, endpoint: expectedSubject?.endpoint ?? options.endpoint });
  if (!loaded.ok) {
    return {
      eligible: false,
      reason: loaded.reason,
      ...(loaded.path ? { artifactPath: loaded.path } : {}),
      storageScope: loaded.scope,
    };
  }
  return {
    ...evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now, expectedSubject),
    artifactPath: loaded.path,
    storageScope: loaded.scope,
  };
}

export function checkGlobalCertificationEligibility(
  provider: string,
  model: string,
  suiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
  expectedSubject?: CertificationSubject,
): ScopedCertificationEligibility {
  const loaded = loadGlobalCertification(provider, model, suiteVersion, { ...options, endpoint: expectedSubject?.endpoint ?? options.endpoint });
  if (!loaded.ok) {
    return {
      eligible: false,
      reason: loaded.reason,
      ...(loaded.path ? { artifactPath: loaded.path } : {}),
      storageScope: 'global',
    };
  }
  return {
    ...evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now, expectedSubject),
    artifactPath: loaded.path,
    storageScope: 'global',
  };
}
