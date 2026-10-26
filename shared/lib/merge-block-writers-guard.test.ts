import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { MERGE_BLOCK_WRITERS_GUARD } from './merge-block-writers-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(MERGE_BLOCK_WRITERS_GUARD, file, source).map((finding) => finding.pattern);

describe('merge-block-writers guard — forbidden shapes', () => {
  it('flags a private wm:blocked writer', () => {
    assert.deepEqual(patternsOf('a.ts', 'setWavemillBlocked(pr, { reason });\n'), ['set-wavemill-blocked']);
    assert.deepEqual(patternsOf('a.ts', 'await deps.releaseToBlocked(candidate.number);\n'), ['release-to-blocked']);
  });

  it('flags a private wm:blocked clearer', () => {
    assert.deepEqual(patternsOf('a.ts', 'removeLabelFromPullRequest(pr, WM_LABELS.blocked, {});\n'), ['blocked-label-clear']);
    assert.deepEqual(patternsOf('a.ts', "removeLabelFromPullRequest(pr, 'wm:blocked');\n"), ['blocked-label-clear']);
    assert.deepEqual(patternsOf('a.sh', 'gh pr edit "$pr" --remove-label wm:blocked\n'), ['blocked-label-clear']);
  });

  it('flags a raw gh pr comment in TS and shell', () => {
    assert.deepEqual(patternsOf('a.ts', 'run(`gh pr comment 7 --body x`);\n'), ['gh-pr-comment']);
    assert.deepEqual(patternsOf('a.ts', "tryGh(['pr', 'comment', n, '--body-file', f]);\n"), ['gh-pr-comment']);
    assert.deepEqual(patternsOf('a.sh', 'gh pr comment "$pr" --body "$body"\n'), ['gh-pr-comment']);
  });
});

describe('merge-block-writers guard — clean shapes', () => {
  it('ignores lane-progression writes, reads of the label, and prose', () => {
    const source = [
      'removeLabelFromPullRequest(prNumber, WM_LABELS.merging);',
      'if (labels.has(WM_LABELS.blocked)) {',
      'setWavemillMerging(prNumber, { markerRoot });',
      'postMergeStatusComment({ prNumber, phase, headSha, baseSha, body, repoDir, shellRunner });',
      '// tend no longer calls setWavemillBlocked or runs gh pr comment directly',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
  });

  it('honours the allow-merge-block-writer suppression', () => {
    assert.deepEqual(patternsOf('a.ts', '// allow-merge-block-writer: fixture\nsetWavemillBlocked(1);\n'), []);
  });

  it('names the reconciler and the merge-status poster as the invariant source', () => {
    for (const path of ['shared/lib/merge-labels.ts', 'shared/lib/pr-state-labels.ts', 'shared/lib/merge-status-comment.ts']) {
      assert.ok(MERGE_BLOCK_WRITERS_GUARD.invariantPaths.includes(path), path);
    }
  });
});

describe('merge-block-writers guard — repository', () => {
  it('passes at HEAD with the seeded allowlist', () => {
    const result = runSourceGuard(MERGE_BLOCK_WRITERS_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(MERGE_BLOCK_WRITERS_GUARD, result));
    assert.ok(result.scannedFiles > 0);
  });
});
