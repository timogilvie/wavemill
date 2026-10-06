import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { archiveTaskResidue, findLatestResidueArchive } from './task-residue-archive.ts';

// HOK-3160 unit coverage for the archive-then-reap residue helper.

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'auto/integration', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], { stdio: 'ignore' });
}

test('archiveTaskResidue writes diff + untracked + index for a retired arm with dirty worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-residue-dirty-'));
  try {
    initRepo(root);
    // Modify a tracked file and add an untracked file.
    writeFileSync(join(root, 'README.md'), 'seed\nedited\n');
    writeFileSync(join(root, 'scratch.txt'), 'notes-from-the-arm\n');
    const result = archiveTaskResidue({
      issue: 'HOK-3160_c',
      worktree: root,
      repoDir: root,
      branch: 'task/demo',
      baseBranch: 'auto/integration',
      prNumber: '101',
      now: () => '2026-10-05T12:00:00Z',
    });
    assert.equal(result.success, true);
    assert.equal(result.untrackedCount, 1);
    assert.equal(result.bundlePath, undefined, 'PR-bearing arm must not create a bundle');
    assert.ok(existsSync(result.diffPath), 'diff.patch must exist');
    const diff = readFileSync(result.diffPath, 'utf-8');
    assert.ok(diff.includes('edited'), 'diff must include tracked-file changes');
    const indexPath = join(result.archivePath, 'index.json');
    assert.ok(existsSync(indexPath), 'index.json must exist');
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as { issue: string; untrackedCount: number; reason: string };
    assert.equal(index.issue, 'HOK-3160_c');
    assert.equal(index.untrackedCount, 1);
    assert.equal(index.reason, 'retired-arm-residue');
    const copied = join(result.archivePath, 'untracked', 'scratch.txt');
    assert.ok(existsSync(copied), 'untracked file must be copied');
    assert.equal(readFileSync(copied, 'utf-8'), 'notes-from-the-arm\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveTaskResidue bundles unpublished commits for a PR-less arm', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-residue-prless-'));
  try {
    initRepo(root);
    // Create a branch with an unpublished commit.
    execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'task/demo'], { stdio: 'ignore' });
    writeFileSync(join(root, 'feature.txt'), 'local work\n');
    execFileSync('git', ['-C', root, 'add', 'feature.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'feature'], { stdio: 'ignore' });

    const result = archiveTaskResidue({
      issue: 'HOK-3160_pl',
      worktree: root,
      repoDir: root,
      branch: 'task/demo',
      baseBranch: 'auto/integration',
      prNumber: '',
      now: () => '2026-10-05T12:30:00Z',
    });
    assert.equal(result.success, true);
    assert.ok(result.bundlePath, 'PR-less arm must receive a bundle');
    assert.ok(existsSync(result.bundlePath!), 'bundle file must be on disk');
    const index = JSON.parse(readFileSync(join(result.archivePath, 'index.json'), 'utf-8')) as { hasBundle: boolean; reason: string };
    assert.equal(index.hasBundle, true);
    assert.equal(index.reason, 'pr-less-arm-residue');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveTaskResidue retains a PR-less arm when its required bundle fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-residue-bundle-failure-'));
  try {
    initRepo(root);
    execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'task/demo'], { stdio: 'ignore' });
    writeFileSync(join(root, 'feature.txt'), 'local work\n');
    execFileSync('git', ['-C', root, 'add', 'feature.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'feature'], { stdio: 'ignore' });

    const result = archiveTaskResidue({
      issue: 'HOK-3160_bundle_failure',
      worktree: root,
      repoDir: root,
      branch: 'task/demo',
      baseBranch: 'auto/integration',
      now: () => '2026-10-05T12:45:00Z',
      git(args, cwd) {
        if (args.includes('bundle')) throw new Error('simulated bundle failure');
        return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      },
    });
    assert.equal(result.success, false);
    assert.match(result.failureReason ?? '', /^archive_bundle_create_failed:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveTaskResidue reports failure for an absent worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-residue-absent-'));
  try {
    initRepo(root);
    const result = archiveTaskResidue({
      issue: 'HOK-3160',
      worktree: join(root, 'does-not-exist'),
      repoDir: root,
      now: () => '2026-10-05T13:00:00Z',
    });
    assert.equal(result.success, false);
    assert.equal(result.failureReason, 'worktree_absent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveTaskResidue retains fail-closed when the archive directory cannot be written', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-residue-rdonly-'));
  try {
    initRepo(root);
    writeFileSync(join(root, 'scratch.txt'), 'x\n');
    // Pre-create .wavemill and make it read-only to block mkdir of subpaths.
    const wavemill = join(root, '.wavemill');
    mkdirSync(wavemill, { recursive: true });
    chmodSync(wavemill, 0o500);
    try {
      const result = archiveTaskResidue({
        issue: 'HOK-3160',
        worktree: root,
        repoDir: root,
        now: () => '2026-10-05T13:30:00Z',
      });
      assert.equal(result.success, false);
      assert.ok(result.failureReason?.startsWith('archive_mkdir_failed'), `expected mkdir failure, got ${result.failureReason}`);
    } finally {
      chmodSync(wavemill, 0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLatestResidueArchive returns the newest timestamped directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-residue-latest-'));
  try {
    initRepo(root);
    const r1 = archiveTaskResidue({
      issue: 'HOK-3160',
      worktree: root,
      repoDir: root,
      now: () => '2026-10-05T10:00:00Z',
    });
    assert.equal(r1.success, true);
    const r2 = archiveTaskResidue({
      issue: 'HOK-3160',
      worktree: root,
      repoDir: root,
      now: () => '2026-10-05T11:00:00Z',
    });
    assert.equal(r2.success, true);
    const latest = findLatestResidueArchive(root, 'HOK-3160');
    assert.equal(latest, r2.archivePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
