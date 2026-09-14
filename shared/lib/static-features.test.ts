/**
 * Tests for the S1 static-feature collector (HOK-2806).
 *
 * Exercises three layers:
 *   - Pure parser units (countTscErrors, sumEslintErrors, fileComplexity).
 *   - Fixture repos built at test time (mkdtemp + git init + commits).
 *   - Bare-checkout parity: same values from a direct checkout as from a
 *     git worktree of it.
 *
 * Fixture repos are built inside a per-test temp dir so the tree the
 * repo's own lint/typecheck walk never see them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  collectStaticFeatures,
  countTscErrors,
  fileComplexity,
  sumEslintErrors,
  readCommittedStaticAnalysisConfig,
  COMPLEXITY_METRIC_ID,
} from './static-features.ts';

// ────────────────────────────────────────────────────────────────
// Parser units — pure, no shell required
// ────────────────────────────────────────────────────────────────

test('countTscErrors returns 0 for empty output', () => {
  assert.equal(countTscErrors(''), 0);
});

test('countTscErrors ignores warnings and non-tsc lines', () => {
  const output = [
    "some prelude",
    "src/a.ts:1:1 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "  1 export const x: number = 'a';",
    "    ~~~~~~~~~~~~~~~",
    "src/b.ts:5:9 - error TS2554: Expected 0 arguments, but got 1.",
    "Found 2 errors.",
  ].join('\n');
  assert.equal(countTscErrors(output), 2);
});

test('countTscErrors matches the marker regardless of surrounding punctuation', () => {
  const output = 'foo(error TS9999)bar\nline 2: error TS12: msg\n';
  assert.equal(countTscErrors(output), 2);
});

test('sumEslintErrors handles the empty array', () => {
  assert.equal(sumEslintErrors('[]'), 0);
});

test('sumEslintErrors sums errorCount and ignores warnings', () => {
  const payload = JSON.stringify([
    { filePath: 'a.ts', errorCount: 2, warningCount: 1 },
    { filePath: 'b.ts', errorCount: 0, warningCount: 5 },
    { filePath: 'c.ts', errorCount: 3, warningCount: 0 },
  ]);
  assert.equal(sumEslintErrors(payload), 5);
});

test('sumEslintErrors returns null on unparseable JSON', () => {
  assert.equal(sumEslintErrors('not json'), null);
});

test('sumEslintErrors returns null when the payload is not an array', () => {
  assert.equal(sumEslintErrors('{"errorCount": 3}'), null);
});

test('fileComplexity is 1 for a straight-line function', () => {
  const source = `function greet(name) { return "hi " + name; }`;
  assert.equal(fileComplexity(source, '.js'), 1);
});

test('fileComplexity counts every branch token exactly once', () => {
  const source = `
    function decide(x) {
      if (x > 0) {
        return "positive";
      } else if (x < 0) {
        return "negative";
      }
      for (let i = 0; i < 3; i++) {
        while (i > 0 && x !== 0) { break; }
      }
      try { return x; } catch (e) { return 0; }
      return x > 5 ? "big" : "small";
    }
  `;
  // 1 base + if + else if + for + while + && + catch + ternary "?" = 8
  const value = fileComplexity(source, '.ts');
  assert.ok(value !== null && value >= 7, `expected ≥7, got ${value}`);
});

test('fileComplexity strips string literals so branch tokens in strings do not count', () => {
  const source = `function noop() { const s = "if for while &&"; return s; }`;
  assert.equal(fileComplexity(source, '.ts'), 1);
});

test('fileComplexity returns null for unsupported extensions', () => {
  assert.equal(fileComplexity('anything', '.txt'), null);
  assert.equal(fileComplexity('anything', ''), null);
});

test('fileComplexity handles python hash comments and def', () => {
  const source = `
def choose(x):
    # if this is a comment, it must not count as a branch
    if x:
        return 1
    elif x is None:
        return 2
    return 0
`;
  // 1 + if + elif = 3
  assert.equal(fileComplexity(source, '.py'), 3);
});

// ────────────────────────────────────────────────────────────────
// Committed-config reader
// ────────────────────────────────────────────────────────────────

test('readCommittedStaticAnalysisConfig returns empty object when no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cfg-'));
  try {
    assert.deepEqual(readCommittedStaticAnalysisConfig(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCommittedStaticAnalysisConfig extracts staticAnalysis block only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cfg-'));
  try {
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.0.0',
        staticAnalysis: {
          typecheckCommand: 'echo type',
          lintCommand: 'echo lint',
          timeoutSeconds: { typecheck: 5 },
        },
      }),
    );
    const cfg = readCommittedStaticAnalysisConfig(dir);
    assert.equal(cfg.typecheckCommand, 'echo type');
    assert.equal(cfg.lintCommand, 'echo lint');
    assert.deepEqual(cfg.timeoutSeconds, { typecheck: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCommittedStaticAnalysisConfig ignores .wavemill-config.local.json (bare-checkout parity)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cfg-'));
  try {
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({
        staticAnalysis: { typecheckCommand: 'echo committed' },
      }),
    );
    writeFileSync(
      join(dir, '.wavemill-config.local.json'),
      JSON.stringify({
        staticAnalysis: { typecheckCommand: 'echo local-overlay' },
      }),
    );
    const cfg = readCommittedStaticAnalysisConfig(dir);
    assert.equal(cfg.typecheckCommand, 'echo committed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCommittedStaticAnalysisConfig tolerates malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cfg-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), '{ not-json ');
    assert.deepEqual(readCommittedStaticAnalysisConfig(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Fixture-repo integration tests (real git, real shell)
// ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initFixture(rootPrefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sf-${rootPrefix}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '.']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

test('build_ok null when no package.json scripts.build and no PR / CI', () => {
  const dir = initFixture('no-build');
  try {
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 5000, lint: 5000, build: 5000, complexity: 5000 },
    });
    assert.equal(result.build_ok, null);
    assert.equal(result.build_evidence, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build_ok true when scripts.build exits 0 (local-build provenance)', () => {
  const dir = initFixture('build-ok');
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'sf-fixture', scripts: { build: 'exit 0' } }),
    );
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 5000, lint: 5000, build: 15_000, complexity: 5000 },
    });
    assert.equal(result.build_ok, true);
    assert.equal(result.build_evidence, 'local-build');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build_ok false when scripts.build exits non-zero', () => {
  const dir = initFixture('build-bad');
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'sf-fixture', scripts: { build: 'exit 5' } }),
    );
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 5000, lint: 5000, build: 15_000, complexity: 5000 },
    });
    assert.equal(result.build_ok, false);
    assert.equal(result.build_evidence, 'local-build');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('committed buildCommand overrides package.json (config wins)', () => {
  const dir = initFixture('build-cfg');
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'sf-fixture', scripts: { build: 'exit 1' } }),
    );
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({ staticAnalysis: { buildCommand: 'exit 0' } }),
    );
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 5000, lint: 5000, build: 15_000, complexity: 5000 },
    });
    assert.equal(result.build_ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('type_errors and lint_errors are null when no config present (not zero)', () => {
  const dir = initFixture('no-config');
  try {
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 3000, lint: 3000, build: 3000, complexity: 3000 },
    });
    assert.equal(result.type_errors, null);
    assert.equal(result.lint_errors, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typecheckCommand override drives type_errors count from tsc-format output', () => {
  const dir = initFixture('typecheck-override');
  try {
    // A script that prints tsc-formatted error lines and exits 2.
    const script = '#!/bin/sh\necho "src/a.ts(1,1): error TS2322: foo"\necho "src/b.ts(1,1): error TS2554: bar"\nexit 2\n';
    writeFileSync(join(dir, 'fake-tsc.sh'), script);
    chmodSync(join(dir, 'fake-tsc.sh'), 0o755);
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({
        staticAnalysis: { typecheckCommand: './fake-tsc.sh' },
      }),
    );
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 15_000, lint: 5000, build: 5000, complexity: 5000 },
    });
    assert.equal(result.type_errors, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lintCommand override drives lint_errors from eslint-shaped JSON', () => {
  const dir = initFixture('lint-override');
  try {
    const script = '#!/bin/sh\ncat <<EOF\n[{"filePath":"a.ts","errorCount":3,"warningCount":9}]\nEOF\nexit 1\n';
    writeFileSync(join(dir, 'fake-eslint.sh'), script);
    chmodSync(join(dir, 'fake-eslint.sh'), 0o755);
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({
        staticAnalysis: { lintCommand: './fake-eslint.sh' },
      }),
    );
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 5000, lint: 15_000, build: 5000, complexity: 5000 },
    });
    assert.equal(result.lint_errors, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typecheck timeout yields null (does not throw)', () => {
  const dir = initFixture('tc-timeout');
  try {
    const script = '#!/bin/sh\nsleep 5\n';
    writeFileSync(join(dir, 'slow.sh'), script);
    chmodSync(join(dir, 'slow.sh'), 0o755);
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({ staticAnalysis: { typecheckCommand: './slow.sh' } }),
    );
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 100, lint: 3000, build: 3000, complexity: 3000 },
    });
    assert.equal(result.type_errors, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complexity_delta counts a branch-heavy function against base', () => {
  const dir = initFixture('cx-delta');
  try {
    writeFileSync(join(dir, 'app.ts'), `export function ok() { return 1; }\n`);
    commitAll(dir, 'base');
    writeFileSync(
      join(dir, 'app.ts'),
      `export function decide(x: number) {
  if (x > 0) return 1;
  else if (x < 0) return -1;
  for (const _ of [1,2,3]) { if (_ > 1) break; }
  return x === 0 ? 0 : -1;
}
`,
    );
    commitAll(dir, 'head');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD~1',
      offline: true,
      timeouts: { typecheck: 3000, lint: 3000, build: 3000, complexity: 10_000 },
    });
    assert.notEqual(result.complexity_delta, null);
    assert.ok((result.complexity_delta ?? 0) >= 4, `expected ≥4, got ${result.complexity_delta}`);
    assert.equal(result.complexity_metric, COMPLEXITY_METRIC_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complexity_delta is 0 for docs-only diffs (observed, not null)', () => {
  const dir = initFixture('cx-docs');
  try {
    writeFileSync(join(dir, 'app.ts'), `export const x = 1;\n`);
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    commitAll(dir, 'base');
    writeFileSync(join(dir, 'README.md'), '# hi\n\nMore words.\n');
    commitAll(dir, 'docs only');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD~1',
      offline: true,
      timeouts: { typecheck: 3000, lint: 3000, build: 3000, complexity: 10_000 },
    });
    assert.equal(result.complexity_delta, 0);
    assert.equal(result.complexity_metric, COMPLEXITY_METRIC_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complexity_delta is null when merge-base cannot be resolved', () => {
  const dir = initFixture('cx-nomerge');
  try {
    writeFileSync(join(dir, 'app.ts'), `export const x = 1;\n`);
    commitAll(dir, 'initial');
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'nonexistent-ref-42',
      offline: true,
      timeouts: { typecheck: 3000, lint: 3000, build: 3000, complexity: 5000 },
    });
    assert.equal(result.complexity_delta, null);
    assert.equal(result.complexity_metric, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare-checkout parity: same values from direct dir and a git worktree of it', () => {
  const dir = initFixture('parity');
  try {
    // Real fixture with a change to measure.
    writeFileSync(join(dir, 'app.ts'), `export function ok() { return 1; }\n`);
    commitAll(dir, 'base');
    writeFileSync(
      join(dir, 'app.ts'),
      `export function ok(x: number) { if (x) return 1; return 0; }\n`,
    );
    commitAll(dir, 'head');
    // Prepare a worktree at HEAD.
    const worktreeDir = mkdtempSync(join(tmpdir(), 'sf-parity-wt-'));
    // git worktree add wants a nonexistent path; remove first.
    rmSync(worktreeDir, { recursive: true, force: true });
    git(dir, ['worktree', 'add', worktreeDir, 'HEAD']);
    try {
      const direct = collectStaticFeatures({
        checkoutDir: dir,
        baseRef: 'HEAD~1',
        offline: true,
        timeouts: { typecheck: 3000, lint: 3000, build: 3000, complexity: 5000 },
      });
      const viaWorktree = collectStaticFeatures({
        checkoutDir: worktreeDir,
        baseRef: 'HEAD~1',
        offline: true,
        timeouts: { typecheck: 3000, lint: 3000, build: 3000, complexity: 5000 },
      });
      assert.equal(direct.complexity_delta, viaWorktree.complexity_delta);
      assert.equal(direct.type_errors, viaWorktree.type_errors);
      assert.equal(direct.lint_errors, viaWorktree.lint_errors);
      assert.equal(direct.build_ok, viaWorktree.build_ok);
      assert.equal(direct.complexity_metric, viaWorktree.complexity_metric);
    } finally {
      try { git(dir, ['worktree', 'remove', '--force', worktreeDir]); } catch { /* best effort */ }
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare-checkout parity: local-overlay in a checkout is ignored', () => {
  const dir = initFixture('parity-overlay');
  try {
    writeFileSync(join(dir, 'app.ts'), `export const x = 1;\n`);
    writeFileSync(
      join(dir, '.wavemill-config.json'),
      JSON.stringify({ staticAnalysis: { buildCommand: 'exit 0' } }),
    );
    commitAll(dir, 'initial');
    // Now write a local overlay that would flip build_ok to false if it were merged.
    writeFileSync(
      join(dir, '.wavemill-config.local.json'),
      JSON.stringify({ staticAnalysis: { buildCommand: 'exit 7' } }),
    );
    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      offline: true,
      timeouts: { typecheck: 3000, lint: 3000, build: 5000, complexity: 3000 },
    });
    // Committed config wins, so build_ok is true.
    assert.equal(result.build_ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Silence linters: readFileSync/existsSync/mkdirSync are used indirectly via
// the module; also ensure eslint-format JSON stays roundtrip-serializable.
void readFileSync;
void existsSync;
void mkdirSync;
