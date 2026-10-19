import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDepsDrift, depsLockfileFingerprint } from './deps-drift.ts';

function makeNpmFixture(opts: {
  installedVersion?: string | null;
  hiddenInstalledVersion?: string | null;
  lockVersion?: string;
  withHidden?: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-'));
  mkdirSync(join(dir, 'node_modules', 'foo'), { recursive: true });
  const lockVersion = opts.lockVersion ?? '0.5.0';
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      dependencies: { foo: `^${lockVersion}` },
    }),
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { foo: `^${lockVersion}` } },
        'node_modules/foo': { version: lockVersion },
      },
    }),
  );
  if (opts.withHidden !== false) {
    writeFileSync(
      join(dir, 'node_modules', '.package-lock.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { foo: `^${opts.hiddenInstalledVersion ?? lockVersion}` } },
          'node_modules/foo': { version: opts.hiddenInstalledVersion ?? lockVersion },
        },
      }),
    );
  }
  if (opts.installedVersion !== null) {
    writeFileSync(
      join(dir, 'node_modules', 'foo', 'package.json'),
      JSON.stringify({ name: 'foo', version: opts.installedVersion ?? lockVersion }),
    );
  }
  return dir;
}

test('drift primitive flags hidden-lockfile mismatch', () => {
  const dir = makeNpmFixture({
    lockVersion: '0.5.0',
    hiddenInstalledVersion: '0.4.0',
    installedVersion: '0.4.0',
  });
  try {
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'drift');
    assert.equal(result.reason, 'hidden-lockfile-mismatch');
    assert.ok(result.packages.some((pkg) => pkg.name === 'foo'));
    const foo = result.packages.find((pkg) => pkg.name === 'foo')!;
    assert.equal(foo.lockVersion, '0.5.0');
    assert.equal(foo.installedVersion, '0.4.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift primitive reports ok when hidden lockfile matches', () => {
  const dir = makeNpmFixture({ lockVersion: '0.5.0', installedVersion: '0.5.0' });
  try {
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'ok');
    assert.equal(result.reason, 'hidden-lockfile-match');
    assert.deepEqual(result.packages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift primitive reports unknown for pnpm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-pnpm-'));
  try {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'pnpm-not-supported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift primitive reports unknown for yarn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-yarn-'));
  try {
    writeFileSync(join(dir, 'yarn.lock'), '');
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'yarn-not-supported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift primitive falls back to direct-dep scan when hidden lockfile absent', () => {
  const dir = makeNpmFixture({
    lockVersion: '0.5.0',
    installedVersion: '0.4.0',
    withHidden: false,
  });
  try {
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'drift');
    assert.equal(result.reason, 'hidden-lockfile-missing');
    const foo = result.packages.find((pkg) => pkg.name === 'foo');
    assert.ok(foo, 'expected foo in drifted packages');
    assert.equal(foo!.lockVersion, '0.5.0');
    assert.equal(foo!.installedVersion, '0.4.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift primitive reports ok when node_modules exists without lockfile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-noloc-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'ok');
    assert.equal(result.reason, 'no-lockfile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift primitive flags node_modules-missing when lockfile has no install at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-missing-nm-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'demo', lockfileVersion: 3, packages: {} }),
    );
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'drift');
    assert.equal(result.reason, 'node_modules-missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('depsLockfileFingerprint changes when the lockfile changes', () => {
  const first = makeNpmFixture({ lockVersion: '0.5.0' });
  const second = makeNpmFixture({ lockVersion: '0.6.0' });
  try {
    const a = depsLockfileFingerprint(first);
    const b = depsLockfileFingerprint(second);
    assert.ok(a && b, 'both fingerprints should resolve');
    assert.notEqual(a, b, 'fingerprint should change with a lockfile bump');
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
