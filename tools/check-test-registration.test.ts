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
    // Create standalone test files so the allowlist doesn't cause drift detection
    mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
    writeFileSync(path.join(repoDir, 'shared', 'lib', 'github.test.js'), '');

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
    assert.match(formatTestRegistration(result), /3 discovered, 2 registered, 1 standalone/);
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
      assert.match(formatTestRegistration(result), /3 discovered, 2 registered, 1 standalone/);
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

test('checkTestRegistration scans codex root when codex tests are registered', () => {
  // protects: codex root is scanned for .test.ts and .test.js files
  withRepo(
    ['codex/tests/x.test.js'],
    ['codex/tests/x.test.js'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);

      assert.equal(result.ok, true);
      assert.match(result.discovered.join(','), /codex\/tests\/x\.test\.js/);
      assert.deepEqual(result.unregistered, []);
    }
  );
});

test('checkTestRegistration reports unregistered codex tests', () => {
  // protects: unregistered codex tests are caught by the guard
  withRepo(
    [],
    ['codex/tests/x.test.js'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.unregistered, ['codex/tests/x.test.js']);
      assert.match(message, /Unregistered test files:/);
    }
  );
});

test('checkTestRegistration discovers .test.js files in shared/lib', () => {
  // protects: .test.js files are discovered alongside .test.ts files
  withRepo(
    ['shared/lib/x.test.js'],
    ['shared/lib/x.test.js'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);

      assert.equal(result.ok, true);
      assert.match(result.discovered.join(','), /shared\/lib\/x\.test\.js/);
      assert.deepEqual(result.unregistered, []);
    }
  );
});

test('checkTestRegistration allows standalone tests to exist unregistered', () => {
  // protects: intentional standalone tests do not trigger unregistered errors
  withRepo(
    [],
    ['shared/lib/github.test.js'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);

      assert.equal(result.ok, true);
      assert.deepEqual(result.unregistered, []);
      assert.deepEqual(result.standalone, ['shared/lib/github.test.js']);
      assert.match(formatTestRegistration(result), /1 standalone/);
    }
  );
});

test('checkTestRegistration reports missing standalone tests', () => {
  // protects: drift in the standalone allowlist is caught if a test disappears
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'test-registration-'));
  try {
    mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    writeFileSync(path.join(repoDir, 'tests', 'run-unit-tests.sh'), `TESTS=(\n)\n`);
    writeFileSync(path.join(repoDir, 'tests', 'run-custom-tests.sh'), `CUSTOM_TS_TESTS=(\n)\n\nCUSTOM_SH_TESTS=(\n)\n`);

    const result = checkTestRegistration(repoDir);
    const message = formatTestRegistration(result);

    assert.equal(result.ok, false);
    assert.deepEqual(result.standaloneMissing, ['shared/lib/github.test.js']);
    assert.match(message, /Missing standalone tests:/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('checkTestRegistration regression: existing passing fixture still passes', () => {
  // protects: no behavior change on the previous happy path (shared/tools only, .test.ts)
  withRepo(
    ['shared/lib/a.test.ts', 'tools/b.test.ts', 'src/c.test.ts'],
    ['shared/lib/a.test.ts', 'tools/b.test.ts', 'src/c.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);

      assert.equal(result.ok, true);
      assert.deepEqual(result.unregistered, []);
      assert.deepEqual(result.overlap, []);
      assert.match(formatTestRegistration(result), /4 discovered, 3 registered, 1 standalone/);
    }
  );
});
