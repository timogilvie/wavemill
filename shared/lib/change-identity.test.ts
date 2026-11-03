/**
 * Tests for the one head-freshness primitive (HOK-3370).
 *
 * Real temporary repositories: patch-id equivalence under base merges and
 * rebases is git behaviour, not something an in-memory fixture can prove.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';

import { computeChangeIdentity, isEvidenceFresh } from './change-identity.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeAndCommit(repo: string, fileName: string, content: string, message: string): string {
  writeFileSync(join(repo, fileName), content, 'utf-8');
  git(repo, ['add', fileName]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

interface Fixture {
  repoDir: string;
  baseSha: string;
  taskHead: string;
}

function createFixture(): Fixture {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'change-identity-'));
  tempDirs.push(tmpDir);
  const repoDir = join(tmpDir, 'work');
  execFileSync('git', ['init', repoDir], { encoding: 'utf-8' });
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Change Identity Test']);
  writeAndCommit(repoDir, 'base.txt', 'base\n', 'base');
  git(repoDir, ['branch', '-M', 'main']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['switch', '-c', 'task/test']);
  const taskHead = writeAndCommit(repoDir, 'feature.txt', 'feature\n', 'feature');
  return { repoDir, baseSha, taskHead };
}

describe('computeChangeIdentity', () => {
  it('is stable across a base merge (same diff, new head)', () => {
    // protects: a mill base merge must NOT stale review evidence (HOK-3361
    // operator touch #2 — the update-from-base staled the review and nothing
    // re-ran it).
    const f = createFixture();
    const before = computeChangeIdentity(f.repoDir, f.taskHead, 'main');
    assert.ok(before);

    // Base advances with an unrelated commit; merge it into the task branch.
    git(f.repoDir, ['switch', 'main']);
    writeAndCommit(f.repoDir, 'other.txt', 'other\n', 'unrelated base work');
    git(f.repoDir, ['switch', 'task/test']);
    git(f.repoDir, ['merge', '--no-edit', 'main']);
    const mergedHead = git(f.repoDir, ['rev-parse', 'HEAD']);
    assert.notEqual(mergedHead, f.taskHead);

    const after = computeChangeIdentity(f.repoDir, mergedHead, 'main');
    assert.ok(after);
    assert.equal(after!.changeId, before!.changeId);
  });

  it('is stable across a clean rebase', () => {
    const f = createFixture();
    const before = computeChangeIdentity(f.repoDir, f.taskHead, 'main');
    git(f.repoDir, ['switch', 'main']);
    writeAndCommit(f.repoDir, 'other.txt', 'other\n', 'unrelated base work');
    git(f.repoDir, ['switch', 'task/test']);
    git(f.repoDir, ['rebase', 'main']);
    const rebasedHead = git(f.repoDir, ['rev-parse', 'HEAD']);
    assert.notEqual(rebasedHead, f.taskHead);

    const after = computeChangeIdentity(f.repoDir, rebasedHead, 'main');
    assert.equal(after!.changeId, before!.changeId);
  });

  it('changes when a code-changing commit lands', () => {
    // protects: a reviewer/remediation commit MUST stale review evidence.
    const f = createFixture();
    const before = computeChangeIdentity(f.repoDir, f.taskHead, 'main');
    const fixedHead = writeAndCommit(f.repoDir, 'feature.txt', 'feature fixed\n', 'review fix');
    const after = computeChangeIdentity(f.repoDir, fixedHead, 'main');
    assert.notEqual(after!.changeId, before!.changeId);
  });

  it('returns null for unreachable objects', () => {
    const f = createFixture();
    assert.equal(computeChangeIdentity(f.repoDir, 'f'.repeat(40), 'main'), null);
  });

  it('reports an empty diff distinctly', () => {
    const f = createFixture();
    const id = computeChangeIdentity(f.repoDir, f.baseSha, 'main');
    assert.equal(id!.changeId, 'empty');
  });
});

describe('isEvidenceFresh', () => {
  it('fast-paths identical heads without computing identities', () => {
    const f = createFixture();
    const result = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: f.taskHead,
      currentHeadSha: f.taskHead,
      baseRef: 'main',
    });
    assert.deepEqual(result, { fresh: true, reason: 'same-head' });
  });

  it('keeps evidence fresh across a base merge', () => {
    const f = createFixture();
    git(f.repoDir, ['switch', 'main']);
    writeAndCommit(f.repoDir, 'other.txt', 'other\n', 'unrelated base work');
    git(f.repoDir, ['switch', 'task/test']);
    git(f.repoDir, ['merge', '--no-edit', 'main']);
    const mergedHead = git(f.repoDir, ['rev-parse', 'HEAD']);

    const result = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: f.taskHead,
      currentHeadSha: mergedHead,
      baseRef: 'main',
    });
    assert.equal(result.fresh, true);
    assert.equal(result.reason, 'same-change-identity');
  });

  it('stales evidence on a code-changing commit', () => {
    const f = createFixture();
    const fixedHead = writeAndCommit(f.repoDir, 'feature.txt', 'feature fixed\n', 'review fix');
    const result = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: f.taskHead,
      currentHeadSha: fixedHead,
      baseRef: 'main',
    });
    assert.deepEqual(result, { fresh: false, reason: 'change-identity-differs' });
  });

  it('uses a stored evidence change id without needing the evidence head', () => {
    const f = createFixture();
    const identity = computeChangeIdentity(f.repoDir, f.taskHead, 'main');
    git(f.repoDir, ['switch', 'main']);
    writeAndCommit(f.repoDir, 'other.txt', 'other\n', 'unrelated base work');
    git(f.repoDir, ['switch', 'task/test']);
    git(f.repoDir, ['merge', '--no-edit', 'main']);
    const mergedHead = git(f.repoDir, ['rev-parse', 'HEAD']);

    const result = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: 'f'.repeat(40), // unreachable — the stored id must carry it
      currentHeadSha: mergedHead,
      baseRef: 'main',
      evidenceChangeId: identity!.changeId,
    });
    assert.equal(result.fresh, true);
  });

  it('treats an unreachable evidence head as stale, never fresh', () => {
    // protects: "cannot prove freshness" must fail toward re-review, never
    // toward trusting stale evidence.
    const f = createFixture();
    const newHead = writeAndCommit(f.repoDir, 'feature.txt', 'feature v2\n', 'more work');
    const result = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: 'f'.repeat(40),
      currentHeadSha: newHead,
      baseRef: 'main',
    });
    assert.deepEqual(result, { fresh: false, reason: 'evidence-head-unreachable' });
  });
});
