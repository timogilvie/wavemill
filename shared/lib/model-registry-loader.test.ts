import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModelRegistryCatalog, ModelRegistryCatalogError } from './model-registry-loader.ts';
import { hasValidationStamp, recordValidationStamp, sha256 } from './schema-validators.ts';

const libDir = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(libDir, '..', 'fixtures', 'model-registry.v1.json'), 'utf-8');
const schemaText = readFileSync(join(libDir, '..', 'schemas', 'model-registry.schema.json'), 'utf-8');
const loaderSourceSha = sha256(readFileSync(join(libDir, 'model-registry-loader.ts')));

/** Mirrors the stamp key loadModelRegistryCatalog derives for a catalog. */
function stampKey(catalogText: string): string {
  return `${sha256(catalogText)}.${sha256(schemaText)}.${loaderSourceSha}`;
}

describe('loadModelRegistryCatalog validation stamps (HOK-3205)', () => {
  let workDir: string;
  const savedDir = process.env.WAVEMILL_SCHEMA_STAMP_DIR;
  const savedDisable = process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'model-registry-loader-'));
    process.env.WAVEMILL_SCHEMA_STAMP_DIR = join(workDir, 'stamps');
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

  it('stamps a catalog after it passes full validation', () => {
    const catalog = JSON.parse(fixtureText);
    catalog.ladders = { ...catalog.ladders };
    const text = JSON.stringify(catalog);
    const path = writeCatalog('valid.json', text);

    assert.equal(hasValidationStamp('model-registry', stampKey(text)), false);
    const loaded = loadModelRegistryCatalog(path);
    assert.equal(loaded.models.length, catalog.models.length);
    assert.equal(hasValidationStamp('model-registry', stampKey(text)), true);
  });

  it('returns independent copies on repeat loads of the same bytes', () => {
    const path = writeCatalog('copies.json', `${fixtureText}\n`);
    const first = loadModelRegistryCatalog(path);
    first.models.length = 0;
    const second = loadModelRegistryCatalog(path);
    assert.ok(second.models.length > 0);
  });

  it('re-validates changed bytes: a stamp for other content never masks an invalid catalog', () => {
    const validText = `${fixtureText}\n\n`;
    loadModelRegistryCatalog(writeCatalog('good.json', validText));
    assert.equal(hasValidationStamp('model-registry', stampKey(validText)), true);

    const bad = JSON.parse(fixtureText);
    bad.models = 'not-an-array';
    const badText = JSON.stringify(bad);
    assert.throws(() => loadModelRegistryCatalog(writeCatalog('good.json', badText)), ModelRegistryCatalogError);
    assert.equal(hasValidationStamp('model-registry', stampKey(badText)), false);
  });

  it('a matching stamp skips validation; WAVEMILL_DISABLE_SCHEMA_STAMP=1 forces it', () => {
    // Semantically invalid (duplicate model id) but parseable, so only the
    // validators can reject it.
    const catalog = JSON.parse(fixtureText);
    catalog.models.push(catalog.models[0]);
    const text = JSON.stringify(catalog);
    const path = writeCatalog('stamped.json', text);
    recordValidationStamp('model-registry', stampKey(text));

    process.env.WAVEMILL_DISABLE_SCHEMA_STAMP = '1';
    assert.throws(() => loadModelRegistryCatalog(path), /duplicate model id/);
    delete process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;

    assert.equal(loadModelRegistryCatalog(path).models.length, catalog.models.length);
  });

  it('malformed JSON fails regardless of stamps', () => {
    assert.throws(() => loadModelRegistryCatalog(writeCatalog('broken.json', '{"schemaVersion": "1",')), /Invalid model registry catalog at/);
  });
});
