import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { checkDepsDrift, depsLockfileFingerprint } from './deps-drift.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'dependency-install');

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

// HOK-3315 — real npm evidence (sanitized): 26 foreign-platform optional
// esbuild binaries correctly absent on darwin/arm64, plus two genuine
// version mismatches (brace-expansion, fast-uri).
test('platform-omitted optional binaries are not drift; real mismatches still fire', () => {
  const dir = join(FIXTURES_DIR, 'darwin-arm64-esbuild');
  const result = checkDepsDrift(dir, { platform: 'darwin', arch: 'arm64' });
  assert.equal(result.status, 'drift');
  assert.equal(result.reason, 'hidden-lockfile-mismatch');
  assert.deepEqual(
    result.packages.map((pkg) => pkg.name).sort(),
    ['brace-expansion', 'fast-uri'],
  );
  assert.ok(result.packages.every((pkg) => pkg.reason === 'version-mismatch'));
  assert.ok(!result.packages.some((pkg) => pkg.name.startsWith('@esbuild/')), 'foreign-platform esbuild binaries must never be reported as drift');
});

test('the same fixture under a different platform still ignores every optional esbuild binary', () => {
  const dir = join(FIXTURES_DIR, 'darwin-arm64-esbuild');
  const result = checkDepsDrift(dir, { platform: 'linux', arch: 'x64' });
  // Re-evaluated for linux/x64: the darwin-arm64 binary this fixture actually
  // has is platform-skipped for this check, and linux-x64's own binary is
  // optional-absent — neither is drift. Only the two real mismatches remain.
  assert.deepEqual(
    result.packages.map((pkg) => pkg.name).sort(),
    ['brace-expansion', 'fast-uri'],
  );
});

test('formatting-only differences (root entry presence) are not drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-format-'));
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { foo: '^1.0.0' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', dependencies: { foo: '^1.0.0' } },
        'node_modules/foo': { version: '1.0.0' },
      },
    }));
    // Hidden lockfile omits the root entry entirely — a real, harmless
    // formatting difference npm itself produces.
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        'node_modules/foo': { version: '1.0.0' },
      },
    }));
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'ok');
    assert.equal(result.reason, 'hidden-lockfile-match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt hidden lockfile reports unknown, never drift or ok', () => {
  const dir = makeNpmFixture({ lockVersion: '0.5.0', installedVersion: '0.5.0' });
  try {
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{ not valid json');
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'hidden-lockfile-parse-error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt project lockfile reports unknown, never drift or ok', () => {
  const dir = makeNpmFixture({ lockVersion: '0.5.0', installedVersion: '0.5.0' });
  try {
    writeFileSync(join(dir, 'package-lock.json'), '{ not valid json');
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'lockfile-parse-error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a required dependency deleted outright is drift, never silently ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-deleted-'));
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { foo: '^1.0.0' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { foo: '^1.0.0' } },
        'node_modules/foo': { version: '1.0.0' },
      },
    }));
    // The hidden lockfile has nothing for `foo` at all — it was deleted.
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {},
    }));
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'drift');
    const foo = result.packages.find((pkg) => pkg.name === 'foo');
    assert.ok(foo, 'deleted required dependency must be reported');
    assert.equal(foo!.reason, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workspace link entry checks existence, not version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-drift-link-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'deps-drift-link-target-'));
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/sibling-pkg': { resolved: 'packages/sibling-pkg', link: true },
      },
    }));
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        'node_modules/sibling-pkg': { resolved: 'packages/sibling-pkg', link: true },
      },
    }));
    symlinkSync(targetDir, join(dir, 'node_modules', 'sibling-pkg'));
    const result = checkDepsDrift(dir);
    assert.equal(result.status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
