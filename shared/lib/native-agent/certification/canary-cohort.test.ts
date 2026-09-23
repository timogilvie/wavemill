import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from '../../config.ts';
import {
  computeIdentityFingerprint,
  type ModelCapabilities,
  type ModelRegistry,
} from '../../model-registry.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type NativeCertificationArtifact,
} from './schema.ts';
import { buildGlobalCertificationPath } from './loader.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './storage.ts';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import {
  evaluateCohortHealth,
  selectCohortRefreshTargets,
  validateCohortConfig,
} from './canary-cohort.ts';

const NOW = new Date('2026-07-01T00:00:00.000Z');
const CANARY_RAN_AT = '2026-06-25T00:00:00.000Z';
const FRESH_CERTIFIED_AT = '2026-06-01T00:00:00.000Z';
const SUITE_VERSION = 'v-cohort-test';

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'canary-cohort-'));
  const previousGlobalRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}');
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      if (previousGlobalRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousGlobalRoot;
      }
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function testSubject(provider: string, model: string): NativeCertificationArtifact['subject'] {
  return {
    registryKey: model,
    nativeProvider: provider,
    providerId: provider,
    providerModelId: model,
    providerNativeId: model,
    identityRevision: 1,
    identityFingerprint: computeIdentityFingerprint({
      alias: model,
      providerNativeId: model,
      provider,
      revision: 1,
    }),
    catalogHash: 'registry',
  };
}

function writeCertArtifact(
  provider: string,
  model: string,
  opts: { canary?: boolean; staleCanary?: boolean } = {},
): void {
  const subject = testSubject(provider, model);
  const artifactPath = buildGlobalCertificationPath(provider, model, SUITE_VERSION);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject,
    provider,
    model,
    phase: 'workflow',
    suiteVersion: SUITE_VERSION,
    certifiedAt: FRESH_CERTIFIED_AT,
    scenarios: [{ scenarioId: 'cohort.test', passed: true }],
    ...(opts.canary !== false
      ? {
        liveCanary: buildLiveCodingCanaryFixture(subject, SUITE_VERSION, {
          ranAt: opts.staleCanary ? '2026-01-01T00:00:00.000Z' : CANARY_RAN_AT,
        }),
      }
      : {}),
  };
  writeFileSync(artifactPath, JSON.stringify(artifact));
}

function nativeModel(provider = 'openai'): ModelCapabilities {
  return {
    vendor: 'openai',
    class: 'strong_generalist',
    strengths: ['coding'],
    weaknesses: [],
    qualityScores: { routing: 70, planning: 75, coding: 85, review: 80, classify: 70 },
    contextWindowTokens: 128_000,
    toolSupport: 'full',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 4,
    nativeCapability: {
      nativeProvider: provider,
      piTransportKind: 'openai-responses',
      readOnlyNative: 'certified',
      certification: {
        maxCertifiedPhase: 'workflow',
        certifiedAt: FRESH_CERTIFIED_AT,
        certificationSuiteVersion: SUITE_VERSION,
      },
    },
  };
}

function registryWith(models: Record<string, ModelCapabilities>): ModelRegistry {
  return { models, ladders: {} };
}

