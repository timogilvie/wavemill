import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  classifyTestCommandScope,
  formatScriptExpansion,
  readScriptExpansion,
  resolvePackageScriptInvocation,
} from './test-command-scope.ts';

const tempDirs = new Set<string>();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorktree(packageJson?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-scope-'));
  tempDirs.add(dir);
  if (packageJson !== undefined) {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson), 'utf-8');
  }
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  return dir;
}

describe('resolvePackageScriptInvocation', () => {
  it('matches npm test and short forms', () => {
    assert.deepEqual(resolvePackageScriptInvocation(['npm', 'test']), { manager: 'npm', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['npm', 't']), { manager: 'npm', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['npm', 'run', 'test']), { manager: 'npm', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['npm', 'run-script', 'test']), { manager: 'npm', script: 'test', extraArgs: [] });
  });

  it('captures extra args and strips a leading --', () => {
    assert.deepEqual(resolvePackageScriptInvocation(['npm', 'test', 'a.test.ts']), { manager: 'npm', script: 'test', extraArgs: ['a.test.ts'] });
    assert.deepEqual(resolvePackageScriptInvocation(['npm', 'test', '--', '--grep', 'x']), { manager: 'npm', script: 'test', extraArgs: ['--grep', 'x'] });
  });

  it('skips leading noise flags', () => {
    assert.deepEqual(resolvePackageScriptInvocation(['npm', '--silent', '-s', 'test']), { manager: 'npm', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['npm', '--prefix', 'sub', 'test']), { manager: 'npm', script: 'test', extraArgs: [], prefix: 'sub' });
    assert.deepEqual(resolvePackageScriptInvocation(['npm', '--prefix=sub', 'test']), { manager: 'npm', script: 'test', extraArgs: [], prefix: 'sub' });
  });

  it('matches pnpm forms including bare pnpm <script>', () => {
    assert.deepEqual(resolvePackageScriptInvocation(['pnpm', 'test']), { manager: 'pnpm', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['pnpm', 'run', 'test']), { manager: 'pnpm', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['pnpm', 'test:unit']), { manager: 'pnpm', script: 'test:unit', extraArgs: [] });
    assert.equal(resolvePackageScriptInvocation(['pnpm', 'install']), null, 'builtins are not scripts');
  });

  it('matches yarn forms', () => {
    assert.deepEqual(resolvePackageScriptInvocation(['yarn', 'test']), { manager: 'yarn', script: 'test', extraArgs: [] });
    assert.deepEqual(resolvePackageScriptInvocation(['yarn', 'run', 'test']), { manager: 'yarn', script: 'test', extraArgs: [] });
  });

  it('returns null for non-package-manager invocations', () => {
    assert.equal(resolvePackageScriptInvocation(['node', '--test', 'a.ts']), null);
    assert.equal(resolvePackageScriptInvocation(['bash', 'tests/run-unit-tests.sh']), null);
    assert.equal(resolvePackageScriptInvocation([]), null);
  });
});

describe('classifyTestCommandScope — full-suite', () => {
  it('refuses npm/pnpm/yarn test with or without args', () => {
    const wt = makeWorktree({ scripts: { test: 'npm run a && npm run b' } });
    for (const argv of [
      ['npm', 'test'],
      ['npm', 't'],
      ['npm', 'run', 'test'],
      ['pnpm', 'test'],
      ['yarn', 'test'],
      ['npm', 'test', 'shared/lib/x.test.ts'],
      ['npm', 'test', '--', '--grep', 'something'],
    ]) {
      const scope = classifyTestCommandScope(argv, { cwd: wt, worktreePath: wt });
      assert.equal(scope.scope, 'full-suite', `expected full-suite for ${argv.join(' ')}`);
      assert.equal(scope.reason, 'package-test-script');
    }
  });

  it('refuses repo-suite runner invocations without a shard', () => {
    const wt = makeWorktree();
    for (const argv of [
      ['bash', 'tests/run-shell-suite.sh'],
      ['sh', 'tests/run-unit-tests.sh'],
      ['./tests/run-custom-tests.sh'],
      ['tests/run-lifecycle-tests.sh'],
    ]) {
      const scope = classifyTestCommandScope(argv, { cwd: wt, worktreePath: wt });
      assert.equal(scope.scope, 'full-suite', `expected full-suite for ${argv.join(' ')}`);
      assert.equal(scope.reason, 'repo-suite-runner');
    }
  });

  it('allows repo-suite runner with --shard or --list', () => {
    const wt = makeWorktree();
    for (const argv of [
      ['bash', 'tests/run-shell-suite.sh', '--shard', '2/3'],
      ['bash', 'tests/run-unit-tests.sh', '--list'],
      ['bash', 'tests/run-unit-tests.sh', '--shard=1/4'],
    ]) {
      const scope = classifyTestCommandScope(argv, { cwd: wt, worktreePath: wt });
      assert.equal(scope.scope, 'focused', `expected focused for ${argv.join(' ')}`);
    }
  });

  it('does not refuse named sub-suites like npm run test:unit', () => {
    const wt = makeWorktree({ scripts: { 'test:unit': 'bash tests/run-unit-tests.sh', test: 'npm run test:unit' } });
    const scope = classifyTestCommandScope(['npm', 'run', 'test:unit'], { cwd: wt, worktreePath: wt });
    assert.equal(scope.scope, 'focused');
  });
});

