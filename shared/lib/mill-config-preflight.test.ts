import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { formatCanaryCohortReport, formatMillConfigPreflightReport, runMillConfigPreflight } from './mill-config-preflight.ts';
import { REMOVED_MODEL_SETTING_PATHS } from './model-settings-migrator.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import { resolveCertificationSubject } from './native-agent/certification/identity.ts';
import { CERTIFICATION_SCHEMA_VERSION, type NativeCertificationArtifact } from './native-agent/certification/schema.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';
import type { ModelRegistry } from './model-registry.ts';
import type { CertifyAllResult, CertifySelectedOptions } from '../../tools/native-agent-certify.ts';

function makeRepo(config: unknown): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'mill-config-preflight-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2));
  return repoDir;
}

function cleanup(repoDir: string): void {
  clearConfigCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

async function withCertificationRoot<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'mill-preflight-cert-root-'));
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  const previousSkip = process.env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD;
  const previousAutoSkip = process.env.WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE;
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = root;
  delete process.env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD;
  delete process.env.WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE;
  try {
    return await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    else process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
    if (previousSkip === undefined) delete process.env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD;
    else process.env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD = previousSkip;
    if (previousAutoSkip === undefined) delete process.env.WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE;
    else process.env.WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE = previousAutoSkip;
    rmSync(root, { recursive: true, force: true });
  }
}

function makeRegistry(requiredSuiteVersion = 'v3'): ModelRegistry {
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
            maxCertifiedPhase: 'workflow',
            certifiedAt: '2026-08-01T00:00:00.000Z',
            certificationSuiteVersion: requiredSuiteVersion,
          },
        },
      },
    },
    ladders: {},
  };
}

function makeArtifact(registry: ModelRegistry, overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  const subject = resolveCertificationSubject({ provider: 'openai', model: 'gpt-4o', registry });
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: subject.subject,
    provider: subject.storageIdentity.provider,
    model: subject.storageIdentity.model,
    phase: 'workflow',
    suiteVersion: 'v3',
    certifiedAt: '2026-08-24T00:00:00.000Z',
    scenarios: [{ scenarioId: 'workflow.run', passed: true }],
    ...overrides,
  };
}

function writeArtifact(root: string, artifact: NativeCertificationArtifact): void {
  const path = buildGlobalCertificationPath(artifact.provider, artifact.model, artifact.suiteVersion, { root });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

function certifyResult(opts: CertifySelectedOptions): CertifyAllResult {
  return {
    phase: 'workflow',
    suiteVersion: 'v3',
    dryRun: false,
    published: opts.targets.map((target) => ({ ...target, artifactPath: `/tmp/${target.model}.json` })),
    skipped: [],
    failed: [],
  };
}

function legacyConfigWithEveryRemovedField(): Record<string, unknown> {
  return {
    modelRegistry: {
      models: { 'legacy-model': { provider: 'openrouter' } },
      ladders: { coder: ['legacy-model'] },
    },
    router: {
      enabled: true,
      defaultAgent: 'claude',
      defaultModel: 'legacy-model',
      models: ['legacy-model'],
      availableModels: { coder: ['legacy-model'] },
      agentMap: { 'legacy-model': 'native-openrouter' },
    },
    challenge: {
      enabled: true,
      models: ['legacy-model'],
      comparisonModel: 'legacy-judge',
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: ['legacy-model'],
        stages: ['coder'],
      },
      deepseek: {
        enabled: true,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-legacy'],
        stages: ['coder'],
      },
    },
    nativeAgent: {
      providers: {
        openai: {
          enabled: true,
          apiKeyEnv: 'OPENAI_API_KEY',
          models: ['gpt-legacy'],
        },
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          models: ['openrouter/legacy'],
        },
      },
    },
  };
}

test('runMillConfigPreflight rejects every removed HOK-2587 model field', async () => {
  const repoDir = makeRepo(legacyConfigWithEveryRemovedField());
  try {
    const result = await runMillConfigPreflight(repoDir);
    assert.equal(result.ok, false);
    assert.equal(result.report.removedFields.length, REMOVED_MODEL_SETTING_PATHS.length);
    assert.deepEqual(
      result.report.removedFields.map((entry) => entry.path).sort(),
      [...REMOVED_MODEL_SETTING_PATHS].sort(),
    );
    assert.match(result.report.validationError ?? '', /wavemill config migrate-model-settings/);
  } finally {
    cleanup(repoDir);
  }
});

