import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../../model-registry.ts';
import type { CertifyAllResult, CertifySelectedOptions } from '../../../../tools/native-agent-certify.ts';
import { runCertificationAutoRemediation } from './auto-remediate.ts';
import type { SuiteCoverageResult } from './coverage.ts';

function registry(): ModelRegistry {
  const nativeModel = {
    vendor: 'OpenRouter',
    class: 'strong_generalist' as const,
    strengths: [],
    weaknesses: [],
    qualityScores: { routing: 70, planning: 70, coding: 70, review: 70, classify: 70 },
    contextWindowTokens: 128_000,
    toolSupport: { functionCalling: true, streamingTools: true },
    multimodal: { text: true, image: false },
    latencyTier: 'standard' as const,
    reasoningTier: 'standard' as const,
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 2,
    nativeCapability: {
      nativeProvider: 'openrouter' as const,
      piTransportKind: 'openai-responses' as const,
      readOnlyNative: 'certified' as const,
      certification: {
        maxCertifiedPhase: 'workflow' as const,
        certifiedAt: '2026-08-01T00:00:00.000Z',
        certificationSuiteVersion: 'v3',
      },
    },
  };
  return {
    models: {
      'qwen-3-coder': nativeModel,
      'ox-alpha': {
        ...nativeModel,
        identity: {
          status: 'provisional' as const,
          revision: 1,
          fingerprint: 'provisional-ox-alpha',
          displayName: 'ox-alpha',
          family: 'unknown' as const,
          evidencePolicy: 'held' as const,
        },
      },
    },
    ladders: {},
  };
}

function coverage(overrides: Partial<SuiteCoverageResult> = {}): SuiteCoverageResult {
  return {
    requiredSuiteVersion: 'v3',
    nativeModelCount: 1,
    artifactCountForRequiredSuite: 1,
    artifactCountByOtherSuite: {},
    status: 'identity-drift',
    remediationCommand: 'wavemill native-agent certify --all --phase workflow',
    root: '/tmp/test-certs',
    ineligibleModels: [{ registryKey: 'qwen-3-coder', reason: 'identity-reidentified' }],
    eligibleModelCount: 0,
    identityDriftCount: 1,
    staleCount: 0,
    staleModels: [],
    renewalDueCount: 0,
    modelsInRenewalWindow: [],
    orphanArtifacts: [],
    ...overrides,
  };
}

function makeCertifyResult(opts: {
  targets: Array<{ provider: string; model: string }>;
  failed?: string[];
  skipped?: string[];
}): CertifyAllResult {
  const failed = new Set(opts.failed ?? []);
  const skipped = new Set(opts.skipped ?? []);
  return {
    phase: 'workflow',
    suiteVersion: 'v3',
    dryRun: false,
    published: opts.targets
      .filter((target) => !failed.has(target.model) && !skipped.has(target.model))
      .map((target) => ({ ...target, artifactPath: `/tmp/${target.model}.json` })),
    failed: opts.targets
      .filter((target) => failed.has(target.model))
      .map((target) => ({ ...target, reason: 'fixture failure' })),
    skipped: opts.targets
      .filter((target) => skipped.has(target.model))
      .map((target) => ({ ...target, reason: 'not live-certifiable' })),
  };
}

