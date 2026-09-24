import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCatalogSnapshot,
  CATALOG_SCHEMA_VERSION,
  defaultLaunchPriorityFixturePath,
  fetchOpenRouterModels,
  hashLaunchPriorityFixture,
  hasTier1ActiveBlockers,
  loadLaunchPriorityFixture,
  loadLaunchPriorityList,
  normalizeCatalog,
  validatePromotionPricing,
  OPENROUTER_MODELS_URL,
  resolveOpenRouterModelIdentity,
  resolveWavemillAliasFromOpenRouterId,
  resolveOpenRouterIdFromWavemillAlias,
  serializeSnapshot,
  type LaunchPriorityFixture,
  type LaunchPriorityModel,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import { getFamilyCapabilities } from './openrouter-capabilities.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-catalog-test-'));
}

function writeFixture(dir: string, fixture: LaunchPriorityFixture): string {
  const path = join(dir, 'fixture.json');
  writeFileSync(path, JSON.stringify(fixture, null, 2), 'utf-8');
  return path;
}

function buildOpenRouterMap(models: OpenRouterModel[]): Map<string, OpenRouterModel> {
  return new Map(models.map((m) => [m.id, m]));
}

const FIXED_RESOLVED_AT = '2026-06-15T12:00:00.000Z';

describe('loadLaunchPriorityFixture', () => {
  it('reads and parses a fixture file', () => {
    const dir = makeTempDir();
    try {
      const fixture: LaunchPriorityFixture = {
        schemaVersion: '1',
        models: [
          {
            wavemillAlias: 'test-model',
            openrouterId: 'vendor/test-model',
            family: 'qwen',
            status: 'active',
            priorityTier: 1,
            roleEligibility: ['coding'],
          },
        ],
      };
      const path = writeFixture(dir, fixture);
      const loaded = loadLaunchPriorityFixture(path);
      assert.equal(loaded.schemaVersion, '1');
      assert.equal(loaded.models.length, 1);
      assert.equal(loaded.models[0]?.wavemillAlias, 'test-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on missing models array', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'bad.json');
      writeFileSync(path, JSON.stringify({ schemaVersion: '1' }), 'utf-8');
      assert.throws(() => loadLaunchPriorityFixture(path), /missing "models" array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default fixture loads and contains launch-priority models', () => {
    const list = loadLaunchPriorityList();
    assert.ok(list.length >= 25, `expected at least 25 launch-priority models, got ${list.length}`);
    const aliases = new Set(list.map((m) => m.wavemillAlias));
    for (const required of ['gpt-5.5', 'deepseek-r1', 'kimi-k2', 'glm-5.2', 'glm-5.3', 'kimi-k3', 'gemini-3.8-flash', 'kimi-k2.7-code']) {
      assert.ok(aliases.has(required), `expected fixture to include ${required}`);
    }
  });

  it('hashes the fixture deterministically', () => {
    const a = hashLaunchPriorityFixture();
    const b = hashLaunchPriorityFixture();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('is invariant to reformatting, because catalogHash gates every certification', () => {
    // Re-indenting this fixture (what a JSON round-trip does) used to move
    // catalogHash and silently uncertify the entire native fleet on every
    // machine. Only a real catalog change may move the hash.
    const dir = mkdtempSync(join(tmpdir(), 'fixture-hash-'));
    try {
      const parsed = loadLaunchPriorityFixture();
      const write = (name: string, contents: string): string => {
        const path = join(dir, name);
        writeFileSync(path, contents);
        return path;
      };
      const compact = write('compact.json', JSON.stringify(parsed));
      const indented = write('indented.json', `${JSON.stringify(parsed, null, 4)}\n`);
      const reordered = write(
        'reordered.json',
        JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()), null, 2),
      );

      const baseline = hashLaunchPriorityFixture(compact);
      assert.equal(hashLaunchPriorityFixture(indented), baseline, 'indentation must not matter');
      assert.equal(hashLaunchPriorityFixture(reordered), baseline, 'top-level key order must not matter');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still changes when the catalog actually changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-hash-semantic-'));
    try {
      const parsed = loadLaunchPriorityFixture() as { models: Array<Record<string, unknown>> };
      const basePath = join(dir, 'base.json');
      writeFileSync(basePath, JSON.stringify(parsed, null, 2));

      const mutated = JSON.parse(JSON.stringify(parsed)) as typeof parsed;
      mutated.models[0]!.status = 'deprecated';
      const mutatedPath = join(dir, 'mutated.json');
      writeFileSync(mutatedPath, JSON.stringify(mutated, null, 2));

      assert.notEqual(hashLaunchPriorityFixture(mutatedPath), hashLaunchPriorityFixture(basePath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a byte hash rather than throwing on an unparseable fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-hash-corrupt-'));
    try {
      const path = join(dir, 'corrupt.json');
      writeFileSync(path, '{ not valid json');
      assert.match(hashLaunchPriorityFixture(path), /^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fetchOpenRouterModels', () => {
  it('returns a Map keyed by model id with injected fetchFn', async () => {
    const fakeFetch = (async (url: string) => {
      assert.equal(url, OPENROUTER_MODELS_URL);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [
            { id: 'a/b', name: 'A/B', context_length: 1024 },
            { id: 'c/d', name: 'C/D', context_length: 2048 },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const map = await fetchOpenRouterModels(fakeFetch);
    assert.equal(map.size, 2);
    assert.equal(map.get('a/b')?.context_length, 1024);
    assert.equal(map.get('c/d')?.context_length, 2048);
  });

  it('throws on non-OK HTTP response', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await assert.rejects(() => fetchOpenRouterModels(fakeFetch), /HTTP 503/);
  });

  it('throws when response body has no data array', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ wrong: 'shape' }),
    })) as unknown as typeof fetch;
    await assert.rejects(() => fetchOpenRouterModels(fakeFetch), /missing "data" array/);
  });
});

describe('OpenRouter alias mapping', () => {
  it('resolves known aliases and ids in both directions', () => {
    assert.equal(resolveWavemillAliasFromOpenRouterId('qwen/qwen3-coder'), 'qwen-3-coder');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('qwen-3-coder'), 'qwen/qwen3-coder');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('glm-5.2'), 'z-ai/glm-5.2');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('kimi-k2.7-code'), 'moonshotai/kimi-k2.7-code');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('ox-alpha'), 'stealth/ox-alpha');
    assert.equal(resolveWavemillAliasFromOpenRouterId('stealth/ox-alpha'), 'ox-alpha');
  });

  it('returns null instead of throwing for unknown aliases', () => {
    assert.equal(resolveOpenRouterIdFromWavemillAlias('does-not-exist'), null);
  });

  it('drops retired aliases from the fixture while keeping deprecated rows retained', () => {
    const byAlias = new Map(loadLaunchPriorityList().map((model) => [model.wavemillAlias, model]));
    // HOK-2947 removed the stale rows outright.
    for (const alias of ['deepseek-coder-v2', 'gemini-2.0-flash', 'qwen-2.5-coder-32b', 'qwen-2.5-72b', 'llama-3.3-70b', 'llama-4-scout', 'devstral-small']) {
      assert.equal(byAlias.get(alias), undefined, `${alias} should be removed from the fixture`);
    }
    assert.equal(byAlias.get('grok-code-fast')?.status, 'deprecated', 'grok-code-fast should remain as deprecated');
    // HOK-3081 retired devstral-medium; both the registry launch-priority
    // projection and the bundled fixture must classify it as deprecated so no
    // catalog consumer still treats it as a watchlist row.
    assert.equal(byAlias.get('devstral-medium')?.status, 'deprecated', 'devstral-medium should remain as deprecated');
    const bundled = new Map(loadLaunchPriorityFixture(defaultLaunchPriorityFixturePath())
      .models.map((model) => [model.wavemillAlias, model]));
    assert.equal(bundled.get('devstral-medium')?.status, 'deprecated', 'bundled launch-priority fixture should mark devstral-medium deprecated');
  });

  it('resolves Kimi/Qwen/GLM/Ox aliases and ids through one native OpenRouter identity', () => {
    const cases = [
      ['qwen-3-coder', 'qwen/qwen3-coder'],
      ['glm-5.2', 'z-ai/glm-5.2'],
      ['kimi-k2.7-code', 'moonshotai/kimi-k2.7-code'],
      ['ox-alpha', 'stealth/ox-alpha'],
    ] as const;

    for (const [alias, openrouterId] of cases) {
      const fromAlias = resolveOpenRouterModelIdentity(alias);
      const fromId = resolveOpenRouterModelIdentity(openrouterId);
      assert.ok(fromAlias, `expected identity for ${alias}`);
      assert.ok(fromId, `expected identity for ${openrouterId}`);
      assert.equal(fromAlias!.wavemillAlias, alias);
      assert.equal(fromAlias!.openrouterId, openrouterId);
      assert.equal(fromAlias!.nativeOpenRouter, true);
      assert.equal(fromId!.wavemillAlias, alias);
      assert.equal(fromId!.openrouterId, openrouterId);
      assert.deepEqual(fromAlias!.equivalentIds, [alias, openrouterId]);
      assert.deepEqual(fromId!.equivalentIds, [alias, openrouterId]);
    }
  });
});

describe('resolveWavemillAliasFromOpenRouterId', () => {
  it('maps OpenRouter ids back to Wavemill aliases', () => {
    assert.equal(resolveWavemillAliasFromOpenRouterId('openai/gpt-5.5'), 'gpt-5.5');
    assert.equal(resolveWavemillAliasFromOpenRouterId('qwen/qwen3-coder'), 'qwen-3-coder');
  });

  it('returns null for unknown ids', () => {
    assert.equal(resolveWavemillAliasFromOpenRouterId('vendor/missing'), null);
  });
});

describe('normalizeCatalog', () => {
  function lp(partial: Partial<LaunchPriorityModel>): LaunchPriorityModel {
    return {
      wavemillAlias: partial.wavemillAlias ?? 'alias',
      openrouterId: partial.openrouterId ?? 'vendor/model',
      family: partial.family ?? 'qwen',
      status: partial.status ?? 'active',
      priorityTier: partial.priorityTier ?? 2,
      roleEligibility: partial.roleEligibility ?? ['coding'],
    };
  }

  it('Qwen: resolves qwen-2.5-coder-32b-instruct with pricing and context', () => {
    const list = [
      lp({
        wavemillAlias: 'qwen-2.5-coder-32b',
        openrouterId: 'qwen/qwen-2.5-coder-32b-instruct',
        family: 'qwen',
        priorityTier: 1,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'qwen/qwen-2.5-coder-32b-instruct',
        name: 'Qwen 2.5 Coder 32B Instruct',
        context_length: 32768,
        pricing: { prompt: '0.0000002', completion: '0.0000006' },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.wavemillAlias, 'qwen-2.5-coder-32b');
    assert.equal(entry.family, 'qwen');
    assert.equal(entry.contextTokens, 32768);
    assert.ok(
      Math.abs((entry.pricing.inputPerMTok ?? 0) - 0.2) < 1e-9,
      `expected ~0.2, got ${entry.pricing.inputPerMTok}`,
    );
    assert.ok(
      Math.abs((entry.pricing.outputPerMTok ?? 0) - 0.6) < 1e-9,
      `expected ~0.6, got ${entry.pricing.outputPerMTok}`,
    );
    assert.deepEqual(entry.capabilities, {
      supportsTools: true,
      supportsStreaming: true,
      supportsTemperature: true,
      temperatureRange: [0, 2],
    });
    assert.deepEqual(entry.roleEligibility, ['coding']);
    assert.equal(entry.resolvedAt, FIXED_RESOLVED_AT);
  });

  it('DeepSeek: per-token pricing normalized to per-MTok', () => {
    const list = [
      lp({
        wavemillAlias: 'deepseek-r1',
        openrouterId: 'deepseek/deepseek-r1',
        family: 'deepseek',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'deepseek/deepseek-r1',
        context_length: 65536,
        pricing: { prompt: '0.00000055', completion: '0.0000022' },
      },
    ]);
    const { entries } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    const entry = entries[0]!;
    assert.equal(entry.family, 'deepseek');
    assert.ok(Math.abs((entry.pricing.inputPerMTok ?? 0) - 0.55) < 1e-9);
    assert.ok(Math.abs((entry.pricing.outputPerMTok ?? 0) - 2.2) < 1e-9);
  });

  it('Kimi: resolves moonshotai/kimi-k2 as family kimi', () => {
    const list = [
      lp({
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'moonshotai/kimi-k2',
        context_length: 200000,
        pricing: { prompt: '0.000001', completion: '0.000003' },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries[0]?.family, 'kimi');
    assert.equal(entries[0]?.openrouterId, 'moonshotai/kimi-k2');
    assert.equal(entries[0]?.contextTokens, 200000);
  });

  it('Ox Alpha: normalizes verified provisional metadata without cache fallback', () => {
    const list = [
      lp({
        wavemillAlias: 'ox-alpha',
        openrouterId: 'stealth/ox-alpha',
        family: 'unknown',
        status: 'provisional',
        priorityTier: 3,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'stealth/ox-alpha',
        name: 'Ox Alpha',
        context_length: 1_048_576,
        top_provider: {
          context_length: 1_048_576,
        },
        supported_parameters: [
          'include_reasoning',
          'max_tokens',
          'reasoning',
          'reasoning_effort',
          'response_format',
          'temperature',
          'tool_choice',
          'tools',
          'top_k',
          'top_p',
        ],
        pricing: { prompt: '0', completion: '0' },
      },
    ]);

    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });

    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      wavemillAlias: 'ox-alpha',
      openrouterId: 'stealth/ox-alpha',
      family: 'unknown',
      contextTokens: 1_048_576,
      pricing: {
        inputPerMTok: 0,
        outputPerMTok: 0,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      capabilities: getFamilyCapabilities('unknown'),
      roleEligibility: ['planning', 'coding', 'review'],
      status: 'provisional',
      priorityTier: 3,
      resolvedAt: FIXED_RESOLVED_AT,
    });
  });

  it('GPT and Kimi aliases both resolve via their OpenRouter ids', () => {
    const list: LaunchPriorityModel[] = [
      lp({
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
      lp({
        wavemillAlias: 'gpt-5.5',
        openrouterId: 'openai/gpt-5.5',
        family: 'gpt',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'moonshotai/kimi-k2',
        context_length: 200000,
        pricing: { prompt: '0.000015', completion: '0.000075' },
      },
      {
        id: 'openai/gpt-5.5',
        context_length: 400000,
        pricing: { prompt: '0.000005', completion: '0.000020' },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 2);
    const byAlias = new Map(entries.map((e) => [e.wavemillAlias, e]));
    assert.equal(byAlias.get('kimi-k2')?.family, 'kimi');
    assert.equal(byAlias.get('kimi-k2')?.contextTokens, 200000);
    assert.equal(byAlias.get('gpt-5.5')?.family, 'gpt');
    assert.equal(byAlias.get('gpt-5.5')?.contextTokens, 400000);
    assert.equal(byAlias.get('gpt-5.5')?.pricing.inputPerMTok, 5);
    assert.equal(byAlias.get('gpt-5.5')?.pricing.outputPerMTok, 20);
  });

  it('Missing model: produces a not_found_in_openrouter blocker', () => {
    const list = [
      lp({
        wavemillAlias: 'phantom-model',
        openrouterId: 'phantom/unavailable',
        family: 'mistral',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      { id: 'some/other-model', context_length: 1024, pricing: { prompt: '0', completion: '0' } },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(entries.length, 0);
    assert.equal(blockers.length, 1);
    const blocker = blockers[0]!;
    assert.equal(blocker.wavemillAlias, 'phantom-model');
    assert.equal(blocker.reason, 'not_found_in_openrouter');
    assert.equal(blocker.priorityTier, 1);
    assert.equal(blocker.status, 'active');
    assert.match(blocker.detail, /phantom\/unavailable/);
  });

  it('Deprecated models are reported as blockers, not entries', () => {
    const list = [
      lp({
        wavemillAlias: 'o3-mini',
        openrouterId: 'openai/o3-mini',
        family: 'gpt',
        status: 'deprecated',
        priorityTier: 3,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      { id: 'openai/o3-mini', context_length: 1024, pricing: { prompt: '0.000001', completion: '0.000004' } },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(entries.length, 0);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.reason, 'deprecated');
  });

  it('handles missing pricing by emitting nulls without blocking', () => {
    const list = [
      lp({
        wavemillAlias: 'free-model',
        openrouterId: 'vendor/free',
        family: 'llama',
        status: 'watchlist',
        priorityTier: 3,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([{ id: 'vendor/free', context_length: 8192 }]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pricing.inputPerMTok, null);
    assert.equal(entries[0]?.pricing.outputPerMTok, null);
    assert.equal(entries[0]?.pricing.cacheReadPerMTok, null);
    assert.equal(entries[0]?.pricing.cacheWritePerMTok, null);
  });

  it('normalizes all advertised pricing dimensions and preserves explicit zero', () => {
    const list = [
      lp({
        wavemillAlias: 'priced-model',
        openrouterId: 'vendor/priced',
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'vendor/priced',
        pricing: {
          prompt: '0.000001',
          completion: '0.000002',
          input_cache_read: '0',
          input_cache_write: 0,
        },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });

    assert.equal(blockers.length, 0);
    assert.deepEqual(entries[0]?.pricing, {
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
    });
  });

  it('preserves absent cache prices separately from advertised zero', () => {
    const list = [
      lp({
        wavemillAlias: 'base-priced-model',
        openrouterId: 'vendor/base-priced',
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'vendor/base-priced',
        pricing: {
          prompt: '0.000001',
          completion: '0.000002',
        },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });

    assert.equal(blockers.length, 0);
    assert.deepEqual(entries[0]?.pricing, {
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    });
  });

  it('blocks malformed, non-finite, and negative advertised pricing', () => {
    const cases: Array<[string, OpenRouterModel['pricing']]> = [
      ['negative', { prompt: '-0.000001', completion: '0.000002' }],
      ['nan', { prompt: 'NaN', completion: '0.000002' }],
      ['infinite', { prompt: Infinity, completion: '0.000002' }],
      ['malformed', { prompt: 'abc', completion: '0.000002' }],
      ['empty', { prompt: '', completion: '0.000002' }],
      ['wrong-type', { prompt: true as unknown as number, completion: '0.000002' }],
    ];

    for (const [name, pricing] of cases) {
      const list = [
        lp({
          wavemillAlias: `bad-${name}`,
          openrouterId: `vendor/bad-${name}`,
        }),
      ];
      const map = buildOpenRouterMap([{ id: `vendor/bad-${name}`, pricing }]);
      const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });

      assert.equal(entries.length, 0, name);
      assert.equal(blockers.length, 1, name);
      assert.equal(blockers[0]?.reason, 'invalid_pricing', name);
      assert.match(blockers[0]?.detail ?? '', /pricing\.inputPerMTok/, name);
    }
  });

  it('falls back to top_provider.context_length when context_length is absent', () => {
    const list = [
      lp({
        wavemillAlias: 'tp-model',
        openrouterId: 'vendor/tp',
        family: 'gemini',
        status: 'active',
        priorityTier: 2,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      { id: 'vendor/tp', top_provider: { context_length: 12345 } },
    ]);
    const { entries } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(entries[0]?.contextTokens, 12345);
  });
});

describe('buildCatalogSnapshot', () => {
  it('produces a deterministic snapshot sorted by tier and alias', () => {
    const list: LaunchPriorityModel[] = [
      {
        wavemillAlias: 'beta-model',
        openrouterId: 'vendor/beta',
        family: 'qwen',
        status: 'active',
        priorityTier: 2,
        roleEligibility: ['coding'],
      },
      {
        wavemillAlias: 'alpha-model',
        openrouterId: 'vendor/alpha',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding'],
      },
    ];
    const map = buildOpenRouterMap([
      { id: 'vendor/alpha', context_length: 1024, pricing: { prompt: '0', completion: '0' } },
      { id: 'vendor/beta', context_length: 2048, pricing: { prompt: '0', completion: '0' } },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    const snapshot = buildCatalogSnapshot(entries, blockers, 'abc123', {
      generatedAt: FIXED_RESOLVED_AT,
    });
    assert.equal(snapshot.schemaVersion, CATALOG_SCHEMA_VERSION);
    assert.equal(snapshot.sourceHash, 'abc123');
    assert.equal(snapshot.generatedAt, FIXED_RESOLVED_AT);
    assert.deepEqual(
      snapshot.entries.map((e) => e.wavemillAlias),
      ['alpha-model', 'beta-model'],
    );
  });

  it('serializeSnapshot produces stable output regardless of input key order', () => {
    const snapshotA = buildCatalogSnapshot(
      [
        {
          wavemillAlias: 'm',
          openrouterId: 'v/m',
          family: 'qwen',
          contextTokens: 1024,
          pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: null, cacheWritePerMTok: null },
          roleEligibility: ['coding'],
          status: 'active',
          priorityTier: 1,
          resolvedAt: FIXED_RESOLVED_AT,
        },
      ],
      [],
      'hash',
      { generatedAt: FIXED_RESOLVED_AT },
    );
    const first = serializeSnapshot(snapshotA);
    const second = serializeSnapshot(snapshotA);
    assert.equal(first, second);
    assert.match(first, /"schemaVersion": "1"/);
  });
});

describe('validatePromotionPricing', () => {
  it('accepts finite matching prices for advertised provider dimensions', () => {
    const result = validatePromotionPricing(
      {
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      {
        pricing: {
          inputPerMTok: 1,
          outputPerMTok: 2,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      },
    );

    assert.deepEqual(result, { ok: true, errors: [] });
  });

  it('requires advertised cache prices to be present and exact', () => {
    const result = validatePromotionPricing(
      {
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: null,
        cacheWritePerMTok: 1.25,
      },
      {
        pricing: {
          inputPerMTok: 1,
          outputPerMTok: 2,
          cacheReadPerMTok: 0.1,
          cacheWritePerMTok: 1.25,
        },
      },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['cacheReadPerMTok must be provided for promotion']);
  });

  it('rejects missing catalog input or output pricing for promotion', () => {
    const result = validatePromotionPricing(
      {
        inputPerMTok: 0,
        outputPerMTok: 2,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      {
        pricing: {
          inputPerMTok: null,
          outputPerMTok: 2,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['inputPerMTok must be advertised by the catalog for promotion']);
  });

  it('rejects fallback-derived cache prices when the provider omits cache pricing', () => {
    const result = validatePromotionPricing(
      {
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: null,
      },
      {
        pricing: {
          inputPerMTok: 1,
          outputPerMTok: 2,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['cacheReadPerMTok mismatch: spec=0.1 catalog=null']);
  });
});

describe('hasTier1ActiveBlockers', () => {
  it('returns true only when an active tier-1 model is blocked', () => {
    assert.equal(
      hasTier1ActiveBlockers([
        {
          wavemillAlias: 'x',
          openrouterId: 'v/x',
          family: 'qwen',
          status: 'active',
          priorityTier: 1,
          reason: 'not_found_in_openrouter',
          detail: '',
        },
      ]),
      true,
    );
    assert.equal(
      hasTier1ActiveBlockers([
        {
          wavemillAlias: 'x',
          openrouterId: 'v/x',
          family: 'qwen',
          status: 'watchlist',
          priorityTier: 1,
          reason: 'not_found_in_openrouter',
          detail: '',
        },
      ]),
      false,
    );
    assert.equal(
      hasTier1ActiveBlockers([
        {
          wavemillAlias: 'x',
          openrouterId: 'v/x',
          family: 'gpt',
          status: 'deprecated',
          priorityTier: 1,
          reason: 'deprecated',
          detail: '',
        },
      ]),
      false,
    );
  });
});
