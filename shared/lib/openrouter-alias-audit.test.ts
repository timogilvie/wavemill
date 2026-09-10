import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditOpenRouterAliases } from './openrouter-alias-audit.ts';
import type { ModelRegistry } from './model-registry.ts';
import type { OpenRouterModel } from './openrouter-catalog.ts';

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
      'inputPerMTok drift for costPerMillionInputTokensUsd: provider price 1 exceeds registry 0.5.',
      'cacheWritePerMTok drift for pricing.cacheWriteCostPerMTok: provider price 1.25 exceeds registry null.',
    ]);
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
