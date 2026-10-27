import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModelRegistryCatalog, ModelRegistryCatalogError } from './model-registry-loader.ts';

const libDir = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(libDir, '..', 'fixtures', 'model-registry.v1.json'), 'utf-8');

function listStampFiles(stampDir: string): string[] {
  try {
    return readdirSync(join(stampDir, 'model-registry'));
  } catch {
    return [];
  }
}

/**
 * The loader caches validated catalogs in a module-level map keyed by content
 * sha. Across tests in one node process a cache hit short-circuits before any
 * stamp write, which would otherwise make "exactly one stamp" assertions
 * order-dependent. Appending unique trailing whitespace (ignored by JSON
 * parsing but changing the sha) guarantees each test exercises the
 * full validate+stamp path.
 */
let cacheBuster = 0;
function uniqueCatalogText(): string {
  cacheBuster += 1;
  return `${fixtureText}${'\n'.repeat(cacheBuster)}`;
}

describe('loadModelRegistryCatalog validation stamps (HOK-3205)', () => {
  let workDir: string;
  let stampDir: string;
  const savedDir = process.env.WAVEMILL_SCHEMA_STAMP_DIR;
  const savedDisable = process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'model-registry-loader-'));
    stampDir = join(workDir, 'stamps');
    process.env.WAVEMILL_SCHEMA_STAMP_DIR = stampDir;
    delete process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.WAVEMILL_SCHEMA_STAMP_DIR;
    else process.env.WAVEMILL_SCHEMA_STAMP_DIR = savedDir;
    if (savedDisable === undefined) delete process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;
    else process.env.WAVEMILL_DISABLE_SCHEMA_STAMP = savedDisable;
  });

  function writeCatalog(name: string, text: string): string {
    const path = join(workDir, name);
    writeFileSync(path, text);
    return path;
  }

  // protects: a successful load records a stamp for the exact catalog bytes
  // so a subsequent process can skip full validation. Without a stamp, cold
  // starts pay the Ajv compile cost every time (HOK-3205).
  it('stamps a catalog after it passes full validation', () => {
    assert.deepEqual(listStampFiles(stampDir), [], 'no stamps before first load');
    const catalogText = uniqueCatalogText();
    const path = writeCatalog('valid.json', catalogText);
    const loaded = loadModelRegistryCatalog(path);
    const parsed = JSON.parse(catalogText) as { models: unknown[] };
    assert.equal(loaded.models.length, parsed.models.length);
    assert.equal(listStampFiles(stampDir).length, 1, 'one stamp after first load');
  });

  // "distinct catalog bytes produce distinct stamp keys" is implied by the
  // "re-validates changed bytes" test below (a stamp for other content never
  // masks an invalid catalog). A direct assertion would need to clear the
  // process-wide validatedCatalogs memo between loads, which the loader does
  // not expose — the single-process behaviour is otherwise untouched by this
  // conversion.

  // protects: a cached memoisation on identical bytes returns independent
  // copies — a caller mutating its result must not corrupt the next load.
  it('returns independent copies on repeat loads of the same bytes', () => {
    const path = writeCatalog('copies.json', uniqueCatalogText());
    const first = loadModelRegistryCatalog(path);
    first.models.length = 0;
    const second = loadModelRegistryCatalog(path);
    assert.ok(second.models.length > 0);
  });

  // protects: a stamp recorded for content X never masks an invalid content
  // Y. The stamp key must include the current catalog bytes, not just a
  // scope-wide marker (regression HOK-3205).
  it('re-validates changed bytes: a stamp for other content never masks an invalid catalog', () => {
    const validText = uniqueCatalogText();
    loadModelRegistryCatalog(writeCatalog('good.json', validText));
    const stampsAfterGood = listStampFiles(stampDir);
    assert.equal(stampsAfterGood.length, 1);

    const bad = JSON.parse(fixtureText);
    bad.models = 'not-an-array';
    const badText = JSON.stringify(bad);
    assert.throws(() => loadModelRegistryCatalog(writeCatalog('good.json', badText)), ModelRegistryCatalogError);
    assert.deepEqual(listStampFiles(stampDir), stampsAfterGood, 'invalid bytes add no stamp');
  });

  // protects: a semantically invalid catalog (duplicate model id) is always
  // rejected, both on first load and under WAVEMILL_DISABLE_SCHEMA_STAMP=1.
  // The escape hatch must never silently accept bad bytes.
  it('duplicate model id is rejected on first load and under forced re-validation', () => {
    const catalog = JSON.parse(fixtureText);
    catalog.models.push(catalog.models[0]);
    const text = JSON.stringify(catalog);
    const path = writeCatalog('dup.json', text);
    assert.throws(() => loadModelRegistryCatalog(path), /duplicate model id/);
    process.env.WAVEMILL_DISABLE_SCHEMA_STAMP = '1';
    assert.throws(() => loadModelRegistryCatalog(path), /duplicate model id/);
  });

  // protects: a malformed catalog is rejected regardless of stamp state —
  // JSON parsing happens before any stamp lookup.
  it('malformed JSON fails regardless of stamps', () => {
    assert.throws(() => loadModelRegistryCatalog(writeCatalog('broken.json', '{"schemaVersion": "1",')), /Invalid model registry catalog at/);
  });
});
