import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { HEAD_PUBLICATION_GUARD } from './head-publication-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(HEAD_PUBLICATION_GUARD, file, source).map((finding) => finding.pattern);

describe('head-publication guard — push outside the seam (HOK-3370)', () => {
  it('flags a git push instruction in an agent prompt builder', () => {
    // protects: the deleted remediation/conflict prompt step 7 ("Push the
    // branch to update PR …") must not come back as a prompt instruction.
    assert.deepEqual(
      patternsOf('shared/lib/agent-adapters.sh', '7. Run git push origin to update the PR.\n'),
      ['push-outside-seam'],
    );
  });

  it('flags a raw git push in mill TS code', () => {
    assert.deepEqual(
      patternsOf('shared/lib/some-controller.ts', "exec(`git push origin ${branch}`);\n"),
      ['push-outside-seam'],
    );
  });

  it('flags a push step in a prompt template markdown file', () => {
    assert.deepEqual(
      patternsOf('tools/prompts/coding-phase.md', 'Then run `git push origin HEAD` to publish.\n'),
      ['push-outside-seam'],
    );
  });

  it('does not flag branch deletions or comments', () => {
    assert.deepEqual(patternsOf('a.ts', "git(['push', 'origin', '--delete', branch]);\n"), []);
    assert.deepEqual(patternsOf('a.sh', 'git push origin --delete "$branch"\n'), []);
    assert.deepEqual(patternsOf('a.ts', '// never git push here\n'), []);
    assert.deepEqual(patternsOf('a.sh', '# the mill handles git push\n'), []);
  });

  it('honours the allow-head-publication suppression', () => {
    assert.deepEqual(
      patternsOf('a.sh', '# allow-head-publication: documented operator recovery command\necho "git push origin $branch"\n'),
      [],
    );
  });
});

describe('head-publication guard — raw head-SHA freshness comparisons', () => {
  it('flags a TS raw compare against currentHeadSha', () => {
    // protects: pr-route-provenance\'s deleted `headSha !== currentHeadSha`
    // shape must not reappear — freshness goes through isEvidenceFresh.
    assert.deepEqual(
      patternsOf('shared/lib/some-provenance.ts', 'if (headSha && headSha !== currentHeadSha) return stale();\n'),
      ['raw-head-freshness-ts'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/other.ts', 'const stale = input.currentHeadSha !== recordHead;\n'),
      ['raw-head-freshness-ts'],
    );
  });

  it('flags a shell raw compare on review/capsule evidence heads', () => {
    assert.deepEqual(
      patternsOf('shared/lib/some-monitor.sh', '[[ "$current_head" != "$review_head" ]]\n'),
      ['raw-head-freshness-shell'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/some-monitor.sh', '[[ "$capsule_review_head" == "$current_head" ]] || return 1\n'),
      ['raw-head-freshness-shell'],
    );
  });

  it('leaves ordinary head reads and unrelated comparisons alone', () => {
    assert.deepEqual(patternsOf('a.sh', 'current_head=$(git -C "$wt" rev-parse HEAD)\n'), []);
    assert.deepEqual(patternsOf('a.ts', 'if (headSha === expectedSha) proceed();\n'), []);
  });
});

describe('head-publication guard — live tree', () => {
  it('passes on the current repository (allowlist covers the justified survivors)', () => {
    // protects: the ratchet itself — a new push site or raw compare anywhere
    // in the tree fails preflight until it routes through the seam/primitive.
    const result = runSourceGuard(HEAD_PUBLICATION_GUARD, repoRoot);
    assert.deepEqual(
      result.findings.map((f) => `${f.file}:${f.line} ${f.pattern}`),
      [],
    );
  });
});
