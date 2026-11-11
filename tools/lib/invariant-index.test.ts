/**
 * Protects: the split-CLAUDE.md index (HOK-3467) stays short and complete.
 *
 * `CLAUDE.md` carries one index line per mechanically-enforced invariant and
 * links the full text under `docs/invariants/`. A new invariant adds one file
 * and one index line; this test fails if either half is missing, if an index
 * line loses its guard reference, or if the index grows past the 25 KB budget
 * that makes it cheap to load on every session.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const claudeMdPath = join(repoRoot, 'CLAUDE.md');
const claudeMd = readFileSync(claudeMdPath, 'utf-8');
const invariantDir = join(repoRoot, 'docs', 'invariants');
const invariantFiles = readdirSync(invariantDir)
  .filter((name) => name.endsWith('.md'))
  .sort();

const INDEX_LINK = /\]\((docs\/invariants\/[^)\s]+\.md)\)/g;
const indexLinks = [...claudeMd.matchAll(INDEX_LINK)].map((match) => match[1]);

describe('CLAUDE.md invariant index', () => {
  it('stays under the 25 KB budget', () => {
    const bytes = Buffer.byteLength(claudeMd, 'utf-8');
    assert.ok(bytes < 25_000, `CLAUDE.md is ${bytes} bytes; keep the index under 25,000`);
  });

  it('indexes every invariant file exactly once', () => {
    for (const name of invariantFiles) {
      const path = `docs/invariants/${name}`;
      const count = indexLinks.filter((link) => link === path).length;
      assert.equal(count, 1, `${path} has ${count} index line(s) in CLAUDE.md; expected exactly one`);
    }
  });

  it('links no invariant file that does not exist', () => {
    const missing = indexLinks.filter((link) => !existsSync(join(repoRoot, link)));
    assert.deepEqual(missing, []);
  });

  it('gives every index line a rule sentence, a guard, and its file link', () => {
    const lines = claudeMd
      .split(/\r?\n/)
      .filter((line) => line.includes('(docs/invariants/'));
    assert.equal(lines.length, indexLinks.length, 'every invariant link sits on its own index line');
    for (const line of lines) {
      assert.match(line, /^- \*\*.+?\*\* — .+\./, `index line lacks a rule sentence: ${line}`);
      assert.match(line, /Guard: .+/, `index line lacks a guard: ${line}`);
      assert.match(line, /\]\(docs\/invariants\/[^)\s]+\.md\)\s*$/, `index line must end with its file link: ${line}`);
    }
  });

  it('resolves every relative markdown link it carries', () => {
    const links = [...claudeMd.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !target.startsWith('http') && !target.startsWith('#'));
    const dangling = links.filter((target) => !existsSync(join(repoRoot, target.split('#')[0])));
    assert.deepEqual(dangling, []);
  });
});