describe('classifyTestCommandScope — focused', () => {
  it('allows node --test and tsx --test and single-file bash tests', () => {
    const wt = makeWorktree();
    for (const argv of [
      ['node', '--test', 'a.test.ts'],
      ['npx', 'tsx', '--test', 'a.test.ts'],
      ['bash', 'tests/foo.test.sh'],
      ['bash', 'tests/run-shell-suite.sh', '--shard', '1/4'],
    ]) {
      const scope = classifyTestCommandScope(argv, { cwd: wt, worktreePath: wt });
      assert.equal(scope.scope, 'focused');
    }
  });
});

describe('readScriptExpansion', () => {
  it('reads the body and chained scripts', () => {
    const body = 'npm run test:preflight && npm run test:shell && npm run test:unit && npm run test:smoke';
    const wt = makeWorktree({ scripts: { test: body } });
    const expansion = readScriptExpansion({
      manager: 'npm',
      script: 'test',
      extraArgs: [],
      cwd: wt,
      worktreePath: wt,
    });
    assert.equal(expansion.body, body);
    assert.deepEqual(expansion.chainedScripts, ['test:preflight', 'test:shell', 'test:unit', 'test:smoke']);
    assert.equal(expansion.extraArgsNote, undefined);
  });

  it('adds an extraArgsNote that names the last chained script', () => {
    const body = 'npm run a && npm run b && npm run c';
    const wt = makeWorktree({ scripts: { test: body } });
    const expansion = readScriptExpansion({
      manager: 'npm',
      script: 'test',
      extraArgs: ['shared/lib/x.test.ts'],
      cwd: wt,
      worktreePath: wt,
    });
    assert.ok(expansion.extraArgsNote?.includes('shared/lib/x.test.ts'), expansion.extraArgsNote);
    assert.ok(expansion.extraArgsNote?.includes('(c)'), expansion.extraArgsNote);
  });

  it('builds an extraArgsNote for a non-chain body', () => {
    const wt = makeWorktree({ scripts: { test: 'node --test some.ts' } });
    const expansion = readScriptExpansion({
      manager: 'npm',
      script: 'test',
      extraArgs: ['x'],
      cwd: wt,
      worktreePath: wt,
    });
    assert.ok(expansion.extraArgsNote?.includes('node --test some.ts'), expansion.extraArgsNote);
  });

  it('returns null body when package.json is missing or invalid', () => {
    const wt = makeWorktree();
    assert.equal(readScriptExpansion({ manager: 'npm', script: 'test', extraArgs: [], cwd: wt, worktreePath: wt }).body, null);

    const bad = makeWorktree();
    writeFileSync(path.join(bad, 'package.json'), '{ not json', 'utf-8');
    assert.equal(readScriptExpansion({ manager: 'npm', script: 'test', extraArgs: [], cwd: bad, worktreePath: bad }).body, null);
  });

  it('walks from cwd up to worktreePath but never above', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'test-scope-outside-'));
    tempDirs.add(outside);
    writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'echo outside' } }), 'utf-8');

    const wt = path.join(outside, 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'echo inside' } }), 'utf-8');
    const nested = path.join(wt, 'nested', 'deeper');
    mkdirSync(nested, { recursive: true });

    const expansion = readScriptExpansion({ manager: 'npm', script: 'test', extraArgs: [], cwd: nested, worktreePath: wt });
    assert.equal(expansion.body, 'echo inside');
  });
});

describe('formatScriptExpansion', () => {
  it('emits a compact block with chain', () => {
    const text = formatScriptExpansion({
      manager: 'npm',
      script: 'test',
      body: 'npm run a && npm run b',
      packageJsonPath: '/tmp/package.json',
      chainedScripts: ['a', 'b'],
      extraArgs: [],
      extraArgsNote: undefined,
    });
    assert.match(text, /npm test runs: npm run a && npm run b/);
    assert.match(text, /Chain: a → b/);
  });

  it('includes the extraArgsNote when present', () => {
    const text = formatScriptExpansion({
      manager: 'npm',
      script: 'test',
      body: 'npm run a && npm run b',
      packageJsonPath: '/tmp/package.json',
      chainedScripts: ['a', 'b'],
      extraArgs: ['x'],
      extraArgsNote: 'Extra arguments (x) are appended to the last command of the chain (b).',
    });
    assert.match(text, /Extra arguments \(x\)/);
  });
});
