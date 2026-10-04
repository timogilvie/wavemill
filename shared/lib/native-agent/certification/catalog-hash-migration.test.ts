import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import {
  carryForwardLegacyCatalogHashCanary,
  classifyReidentificationCause,
} from './catalog-hash-migration.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  LIVE_CODING_CANARY_TTL_DAYS,
  type CertificationSubject,
  type NativeCertificationArtifact,
} from './schema.ts';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const SUITE = 'v-test';
const LEGACY_HASH = 'a'.repeat(64);
const ROW_HASH = 'b'.repeat(64);

const SUBJECT: CertificationSubject = {
  registryKey: 'gemini-2.5-pro',
  nativeProvider: 'openrouter',
  providerId: 'google',
  providerModelId: 'gemini-2.5-pro',
  providerNativeId: 'google/gemini-2.5-pro',
  identityRevision: 1,
  identityFingerprint: 'fingerprint-1',
  catalogHash: ROW_HASH,
};

function artifact(
  subjectOverrides: Partial<CertificationSubject> = {},
  canaryOverrides: Record<string, unknown> = {},
  overrides: Partial<NativeCertificationArtifact> = {},
): NativeCertificationArtifact {
  const subject = { ...SUBJECT, catalogHash: LEGACY_HASH, ...subjectOverrides };
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject,
    provider: subject.providerId,
    model: subject.providerModelId,
    phase: 'workflow',
    suiteVersion: SUITE,
    certifiedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 'wf1', passed: true }],
    liveCanary: buildLiveCodingCanaryFixture(subject, SUITE, {
      ranAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      ...canaryOverrides,
    }),
    ...overrides,
  };
}

const INVALIDATION = {
  invalidatedAt: NOW.toISOString(),
  reason: 'identity_mismatch' as const,
  expectedModel: SUBJECT.providerNativeId,
  observedModel: 'someone/else',
  requestedWireId: SUBJECT.providerNativeId,
  source: 'runtime' as const,
};

describe('classifyReidentificationCause', () => {
  const opts = { legacyCatalogHash: LEGACY_HASH };

  it('recognizes an artifact drifting only because of the hash-scheme change', () => {
    assert.equal(classifyReidentificationCause(artifact(), SUBJECT, opts), 'catalog-hash-migration');
  });

  it('attributes any other catalogHash-only drift to the launch-priority fixture', () => {
    assert.equal(
      classifyReidentificationCause(artifact({ catalogHash: 'c'.repeat(64) }), SUBJECT, opts),
      'launch-priority-catalog',
    );
  });

  it('attributes registry identity changes regardless of the catalog hash', () => {
    for (const change of [
      { identityFingerprint: 'fingerprint-0' },
      { identityRevision: 0 },
      { providerNativeId: 'google/gemini-2.5-pro-0909' },
      { identityFingerprint: 'fingerprint-0', catalogHash: ROW_HASH },
    ]) {
      assert.equal(classifyReidentificationCause(artifact(change), SUBJECT, opts), 'registry-identity', JSON.stringify(change));
    }
  });

  it('reports invalidation first, and unknown for missing or matching subjects', () => {
    assert.equal(
      classifyReidentificationCause(artifact({}, {}, { identityInvalidation: INVALIDATION }), SUBJECT, opts),
      'identity-invalidated',
    );
    assert.equal(classifyReidentificationCause(undefined, SUBJECT, opts), 'unknown');
    assert.equal(classifyReidentificationCause(artifact({ catalogHash: ROW_HASH }), SUBJECT, opts), 'unknown');
  });

  it('never classifies a non-OpenRouter subject as a hash-scheme migration by default', () => {
    const subject = { ...SUBJECT, nativeProvider: 'openai', catalogHash: 'registry' };
    const stored = artifact({ nativeProvider: 'openai', catalogHash: LEGACY_HASH });
    assert.equal(classifyReidentificationCause(stored, subject), 'launch-priority-catalog');
  });
});

describe('carryForwardLegacyCatalogHashCanary', () => {
  const carry = (previous: NativeCertificationArtifact, subject = SUBJECT) => carryForwardLegacyCatalogHashCanary({
    previous,
    subject,
    suiteVersion: SUITE,
    now: NOW,
    legacyCatalogHash: LEGACY_HASH,
  });

  it('re-stamps a fresh live pass with the per-model hash and records the old one', () => {
    const previous = artifact();
    const carried = carry(previous);
    assert.ok(carried);
    assert.equal(carried.catalogHash, ROW_HASH);
    assert.equal(carried.canaryCarriedForwardFrom, LEGACY_HASH);
    assert.equal(carried.ranAt, previous.liveCanary!.ranAt, 'freshness is not reset');
    assert.equal(carried.status, 'pass');
  });

  it('refuses when the stored hash is not the current whole-file hash', () => {
    assert.equal(carry(artifact({ catalogHash: 'c'.repeat(64) })), undefined);
  });

  it('refuses when registry identity also changed', () => {
    assert.equal(carry(artifact({ identityFingerprint: 'fingerprint-0' })), undefined);
    assert.equal(carry(artifact({ identityRevision: 0 })), undefined);
  });

  it('refuses failed, inconclusive, non-live, stale and wrong-suite canaries', () => {
    const staleRanAt = new Date(NOW.getTime() - (LIVE_CODING_CANARY_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    for (const canaryOverrides of [
      { status: 'fail', reason: 'wrong_mutation' },
      { status: 'inconclusive', reason: 'provider_transient_error' },
      { status: 'skipped', reason: 'provider_config_error' },
      { isLive: false },
      { ranAt: staleRanAt },
      { suiteVersion: 'v-other' },
    ]) {
      assert.equal(carry(artifact({}, canaryOverrides)), undefined, JSON.stringify(canaryOverrides));
    }
  });

  it('refuses a canary recorded under a different hash than its artifact', () => {
    assert.equal(carry(artifact({}, { catalogHash: 'c'.repeat(64) })), undefined);
  });

  it('refuses invalidated artifacts and artifacts without a canary', () => {
    assert.equal(carry(artifact({}, {}, { identityInvalidation: INVALIDATION })), undefined);
    assert.equal(carry(artifact({}, {}, { liveCanary: undefined })), undefined);
  });

  it('does nothing when the subject already matches (routine renewal path)', () => {
    assert.equal(carry(artifact({ catalogHash: ROW_HASH })), undefined);
  });
});
