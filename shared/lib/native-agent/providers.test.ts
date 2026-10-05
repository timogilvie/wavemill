import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../model-registry.ts';
import {
  buildGlobalCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  resolveCertificationSubject,
  type NativeCertificationArtifact,
} from './certification/index.ts';
import { resolveOpenRouterModelIdentity } from '../openrouter-catalog.ts';
import {
  buildOpenAiResponsesModel,
  buildOpenRouterModel,
  getNativeProviderApiKey,
  getRegisteredPiProviderForModel,
  OPENAI_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  resolveNativeAgentProviders,
} from './providers.ts';
import { toProviderRequestModelId } from './provider.ts';

const FIXED_NOW = new Date('2026-07-12T12:00:00.000Z');

const PROVIDER_CASES = [
  {
    provider: 'openai' as const,
    modelId: 'gpt-4o',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyValue: 'sk-openai-test',
  },
  {
    provider: 'openrouter' as const,
    modelId: 'glm-5.2',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyValue: 'sk-openrouter-test',
  },
] as const;

function makeCertifiedRegistry(
  modelId: string,
  provider: 'openai' | 'openrouter',
  suiteVersion = 'v1',
): ModelRegistry {
  const providerNativeId = provider === 'openrouter'
    ? (resolveOpenRouterModelIdentity(modelId)?.openrouterId ?? modelId)
    : modelId;
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['testing'],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        supportedModel: {
          wavemillAlias: modelId,
          providerNativeId,
          provider,
          transport: provider === 'openai' ? 'openai-responses' : 'openai-completions',
          stages: ['planning', 'coding', 'review'],
          lifecycle: 'supported',
          launchEligible: true,
          routingEligible: true,
        },
        nativeCapability: provider === 'openai'
          ? {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FIXED_NOW.toISOString(),
              certificationSuiteVersion: suiteVersion,
            },
          }
          : {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FIXED_NOW.toISOString(),
              certificationSuiteVersion: suiteVersion,
            },
          },
      },
    },
    ladders: {},
  };
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-agent-provider-'));
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

function writeArtifact(
  repoDir: string,
  provider: 'openai' | 'openrouter',
  modelId: string,
  suiteVersion: string,
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const path = buildGlobalCertificationPath(provider, modelId, suiteVersion);
  mkdirSync(dirname(path), { recursive: true });
  const resolved = resolveCertificationSubject({
    provider,
    model: modelId,
    registry: makeCertifiedRegistry(modelId, provider, suiteVersion),
  });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: resolved.subject,
    provider: resolved.storageIdentity.provider,
    model: resolved.storageIdentity.model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf8');
  return path;
}

function makeProviderConfig(provider: 'openai' | 'openrouter', modelId: string) {
  return provider === 'openai'
    ? { providers: { openai: { models: [modelId] } } }
    : { providers: { openrouter: { models: [modelId] } } };
}

