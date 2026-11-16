import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSourceGuard } from './lib/source-guard.ts';
import { MODEL_INPUT_GUARD } from './check-model-input.ts';

function write(repo: string, relPath: string, contents: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function track(repo: string): void {
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
}

function patterns(repo: string): string[] {
  return runSourceGuard(MODEL_INPUT_GUARD, repo).findings.map((f) => f.pattern).sort();
}

describe('MODEL_INPUT_GUARD', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'model-input-'));
    execFileSync('git', ['init', '-q', repo]);
    write(repo, 'tools/model-input-allowlist.txt', '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // protects: a second PR-diff reader would see a different change than the reviewer.
  it('reports a gh pr diff call outside the reader', () => {
    write(repo, 'tools/x.ts', [
      "const diff = execFileSync('gh', ['pr', 'diff', '42']);",
      'const command = `gh pr diff 42`;',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), ['gh-pr-diff-outside-reader', 'gh-pr-diff-outside-reader']);
  });

  // protects: the one reader stays the allowed home for the diff call.
  it('does not report the call inside pr-diff-provider.ts', () => {
    write(repo, 'shared/lib/pr-diff-provider.ts', "const diff = spawnSync('gh', ['pr', 'diff', prNumber]);\n");
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: a shell caller must not shell out to gh pr diff either.
  it('reports gh pr diff in a shell script', () => {
    write(repo, 'scripts/fetch.sh', '#!/usr/bin/env bash\ngh pr diff "$1" > pr.diff\n');
    track(repo);
    assert.deepEqual(patterns(repo), ['gh-pr-diff-outside-reader']);
  });

  // protects: how much fits a model is the adapter's answer, not a byte cap.
  it('reports a new prompt byte cap', () => {
    write(repo, 'shared/lib/judge.ts', 'const MAX_JUDGE_PROMPT_BYTES = 1_000;\nfunction truncateDiffForPrompt() {}\n');
    track(repo);
    assert.deepEqual(patterns(repo), ['prompt-byte-cap', 'prompt-byte-cap']);
  });

  // protects: the reader's own stdout buffer bound is not a prompt-fit rule.
  it('does not report the PR-diff reader buffer bound', () => {
    write(repo, 'shared/lib/reader.ts', 'export const PR_DIFF_MAX_BYTES = 64 * 1024 * 1024;\n');
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: prose naming the shape is not an occurrence of it.
  it('ignores whole-line comments and JSDoc naming the shapes', () => {
    write(repo, 'shared/lib/doc.ts', [
      '// can be from `gh pr diff` or `git diff`',
      ' * @param diff - PR diff output (from `gh pr diff` or `git diff`)',
      '// MAX_JUDGE_PROMPT_BYTES was removed',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: one justified exception can be suppressed inline, with its reason.
  it('honours an inline allow-model-input marker', () => {
    write(repo, 'shared/lib/permissions.ts', [
      '// allow-model-input: an agent allow-rule, not a diff reader',
      "const pattern = 'gh pr diff*';",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: the guard runs clean against the real tree (two allowlisted
  // prompt-content slice names; no diff-reader bypass).
  it('runs clean on the current repository', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert.deepEqual(runSourceGuard(MODEL_INPUT_GUARD, repoRoot).findings, []);
  });
});
