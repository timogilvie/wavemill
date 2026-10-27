import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkGuardSource,
  formatGuardResult,
  isCommentLine,
  parseGuardAllowlist,
  runSourceGuard,
  truncate,
  type GuardSpec,
} from './source-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SPEC: GuardSpec = {
  name: 'demo',
  findingNoun: 'forbidden call(s)',
  suppressionMarker: 'allow-demo',
  allowlistFile: 'tools/demo-allowlist.txt',
  invariantPaths: ['shared/lib/demo.ts'],
  patterns: [
    { name: 'ts-forbidden', description: 'forbidden() in TS', lang: 'ts', re: /\bforbidden\(/ },
    { name: 'sh-forbidden', description: 'forbidden_cmd in shell', lang: 'sh', re: /\bforbidden_cmd\b/ },
    { name: 'both-token', description: 'BAD_TOKEN anywhere', lang: 'both', re: /\bBAD_TOKEN\b/, excludePaths: ['shared/lib/token-owner.ts'] },
  ],
  structuralChecks: [{
    name: 'needs-footer',
    description: 'file must end with a FOOTER line',
    paths: ['shared/lib/structured.ts'],
    find: (text) => (text.includes('FOOTER') ? [] : [{ line: 1, detail: 'missing' }]),
  }],
  remediation: ['Use the demo helper instead.'],
};

const patternsOf = (file: string, source: string, spec: GuardSpec = SPEC) =>
  checkGuardSource(spec, file, source).map((finding) => finding.pattern);

describe('checkGuardSource — matching', () => {
  it('reports file, 1-indexed line, column anchor, pattern and trimmed text', () => {
    const [finding] = checkGuardSource(SPEC, 'shared/lib/a.ts', 'const ok = 1;\n  const x = forbidden(1);\n');
    assert.deepEqual(finding, {
      file: 'shared/lib/a.ts',
      line: 2,
      column: 13,
      pattern: 'ts-forbidden',
      description: 'forbidden() in TS',
      text: 'const x = forbidden(1);',
    });
  });

  it('dispatches patterns by language', () => {
    assert.deepEqual(patternsOf('a.ts', 'forbidden(); forbidden_cmd; BAD_TOKEN'), ['ts-forbidden', 'both-token']);
    assert.deepEqual(patternsOf('a.sh', 'forbidden(); forbidden_cmd; BAD_TOKEN'), ['sh-forbidden', 'both-token']);
    assert.deepEqual(patternsOf('a.mjs', 'forbidden()'), ['ts-forbidden']);
    assert.deepEqual(patternsOf('a.md', 'forbidden(); BAD_TOKEN'), [], 'unknown extensions are never scanned');
  });

  it('honours per-spec extension overrides', () => {
    const tsOnly: GuardSpec = { ...SPEC, shellExtensions: [], tsExtensions: ['.ts'] };
    assert.deepEqual(patternsOf('a.sh', 'forbidden_cmd', tsOnly), []);
    assert.deepEqual(patternsOf('a.js', 'forbidden()', tsOnly), []);
  });

  it('skips a pattern on its excluded paths only', () => {
    assert.deepEqual(patternsOf('shared/lib/token-owner.ts', 'BAD_TOKEN; forbidden()'), ['ts-forbidden']);
  });

  it('runs structural checks only on their listed paths', () => {
    assert.deepEqual(patternsOf('shared/lib/structured.ts', 'const a = 1;\n'), ['needs-footer']);
    assert.deepEqual(patternsOf('shared/lib/structured.ts', '// FOOTER\n'), []);
    assert.deepEqual(patternsOf('shared/lib/other.ts', 'const a = 1;\n'), []);
    const [finding] = checkGuardSource(SPEC, 'shared/lib/structured.ts', '  const a = 1;\n');
    assert.equal(finding.description, 'file must end with a FOOTER line (missing)');
    assert.equal(finding.column, 3, 'structural column defaults to the first non-blank character');
  });
});

describe('checkGuardSource — comments and suppression', () => {
  it('skips whole-line comments per language but not trailing comments', () => {
    assert.deepEqual(patternsOf('a.ts', '// forbidden()\n/* forbidden() */\n * forbidden()\n'), []);
    assert.deepEqual(patternsOf('a.sh', '# forbidden_cmd\n'), []);
    assert.deepEqual(patternsOf('a.sh', '// forbidden_cmd\n'), ['sh-forbidden'], '// is not a shell comment');
    assert.deepEqual(patternsOf('a.ts', 'forbidden(); // trailing note\n'), ['ts-forbidden']);
  });

  it('suppresses on the same line or the line directly above, not two above', () => {
    assert.deepEqual(patternsOf('a.ts', 'forbidden(); // allow-demo: reason\n'), []);
    assert.deepEqual(patternsOf('a.ts', '// allow-demo: reason\nforbidden();\n'), []);
    assert.deepEqual(patternsOf('a.sh', '# allow-demo: reason\nforbidden_cmd\n'), []);
    assert.deepEqual(patternsOf('a.ts', '// allow-demo: reason\n\nforbidden();\n'), ['ts-forbidden']);
  });

  it('suppresses structural findings at their anchor line', () => {
    assert.deepEqual(patternsOf('shared/lib/structured.ts', 'const a = 1; // allow-demo: legacy\n'), []);
  });
});

