import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  auditOpenRouterAliases,
  isFirstPartyEndpoint,
  parseEndpointsFixture,
  selectPricingReference,
} from './openrouter-alias-audit.ts';
import type { ModelRegistry } from './model-registry.ts';
import type { OpenRouterEndpoint, OpenRouterModel } from './openrouter-catalog.ts';

function makeModel(overrides: Partial<ModelRegistry['models'][string]> = {}): ModelRegistry['models'][string] {
  return {
    vendor: 'test',
    class: 'fast_economy',
    strengths: ['test'],
    weaknesses: ['test'],
    qualityScores: { routing: 0, planning: 0, coding: 80, review: 0, classify: 0 },
    defaultLadderEligible: false,
    // Above the built-in coding floor (144_384) so the context-window predicate
    // does not exclude these fixtures from selectability. Individual tests can
    // still override via `overrides.contextWindowTokens`.
    contextWindowTokens: 200_000,
    toolSupport: 'basic',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 2,
    agent: 'native-openrouter',
    supportedModel: {
      lifecycle: 'supported',
      stages: ['coding'],
      ...overrides.supportedModel,
    },
    ...overrides,
  };
}

describe('openrouter alias audit', () => {
  it('reports retired unresolved and missing-catalog aliases as non-selectable', () => {
    const registry: ModelRegistry = {
      models: {
        'deepseek-coder-v2': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'deepseek/deepseek-coder-v2-instruct' },
        }),
        'gemini-2.0-flash': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'google/gemini-2.0-flash-001' },
        }),
        'grok-code-fast': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'x-ai/grok-code-fast-1' },
        }),
        'qwen-2.5-coder-32b': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'qwen/qwen-2.5-coder-32b-instruct' },
        }),
      },
      ladders: {},
    };
    const catalog = new Map<string, OpenRouterModel>([
      ['qwen/qwen-2.5-coder-32b-instruct', { id: 'qwen/qwen-2.5-coder-32b-instruct' }],
    ]);

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: catalog,
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.checked, 4);
    assert.equal(report.schemaVersion, '2');
    assert.equal(report.selectableFindings, 0);
    // HOK-2947 removed the retired aliases' launch-priority mapping rows, so
    // they no longer resolve to a wire id; grok-code-fast keeps its row.
    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason, finding.selectable]), [
      ['deepseek-coder-v2', 'unresolved-openrouter-id', false],
      ['gemini-2.0-flash', 'unresolved-openrouter-id', false],
      ['grok-code-fast', 'not-found-in-openrouter', false],
      ['qwen-2.5-coder-32b', 'unresolved-openrouter-id', false],
    ]);
  });

  it('counts selectable aliases with drift as blocking findings', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map(),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.checked, 1);
    assert.equal(report.selectableFindings, 1);
    assert.equal(report.findings[0]?.alias, 'qwen-3-coder');
    assert.equal(report.findings[0]?.reason, 'not-found-in-openrouter');
    assert.equal(report.findings[0]?.selectable, true);
  });

  it('reports overstated registry context windows but accepts equal or conservative declarations', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
        'qwen-3-235b': makeModel({
          contextWindowTokens: 131_072,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-235b-a22b-2507' },
        }),
        'kimi-k2': makeModel({
          contextWindowTokens: 65_536,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'moonshotai/kimi-k2' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', context_length: 131_072 }],
        ['qwen/qwen3-235b-a22b-2507', { id: 'qwen/qwen3-235b-a22b-2507', context_length: 131_072 }],
        ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', context_length: 131_072 }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason]), [
      ['qwen-3-coder', 'context-window-overstated'],
    ]);
    assert.match(report.findings[0]?.detail ?? '', /200000/);
    assert.match(report.findings[0]?.detail ?? '', /131072/);
  });

  it('uses top_provider context length and skips context checks when provider context is absent', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
        'qwen-3-235b': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-235b-a22b-2507' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', top_provider: { context_length: 131_072 } }],
        ['qwen/qwen3-235b-a22b-2507', { id: 'qwen/qwen3-235b-a22b-2507' }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason]), [
      ['qwen-3-coder', 'context-window-overstated'],
    ]);
  });

  it('reports catalog tool-support mismatches and skips absent supported_parameters', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          toolSupport: 'basic',
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
        'qwen-3-235b': makeModel({
          toolSupport: 'full',
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-235b-a22b-2507' },
        }),
        'kimi-k2': makeModel({
          toolSupport: 'none',
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'moonshotai/kimi-k2' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', supported_parameters: ['temperature'] }],
        ['qwen/qwen3-235b-a22b-2507', { id: 'qwen/qwen3-235b-a22b-2507' }],
        ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', supported_parameters: ['temperature'] }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason, finding.selectable]), [
      ['qwen-3-coder', 'tool-support-mismatch', true],
    ]);
  });

  it('reports only missing or understated registry pricing as drift', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          costPerMillionInputTokensUsd: 0.5,
          costPerMillionOutputTokensUsd: 3,
          pricing: {
            inputCostPerMTok: 1.5,
            outputCostPerMTok: 2,
            cacheReadCostPerMTok: 0.2,
          },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', {
          id: 'qwen/qwen3-coder',
          context_length: 200_000,
          supported_parameters: ['tools'],
          pricing: {
            prompt: '0.000001',
            completion: '0.000002',
            input_cache_read: '0.000000125',
            input_cache_write: '0.00000125',
          },
        }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => finding.reason), [
      'pricing-drift',
      'pricing-drift',
    ]);
    assert.deepEqual(report.findings.map((finding) => finding.detail), [
      'inputPerMTok drift for costPerMillionInputTokensUsd: registry 0.5 understates OpenRouter top-level price 1.',
      'cacheWritePerMTok drift for pricing.cacheWriteCostPerMTok: registry null understates OpenRouter top-level price 1.25.',
    ]);
    assert.equal(report.findings[0]?.referenceSource, 'catalog-top-level');
    assert.equal(report.findings[0]?.expected, 1);
    assert.equal(report.findings[0]?.actual, 0.5);
    assert.equal(report.selectableFindings, 2);
  });

  it('accepts conservative registry pricing when the live catalog is discounted', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          costPerMillionInputTokensUsd: 1,
          costPerMillionOutputTokensUsd: 2,
          pricing: {
            inputCostPerMTok: 1,
            outputCostPerMTok: 2,
            cacheReadCostPerMTok: 0.2,
          },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', {
          id: 'qwen/qwen3-coder',
          context_length: 200_000,
          supported_parameters: ['tools'],
          pricing: {
            prompt: '0.00000028',
            completion: '0.00000088',
            input_cache_read: '0.000000052',
          },
        }],
      ]),
      now: new Date('2026-09-10T00:00:00.000Z'),
      catalogSource: 'live',
    });

    assert.deepEqual(report.findings, []);
    assert.equal(report.selectableFindings, 0);
  });

  it('does not report cache drift when provider cache prices are absent', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          pricing: {
            inputCostPerMTok: 1,
            outputCostPerMTok: 2,
            cacheReadCostPerMTok: 0.1,
            cacheWriteCostPerMTok: 1.25,
          },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', {
          id: 'qwen/qwen3-coder',
          context_length: 200_000,
          supported_parameters: ['tools'],
          pricing: { prompt: '0.000001', completion: '0.000002' },
        }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings, []);
  });

  it('accepts Ox Alpha provisional zero pricing and absent cache prices', () => {
    const registry: ModelRegistry = {
      models: {
        'ox-alpha': makeModel({
          vendor: 'unknown',
          qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
          pricing: {
            inputCostPerMTok: 0,
            outputCostPerMTok: 0,
          },
          costPerMillionInputTokensUsd: 0,
          costPerMillionOutputTokensUsd: 0,
          contextWindowTokens: 1_048_576,
          multimodal: { text: true, image: true, video: true },
          supportedModel: {
            lifecycle: 'supported',
            stages: ['planning', 'coding', 'review'],
            providerNativeId: 'stealth/ox-alpha',
            routingEligible: false,
          },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['stealth/ox-alpha', {
          id: 'stealth/ox-alpha',
          context_length: 1_048_576,
          top_provider: { context_length: 1_048_576 },
          supported_parameters: ['reasoning', 'tools'],
          pricing: { prompt: '0', completion: '0' },
        }],
      ]),
      now: new Date('2026-08-24T22:16:05.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings, []);
    assert.equal(report.checked, 1);
  });

  it('reports malformed provider pricing as invalid instead of comparing fallback values', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          pricing: {
            inputCostPerMTok: 1,
            outputCostPerMTok: 2,
          },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', {
          id: 'qwen/qwen3-coder',
          context_length: 200_000,
          supported_parameters: ['tools'],
          pricing: { prompt: '-0.000001', completion: '0.000002' },
        }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.reason, 'invalid-pricing');
    assert.equal(report.findings[0]?.detail, 'OpenRouter pricing.inputPerMTok is invalid: -0.000001.');
  });

  // Endpoint fixture helper: prices are quoted per-MTok and converted to the
  // per-token strings the OpenRouter endpoints API returns.
  function endpointFixture(input: {
    provider: string;
    tag?: string;
    inputPerMTok?: number;
    outputPerMTok?: number;
    cacheReadPerMTok?: number;
    contextLength?: number;
    rawPricing?: OpenRouterEndpoint['pricing'];
  }): OpenRouterEndpoint {
    const perToken = (value: number | undefined): string | undefined =>
      value === undefined ? undefined : (value / 1_000_000).toFixed(12);
    return {
      provider_name: input.provider,
      tag: input.tag,
      context_length: input.contextLength,
      pricing: input.rawPricing ?? {
        prompt: perToken(input.inputPerMTok),
        completion: perToken(input.outputPerMTok),
        input_cache_read: perToken(input.cacheReadPerMTok),
      },
    };
  }

  it('accepts kimi-k3-style pricing when the registry covers the first-party endpoint (HOK-3138 acceptance 1)', () => {
    const registry: ModelRegistry = {
      models: {
        'kimi-k3': makeModel({
          costPerMillionInputTokensUsd: 3,
          costPerMillionOutputTokensUsd: 15,
          pricing: { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheReadCostPerMTok: 0.31 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'moonshotai/kimi-k3' },
        }),
      },
      ladders: {},
    };
    // Top-level block is Relace, the cheapest-prompt endpoint: prompt ==
    // cache_read with no cache discount, unlike every real Moonshot route.
    const catalog = new Map<string, OpenRouterModel>([
      ['moonshotai/kimi-k3', {
        id: 'moonshotai/kimi-k3',
        context_length: 200_000,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.0000006572', completion: '0.00001', input_cache_read: '0.0000006572' },
      }],
    ]);
    const endpoints: OpenRouterEndpoint[] = [
      endpointFixture({ provider: 'Relace', tag: 'relace/fp4', inputPerMTok: 0.6572, outputPerMTok: 10, cacheReadPerMTok: 0.6572 }),
      endpointFixture({ provider: 'Wafer', tag: 'wafer', inputPerMTok: 1.4417, outputPerMTok: 14, cacheReadPerMTok: 0.3 }),
      endpointFixture({ provider: 'Moonshot AI', tag: 'moonshotai/mxfp4', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 }),
      endpointFixture({ provider: 'HostA', tag: 'host-a/fp8', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 }),
      endpointFixture({ provider: 'HostB', tag: 'host-b/fp8', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 }),
    ];

    const withEndpoints = auditOpenRouterAliases({
      registry,
      openRouterModels: catalog,
      openRouterEndpoints: new Map([['moonshotai/kimi-k3', endpoints]]),
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'live',
    });
    assert.deepEqual(withEndpoints.findings, []);

    // Without endpoints the audit falls back to the top-level block and
    // reports the pre-HOK-3138 false positive; this documents the bug.
    const withoutEndpoints = auditOpenRouterAliases({
      registry,
      openRouterModels: catalog,
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'file',
    });
    assert.deepEqual(
      withoutEndpoints.findings.map((finding) => [finding.reason, finding.referenceSource]),
      [['pricing-drift', 'catalog-top-level']],
    );
    assert.match(withoutEndpoints.findings[0]?.detail ?? '', /cacheReadPerMTok drift/);
  });

  it('reports glm-5.2-style cache drift against the first-party endpoint (HOK-3138 acceptance 2+3)', () => {
    const registry: ModelRegistry = {
      models: {
        'glm-5.2': makeModel({
          costPerMillionInputTokensUsd: 1.45,
          costPerMillionOutputTokensUsd: 4.55,
          pricing: { inputCostPerMTok: 1.45, outputCostPerMTok: 4.55, cacheReadCostPerMTok: 0.2 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'z-ai/glm-5.2' },
        }),
      },
      ladders: {},
    };
    const catalog = new Map<string, OpenRouterModel>([
      ['z-ai/glm-5.2', {
        id: 'z-ai/glm-5.2',
        context_length: 200_000,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.00000041', completion: '0.00000399', input_cache_read: '0.00000026' },
      }],
    ]);
    const endpoints: OpenRouterEndpoint[] = [
      endpointFixture({ provider: 'Wafer', tag: 'wafer', inputPerMTok: 0.41, outputPerMTok: 3.99, cacheReadPerMTok: 0.26 }),
      endpointFixture({ provider: 'Morph', tag: 'morph/fp8', inputPerMTok: 0.55, outputPerMTok: 4.1, cacheReadPerMTok: 0.1 }),
      endpointFixture({ provider: 'Z.AI', tag: 'z-ai/fp8', inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26 }),
    ];

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: catalog,
      openRouterEndpoints: new Map([['z-ai/glm-5.2', endpoints]]),
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'live',
    });

    // Registry input 1.45 >= first-party 1.40: no input finding even though
    // Wafer's 0.41 prompt price is far lower. Only the cache dimension drifts.
    assert.equal(report.findings.length, 1);
    const finding = report.findings[0];
    assert.equal(finding?.reason, 'pricing-drift');
    assert.equal(
      finding?.detail,
      'cacheReadPerMTok drift for pricing.cacheReadCostPerMTok: registry 0.2 understates first-party reference Z.AI (z-ai/fp8) 0.26.',
    );
    assert.equal(finding?.referenceProvider, 'Z.AI');
    assert.equal(finding?.referenceSource, 'first-party');
    assert.equal(finding?.expected, 0.26);
    assert.equal(finding?.actual, 0.2);
  });

  it('uses the per-endpoint lower median when no first-party endpoint exists', () => {
    const registry: ModelRegistry = {
      models: {
        'llama-4-maverick': makeModel({
          pricing: { inputCostPerMTok: 1, outputCostPerMTok: 2, cacheReadCostPerMTok: 0.005 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'meta-llama/llama-4-maverick' },
        }),
      },
      ladders: {},
    };
    // Prompt and cache orderings differ: the per-dimension cache median would
    // be 0.02, but the reference endpoint is B so expected cache is 0.01.
    const endpoints: OpenRouterEndpoint[] = [
      endpointFixture({ provider: 'HostA', tag: 'host-a', inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.5 }),
      endpointFixture({ provider: 'HostB', tag: 'host-b', inputPerMTok: 0.2, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 }),
      endpointFixture({ provider: 'HostC', tag: 'host-c', inputPerMTok: 0.3, outputPerMTok: 0.6, cacheReadPerMTok: 0.02 }),
    ];

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['meta-llama/llama-4-maverick', {
          id: 'meta-llama/llama-4-maverick',
          context_length: 200_000,
          supported_parameters: ['tools'],
          pricing: { prompt: '0.0000001', completion: '0.0000004', input_cache_read: '0.0000005' },
        }],
      ]),
      openRouterEndpoints: new Map([['meta-llama/llama-4-maverick', endpoints]]),
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'live',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.reason, finding.referenceSource, finding.expected]), [
      ['pricing-drift', 'endpoint-median', 0.01],
    ]);
    assert.match(report.findings[0]?.detail ?? '', /endpoint-median reference HostB \(host-b\) 0\.01/);
  });

  it('picks the lower median deterministically for an even endpoint count', () => {
    const endpoints: OpenRouterEndpoint[] = [
      endpointFixture({ provider: 'HostD', tag: 'host-d', inputPerMTok: 0.4, outputPerMTok: 0.7 }),
      endpointFixture({ provider: 'HostB', tag: 'host-b', inputPerMTok: 0.2, outputPerMTok: 0.5 }),
      endpointFixture({ provider: 'HostA', tag: 'host-a', inputPerMTok: 0.1, outputPerMTok: 0.4 }),
      endpointFixture({ provider: 'HostC', tag: 'host-c', inputPerMTok: 0.3, outputPerMTok: 0.6 }),
    ];
    const reference = selectPricingReference('meta-llama/llama-4-maverick', endpoints);
    assert.equal(reference?.source, 'endpoint-median');
    assert.equal(reference?.provider, 'HostB');
    assert.equal(reference?.tag, 'host-b');
  });

  it('selects the standard tier among multiple first-party tiers', () => {
    const endpoints: OpenRouterEndpoint[] = [
      endpointFixture({ provider: 'Google AI Studio', tag: 'google-ai-studio/flex', inputPerMTok: 0.625, outputPerMTok: 1.25 }),
      endpointFixture({ provider: 'Google AI Studio', tag: 'google-ai-studio', inputPerMTok: 1.25, outputPerMTok: 2.5 }),
      endpointFixture({ provider: 'Google AI Studio', tag: 'google-ai-studio/priority', inputPerMTok: 2.25, outputPerMTok: 4.5 }),
      endpointFixture({ provider: 'CheapHost', tag: 'cheap-host', inputPerMTok: 0.3, outputPerMTok: 0.9 }),
    ];
    const makeGeminiRegistry = (inputPrice: number): ModelRegistry => ({
      models: {
        'gemini-2.5-flash': makeModel({
          costPerMillionInputTokensUsd: inputPrice,
          costPerMillionOutputTokensUsd: 2.5,
          pricing: { inputCostPerMTok: inputPrice, outputCostPerMTok: 2.5 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'google/gemini-2.5-flash' },
        }),
      },
      ladders: {},
    });
    const catalog = new Map<string, OpenRouterModel>([
      ['google/gemini-2.5-flash', {
        id: 'google/gemini-2.5-flash',
        context_length: 200_000,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.0000003', completion: '0.0000009' },
      }],
    ]);
    const audit = (inputPrice: number) => auditOpenRouterAliases({
      registry: makeGeminiRegistry(inputPrice),
      openRouterModels: catalog,
      openRouterEndpoints: new Map([['google/gemini-2.5-flash', endpoints]]),
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'live',
    });

    // Registry at the standard tier: neither the flex discount nor the
    // priority surcharge produces a finding.
    assert.deepEqual(audit(1.25).findings, []);

    // Understating the standard tier drifts against it, not flex or priority.
    const drifted = audit(1).findings;
    assert.equal(drifted.length, 2);
    for (const finding of drifted) {
      assert.equal(finding.reason, 'pricing-drift');
      assert.equal(finding.expected, 1.25);
      assert.match(finding.detail, /first-party reference Google AI Studio \(google-ai-studio\) 1\.25/);
    }
  });

  it('tolerates registry prices within 1% below the reference', () => {
    const makeToleranceRegistry = (inputPrice: number | undefined): ModelRegistry => ({
      models: {
        'qwen-3-coder': makeModel({
          costPerMillionInputTokensUsd: 1,
          costPerMillionOutputTokensUsd: 2,
          pricing: inputPrice === undefined
            ? { outputCostPerMTok: 2 }
            : { inputCostPerMTok: inputPrice, outputCostPerMTok: 2 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    });
    const catalog = new Map<string, OpenRouterModel>([
      ['qwen/qwen3-coder', {
        id: 'qwen/qwen3-coder',
        context_length: 200_000,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.000001', completion: '0.000002' },
      }],
    ]);
    const audit = (inputPrice: number | undefined) => auditOpenRouterAliases({
      registry: makeToleranceRegistry(inputPrice),
      openRouterModels: catalog,
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(audit(0.995).findings, []);
    assert.deepEqual(audit(0.98).findings.map((finding) => [finding.reason, finding.actual]), [
      ['pricing-drift', 0.98],
    ]);
    assert.deepEqual(audit(undefined).findings.map((finding) => [finding.reason, finding.actual]), [
      ['pricing-drift', null],
    ]);
  });

  it('checks the context window against the max across endpoints when present', () => {
    const makeGlmRegistry = (contextWindowTokens: number): ModelRegistry => ({
      models: {
        'glm-5.3-flash': makeModel({
          contextWindowTokens,
          pricing: { inputCostPerMTok: 1, outputCostPerMTok: 2 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'z-ai/glm-5.3-flash' },
        }),
      },
      ladders: {},
    });
    const catalog = new Map<string, OpenRouterModel>([
      ['z-ai/glm-5.3-flash', {
        id: 'z-ai/glm-5.3-flash',
        context_length: 1_310_720,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.0000001', completion: '0.0000005' },
      }],
    ]);
    const endpoints: OpenRouterEndpoint[] = [
      endpointFixture({ provider: 'Z.AI', tag: 'z-ai/fp8', inputPerMTok: 0.15, outputPerMTok: 0.5, contextLength: 1_048_576 }),
      endpointFixture({ provider: 'HostA', tag: 'host-a', inputPerMTok: 0.2, outputPerMTok: 0.6, contextLength: 786_432 }),
    ];
    const audit = (contextWindowTokens: number) => auditOpenRouterAliases({
      registry: makeGlmRegistry(contextWindowTokens),
      openRouterModels: catalog,
      openRouterEndpoints: new Map([['z-ai/glm-5.3-flash', endpoints]]),
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'live',
    });

    // The top-level 1310720 would accept the overstated registry window; the
    // max endpoint context 1048576 is the real capability bound.
    const overstated = audit(1_310_720).findings;
    assert.deepEqual(overstated.map((finding) => finding.reason), ['context-window-overstated']);
    assert.match(overstated[0]?.detail ?? '', /max OpenRouter endpoint context length 1048576/);

    assert.deepEqual(audit(1_048_576).findings, []);
  });

  it('falls back to top-level pricing for empty or all-invalid endpoint lists', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          pricing: { inputCostPerMTok: 1, outputCostPerMTok: 2 },
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };
    const catalog = new Map<string, OpenRouterModel>([
      ['qwen/qwen3-coder', {
        id: 'qwen/qwen3-coder',
        context_length: 200_000,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.000001', completion: '0.000002' },
      }],
    ]);
    const audit = (endpoints: OpenRouterEndpoint[]) => auditOpenRouterAliases({
      registry,
      openRouterModels: catalog,
      openRouterEndpoints: new Map([['qwen/qwen3-coder', endpoints]]),
      now: new Date('2026-10-01T00:00:00.000Z'),
      catalogSource: 'live',
    });

    // Registry matches the top-level block exactly, so a clean fallback
    // produces no findings — and invalid endpoints never add invalid-pricing
    // findings of their own.
    assert.deepEqual(audit([]).findings, []);
    assert.deepEqual(audit([
      endpointFixture({ provider: 'Broken', tag: 'broken', rawPricing: { prompt: '-1', completion: '0.000001' } }),
      endpointFixture({ provider: 'NoPrompt', tag: 'no-prompt', rawPricing: { completion: '0.000001' } }),
    ]).findings, []);
  });

  it('classifies first-party endpoints by author slug mapping and fallback heuristic', () => {
    assert.equal(isFirstPartyEndpoint('qwen/qwen3-coder', { tag: 'alibaba/opensource' }), true);
    assert.equal(isFirstPartyEndpoint('mistralai/mistral-medium-3-5', { tag: 'mistral/eu' }), true);
    assert.equal(isFirstPartyEndpoint('meta-llama/llama-4-maverick', { tag: 'google-vertex' }), false);
    // Unknown author: tag slug === author heuristic.
    assert.equal(isFirstPartyEndpoint('stealth/ox-alpha', { tag: 'stealth' }), true);
    // No tag: the slugified provider_name is compared instead.
    assert.equal(isFirstPartyEndpoint('moonshotai/kimi-k3', { provider_name: 'Moonshot AI' }), false);
    assert.equal(isFirstPartyEndpoint('z-ai/glm-5.2', { provider_name: 'Z AI' }), true);
  });

  it('parses endpoints fixtures in raw-response and bare-array shapes', () => {
    const parsed = parseEndpointsFixture({
      'z-ai/glm-5.2': { data: { endpoints: [{ provider_name: 'Z.AI', tag: 'z-ai/fp8' }] } },
      'moonshotai/kimi-k3': [{ provider_name: 'Moonshot AI', tag: 'moonshotai/mxfp4' }],
    });
    assert.equal(parsed.get('z-ai/glm-5.2')?.[0]?.tag, 'z-ai/fp8');
    assert.equal(parsed.get('moonshotai/kimi-k3')?.[0]?.tag, 'moonshotai/mxfp4');
    assert.throws(() => parseEndpointsFixture([{}]), /keyed by model id/);
    assert.throws(() => parseEndpointsFixture({ 'z-ai/glm-5.2': { data: {} } }), /no endpoints array/);
  });

  it('reports blocked provider drift as non-selectable', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', {
          id: 'qwen/qwen3-coder',
          context_length: 131_072,
          supported_parameters: ['temperature'],
        }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.selectableFindings, 0);
    assert.deepEqual(report.findings.map((finding) => [finding.reason, finding.selectable]), [
      ['context-window-overstated', false],
      ['tool-support-mismatch', false],
    ]);
  });
});
