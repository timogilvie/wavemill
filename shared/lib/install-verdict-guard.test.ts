import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { INSTALL_VERDICT_GUARD } from './install-verdict-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(INSTALL_VERDICT_GUARD, file, source).map((finding) => finding.pattern);

describe('install-verdict guard — forbidden shapes', () => {
  it('flags a byte/hash comparison of the project lockfile (HOK-3315)', () => {
    assert.deepEqual(patternsOf('tools/scratch.sh', 'cat package-lock.json | md5sum\n'), ['private-lockfile-hash']);
    assert.deepEqual(patternsOf('tools/scratch.sh', 'sha256sum "$dir/package-lock.json"\n'), ['private-lockfile-hash']);
  });

  it('flags a byte/hash comparison of the hidden lockfile', () => {
    assert.deepEqual(
      patternsOf('tools/scratch.sh', 'shasum -a 256 "$dir/node_modules/.package-lock.json"\n'),
      ['private-lockfile-hash'],
    );
  });

  it('flags a hand-rolled jq .packages slurp diff', () => {
    assert.deepEqual(
      patternsOf('shared/lib/scratch.sh', "jq -cs '.packages' \"$lock\" \"$hidden\"\n"),
      ['private-lockfile-diff'],
    );
  });

  it('flags a hand-rolled JSON.parse lockfile diff', () => {
    assert.deepEqual(
      patternsOf('shared/lib/scratch.ts', "const lock = JSON.parse(readFileSync('package-lock.json'));\n"),
      ['private-lockfile-diff'],
    );
  });

  it('flags a direct import of deps-drift.ts outside the allowed consumers', () => {
    assert.deepEqual(
      patternsOf('shared/lib/scratch.ts', "import { checkDepsDrift } from './deps-drift.ts';\n"),
      ['deps-drift-direct-import'],
    );
    assert.deepEqual(
      patternsOf('tools/scratch.ts', "import { checkDepsDrift } from '../shared/lib/deps-drift.ts';\n"),
      ['deps-drift-direct-import'],
    );
  });
});

describe('install-verdict guard — clean shapes', () => {
  it('allows the known deps-drift.ts consumers', () => {
    assert.deepEqual(
      patternsOf('shared/lib/wavemill-incident-detector.ts', "import { checkDepsDrift } from './deps-drift.ts';\n"),
      [],
    );
    assert.deepEqual(
      patternsOf('shared/lib/deps-drift-cli.ts', "import { checkDepsDrift } from './deps-drift.ts';\n"),
      [],
    );
  });

  it('ignores a jq filter on the verdict output, not a lockfile diff', () => {
    assert.deepEqual(
      patternsOf('shared/lib/scratch.sh', "jq -r '[.packages[]?.name] | join(\",\")' <<<\"$json\"\n"),
      [],
    );
  });

  it('ignores an unrelated hash of an unrelated file', () => {
    assert.deepEqual(patternsOf('tools/scratch.sh', 'sha256sum "$dir/some-other-file.json"\n'), []);
  });

  it('ignores whole-line comments naming the shape', () => {
    assert.deepEqual(patternsOf('tools/scratch.sh', '# cat package-lock.json | md5sum would be the old defect\n'), []);
  });

  it('honours the allow-install-verdict suppression on the line and above', () => {
    assert.deepEqual(
      patternsOf('tools/scratch.sh', 'cat package-lock.json | md5sum # allow-install-verdict: bounded-retry cache key, not a verdict\n'),
      [],
    );
  });
});

describe('install-verdict guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(INSTALL_VERDICT_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(INSTALL_VERDICT_GUARD, result));
  });
});
