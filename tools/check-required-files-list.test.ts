import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'tools', 'check-required-files-list.ts');

function runGuard(repoDir: string): { ok: boolean; stdout: string; stderr: string } {
  const result = execSync(`npx tsx ${CLI} ${repoDir}`, {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: true, stdout: result, stderr: '' };
}

function runGuardCatch(repoDir: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    return runGuard(repoDir);
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    };
  }
}

function initRepo(repoDir: string): void {
  execSync('git init -b main', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(join(repoDir, 'README.md'), '# repo\n');
  execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });
}

test('check-required-files-list fails on a second required-files list', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'required-files-list-'));
  try {
    initRepo(repoDir);
    const decoyDir = join(repoDir, 'shared', 'lib');
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(
      join(decoyDir, 'decoy-guard.ts'),
      `export const MY_REQUIRED = [\n` +
      `  'tests/run-unit-tests.sh',\n` +
      `  'tests/run-shell-suite.sh',\n` +
      `  'tests/journeys/',\n` +
      `];\n`,
    );
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "decoy"', { cwd: repoDir, stdio: 'ignore' });

    const result = runGuardCatch(repoDir);

    assert.equal(result.ok, false);
    assert.match(result.stderr, /decoy-guard\.ts/);
    assert.match(result.stderr, /duplicate required-files list/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('check-required-files-list passes when an allowlisted file stays at its count', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'required-files-list-'));
  try {
    initRepo(repoDir);
    const allowlistDir = join(repoDir, 'tools');
    mkdirSync(allowlistDir, { recursive: true });
    writeFileSync(
      join(allowlistDir, 'required-files-list-allowlist.txt'),
      'shared/lib/conflict-scorer.ts  2  # test allowlist\n',
    );
    const scorerDir = join(repoDir, 'shared', 'lib');
    mkdirSync(scorerDir, { recursive: true });
    writeFileSync(
      join(scorerDir, 'conflict-scorer.ts'),
      `export const LOW_CONFLICT = [\n` +
      `  'tests/run-unit-tests.sh',\n` +
      `  'tests/run-shell-suite.sh',\n` +
      `];\n`,
    );
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "scorer"', { cwd: repoDir, stdio: 'ignore' });

    const result = runGuard(repoDir);

    assert.equal(result.ok, true);
    assert.match(result.stdout, /required-files-list: ok/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('check-required-files-list honours a per-line suppression marker', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'required-files-list-'));
  try {
    initRepo(repoDir);
    const decoyDir = join(repoDir, 'shared', 'lib');
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(
      join(decoyDir, 'legacy-guard.ts'),
      `export const LEGACY_REQUIRED = [\n` +
      `  'tests/run-unit-tests.sh', // allow-required-files-list: legacy registry\n` +
      `  'tests/run-shell-suite.sh', // allow-required-files-list: legacy registry\n` +
      `];\n`,
    );
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "legacy"', { cwd: repoDir, stdio: 'ignore' });

    const result = runGuard(repoDir);

    assert.equal(result.ok, true);
    assert.match(result.stdout, /required-files-list: ok/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
