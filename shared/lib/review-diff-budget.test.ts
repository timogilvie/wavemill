import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_REVIEW_DIFF_MAX_CHARS,
  compactReviewDiff,
  isGeneratedReviewPath,
  listDiffPaths,
  readLinguistGeneratedPaths,
  resolveReviewDiffMaxChars,
} from './review-diff-budget.ts';

function fileDiff(path: string, addedLines: number, lineText = 'x'): string {
  const body = Array.from({ length: addedLines }, () => `+${lineText}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'index 0000000..1111111 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${addedLines} @@`,
    body,
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

describe('compactReviewDiff', () => {
  it('returns a diff that fits and has no generated files unchanged', () => {
    const diff = fileDiff('src/a.ts', 3) + fileDiff('src/b.ts', 2);
    const result = compactReviewDiff(diff, { maxChars: 10_000 });
    assert.equal(result.diff, diff);
    assert.deepEqual(result.omitted, []);
  });

  it('always omits generated output, even when the diff fits', () => {
    const diff = fileDiff('src/a.ts', 2) + fileDiff('packages/scan/action/dist/index.js', 5) + fileDiff('pnpm-lock.yaml', 4);
    const result = compactReviewDiff(diff, { maxChars: 10_000 });
    assert.deepEqual(result.omitted.map((entry) => [entry.path, entry.reason]), [
      ['packages/scan/action/dist/index.js', 'generated'],
      ['pnpm-lock.yaml', 'generated'],
    ]);
    assert.match(result.diff, /^# Review diff note: 2 changed file\(s\) were omitted/);
    assert.match(result.diff, /packages\/scan\/action\/dist\/index\.js \(generated output; \+5\/-0 lines\)/);
    assert.ok(result.diff.includes('+++ b/src/a.ts'));
    assert.ok(!result.diff.includes('+++ b/pnpm-lock.yaml'));
  });

  it('treats caller-supplied generated paths (linguist-generated) as generated', () => {
    const diff = fileDiff('src/a.ts', 2) + fileDiff('schemas/report.schema.json', 3);
    const result = compactReviewDiff(diff, {
      maxChars: 10_000,
      generatedPaths: new Set(['schemas/report.schema.json']),
    });
    assert.deepEqual(result.omitted.map((entry) => entry.path), ['schemas/report.schema.json']);
  });

  it('drops the largest files first until the kept diff fits the budget', () => {
    const small = fileDiff('src/small.ts', 10);
    const medium = fileDiff('fixtures/medium.json', 200);
    const large = fileDiff('fixtures/large.json', 2_000);
    const diff = small + large + medium;
    const result = compactReviewDiff(diff, { maxChars: small.length + medium.length });
    assert.deepEqual(result.omitted.map((entry) => [entry.path, entry.reason]), [['fixtures/large.json', 'size-budget']]);
    assert.ok(result.keptChars <= small.length + medium.length);
    assert.ok(result.diff.includes('+++ b/src/small.ts'));
    assert.ok(result.diff.includes('+++ b/fixtures/medium.json'));
    assert.match(result.diff, /fixtures\/large\.json \(too large, \d+ chars; \+2000\/-0 lines\)/);
  });

  it('keeps kept files in their original order', () => {
    const diff = fileDiff('src/z.ts', 1) + fileDiff('fixtures/big.json', 500) + fileDiff('src/a.ts', 1);
    const result = compactReviewDiff(diff, { maxChars: 1_000 });
    assert.ok(result.diff.indexOf('+++ b/src/z.ts') < result.diff.indexOf('+++ b/src/a.ts'));
  });

  it('names deleted files by their old path', () => {
    const diff = fileDiff('src/a.ts', 1) + deletedFileDiff('dist/old.js');
    const result = compactReviewDiff(diff, { maxChars: 10_000 });
    assert.deepEqual(result.omitted.map((entry) => [entry.path, entry.deletions]), [['dist/old.js', 2]]);
  });

  it('caps the listed omissions and summarises the rest', () => {
    const diff = Array.from({ length: 205 }, (_, i) => fileDiff(`dist/chunk-${i}.js`, 1)).join('');
    const result = compactReviewDiff(diff, { maxChars: 10_000 });
    assert.equal(result.omitted.length, 205);
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

describe('readLinguistGeneratedPaths', () => {
  it('returns paths marked linguist-generated in .gitattributes', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-diff-budget-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      writeFileSync(join(repoDir, '.gitattributes'), 'schemas/*.json linguist-generated\n');
      const generated = readLinguistGeneratedPaths(repoDir, ['schemas/a.json', 'src/a.ts']);
      assert.deepEqual([...generated], ['schemas/a.json']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns an empty set outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-diff-budget-nogit-'));
    try {
      assert.equal(readLinguistGeneratedPaths(join(dir, 'missing'), ['a.ts']).size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