describe('native-agent provider resolution', () => {
  it('builds a ready OpenAI responses model', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1');

      const [entry] = resolveNativeAgentProviders({
        providers: {
          openai: {
            models: ['gpt-4o'],
          },
        },
      }, {
        repoDir,
        env: { OPENAI_API_KEY: 'sk-openai-test' },
        registry: makeCertifiedRegistry('gpt-4o', 'openai'),
        now: FIXED_NOW,
      });

      assert(entry);
      assert.equal(entry.status, 'ready');
      assert.equal(entry.providerName, 'openai');
      assert.equal(entry.modelId, 'gpt-4o');
      assert.equal(entry.model.api, 'openai-responses');
      assert.equal(entry.model.provider, 'openai');
      assert.equal(entry.model.baseUrl, OPENAI_DEFAULT_BASE_URL);
      assert.equal(entry.model.id, 'openai:gpt-4o');
      assert.equal(entry.model.name, 'gpt-4o');
      assert.equal(toProviderRequestModelId(entry.model), 'gpt-4o');
      assert.equal(getNativeProviderApiKey(entry), 'sk-openai-test');
    } finally {
      cleanup();
    }
  });

  it('builds a ready OpenRouter model with compat and header overrides', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openrouter', 'qwen-3-coder', 'v1');

      const [entry] = resolveNativeAgentProviders({
        providers: {
          openrouter: {
            baseUrl: 'https://example.test/openrouter',
            headers: {
              'HTTP-Referer': 'https://wavemill.test',
              'X-Title': 'Wavemill',
            },
            models: ['qwen-3-coder'],
          },
        },
      }, {
        repoDir,
        env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
        registry: makeCertifiedRegistry('qwen-3-coder', 'openrouter'),
        now: FIXED_NOW,
      });

      assert(entry);
      assert.equal(entry.status, 'ready');
      assert.equal(entry.model.api, 'openai-completions');
      assert.equal(entry.model.provider, 'openrouter');
      assert.equal(entry.model.baseUrl, 'https://example.test/openrouter');
      assert.equal(entry.model.id, 'openrouter:qwen-3-coder');
      assert.equal(entry.model.name, 'qwen/qwen3-coder');
      assert.equal(toProviderRequestModelId(entry.model), 'qwen/qwen3-coder');
      assert.deepEqual(entry.model.headers, {
        'HTTP-Referer': 'https://wavemill.test',
        'X-Title': 'Wavemill',
      });
      assert.deepEqual(entry.model.compat, {
        thinkingFormat: 'openrouter',
        supportsStrictMode: true,
      });
    } finally {
      cleanup();
    }
  });

  it('uses repo .env values and default models when explicit env is absent', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeFileSync(join(repoDir, '.env'), 'WAVEMILL_TEST_OPENAI_KEY=sk-from-dotenv\n', 'utf8');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1');

      const [entry] = resolveNativeAgentProviders({
        providers: {
          openai: {
            apiKeyEnv: 'WAVEMILL_TEST_OPENAI_KEY',
          },
        },
      }, {
        repoDir,
        registry: makeCertifiedRegistry('gpt-4o', 'openai'),
        now: FIXED_NOW,
      });

      assert(entry);
      assert.equal(entry.status, 'ready');
      assert.equal(entry.modelId, 'gpt-4o');
      assert.equal(getNativeProviderApiKey(entry), 'sk-from-dotenv');
    } finally {
      cleanup();
    }
  });

  it('marks missing, empty, and whitespace-only keys as unavailable without leaking secrets', () => {
    const consoleLog = console.log;
    const consoleWarn = console.warn;
    const consoleError = console.error;
    const originalOpenAiKeyName = process.env.OPENAI_KEY_NAME;
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const events: string[] = [];
    console.log = (...args: unknown[]) => { events.push(`log:${args.join(' ')}`); };
    console.warn = (...args: unknown[]) => { events.push(`warn:${args.join(' ')}`); };
    console.error = (...args: unknown[]) => { events.push(`error:${args.join(' ')}`); };

    try {
      delete process.env.OPENAI_KEY_NAME;
      delete process.env.OPENROUTER_API_KEY;

      const missing = resolveNativeAgentProviders({
        providers: {
          openai: {
            apiKeyEnv: 'OPENAI_KEY_NAME',
            models: ['gpt-4o'],
          },
        },
      }, {
        env: {},
      });
      const empty = resolveNativeAgentProviders({
        providers: {
          openrouter: {
            models: ['openai/gpt-4o-mini'],
          },
        },
      }, {
        env: { OPENROUTER_API_KEY: '' },
      });
      const whitespace = resolveNativeAgentProviders({
        providers: {
          openrouter: {
            models: ['openai/gpt-4o-mini'],
          },
        },
      }, {
        env: { OPENROUTER_API_KEY: '   ' },
      });

      for (const entry of [...missing, ...empty, ...whitespace]) {
        assert.equal(entry.status, 'unavailable');
        assert.match(entry.reason, /OPENAI_KEY_NAME|OPENROUTER_API_KEY/);
      }

      const serialized = JSON.stringify({ missing, empty, whitespace });
      assert(!serialized.includes('sk-openrouter-test'));
      assert(!serialized.includes('OPENROUTER_API_KEY='));
      assert.deepEqual(events, []);
    } finally {
      if (typeof originalOpenAiKeyName === 'undefined') {
        delete process.env.OPENAI_KEY_NAME;
      } else {
        process.env.OPENAI_KEY_NAME = originalOpenAiKeyName;
      }
      if (typeof originalOpenRouterKey === 'undefined') {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      }
      console.log = consoleLog;
      console.warn = consoleWarn;
      console.error = consoleError;
    }
  });

  it('returns skipped entries for disabled providers', () => {
    const [entry] = resolveNativeAgentProviders({
      providers: {
        openrouter: {
          enabled: false,
          models: ['openai/gpt-4o-mini'],
        },
      },
    }, {
      env: { OPENROUTER_API_KEY: 'sk-ignored' },
    });

    assert(entry);
    assert.equal(entry.status, 'skipped');
    assert.match(entry.reason, /enabled is false/);
  });

  it('does not expose ready provider secrets in JSON output', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1');

      const [entry] = resolveNativeAgentProviders({
        providers: {
          openai: {
            models: ['gpt-4o'],
          },
        },
      }, {
        repoDir,
        env: { OPENAI_API_KEY: 'sk-secret-value' },
        registry: makeCertifiedRegistry('gpt-4o', 'openai'),
        now: FIXED_NOW,
      });

      assert(entry);
      assert.equal(entry.status, 'ready');
      const serialized = JSON.stringify(entry);
      assert(!serialized.includes('sk-secret-value'));
      assert.equal(getNativeProviderApiKey(entry), 'sk-secret-value');
    } finally {
      cleanup();
    }
  });
});

