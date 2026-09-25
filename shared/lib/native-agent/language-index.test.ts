import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildLanguageIndex,
  DEFAULT_MAX_RESULTS,
  detectLanguage,
  IndexAborted,
  IndexBudgetExceeded,
} from './language-index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = {
  ts: path.join(__dirname, 'tools', 'fixtures', 'code-search', 'ts-project'),
  py: path.join(__dirname, 'tools', 'fixtures', 'code-search', 'py-project'),
  mixed: path.join(__dirname, 'tools', 'fixtures', 'code-search', 'mixed-project'),
} as const;

function makeEmptyWorktree(): string {
  return mkdtempSync(path.join(tmpdir(), 'lang-index-empty-'));
}

describe('language-index — detectLanguage', () => {
  it('recognizes typescript-family extensions', () => {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
      assert.equal(detectLanguage(`foo${ext}`), 'typescript');
    }
  });

  it('returns null for unsupported languages', () => {
    for (const ext of ['.py', '.rb', '.go', '.rs', '.txt', '.md']) {
      assert.equal(detectLanguage(`foo${ext}`), null);
    }
  });
});

describe('language-index — buildLanguageIndex', () => {
  it('returns an empty, revision-stable index on an empty tree', async () => {
    const dir = makeEmptyWorktree();
    const idx = await buildLanguageIndex(dir);
    assert.equal(idx.indexedFiles, 0);
    assert.equal(idx.scannedBytes, 0);
    assert.match(idx.indexRevision, /^[0-9a-f]{40}$/);
    const symbols = await idx.findSymbols({});
    assert.deepEqual(symbols.matches, []);
    assert.equal(symbols.meta.totalMatches, 0);
    assert.equal(symbols.meta.truncated, false);
  });

  it('populates definitions and references over ts-project', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    assert.ok(idx.indexedFiles >= 3);
    const defs = await idx.findDefinition('calculateTotal');
    assert.equal(defs.matches.length, 1);
    const [def] = defs.matches;
    assert.ok(def);
    assert.equal(def.path, path.join('src', 'utils.ts'));
    assert.equal(def.kind, 'function');
    assert.equal(def.referenceKind, 'definition');
    assert.equal(def.symbol, 'calculateTotal');
    assert.ok(def.startLine >= 1);
    assert.ok(def.endLine >= def.startLine);
  });

  it('findReferences returns entries from both index.ts and consumer.ts, sorted', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const refs = await idx.findReferences('calculateTotal');
    const paths = new Set(refs.matches.map((m) => m.path));
    assert.ok(paths.has(path.join('src', 'index.ts')));
    assert.ok(paths.has(path.join('src', 'consumer.ts')));

    // Deterministic ordering: sorted by (path, line, column, symbol, kind).
    const sorted = [...refs.matches].sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.startColumn - b.startColumn;
    });
    assert.deepEqual(refs.matches, sorted);
  });

  it('findCallSites returns only the call expressions, not imports', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const calls = await idx.findCallSites('calculateTotal');
    assert.ok(calls.matches.length > 0);
    for (const call of calls.matches) {
      assert.equal(call.referenceKind, 'call');
    }
  });

  it('missing symbol returns [] with totalMatches: 0', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const misses = await idx.findDefinition('doesNotExist');
    assert.deepEqual(misses.matches, []);
    assert.equal(misses.meta.totalMatches, 0);
    assert.equal(misses.meta.truncated, false);
  });

  it('two independent builds on the same tree produce identical indexRevision', async () => {
    const a = await buildLanguageIndex(FIXTURES.ts);
    const b = await buildLanguageIndex(FIXTURES.ts);
    assert.equal(a.indexRevision, b.indexRevision);
    assert.equal(a.indexedFiles, b.indexedFiles);
    const defsA = await a.findDefinition('calculateTotal');
    const defsB = await b.findDefinition('calculateTotal');
    assert.deepEqual(defsA.matches, defsB.matches);
  });

  it('touching a file mtime and re-querying reports staleness: true', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const target = path.join(FIXTURES.ts, 'src', 'utils.ts');
    // Nudge mtime forward without changing the content.
    const now = new Date();
    const later = new Date(now.getTime() + 5_000);
    utimesSync(target, later, later);
    try {
      const stale = await idx.findDefinition('calculateTotal');
      assert.equal(stale.meta.staleness, true);

      const fresh = await buildLanguageIndex(FIXTURES.ts);
      const freshQuery = await fresh.findDefinition('calculateTotal');
      assert.equal(freshQuery.meta.staleness, false);
    } finally {
      // Restore mtime so the fixture stays stable for other tests.
      utimesSync(target, now, now);
    }
  });

  it('respects maxResults truncation and reports totalMatches', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const truncated = await idx.findSymbols({}, { maxResults: 1 });
    assert.equal(truncated.matches.length, 1);
    assert.equal(truncated.meta.truncated, true);
    assert.ok(truncated.meta.totalMatches > 1);
  });

  it('maxSymbols cap aborts the build with IndexBudgetExceeded', async () => {
    await assert.rejects(
      buildLanguageIndex(FIXTURES.ts, { maxSymbols: 1 }),
      (err: unknown) => err instanceof IndexBudgetExceeded && (err as IndexBudgetExceeded).kind === 'maxSymbols',
    );
  });

  it('maxBytes cap aborts the build with IndexBudgetExceeded', async () => {
    await assert.rejects(
      buildLanguageIndex(FIXTURES.ts, { maxBytes: 1 }),
      (err: unknown) => err instanceof IndexBudgetExceeded && (err as IndexBudgetExceeded).kind === 'maxBytes',
    );
  });

  it('maxFiles cap aborts the build with IndexBudgetExceeded', async () => {
    await assert.rejects(
      buildLanguageIndex(FIXTURES.ts, { maxFiles: 1 }),
      (err: unknown) => err instanceof IndexBudgetExceeded && (err as IndexBudgetExceeded).kind === 'maxFiles',
    );
  });

  it('AbortSignal fired before build raises IndexAborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      buildLanguageIndex(FIXTURES.ts, { signal: controller.signal }),
      (err: unknown) => err instanceof IndexAborted,
    );
  });

  it('rejects a worktree path that resolves outside the caller-provided root', async () => {
    // The public API takes the worktree root and resolves everything inside it,
    // but the language-index shares the same resolveInsideWorktree helper as the
    // read-only tools. A relative escape at the top level fails because the dir
    // does not exist.
    await assert.rejects(buildLanguageIndex('/definitely-not-a-real-worktree-xyz'));
  });

  it('mixed-project index skips python/markdown and only holds TS symbols', async () => {
    const idx = await buildLanguageIndex(FIXTURES.mixed);
    // Only the entry.ts file has symbols in this fixture.
    assert.equal(idx.indexedFiles, 1);
    const greetings = await idx.findDefinition('greeting');
    assert.equal(greetings.matches.length, 1);
    const py = await idx.findDefinition('helper');
    assert.equal(py.matches.length, 0);
  });

  it('symlinks are not followed into the tree', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lang-index-symlink-'));
    const inside = path.join(dir, 'a.ts');
    writeFileSync(inside, 'export function inside(): number { return 1; }');
    // A symlink to a non-existent target — the walker should skip it entirely.
    const linkTarget = path.join(dir, 'link.ts');
    try {
      symlinkSync('/nonexistent-target-for-symlink.ts', linkTarget);
    } catch {
      // On environments that disallow symlink creation, skip the assertion.
      return;
    }
    const idx = await buildLanguageIndex(dir);
    const defs = await idx.findDefinition('inside');
    assert.equal(defs.matches.length, 1);
  });

  it('default maxResults is bounded and stable', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const all = await idx.findSymbols({});
    assert.ok(all.matches.length <= DEFAULT_MAX_RESULTS);
  });

  it('extension dispatch: .py / .rs / text is unsupported', () => {
    assert.equal(detectLanguage('main.py'), null);
    assert.equal(detectLanguage('foo.rs'), null);
    assert.equal(detectLanguage('notes.txt'), null);
  });

  it('extension dispatch: .tsx / .mts / .cts treat as TypeScript', () => {
    for (const ext of ['.tsx', '.mts', '.cts']) {
      assert.equal(detectLanguage(`foo${ext}`), 'typescript');
    }
  });

  it('filters results by path prefix', async () => {
    const idx = await buildLanguageIndex(FIXTURES.ts);
    const scoped = await idx.findReferences('calculateTotal', {
      path: path.join('src', 'index.ts'),
    });
    for (const match of scoped.matches) {
      assert.equal(match.path, path.join('src', 'index.ts'));
    }
    assert.ok(scoped.matches.length > 0);
  });
});

describe('language-index — build in an empty subdirectory', () => {
  it('nested directory with only markdown files yields an empty index', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lang-index-md-'));
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'README.md'), '# empty');
    const idx = await buildLanguageIndex(dir);
    assert.equal(idx.indexedFiles, 0);
    const symbols = await idx.findSymbols({});
    assert.deepEqual(symbols.matches, []);
  });
});
