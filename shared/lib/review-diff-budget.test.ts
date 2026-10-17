import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_REVIEW_DIFF_MAX_CHARS,
  compactReviewDiff,
  isGeneratedReviewPath,
  listDiffPaths,
  readGeneratedFileInfo,
  resolveReviewDiffMaxChars,
} from './review-diff-budget.ts';

function newFileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function fileDiff(path: string, addedLines: number, lineText = 'x'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 0000000..1111111 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${addedLines} @@`,
    ...Array.from({ length: addedLines }, () => `+${lineText}`),
    '',
  ].join('\n');
}

function deletedFileDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-gone',
    '-also gone',
    '',
  ].join('\n');
}

/** A JSON report with `rows` rows; `mutate` tweaks it to make a sibling. */
function reportJson(rows: number, mutate: (report: { rows: Array<{ id: number; value: number }>; title: string }) => void = () => {}): string[] {
  const report = { title: 'report', rows: Array.from({ length: rows }, (_, id) => ({ id, value: id * 2 })) };
  mutate(report);
  return JSON.stringify(report, null, 2).split('\n');
}

describe('compactReviewDiff', () => {
  it('returns a diff that fits and has nothing to summarize unchanged', () => {
    const diff = fileDiff('src/a.ts', 3) + fileDiff('src/b.ts', 2);
    const result = compactReviewDiff(diff, { maxChars: 10_000 });
    assert.equal(result.diff, diff);
    assert.deepEqual(result.omitted, []);
    assert.deepEqual(result.unreviewed, []);
  });

  it('summarizes generated output by pattern and by caller-supplied info, naming the generator', () => {
    const diff = fileDiff('src/a.ts', 2)
      + fileDiff('packages/scan/action/dist/index.js', 5)
      + fileDiff('fixtures/report/full.v1.json', 4);
    const result = compactReviewDiff(diff, {
      maxChars: 10_000,
      generated: new Map([['fixtures/report/full.v1.json', { generator: 'pnpm export:report' }]]),
    });
    assert.deepEqual(result.omitted.map((entry) => [entry.path, entry.reason]), [
      ['packages/scan/action/dist/index.js', 'generated'],
      ['fixtures/report/full.v1.json', 'generated'],
    ]);
    assert.match(result.diff, /^# Review diff note: 2 changed file\(s\) are summarized/);
    assert.match(result.diff, /# Generated output \(review the generator, not its output\):/);
    assert.match(result.diff, /fixtures\/report\/full\.v1\.json \(\+4\/-0 lines; generator: pnpm export:report\)/);
    assert.ok(result.diff.includes('+++ b/src/a.ts'));
    assert.ok(!result.diff.includes('+++ b/fixtures/report/full.v1.json'));
    assert.deepEqual(result.unreviewed, []);
  });

  it('collapses a near-duplicate JSON family into a representative plus structural deltas', () => {
    const diff = newFileDiff('fixtures/invalid/a.json', reportJson(40, (r) => { r.title = 'A'; }))
      + newFileDiff('fixtures/invalid/b.json', reportJson(40, (r) => { r.rows[3].value = 999; }))
      + newFileDiff('fixtures/invalid/c.json', reportJson(40, (r) => { r.rows.pop(); }))
      + fileDiff('src/a.ts', 1);
    const result = compactReviewDiff(diff, { maxChars: 100_000 });

    const duplicates = result.omitted.filter((entry) => entry.reason === 'near-duplicate');
    assert.equal(duplicates.length, 2);
    const representative = duplicates[0].representative!;
    assert.ok(duplicates.every((entry) => entry.representative === representative));
    // The representative stays in full; siblings appear only as deltas.
    assert.ok(result.diff.includes(`+++ b/${representative}`));
    for (const entry of duplicates) assert.ok(!result.diff.includes(`+++ b/${entry.path}`));
    assert.match(result.diff, /# Near-duplicate family: 2 sibling\(s\) of fixtures\/invalid\/\w\.json/);
    assert.match(result.diff, /\$\.rows\[3\]\.value: (6 → 999|999 → 6)/);
    assert.match(result.diff, /\$\.rows\[39\]\.(id|value): (removed|added)/);
    assert.ok(result.diff.length < diff.length);
    assert.deepEqual(result.unreviewed, []);
  });

  it('does not collapse new files that differ substantially', () => {
    const diff = newFileDiff('fixtures/a.json', reportJson(40))
      + newFileDiff('fixtures/b.json', reportJson(40, (r) => { r.rows.forEach((row) => { row.value += 1; }); }))
      + newFileDiff('fixtures/c.json', reportJson(40, (r) => { r.rows.forEach((row) => { row.value -= 1; }); }));
    const result = compactReviewDiff(diff, { maxChars: 100_000 });
    assert.deepEqual(result.omitted, []);
    assert.equal(result.diff, diff);
  });

  it('collapses near-duplicate text files with positional line deltas', () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const variant = (index: number) => base.map((line, i) => (i === index ? `changed ${index}` : line));
    const diff = newFileDiff('docs/samples/a.txt', base)
      + newFileDiff('docs/samples/b.txt', variant(4))
      + newFileDiff('docs/samples/c.txt', variant(9));
    const result = compactReviewDiff(diff, { maxChars: 100_000 });
    assert.equal(result.omitted.filter((entry) => entry.reason === 'near-duplicate').length, 2);
    assert.match(result.diff, /line 5: "line 4" → "changed 4"/);
  });

  it('drops the largest hand-written files last, and reports them as unreviewed', () => {
    const small = fileDiff('src/small.ts', 10);
    const medium = fileDiff('src/medium.ts', 200);
    const large = fileDiff('src/large.ts', 2_000);
    const diff = small + large + medium;
    const result = compactReviewDiff(diff, { maxChars: small.length + medium.length + 2_000 });
    assert.deepEqual(result.unreviewed.map((entry) => [entry.path, entry.reason]), [['src/large.ts', 'size-budget']]);
    assert.match(result.diff, /# NOT REVIEWED: dropped to fit the reviewer input budget/);
    assert.match(result.diff, /src\/large\.ts \(\+2000\/-0 lines; \d+ chars\)/);
    assert.ok(result.diff.indexOf('+++ b/src/small.ts') < result.diff.indexOf('+++ b/src/medium.ts'));
  });

  it('names deleted files by their old path', () => {
    const diff = fileDiff('src/a.ts', 1) + deletedFileDiff('dist/old.js');
    const result = compactReviewDiff(diff, { maxChars: 10_000 });
    assert.deepEqual(result.omitted.map((entry) => [entry.path, entry.deletions]), [['dist/old.js', 2]]);
  });

  it('caps the listed entries and summarises the rest', () => {
    const diff = Array.from({ length: 105 }, (_, i) => fileDiff(`dist/chunk-${i}.js`, 1)).join('');
    const result = compactReviewDiff(diff, { maxChars: 100_000 });
    assert.equal(result.omitted.length, 105);
    assert.match(result.diff, /# {3}\.\.\. and 5 more/);
  });
});

describe('resolveReviewDiffMaxChars', () => {
  it('reads a positive integer override and falls back otherwise', () => {
    assert.equal(resolveReviewDiffMaxChars({ WAVEMILL_REVIEW_DIFF_MAX_CHARS: '1234' }), 1234);
    assert.equal(resolveReviewDiffMaxChars({ WAVEMILL_REVIEW_DIFF_MAX_CHARS: 'nope' }), DEFAULT_REVIEW_DIFF_MAX_CHARS);
    assert.equal(resolveReviewDiffMaxChars({ WAVEMILL_REVIEW_DIFF_MAX_CHARS: '0' }), DEFAULT_REVIEW_DIFF_MAX_CHARS);
    assert.equal(resolveReviewDiffMaxChars({}), DEFAULT_REVIEW_DIFF_MAX_CHARS);
  });
});

describe('isGeneratedReviewPath / listDiffPaths', () => {
  it('matches generated output but not source', () => {
    for (const path of ['dist/index.js', 'pkg/build/out.js', 'a.min.js', 'a.js.map', 'src/__snapshots__/x.snap', 'go.sum']) {
      assert.equal(isGeneratedReviewPath(path), true, path);
    }
    for (const path of ['src/dist.ts', 'src/builder.ts', 'fixtures/report.json', 'package.json']) {
      assert.equal(isGeneratedReviewPath(path), false, path);
    }
  });

  it('lists changed paths in diff order', () => {
    assert.deepEqual(listDiffPaths(fileDiff('b.ts', 1) + fileDiff('a.ts', 1)), ['b.ts', 'a.ts']);
    assert.deepEqual(listDiffPaths(''), []);
  });
});

describe('readGeneratedFileInfo', () => {
  function withRepo(run: (repoDir: string) => void) {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-diff-budget-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      run(repoDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }

  it('marks linguist-generated paths', () => {
    withRepo((repoDir) => {
      writeFileSync(join(repoDir, '.gitattributes'), 'schemas/*.json linguist-generated\n');
      const generated = readGeneratedFileInfo(repoDir, ['schemas/a.json', 'src/a.ts']);
      assert.deepEqual([...generated.keys()], ['schemas/a.json']);
    });
  });

  it('marks files listed by a PROVENANCE.json in their directory or an ancestor, with its command', () => {
    withRepo((repoDir) => {
      mkdirSync(join(repoDir, 'fixtures/report/invalid'), { recursive: true });
      writeFileSync(join(repoDir, 'fixtures/report/PROVENANCE.json'), JSON.stringify({
        command: 'pnpm export:arbiter-report',
        files: { 'full.v1.json': 'hash', 'invalid/bad.json': 'hash' },
      }));
      const generated = readGeneratedFileInfo(repoDir, [
        'fixtures/report/full.v1.json',
        'fixtures/report/invalid/bad.json',
        'fixtures/report/notes.md',
        'scripts/export.mjs',
      ]);
      assert.deepEqual([...generated.entries()], [
        ['fixtures/report/full.v1.json', { generator: 'pnpm export:arbiter-report' }],
        ['fixtures/report/invalid/bad.json', { generator: 'pnpm export:arbiter-report' }],
      ]);
    });
  });

  it('ignores a malformed manifest and works outside a git repository', () => {
    withRepo((repoDir) => {
      writeFileSync(join(repoDir, 'PROVENANCE.json'), '{not json');
      assert.equal(readGeneratedFileInfo(repoDir, ['a.json']).size, 0);
    });
    const dir = mkdtempSync(join(tmpdir(), 'review-diff-budget-nogit-'));
    try {
      assert.equal(readGeneratedFileInfo(join(dir, 'missing'), ['a.ts']).size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
