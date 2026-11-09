/**
 * Tests for the Hokusai (Model 30) descriptor-stage candidate pool (HOK-3429).
 *
 * The pool is the ladder plus native models that pass the existing router
 * certification gate and are launch-ready. These tests seed the global
 * certification store explicitly so they never depend on artifacts a
 * developer happens to have run locally.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { getDescriptorStagePool } from './descriptor-stage-pool.ts';
import { getConfiguredModelsForDescriptorStage, DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import { resolveCertificationSubject } from './native-agent/certification/identity.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import { CERTIFICATION_SCHEMA_VERSION } from './native-agent/certification/schema.ts';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const CERTIFIED_AT = '2026-11-01T00:00:00.000Z';
const FRESH_CANARY_RAN_AT = '2026-11-04T00:00:00.000Z';
// The live coding canary TTL is 14 days; this run is well past it.
const STALE_CANARY_RAN_AT = '2026-10-01T00:00:00.000Z';
const CERTIFIED_NATIVE_MODELS = ['qwen-3-coder', 'kimi-k2.7-code', 'glm-5.3', 'glm-5.3-flash'];

const priorOpenRouterKey = process.env.TEST_POOL_OPENROUTER_KEY;

before(() => {
  process.env.TEST_POOL_OPENROUTER_KEY = 'test-openrouter-key';
});

after(() => {
  if (priorOpenRouterKey === undefined) {
    delete process.env.TEST_POOL_OPENROUTER_KEY;
  } else {
    process.env.TEST_POOL_OPENROUTER_KEY = priorOpenRouterKey;
  }
});

interface TestRepo {
  repoDir: string;
  certificationRoot: string;
  cleanup: () => void;
}

function makeRepo(providers: Record<string, unknown> = {}): TestRepo {
  const repoDir = mkdtempSync(join(tmpdir(), 'descriptor-stage-pool-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      providers: {
        openrouter: { enabled: true, apiKeyEnv: 'TEST_POOL_OPENROUTER_KEY' },
        ...providers,
      },
    }),
  );
  clearConfigCache(repoDir);
  const certificationRoot = mkdtempSync(join(tmpdir(), 'descriptor-stage-pool-cert-'));
  return {
    repoDir,
    certificationRoot,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(certificationRoot, { recursive: true, force: true });
    },
  };
}

function writeCertification(
  root: string,
  modelId: string,
  canaryRanAt: string = FRESH_CANARY_RAN_AT,
): void {
  const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
  const suiteVersion = capabilities?.nativeCapability?.certification?.certificationSuiteVersion;
  const provider = capabilities?.nativeCapability?.nativeProvider;
  assert.ok(suiteVersion, `fixture model ${modelId} must declare a certification suite`);
  assert.ok(provider, `fixture model ${modelId} must declare a native provider`);
  const identity = resolveCertificationSubject({
    provider,
    model: modelId,
    registry: DEFAULT_MODEL_REGISTRY,
  });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
    { root },
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: CERTIFIED_AT,
    scenarios: [{ scenarioId: 'native-openrouter-workflow-launch', passed: true }],
    liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: canaryRanAt }),
  }, null, 2));
}

describe('getDescriptorStagePool', () => {
  // protects: without a repo dir the pool is exactly the ladder and nothing is
  // rejected (native models only exist in a repo-scoped context).
  it('returns the ladder unchanged when no repo dir is provided', () => {
    const pool = getDescriptorStagePool(undefined, 'coder');
    assert.deepEqual(pool.models, getConfiguredModelsForDescriptorStage(undefined, 'coder'));
    assert.deepEqual(pool.nativeModels, []);
    assert.deepEqual(pool.nativeRejections, []);
    assert.deepEqual(pool.providerWarnings, []);
  });

  // protects: acceptance #1 — certified native models reach the coder pool that
  // Model 30 is offered (they are defaultLadderEligible: false otherwise).
  it('adds certified, launch-ready native models to the coder pool', () => {
    const repo = makeRepo();
    try {
      for (const modelId of CERTIFIED_NATIVE_MODELS) {
        writeCertification(repo.certificationRoot, modelId);
      }
      const pool = getDescriptorStagePool(repo.repoDir, 'coder', {
        now: NOW,
        certificationRoot: repo.certificationRoot,
      });
      for (const modelId of CERTIFIED_NATIVE_MODELS) {
        assert.ok(pool.models.includes(modelId), `${modelId} should be in the coder pool`);
        assert.ok(pool.nativeModels.includes(modelId), `${modelId} should be reported as native`);
        assert.ok(
          !pool.nativeRejections.some((rejection) => rejection.modelId === modelId),
          `${modelId} should not be rejected`,
        );
      }
      assert.equal(new Set(pool.models).size, pool.models.length, 'pool must not contain duplicates');
      assert.deepEqual(pool.providerWarnings, []);
    } finally {
      repo.cleanup();
    }
  });

  // protects: acceptance #2 — a stale live canary keeps the model out of the
  // pool and records the reason the route artifact carries.
  it('drops a model whose live canary is stale and records stale-live-canary', () => {
    const repo = makeRepo();
    try {
      for (const modelId of CERTIFIED_NATIVE_MODELS) {
        writeCertification(
          repo.certificationRoot,
          modelId,
          modelId === 'qwen-3-coder' ? STALE_CANARY_RAN_AT : FRESH_CANARY_RAN_AT,
        );
      }
      const pool = getDescriptorStagePool(repo.repoDir, 'coder', {
        now: NOW,
        certificationRoot: repo.certificationRoot,
      });
      assert.ok(!pool.models.includes('qwen-3-coder'), 'stale-canary coder must be dropped');
      const rejection = pool.nativeRejections.find((entry) => entry.modelId === 'qwen-3-coder');
      assert.ok(rejection, 'rejection must be recorded');
      assert.equal(rejection?.reason, 'stale-live-canary');
      assert.equal(rejection?.role, 'coder');
      // The fresh siblings are unaffected.
      assert.ok(pool.models.includes('kimi-k2.7-code'));
    } finally {
      repo.cleanup();
    }
  });

  // protects: rule 2 — a certified model is never offered when its provider is
  // not launch-ready, and the reason is reported.
  it('drops native models with a provider warning when OpenRouter is disabled', () => {
    const repo = makeRepo({ openrouter: { enabled: false, apiKeyEnv: 'TEST_POOL_OPENROUTER_KEY' } });
    try {
      writeCertification(repo.certificationRoot, 'qwen-3-coder');
      const pool = getDescriptorStagePool(repo.repoDir, 'coder', {
        now: NOW,
        certificationRoot: repo.certificationRoot,
      });
      assert.ok(!pool.models.includes('qwen-3-coder'));
      assert.deepEqual(pool.nativeModels, []);
      assert.ok(
        pool.providerWarnings.some((warning) => warning.includes('providers.openrouter.enabled')),
        'provider-disabled warning must be reported',
      );
      assert.ok(
        pool.providerWarnings.some((warning) => warning.includes('qwen-3-coder')),
        'per-model launch-readiness warning must be reported',
      );
    } finally {
      repo.cleanup();
    }
  });

  // protects: rule 2 — a missing API key drops native models even when the
  // provider is enabled.
  it('drops native models when the provider API key is missing', () => {
    const repo = makeRepo({ openrouter: { enabled: true, apiKeyEnv: 'TEST_POOL_MISSING_KEY' } });
    try {
      writeCertification(repo.certificationRoot, 'glm-5.3');
      const pool = getDescriptorStagePool(repo.repoDir, 'coder', {
        now: NOW,
        certificationRoot: repo.certificationRoot,
      });
      assert.ok(!pool.models.includes('glm-5.3'));
      assert.ok(
        pool.providerWarnings.some((warning) => warning.includes('TEST_POOL_MISSING_KEY')),
        'missing-key warning must be reported',
      );
    } finally {
      repo.cleanup();
    }
  });

  // protects: the certification gate still enforces role eligibility per stage.
  it('rejects a native model whose launch-priority role excludes the stage', () => {
    const repo = makeRepo();
    try {
      // llama-4-maverick is eligible for planning/coding only.
      writeCertification(repo.certificationRoot, 'llama-4-maverick');
      const pool = getDescriptorStagePool(repo.repoDir, 'reviewer', {
        now: NOW,
        certificationRoot: repo.certificationRoot,
      });
      assert.ok(!pool.models.includes('llama-4-maverick'));
      const rejection = pool.nativeRejections.find((entry) => entry.modelId === 'llama-4-maverick');
      assert.equal(rejection?.reason, 'role-ineligible');
    } finally {
      repo.cleanup();
    }
  });
});