describe('native-agent Pi provider lookup', () => {
  it('builds validator-recognized provider/api pairs', () => {
    const openAiModel = buildOpenAiResponsesModel({ modelId: 'gpt-4o' });
    const openRouterModel = buildOpenRouterModel({ modelId: 'openai/gpt-4o-mini' });

    assert.equal(openAiModel.provider, 'openai');
    assert.equal(openAiModel.api, 'openai-responses');
    assert.equal(openRouterModel.provider, 'openrouter');
    assert.equal(openRouterModel.api, 'openai-completions');
  });

  it('resolves built-in Pi providers for OpenAI and OpenRouter models', () => {
    const openAiProvider = getRegisteredPiProviderForModel(buildOpenAiResponsesModel({
      modelId: 'gpt-4o',
    }));
    const openRouterProvider = getRegisteredPiProviderForModel(buildOpenRouterModel({
      modelId: 'openai/gpt-4o-mini',
      baseUrl: OPENROUTER_DEFAULT_BASE_URL,
    }));

    assert(openAiProvider);
    assert(openRouterProvider);
  });

  it('handles unknown provider APIs without throwing', () => {
    const provider = getRegisteredPiProviderForModel({
      api: 'definitely-unknown-provider',
    } as ReturnType<typeof buildOpenAiResponsesModel>);

    assert.equal(provider, undefined);
  });

  // Regression: provider entries are enumerated by wavemill alias, but the alias is
  // not a valid OpenRouter model ID. Sending it unresolved made native coding launches
  // die with `400 qwen-2.5-coder-32b is not a valid model ID`, which the monitor then
  // left parked in `phase: coding` forever.
  it('sends the provider-native model ID on the wire, not the wavemill alias', () => {
    const model = buildOpenRouterModel({ modelId: 'qwen-3-coder' });

    assert.equal(model.name, 'qwen/qwen3-coder');
    // The entry stays keyed by alias so provider matching and certification lookups
    // continue to resolve the same entry.
    assert.equal(model.id, 'openrouter:qwen-3-coder');
  });

  it('leaves already provider-native and unknown model IDs unchanged', () => {
    assert.equal(
      buildOpenRouterModel({ modelId: 'qwen/qwen-2.5-coder-32b-instruct' }).name,
      'qwen/qwen-2.5-coder-32b-instruct',
    );
    assert.equal(
      buildOpenRouterModel({ modelId: 'openai/gpt-4o-mini' }).name,
      'openai/gpt-4o-mini',
    );
    assert.equal(
      buildOpenRouterModel({ modelId: 'definitely-not-in-the-catalog' }).name,
      'definitely-not-in-the-catalog',
    );
  });
});

