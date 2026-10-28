import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runSourceGuard, type GuardFinding } from './lib/source-guard.ts';
import { SOURCE_TEXT_ASSERTIONS_GUARD } from '../shared/lib/source-text-assertions-guard.ts';

// protects: HOK-3237 — the guard must detect new source-text assertions in
// tests, honour its tests/check-* exemption, and respect inline suppressions.
// We build a tiny fake repo per case and call runSourceGuard against it. We
// deliberately do NOT read the guard's own source: that would be the exact
// anti-pattern this guard forbids. Instead we drive the public API with
// representative offender fixtures and inspect the returned findings.

function write(repo: string, relPath: string, contents: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function track(repo: string): void {
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
}

function patterns(findings: readonly GuardFinding[]): string[] {
  return findings.map((f) => `${f.file}:${f.pattern}`).sort();
}

describe('SOURCE_TEXT_ASSERTIONS_GUARD', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'source-text-assertions-'));
    execFileSync('git', ['init', '-q', repo]);
    write(repo, 'tools/source-text-assertions-allowlist.txt', '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // protects: the shell-mill-monitor-script-read pattern catches a cat of the
  // generated mill/monitor script — the exact anti-pattern HOK-3237 bans.
  it('reports a shell test that cats $MILL_SCRIPT', () => {
    write(repo, 'tests/widget.test.sh', [
      '#!/usr/bin/env bash',
      'MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"',
      'body="$(cat "$MILL_SCRIPT")"',
      'echo "$body"',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(
      patterns(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings),
      ['tests/widget.test.sh:shell-mill-monitor-script-read'],
    );
  });

  // protects: the shell-source-path-read pattern catches a grep of a literal
  // shared/lib/**.ts path.
  it('reports a shell test that greps a shared/lib/**.ts source file', () => {
    write(repo, 'tests/greppy.test.sh', [
      '#!/usr/bin/env bash',
      'grep -q "foo" "$REPO_DIR/shared/lib/some-module.ts"',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(
      patterns(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings),
      ['tests/greppy.test.sh:shell-source-path-read'],
    );
  });

  // protects: the ts-readfile-sibling-source pattern catches the
  // readFileSync(new URL('./x.ts', import.meta.url)) sibling-source read that
  // is the usual TS flavour of a source-text assertion.
  // allow-source-text-assertion: the it() name below intentionally spells the pattern.
  it('reports a TS test that readFileSync(..., import.meta.url) a sibling source', () => {
    write(repo, 'shared/lib/widget.test.ts', [
      "import { readFileSync } from 'node:fs';",
      // allow-source-text-assertion: fixture — the next line IS the pattern the guard must detect.
      "const src = readFileSync(new URL('./widget.ts', import.meta.url), 'utf8');",
      "if (src.includes('foo')) throw new Error('ok');",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(
      patterns(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings),
      ['shared/lib/widget.test.ts:ts-readfile-sibling-source'],
    );
  });

  // protects: the ts-hash-source pattern catches a sha256 of a .ts file —
  // using source bytes as a stamp/oracle instead of calling the function.
  // allow-source-text-assertion: the it() name below intentionally spells the pattern.
  it('reports a TS test that sha256(readFileSync(... .ts))', () => {
    write(repo, 'shared/lib/widget.test.ts', [
      "import { readFileSync } from 'node:fs';",
      "import { sha256 } from './schema-validators.ts';",
      // allow-source-text-assertion: fixture — hashing a .ts source file is the pattern the guard must detect.
      "const stamp = sha256(readFileSync('shared/lib/widget.ts'));",
      "if (stamp.length !== 64) throw new Error('bad');",
      '',
    ].join('\n'));
    track(repo);
    const found = patterns(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings);
    // The guard matches both the readfile-source-path pattern and the
    // hash-source pattern on the same source line, which is correct — each
    // forbidden shape is reported independently.
    assert.ok(found.includes('shared/lib/widget.test.ts:ts-hash-source'), `expected ts-hash-source, got ${JSON.stringify(found)}`);
  });

  // protects: tests/check-* lint guards are deliberately exempt — reading
  // source is their job (HOK-3236 framework). If the exemption breaks, every
  // tracked guard would fire on itself.
  it('skips tests/check-* lint guards even when they grep source paths', () => {
    write(repo, 'tests/check-dummy.test.sh', [
      '#!/usr/bin/env bash',
      'grep -q "foo" "$REPO_DIR/shared/lib/some-module.ts"',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings, []);
  });

  // protects: an inline `// allow-source-text-assertion: <reason>` suppresses
  // the finding on the marked line (or the line directly above). Without
  // this escape hatch, a legitimate meta-test could not opt out.
  it('honours an inline allow-source-text-assertion suppression marker', () => {
    write(repo, 'tests/suppressed.test.sh', [
      '#!/usr/bin/env bash',
      '# allow-source-text-assertion: meta-test for the guard itself',
      'cat "$MILL_SCRIPT"',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings, []);
  });

  // protects: a non-test production file whose code reads sibling source is
  // NEVER reported — the ban is strictly on test code. The HOK-3237 regression
  // was that the first draft of the guard caught model-registry-loader.ts
  // itself, which uses readFileSync(import.meta.url) legitimately for its
  // stamp key.
  it('does not report production files that readFileSync import.meta.url', () => {
    write(repo, 'shared/lib/loader.ts', [
      "import { readFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      // allow-source-text-assertion: fixture — a production file that reads its own source, to prove the guard does NOT fire here.
      "export const srcHash = readFileSync(fileURLToPath(import.meta.url));",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(runSourceGuard(SOURCE_TEXT_ASSERTIONS_GUARD, repo).findings, []);
  });
});