describe('runCertificationAutoRemediation', () => {
  it('republishes the deterministic matrix and records success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-'));
    try {
      const cachePath = join(dir, 'attempts.json');
      let calls = 0;
      const result = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn: async (opts: CertifySelectedOptions) => {
          calls += 1;
          return makeCertifyResult({ targets: opts.targets });
        },
        now: () => new Date('2026-08-31T00:00:00.000Z'),
      });

      assert.equal(calls, 1);
      assert.equal(result.attempted, true);
      assert.equal(result.mode, 'republish-matrix');
      assert.deepEqual(result.targets, ['qwen-3-coder']);
      assert.deepEqual(result.published, ['openrouter/qwen-3-coder']);
      const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as { attempts: Record<string, { outcome: string }> };
      assert.equal(cache.attempts[result.attemptKey]?.outcome, 'success');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let a prior success suppress a later required remediation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-repeat-success-'));
    try {
      const cachePath = join(dir, 'attempts.json');
      let calls = 0;
      const certifyFn = async (opts: CertifySelectedOptions): Promise<CertifyAllResult> => {
        calls += 1;
        return makeCertifyResult({ targets: opts.targets });
      };

      const first = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn,
        processToken: 'process-one',
      });
      const second = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn,
        processToken: 'process-two',
      });

      assert.equal(first.attempted, true);
      assert.equal(second.attempted, true);
      assert.equal(second.mode, 'republish-matrix');
      assert.equal(calls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not repeat a successful remediation in the same process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-same-process-success-'));
    try {
      const cachePath = join(dir, 'attempts.json');
      let calls = 0;
      const certifyFn = async (opts: CertifySelectedOptions): Promise<CertifyAllResult> => {
        calls += 1;
        return makeCertifyResult({ targets: opts.targets });
      };

      await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn,
        processToken: 'same-process',
      });
      const second = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn,
        processToken: 'same-process',
      });

      assert.equal(calls, 1);
      assert.equal(second.attempted, false);
      assert.equal(second.mode, 'noop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records one failure and blocks the next matching attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-loop-'));
    try {
      const cachePath = join(dir, 'attempts.json');
      let calls = 0;
      const first = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn: async (opts: CertifySelectedOptions) => {
          calls += 1;
          return makeCertifyResult({ targets: opts.targets, failed: ['qwen-3-coder'] });
        },
      });
      assert.equal(first.attempted, true);
      assert.equal(first.failed.length, 1);

      const second = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: cachePath,
        certifyFn: async (opts: CertifySelectedOptions) => {
          calls += 1;
          return makeCertifyResult({ targets: opts.targets });
        },
      });

      assert.equal(calls, 1);
      assert.equal(second.attempted, false);
      assert.equal(second.mode, 'blocked-by-loop-guard');
      assert.match(second.failed[0]?.reason ?? '', /already failed once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes provisional identities from automatic targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-provisional-'));
    try {
      let observedTargets: string[] = [];
      await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        attemptCachePath: join(dir, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => {
          observedTargets = opts.targets.map((target) => target.model);
          return makeCertifyResult({ targets: opts.targets });
        },
      });
      assert.deepEqual(observedTargets, ['qwen-3-coder']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips live-smoke consent from the certifier environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-env-'));
    try {
      let receivedEnv: NodeJS.ProcessEnv | undefined;
      await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage(),
        env: { OPENROUTER_LIVE_SMOKE: '1', OPENROUTER_API_KEY: 'present' },
        attemptCachePath: join(dir, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => {
          receivedEnv = opts.env;
          return makeCertifyResult({ targets: opts.targets });
        },
      });
      assert.equal(receivedEnv?.OPENROUTER_LIVE_SMOKE, undefined);
      assert.equal(receivedEnv?.OPENROUTER_API_KEY, 'present');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renews only models inside the renewal window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-renewal-'));
    try {
      let observedTargets: string[] = [];
      const result = await runCertificationAutoRemediation({
        registry: registry(),
        repoDir: process.cwd(),
        coverage: coverage({
          status: 'ok',
          ineligibleModels: [],
          eligibleModelCount: 1,
          identityDriftCount: 0,
          renewalDueCount: 1,
          modelsInRenewalWindow: [{ registryKey: 'qwen-3-coder', expiresAt: '2026-09-01T00:00:00.000Z' }],
        }),
        attemptCachePath: join(dir, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => {
          observedTargets = opts.targets.map((target) => target.model);
          return makeCertifyResult({ targets: opts.targets });
        },
      });
      assert.equal(result.mode, 'renewal');
      assert.deepEqual(observedTargets, ['qwen-3-coder']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-certifies only the models that re-identified below the fleet drift threshold (HOK-3159)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cert-auto-reidentify-'));
    const base = registry();
    const multi: ModelRegistry = {
      ...base,
      models: { ...base.models, 'glm-5.3': base.models['qwen-3-coder']!, 'kimi-k2': base.models['qwen-3-coder']! },
    };
    try {
      let observedTargets: string[] = [];
      const result = await runCertificationAutoRemediation({
        registry: multi,
        repoDir: process.cwd(),
        coverage: coverage({
          // One row edit re-identifies one model: far below the threshold that
          // flips status to identity-drift, but still uncertified until renewed.
          status: 'ok',
          ineligibleModels: [{ registryKey: 'qwen-3-coder', reason: 'identity-reidentified', cause: 'launch-priority-catalog' }],
          eligibleModelCount: 2,
          identityDriftCount: 1,
          renewalDueCount: 1,
          modelsInRenewalWindow: [{ registryKey: 'kimi-k2', expiresAt: '2026-09-01T00:00:00.000Z' }],
        }),
        attemptCachePath: join(dir, 'attempts.json'),
        certifyFn: async (opts: CertifySelectedOptions) => {
          observedTargets = opts.targets.map((target) => target.model);
          return makeCertifyResult({ targets: opts.targets });
        },
      });
      assert.equal(result.mode, 'reidentify');
      assert.deepEqual(observedTargets, ['kimi-k2', 'qwen-3-coder'], 'drifted model plus renewals, not the fleet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('noops when the registry has no native targets', async () => {
    const result = await runCertificationAutoRemediation({
      registry: { models: {}, ladders: {} },
      repoDir: process.cwd(),
      coverage: coverage({ status: 'empty-store' }),
      certifyFn: async () => {
        throw new Error('should not be called');
      },
    });
    assert.equal(result.mode, 'noop');
    assert.equal(result.attempted, false);
  });
});
