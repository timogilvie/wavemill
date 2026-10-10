import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkSourceText,
  checkTaskIdentity,
  formatTaskIdentity,
} from './task-identity-checker.ts';

// Build `${…}` fragments by concatenation so the template-curly guard does not
// flag this test's own fixtures (plain strings must never contain `${…}`).
const dollarOpen = '$' + '{';
const challengerTemplate = '`' + dollarOpen + 'id}_c`'; // `${id}_c`
const shellBuild = '"' + dollarOpen + 'pairId}_c"'; // "${pairId}_c"
const shellParam = dollarOpen + 'num%_c}'; // ${num%_c}

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'task-identity-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  return repoDir;
}

function writeTracked(repoDir: string, relPath: string, contents: string): void {
  const fullPath = join(repoDir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
  execFileSync('git', ['add', relPath], { cwd: repoDir });
}

describe('checkSourceText — each pattern class fires', () => {
  it('flags TS .endsWith("_c")', () => {
    const findings = checkSourceText('fixture.ts', "const c = id.endsWith('_c');\n");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'ts-endswith-c');
    assert.equal(findings[0].line, 1);
  });

  it('flags the /_c$/ regex literal', () => {
    const findings = checkSourceText('fixture.ts', "const base = id.replace(/_c$/, '');\n");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'c-anchor-regex');
  });

  // allow-template-curly: literal description of the forbidden shape, not interpolation.
  it('flags a hand-built ${expr}_c template literal', () => {
    const findings = checkSourceText('fixture.ts', `const k = ${challengerTemplate};\n`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'ts-template-c');
  });

  it('flags an inline issue-ID regex literal', () => {
    const findings = checkSourceText('fixture.ts', 'const re = /^[A-Z]+-\\d+$/;\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'issue-id-regex');
  });

  it('flags a string-source issue-ID regex (double backslash)', () => {
    const findings = checkSourceText('fixture.ts', "const re = new RegExp('[A-Z]{2,}-\\\\d+');\n");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'issue-id-regex');
  });

  // allow-template-curly: literal description of the forbidden shape, not interpolation.
  it('flags shell ${var%_c} parameter expansion', () => {
    const findings = checkSourceText('fixture.sh', `num="${shellParam}"\n`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'sh-param-expand-c');
  });

  it('flags shell *_c ]] glob tests', () => {
    const findings = checkSourceText('fixture.sh', '[[ "$slug" == *_c ]] && echo challenger\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'sh-glob-c');
  });

  // allow-template-curly: literal description of the forbidden shape, not interpolation.
  it('flags a hand-built shell ${var}_c challenger ID', () => {
    const findings = checkSourceText('fixture.sh', `key=${shellBuild}\n`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'sh-build-c');
  });

  it('flags awk sub("_c$"…)', () => {
    const findings = checkSourceText('fixture.sh', 'echo "$x" | awk \'{ sub("_c$", "", $1); print }\'\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'sh-awk-sub-c');
  });

  it('flags jq endswith("_c")', () => {
    const findings = checkSourceText('fixture.sh', 'jq -r \'select(.id | endswith("_c"))\'\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, 'sh-jq-endswith-c');
  });
});

describe('checkSourceText — clean source stays clean', () => {
  it('ignores variable names ending in _c', () => {
    const source = 'const comp_c = 1;\nconst num_c = 2;\nfunction foo_c() {}\n';
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores prose issue IDs in strings and comments', () => {
    const source = [
      "const msg = 'HOK-123_c was refused';",
      '// challenger HOK-123_c failed three times',
      '',
    ].join('\n');
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores code that uses the task-identity primitives', () => {
    const source = [
      'const c = isChallengerTaskId(id);',
      'const key = challengerTaskKey(pairId);',
      'const built = challengerTaskId(taskId);',
      '',
    ].join('\n');
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  // allow-template-curly: literal description of the forbidden shape, not interpolation.
  it('ignores a template literal whose _c is not right after ${…}', () => {
    const source = 'const s = `' + dollarOpen + "id} suffix_c`;\n"; // `${id} suffix_c`
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  // allow-template-curly: literal description of the forbidden shape, not interpolation.
  it('ignores shell comments naming a ${var}_c task', () => {
    const source = '# the ' + shellParam.replace('%', '') + ' task may not exist\n';
    assert.deepEqual(checkSourceText('fixture.sh', source), []);
  });

  it('ignores unrelated shell suffixes like _cfg / _count', () => {
    // allow-template-curly: shell fixture text, not JavaScript interpolation.
    const source = 'val="${config}_cfg"\ntotal="${items}_count"\n';
    assert.deepEqual(checkSourceText('fixture.sh', source), []);
  });

  it('ignores unrelated regexes without an issue-ID shape', () => {
    const source = 'const re = /[a-z]+_\\d+/;\nconst r2 = /[A-Za-z]+\\s+/;\n';
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });
});

describe('allow-task-identity suppression', () => {
  it('suppresses with a same-line marker', () => {
    const source = "const c = id.endsWith('_c'); // allow-task-identity: slug heuristic\n";
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('suppresses with a marker on the immediately preceding line', () => {
    const source = [
      '// allow-task-identity: slug heuristic',
      "const c = id.endsWith('_c');",
      '',
    ].join('\n');
    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('suppresses a shell finding with a # marker', () => {
    const source = [
      '# allow-task-identity: display-only',
      `num="${shellParam}"`,
      '',
    ].join('\n');
    assert.deepEqual(checkSourceText('fixture.sh', source), []);
  });

  it('does not suppress with a marker two lines above', () => {
    const source = [
      '// allow-task-identity: slug heuristic',
      '',
      "const c = id.endsWith('_c');",
      '',
    ].join('\n');
    assert.equal(checkSourceText('fixture.ts', source).length, 1);
  });
});

describe('checkTaskIdentity — automatic exclusions', () => {
  it('does not scan the invariant source, test files, or fixtures', () => {
    const repoDir = makeRepo();
    try {
      const violation = "const c = id.endsWith('_c');\n";
      writeTracked(repoDir, 'shared/lib/task-identity.ts', violation);
      writeTracked(repoDir, 'shared/lib/foo.test.ts', violation);
      writeTracked(repoDir, 'tests/fixtures/sample.ts', violation);

      const result = checkTaskIdentity(repoDir);

      assert.equal(result.ok, true);
      assert.equal(result.findings.length, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('checkTaskIdentity — seeded violation + allowlist (acceptance)', () => {
  it('fails on a seeded violation and passes once it is allowlisted', () => {
    const repoDir = makeRepo();
    try {
      writeTracked(repoDir, 'shared/lib/offender.ts', "const c = id.endsWith('_c');\n");

      const failing = checkTaskIdentity(repoDir);
      assert.equal(failing.ok, false);
      assert.equal(failing.findings.length, 1);
      assert.equal(failing.findings[0].file, 'shared/lib/offender.ts');

      writeTracked(
        repoDir,
        'tools/task-identity-allowlist.txt',
        '# justified for the test\nshared/lib/offender.ts\n',
      );

      const passing = checkTaskIdentity(repoDir);
      assert.equal(passing.ok, true);
      assert.equal(passing.findings.length, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('ignores untracked offenders', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, 'untracked.ts'), "const c = id.endsWith('_c');\n");
      const result = checkTaskIdentity(repoDir);
      assert.equal(result.ok, true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('formatTaskIdentity', () => {
  it('includes the file:line, pattern name, and remediation hints', () => {
    const output = formatTaskIdentity({
      ok: false,
      scannedFiles: 3,
      findings: [{
        file: 'shared/example.ts',
        line: 7,
        column: 11,
        pattern: 'ts-endswith-c',
        description: 'challenger check',
        text: "id.endsWith('_c')",
      }],
    });

    assert.match(output, /shared\/example\.ts:7:11/);
    assert.match(output, /ts-endswith-c/);
    assert.match(output, /task-identity-allowlist\.txt/);
    assert.match(output, /allow-task-identity: <reason>/);
  });

  it('reports ok with a scanned-file count', () => {
    const output = formatTaskIdentity({ ok: true, scannedFiles: 42, findings: [] });
    assert.match(output, /ok \(42 files scanned\)/);
  });
});
