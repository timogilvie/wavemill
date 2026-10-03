import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ModelRegistry } from '../shared/lib/model-registry.ts';
import type { OpenRouterModel } from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterAliasAuditCommand } from './audit-openrouter-aliases.ts';

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openrouter-alias-audit-'));
  tempDirs.push(dir);
  return dir;
}

function makeModel(lifecycle: 'supported' | 'blocked' = 'supported'): ModelRegistry['models'][string] {
  return {
    vendor: 'test',
    class: 'fast_economy',
    strengths: ['test'],
    weaknesses: ['test'],
    qualityScores: { routing: 0, planning: 0, coding: 80, review: 0, classify: 0 },
    // Above the built-in coding floor (144_384) so the context-window predicate
    // does not exclude this fixture from selectability.
    contextWindowTokens: 200_000,
    toolSupport: 'basic',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 2,
    pricing: { inputCostPerMTok: 1, outputCostPerMTok: 2 },
    agent: 'native-openrouter',
    supportedModel: { lifecycle, stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
  };
}

function captureOutput() {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  return {
    stdout,
    stderr,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('audit-openrouter-aliases command', () => {
  it('writes a report and exits zero when findings are retired only', async () => {
    const repoDir = makeTempRepo();
    const output = captureOutput();
    try {
      const code = await runOpenRouterAliasAuditCommand({
        'catalog-json': undefined,
        'endpoints-json': undefined,
        fixture: false,
        output: undefined,
        'repo-dir': repoDir,
        json: false,
        'no-write': false,
      }, {
        fetchCatalog: async () => new Map<string, OpenRouterModel>(),
        fetchEndpoints: async () => [],
        registry: { models: { 'deepseek-coder-v2': makeModel('blocked') }, ladders: {} },
        now: () => new Date('2026-08-18T00:00:00.000Z'),
      });

      assert.equal(code, 0);
      const path = join(repoDir, '.wavemill', 'audits', 'openrouter-alias-drift.json');
      assert.equal(existsSync(path), true);
      const report = JSON.parse(readFileSync(path, 'utf-8')) as { schemaVersion: string; selectableFindings: number };
      assert.equal(report.schemaVersion, '2');
      assert.equal(report.selectableFindings, 0);
      assert.match(output.stdout.join('\n'), /retired - expected/);
    } finally {
      output.restore();
    }
  });

  it('returns one when a selectable alias is missing from the catalog', async () => {
    const repoDir = makeTempRepo();
    const code = await runOpenRouterAliasAuditCommand({
      'catalog-json': undefined,
      'endpoints-json': undefined,
      fixture: false,
      output: undefined,
      'repo-dir': repoDir,
      json: false,
      'no-write': true,
    }, {
      fetchCatalog: async () => new Map<string, OpenRouterModel>(),
      fetchEndpoints: async () => [],
      registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
      now: () => new Date('2026-08-18T00:00:00.000Z'),
    });

    assert.equal(code, 1);
  });

  it('returns one and reports details when selectable pricing drifts', async () => {
    const repoDir = makeTempRepo();
    const output = captureOutput();
    try {
      const code = await runOpenRouterAliasAuditCommand({
        'catalog-json': undefined,
        'endpoints-json': undefined,
        fixture: false,
        output: undefined,
        'repo-dir': repoDir,
        json: true,
        'no-write': true,
      }, {
        fetchCatalog: async () => new Map<string, OpenRouterModel>([
          ['qwen/qwen3-coder', {
            id: 'qwen/qwen3-coder',
            context_length: 200_000,
            supported_parameters: ['tools'],
            pricing: { prompt: '0.000001', completion: '0.000003' },
          }],
        ]),
        fetchEndpoints: async () => [],
        registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
        now: () => new Date('2026-08-18T00:00:00.000Z'),
      });

      assert.equal(code, 1);
      assert.match(output.stdout.join('\n'), /pricing-drift/);
      assert.match(output.stdout.join('\n'), /outputPerMTok drift/);
      assert.match(output.stdout.join('\n'), /registry 2 understates OpenRouter top-level price 3/);
    } finally {
      output.restore();
    }
  });

  it('loads a raw catalog JSON file', async () => {
    const repoDir = makeTempRepo();
    const catalogPath = join(repoDir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify({ data: [{ id: 'qwen/qwen3-coder' }] }), 'utf-8');
    const code = await runOpenRouterAliasAuditCommand({
      'catalog-json': catalogPath,
      'endpoints-json': undefined,
      fixture: false,
      output: undefined,
      'repo-dir': repoDir,
      json: true,
      'no-write': true,
    }, {
      fetchCatalog: async () => {
        throw new Error('should not fetch');
      },
      fetchEndpoints: async () => {
        throw new Error('should not fetch endpoints');
      },
      registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
      now: () => new Date('2026-08-18T00:00:00.000Z'),
    });

    assert.equal(code, 0);
  });

  it('returns two when the live catalog fetch fails', async () => {
    const repoDir = makeTempRepo();
    const code = await runOpenRouterAliasAuditCommand({
      'catalog-json': undefined,
      'endpoints-json': undefined,
      fixture: false,
      output: undefined,
      'repo-dir': repoDir,
      json: false,
      'no-write': false,
    }, {
      fetchCatalog: async () => {
        throw new Error('network down');
      },
      fetchEndpoints: async () => [],
      registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
      now: () => new Date('2026-08-18T00:00:00.000Z'),
    });

    assert.equal(code, 2);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'audits', 'openrouter-alias-drift.json')), false);
  });
  it('compares against the first-party endpoint reference in live mode', async () => {
    const repoDir = makeTempRepo();
    const output = captureOutput();
    try {
      const code = await runOpenRouterAliasAuditCommand({
        'catalog-json': undefined,
        'endpoints-json': undefined,
        fixture: false,
        output: undefined,
        'repo-dir': repoDir,
        json: false,
        'no-write': true,
      }, {
        // Top-level block is a cheap third-party host whose cache price would
        // flag the registry; the first-party endpoint matches the registry.
        fetchCatalog: async () => new Map<string, OpenRouterModel>([
          ['qwen/qwen3-coder', {
            id: 'qwen/qwen3-coder',
            context_length: 200_000,
            supported_parameters: ['tools'],
            pricing: { prompt: '0.0000006', completion: '0.000001', input_cache_read: '0.0000006' },
          }],
        ]),
        fetchEndpoints: async (modelId) => {
          assert.equal(modelId, 'qwen/qwen3-coder');
          return [
            { provider_name: 'CheapHost', tag: 'cheap-host', pricing: { prompt: '0.0000006', completion: '0.000001', input_cache_read: '0.0000006' } },
            { provider_name: 'Alibaba', tag: 'alibaba/opensource', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ];
        },
        registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
        now: () => new Date('2026-10-01T00:00:00.000Z'),
      });

      assert.equal(code, 0);
      assert.match(output.stdout.join('\n'), /Selectable findings: 0/);
    } finally {
      output.restore();
    }
  });

  it('returns two when an endpoint fetch fails in live mode', async () => {
    const repoDir = makeTempRepo();
    const output = captureOutput();
    try {
      const code = await runOpenRouterAliasAuditCommand({
        'catalog-json': undefined,
        'endpoints-json': undefined,
        fixture: false,
        output: undefined,
        'repo-dir': repoDir,
        json: false,
        'no-write': true,
      }, {
        fetchCatalog: async () => new Map<string, OpenRouterModel>([
          ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', context_length: 200_000 }],
        ]),
        fetchEndpoints: async () => {
          throw new Error('endpoints unavailable');
        },
        registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
        now: () => new Date('2026-10-01T00:00:00.000Z'),
      });

      assert.equal(code, 2);
      assert.match(output.stderr.join('\n'), /could not load endpoints/);
      assert.match(output.stderr.join('\n'), /endpoints unavailable/);
    } finally {
      output.restore();
    }
  });

  it('drives the reference from an offline endpoints fixture with --endpoints-json', async () => {
    const repoDir = makeTempRepo();
    const catalogPath = join(repoDir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify({
      data: [{
        id: 'qwen/qwen3-coder',
        context_length: 200_000,
        supported_parameters: ['tools'],
        pricing: { prompt: '0.000001', completion: '0.000002' },
      }],
    }), 'utf-8');
    const endpointsPath = join(repoDir, 'endpoints.json');
    writeFileSync(endpointsPath, JSON.stringify({
      'qwen/qwen3-coder': {
        data: {
          endpoints: [
            { provider_name: 'Alibaba', tag: 'alibaba/opensource', pricing: { prompt: '0.000002', completion: '0.000004' } },
          ],
        },
      },
    }), 'utf-8');
    const output = captureOutput();
    try {
      const code = await runOpenRouterAliasAuditCommand({
        'catalog-json': catalogPath,
        'endpoints-json': endpointsPath,
        fixture: false,
        output: undefined,
        'repo-dir': repoDir,
        json: false,
        'no-write': true,
      }, {
        fetchCatalog: async () => {
          throw new Error('should not fetch');
        },
        fetchEndpoints: async () => {
          throw new Error('should not fetch endpoints');
        },
        registry: { models: { 'qwen-3-coder': makeModel('supported') }, ladders: {} },
        now: () => new Date('2026-10-01T00:00:00.000Z'),
      });

      // Registry input 1 understates the first-party reference 2 even though
      // the top-level catalog block matches the registry exactly.
      assert.equal(code, 1);
      const stdout = output.stdout.join('\n');
      assert.match(stdout, /pricing-drift/);
      assert.match(stdout, /first-party reference Alibaba \(alibaba\/opensource\) 2/);
    } finally {
      output.restore();
    }
  });
});
