import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { evaluateNativeProviderGate } from './eligibility-gate.ts';
import { buildGlobalCertificationPath } from './loader.ts';
import { resolveCertificationSubject } from './identity.ts';
import { CERTIFICATION_SCHEMA_VERSION, type NativeCertificationArtifact } from './schema.ts';
import { evaluateSuiteCoverage } from './coverage.ts';
import type { ModelRegistry } from '../../model-registry.ts';
import { hashLaunchPriorityFixture } from '../../openrouter-catalog.ts';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function makeRegistry(requiredSuiteVersion = 'vNEW'): ModelRegistry {
  return {
    models: {
      'gpt-4o': {
        vendor: 'openai',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: 'read-only',
            certifiedAt: '2026-08-01T00:00:00.000Z',
            certificationSuiteVersion: requiredSuiteVersion,
          },
        },
      },
    },
    ladders: {},
  };
}

function makeArtifact(suiteVersion: string, registry: ModelRegistry): NativeCertificationArtifact {
  const subject = resolveCertificationSubject({ provider: 'openai', model: 'gpt-4o', registry });
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: subject.subject,
    provider: subject.storageIdentity.provider,
    model: subject.storageIdentity.model,
    phase: 'read-only',
    suiteVersion,
    certifiedAt: '2026-08-24T00:00:00.000Z',
    scenarios: [{ scenarioId: 'read-only.list-files', passed: true }],
  };
}

function withAdditionalNativeModels(registry: ModelRegistry, modelIds: string[]): ModelRegistry {
  const models = { ...registry.models };
  for (const modelId of modelIds) {
    models[modelId] = {
      ...registry.models['gpt-4o']!,
      nativeCapability: {
        ...registry.models['gpt-4o']!.nativeCapability!,
        certification: {
          ...registry.models['gpt-4o']!.nativeCapability!.certification!,
        },
      },
    };
  }
  return {
    ...registry,
    models,
  };
}

