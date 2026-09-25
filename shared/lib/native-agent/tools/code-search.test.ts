import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ResolvedNativeCodeSearchConfig } from '../../config.ts';
import type { WavemillConfig } from '../../config.ts';
import {
  CODE_SEARCH_PATH_FIELDS,
  createCodeSearchTools,
  type CodeSearchDetails,
  type CodeSearchErrorDetails,
  type CodeSearchFallbackDetails,
} from './code-search.ts';
import { computeEligibility } from './exposure.ts';
import { createReadOnlyTools } from './read-only.ts';
import { createToolRegistry } from './registry.ts';
import type { RegisteredToolMetadata, WavemillToolResult } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'code-search');
const TS_FIXTURE = path.join(FIXTURE_ROOT, 'ts-project');
const PY_FIXTURE = path.join(FIXTURE_ROOT, 'py-project');

function makeConfig(overrides: Partial<ResolvedNativeCodeSearchConfig> = {}): ResolvedNativeCodeSearchConfig {
  return {
    enabled: true,
    allowedPhases: ['planning', 'coding', 'review'],
    limits: {
      maxFiles: 2000,
      maxBytes: 32 * 1024 * 1024,
      maxSymbols: 20_000,
      maxResults: 200,
    },
    invalidReasons: [],
    ...overrides,
  };
}

function makeSearchTextExecutor(worktree: string) {
  // A search_text executor derived from the real read-only factory so tests
  // exercise the injected-executor fallback path with real behavior.
  const readOnly = createReadOnlyTools(worktree);
  const searchText = readOnly.find((d) => d.metadata.name === 'search_text');
  if (!searchText) throw new Error('search_text descriptor missing from fixture setup');
  return searchText.execute as (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<WavemillToolResult<unknown>>;
}

function findByName(descriptors: ReturnType<typeof createCodeSearchTools>, name: string) {
  const d = descriptors.find((desc) => desc.metadata.name === name);
  if (!d) throw new Error(`missing descriptor: ${name}`);
  return d;
}

describe('createCodeSearchTools — descriptor gating', () => {
  it('returns [] when config is null', () => {
    const descriptors = createCodeSearchTools({ config: null, worktreePath: TS_FIXTURE });
    assert.deepEqual(descriptors, []);
  });

  it('returns [] when config.enabled is false', () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig({ enabled: false }),
      worktreePath: TS_FIXTURE,
    });
    assert.deepEqual(descriptors, []);
  });

  it('registers exactly four descriptors, all opt-in, read-only, all three phases', () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    assert.equal(descriptors.length, 4);
    const registry = createToolRegistry(descriptors);
    const listed = registry.list();
    const expected = new Set([
      'code_search_symbols',
      'code_search_definition',
      'code_search_references',
      'code_search_call_sites',
    ]);
    for (const meta of listed) {
      assert.equal(meta.family, 'code_search');
      assert.equal(meta.exposure, 'opt-in');
      assert.equal(meta.class, 'read-only');
      assert.equal(meta.certificationRequirement, 'read-only');
      assert.deepEqual([...meta.allowedPhases].sort(), ['coding', 'planning', 'review']);
      assert.ok(expected.has(meta.name), `unexpected descriptor ${meta.name}`);
      expected.delete(meta.name);
    }
    assert.equal(expected.size, 0);
  });

  it('every parameter schema is additionalProperties: false; symbol required except code_search_symbols', () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    for (const desc of descriptors) {
      const schema = desc.parameters as { additionalProperties: boolean; required?: string[] };
      assert.equal(schema.additionalProperties, false);
      if (desc.metadata.name === 'code_search_symbols') {
        assert.equal(schema.required, undefined);
      } else {
        assert.deepEqual(schema.required, ['symbol']);
      }
    }
  });
});

describe('createCodeSearchTools — eligibility gating', () => {
  it('computeEligibility denies each tool when family is not enabled', () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const registry = createToolRegistry(descriptors);
    const config: WavemillConfig = { nativeAgent: { advanced: {} } };
    const result = computeEligibility({
      phase: 'planning',
      config,
      certification: { maxCertifiedPhase: 'workflow' },
      registry: registry.list() as unknown as RegisteredToolMetadata[],
    });
    assert.deepEqual([...result.eligibleNames], []);
    assert.ok(result.denials.every((d) => d.reason === 'family_not_enabled'));
  });

  it('computeEligibility surfaces logical_id_not_allowlisted when logicalIds excludes a tool', () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const registry = createToolRegistry(descriptors);
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          code_search: {
            enabled: true,
            allowedPhases: ['planning'],
            logicalIds: ['code_search.definition'],
          },
        },
      },
    };
    const result = computeEligibility({
      phase: 'planning',
      config,
      certification: { maxCertifiedPhase: 'workflow' },
      registry: registry.list() as unknown as RegisteredToolMetadata[],
    });
    assert.deepEqual([...result.eligibleNames], ['code_search_definition']);
    const excluded = result.denials.filter((d) => d.reason === 'logical_id_not_allowlisted');
    assert.ok(excluded.length >= 1);
  });
});

