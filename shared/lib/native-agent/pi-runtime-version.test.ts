import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  clearPiRuntimeVersionCache,
  parsePiRuntimeVersions,
  piRuntimeVersionsField,
  resolvePiRuntimeVersions,
} from './pi-runtime-version.ts';

function installPackage(root: string, name: string, body: string): string {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'package.json');
  writeFileSync(path, body);
  return path;
}

describe('resolvePiRuntimeVersions (HOK-3164)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-runtime-version-'));
    clearPiRuntimeVersionCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearPiRuntimeVersionCache();
  });

  it('reads both installed package versions', () => {
    installPackage(root, '@earendil-works/pi-agent-core', JSON.stringify({ version: '1.0.2' }));
    installPackage(root, '@earendil-works/pi-ai', JSON.stringify({ version: '1.0.3' }));

    assert.deepEqual(resolvePiRuntimeVersions(root), { 'pi-agent-core': '1.0.2', 'pi-ai': '1.0.3' });
  });

  it('follows Node ancestor lookup from a nested directory without its own node_modules', () => {
    installPackage(root, '@earendil-works/pi-ai', JSON.stringify({ version: '1.0.2' }));
    const nested = join(root, 'worktrees', 'task', 'shared', 'lib');
    mkdirSync(nested, { recursive: true });

    assert.deepEqual(resolvePiRuntimeVersions(nested), { 'pi-ai': '1.0.2' });
  });

  it('prefers the nearest install over an ancestor one', () => {
    installPackage(root, '@earendil-works/pi-ai', JSON.stringify({ version: '0.79.8' }));
    const nested = join(root, 'child');
    installPackage(nested, '@earendil-works/pi-ai', JSON.stringify({ version: '1.0.2' }));

    assert.equal(resolvePiRuntimeVersions(nested)['pi-ai'], '1.0.2');
  });

  it('returns an empty object when nothing is installed', () => {
    assert.deepEqual(resolvePiRuntimeVersions(root), {});
  });

  it('drops a package whose package.json is malformed or has no version', () => {
    installPackage(root, '@earendil-works/pi-agent-core', '{ not json');
    installPackage(root, '@earendil-works/pi-ai', JSON.stringify({ name: '@earendil-works/pi-ai' }));

    assert.deepEqual(resolvePiRuntimeVersions(root), {});
  });

  it('memoizes per start directory and returns a frozen object', () => {
    const path = installPackage(root, '@earendil-works/pi-ai', JSON.stringify({ version: '1.0.2' }));
    const first = resolvePiRuntimeVersions(root);
    writeFileSync(path, JSON.stringify({ version: '9.9.9' }));

    const second = resolvePiRuntimeVersions(root);
    assert.equal(second, first);
    assert.equal(second['pi-ai'], '1.0.2');
    assert.ok(Object.isFrozen(second));

    clearPiRuntimeVersionCache();
    assert.equal(resolvePiRuntimeVersions(root)['pi-ai'], '9.9.9');
  });

  it('defaults to the install this module is loaded from', () => {
    // Find the package.json Node would load, the same way the resolver does,
    // so the assertion holds both in the main checkout and in worktrees.
    let dir = dirname(fileURLToPath(import.meta.url));
    let expected: string | undefined;
    for (;;) {
      try {
        expected = JSON.parse(readFileSync(join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), 'utf-8')).version;
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    assert.equal(resolvePiRuntimeVersions()['pi-ai'], expected);
  });
});

describe('parsePiRuntimeVersions (HOK-3164)', () => {
  it('keeps only known keys with non-empty string values', () => {
    assert.deepEqual(
      parsePiRuntimeVersions({ 'pi-agent-core': ' 1.0.2 ', 'pi-ai': '', extra: '1', other: 3 }),
      { 'pi-agent-core': '1.0.2' },
    );
  });

  it('returns an empty object for non-object input', () => {
    for (const value of [undefined, null, 'x', 1, ['1.0.2']]) {
      assert.deepEqual(parsePiRuntimeVersions(value), {});
    }
  });
});

describe('piRuntimeVersionsField (HOK-3164)', () => {
  it('spreads a copy when any version is present', () => {
    const versions = Object.freeze({ 'pi-ai': '1.0.2' });
    const field = piRuntimeVersionsField(versions);
    assert.deepEqual(field, { piRuntimeVersions: { 'pi-ai': '1.0.2' } });
    assert.notEqual(field.piRuntimeVersions, versions);
  });

  it('spreads nothing when no version is present', () => {
    assert.deepEqual(piRuntimeVersionsField({}), {});
  });
});
