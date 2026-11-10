/**
 * Tests for test discovery (HOK-3466): suite membership comes from the file's
 * name and its optional marker, never from a list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverTestSuites, listShellScripts } from './test-discovery.ts';

function withRepo(files: Record<string, string>, fn: (repoDir: string) => void, { git = false } = {}): void {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'test-discovery-'));
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
      writeFileSync(path.join(repoDir, file), content);
    }
    if (git) execFileSync('git', ['init', '-q', repoDir]);
    fn(repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

// protects: a new test file that nobody listed anywhere silently never running
test('a test file joins its suite by name alone', () => {
  withRepo(
    {
      'shared/lib/a.test.ts': '',
      'tools/b.test.js': '',
      'tests/c.test.sh': '#!/usr/bin/env bash\n',
      'tests/nested/d.test.sh': '#!/usr/bin/env bash\n',
      'tests/helper.sh': '#!/usr/bin/env bash\n',
      'shared/lib/a.ts': '',
    },
    (repoDir) => {
      const suites = discoverTestSuites(repoDir);
      assert.deepEqual(suites.unit, ['shared/lib/a.test.ts', 'tools/b.test.js']);
      assert.deepEqual(suites.shell, ['c.test.sh', 'nested/d.test.sh']);
      assert.deepEqual(suites.custom, []);
    },
  );
});

// protects: a custom-harness or excluded test being run by the wrong runner, or by two runners
test('a marker moves a file to the declared suite, exactly once', () => {
  withRepo(
    {
      'shared/lib/custom.test.ts': '// wavemill-test-suite: custom\n',
      'shared/lib/doc.test.ts': '/**\n * wavemill-test-suite: custom\n */\n',
      'tests/custom.test.sh': '#!/usr/bin/env bash\n# wavemill-test-suite: custom\n',
      'tests/life.test.sh': '#!/usr/bin/env bash\n# wavemill-test-suite: lifecycle (run elsewhere)\n',
      'tests/live.test.ts': '// wavemill-test-suite: standalone\n',
      'tests/dead.test.sh': '#!/usr/bin/env bash\n# wavemill-test-suite: none\n',
      'tests/check-thing.sh': '#!/usr/bin/env bash\n# wavemill-test-suite: shell\n',
      'tests/plain.test.sh': '#!/usr/bin/env bash\n',
    },
    (repoDir) => {
      const suites = discoverTestSuites(repoDir);
      assert.deepEqual(suites.custom, ['shared/lib/custom.test.ts', 'shared/lib/doc.test.ts', 'tests/custom.test.sh']);
      assert.deepEqual(suites.shell, ['check-thing.sh', 'plain.test.sh']);
      assert.deepEqual(suites.unit, []);
      assert.deepEqual(suites.other, {
        lifecycle: ['tests/life.test.sh'],
        standalone: ['tests/live.test.ts'],
        none: ['tests/dead.test.sh'],
      });
    },
  );
});

// protects: a typo in a marker, or a misplaced shell test, dropping a test without anyone noticing
test('a file that cannot be placed fails discovery by name', () => {
  withRepo({ 'shared/lib/a.test.ts': '// wavemill-test-suite: custmo\n' }, (repoDir) => {
    assert.throws(() => discoverTestSuites(repoDir), /a\.test\.ts declares unknown suite "custmo"/);
  });
  withRepo({ 'shared/lib/a.test.sh': '#!/usr/bin/env bash\n' }, (repoDir) => {
    assert.throws(() => discoverTestSuites(repoDir), /a\.test\.sh is a shell test outside tests\//);
  });
  withRepo({ 'tests/a.test.sh': '#!/usr/bin/env bash\n# wavemill-test-suite: unit\n' }, (repoDir) => {
    assert.throws(() => discoverTestSuites(repoDir), /declares suite "unit" but is not a \.ts\/\.js file/);
  });
});

// protects: shard assignment changing between machines because of filesystem order
test('discovery order is code-point sorted', () => {
  withRepo({ 'tools/b.test.ts': '', 'tools/Z.test.ts': '', 'tools/a.test.ts': '', 'shared/z.test.ts': '' }, (repoDir) => {
    assert.deepEqual(discoverTestSuites(repoDir).unit, [
      'shared/z.test.ts',
      'tools/Z.test.ts',
      'tools/a.test.ts',
      'tools/b.test.ts',
    ]);
  });
});

// protects: tests inside ignored trees (node_modules, mill worktrees) being run, and new uncommitted tests being skipped
test('inside git, ignored files are skipped and untracked files are included', () => {
  withRepo(
    {
      '.gitignore': 'worktrees/\n',
      'worktrees/task/shared/lib/copy.test.ts': '',
      'shared/lib/new.test.ts': '',
    },
    (repoDir) => {
      assert.deepEqual(discoverTestSuites(repoDir).unit, ['shared/lib/new.test.ts']);
    },
    { git: true },
  );
});

// protects: a shell script escaping the bash -n syntax pass because nobody added it to a list
test('listShellScripts finds .sh files and extensionless shell scripts', () => {
  withRepo(
    {
      'shared/lib/a.sh': 'echo hi\n',
      'bin/tool': '#!/usr/bin/env bash\necho hi\n',
      'fixtures/agent/coding': '# shellcheck shell=bash\necho hi\n',
      'bin/py': '#!/usr/bin/env python3\n',
      'LICENSE': 'text\n',
      'notes.md': '#!/usr/bin/env bash\n',
    },
    (repoDir) => {
      assert.deepEqual(listShellScripts(repoDir), ['bin/tool', 'fixtures/agent/coding', 'shared/lib/a.sh']);
    },
  );
});
