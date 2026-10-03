import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkSourceText,
  checkTestTrackedWrites,
  formatTestTrackedWrites,
} from './test-tracked-write-checker.ts';

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'test-tracked-writes-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  return repoDir;
}

describe('checkSourceText', () => {
  const tracked = new Set(['tools/prompts/x.md']);

  it('flags writeFileSync on a tracked literal path', () => {
    const source = "writeFileSync('tools/prompts/x.md', 'hi');\n";
    const findings = checkSourceText('a.test.ts', source, tracked);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].callee, 'writeFileSync');
    assert.equal(findings[0].path, 'tools/prompts/x.md');
    assert.equal(findings[0].line, 1);
  });

  it('flags fs.writeFileSync (property access) and strips leading ./', () => {
    const source = "fs.writeFileSync('./tools/prompts/x.md', 'hi');\n";
    const findings = checkSourceText('a.test.ts', source, tracked);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].callee, 'writeFileSync');
    assert.equal(findings[0].path, 'tools/prompts/x.md');
  });

  it('flags the destination of renameSync', () => {
    const source = "renameSync(tmp, 'tools/prompts/x.md');\n";
    const findings = checkSourceText('a.test.ts', source, tracked);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].callee, 'renameSync');
    assert.equal(findings[0].path, 'tools/prompts/x.md');
  });

  it('flags the destination of copyFileSync', () => {
    const source = "copyFileSync(src, 'tools/prompts/x.md');\n";
    const findings = checkSourceText('a.test.ts', source, tracked);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].callee, 'copyFileSync');
  });

  it('flags no-substitution template literals', () => {
    const source = 'writeFileSync(`tools/prompts/x.md`, `hi`);\n';
    const findings = checkSourceText('a.test.ts', source, tracked);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, 'tools/prompts/x.md');
  });

  it('does not flag untracked literal paths', () => {
    const source = "writeFileSync('other/path.md', 'hi');\n";
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });

  it('does not flag computed path arguments', () => {
    const source = "writeFileSync(join(tmp, 'x.md'), 'hi');\n";
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });

  it('does not flag read-only calls', () => {
    const source = "readFileSync('tools/prompts/x.md', 'utf-8');\n";
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });

  it('does not flag template literals with substitutions', () => {
    const source = 'writeFileSync(`tools/prompts/${name}.md`, `hi`);\n';
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });

  it('does not flag absolute paths', () => {
    const source = "writeFileSync('/tmp/x.md', 'hi');\n";
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });

  it('honors a same-line suppression comment', () => {
    const source = "writeFileSync('tools/prompts/x.md', 'hi'); // allow-tracked-write: fixture\n";
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });

  it('honors a previous-line suppression comment', () => {
    const source = [
      '// allow-tracked-write: fixture',
      "writeFileSync('tools/prompts/x.md', 'hi');",
      '',
    ].join('\n');
    assert.deepEqual(checkSourceText('a.test.ts', source, tracked), []);
  });
});

describe('checkTestTrackedWrites', () => {
  it('flags the exact HOK-3157 pattern in a fixture repo', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'tools/prompts'), { recursive: true });
      mkdirSync(join(repoDir, 'shared/lib'), { recursive: true });
      writeFileSync(join(repoDir, 'tools/prompts/dependency-classifier.md'), 'default\n');
      writeFileSync(
        join(repoDir, 'shared/lib/dependency-classifier.test.ts'),
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "const original = readFileSync('tools/prompts/dependency-classifier.md', 'utf-8');",
          "try {",
          "  writeFileSync('tools/prompts/dependency-classifier.md', 'marker');",
          "} finally {",
          "  writeFileSync('tools/prompts/dependency-classifier.md', original);",
          "}",
          '',
        ].join('\n'),
      );
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir });

      const result = checkTestTrackedWrites(repoDir);
      assert.equal(result.ok, false);
      assert.equal(result.scannedFiles, 1);
      assert.ok(result.findings.length >= 1);
      for (const finding of result.findings) {
        assert.equal(finding.file, 'shared/lib/dependency-classifier.test.ts');
        assert.equal(finding.path, 'tools/prompts/dependency-classifier.md');
        assert.equal(finding.callee, 'writeFileSync');
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not scan non-test files', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'tools/prompts'), { recursive: true });
      mkdirSync(join(repoDir, 'shared/lib'), { recursive: true });
      writeFileSync(join(repoDir, 'tools/prompts/x.md'), 'default\n');
      writeFileSync(
        join(repoDir, 'shared/lib/non-test.ts'),
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('tools/prompts/x.md', 'hi');\n",
      );
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir });

      const result = checkTestTrackedWrites(repoDir);
      assert.equal(result.ok, true);
      assert.equal(result.scannedFiles, 0);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not flag writes to untracked paths from a test file', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'shared/lib'), { recursive: true });
      writeFileSync(
        join(repoDir, 'shared/lib/foo.test.ts'),
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('tmp/output.md', 'hi');\n",
      );
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir });

      const result = checkTestTrackedWrites(repoDir);
      assert.equal(result.ok, true);
      assert.equal(result.scannedFiles, 1);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('formatTestTrackedWrites', () => {
  it('ok line includes scanned file count', () => {
    const output = formatTestTrackedWrites({ ok: true, scannedFiles: 42, findings: [] });
    assert.match(output, /ok \(42 test files scanned\)/);
  });

  it('failure output lists locations and remediation guidance', () => {
    const output = formatTestTrackedWrites({
      ok: false,
      scannedFiles: 1,
      findings: [{
        file: 'shared/lib/foo.test.ts',
        line: 7,
        column: 3,
        callee: 'writeFileSync',
        path: 'tools/prompts/x.md',
      }],
    });
    assert.match(output, /shared\/lib\/foo\.test\.ts:7:3/);
    assert.match(output, /writeFileSync\('tools\/prompts\/x\.md'\)/);
    assert.match(output, /HOK-3157/);
    assert.match(output, /mkdtemp/);
    assert.match(output, /allow-tracked-write: <reason>/);
  });
});