describe('native-agent certification gate', () => {
  it('configured-only model lists do not create task-mode candidates', () => {
    const emptyRegistry = { models: {}, ladders: {} };

    const consoleLog = console.log;
    const consoleWarn = console.warn;
    const consoleError = console.error;
    const events: string[] = [];
    console.log = (...args: unknown[]) => { events.push(`log:${args.join(' ')}`); };
    console.warn = (...args: unknown[]) => { events.push(`warn:${args.join(' ')}`); };
    console.error = (...args: unknown[]) => { events.push(`error:${args.join(' ')}`); };

    try {
      const entries = resolveNativeAgentProviders({
        providers: {
          openai: {
            models: ['uncertified-model'],
          },
        },
      }, {
        env: { OPENAI_API_KEY: 'sk-secret-should-not-leak' },
        registry: emptyRegistry,
      });

      assert.equal(entries.length, 0);
      const serialized = JSON.stringify(entries);
      assert(!serialized.includes('sk-secret-should-not-leak'), 'API key must not appear in serialized output');
      assert.deepEqual(events, []);
    } finally {
      console.log = consoleLog;
      console.warn = consoleWarn;
      console.error = consoleError;
    }
  });

  it('configured-only model lists do not create certification-mode candidates', () => {
    const emptyRegistry = { models: {}, ladders: {} };

    const entries = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['uncertified-model'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      registry: emptyRegistry,
      certificationMode: true,
    });

    assert.equal(entries.length, 0);
  });

  it('certified model resolves to ready with certificationOnly: false', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'certified-model', 'v1');

      const entries = resolveNativeAgentProviders({
        providers: {
          openai: {
            models: ['certified-model'],
          },
        },
      }, {
        repoDir,
        env: { OPENAI_API_KEY: 'sk-test' },
        registry: makeCertifiedRegistry('certified-model', 'openai'),
        now: FIXED_NOW,
      });

      assert.equal(entries.length, 1);
      const [entry] = entries;
      assert.equal(entry.status, 'ready');
      assert.equal(entry.certificationOnly, false);
    } finally {
      cleanup();
    }
  });

  it('certified model in certificationMode resolves to ready with certificationOnly: false', () => {
    const entries = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['certified-model'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      registry: makeCertifiedRegistry('certified-model', 'openai'),
      certificationMode: true,
    });

    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.status, 'ready');
    assert.equal(entry.certificationOnly, false);
  });

  it('distinct registry models are judged independently without configured-list substitution', () => {
    const { repoDir, cleanup } = makeRepo();
    const registry = makeCertifiedRegistry('certified-a', 'openai');
    registry.models['uncertified-b'] = makeCertifiedRegistry('uncertified-b', 'openai').models['uncertified-b']!;

    try {
      writeArtifact(repoDir, 'openai', 'certified-a', 'v1');

      const entries = resolveNativeAgentProviders({
        providers: {
          openai: {
            models: ['certified-a', 'uncertified-b'],
          },
        },
      }, {
        repoDir,
        env: { OPENAI_API_KEY: 'sk-test' },
        registry,
        now: FIXED_NOW,
      });

      assert.equal(entries.length, 2);
      const certifiedEntry = entries.find((e) => e.modelId === 'certified-a');
      const uncertifiedEntry = entries.find((e) => e.modelId === 'uncertified-b');

      assert(certifiedEntry);
      assert.equal(certifiedEntry.status, 'ready');

      assert(uncertifiedEntry);
      assert.equal(uncertifiedEntry.status, 'uncertified');
      assert.equal(uncertifiedEntry.rejectionReason, 'missing_artifact');
      assert.match(uncertifiedEntry.reason, /uncertified-b/);
    } finally {
      cleanup();
    }
  });
});

