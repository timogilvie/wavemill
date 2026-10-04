/**
 * Catalog-hash scheme migration and re-identification causes (HOK-3159).
 *
 * OpenRouter certification subjects used to carry the SHA-256 of the whole
 * launch-priority fixture as `catalogHash`, so any edit to any row
 * re-identified every OpenRouter model and stripped its live coding canary.
 * Subjects now carry a per-model row hash (`hashLaunchPriorityModelRow`).
 *
 * This module holds the two pieces that make the switch survivable:
 *
 * - {@link carryForwardLegacyCatalogHashCanary} keeps a stored live canary
 *   across the scheme change when nothing but the hash scheme moved.
 * - {@link classifyReidentificationCause} names *why* a stored subject no
 *   longer matches, so preflight reports one cause instead of N separate
 *   re-certifications.
 */

import { hashLaunchPriorityFixture } from '../../openrouter-catalog.ts';
import { subjectsEqual } from './identity.ts';
import {
  evaluateLiveCodingCanaryEligibility,
  isRevisionAwareArtifact,
  type AnyNativeCertificationArtifact,
  type CertificationSubject,
  type LiveCodingCanaryResult,
} from './schema.ts';

/**
 * Why a stored artifact's subject no longer matches the expected subject.
 *
 * - `catalog-hash-migration` — only `catalogHash` differs, and the stored
 *   value is the current whole-file fixture hash: the artifact predates the
 *   per-model scheme and the model's row is unchanged. Re-certification
 *   carries its live canary forward.
 * - `launch-priority-catalog` — only `catalogHash` differs otherwise: the
 *   model's launch-priority row changed (or, for a legacy whole-file hash, the
 *   fixture changed since it was issued).
 * - `registry-identity` — a registry identity field (key, wire id, revision,
 *   fingerprint) changed.
 * - `identity-invalidated` — the artifact carries a durable invalidation.
 * - `unknown` — no comparable subject (legacy or unreadable artifact).
 */
export type ReidentificationCause =
  | 'catalog-hash-migration'
  | 'launch-priority-catalog'
  | 'registry-identity'
  | 'identity-invalidated'
  | 'unknown';

/** Operator-facing phrase for each cause, used by the preflight report. */
export const REIDENTIFICATION_CAUSE_LABELS: Record<ReidentificationCause, string> = {
  'catalog-hash-migration': 'catalog hash scheme migrated to per-model rows (live canaries carry forward)',
  'launch-priority-catalog': 'launch-priority fixture row changed',
  'registry-identity': 'registry identity changed',
  'identity-invalidated': 'identity invalidated (provider substitution or unpinned alias)',
  unknown: 'stored subject missing or unreadable',
};

export interface LegacyCatalogHashOptions {
  /**
   * The whole-file fixture hash the pre-HOK-3159 scheme would have stamped
   * today. Defaults to `hashLaunchPriorityFixture(fixturePath)`; inject it in
   * tests or when the caller already computed it.
   */
  legacyCatalogHash?: string;
  fixturePath?: string;
}

/**
 * Classify why `artifact` fails the identity check against `expected`.
 * Callers pass only artifacts already rejected as `identity-reidentified` or
 * `identity-invalidated`; an exact subject match classifies as `unknown`.
 */
export function classifyReidentificationCause(
  artifact: AnyNativeCertificationArtifact | undefined,
  expected: CertificationSubject,
  options: LegacyCatalogHashOptions = {},
): ReidentificationCause {
  if (!artifact || !isRevisionAwareArtifact(artifact)) return 'unknown';
  if (artifact.identityInvalidation) return 'identity-invalidated';

  const stored = artifact.subject;
  if (stored.catalogHash === expected.catalogHash) {
    return subjectsEqual(stored, expected) ? 'unknown' : 'registry-identity';
  }
  if (!subjectsEqual({ ...stored, catalogHash: expected.catalogHash }, expected)) {
    return 'registry-identity';
  }
  return stored.catalogHash === resolveLegacyCatalogHash(expected, options)
    ? 'catalog-hash-migration'
    : 'launch-priority-catalog';
}

/**
 * Carry a stored live coding canary across the whole-file → per-model
 * catalog-hash scheme change.
 *
 * Returns the canary re-stamped with the new subject's `catalogHash` and
 * `canaryCarriedForwardFrom` set to the old hash — but only when every one of
 * these holds, so the migration can never widen what a canary proves:
 *
 * 1. The stored subject differs from `subject` in `catalogHash` alone
 *    (registry key, wire id, identity revision and fingerprint unchanged).
 * 2. The stored hash equals the current whole-file fixture hash, which proves
 *    the artifact was issued against this exact fixture — so the model's own
 *    row is unchanged. A legacy hash from an older fixture state is refused:
 *    the row may have moved since, and only a fresh canary can say.
 * 3. The canary was recorded under that same stored hash.
 * 4. The re-stamped canary passes the normal coding-eligibility gate against
 *    the new subject (live pass, fresh, matching suite/phase/identity).
 *
 * Invalidated artifacts never carry forward. Returns undefined otherwise.
 */
export function carryForwardLegacyCatalogHashCanary(input: {
  previous: AnyNativeCertificationArtifact;
  subject: CertificationSubject;
  suiteVersion: string;
  now: Date;
} & LegacyCatalogHashOptions): LiveCodingCanaryResult | undefined {
  const { previous, subject } = input;
  if (!isRevisionAwareArtifact(previous) || previous.identityInvalidation) return undefined;
  const canary = previous.liveCanary;
  if (!canary) return undefined;
  if (classifyReidentificationCause(previous, subject, input) !== 'catalog-hash-migration') return undefined;
  if (canary.catalogHash !== previous.subject.catalogHash) return undefined;

  const restamped: LiveCodingCanaryResult = {
    ...canary,
    catalogHash: subject.catalogHash,
    canaryCarriedForwardFrom: canary.catalogHash,
  };
  const eligibility = evaluateLiveCodingCanaryEligibility(
    { ...previous, subject, liveCanary: restamped },
    input.suiteVersion,
    input.now,
    subject,
  );
  return eligibility.eligible ? restamped : undefined;
}

function resolveLegacyCatalogHash(
  expected: CertificationSubject,
  options: LegacyCatalogHashOptions,
): string | undefined {
  if (options.legacyCatalogHash !== undefined) return options.legacyCatalogHash;
  // Only OpenRouter subjects were ever stamped with the whole-file hash.
  if (expected.nativeProvider !== 'openrouter') return undefined;
  try {
    return hashLaunchPriorityFixture(options.fixturePath);
  } catch {
    return undefined;
  }
}
