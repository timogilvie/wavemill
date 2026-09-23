import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { certifyAllNativeAgents, certifyNativeAgent, refreshCanaryCohort, renderCanaryStatusLine } from './native-agent-certify.ts';
import type { HarnessReport, HarnessScenarioResult } from '../shared/lib/native-agent/certification/scenario-runner.ts';
import { CERTIFICATION_SCHEMA_VERSION, type NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import { buildLiveCodingCanaryFixture } from '../shared/lib/native-agent/certification/canary-fixtures.ts';
import { resolveCertificationSubject } from '../shared/lib/native-agent/certification/identity.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from '../shared/lib/native-agent/certification/scenarios.ts';
import { computeIdentityFingerprint, type ModelRegistry } from '../shared/lib/model-registry.ts';

const OPENROUTER_STORAGE_CASES = [
  {
    rawId: 'qwen/qwen3-coder',
    alias: 'qwen-3-coder',
    providerPath: 'qwen',
    modelPath: 'qwen3-coder',
    vendor: 'qwen',
    modelClass: 'strong_generalist' as const,
    qualityScores: { routing: 60, planning: 72, coding: 84, review: 78, classify: 58 },
    contextWindowTokens: 131_072,
    costPerMillionInputTokensUsd: 0.35,
    costPerMillionOutputTokensUsd: 1.05,
  },
  {
    rawId: 'z-ai/glm-5.2',
    alias: 'glm-5.2',
    providerPath: 'z-ai',
    modelPath: 'glm-5.2',
    vendor: 'z-ai',
    modelClass: 'frontier' as const,
    qualityScores: { routing: 62, planning: 80, coding: 80, review: 84, classify: 60 },
    contextWindowTokens: 1_048_576,
    costPerMillionInputTokensUsd: 0.93,
    costPerMillionOutputTokensUsd: 3,
  },
  {
    rawId: 'moonshotai/kimi-k2.7-code',
    alias: 'kimi-k2.7-code',
    providerPath: 'moonshotai',
    modelPath: 'kimi-k2.7-code',
    vendor: 'kimi',
    modelClass: 'strong_generalist' as const,
    qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
    contextWindowTokens: 262_144,
    costPerMillionInputTokensUsd: 0.74,
    costPerMillionOutputTokensUsd: 3.5,
  },
] as const;

// ---------------------------------------------------------------------------
// Minimal stub registry with one certified model
// ---------------------------------------------------------------------------

const STUB_REGISTRY: ModelRegistry = {
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
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
    'qwen-3-coder': {
      vendor: 'qwen',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 60, planning: 72, coding: 84, review: 78, classify: 58 },
      contextWindowTokens: 131_072,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.35,
      costPerMillionOutputTokensUsd: 1.05,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
    'ox-alpha': {
      vendor: 'unknown',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: ['provisional stealth identity'],
      qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
      contextWindowTokens: 1_048_576,
      toolSupport: 'basic',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0,
      costPerMillionOutputTokensUsd: 0,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
      },
      supportedModel: {
        wavemillAlias: 'ox-alpha',
        providerNativeId: 'stealth/ox-alpha',
        provider: 'openrouter',
        transport: 'openai-completions',
        stages: ['planning', 'coding', 'review'],
        requiredCertificationPhaseByStage: {
          planning: 'workflow',
          coding: 'patch',
          review: 'read-only',
        },
        certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        certificationFreshnessDays: 60,
        canonicalArtifactIdentity: {
          provider: 'stealth',
          model: 'ox-alpha',
          suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
        lifecycle: 'supported',
        compatibilityFlags: { thinkingFormat: 'openrouter' },
        launchEligible: true,
        routingEligible: false,
      },
      identity: {
        status: 'provisional',
        revision: 1,
        fingerprint: computeIdentityFingerprint({
          alias: 'ox-alpha',
          providerNativeId: 'stealth/ox-alpha',
          provider: 'openrouter',
          revision: 1,
        }),
        displayName: 'Ox Alpha',
        family: 'unknown',
        evidencePolicy: 'held',
        verification: {
          source: 'test',
          observedAt: '2026-08-22T15:22:39.700Z',
          catalogHash: 'test-catalog-hash',
        },
      },
    },
    'glm-5.2': {
      vendor: 'z-ai',
      class: 'frontier',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 62, planning: 80, coding: 80, review: 84, classify: 60 },
      contextWindowTokens: 1_048_576,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.93,
      costPerMillionOutputTokensUsd: 3,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
    'kimi-k2.7-code': {
      vendor: 'kimi',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
      contextWindowTokens: 262_144,
      toolSupport: 'basic',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.74,
      costPerMillionOutputTokensUsd: 3.5,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
  },
  ladders: {},
};

const PASSING_REPORT: HarnessReport = {
  provider: 'openai',
  model: 'gpt-4o',
  transport: 'openai-responses',
  results: [
    {
      scenarioId: 's1',
      category: 'tool',
      classification: 'deterministic',
      phase: 'read-only',
      status: 'pass',
      durationMs: 1,
    } as HarnessScenarioResult,
  ],
  countsByStatus: { pass: 1, fail: 0, unsupported: 0, 'not-run': 0 },
  countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
  knownLimitations: [],
  harnessPassed: true,
  liveCertifiable: true,
  dryRun: false,
};

const FAILING_REPORT: HarnessReport = {
  ...PASSING_REPORT,
  results: [
    {
      scenarioId: 's1',
      category: 'tool',
      classification: 'deterministic',
      phase: 'read-only',
      status: 'fail',
      detail: 'assertion failed',
      durationMs: 1,
    } as HarnessScenarioResult,
  ],
  countsByStatus: { pass: 0, fail: 1, unsupported: 0, 'not-run': 0 },
  harnessPassed: false,
  liveCertifiable: false,
};

describe('certifyNativeAgent', () => {
  it('dry-run does not persist an artifact', async () => {
    let writeCalls = 0;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: true,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({ ...PASSING_REPORT, dryRun: true, liveCertifiable: false }),
      writeCertificationFn: () => { writeCalls++; return '/repo/cert.json'; },
    });

    assert.equal(writeCalls, 0, 'writeCertification must not be called in dry-run');
    assert.equal(result.dryRun, true);
    assert.equal(result.artifactPath, undefined);
    assert.equal(result.harnessPassed, true);
  });

  it('live success writes the artifact and returns path', async () => {
    let written: NativeCertificationArtifact | undefined;
    const FIXED_NOW = new Date('2026-03-01T00:00:00.000Z');

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => PASSING_REPORT,
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
      now: () => FIXED_NOW,
    });

    assert.ok(result.artifactPath, 'artifactPath should be set');
    assert.ok(written, 'artifact should have been written');
    assert.equal(written.provider, 'openai');
    assert.equal(written.model, 'gpt-4o');
    assert.equal(written.phase, 'read-only');
    assert.equal(written.certifiedAt, FIXED_NOW.toISOString());
    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, true);
  });

  it('requires live smoke before publishing a provisional OpenRouter artifact', async () => {
    let writeCalls = 0;
    let smokeCalls = 0;

    await assert.rejects(
      () => certifyNativeAgent({
        provider: 'openrouter',
        model: 'ox-alpha',
        phase: 'workflow',
        repoDir: '/repo',
        registry: STUB_REGISTRY,
        runScenariosFn: async () => ({
          ...PASSING_REPORT,
          provider: 'openrouter',
          model: 'ox-alpha',
          transport: 'openai-completions',
          results: [
            {
              scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
              category: 'phase',
              classification: 'deterministic',
              phase: 'workflow',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
        }),
        runOpenRouterSmokeFn: async () => {
          smokeCalls++;
          return [];
        },
        writeCertificationFn: () => {
          writeCalls++;
          return '/repo/cert.json';
        },
        env: {},
      }),
      /OPENROUTER_LIVE_SMOKE=1/,
    );

    assert.equal(smokeCalls, 0, 'smoke must not run without explicit consent');
    assert.equal(writeCalls, 0, 'artifact must not be written without live smoke evidence');
  });

  it('writes live smoke evidence for provisional OpenRouter artifacts', async () => {
    let written: NativeCertificationArtifact | undefined;
    const FIXED_NOW = new Date('2026-08-23T12:00:00.000Z');

    const result = await certifyNativeAgent({
      provider: 'openrouter',
      model: 'ox-alpha',
      phase: 'workflow',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({
        ...PASSING_REPORT,
        provider: 'openrouter',
        model: 'ox-alpha',
        transport: 'openai-completions',
        results: [
          {
            scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
            category: 'phase',
            classification: 'deterministic',
            phase: 'workflow',
            status: 'pass',
            durationMs: 1,
          } as HarnessScenarioResult,
        ],
        countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
      }),
      runOpenRouterSmokeFn: async (opts) => [{
        modelId: 'ox-alpha',
        family: 'unknown',
        status: 'ok',
        requestedWireId: opts.entries[0]!.openrouterId,
        providerReturnedModel: 'stealth/ox-alpha',
        catalogHash: opts.catalogHash ?? 'missing-catalog-hash',
        checkedAt: '2026-08-23T12:00:00.000Z',
        costUsd: null,
      }],
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/stealth/ox-alpha/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
      env: {
        OPENROUTER_LIVE_SMOKE: '1',
        OPENROUTER_API_KEY: 'sk-test',
      },
      now: () => FIXED_NOW,
    });

    assert.ok(written, 'artifact should have been written');
    assert.deepEqual(written.liveSmokeEvidence, {
      requestedWireId: 'stealth/ox-alpha',
      providerReturnedModel: 'stealth/ox-alpha',
      catalogHash: 'test-catalog-hash',
      succeededAt: '2026-08-23T12:00:00.000Z',
    });
    assert.equal(written.subject.providerNativeId, 'stealth/ox-alpha');
    assert.equal(result.liveSmokeEvidence?.catalogHash, 'test-catalog-hash');
    assert.equal(result.artifactPath, `/repo/.wavemill/native-agent-certifications/stealth/ox-alpha/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`);
  });

  it('harness failure does not write artifact', async () => {
    let writeCalls = 0;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => FAILING_REPORT,
      writeCertificationFn: () => { writeCalls++; return '/repo/cert.json'; },
    });

    assert.equal(writeCalls, 0, 'writeCertification must not be called when harness fails');
    assert.equal(result.harnessPassed, false);
    assert.equal(result.artifactPath, undefined);
  });

  it('certifies patch when the default catalog includes patch scenarios', async () => {
    let written: NativeCertificationArtifact | undefined;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'patch',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => {
        assert.equal(opts.scenarios.length > 0, true);
        assert.equal(opts.scenarios.some((scenario) => scenario.phase === 'patch'), true);
        return {
          ...PASSING_REPORT,
          results: [
            {
              scenarioId: 'patch.runtime.native-patch-application',
              category: 'tool',
              classification: 'deterministic',
              phase: 'patch',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
        };
      },
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
    });

    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, true);
    assert.equal(result.artifactPath, `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`);
    assert.ok(written, 'patch artifact should have been written');
    assert.equal(written.phase, 'patch');
    assert.equal(result.knownLimitations.some((limitation) => /no patch scenarios/.test(limitation)), false);
  });

  it('certifies workflow when the default catalog includes workflow scenarios', async () => {
    let written: NativeCertificationArtifact | undefined;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'workflow',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => {
        assert.equal(opts.scenarios.some((scenario) => scenario.phase === 'workflow'), true);
        return {
          ...PASSING_REPORT,
          results: [
            {
              scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
              category: 'phase',
              classification: 'deterministic',
              phase: 'workflow',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
        };
      },
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
    });

    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, true);
    assert.equal(result.artifactPath, `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`);
    assert.ok(written);
    assert.equal(written.phase, 'workflow');
    assert.equal(result.knownLimitations.some((limitation) => /no workflow scenarios/.test(limitation)), false);
  });

  it('throws for unsupported model', async () => {
    await assert.rejects(
      () => certifyNativeAgent({
        provider: 'openai',
        model: 'unknown-model',
        phase: 'read-only',
        repoDir: '/repo',
        registry: STUB_REGISTRY,
        runScenariosFn: async () => PASSING_REPORT,
        writeCertificationFn: () => '/repo/cert.json',
      }),
      /not supported for native certification/,
    );
  });

  it('includes scenario outcomes in the result', async () => {
    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: true,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({ ...PASSING_REPORT, dryRun: true, liveCertifiable: false }),
      writeCertificationFn: () => '/repo/cert.json',
    });

    assert.equal(result.scenarios.length, 1);
    assert.equal(result.scenarios[0].scenarioId, 's1');
    assert.equal(result.scenarios[0].status, 'pass');
  });

  for (const testCase of OPENROUTER_STORAGE_CASES) {
    it(`resolves raw OpenRouter id ${testCase.rawId} through registry metadata and writes storage identity`, async () => {
      let written: NativeCertificationArtifact | undefined;
      const expectedArtifactPath = `/repo/.wavemill/native-agent-certifications/${testCase.providerPath}/${testCase.modelPath}/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;

      const result = await certifyNativeAgent({
        provider: 'openrouter',
        model: testCase.rawId,
        phase: 'workflow',
        repoDir: '/repo',
        registry: STUB_REGISTRY,
        runScenariosFn: async () => ({
          ...PASSING_REPORT,
          provider: 'openrouter',
          model: testCase.rawId,
          transport: 'openai-completions',
          results: [
            {
              scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
              category: 'phase',
              classification: 'deterministic',
              phase: 'workflow',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
        }),
        writeCertificationFn: (_repoDir, artifact) => {
          written = artifact;
          return expectedArtifactPath;
        },
      });

      assert.equal(result.model, testCase.rawId);
      assert.equal(result.artifactPath, expectedArtifactPath);
      assert.ok(written, 'artifact should have been written');
      assert.equal(written.provider, testCase.providerPath);
      assert.equal(written.model, testCase.modelPath);
      assert.equal(written.phase, 'workflow');
    });
  }

  it('omits not-run live-judge scenarios from persisted artifacts', async () => {
    let written: NativeCertificationArtifact | undefined;

    await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({
        ...PASSING_REPORT,
        results: [
          PASSING_REPORT.results[0]!,
          {
            scenarioId: 'live.judge.tool-output-summary-quality',
            category: 'tool',
            classification: 'live-judged',
            phase: 'read-only',
            status: 'not-run',
            reason: 'requires-live-judge',
            durationMs: 1,
          } as HarnessScenarioResult,
        ],
      }),
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
    });

    assert.ok(written, 'artifact should have been written');
    assert.deepEqual(
      written.scenarios.map((scenario) => scenario.scenarioId),
      ['s1'],
    );
  });
});

describe('certifyAllNativeAgents', () => {
  it('dry-run iterates native-capable registry models without publishing', async () => {
    const seen: string[] = [];
    let writeCalls = 0;

    const result = await certifyAllNativeAgents({
      phase: 'workflow',
      repoDir: '/repo',
      dryRun: true,
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => {
        seen.push(`${opts.provider}/${opts.model}`);
        return {
          ...PASSING_REPORT,
          provider: opts.provider,
          model: opts.model,
          transport: opts.transport,
          dryRun: true,
          liveCertifiable: false,
        };
      },
      writeCertificationFn: () => {
        writeCalls++;
        return '/repo/cert.json';
      },
    });

    assert.deepEqual(seen.sort(), [
      'openai/gpt-4o',
      'openrouter/glm-5.2',
      'openrouter/kimi-k2.7-code',
      'openrouter/ox-alpha',
      'openrouter/qwen-3-coder',
    ]);
    assert.equal(writeCalls, 0);
    assert.equal(result.published.length, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, 5);
  });

  it('classifies provisional OpenRouter live-smoke policy refusals as skipped', async () => {
    const written: string[] = [];

    const result = await certifyAllNativeAgents({
      provider: 'openrouter',
      phase: 'workflow',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => ({
        ...PASSING_REPORT,
        provider: opts.provider,
        model: opts.model,
        transport: opts.transport,
        results: [{
          scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
          category: 'phase',
          classification: 'deterministic',
          phase: 'workflow',
          status: 'pass',
          durationMs: 1,
        } as HarnessScenarioResult],
        countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
      }),
      writeCertificationFn: (_repoDir, artifact) => {
        written.push(`${artifact.provider}/${artifact.model}`);
        return `/repo/${artifact.provider}/${artifact.model}/${artifact.suiteVersion}.json`;
      },
      env: {},
    });

    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].model, 'ox-alpha');
    assert.match(result.skipped[0].reason ?? '', /OPENROUTER_LIVE_SMOKE=1/);
    assert.equal(result.published.length, 3);
    assert.equal(written.length, 3);
  });

  it('classifies harness failures as failed', async () => {
    const result = await certifyAllNativeAgents({
      provider: 'openai',
      phase: 'read-only',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      runScenariosFn: async () => FAILING_REPORT,
      writeCertificationFn: () => '/repo/cert.json',
    });

    assert.equal(result.published.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.deepEqual(result.failed.map((entry) => entry.model), ['gpt-4o']);
  });
});

// ---------------------------------------------------------------------------
// HOK-2943: live coding canary integration
// ---------------------------------------------------------------------------

describe('certifyNativeAgent live coding canary', () => {
  const FIXED_NOW = new Date('2026-09-01T12:00:00.000Z');
  const CANARY_RAN_AT = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString();
  const SUBJECT = resolveCertificationSubject({
    provider: 'openai',
    model: 'gpt-4o',
    registry: STUB_REGISTRY,
  }).subject;

  const WORKFLOW_REPORT: HarnessReport = {
    ...PASSING_REPORT,
    results: [
      {
        scenarioId: 'wf1',
        category: 'phase',
        classification: 'deterministic',
        phase: 'workflow',
        status: 'pass',
        durationMs: 1,
      } as HarnessScenarioResult,
    ],
    countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
  };

  function workflowCertifyOptions(overrides: Record<string, unknown> = {}) {
    return {
      provider: 'openai' as const,
      model: 'gpt-4o',
      phase: 'workflow' as const,
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      runScenariosFn: async () => WORKFLOW_REPORT,
      loadPreviousArtifactFn: () => undefined,
      now: () => FIXED_NOW,
      env: {},
      ...overrides,
    };
  }

  function previousArtifactWithCanary(
    canaryOverrides: Record<string, unknown> = {},
  ): NativeCertificationArtifact {
    return {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      subject: SUBJECT,
      provider: SUBJECT.providerId,
      model: SUBJECT.providerModelId,
      phase: 'workflow',
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      scenarios: [{ scenarioId: 'wf1', passed: true }],
      liveCanary: buildLiveCodingCanaryFixture(SUBJECT, DEFAULT_CERTIFICATION_SUITE_VERSION, {
        ranAt: CANARY_RAN_AT,
        ...canaryOverrides,
      }),
    };
  }

  it('dry-run never invokes the live canary runner or persists canary evidence', async () => {
    let canaryCalls = 0;
    let writeCalls = 0;
    const result = await certifyNativeAgent(workflowCertifyOptions({
      dryRun: true,
      liveCodingCanary: true,
      runScenariosFn: async () => ({ ...WORKFLOW_REPORT, dryRun: true, liveCertifiable: false }),
      runLiveCanaryFn: async () => { canaryCalls++; throw new Error('unreachable'); },
      writeCertificationFn: () => { writeCalls++; return '/repo/cert.json'; },
    }));

    assert.equal(canaryCalls, 0, 'dry-run must never run the live canary');
    assert.equal(writeCalls, 0);
    assert.equal(result.codingEligible, false);
    assert.equal(result.liveCanary, undefined);
  });

  it('persists a canary pass with the artifact and grants coding eligibility', async () => {
    let written: NativeCertificationArtifact | undefined;
    const result = await certifyNativeAgent(workflowCertifyOptions({
      liveCodingCanary: true,
      runLiveCanaryFn: async (opts) => buildLiveCodingCanaryFixture(opts.subject, opts.suiteVersion, {
        ranAt: CANARY_RAN_AT,
        attempts: 1,
      }),
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
    }));

    assert.ok(written, 'artifact must be written');
    assert.equal(written!.liveCanary?.status, 'pass');
    assert.equal(written!.liveCanary?.isLive, true);
    assert.equal(result.codingEligible, true);
    assert.equal(result.liveCanary?.status, 'pass');
    assert.equal(result.liveCanary?.carriedForward, undefined);
  });

  it('publishes deterministic evidence without canary evidence when the flag is absent', async () => {
    let written: NativeCertificationArtifact | undefined;
    let canaryCalls = 0;
    const result = await certifyNativeAgent(workflowCertifyOptions({
      runLiveCanaryFn: async () => { canaryCalls++; throw new Error('unreachable'); },
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
    }));

    assert.equal(canaryCalls, 0);
    assert.ok(written, 'deterministic artifact still publishes');
    assert.equal(written!.liveCanary, undefined, 'no canary evidence without the opt-in flag');
    assert.equal(result.codingEligible, false, 'missing canary never grants coding eligibility');
  });

  it('carries forward a previous eligible canary pass on deterministic-only re-certification', async () => {
    let written: NativeCertificationArtifact | undefined;
    const result = await certifyNativeAgent(workflowCertifyOptions({
      loadPreviousArtifactFn: () => previousArtifactWithCanary(),
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
    }));

    assert.equal(written!.liveCanary?.status, 'pass');
    assert.equal(written!.liveCanary?.ranAt, CANARY_RAN_AT, 'original canary timestamp is preserved');
    assert.equal(result.codingEligible, true);
    assert.equal(result.liveCanary?.carriedForward, true);
  });

  it('does not carry forward stale, non-live, failed, or identity-mismatched previous canaries', async () => {
    for (const canaryOverrides of [
      { ranAt: new Date(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString() },
      { isLive: false },
      { status: 'fail' as const, reason: 'protocol_failure' as const },
      { providerNativeId: 'someone-else' },
    ]) {
      let written: NativeCertificationArtifact | undefined;
      const result = await certifyNativeAgent(workflowCertifyOptions({
        loadPreviousArtifactFn: () => previousArtifactWithCanary(canaryOverrides),
        writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
          written = artifact;
          return '/repo/cert.json';
        },
      }));
      assert.equal(written!.liveCanary, undefined, `must drop previous canary for ${JSON.stringify(canaryOverrides)}`);
      assert.equal(result.codingEligible, false);
    }
  });

  it('preserves a previous fresh pass when a new canary attempt is inconclusive', async () => {
    let written: NativeCertificationArtifact | undefined;
    const inconclusiveRanAt = FIXED_NOW.toISOString();
    const result = await certifyNativeAgent(workflowCertifyOptions({
      liveCodingCanary: true,
      loadPreviousArtifactFn: () => previousArtifactWithCanary(),
      runLiveCanaryFn: async (opts) => buildLiveCodingCanaryFixture(opts.subject, opts.suiteVersion, {
        ranAt: inconclusiveRanAt,
        status: 'inconclusive',
        reason: 'provider_transient_error',
        detail: '429 rate limited',
      }),
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
    }));

    assert.equal(written!.liveCanary?.status, 'pass', 'previous pass remains authoritative');
    assert.equal(written!.liveCanary?.ranAt, CANARY_RAN_AT);
    assert.equal(written!.liveCanary?.lastInconclusiveAttempt?.ranAt, inconclusiveRanAt);
    assert.equal(written!.liveCanary?.lastInconclusiveAttempt?.reason, 'provider_transient_error');
    assert.equal(result.codingEligible, true);
    assert.equal(result.liveCanary?.carriedForward, true);
  });

  it('records an inconclusive result and stays ineligible when no previous pass exists', async () => {
    let written: NativeCertificationArtifact | undefined;
    const result = await certifyNativeAgent(workflowCertifyOptions({
      liveCodingCanary: true,
      runLiveCanaryFn: async (opts) => buildLiveCodingCanaryFixture(opts.subject, opts.suiteVersion, {
        ranAt: FIXED_NOW.toISOString(),
        status: 'inconclusive',
        reason: 'provider_transient_error',
      }),
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
    }));

    assert.equal(written!.liveCanary?.status, 'inconclusive');
    assert.equal(result.codingEligible, false);
  });

  it('lets a definitive canary failure revoke a previous identity-matching pass', async () => {
    let written: NativeCertificationArtifact | undefined;
    const result = await certifyNativeAgent(workflowCertifyOptions({
      liveCodingCanary: true,
      loadPreviousArtifactFn: () => previousArtifactWithCanary(),
      runLiveCanaryFn: async (opts) => buildLiveCodingCanaryFixture(opts.subject, opts.suiteVersion, {
        ranAt: FIXED_NOW.toISOString(),
        status: 'fail',
        reason: 'wrong_mutation',
      }),
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
    }));

    assert.equal(written!.liveCanary?.status, 'fail', 'definitive failure replaces the previous pass');
    assert.equal(written!.liveCanary?.reason, 'wrong_mutation');
    assert.equal(result.codingEligible, false);
  });

  it('never runs the canary for read-only certification even when requested', async () => {
    let canaryCalls = 0;
    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      liveCodingCanary: true,
      runScenariosFn: async () => PASSING_REPORT,
      runLiveCanaryFn: async () => { canaryCalls++; throw new Error('unreachable'); },
      loadPreviousArtifactFn: () => undefined,
      writeCertificationFn: () => '/repo/cert.json',
      now: () => FIXED_NOW,
      env: {},
    });

    assert.equal(canaryCalls, 0, 'read-only certification cannot satisfy coding, so no canary runs');
    assert.equal(result.codingEligible, false);
  });

  it('renderCanaryStatusLine states eligibility explicitly', async () => {
    const passResult = await certifyNativeAgent(workflowCertifyOptions({
      liveCodingCanary: true,
      runLiveCanaryFn: async (opts) => buildLiveCodingCanaryFixture(opts.subject, opts.suiteVersion, {
        ranAt: CANARY_RAN_AT,
      }),
      writeCertificationFn: () => '/repo/cert.json',
    }));
    assert.match(renderCanaryStatusLine(passResult, 'workflow'), /status=pass.*Coding eligibility: granted/);

    const missingResult = await certifyNativeAgent(workflowCertifyOptions({
      writeCertificationFn: () => '/repo/cert.json',
    }));
    assert.match(renderCanaryStatusLine(missingResult, 'workflow'), /missing.*NOT granted/);

    assert.match(renderCanaryStatusLine(missingResult, 'read-only'), /not applicable/);
  });
});

describe('certifyNativeAgent skipped canary preservation', () => {
  const FIXED_NOW = new Date('2026-09-01T12:00:00.000Z');
  const CANARY_RAN_AT = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString();
  const SUBJECT = resolveCertificationSubject({
    provider: 'openai',
    model: 'gpt-4o',
    registry: STUB_REGISTRY,
  }).subject;

  it('a skipped canary run never revokes a valid previous pass', async () => {
    let written: NativeCertificationArtifact | undefined;
    const previous: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      subject: SUBJECT,
      provider: SUBJECT.providerId,
      model: SUBJECT.providerModelId,
      phase: 'workflow',
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      scenarios: [{ scenarioId: 'wf1', passed: true }],
      liveCanary: buildLiveCodingCanaryFixture(SUBJECT, DEFAULT_CERTIFICATION_SUITE_VERSION, {
        ranAt: CANARY_RAN_AT,
      }),
    };

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'workflow',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      liveCodingCanary: true,
      runScenariosFn: async () => ({
        ...PASSING_REPORT,
        results: [{
          scenarioId: 'wf1',
          category: 'phase',
          classification: 'deterministic',
          phase: 'workflow',
          status: 'pass',
          durationMs: 1,
        } as HarnessScenarioResult],
        countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
      }),
      loadPreviousArtifactFn: () => previous,
      runLiveCanaryFn: async (opts) => buildLiveCodingCanaryFixture(opts.subject, opts.suiteVersion, {
        ranAt: FIXED_NOW.toISOString(),
        status: 'skipped',
        reason: 'provider_config_error',
      }),
      writeCertificationFn: (_repoDir: string, artifact: NativeCertificationArtifact) => {
        written = artifact;
        return '/repo/cert.json';
      },
      now: () => FIXED_NOW,
      env: {},
    });

    assert.equal(written!.liveCanary?.status, 'pass', 'valid pass stays authoritative past a skipped run');
    assert.equal(written!.liveCanary?.ranAt, CANARY_RAN_AT);
    assert.equal(result.codingEligible, true);
    assert.equal(result.liveCanary?.carriedForward, true);
  });
});

describe('refreshCanaryCohort', () => {
  it('rejects when no cohort configured', async () => {
    await assert.rejects(
      () => refreshCanaryCohort({ repoDir: '/tmp/no-cohort' }),
      (err: Error & { exitCode?: number }) => {
        assert.match(err.message, /No canary cohort configured/);
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  });

  it('rejects dry-run', async () => {
    await assert.rejects(
      () => refreshCanaryCohort({
        repoDir: '/tmp/test',
        dryRun: true,
        cohort: { identities: [{ provider: 'openai', model: 'gpt-4o' }] },
        registry: STUB_REGISTRY,
      }),
      (err: Error & { exitCode?: number }) => {
        assert.match(err.message, /cannot be combined with --dry-run/);
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  });

  it('rejects invalid cohort identities', async () => {
    await assert.rejects(
      () => refreshCanaryCohort({
        repoDir: '/tmp/test',
        cohort: { identities: [{ provider: 'openai', model: 'nonexistent' }] },
        registry: STUB_REGISTRY,
      }),
      (err: Error & { exitCode?: number }) => {
        assert.match(err.message, /validation failed/);
        return true;
      },
    );
  });
});
