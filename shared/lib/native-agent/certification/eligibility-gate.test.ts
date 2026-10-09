import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { computeIdentityFingerprint, type ModelRegistry } from '../../model-registry.ts';
import { hashLaunchPriorityModelRow, resolveOpenRouterModelIdentity } from '../../openrouter-catalog.ts';
import {
  buildGlobalCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  evaluateNativeProviderGate,
  type CertificationPhase,
  type CertificationSubject,
  type NativeCertificationArtifact,
  type NativeGateInput,
} from './index.ts';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './storage.ts';

const FIXED_NOW = new Date('2026-07-12T12:00:00.000Z');

function makeRegistry(modelId: string, provider: 'openai' | 'openrouter', suiteVersion = 'v1'): ModelRegistry {
  const providerNativeId = provider === 'openrouter'
    ? (resolveOpenRouterModelIdentity(modelId)?.openrouterId ?? modelId)
    : modelId;
  return {
    models: {
      [modelId]: {
        vendor: provider,
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        nativeCapability: {
          nativeProvider: provider,
          piTransportKind: provider === 'openai' ? 'openai-responses' : 'openai-completions',
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: 'workflow',
            certifiedAt: FIXED_NOW.toISOString(),
            certificationSuiteVersion: suiteVersion,
          },
        },
        supportedModel: {
          wavemillAlias: modelId,
          providerNativeId,
          provider,
          transport: provider === 'openai' ? 'openai-responses' : 'openai-completions',
          stages: ['planning', 'coding', 'review'],
          certificationSuiteVersion: suiteVersion,
        },
      },
    },
    ladders: {},
  };
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'eligibility-gate-'));
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  return {
    repoDir,
    cleanup: () => {
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function taskInput(
  registry: ModelRegistry,
  modelId: string,
  repoDir: string,
  overrides: Partial<NativeGateInput> = {},
): NativeGateInput {
  return {
    modelId,
    mode: 'task',
    requiredPhase: 'read-only',
    registry,
    repoDir,
    apiKeyPresent: true,
    apiKeyEnv: 'TEST_API_KEY',
    now: FIXED_NOW,
    ...overrides,
  };
}

function makeSubject(provider: 'openai' | 'openrouter', modelId: string): CertificationSubject {
  const openRouterIdentity = provider === 'openrouter'
    ? (resolveOpenRouterModelIdentity(modelId)?.openrouterId ?? modelId).split('/')
    : null;
  const providerNativeId = openRouterIdentity ? `${openRouterIdentity[0]!}/${openRouterIdentity[1]!}` : modelId;
  return {
    registryKey: modelId,
    nativeProvider: provider,
    providerId: openRouterIdentity ? openRouterIdentity[0]! : provider,
    providerModelId: openRouterIdentity ? openRouterIdentity[1]! : modelId,
    providerNativeId,
    identityRevision: 1,
    identityFingerprint: computeIdentityFingerprint({
      alias: modelId,
      providerNativeId,
      provider,
      revision: 1,
    }),
    catalogHash: provider === 'openrouter' ? hashLaunchPriorityModelRow(modelId) ?? 'missing-row' : 'registry',
  };
}

function writeArtifact(
  repoDir: string,
  provider: 'openai' | 'openrouter',
  modelId: string,
  suiteVersion: string,
  overrides: Partial<NativeCertificationArtifact> = {},
  certificationRoot?: string,
): string {
  void repoDir;
  const path = buildGlobalCertificationPath(provider, modelId, suiteVersion, { root: certificationRoot });
  mkdirSync(dirname(path), { recursive: true });
  const subject = makeSubject(provider, modelId);
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject,
    provider: subject.providerId,
    model: subject.providerModelId,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf8');
  return path;
}

describe('evaluateNativeProviderGate', () => {
  it('rejects missing API keys before registry or filesystem checks', () => {
    const decision = evaluateNativeProviderGate({
      modelId: 'gpt-4o',
      mode: 'task',
      requiredPhase: 'read-only',
      registry: { models: {}, ladders: {} },
      repoDir: '/tmp/unused',
      apiKeyPresent: false,
      apiKeyEnv: 'OPENAI_API_KEY',
      now: FIXED_NOW,
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'missing_api_key');
    assert.match(decision.message, /apiKeyEnv=OPENAI_API_KEY/);
  });

  it('rejects unregistered models without requiring artifact access', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const decision = evaluateNativeProviderGate(taskInput({ models: {}, ladders: {} }, 'missing-model', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'unregistered_model');
      assert.match(decision.message, /nativeCapability=unregistered/);
    } finally {
      cleanup();
    }
  });

  it('allows certification mode without an artifact', () => {
    const registry = makeRegistry('gpt-4o', 'openai');

    const decision = evaluateNativeProviderGate({
      modelId: 'gpt-4o',
      mode: 'certification',
      registry,
      apiKeyPresent: true,
      apiKeyEnv: 'OPENAI_API_KEY',
    });

    assert.deepEqual(decision, {
      ok: true,
      modelId: 'gpt-4o',
      nativeProvider: 'openai',
      certified: false,
    });
  });

  it('requires requiredPhase in task mode', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      assert.throws(
        () => evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, { requiredPhase: undefined })),
        /requiredPhase is required/,
      );
    } finally {
      cleanup();
    }
  });

  it('does not require repoDir in task mode because artifacts are global', () => {
    const registry = makeRegistry('gpt-4o', 'openai');
    const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', '/tmp/unused', { repoDir: undefined }));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'missing_artifact');
    assert.equal(decision.artifactScope, 'global');
  });

  it('maps missing artifacts to missing_artifact with a resolved path', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'missing_artifact');
      assert.match(decision.artifactPath ?? '', /global-certifications\/openai\/gpt-4o\/v1\.json$/);
    } finally {
      cleanup();
    }
  });

  it('maps malformed artifacts to malformed_artifact', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const path = buildGlobalCertificationPath('openai', 'gpt-4o', 'v1');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'not json', 'utf8');

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'malformed_artifact');
    } finally {
      cleanup();
    }
  });

  it('rejects wrong suite before staleness', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai', 'v1');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        suiteVersion: 'v0',
        certifiedAt: new Date(FIXED_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'wrong_suite');
      assert.equal(decision.foundSuiteVersion, 'v0');
    } finally {
      cleanup();
    }
  });

  it('rejects stale artifacts at the TTL boundary', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'stale_artifact');
    } finally {
      cleanup();
    }
  });

  it('rejects insufficient phases', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { phase: 'read-only' });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, { requiredPhase: 'workflow' }));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'insufficient_phase');
      assert.equal(decision.foundPhase, 'read-only');
    } finally {
      cleanup();
    }
  });

  it('treats scenario failures as insufficient phase readiness', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        scenarios: [{ scenarioId: 's1', passed: false, failureMessage: 'boom' }],
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'insufficient_phase');
    } finally {
      cleanup();
    }
  });

  it('returns ready decisions with the loaded artifact for certified task-mode models', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const path = writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { phase: 'patch' });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, true);
      assert.equal(decision.certified, true);
      assert.equal(decision.nativeProvider, 'openai');
      assert.equal(decision.storagePath, path);
      assert.equal(decision.artifact?.phase, 'patch');
    } finally {
      cleanup();
    }
  });

  it('uses certificationRoot over the ambient global root', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const explicitRoot = mkdtempSync(join(tmpdir(), 'eligibility-gate-explicit-'));
      const registry = makeRegistry('gpt-4o', 'openai');
      const path = writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { phase: 'patch' }, explicitRoot);

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, {
        certificationRoot: explicitRoot,
      }));

      assert.equal(decision.ok, true);
      assert.equal(decision.storagePath, path);
    } finally {
      cleanup();
    }
  });

  it('resolves openrouter aliases and raw IDs to the same storage identity', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const aliasRegistry = makeRegistry('glm-5.2', 'openrouter');
      const rawRegistry = aliasRegistry;
      const path = writeArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1');

      const aliasDecision = evaluateNativeProviderGate(taskInput(aliasRegistry, 'glm-5.2', repoDir));
      const rawDecision = evaluateNativeProviderGate(taskInput(rawRegistry, 'z-ai/glm-5.2', repoDir));

      assert.equal(aliasDecision.ok, true);
      assert.equal(rawDecision.ok, true);
      assert.equal(aliasDecision.storagePath, path);
      assert.equal(rawDecision.storagePath, path);
    } finally {
      cleanup();
    }
  });

  it('rejects artifacts whose on-disk identity does not match the resolved storage identity', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('glm-5.2', 'openrouter');
      writeArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1', {
        provider: 'openrouter',
        model: 'glm-5.2',
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'glm-5.2', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'identity_reidentified');
    } finally {
      cleanup();
    }
  });

  it('rejects missing registry suite metadata as wrong_suite', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      delete registry.models['gpt-4o']?.nativeCapability?.certification?.certificationSuiteVersion;

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'wrong_suite');
    } finally {
      cleanup();
    }
  });

  it('keeps fresh lower-bound artifacts ready before the TTL cutoff', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 59 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, true);
      assert.equal(decision.certified, true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// HOK-2943: live coding canary enforcement
// ---------------------------------------------------------------------------

describe('evaluateNativeProviderGate live coding canary', () => {
  const CANARY_RAN_AT = new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

  function freshCanary(overrides: Parameters<typeof buildLiveCodingCanaryFixture>[2] = {}) {
    return buildLiveCodingCanaryFixture(makeSubject('openai', 'gpt-4o'), 'v1', {
      ranAt: CANARY_RAN_AT,
      ...overrides,
    });
  }

  function codingInput(registry: ModelRegistry, repoDir: string, overrides: Partial<NativeGateInput> = {}): NativeGateInput {
    return taskInput(registry, 'gpt-4o', repoDir, { requiredPhase: 'patch', ...overrides });
  }

  it('grants coding eligibility for a fresh, live, identity-matching canary pass', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { liveCanary: freshCanary() });

      const decision = evaluateNativeProviderGate(codingInput(registry, repoDir));
      assert.equal(decision.ok, true);
    } finally {
      cleanup();
    }
  });

  it('rejects coding without a canary even when deterministic scenarios pass', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1');

      const decision = evaluateNativeProviderGate(codingInput(registry, repoDir));
      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'missing_live_canary');

      // The same artifact still grants non-coding phases.
      const planner = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, { requiredPhase: 'workflow' }));
      assert.equal(planner.ok, true);
    } finally {
      cleanup();
    }
  });

  it('honors an explicit coding launchPhase over phase inference', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1');

      const explicitCoding = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, {
        requiredPhase: 'workflow',
        launchPhase: 'coding',
      }));
      assert.equal(explicitCoding.ok, false);
      assert.equal(explicitCoding.reason, 'missing_live_canary');

      const explicitPlanning = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, {
        requiredPhase: 'patch',
        launchPhase: 'planning',
      }));
      assert.equal(explicitPlanning.ok, true, 'explicit non-coding launch phase skips the canary requirement');
    } finally {
      cleanup();
    }
  });

  it('rejects skipped, failed, and inconclusive canaries with distinct reasons', () => {
    const cases = [
      { overrides: { status: 'skipped' as const, reason: 'provider_config_error' as const }, expected: 'missing_live_canary' },
      { overrides: { status: 'fail' as const, reason: 'protocol_failure' as const }, expected: 'failed_live_canary' },
      { overrides: { status: 'inconclusive' as const, reason: 'provider_transient_error' as const }, expected: 'inconclusive_live_canary' },
    ];
    for (const testCase of cases) {
      const { repoDir, cleanup } = makeRepo();
      try {
        const registry = makeRegistry('gpt-4o', 'openai');
        writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { liveCanary: freshCanary(testCase.overrides) });

        const decision = evaluateNativeProviderGate(codingInput(registry, repoDir));
        assert.equal(decision.ok, false);
        assert.equal(decision.reason, testCase.expected);
        if (testCase.expected !== 'missing_live_canary') {
          assert.equal(decision.liveCanaryStatus, testCase.overrides.status);
        }
      } finally {
        cleanup();
      }
    }
  });

  it('rejects a non-live canary pass (dry-run/injected evidence can never satisfy the gate)', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { liveCanary: freshCanary({ isLive: false }) });

      const decision = evaluateNativeProviderGate(codingInput(registry, repoDir));
      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'non_live_canary');
    } finally {
      cleanup();
    }
  });

  it('enforces the freshness boundary: valid strictly before expiry, invalid at expiry', () => {
    const expiresAt = FIXED_NOW.toISOString();
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { liveCanary: freshCanary({ expiresAt }) });

      const justBefore = evaluateNativeProviderGate(codingInput(registry, repoDir, {
        now: new Date(FIXED_NOW.getTime() - 1),
      }));
      assert.equal(justBefore.ok, true, 'canary is valid immediately before expiry');

      const atExpiry = evaluateNativeProviderGate(codingInput(registry, repoDir, { now: FIXED_NOW }));
      assert.equal(atExpiry.ok, false, 'canary is invalid at expiry');
      assert.equal(atExpiry.reason, 'stale_live_canary');
    } finally {
      cleanup();
    }
  });

  it('rejects canary identity mismatches across provider, model, resolved id, suite, and fingerprint', () => {
    const mismatches: Array<Record<string, unknown>> = [
      { provider: 'other-provider' },
      { model: 'other-model' },
      { providerNativeId: 'other/native-id' },
      { suiteVersion: 'v0' },
      { identityFingerprint: 'tampered-fingerprint' },
      { catalogHash: 'tampered-catalog' },
    ];
    for (const mismatch of mismatches) {
      const { repoDir, cleanup } = makeRepo();
      try {
        const registry = makeRegistry('gpt-4o', 'openai');
        writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
          liveCanary: { ...freshCanary(), ...mismatch },
        });

        const decision = evaluateNativeProviderGate(codingInput(registry, repoDir));
        assert.equal(decision.ok, false, `mismatch ${JSON.stringify(mismatch)} must reject`);
        assert.equal(decision.reason, 'live_canary_identity_mismatch');
      } finally {
        cleanup();
      }
    }
  });
});