test('runMillConfigPreflight accepts clean config', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const artifact = makeArtifact(registry);
    writeArtifact(root, artifact);
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
      nativeAgent: { certification: { autoRemediate: false } },
    });
    try {
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
      });
      assert.equal(result.ok, true);
      assert.equal(result.report.removedFields.length, 0);
      assert.equal(result.report.validationError, null);
      assert.equal(result.report.certificationCoverage?.status, 'ok');
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight reports only present legacy fields', async () => {
  const repoDir = makeRepo({
    router: {
      enabled: true,
      defaultAgent: 'claude',
      defaultModel: 'legacy-model',
    },
  });
  try {
    const result = await runMillConfigPreflight(repoDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.report.removedFields.map((entry) => entry.path), ['router.defaultModel']);
  } finally {
    cleanup(repoDir);
  }
});

test('runMillConfigPreflight rejects suite bump without current artifacts', async () => {
  await withCertificationRoot(async (root) => {
    const oldPath = join(root, 'openai', 'gpt-4o', 'v2.json');
    mkdirSync(join(root, 'openai', 'gpt-4o'), { recursive: true });
    writeFileSync(oldPath, '{}');
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
      nativeAgent: { certification: { autoRemediate: false } },
    });
    try {
      const result = await runMillConfigPreflight(repoDir);
      assert.equal(result.ok, false);
      assert.equal(result.report.certificationCoverage?.status, 'bump-without-publish');
      assert.match(result.report.certificationCoverage?.remediationCommand ?? '', /certify --all/);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight honors certification coverage guard skip', async () => {
  await withCertificationRoot(async (root) => {
    mkdirSync(join(root, 'openai', 'gpt-4o'), { recursive: true });
    writeFileSync(join(root, 'openai', 'gpt-4o', 'v2.json'), '{}');
    process.env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD = '1';
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    try {
      const result = await runMillConfigPreflight(repoDir);
      assert.equal(result.ok, true);
      assert.equal(result.report.certificationCoverage, undefined);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight auto-remediates identity drift before blocking startup', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const drifted = makeArtifact(registry);
    drifted.subject = { ...drifted.subject, catalogHash: 'old-fixture-hash' };
    writeArtifact(root, drifted);
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    try {
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        attemptCachePath: join(root, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => {
          writeArtifact(root, makeArtifact(registry, { certifiedAt: '2026-08-31T00:00:00.000Z' }));
          return certifyResult(opts);
        },
        now: () => new Date('2026-08-31T12:00:00.000Z'),
      });
      assert.equal(result.ok, true);
      assert.equal(result.report.certificationCoverage?.status, 'ok');
      assert.equal(result.report.certificationRemediation?.mode, 'republish-matrix');
      assert.equal(result.report.certificationRemediation?.attempted, true);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight blocks clearly when auto-remediation fails', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const drifted = makeArtifact(registry);
    drifted.subject = { ...drifted.subject, catalogHash: 'old-fixture-hash' };
    writeArtifact(root, drifted);
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    try {
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        attemptCachePath: join(root, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => ({
          ...certifyResult(opts),
          published: [],
          failed: opts.targets.map((target) => ({ ...target, reason: 'fixture failure' })),
        }),
        now: () => new Date('2026-08-31T12:00:00.000Z'),
      });
      assert.equal(result.ok, false);
      assert.equal(result.report.certificationCoverage?.status, 'identity-drift');
      assert.equal(result.report.certificationRemediation?.failed[0]?.reason, 'fixture failure');
      const formatted = formatMillConfigPreflightReport(result.report);
      assert.match(formatted, /Native certification identity drift/);
      assert.match(formatted, /Native certification auto-remediation/);
      assert.match(formatted, /failed: openai\/gpt-4o - fixture failure/);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight renews near-expiry artifacts without failing preflight', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    writeArtifact(root, makeArtifact(registry));
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    try {
      let observedTargets: string[] = [];
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        attemptCachePath: join(root, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => {
          observedTargets = opts.targets.map((target) => target.model);
          writeArtifact(root, makeArtifact(registry, { certifiedAt: '2026-08-31T00:00:00.000Z' }));
          return certifyResult(opts);
        },
        now: () => new Date('2026-10-22T00:00:00.000Z'),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(observedTargets, ['gpt-4o']);
      assert.equal(result.report.certificationRemediation?.mode, 'renewal');
      assert.equal(result.report.certificationCoverage?.status, 'ok');
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight honors auto-remediation env opt-out', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const drifted = makeArtifact(registry);
    drifted.subject = { ...drifted.subject, catalogHash: 'old-fixture-hash' };
    writeArtifact(root, drifted);
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    try {
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        env: { WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE: '1' },
        certifyFn: async () => {
          throw new Error('should not be called');
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.report.certificationCoverage?.status, 'identity-drift');
      assert.equal(result.report.certificationRemediation, undefined);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight skips auto-remediation during mill dry-runs', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    try {
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        env: { WAVEMILL_DRY_RUN: '1' },
        certifyFn: async () => {
          throw new Error('should not be called');
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.report.certificationCoverage?.status, 'empty-store');
      assert.equal(result.report.certificationRemediation, undefined);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight honors config auto-remediation opt-out', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const drifted = makeArtifact(registry);
    drifted.subject = { ...drifted.subject, catalogHash: 'old-fixture-hash' };
    writeArtifact(root, drifted);
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
      nativeAgent: { certification: { autoRemediate: false } },
    });
    try {
      const result = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        certifyFn: async () => {
          throw new Error('should not be called');
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.report.certificationCoverage?.status, 'identity-drift');
      assert.equal(result.report.certificationRemediation, undefined);
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight loop guard prevents repeated failing remediation', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    const drifted = makeArtifact(registry);
    drifted.subject = { ...drifted.subject, catalogHash: 'old-fixture-hash' };
    writeArtifact(root, drifted);
    const repoDir = makeRepo({
      router: { enabled: true, defaultAgent: 'claude' },
      observer: { enabled: false },
    });
    const attemptCachePath = join(root, 'attempts.json');
    let calls = 0;
    try {
      const first = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        attemptCachePath,
        certifyFn: async (opts: CertifySelectedOptions) => {
          calls += 1;
          return {
            ...certifyResult(opts),
            published: [],
            failed: opts.targets.map((target) => ({ ...target, reason: 'fixture failure' })),
          };
        },
      });
      assert.equal(first.ok, false);

      const second = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        attemptCachePath,
        certifyFn: async () => {
          calls += 1;
          throw new Error('should not be called twice');
        },
      });
      assert.equal(second.ok, false);
      assert.equal(calls, 1);
      assert.equal(second.report.certificationRemediation?.mode, 'blocked-by-loop-guard');
    } finally {
      cleanup(repoDir);
    }
  });
});

