import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isValidCertificationPathSegment,
  resolveCertificationSubject,
  resolveCertificationStorageIdentity,
} from './identity.ts';
import {
  computeIdentityFingerprint,
  type ModelCapabilities,
  type ModelRegistry,
  type OpenRouterRoutingPreference,
} from '../../model-registry.ts';

describe('resolveCertificationStorageIdentity', () => {
  it('normalizes OpenRouter challenge aliases to canonical provider/model storage identity', () => {
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'qwen-3-coder'), {
      provider: 'qwen',
      model: 'qwen3-coder',
    });
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'glm-5.2'), {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'kimi-k2.7-code'), {
      provider: 'moonshotai',
      model: 'kimi-k2.7-code',
    });
  });

  it('normalizes provider aliases and mixed case for direct storage identities', () => {
    assert.deepEqual(resolveCertificationStorageIdentity('Z.AI', 'GLM-5.2'), {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
    assert.deepEqual(resolveCertificationStorageIdentity('Moonshot-AI', 'KIMI-K2.7-CODE'), {
      provider: 'moonshotai',
      model: 'kimi-k2.7-code',
    });
  });

  it('keeps OpenRouter IDs with slashes as safe two-segment storage paths', () => {
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'z-ai/glm-5.2'), {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
  });

  it('rejects unsafe path segments', () => {
    assert.equal(isValidCertificationPathSegment('qwen3-coder'), true);
    assert.equal(isValidCertificationPathSegment('../qwen3-coder'), false);
    assert.equal(isValidCertificationPathSegment('qwen/qwen3-coder'), false);
    assert.equal(isValidCertificationPathSegment(''), false);
  });
});

describe('resolveCertificationSubject', () => {
  it('resolves alias and raw OpenRouter id to one identical subject', () => {
    const registry = makeRegistry();
    const alias = resolveCertificationSubject({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      registry,
    });
    const raw = resolveCertificationSubject({
      provider: 'openrouter',
      model: 'qwen/qwen3-coder',
      registry,
    });

    assert.deepEqual(alias.subject, raw.subject);
    assert.deepEqual(alias.storageIdentity, { provider: 'qwen', model: 'qwen3-coder' });
    assert.deepEqual(raw.storageIdentity, alias.storageIdentity);
  });

  it('changes the subject when the registry identity revision changes', () => {
    const first = resolveCertificationSubject({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      registry: makeRegistry(1),
    });
    const second = resolveCertificationSubject({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      registry: makeRegistry(2),
    });

    assert.equal(first.storageIdentity.provider, second.storageIdentity.provider);
    assert.equal(first.storageIdentity.model, second.storageIdentity.model);
    assert.notDeepEqual(first.subject, second.subject);
    assert.equal(second.subject.identityRevision, 2);
  });

  // A certificate earned on whatever host OpenRouter picked says nothing about
  // the pinned host (kimi-k3 tool args are mangled on some quantized hosts).
  it('binds the subject catalogHash to the OpenRouter routing pin', () => {
    const unpinned = resolveCertificationSubject({ provider: 'openrouter', model: 'qwen-3-coder', registry: makeRegistry() });
    const pinned = resolveCertificationSubject({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      registry: makeRegistry(1, { order: ['alibaba'], allow_fallbacks: false }),
    });
    const repinned = resolveCertificationSubject({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      registry: makeRegistry(1, { order: ['together'], allow_fallbacks: false }),
    });

    assert.equal(unpinned.unpinnedCatalogHash, undefined);
    assert.equal(pinned.unpinnedCatalogHash, unpinned.subject.catalogHash);
    assert.notEqual(pinned.subject.catalogHash, unpinned.subject.catalogHash);
    assert.notEqual(pinned.subject.catalogHash, repinned.subject.catalogHash);
    assert.deepEqual({ ...pinned.subject, catalogHash: '' }, { ...unpinned.subject, catalogHash: '' });
  });
});

function makeRegistry(revision = 1, openRouterRouting?: OpenRouterRoutingPreference): ModelRegistry {
  const alias = 'qwen-3-coder';
  const providerNativeId = 'qwen/qwen3-coder';
  const fingerprint = computeIdentityFingerprint({
    alias,
    providerNativeId,
    provider: 'openrouter',
    revision,
  });
  const model: ModelCapabilities = {
    vendor: 'qwen',
    class: 'strong_generalist',
    strengths: [],
    weaknesses: [],
    qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
    contextWindowTokens: 262144,
    toolSupport: 'full',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 3,
    nativeCapability: {
      nativeProvider: 'openrouter',
      piTransportKind: 'openai-completions',
      readOnlyNative: 'certified',
      ...(openRouterRouting ? { compatFlags: { thinkingFormat: 'openrouter', openRouterRouting } } : {}),
    },
    supportedModel: {
      wavemillAlias: alias,
      providerNativeId,
      provider: 'openrouter',
      transport: 'openai-completions',
      stages: ['planning', 'coding', 'review'],
      certificationSuiteVersion: 'v3',
      canonicalArtifactIdentity: { provider: 'qwen', model: 'qwen3-coder', suiteVersion: 'v3' },
    },
    identity: {
      status: 'verified',
      revision,
      fingerprint,
      displayName: 'Qwen 3 Coder',
      family: 'qwen',
      evidencePolicy: 'eligible',
      verification: {
        source: 'test',
        observedAt: '2026-08-23T00:00:00.000Z',
        catalogHash: 'catalog-hash',
      },
    },
  };
  return {
    models: { [alias]: model },
    ladders: {},
  };
}
