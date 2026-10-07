/**
 * Real-git fixture tests for the self-review diff base (HOK-3166).
 *
 * Reproduces the stale-local-base bug: a task worktree's local
 * `auto/integration` lags `origin/auto/integration`, the task branch merges
 * the newer origin tip, and a bare `auto/integration...HEAD` diff then pulls
 * another PR's merged work into the review. All repos live under mkdtemp
 * (HOK-3157: tests never write tracked repo paths).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeDiffMetadata, getGitDiff } from './review-context-gatherer.ts';
import {
  resolveReviewDiffBase,
  REVIEW_SKIP_FETCH_ENV,
} from './git-base-resolver.ts';

const BASE = 'auto/integration';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '--quiet', '-m', message);
}

function changedFiles(repoDir: string, ref: string): string[] {
  return analyzeDiffMetadata(getGitDiff(ref, repoDir)).files.sort();
}

interface Fixture {
  root: string;
  seed: string;
  work: string;
  /** origin/auto/integration tip before the other PR merged. */
  oldBaseSha: string;
  /** origin/auto/integration tip after the other PR merged. */
  newBaseSha: string;
}

/**
 * origin.git ← seed (pushes auto/integration) ; work = clone with a local
 * auto/integration branch frozen at the old tip, a task branch with its own
 * commit, and a merge of the newer origin/auto/integration.
 */
function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'review-diff-base-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const work = join(root, 'work');

  git(root, 'init', '--quiet', '--bare', origin);
  git(root, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '--quiet', '-b', BASE);
  commitFile(seed, 'base.txt', 'v1\n', 'seed base');
  git(seed, 'push', '--quiet', 'origin', BASE);
  const oldBaseSha = git(seed, 'rev-parse', 'HEAD');

  git(root, 'clone', '--quiet', origin, work);
  git(work, 'branch', BASE, `origin/${BASE}`);
  git(work, 'checkout', '--quiet', '-b', 'task/x', BASE);
  commitFile(work, 'task-own.ts', 'export const own = 1;\n', 'task change');

  // Another PR merges into integration after the worktree was cut.
  commitFile(seed, 'other-pr.ts', 'export const other = 1;\n', 'other PR');
  writeFileSync(join(seed, 'base.txt'), 'v2\n');
  git(seed, 'commit', '--quiet', '-am', 'other PR touches base');
  git(seed, 'push', '--quiet', 'origin', BASE);
  const newBaseSha = git(seed, 'rev-parse', 'HEAD');

  // The task branch merges the newer origin tip; local auto/integration stays old.
  git(work, 'fetch', '--quiet', 'origin');
  git(work, 'merge', '--quiet', '--no-ff', '--no-edit', `origin/${BASE}`);

  return { root, seed, work, oldBaseSha, newBaseSha };
}

describe('review diff base (HOK-3166)', () => {
  let fixture: Fixture;
  let previousSkipFetch: string | undefined;

  beforeEach(() => {
    previousSkipFetch = process.env[REVIEW_SKIP_FETCH_ENV];
    delete process.env[REVIEW_SKIP_FETCH_ENV];
    fixture = buildFixture();
  });

  afterEach(() => {
    if (previousSkipFetch === undefined) delete process.env[REVIEW_SKIP_FETCH_ENV];
    else process.env[REVIEW_SKIP_FETCH_ENV] = previousSkipFetch;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('reproduces the bug: a bare local-base three-dot diff includes the other PR', () => {
    assert.equal(git(fixture.work, 'rev-parse', BASE), fixture.oldBaseSha);
    const raw = git(fixture.work, 'diff', '--name-only', `refs/heads/${BASE}...HEAD`).split('\n').sort();
    assert.deepEqual(raw, ['base.txt', 'other-pr.ts', 'task-own.ts']);
  });

  it('getGitDiff on the bare base name reviews only the branch\'s own changes', () => {
    assert.deepEqual(changedFiles(fixture.work, BASE), ['task-own.ts']);
  });

  it('refreshes a never-fetched origin/<b> and diffs only the branch\'s own changes', () => {
    // Simulate a worktree whose remote-tracking ref predates the other PR,
    // while the branch already contains the newer integration commits.
    git(fixture.work, 'update-ref', `refs/remotes/origin/${BASE}`, fixture.oldBaseSha);
    assert.deepEqual(changedFiles(fixture.work, BASE).length, 3, 'stale origin ref reproduces the superset');

    const base = resolveReviewDiffBase(fixture.work, BASE);
    assert.equal(base.fetch, 'fetched');
    assert.equal(base.kind, 'remote');
    assert.equal(base.ref, `origin/${BASE}`);
    assert.equal(base.baseSha, fixture.newBaseSha);
    assert.equal(base.mergeBaseSha, fixture.newBaseSha);
    assert.deepEqual(changedFiles(fixture.work, base.ref), ['task-own.ts']);
  });

  it('WAVEMILL_REVIEW_SKIP_FETCH=1 leaves the remote-tracking ref untouched', () => {
    git(fixture.work, 'update-ref', `refs/remotes/origin/${BASE}`, fixture.oldBaseSha);
    process.env[REVIEW_SKIP_FETCH_ENV] = '1';

    const base = resolveReviewDiffBase(fixture.work, BASE);
    assert.equal(base.fetch, 'skipped');
    assert.equal(base.baseSha, fixture.oldBaseSha);
  });

  it('passes explicit refs through: origin/<b> and a 40-hex SHA', () => {
    const viaOrigin = resolveReviewDiffBase(fixture.work, `origin/${BASE}`);
    assert.equal(viaOrigin.kind, 'explicit');
    assert.equal(viaOrigin.ref, `origin/${BASE}`);
    assert.deepEqual(changedFiles(fixture.work, viaOrigin.ref), ['task-own.ts']);

    const viaSha = resolveReviewDiffBase(fixture.work, fixture.newBaseSha);
    assert.equal(viaSha.kind, 'explicit');
    assert.equal(viaSha.fetch, 'skipped');
    assert.equal(viaSha.ref, fixture.newBaseSha);
    assert.deepEqual(changedFiles(fixture.work, viaSha.ref), ['task-own.ts']);
  });

  it('falls back to the local branch when the repo has no origin (back-compat)', () => {
    git(fixture.work, 'remote', 'remove', 'origin');

    const base = resolveReviewDiffBase(fixture.work, BASE);
    assert.equal(base.kind, 'local');
    assert.equal(base.fetch, 'failed');
    assert.equal(base.ref, BASE);
    assert.equal(base.baseSha, fixture.oldBaseSha);
    // Without an origin ref the local base is all there is; the diff still works.
    assert.ok(changedFiles(fixture.work, base.ref).includes('task-own.ts'));
  });

  it('degrades to null SHAs in a non-git directory instead of throwing', () => {
    const plain = mkdtempSync(join(tmpdir(), 'review-diff-base-plain-'));
    try {
      const base = resolveReviewDiffBase(plain, BASE);
      assert.equal(base.fetch, 'failed');
      assert.equal(base.kind, 'local');
      assert.equal(base.baseSha, null);
      assert.equal(base.mergeBaseSha, null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
