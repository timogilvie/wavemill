import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import {
  MERGE_BLOCK_WRITERS_GUARD,
  RECONCILER_LABEL_SCOPE_GUARD,
} from './merge-block-writers-guard.ts';

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

describe('reconciler-label-scope guard — the reconciler writes only ready/blocked (HOK-3449)', () => {
  const reconcilerPatterns = (source: string) =>
    checkGuardSource(RECONCILER_LABEL_SCOPE_GUARD, 'shared/lib/merge-labels.ts', source)
      .map((finding) => finding.pattern);

  it('flags every label helper other than setMergeLabel', () => {
    assert.deepEqual(reconcilerPatterns('clearWavemillState(7);\n'), ['reconciler-label-helper']);
    assert.deepEqual(reconcilerPatterns('setWavemillReady(7);\n'), ['reconciler-label-helper']);
    assert.deepEqual(reconcilerPatterns('addWavemillRisky(7);\n'), ['reconciler-label-helper']);
  });

  it('flags raw label writes and foreign labels', () => {
    assert.deepEqual(reconcilerPatterns('removeLabelFromPullRequest(7, WM_LABELS.approved);\n'), [
      'reconciler-raw-label-write',
      'reconciler-foreign-label',
    ]);
    assert.deepEqual(reconcilerPatterns('const m = WM_LABELS.merging;\n'), ['reconciler-foreign-label']);
    assert.deepEqual(reconcilerPatterns("labels.has('wavemill');\n"), ['reconciler-foreign-label']);
  });

  it('ignores the sanctioned writer and the two scope labels', () => {
    assert.deepEqual(reconcilerPatterns('writeMergeLabel(7, null);\n'), []);
    assert.deepEqual(reconcilerPatterns('setMergeLabel(7, WM_LABELS.ready);\n'), []);
    assert.deepEqual(reconcilerPatterns("if (currentLabels.has('wm:blocked')) {}\n"), []);
  });

  it('does not fire the scoped patterns outside the reconciler', () => {
    assert.deepEqual(
      checkGuardSource(
        RECONCILER_LABEL_SCOPE_GUARD,
        'shared/lib/tend-controller.ts',
        'setWavemillReady(pr);\nremoveLabelFromPullRequest(pr, WM_LABELS.approved);\n',
      ),
      [],
    );
  });

  describe('merge-label-write-scope structural check', () => {
    const scope = (body: string) => [
      'export const MERGE_LABEL_WRITE_SCOPE = [WM_LABELS.ready, WM_LABELS.blocked] as const;',
      '',
      'export function setMergeLabel(prNumber: number, label: MergeLabel | null): SetMergeLabelResult {',
      body,
      '}',
      '',
    ].join('\n');

    const scopeFindings = (source: string) =>
      checkGuardSource(RECONCILER_LABEL_SCOPE_GUARD, 'shared/lib/pr-state-labels.ts', source)
        .map((finding) => finding.pattern);

    it('accepts the two-label scope and the lane-lock read', () => {
      assert.deepEqual(
        scopeFindings(scope([
          "  const clear = MERGE_LABEL_WRITE_SCOPE.filter((s) => s !== label);",
          "  if (holdsMergeLaneLock(pr.labels)) return { pr, written: false };",
          "  return { pr: transitionPullRequestLabels(prNumber, label ? [label] : [], clear, options), written: true };",
        ].join('\n'))),
        [],
      );
    });

    it('fails when the scope set widens', () => {
      const widened = scope('  return { pr, written: false };')
        .replace('WM_LABELS.blocked]', 'WM_LABELS.blocked, WM_LABELS.superseded]');
      assert.deepEqual(scopeFindings(widened), ['merge-label-write-scope']);
    });

    it('fails when the setter body names another label', () => {
      assert.deepEqual(
        scopeFindings(scope("  labelsToRemove.push(WM_LABELS.approved);\n  return { pr, written: false };")),
        ['merge-label-write-scope'],
      );
    });
  });

  it('passes the reconciler scope guard at HEAD', () => {
    const result = runSourceGuard(RECONCILER_LABEL_SCOPE_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(RECONCILER_LABEL_SCOPE_GUARD, result));
    assert.ok(result.scannedFiles > 0);
  });
});

describe('merge-block-writers guard — repository', () => {
  it('passes at HEAD with the seeded allowlist', () => {
    const result = runSourceGuard(MERGE_BLOCK_WRITERS_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(MERGE_BLOCK_WRITERS_GUARD, result));
    assert.ok(result.scannedFiles > 0);
  });
});