describe('helpers', () => {
  it('isCommentLine treats blank lines as code', () => {
    assert.equal(isCommentLine('   ', false), false);
    assert.equal(isCommentLine('   # x', true), true);
    assert.equal(isCommentLine('   # x', false), false);
  });

  it('truncate collapses whitespace and caps the length', () => {
    assert.equal(truncate('a   b\tc'), 'a b c');
    const long = truncate('x'.repeat(200));
    assert.equal(long.length, 160);
    assert.ok(long.endsWith('...'));
  });
});

describe('parseGuardAllowlist', () => {
  it('parses whole-file and counted entries with same-line reasons', () => {
    const parsed = parseGuardAllowlist([
      '# header comment',
      '',
      'shared/lib/a.ts  # whole file',
      'shared/lib/b.sh 3  # three sites',
      'shared/lib/c.ts',
      'shared/lib/d.ts 2',
    ].join('\n'));
    assert.deepEqual(parsed.entries, [
      { path: 'shared/lib/a.ts', reason: 'whole file', line: 3 },
      { path: 'shared/lib/b.sh', reason: 'three sites', line: 4, maxFindings: 3 },
    ]);
    assert.deepEqual(parsed.missingReason.map((entry) => entry.path), ['shared/lib/c.ts', 'shared/lib/d.ts']);
  });

  it('accepts reasonless entries when reasons are not required', () => {
    const parsed = parseGuardAllowlist('# reason above\nshared/lib/a.ts\n', false);
    assert.deepEqual(parsed.entries, [{ path: 'shared/lib/a.ts', reason: '', line: 2 }]);
    assert.deepEqual(parsed.missingReason, []);
  });
});

describe('runSourceGuard', () => {
  let repo: string;

  function write(relPath: string, contents: string): void {
    const fullPath = join(repo, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }

  function track(...paths: string[]): void {
    execFileSync('git', ['add', ...paths], { cwd: repo });
  }

  function summary(spec: GuardSpec = SPEC): string[] {
    return runSourceGuard(spec, repo).findings.map((f) => `${f.file}:${f.line}:${f.pattern}`).sort();
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'source-guard-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('scans tracked files only and skips invariant, test, and excluded-prefix paths', () => {
    write('shared/lib/bad.ts', 'forbidden();\n');
    write('shared/lib/demo.ts', 'forbidden();\n');
    write('shared/lib/bad.test.ts', 'forbidden();\n');
    write('shared/lib/bad.test.sh', 'forbidden_cmd\n');
    write('tests/helper.sh', 'forbidden_cmd\n');
    write('features/x/plan.ts', 'forbidden();\n');
    write('shared/validators/gen.cjs', 'forbidden();\n');
    track('.');
    write('shared/lib/untracked.ts', 'forbidden();\n');

    const result = runSourceGuard(SPEC, repo);
    assert.deepEqual(summary(), ['shared/lib/bad.ts:1:ts-forbidden']);
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.ok, false);
  });

  it('includeTests: true scans *.test.* files; testsOnly: true scans ONLY *.test.*', () => {
    // protects: HOK-3237 — a guard whose target is test code must be able to
    // scan test files (includeTests), and conversely a tests-only guard must
    // skip every production source so it never flags its own invariant target.
    write('shared/lib/a.test.ts', 'forbidden();\n');
    write('shared/lib/b.ts', 'forbidden();\n');
    track('.');
    const defaultSummary = runSourceGuard(SPEC, repo).findings.map((f) => f.file).sort();
    assert.deepEqual(defaultSummary, ['shared/lib/b.ts']);
    const includeSummary = runSourceGuard({ ...SPEC, includeTests: true }, repo).findings.map((f) => f.file).sort();
    assert.deepEqual(includeSummary, ['shared/lib/a.test.ts', 'shared/lib/b.ts']);
    const onlySummary = runSourceGuard({ ...SPEC, testsOnly: true }, repo).findings.map((f) => f.file).sort();
    assert.deepEqual(onlySummary, ['shared/lib/a.test.ts']);
  });

  it('honours custom excluded prefixes', () => {
    write('tests/helper.sh', 'forbidden_cmd\n');
    track('.');
    assert.deepEqual(summary({ ...SPEC, excludedPrefixes: [] }), ['tests/helper.sh:1:sh-forbidden']);
  });

  it('exempts a whole-file entry and reports reasonless entries without honouring them', () => {
    write('shared/lib/listed.ts', 'forbidden();\n');
    write('shared/lib/unexplained.ts', 'forbidden();\n');
    write(SPEC.allowlistFile, 'shared/lib/listed.ts  # legacy\nshared/lib/unexplained.ts\n');
    track('.');
    assert.deepEqual(summary(), [
      'shared/lib/unexplained.ts:1:ts-forbidden',
      'tools/demo-allowlist.txt:2:allowlist-missing-reason',
    ]);
  });

  it('enforces a count ratchet: at budget passes, above fails with every site listed', () => {
    write('shared/lib/counted.sh', 'forbidden_cmd\nforbidden_cmd\n');
    write(SPEC.allowlistFile, 'shared/lib/counted.sh 2  # two legacy sites\n');
    track('.');
    assert.equal(runSourceGuard(SPEC, repo).ok, true);

    write('shared/lib/counted.sh', 'forbidden_cmd\nforbidden_cmd\nforbidden_cmd\n');
    assert.deepEqual(summary(), [
      'shared/lib/counted.sh:1:sh-forbidden',
      'shared/lib/counted.sh:2:sh-forbidden',
      'shared/lib/counted.sh:3:sh-forbidden',
      'tools/demo-allowlist.txt:1:allowlist-count-exceeded',
    ]);
  });

  it('reports over-allowing entries so the list only shrinks', () => {
    write('shared/lib/counted.sh', 'forbidden_cmd\n');
    write('shared/lib/clean.ts', 'ok();\n');
    write('shared/lib/demo.ts', 'forbidden();\n');
    write(SPEC.allowlistFile, [
      'shared/lib/counted.sh 3  # fewer sites than budget',
      'shared/lib/clean.ts  # no findings left',
      'shared/lib/gone.ts  # file removed',
      'shared/lib/demo.ts  # invariant source must not be listed',
      '',
    ].join('\n'));
    track('.');
    const result = runSourceGuard(SPEC, repo);
    assert.deepEqual(result.findings.map((f) => `${f.line}:${f.pattern}`), [
      '1:allowlist-stale',
      '2:allowlist-stale',
      '3:allowlist-stale',
      '4:allowlist-stale',
    ]);
    assert.match(result.findings[0].description, /lower its allowlist count from 3 to 1/);
    assert.match(result.findings[2].description, /does not exist/);
  });

  it('skips the ratchet and whole-file scans when ratchet is off', () => {
    write('shared/lib/clean.ts', 'ok();\n');
    write(SPEC.allowlistFile, 'shared/lib/clean.ts  # stale but tolerated\n');
    track('.');
    const result = runSourceGuard({ ...SPEC, ratchet: false }, repo);
    assert.equal(result.ok, true);
    assert.equal(result.scannedFiles, 0, 'a whole-file entry is not scanned without the ratchet');
  });

  it('treats a missing allowlist as empty', () => {
    write('shared/lib/clean.ts', 'ok();\n');
    track('.');
    assert.deepEqual(runSourceGuard(SPEC, repo), { ok: true, scannedFiles: 1, findings: [] });
  });
});

