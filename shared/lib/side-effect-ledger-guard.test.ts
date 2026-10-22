import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { SIDE_EFFECT_LEDGER_GUARD } from './side-effect-ledger-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(SIDE_EFFECT_LEDGER_GUARD, file, source).map((finding) => finding.pattern);

describe('side-effect-ledger guard — effect sites', () => {
  it('flags git push as a command string or an argv array', () => {
    assert.deepEqual(patternsOf('a.sh', 'git -C "$REPO_DIR" push origin "$branch"\n'), ['git-push']);
    assert.deepEqual(patternsOf('a.ts', "runner('git push --force-with-lease origin HEAD');\n"), ['git-push']);
    assert.deepEqual(patternsOf('a.ts', "git(dir, ['push', remote, ref]);\n"), ['git-push']);
    assert.deepEqual(patternsOf('a.ts', "execFile('git', ['push', 'origin', '--delete', b]);\n"), ['git-push']);
  });

  it('flags gh pr merge, label writes, and Linear state transitions', () => {
    assert.deepEqual(patternsOf('a.sh', 'gh pr merge "$pr" --squash\n'), ['gh-pr-merge']);
    assert.deepEqual(patternsOf('a.ts', "gh(['pr', 'merge', String(pr)]);\n"), ['gh-pr-merge']);
    assert.deepEqual(patternsOf('a.sh', 'gh pr edit "$pr" --add-label wm:ready\n'), ['gh-label-write']);
    assert.deepEqual(patternsOf('a.ts', 'await client.updateIssue(id, { stateId: done.id });\n'), ['linear-state-transition']);
  });
});

describe('side-effect-ledger guard — clean shapes', () => {
  it('ignores stash push, unrelated push(), key tables, and prose', () => {
    const source = [
      'git stash push -u -m tag',
      'output.push(line);',
      "const kinds = [['push', 'S'], ['merge', 'S']];",
      '// git push happens in branch-publication.ts',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
    assert.deepEqual(patternsOf('a.sh', 'git stash push -m tag\n# gh pr merge is tend-only\n'), []);
  });

  it('honours the allow-side-effect-ledger suppression', () => {
    assert.deepEqual(patternsOf('a.ts', "// allow-side-effect-ledger: fixture text\nconst d = 'git push failed';\n"), []);
  });
});

describe('side-effect-ledger guard — repository', () => {
  it('passes at HEAD with the seeded count ratchet', () => {
    const result = runSourceGuard(SIDE_EFFECT_LEDGER_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(SIDE_EFFECT_LEDGER_GUARD, result));
  });
});
