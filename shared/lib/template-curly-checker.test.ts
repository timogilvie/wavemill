import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkSourceText,
  checkTemplateCurly,
  formatTemplateCurly,
} from './template-curly-checker.ts';

const placeholder = '$' + '{x}';
const repoPlaceholder = '$' + '{repo}';
const emptyPlaceholder = '$' + '{}';

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'template-curly-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  return repoDir;
}

describe('checkSourceText', () => {
  it('flags single-quoted placeholder syntax', () => {
    const findings = checkSourceText('fixture.ts', `const s = 'prefix ${placeholder} suffix';\n`);

    assert.equal(findings.length, 1);
    const { file, line, column, pattern, text } = findings[0];
    assert.deepEqual({ file, line, column, pattern }, {
      file: 'fixture.ts',
      line: 1,
      column: 11,
      pattern: 'string-literal-placeholder',
    });
    assert.ok(text.includes(`'prefix ${placeholder} suffix'`), 'the finding shows the offending line');
  });

  it('flags double-quoted placeholder syntax', () => {
    const findings = checkSourceText('fixture.ts', `const s = "prefix ${placeholder} suffix";\n`);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].column, 11);
    assert.ok(findings[0].text.includes(`"prefix ${placeholder} suffix"`));
  });

  it('flags string literals inside template substitutions', () => {
    const source = 'const s = `' + '${' + `'nested ${placeholder}'` + '}`;\n';

    const findings = checkSourceText('fixture.ts', source);

    assert.equal(findings.length, 1);
    assert.ok(findings[0].text.includes(`'nested ${placeholder}'`));
  });

  it('flags javascript files', () => {
    const findings = checkSourceText('fixture.js', `const s = 'prefix ${placeholder} suffix';\n`);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'fixture.js');
  });

  it('reports the line for object property values in multiline objects', () => {
    const source = [
      'const incident = {',
      '  summary: `ok`,',
      `  operatorAction: 'Investigate PR ${placeholder}',`,
      '};',
      '',
    ].join('\n');

    const findings = checkSourceText('fixture.ts', source);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 3);
    assert.equal(findings[0].column, 19);
  });

  it('ignores real template literals', () => {
    const source = 'const s = `prefix ' + placeholder + ' suffix`;\n';

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores template literals containing quoted placeholder-like substitutions', () => {
    const source = "const s = `Repository '" + repoPlaceholder + "' not found`;\n";

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores multiline template literal content', () => {
    const source = [
      'const s = `',
      `  shell says '${placeholder}' here`,
      '`;',
      '',
    ].join('\n');

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores escaped template syntax inside template literals', () => {
    const source = 'const s = `literal \\' + placeholder + '`;\n';

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores comments', () => {
    const source = [
      `// ${placeholder}`,
      '/**',
      ` * ${placeholder}`,
      ' */',
      'const ok = true;',
      '',
    ].join('\n');

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores regex literals', () => {
    const source = 'const pattern = /\\$\\{[^}]+\\}/;\n';

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores dollars without non-empty braces', () => {
    const source = [
      "const dollars = '$100';",
      `const empty = '${emptyPlaceholder}';`,
      '',
    ].join('\n');

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('ignores rule-generator style substitutions inside generated templates', () => {
    const source = [
      'function render(severity) {',
      "  return `if ('" + '$' + "{severity}' === 'error') { process.exit(1); }`;",
      '}',
      '',
    ].join('\n');

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });
});

describe('allow-template-curly suppression', () => {
  it('suppresses a finding with a same-line marker', () => {
    const source = `const s = 'literal ${placeholder}'; // allow-template-curly: external syntax\n`;

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('suppresses a finding with a marker on the immediately preceding line', () => {
    const source = [
      '// allow-template-curly: external syntax',
      `const s = 'literal ${placeholder}';`,
      '',
    ].join('\n');

    assert.deepEqual(checkSourceText('fixture.ts', source), []);
  });

  it('does not suppress a finding with a marker two lines above', () => {
    const source = [
      '// allow-template-curly: external syntax',
      '',
      `const s = 'literal ${placeholder}';`,
      '',
    ].join('\n');

    assert.equal(checkSourceText('fixture.ts', source).length, 1);
  });
});

describe('checkTemplateCurly', () => {
  it('scans tracked source files and ignores untracked files', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, 'tracked.ts'), `const s = 'literal ${placeholder}';\n`);
      writeFileSync(join(repoDir, 'untracked.ts'), `const s = 'literal ${placeholder}';\n`);
      execFileSync('git', ['add', 'tracked.ts'], { cwd: repoDir });

      const result = checkTemplateCurly(repoDir);

      assert.equal(result.ok, false);
      assert.equal(result.scannedFiles, 1);
      assert.deepEqual(result.findings.map((finding) => finding.file), ['tracked.ts']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns ok when tracked placeholder syntax is explicitly suppressed', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(
        join(repoDir, 'tracked.ts'),
        `// allow-template-curly: fixture syntax\nconst s = 'literal ${placeholder}';\n`,
      );
      execFileSync('git', ['add', 'tracked.ts'], { cwd: repoDir });

      const result = checkTemplateCurly(repoDir);

      assert.equal(result.ok, true);
      assert.equal(result.findings.length, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('formatTemplateCurly', () => {
  it('includes locations and remediation options', () => {
    const output = formatTemplateCurly({
      ok: false,
      scannedFiles: 1,
      findings: [{
        file: 'shared/example.ts',
        line: 2,
        column: 14,
        pattern: 'string-literal-placeholder',
        description: 'plain string literal contains placeholder syntax',
        text: `'${placeholder}'`,
      }],
    });

    assert.match(output, /shared\/example\.ts:2:14/);
    assert.match(output, /switch the string to backticks/);
    assert.match(output, /allow-template-curly: <reason>/);
    assert.match(output, /tools\/template-curly-allowlist\.txt/);
  });
});
