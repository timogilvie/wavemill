import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { fetchPrDiff, isTooLargeDiffError, type PrDiffRunOptions } from './pr-diff-provider.ts';

const TOO_LARGE_STDERR = `HTTP 406: Sorry, the diff exceeded the maximum number of files (300).
Consider using 'List pull requests files' API or locally cloning the repository instead.
PullRequest.diff too_large`;

function ghError(message: string): Error {
  return Object.assign(new Error(message), { stderr: message });
}

function metadata(): string {
  return JSON.stringify({
    url: 'https://github.com/org/repo/pull/1197',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'head-sha',
  });
}

/** A runGit that answers the local-git diff path for `head-sha`, returning `diff`. */
function localGitDiff(diff: string) {
  return mock.fn((args: string[]) => {
    if (args[0] === 'fetch') return '';
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'merge-base') return 'base-sha';
    if (args[0] === 'diff') return diff;
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
}

function failingLocalGit() {
  return mock.fn((args: string[]) => {
    if (args[0] === 'fetch') throw new Error('fetch failed');
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
}

describe('fetchPrDiff', () => {
  it('reads local git first, honouring .gitattributes, and never calls gh pr diff', () => {
    const runGh = mock.fn((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') return metadata();
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = localGitDiff('diff --git a/a.ts b/a.ts\n+local\n');

    const result = fetchPrDiff('1197', '/repo', { runGh, runGit });

    assert.equal(result.kind, 'diff');
    assert.equal(result.kind === 'diff' && result.source, 'local-git');
    assert.equal(result.kind === 'diff' && result.text, 'diff --git a/a.ts b/a.ts\n+local\n');
    assert.equal(result.kind === 'diff' && result.headSha, 'head-sha');
    // gh is used for metadata, but never for the diff itself.
    assert.equal(runGh.mock.calls.filter((call) => call.arguments[0] === 'pr' && call.arguments[1] === 'diff').length, 0);
  });

  it('falls back to gh pr diff when the local objects cannot be fetched', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[1] === 'view') return metadata();
      if (args[1] === 'diff') {
        assert.deepEqual(args, ['pr', 'diff', '1197']);
        return 'diff --git a/big.ts b/big.ts\n+from gh\n';
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = failingLocalGit();

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit });

      assert.equal(result.kind, 'diff');
      assert.equal(result.kind === 'diff' && result.source, 'gh-pr-diff');
      assert.match(result.kind === 'diff' ? result.text : '', /from gh/);
      assert.equal(result.kind === 'diff' && result.headSha, undefined);
      // The attempts record the order: local tried first, then gh.
      assert.match(result.attempts[0], /^local-git:/);
      assert.ok(result.attempts.some((attempt) => attempt.startsWith('gh pr diff: ok')));
    } finally {
      warn.mock.restore();
    }
  });

  it('returns unavailable when both local git and gh pr diff fail', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[1] === 'diff') throw ghError(TOO_LARGE_STDERR);
      if (args[1] === 'view') return metadata();
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = failingLocalGit();

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit });

      assert.equal(result.kind, 'unavailable');
      assert.equal(result.kind === 'unavailable' && result.reason, 'gh_too_large');
      assert.match(result.kind === 'unavailable' ? result.detail : '', /HTTP 406/);
      assert.notEqual(result.kind === 'unavailable' && result.detail, '(PR diff unavailable)');
    } finally {
      warn.mock.restore();
    }
  });

  it('reports a missing PR as pr_metadata_missing', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[1] === 'view') throw ghError('gh pr view failed: no pull requests found');
      if (args[1] === 'diff') throw ghError('gh pr diff failed');
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit: failingLocalGit() });
      assert.equal(result.kind, 'unavailable');
      assert.equal(result.kind === 'unavailable' && result.reason, 'pr_metadata_missing');
    } finally {
      warn.mock.restore();
    }
  });

  it('classifies a local buffer overrun as unavailable, not an empty diff', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[1] === 'view') return metadata();
      if (args[1] === 'diff') return 'x'.repeat(20);
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = mock.fn((args: string[], options?: PrDiffRunOptions) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'diff') {
        assert.equal(options?.encoding, 'buffer');
        return 'y'.repeat(20);
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit, maxBytes: 5 });

      assert.equal(result.kind, 'unavailable');
      assert.equal(result.kind === 'unavailable' && result.reason, 'buffer_overrun');
      assert.notEqual(result.kind === 'diff' && result.text, '');
    } finally {
      warn.mock.restore();
    }
  });

  it('goes straight to gh pr diff --repo when a repo override is set', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      assert.deepEqual(args, ['pr', 'diff', '1197', '--repo', 'other/repo']);
      return 'diff --git a/a.ts b/a.ts\n+other\n';
    });
    const runGit = mock.fn(() => {
      throw new Error('local git must not run for a repo override');
    });

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit, repo: 'other/repo' });
      assert.equal(result.kind, 'diff');
      assert.equal(result.kind === 'diff' && result.source, 'gh-pr-diff');
      assert.equal(runGit.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it('preserves an empty successful local diff', () => {
    const result = fetchPrDiff('123', '/repo', {
      runGh: () => metadata(),
      runGit: localGitDiff(''),
    });
    assert.equal(result.kind, 'diff');
    assert.equal(result.kind === 'diff' && result.text, '');
    assert.equal(result.kind === 'diff' && result.bytes, 0);
  });

  // protects: local git honours `.gitattributes -diff`, so a generated file
  // arrives as git's binary line rather than its full text (HOK-3493).
  it('gets Binary files differ for a file marked -diff in a real repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pr-diff-local-'));
    const bare = mkdtempSync(join(tmpdir(), 'pr-diff-origin-'));
    const git = (args: string[], cwd = repo) =>
      execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git(['init', '-q', '--bare', '-b', 'main', bare]);
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      writeFileSync(join(repo, '.gitattributes'), 'generated/*.cjs linguist-generated=true -diff\n');
      mkdirSync(join(repo, 'generated'), { recursive: true });
      writeFileSync(join(repo, 'generated', 'big.validator.cjs'), 'before\n');
      writeFileSync(join(repo, 'src.ts'), 'export const a = 1;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
      git(['remote', 'add', 'origin', bare]);
      git(['push', '-q', 'origin', 'main']);
      writeFileSync(join(repo, 'generated', 'big.validator.cjs'), 'after\n');
      writeFileSync(join(repo, 'src.ts'), 'export const a = 2;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'change']);
      const headSha = git(['rev-parse', 'HEAD']);
      // The PR head is on origin as a pull ref, as the mill's base checkout sees it.
      git(['push', '-q', 'origin', `HEAD:refs/pull/7/head`]);

      const result = fetchPrDiff('7', repo, {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return JSON.stringify({
              url: 'https://github.com/org/repo/pull/7',
              headRefName: 'feature',
              baseRefName: 'main',
              headRefOid: headSha,
            });
          }
          throw new Error(`unexpected gh ${args.join(' ')}`);
        },
      });

      assert.equal(result.kind, 'diff');
      const text = result.kind === 'diff' ? result.text : '';
      assert.match(text, /Binary files .*generated\/big\.validator\.cjs.* differ/);
      assert.match(text, /\+export const a = 2;/);
      assert.doesNotMatch(text, /\+after/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('isTooLargeDiffError', () => {
  it('matches GitHub diff-too-large errors but not unrelated failures', () => {
    assert.equal(isTooLargeDiffError(TOO_LARGE_STDERR), true);
    assert.equal(isTooLargeDiffError('PullRequest.diff too_large'), true);
    assert.equal(isTooLargeDiffError('HTTP 404: Not Found'), false);
  });
});