describe('createCodeSearchTools — TS engine executor', () => {
  it('code_search_definition returns byte-identical canonical JSON on two runs', async () => {
    const runOnce = async () => {
      const descriptors = createCodeSearchTools({
        config: makeConfig(),
        worktreePath: TS_FIXTURE,
      });
      const def = findByName(descriptors, 'code_search_definition');
      const result = await def.execute('call-1', { symbol: 'calculateTotal' });
      return result.content[0]?.text ?? '';
    };
    const first = await runOnce();
    const second = await runOnce();
    assert.equal(first, second);
    assert.ok(first.includes('calculateTotal'));
  });

  it('code_search_references respects maxResults truncation', async () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const refs = findByName(descriptors, 'code_search_references');
    const result = (await refs.execute('call-2', {
      symbol: 'calculateTotal',
      maxResults: 1,
    })) as WavemillToolResult<CodeSearchDetails>;
    const details = result.details;
    assert.equal(details.matches.length, 1);
    assert.equal(details.meta.truncated, true);
    assert.ok(details.meta.totalMatches > 1);
  });

  it('unsupported language returns a structured error with fallback: false', async () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: PY_FIXTURE,
    });
    const defs = findByName(descriptors, 'code_search_definition');
    const result = (await defs.execute('call-3', {
      symbol: 'compute_value',
      path: 'main.py',
    })) as WavemillToolResult<CodeSearchErrorDetails>;
    const details = result.details;
    assert.equal(details.error, 'unsupported_language');
    assert.equal(details.language, 'python');
  });

  it('unsupported language + fallback: true delegates to injected search_text', async () => {
    const executor = makeSearchTextExecutor(PY_FIXTURE);
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: PY_FIXTURE,
      searchTextExecutor: executor,
    });
    const defs = findByName(descriptors, 'code_search_definition');
    const result = (await defs.execute('call-4', {
      symbol: 'compute_value',
      language: 'python',
      fallback: true,
    })) as WavemillToolResult<CodeSearchFallbackDetails>;
    assert.equal(result.details.fallback, true);
    assert.equal(result.details.status, 'ok');
    assert.ok(
      typeof result.content[0]?.text === 'string' && result.content[0]!.text.includes('compute_value'),
      `expected fallback text to include the search hit; got: ${JSON.stringify(result.content[0]?.text)}`,
    );
  });

  it('path outside the worktree yields path_outside_worktree', async () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const defs = findByName(descriptors, 'code_search_definition');
    const result = (await defs.execute('call-5', {
      symbol: 'calculateTotal',
      path: '../../..',
    })) as WavemillToolResult<CodeSearchErrorDetails>;
    assert.equal(result.details.error, 'path_outside_worktree');
  });

  it('aborted signal short-circuits to { error: aborted }', async () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const defs = findByName(descriptors, 'code_search_definition');
    const controller = new AbortController();
    controller.abort();
    const result = (await defs.execute('call-6', { symbol: 'calculateTotal' }, controller.signal)) as WavemillToolResult<CodeSearchErrorDetails>;
    assert.equal(result.details.error, 'aborted');
  });

  it('provenance metadata is attached to every success and every error', async () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const def = findByName(descriptors, 'code_search_definition');
    const success = await def.execute('call-7a', { symbol: 'calculateTotal' });
    assert.equal(success.metadata?.trust?.sourceKind, 'file');
    const error = await def.execute('call-7b', { symbol: '' });
    assert.equal(error.metadata?.trust?.sourceKind, 'file');
  });

  it('code_search_symbols requires symbol or pattern', async () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    const symbols = findByName(descriptors, 'code_search_symbols');
    const result = (await symbols.execute('call-8', {})) as WavemillToolResult<CodeSearchErrorDetails>;
    assert.equal(result.details.error, 'invalid_params');
  });

  it('CODE_SEARCH_PATH_FIELDS covers every descriptor name', () => {
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: TS_FIXTURE,
    });
    for (const desc of descriptors) {
      assert.ok(
        CODE_SEARCH_PATH_FIELDS[desc.metadata.name] !== undefined,
        `missing path-field entry for ${desc.metadata.name}`,
      );
      assert.deepEqual(CODE_SEARCH_PATH_FIELDS[desc.metadata.name], ['path']);
    }
  });

  it('redacts secret-shaped tokens in returned content', async () => {
    // Assemble an ad-hoc worktree containing a definition that mentions a
    // secret-shaped literal in a string. Redaction runs over both content and
    // details before the result leaves the executor.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-redact-'));
    const filePath = path.join(dir, 'leak.ts');
    const secret = 'sk-' + 'a'.repeat(48);
    fs.writeFileSync(
      filePath,
      `export function leakToken(): string { return "token=${secret}"; }`,
    );
    const descriptors = createCodeSearchTools({
      config: makeConfig(),
      worktreePath: dir,
    });
    const def = findByName(descriptors, 'code_search_definition');
    const result = await def.execute('call-9', { symbol: 'leakToken' });
    const text = result.content[0]?.text ?? '';
    assert.equal(text.includes(secret), false, 'raw secret must not appear in returned text');
  });
});
