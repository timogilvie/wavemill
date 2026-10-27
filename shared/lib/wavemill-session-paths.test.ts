import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CLAUDE_PROJECT_DIR_MAX_LENGTH,
  encodeProjectDir,
  resolveProjectsDir,
  resolveProjectsDirs,
} from './wavemill-session-paths.ts';

describe('encodeProjectDir', () => {
  it('replaces / with -', () => {
    assert.equal(encodeProjectDir('/Users/tim/worktrees/my-feature'), '-Users-tim-worktrees-my-feature');
  });

  it('ignores trailing slashes', () => {
    assert.equal(encodeProjectDir('/Users/tim/worktrees/my-feature/'), '-Users-tim-worktrees-my-feature');
  });

  it('replaces every non-alphanumeric character, as Claude Code does', () => {
    assert.equal(encodeProjectDir('/Users/tim/my.repo/wt_1'), '-Users-tim-my-repo-wt-1');
  });

  it('truncates names over 200 chars with the Claude Code hash suffix', () => {
    // Observed on disk: Claude Code stored this worktree's sessions under the
    // 200-char prefix plus `-erm9lf`.
    const worktree = '/Users/timothyogilvie/Dropbox/wavemill/worktrees/terminal-cleanup-must-reap-delivered-work-automatically-once-the-pr-is-merged-or-the-arm-is-retired-with-its-sibling-merged-and-linear-is-done-archive-any-residue-and-free-the-task-never-retain-it-indefinitely';
    const result = encodeProjectDir(worktree);
    assert.equal(result.length, 207);
    assert.equal(result.slice(0, CLAUDE_PROJECT_DIR_MAX_LENGTH), worktree.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
    assert.ok(result.endsWith('-erm9lf'), result);
    assert.notEqual(encodeProjectDir(`${worktree}-challenger`), result, 'sibling arms must not share a directory');
  });
});

describe('resolveProjectsDirs', () => {
  it('starts with the user Claude projects directory', () => {
    const worktreePath = '/nonexistent/worktree';
    assert.equal(resolveProjectsDir(worktreePath), join(homedir(), '.claude', 'projects', encodeProjectDir(worktreePath)));
    assert.deepEqual(resolveProjectsDirs(worktreePath), [resolveProjectsDir(worktreePath)]);
  });

  it('includes each DeepSeek provider transcript root that exists, and nothing else', () => {
    const base = mkdtempSync(join(tmpdir(), 'session-paths-'));
    try {
      const worktreePath = join(base, 'worktree');
      const encoded = encodeProjectDir(worktreePath);
      const runs = join(worktreePath, '.wavemill', 'runs');
      const providerProjectsDir = join(runs, 'HOK-1485', 'providers', 'deepseek', 'home', '.claude', 'projects', encoded);
      mkdirSync(providerProjectsDir, { recursive: true });
      // A run without a DeepSeek home, and a stray file, contribute nothing.
      mkdirSync(join(runs, 'HOK-1486'), { recursive: true });
      writeFileSync(join(runs, 'stray.txt'), '');

      assert.deepEqual(resolveProjectsDirs(worktreePath), [resolveProjectsDir(worktreePath), providerProjectsDir]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
