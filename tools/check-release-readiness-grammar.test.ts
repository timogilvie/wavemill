import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runSourceGuard } from './lib/source-guard.ts';
import { RELEASE_READINESS_GUARD } from '../shared/lib/release-readiness-guard.ts';

function write(repo: string, relPath: string, contents: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function track(repo: string): void {
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
}

function patterns(repo: string): string[] {
  return runSourceGuard(RELEASE_READINESS_GUARD, repo).findings.map((f) => f.pattern).sort();
}

describe('RELEASE_READINESS_GUARD', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'release-readiness-grammar-'));
    execFileSync('git', ['init', '-q', repo]);
    write(repo, 'tools/release-readiness-allowlist.txt', '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // protects: the HOK-3406 incident — a second field grammar that disagreed
  // with the consumer's.
  it('reports an escaped-bold field regex outside the shared parser', () => {
    write(repo, 'shared/lib/widget.ts', [
      'const field = /\\*\\*database_change_risk\\*\\*:\\s*(\\S+)/;',
      'const other = /\\*\\*env_changes\\*\\*/;',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), [
      'private-release-readiness-field-regex',
      'private-release-readiness-field-regex',
    ]);
  });

  // protects: the canonical grammar may legitimately name the fields.
  it('ignores the canonical parser and test files', () => {
    write(repo, 'shared/lib/task-packet-utils.ts', 'const field = /\\*\\*manual_steps\\*\\*/;\n');
    write(repo, 'shared/lib/widget.test.ts', 'const field = /\\*\\*config_changes\\*\\*/;\n');
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: prose naming a field is not a grammar.
  it('ignores whole-line comments', () => {
    write(repo, 'shared/lib/widget.ts', '// never write /\\*\\*config_changes\\*\\*/ here\n');
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });
});