describe('canary-cohort', () => {
  describe('validateCohortConfig', () => {
    it('returns no errors for valid cohort', () => {
      const registry = registryWith({ 'model-a': nativeModel() });
      const errors = validateCohortConfig(
        { identities: [{ provider: 'openai', model: 'model-a' }] },
        registry,
      );
      assert.equal(errors.length, 0);
    });

    it('rejects unknown model', () => {
      const registry = registryWith({});
      const errors = validateCohortConfig(
        { identities: [{ provider: 'openai', model: 'unknown' }] },
        registry,
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /not in registry/);
    });

    it('rejects provider mismatch', () => {
      const registry = registryWith({ 'model-a': nativeModel('openai') });
      const errors = validateCohortConfig(
        { identities: [{ provider: 'openrouter', model: 'model-a' }] },
        registry,
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /provider mismatch/);
    });
  });

  describe('evaluateCohortHealth', () => {
    it('reports all ready when canaries pass', () => {
      const { cleanup } = makeRepo();
      try {
        const registry = registryWith({
          'model-a': nativeModel(),
          'model-b': nativeModel(),
        });
        writeCertArtifact('openai', 'model-a');
        writeCertArtifact('openai', 'model-b');

        const health = evaluateCohortHealth(
          {
            identities: [
              { provider: 'openai', model: 'model-a' },
              { provider: 'openai', model: 'model-b' },
            ],
            minimumReady: 2,
          },
          registry,
          { now: NOW },
        );
        assert.equal(health.codingReadyCount, 2);
        assert.equal(health.belowMinimum, false);
      } finally {
        cleanup();
      }
    });

    it('reports below minimum when canary missing', () => {
      const { cleanup } = makeRepo();
      try {
        const registry = registryWith({
          'model-a': nativeModel(),
          'model-b': nativeModel(),
        });
        writeCertArtifact('openai', 'model-a');
        // model-b has no artifact

        const health = evaluateCohortHealth(
          {
            identities: [
              { provider: 'openai', model: 'model-a' },
              { provider: 'openai', model: 'model-b' },
            ],
            minimumReady: 2,
          },
          registry,
          { now: NOW },
        );
        assert.equal(health.codingReadyCount, 1);
        assert.equal(health.belowMinimum, true);
        assert.equal(health.identities[1].reason, 'missing');
      } finally {
        cleanup();
      }
    });

    it('reports stale canary as not ready', () => {
      const { cleanup } = makeRepo();
      try {
        const registry = registryWith({ 'model-a': nativeModel() });
        writeCertArtifact('openai', 'model-a', { staleCanary: true });

        const health = evaluateCohortHealth(
          {
            identities: [{ provider: 'openai', model: 'model-a' }],
            minimumReady: 1,
          },
          registry,
          { now: NOW },
        );
        assert.equal(health.codingReadyCount, 0);
        assert.equal(health.belowMinimum, true);
        assert.equal(health.identities[0].reason, 'stale');
      } finally {
        cleanup();
      }
    });

    it('uses default minimumReady of 2', () => {
      const { cleanup } = makeRepo();
      try {
        const registry = registryWith({ 'model-a': nativeModel() });
        writeCertArtifact('openai', 'model-a');

        const health = evaluateCohortHealth(
          { identities: [{ provider: 'openai', model: 'model-a' }] },
          registry,
          { now: NOW },
        );
        assert.equal(health.minimumReady, 2);
        assert.equal(health.belowMinimum, true);
      } finally {
        cleanup();
      }
    });
  });

  describe('selectCohortRefreshTargets', () => {
    it('selects only non-ready identities', () => {
      const { cleanup } = makeRepo();
      try {
        const registry = registryWith({
          'model-a': nativeModel(),
          'model-b': nativeModel(),
        });
        writeCertArtifact('openai', 'model-a');
        // model-b missing

        const targets = selectCohortRefreshTargets(
          {
            identities: [
              { provider: 'openai', model: 'model-a' },
              { provider: 'openai', model: 'model-b' },
            ],
          },
          registry,
          { now: NOW },
        );
        assert.equal(targets.length, 1);
        assert.equal(targets[0].model, 'model-b');
      } finally {
        cleanup();
      }
    });

    it('returns empty when all ready', () => {
      const { cleanup } = makeRepo();
      try {
        const registry = registryWith({
          'model-a': nativeModel(),
          'model-b': nativeModel(),
        });
        writeCertArtifact('openai', 'model-a');
        writeCertArtifact('openai', 'model-b');

        const targets = selectCohortRefreshTargets(
          {
            identities: [
              { provider: 'openai', model: 'model-a' },
              { provider: 'openai', model: 'model-b' },
            ],
          },
          registry,
          { now: NOW },
        );
        assert.equal(targets.length, 0);
      } finally {
        cleanup();
      }
    });
  });
});