function writeArtifact(root: string, artifact: NativeCertificationArtifact): void {
  const path = buildGlobalCertificationPath(artifact.provider, artifact.model, artifact.suiteVersion, { root });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

describe('evaluateSuiteCoverage', () => {
  it('detects a suite bump without published current artifacts and recovers after publish', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-'));
    const registry = makeRegistry('vNEW');
    try {
      writeArtifact(root, makeArtifact('vOLD', registry));

      const coverage = evaluateSuiteCoverage({ registry, root });
      assert.equal(coverage.status, 'bump-without-publish');
      assert.equal(coverage.requiredSuiteVersion, 'vNEW');
      assert.equal(coverage.artifactCountForRequiredSuite, 0);
      assert.deepEqual(coverage.artifactCountByOtherSuite, { vOLD: 1 });
      assert.equal(coverage.staleCount, 0);
      assert.deepEqual(coverage.modelsInRenewalWindow, []);
      assert.match(coverage.remediationCommand, /certify --all/);

      writeArtifact(root, makeArtifact('vNEW', registry));
      const recovered = evaluateSuiteCoverage({ registry, root });
      assert.equal(recovered.status, 'ok');
      assert.equal(recovered.artifactCountForRequiredSuite, 1);

      const gate = evaluateNativeProviderGate({
        modelId: 'gpt-4o',
        mode: 'task',
        requiredPhase: 'read-only',
        registry,
        apiKeyPresent: true,
        apiKeyEnv: 'OPENAI_API_KEY',
        now: NOW,
        certificationRoot: root,
      });
      assert.equal(gate.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags identity drift when artifacts are on the right suite but no longer match their subject', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-drift-'));
    const registry = makeRegistry('vNEW');
    try {
      // A healthy store: right suite, right subject.
      writeArtifact(root, makeArtifact('vNEW', registry));
      assert.equal(evaluateSuiteCoverage({ registry, root }).status, 'ok');

      // Now simulate the launch-priority fixture changing underneath it. The
      // artifact count and suite version are untouched — only catalogHash moves,
      // which is precisely the case the count-based guard could not see.
      const drifted = makeArtifact('vNEW', registry);
      drifted.subject = { ...drifted.subject!, catalogHash: 'hash-from-a-previous-fixture' };
      writeArtifact(root, drifted);

      const coverage = evaluateSuiteCoverage({ registry, root });
      assert.equal(coverage.status, 'identity-drift');
      assert.equal(coverage.artifactCountForRequiredSuite, 1, 'count signal is unchanged');
      assert.equal(coverage.eligibleModelCount, 0);
      assert.equal(coverage.identityDriftCount, 1);
      assert.equal(coverage.staleCount, 0);
      assert.deepEqual(coverage.modelsInRenewalWindow, []);
      assert.deepEqual(
        coverage.ineligibleModels.map((m) => m.reason),
        ['identity-reidentified'],
      );

      // Re-certifying restores eligibility.
      writeArtifact(root, makeArtifact('vNEW', registry));
      assert.equal(evaluateSuiteCoverage({ registry, root }).status, 'ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies the cause of each re-identified model (HOK-3159)', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-causes-'));
    const base = withAdditionalNativeModels(makeRegistry('vNEW'), ['gpt-4o-b', 'gpt-4o-c', 'gpt-4o-d']);
    const gpt4o = base.models['gpt-4o']!;
    const registry: ModelRegistry = {
      ...base,
      models: {
        ...base.models,
        'qwen-3-coder': {
          ...gpt4o,
          nativeCapability: { ...gpt4o.nativeCapability!, nativeProvider: 'openrouter', piTransportKind: 'openai-completions' },
        },
      },
    };
    const artifactFor = (provider: 'openai' | 'openrouter', model: string): NativeCertificationArtifact => {
      const subject = resolveCertificationSubject({ provider, model, registry });
      return {
        ...makeArtifact('vNEW', registry),
        subject: subject.subject,
        provider: subject.storageIdentity.provider,
        model: subject.storageIdentity.model,
      };
    };
    try {
      const catalog = artifactFor('openai', 'gpt-4o');
      catalog.subject = { ...catalog.subject!, catalogHash: 'hash-from-a-previous-fixture' };
      writeArtifact(root, catalog);

      const fingerprint = artifactFor('openai', 'gpt-4o-b');
      fingerprint.subject = { ...fingerprint.subject!, identityFingerprint: 'old-fingerprint' };
      writeArtifact(root, fingerprint);

      const invalidated = artifactFor('openai', 'gpt-4o-c');
      invalidated.identityInvalidation = {
        invalidatedAt: NOW.toISOString(),
        reason: 'identity_mismatch',
        expectedModel: 'gpt-4o-c',
        observedModel: 'someone-else',
        requestedWireId: 'gpt-4o-c',
        source: 'runtime',
      };
      writeArtifact(root, invalidated);

      writeArtifact(root, artifactFor('openai', 'gpt-4o-d'));

      // A pre-HOK-3159 OpenRouter artifact: stamped with the whole-file hash.
      const legacy = artifactFor('openrouter', 'qwen-3-coder');
      legacy.subject = { ...legacy.subject!, catalogHash: hashLaunchPriorityFixture() };
      writeArtifact(root, legacy);

      const coverage = evaluateSuiteCoverage({ registry, root });
      const causes = Object.fromEntries(coverage.ineligibleModels.map((m) => [m.registryKey, m.cause]));
      assert.deepEqual(causes, {
        'gpt-4o': 'launch-priority-catalog',
        'gpt-4o-b': 'registry-identity',
        'gpt-4o-c': 'identity-invalidated',
        'qwen-3-coder': 'catalog-hash-migration',
      });
      assert.equal(coverage.eligibleModelCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not raise identity drift for a lone stale orphan while the fleet is healthy', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-orphan-'));
    const registry = makeRegistry('vNEW');
    try {
      writeArtifact(root, makeArtifact('vNEW', registry));
      // An artifact for a model that is no longer in the registry at all must not
      // be counted against the fleet: it is never resolved as a certifiable model.
      const orphan = makeArtifact('vNEW', registry);
      orphan.provider = 'stealth';
      orphan.model = 'removed-model';
      writeArtifact(root, orphan);

      const coverage = evaluateSuiteCoverage({ registry, root });
      assert.equal(coverage.status, 'ok');
      assert.equal(coverage.eligibleModelCount, 1);
      assert.equal(coverage.identityDriftCount, 0);
      assert.deepEqual(coverage.orphanArtifacts.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        suiteVersion: entry.suiteVersion,
      })), [{
        provider: 'stealth',
        model: 'removed-model',
        suiteVersion: 'vNEW',
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks near-expiry artifacts as renewal due without blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-renewal-'));
    const registry = makeRegistry('vNEW');
    try {
      writeArtifact(root, makeArtifact('vNEW', registry));

      const coverage = evaluateSuiteCoverage({
        registry,
        root,
        now: new Date('2026-10-22T00:00:00.000Z'),
        renewalWindowDays: 7,
      });
      assert.equal(coverage.status, 'ok');
      assert.equal(coverage.renewalDueCount, 1);
      assert.deepEqual(coverage.modelsInRenewalWindow, [{
        registryKey: 'gpt-4o',
        expiresAt: '2026-10-23T00:00:00.000Z',
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports stale status when expired artifacts take out the certifiable fleet', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-stale-'));
    const registry = makeRegistry('vNEW');
    try {
      writeArtifact(root, makeArtifact('vNEW', registry));

      const coverage = evaluateSuiteCoverage({
        registry,
        root,
        now: new Date('2026-10-25T00:00:00.000Z'),
      });
      assert.equal(coverage.status, 'stale');
      assert.equal(coverage.staleCount, 1);
      assert.deepEqual(coverage.staleModels, [{ registryKey: 'gpt-4o' }]);
      assert.equal(coverage.identityDriftCount, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps mixed stale and eligible coverage ok below the stale threshold', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-mixed-stale-'));
    const registry = withAdditionalNativeModels(makeRegistry('vNEW'), ['gpt-4o-mini', 'gpt-4.1']);
    try {
      writeArtifact(root, makeArtifact('vNEW', registry));
      for (const model of ['gpt-4o-mini', 'gpt-4.1']) {
        const fresh = makeArtifact('vNEW', registry);
        fresh.subject = resolveCertificationSubject({ provider: 'openai', model, registry }).subject;
        fresh.model = model;
        fresh.certifiedAt = '2026-10-01T00:00:00.000Z';
        writeArtifact(root, fresh);
      }

      const coverage = evaluateSuiteCoverage({
        registry,
        root,
        now: new Date('2026-10-25T00:00:00.000Z'),
      });
      assert.equal(coverage.status, 'ok');
      assert.equal(coverage.eligibleModelCount, 2);
      assert.equal(coverage.staleCount, 1);
      assert.deepEqual(coverage.staleModels, [{ registryKey: 'gpt-4o' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats an empty store as a warning state, not a bump failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-empty-'));
    try {
      const coverage = evaluateSuiteCoverage({ registry: makeRegistry('vNEW'), root });
      assert.equal(coverage.status, 'empty-store');
      assert.equal(coverage.artifactCountForRequiredSuite, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
