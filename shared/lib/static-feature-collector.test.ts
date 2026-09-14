import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  collectStaticFeatures,
  parseEslintErrorCount,
  parseMypyErrorCount,
  parseRuffErrorCount,
  parseTscErrorCount,
} from './static-feature-collector.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'static-features-'));
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function initGitRepo(): string {
  const dir = tempDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  return dir;
}

function commitAll(dir: string, message: string): string {
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('static feature parsers', () => {
  it('counts tsc diagnostics and summary output', () => {
    assert.equal(parseTscErrorCount('', 0), 0);
    assert.equal(parseTscErrorCount('a.ts(1,1): error TS2345: nope\nb.ts(2,1): error TS7006: nope', 2), 2);
    assert.equal(parseTscErrorCount('Found 7 errors in 2 files.', 2), 7);
    assert.equal(parseTscErrorCount('internal crash', 2), null);
  });

  it('counts eslint errors without warnings', () => {
    assert.equal(parseEslintErrorCount('[{"errorCount":2,"warningCount":9},{"errorCount":0}]'), 2);
    assert.equal(parseEslintErrorCount('[]'), 0);
    assert.equal(parseEslintErrorCount('not json'), null);
  });

  it('counts ruff and mypy output', () => {
    assert.equal(parseRuffErrorCount('[{"code":"F401"},{"code":"E501"}]'), 2);
    assert.equal(parseRuffErrorCount('[]'), 0);
    assert.equal(parseMypyErrorCount('Found 5 errors in 3 files', 1), 5);
    assert.equal(parseMypyErrorCount('Success: no issues found in 4 source files', 0), 0);
  });
});

describe('collectStaticFeatures tool detection', () => {
  it('chooses tsc when tsconfig and a local binary are present', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeExecutable(join(dir, 'node_modules', '.bin', 'tsc'), '#!/usr/bin/env bash\necho "Found 3 errors in 2 files."\nexit 2\n');
    commitAll(dir, 'base');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: 'HEAD' });
    assert.equal(result.type_errors, 3);
    assert.equal(result.collection.typeChecker, 'tsc');
  });

  it('uses null rather than zero when configured tools cannot run', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
    writeFileSync(join(dir, 'eslint.config.js'), 'export default [];\n');
    commitAll(dir, 'base');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: 'HEAD' });
    assert.equal(result.type_errors, null);
    assert.equal(result.lint_errors, null);
    assert.equal(result.collection.reasons.type_errors, 'deps-not-installed');
    assert.equal(result.collection.reasons.lint_errors, 'deps-not-installed');
  });

  it('falls back to package lint script and treats exit 0 as observed zero', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }));
    commitAll(dir, 'base');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: 'HEAD' });
    assert.equal(result.lint_errors, 0);
    assert.equal(result.collection.linter, 'package-script');
  });

  it('maps terminal CI evidence to build_ok when no build script exists', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'README.md'), 'base\n');
    commitAll(dir, 'base');

    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      ciEvidence: { ran: true, allTerminal: true, passed: false },
    });
    assert.equal(result.build_ok, false);
    assert.equal(result.collection.buildEvidence, 'ci-terminal');
  });

  it('leaves build_ok null for legacy ran:false CI evidence', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'README.md'), 'base\n');
    commitAll(dir, 'base');

    const result = collectStaticFeatures({
      checkoutDir: dir,
      baseRef: 'HEAD',
      ciEvidence: { ran: false, allTerminal: true, passed: true },
    });
    assert.equal(result.build_ok, null);
    assert.equal(result.collection.buildEvidence, null);
  });

  it('guards tool fields on expected head mismatch but still computes complexity', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }));
    const base = commitAll(dir, 'base');
    writeFileSync(join(dir, 'code.js'), 'if (x) y();\n');
    commitAll(dir, 'head');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: base, expectedHeadSha: base });
    assert.equal(result.lint_errors, null);
    assert.equal(result.collection.reasons.lint_errors, 'head-mismatch');
    assert.equal(result.complexity_delta, 1);
  });
});

describe('collectStaticFeatures complexity_delta', () => {
  it('computes branch-count complexity deltas from git objects', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'code.ts'), 'export function f() { return 1; }\n');
    const base = commitAll(dir, 'base');
    writeFileSync(join(dir, 'code.ts'), 'export function f(x) { if (x && y) return 1; if (z) return 2; return 3; }\n');
    commitAll(dir, 'head');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: base });
    assert.equal(result.complexity_delta, 3);
    assert.equal(result.collection.complexityMetric, 'hok-branch-count/1');
  });

  it('returns zero for docs-only diffs', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'README.md'), 'base\n');
    const base = commitAll(dir, 'base');
    writeFileSync(join(dir, 'README.md'), 'base\nmore\n');
    commitAll(dir, 'head');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: base });
    assert.equal(result.complexity_delta, 0);
    assert.equal(result.collection.complexityMetric, 'hok-branch-count/1');
  });

  it('returns null when the diff cannot be resolved', () => {
    const dir = initGitRepo();
    writeFileSync(join(dir, 'code.ts'), 'if (x) y();\n');
    commitAll(dir, 'base');

    const result = collectStaticFeatures({ checkoutDir: dir, baseRef: 'missing-ref' });
    assert.equal(result.complexity_delta, null);
    assert.equal(result.collection.reasons.complexity_delta, 'diff-unavailable');
  });
});