test('runMillConfigPreflight runs one bounded canary-cohort refresh and surfaces health', async () => {
  const registry = makeRegistry();
  await withCertificationRoot(async (root) => {
    // Deterministic coverage is healthy; only the live canary is missing.
    writeArtifact(root, makeArtifact(registry, {
      certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }));
    const repoDir = makeRepo({
      nativeAgent: {
        certification: {
          canaryCohort: [{ provider: 'openai', model: 'gpt-4o' }],
          minCodingReady: 1,
        },
        providers: { openai: { apiKeyEnv: 'COHORT_PREFLIGHT_TEST_KEY' } },
      },
    });
    const canaryAttemptCachePath = join(root, 'canary-attempts.json');
    try {
      let canaryCalls = 0;
      const canaryCertifyFn = (async (opts: { liveCodingCanary?: boolean }) => {
        canaryCalls += 1;
        assert.equal(opts.liveCodingCanary, true);
        return {
          harnessPassed: true,
          codingEligible: false,
          liveCanary: { status: 'inconclusive' as const, reason: 'provider_transient_error' },
        };
      }) as never;

      const first = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        canaryAttemptCachePath,
        canaryCertifyFn,
        env: { COHORT_PREFLIGHT_TEST_KEY: 'test-key' },
      });
      assert.equal(first.ok, true, 'below-minimum cohort alerts but never blocks preflight');
      assert.equal(canaryCalls, 1);
      assert.equal(first.report.canaryCohortRefresh?.attempted, 1);
      assert.equal(first.report.canaryCohortHealth?.belowMinimum, true);
      assert.equal(first.report.canaryCohortHealth?.codingReadyCount, 0);
      assert.match(
        formatCanaryCohortReport(first.report),
        /ALERT: coding-ready cohort \(0\) is below the configured minimum \(1\)/,
      );

      // Same remediation episode: no second provider spend.
      const second = await runMillConfigPreflight(repoDir, {
        registry,
        certificationRoot: root,
        canaryAttemptCachePath,
        canaryCertifyFn,
        env: { COHORT_PREFLIGHT_TEST_KEY: 'test-key' },
      });
      assert.equal(canaryCalls, 1);
      assert.equal(second.report.canaryCohortRefresh?.attempted, 0);
      const skipReason = second.report.canaryCohortRefresh?.outcomes[0]?.reason ?? '';
      assert.match(skipReason, /already attempted this episode/);
    } finally {
      cleanup(repoDir);
    }
  });
});