describe('formatGuardResult', () => {
  it('prints an ok line with the scanned-file count', () => {
    assert.equal(formatGuardResult(SPEC, { ok: true, scannedFiles: 7, findings: [] }), 'demo: ok (7 files scanned)');
  });

  it('lists findings with remediation, allowlist and suppression instructions', () => {
    const output = formatGuardResult(SPEC, {
      ok: false,
      scannedFiles: 2,
      findings: [{ file: 'shared/lib/a.ts', line: 4, column: 9, pattern: 'ts-forbidden', description: 'forbidden() in TS', text: 'forbidden()' }],
    });
    assert.match(output, /^demo: found 1 forbidden call\(s\):/);
    assert.match(output, /1\. shared\/lib\/a\.ts:4:9 \[ts-forbidden\] forbidden\(\) in TS\n {3}forbidden\(\)/);
    assert.match(output, /Use the demo helper instead\./);
    assert.match(output, /tools\/demo-allowlist\.txt/);
    assert.match(output, /\/\/ allow-demo: <reason>/);
  });
});

describe('runGuardCli (via a tools/check-* wrapper)', () => {
  it('exits 0 with the ok line on a clean repo and 1 with findings on stderr otherwise', () => {
    const repo = mkdtempSync(join(tmpdir(), 'source-guard-cli-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'shared', 'lib'), { recursive: true });
      writeFileSync(join(repo, 'shared/lib/clean.ts'), 'export const a = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      const tool = join(repoRoot, 'tools', 'check-failure-policy.ts');

      const clean = spawnSync('npx', ['tsx', tool, repo], { encoding: 'utf-8' });
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, /^failure-policy: ok \(1 files scanned\)/);

      writeFileSync(join(repo, 'shared/lib/parks.ts'), 'export const c = { retryable: false };\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      const failing = spawnSync('npx', ['tsx', tool, repo], { encoding: 'utf-8' });
      assert.equal(failing.status, 1);
      assert.match(failing.stderr, /shared\/lib\/parks\.ts:1:\d+ \[non-retryable-classification\]/);
      assert.match(failing.stderr, /allow-failure-policy: <reason>/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
