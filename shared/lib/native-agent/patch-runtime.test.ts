import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { NATIVE_PATCH_VERSION, type NativePatch } from './patch-contract.ts';
import { applyNativePatch } from './patch-runtime.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(worktree: string, relativePath: string, content: string): void {
  mkdirSync(path.dirname(path.join(worktree, relativePath)), { recursive: true });
  writeFileSync(path.join(worktree, relativePath), content);
}

function readFixture(worktree: string, relativePath: string): string {
  return readFileSync(path.join(worktree, relativePath), 'utf8');
}

function makePatch(operations: NativePatch['operations']): NativePatch {
  return {
    version: NATIVE_PATCH_VERSION,
    atomic: true,
    operations,
  };
}

describe('patch-runtime', () => {
  // protects: HOK-3255's 24k-line patch must finish under a small heap, with Git's counts.
  it('patches a large file under a 64 MiB heap and reports Git numstat', () => {
    const runtimeUrl = new URL('./patch-runtime.ts', import.meta.url).href;
    const script = `
      import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { applyNativePatch } from ${JSON.stringify(runtimeUrl)};
      const dir = mkdtempSync(join(tmpdir(), 'large-patch-replay-'));
      try {
        const text = Array.from({ length: 24238 }, (_, i) => 'line ' + i).join('\\n') + '\\n';
        writeFileSync(join(dir, 'large.sh'), text);
        const result = await applyNativePatch(dir, {
          version: 1, atomic: true,
          operations: [{ op: 'edit', path: 'large.sh', oldText: 'line 12000', newText: 'changed\\ninserted' }],
        });
        if (!result.ok) throw new Error(JSON.stringify(result));
        if (readFileSync(join(dir, 'large.sh'), 'utf8') !== text.replace('line 12000', 'changed\\ninserted')) {
          throw new Error('incorrect post image');
        }
        console.log(JSON.stringify(result.fileChanges));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    `;
    const output = execFileSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15000,
    });
    assert.deepEqual(JSON.parse(output), [{ path: 'large.sh', linesAdded: 2, linesRemoved: 1 }]);
  });

  it('applies a single edit and reports file and line deltas', async () => {
    const worktree = makeTempDir('patch-runtime-single-');
    writeFixture(worktree, 'src/file.ts', 'const value = 1;\n');

    const result = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/file.ts',
        oldText: 'const value = 1;',
        newText: 'const value = 2;\nconst extra = 3;',
      },
    ]));

    assert.deepEqual(result, {
      ok: true,
      atomic: true,
      appliedOperations: 1,
      changedFiles: ['src/file.ts'],
      fileChanges: [{ path: 'src/file.ts', linesAdded: 2, linesRemoved: 1 }],
      linesAdded: 2,
      linesRemoved: 1,
      snapshots: [{
        path: 'src/file.ts',
        originalDiskText: 'const value = 1;\n',
        postImage: 'const value = 2;\nconst extra = 3;\n',
      }],
    });
    assert.equal(readFixture(worktree, 'src/file.ts'), 'const value = 2;\nconst extra = 3;\n');
  });

  it('applies a multi-file patch transactionally on success', async () => {
    const worktree = makeTempDir('patch-runtime-multi-');
    writeFixture(worktree, 'src/a.ts', 'alpha\nbeta\ngamma\n');
    writeFixture(worktree, 'src/b.ts', 'one\ntwo\n');

    const result = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/a.ts',
        oldText: 'beta',
        newText: 'beta-2',
      },
      {
        op: 'edit',
        path: 'src/b.ts',
        oldText: 'two',
        newText: 'two\nthree',
      },
    ]));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.changedFiles, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(result.fileChanges, [
      { path: 'src/a.ts', linesAdded: 1, linesRemoved: 1 },
      { path: 'src/b.ts', linesAdded: 1, linesRemoved: 0 },
    ]);
    assert.equal(result.linesAdded, 2);
    assert.equal(result.linesRemoved, 1);
    assert.equal(readFixture(worktree, 'src/a.ts'), 'alpha\nbeta-2\ngamma\n');
    assert.equal(readFixture(worktree, 'src/b.ts'), 'one\ntwo\nthree\n');
  });

  it('composes sequential edits against the same staged file', async () => {
    const worktree = makeTempDir('patch-runtime-sequential-');
    writeFixture(worktree, 'src/file.ts', 'first\nsecond\n');

    const result = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/file.ts',
        oldText: 'second',
        newText: 'middle',
      },
      {
        op: 'edit',
        path: 'src/file.ts',
        oldText: 'middle',
        newText: 'last',
      },
    ]));

    assert.equal(result.ok, true);
    assert.equal(readFixture(worktree, 'src/file.ts'), 'first\nlast\n');
  });

  it('leaves the worktree unchanged when a later operation fails', async () => {
    const worktree = makeTempDir('patch-runtime-rollback-');
    writeFixture(worktree, 'src/a.ts', 'before\n');
    writeFixture(worktree, 'src/b.ts', 'still here\n');
    const originalA = readFixture(worktree, 'src/a.ts');
    const originalB = readFixture(worktree, 'src/b.ts');

    const result = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/a.ts',
        oldText: 'before',
        newText: 'after',
      },
      {
        op: 'edit',
        path: 'src/b.ts',
        oldText: 'missing',
        newText: 'replacement',
      },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection.operationIndex, 1);
    assert.equal(result.rejection.code, 'old_text_not_found');
    assert.equal(readFixture(worktree, 'src/a.ts'), originalA);
    assert.equal(readFixture(worktree, 'src/b.ts'), originalB);
  });

  it('rejects missing or denied paths without writing anything', async () => {
    const worktree = makeTempDir('patch-runtime-path-');
    writeFixture(worktree, 'src/file.ts', 'safe\n');
    const original = readFixture(worktree, 'src/file.ts');

    const result = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: '../outside.ts',
        oldText: 'safe',
        newText: 'unsafe',
      },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection.code, 'path_denied');
    assert.equal(readFixture(worktree, 'src/file.ts'), original);
  });

  it('rejects ambiguous matches and anchor mismatches', async () => {
    const worktree = makeTempDir('patch-runtime-anchors-');
    writeFixture(worktree, 'src/file.ts', 'start\nrepeat\nmid\nrepeat\nend\n');

    const ambiguous = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/file.ts',
        oldText: 'repeat',
        newText: 'updated',
      },
    ]));

    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) {
      assert.equal(ambiguous.rejection.code, 'ambiguous_anchor');
    }

    const anchorMismatch = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/file.ts',
        oldText: 'repeat',
        newText: 'updated',
        anchorBefore: 'missing\n',
      },
    ]));

    assert.equal(anchorMismatch.ok, false);
    if (!anchorMismatch.ok) {
      assert.equal(anchorMismatch.rejection.code, 'anchor_mismatch');
    }

    writeFixture(worktree, 'src/single.ts', 'only once\n');
    const singleMismatch = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/single.ts',
        oldText: 'only',
        newText: 'just',
        anchorAfter: '\nmissing',
      },
    ]));

    assert.equal(singleMismatch.ok, false);
    if (!singleMismatch.ok) {
      assert.equal(singleMismatch.rejection.code, 'anchor_mismatch');
    }
  });

  it('applies unified diffs and rejects context mismatches without writes', async () => {
    const worktree = makeTempDir('patch-runtime-diff-');
    writeFixture(worktree, 'src/file.ts', 'alpha\nbeta\ngamma\n');

    const applied = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit-diff',
        path: 'src/file.ts',
        diff: '@@ -1,3 +1,4 @@\n alpha\n-beta\n+beta-2\n gamma\n+delta',
      },
    ]));

    assert.equal(applied.ok, true);
    assert.equal(readFixture(worktree, 'src/file.ts'), 'alpha\nbeta-2\ngamma\ndelta\n');

    writeFixture(worktree, 'src/file.ts', 'alpha\nbeta\ngamma\n');
    const original = readFixture(worktree, 'src/file.ts');

    const rejected = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit-diff',
        path: 'src/file.ts',
        diff: '@@ -1,2 +1,2 @@\n alpha\n-wrong\n+beta-2',
      },
    ]));

    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.rejection.code, 'old_text_not_found');
    }
    assert.equal(readFixture(worktree, 'src/file.ts'), original);
  });

  it('reports exact add-only, remove-only, and mixed line counts', async () => {
    const worktree = makeTempDir('patch-runtime-counts-');
    writeFixture(worktree, 'src/add.ts', 'a\n');
    writeFixture(worktree, 'src/remove.ts', 'a\nb\n');
    writeFixture(worktree, 'src/mixed.ts', 'x\ny\n');

    const result = await applyNativePatch(worktree, makePatch([
      {
        op: 'edit',
        path: 'src/add.ts',
        oldText: 'a',
        newText: 'a\nb\nc',
      },
      {
        op: 'edit',
        path: 'src/remove.ts',
        oldText: 'a\nb',
        newText: 'a',
      },
      {
        op: 'edit',
        path: 'src/mixed.ts',
        oldText: 'x\ny',
        newText: 'z\nq',
      },
    ]));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.fileChanges, [
      { path: 'src/add.ts', linesAdded: 2, linesRemoved: 0 },
      { path: 'src/mixed.ts', linesAdded: 2, linesRemoved: 2 },
      { path: 'src/remove.ts', linesAdded: 0, linesRemoved: 1 },
    ]);
    assert.equal(result.linesAdded, 4);
    assert.equal(result.linesRemoved, 3);
  });
});