describe('native provider certification artifacts', () => {
  for (const testCase of PROVIDER_CASES) {
    it(`rejects missing ${testCase.provider} artifacts in task mode`, () => {
      const { repoDir, cleanup } = makeRepo();
      try {
        const [entry] = resolveNativeAgentProviders(
          makeProviderConfig(testCase.provider, testCase.modelId),
          {
            repoDir,
            env: { [testCase.apiKeyEnv]: testCase.apiKeyValue },
            registry: makeCertifiedRegistry(testCase.modelId, testCase.provider),
            now: FIXED_NOW,
          },
        );

        assert(entry);
        assert.equal(entry.status, 'uncertified');
        assert.equal(entry.rejectionReason, 'missing_artifact');
        assert.match(entry.reason, /artifactPath=/);
      } finally {
        cleanup();
      }
    });

    it(`rejects stale ${testCase.provider} artifacts in task mode`, () => {
      const { repoDir, cleanup } = makeRepo();
      try {
        writeArtifact(repoDir, testCase.provider, testCase.modelId, 'v1', {
          certifiedAt: new Date(FIXED_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
        });

        const [entry] = resolveNativeAgentProviders(
          makeProviderConfig(testCase.provider, testCase.modelId),
          {
            repoDir,
            env: { [testCase.apiKeyEnv]: testCase.apiKeyValue },
            registry: makeCertifiedRegistry(testCase.modelId, testCase.provider),
            now: FIXED_NOW,
          },
        );

        assert(entry);
        assert.equal(entry.status, 'uncertified');
        assert.equal(entry.rejectionReason, 'stale_artifact');
      } finally {
        cleanup();
      }
    });

    it(`rejects wrong-suite ${testCase.provider} artifacts before staleness`, () => {
      const { repoDir, cleanup } = makeRepo();
      try {
        writeArtifact(repoDir, testCase.provider, testCase.modelId, 'v1', {
          suiteVersion: 'v0',
          certifiedAt: new Date(FIXED_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
        });

        const [entry] = resolveNativeAgentProviders(
          makeProviderConfig(testCase.provider, testCase.modelId),
          {
            repoDir,
            env: { [testCase.apiKeyEnv]: testCase.apiKeyValue },
            registry: makeCertifiedRegistry(testCase.modelId, testCase.provider),
            now: FIXED_NOW,
          },
        );

        assert(entry);
        assert.equal(entry.status, 'uncertified');
        assert.equal(entry.rejectionReason, 'wrong_suite');
      } finally {
        cleanup();
      }
    });

    it(`rejects insufficient-phase ${testCase.provider} artifacts with an explicit override`, () => {
      const { repoDir, cleanup } = makeRepo();
      try {
        writeArtifact(repoDir, testCase.provider, testCase.modelId, 'v1', { phase: 'patch' });

        const [entry] = resolveNativeAgentProviders(
          makeProviderConfig(testCase.provider, testCase.modelId),
          {
            repoDir,
            env: { [testCase.apiKeyEnv]: testCase.apiKeyValue },
            registry: makeCertifiedRegistry(testCase.modelId, testCase.provider),
            requiredCertificationPhase: 'workflow',
            now: FIXED_NOW,
          },
        );

        assert(entry);
        assert.equal(entry.status, 'uncertified');
        assert.equal(entry.rejectionReason, 'insufficient_phase');
      } finally {
        cleanup();
      }
    });
  }

  it('requires workflow certification for planning by default while keeping read-only phases lenient', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1', { phase: 'patch' });
      const registry = makeCertifiedRegistry('glm-5.2', 'openrouter');

      const [planningEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openrouter', 'glm-5.2'),
        {
          repoDir,
          env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
          phase: 'planning',
          registry,
          now: FIXED_NOW,
        },
      );
      assert(planningEntry);
      assert.equal(planningEntry.status, 'uncertified');
      assert.equal(planningEntry.rejectionReason, 'insufficient_phase');

      const [reviewEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openrouter', 'glm-5.2'),
        {
          repoDir,
          env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
          phase: 'review',
          registry,
          now: FIXED_NOW,
        },
      );
      assert(reviewEntry);
      assert.equal(reviewEntry.status, 'ready');

      const [taskExpansionEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openrouter', 'glm-5.2'),
        {
          repoDir,
          env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
          phase: 'task-expansion',
          registry,
          now: FIXED_NOW,
        },
      );
      assert(taskExpansionEntry);
      assert.equal(taskExpansionEntry.status, 'ready');

      writeArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1', { phase: 'workflow' });
      const [workflowPlanningEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openrouter', 'glm-5.2'),
        {
          repoDir,
          env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
          phase: 'planning',
          registry,
          now: FIXED_NOW,
        },
      );
      assert(workflowPlanningEntry);
      assert.equal(workflowPlanningEntry.status, 'ready');
    } finally {
      cleanup();
    }
  });

  it('keeps certification mode lenient for stale registered candidates', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const [taskEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
        },
      );
      const [entry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
          mode: 'certification',
        },
      );

      assert.equal(taskEntry.status, 'uncertified');
      assert.equal(taskEntry.rejectionReason, 'stale_artifact');
      assert(entry);
      assert.equal(entry.status, 'ready');
      assert.equal(entry.certificationOnly, false);
    } finally {
      cleanup();
    }
  });

  it('maps malformed artifacts to malformed_artifact for provider resolution', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const path = buildGlobalCertificationPath('openai', 'gpt-4o', 'v1');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'not json', 'utf8');

      const [entry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
        },
      );

      assert(entry);
      assert.equal(entry.status, 'uncertified');
      assert.equal(entry.rejectionReason, 'malformed_artifact');
    } finally {
      cleanup();
    }
  });

  it('rejects wrong-provider artifacts by identity even when the file path matches', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        provider: 'openrouter',
      });

      const [entry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
        },
      );

      assert.equal(entry.status, 'uncertified');
      assert.equal(entry.rejectionReason, 'identity_reidentified');
    } finally {
      cleanup();
    }
  });

  it('rejects wrong-model artifacts by identity even when the file path matches', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        model: 'gpt-4.1',
      });

      const [entry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
        },
      );

      assert.equal(entry.status, 'uncertified');
      assert.equal(entry.rejectionReason, 'identity_reidentified');
    } finally {
      cleanup();
    }
  });

  it('treats a fresh 59-day artifact as ready and the 60-day boundary as stale', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 59 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const [freshEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
        },
      );

      assert.equal(freshEntry.status, 'ready');

      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const [boundaryEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openai', 'gpt-4o'),
        {
          repoDir,
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          registry: makeCertifiedRegistry('gpt-4o', 'openai'),
          now: FIXED_NOW,
        },
      );

      assert.equal(boundaryEntry.status, 'uncertified');
      assert.equal(boundaryEntry.rejectionReason, 'stale_artifact');
    } finally {
      cleanup();
    }
  });

  it('resolves openrouter aliases and raw IDs to the same artifact path', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const path = writeArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1');

      const [aliasEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openrouter', 'glm-5.2'),
        {
          repoDir,
          env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
          registry: makeCertifiedRegistry('glm-5.2', 'openrouter'),
          now: FIXED_NOW,
        },
      );
      const [rawEntry] = resolveNativeAgentProviders(
        makeProviderConfig('openrouter', 'z-ai/glm-5.2'),
        {
          repoDir,
          env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
          registry: makeCertifiedRegistry('glm-5.2', 'openrouter'),
          now: FIXED_NOW,
        },
      );

      assert.equal(aliasEntry.status, 'ready');
      assert.equal(rawEntry.status, 'ready');
      assert.equal(buildGlobalCertificationPath('openrouter', 'glm-5.2', 'v1'), path);
      assert.equal(buildGlobalCertificationPath('openrouter', 'z-ai/glm-5.2', 'v1'), path);
    } finally {
      cleanup();
    }
  });
});
