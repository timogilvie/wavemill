import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { BASE_MERGE_GUARD } from './base-merge-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(BASE_MERGE_GUARD, file, source).map((finding) => finding.pattern);

describe('base-merge guard — prompt instructions (HOK-3385)', () => {
  it('flags the deleted fetch/merge prompt steps so they cannot come back', () => {
    // protects: the HOK-3374 incident shape — a native resolver prompted to
    // run git fetch + git merge, tools its runtime does not have.
    assert.deepEqual(
      patternsOf('shared/lib/agent-adapters.sh', '   git fetch origin $base_branch\n'),
      ['prompt-merge-instruction', 'base-integration-instruction'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/agent-adapters.sh', '   git merge origin/$base_branch\n'),
      ['prompt-merge-instruction', 'base-integration-instruction', 'mill-base-merge-sh'],
    );
  });

  it('flags the deleted rebase-alternative note shape', () => {
    // protects: tend_attempt_conflict_prompt_note's "git rebase origin/<base>"
    // prose instruction must not be reintroduced in any prompt surface.
    assert.deepEqual(
      patternsOf(
        'shared/lib/wavemill-monitor.sh',
        'Instead of step 3, rebase the branch onto origin/$base_branch (git rebase origin/$base_branch).\n',
      ),
      ['base-integration-instruction', 'mill-base-merge-sh'],
    );
  });

  it('flags a merge instruction in a prompt template markdown file', () => {
    assert.deepEqual(
      patternsOf('tools/prompts/coding-phase.md', '2. git merge origin/main into your branch\n'),
      ['prompt-merge-instruction', 'base-integration-instruction', 'mill-base-merge-sh'],
    );
  });
});

describe('base-merge guard — mill-side merges outside the primitive', () => {
  it('flags a private TS shell merge or rebase', () => {
    // protects: a new base-integration mover (HOK-3347) must call
    // updateBranchWithBase, never a private `git merge`/`git rebase`.
    assert.deepEqual(
      // allow-template-curly: fixture source text fed to the guard, ${base} is literal
      patternsOf('shared/lib/some-mover.ts', 'shellRunner(`git merge --no-edit ${base}`);\n'),
      ['mill-base-merge-ts'],
    );
    // The sh-only instruction patterns do not apply to TS files, so only
    // the mill-side pattern fires here.
    assert.deepEqual(
      patternsOf('shared/lib/some-mover.ts', "shellRunner('git rebase origin/main');\n"),
      ['mill-base-merge-ts'],
    );
  });

  it('leaves merge-base, merge-tree, quiet fetch plumbing and permission patterns alone', () => {
    assert.deepEqual(patternsOf('shared/lib/a.ts', "run('git merge-base main HEAD');\n"), []);
    assert.deepEqual(patternsOf('shared/lib/a.ts', "run('git merge-tree --write-tree a b');\n"), []);
    assert.deepEqual(patternsOf('shared/lib/a.sh', 'git -C "$wt" fetch --quiet origin "$base" || true\n'), []);
    assert.deepEqual(patternsOf('shared/lib/a.ts', "patterns = ['git rebase*', 'git merge*'];\n"), []);
    assert.deepEqual(patternsOf('shared/lib/a.sh', '# the mill runs git merge origin/base here\n'), []);
  });

  it('honours the allow-base-merge suppression', () => {
    assert.deepEqual(
      patternsOf('shared/lib/a.sh', '# allow-base-merge: log message, not an instruction\nwarn "git fetch origin $b failed"\n'),
      [],
    );
  });
});

describe('base-merge guard — live tree', () => {
  it('passes on the current repository (allowlist covers the justified survivors)', () => {
    // protects: the ratchet itself — a new prompt merge instruction or
    // private mill merge anywhere in the tree fails preflight until it
    // routes through updateBranchWithBase.
    const result = runSourceGuard(BASE_MERGE_GUARD, repoRoot);
    assert.deepEqual(
      result.findings.map((f) => `${f.file}:${f.line} ${f.pattern}`),
      [],
    );
  });
});
