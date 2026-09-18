import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTestRegistration, formatTestRegistration } from './check-test-registration.ts';

interface RepoOptions {
  customTsEntries?: string[];
  customShEntries?: string[];
}

function withRepo(entries: string[], testFiles: string[], fn: (repoDir: string) => void, options: RepoOptions = {}): void {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'test-registration-'));
  try {
    mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    for (const testFile of testFiles) {
      const filePath = path.join(repoDir, testFile);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, '');
    }
    writeFileSync(path.join(repoDir, 'tests', 'run-unit-tests.sh'), `TESTS=(\n${entries.map((entry) => `  ${entry}`).join('\n')}\n)\n`);
    const customTs = (options.customTsEntries ?? []).map((entry) => `  ${entry}`).join('\n');
    const customSh = (options.customShEntries ?? []).map((entry) => `  ${entry}`).join('\n');
    writeFileSync(
      path.join(repoDir, 'tests', 'run-custom-tests.sh'),
      `CUSTOM_TS_TESTS=(\n${customTs}\n)\n\nCUSTOM_SH_TESTS=(\n${customSh}\n)\n`
    );
    fn(repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

test('checkTestRegistration passes when discovered tests are registered in unit only', () => {
  withRepo(['shared/lib/a.test.ts', 'tools/b.test.ts'], ['shared/lib/a.test.ts', 'tools/b.test.ts'], (repoDir) => {
    const result = checkTestRegistration(repoDir);

    assert.equal(result.ok, true);
    assert.deepEqual(result.unregistered, []);
    assert.deepEqual(result.overlap, []);
    assert.match(formatTestRegistration(result), /2 discovered, 2 registered/);
  });
});

test('checkTestRegistration passes when discovered tests are registered in custom TS only', () => {
  withRepo(
    [],
    ['shared/lib/a.test.ts', 'src/b.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);

      assert.equal(result.ok, true);
      assert.deepEqual(result.unregistered, []);
      assert.deepEqual(result.staleCustom, []);
      assert.deepEqual(result.overlap, []);
      assert.match(formatTestRegistration(result), /2 discovered, 2 registered/);
    },
    { customTsEntries: ['shared/lib/a.test.ts', 'src/b.test.ts'] }
  );
});

test('checkTestRegistration reports cross-suite overlap', () => {
  withRepo(
    ['shared/lib/a.test.ts'],
    ['shared/lib/a.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.overlap, ['shared/lib/a.test.ts']);
      assert.match(message, /Cross-suite overlap \(registered in both TESTS and CUSTOM_TS_TESTS\):/);
      assert.match(message, /shared\/lib\/a\.test\.ts/);
    },
    { customTsEntries: ['shared/lib/a.test.ts'] }
  );
});

test('checkTestRegistration reports unregistered test files with the registration remedy', () => {
  withRepo(['shared/lib/a.test.ts'], ['shared/lib/a.test.ts', 'src/b.test.ts'], (repoDir) => {
    const result = checkTestRegistration(repoDir);
    const message = formatTestRegistration(result);

    assert.equal(result.ok, false);
    assert.deepEqual(result.unregistered, ['src/b.test.ts']);
    assert.match(message, /Unregistered test files:/);
    assert.match(message, /tests\/run-unit-tests\.sh/);
    assert.match(message, /tests\/run-custom-tests\.sh/);
  });
});

test('checkTestRegistration reports stale and duplicate registrations', () => {
  withRepo(['tools/a.test.ts', 'tools/a.test.ts', 'tools/missing.test.ts'], ['tools/a.test.ts'], (repoDir) => {
    const result = checkTestRegistration(repoDir);

    assert.equal(result.ok, false);
    assert.deepEqual(result.stale, ['tools/missing.test.ts']);
    assert.deepEqual(result.duplicates, ['tools/a.test.ts']);
  });
});

test('checkTestRegistration reports duplicate custom TS registrations', () => {
  withRepo(
    [],
    ['shared/lib/a.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.customDuplicates, ['shared/lib/a.test.ts']);
      assert.match(message, /Duplicate custom harness registrations:/);
    },
    { customTsEntries: ['shared/lib/a.test.ts', 'shared/lib/a.test.ts'] }
  );
});

test('checkTestRegistration reports stale custom TS registrations', () => {
  withRepo(
    ['shared/lib/a.test.ts'],
    ['shared/lib/a.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.staleCustom, ['shared/lib/gone.test.ts']);
      assert.deepEqual(result.customMissing, ['shared/lib/gone.test.ts']);
      assert.match(message, /Stale custom TS registrations:/);
    },
    { customTsEntries: ['shared/lib/gone.test.ts'] }
  );
});

test('checkTestRegistration reports missing custom shell registrations', () => {
  withRepo(
    ['shared/lib/a.test.ts'],
    ['shared/lib/a.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.customMissing, ['tests/gone.test.sh']);
      assert.match(message, /Missing custom harness test files:/);
      assert.match(message, /tests\/gone\.test\.sh/);
    },
    { customTsEntries: ['shared/lib/a.test.ts'], customShEntries: ['tests/gone.test.sh'] }
  );
});
