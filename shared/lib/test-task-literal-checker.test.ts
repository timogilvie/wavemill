import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkTestTaskLiterals,
  checkTestTaskLiteralSource,
  formatTestTaskLiterals,
  isTestTaskLiteralScanned,
  parseTestTaskLiteralsAllowlist,
  TEST_TASK_LITERALS_ALLOWLIST_FILE,
} from './test-task-literal-checker.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const linesOf = (source: string, file = 'tests/example.test.ts') =>
  checkTestTaskLiteralSource(file, source).map((finding) => finding.line);

describe('checkTestTaskLiteralSource', () => {
  it('flags TS, JSON, jq and escaped-JSON task literals', () => {
    assert.deepEqual(linesOf("const state = {\n  tasks: {\n    'HOK-1': { slug: 'a' },\n  },\n};"), [2]);
    assert.deepEqual(linesOf("writeFileSync(p, JSON.stringify({ tasks: { 'HOK-1': {} } }));"), [1]);
    assert.deepEqual(linesOf('{\n  "tasks": {\n    "HOK-1": {}\n  }\n}', 'tests/fixtures/state.json'), [2]);
    assert.deepEqual(linesOf("jq -n '{tasks: {($i): {slug: \"a\"}}}' > \"$STATE_FILE\"", 'tests/a.test.sh'), [1]);
    assert.deepEqual(linesOf('printf "{\\"tasks\\":{\\"$ISSUE\\":{}}}\\n"', 'tests/a.test.sh'), [1]);
    assert.deepEqual(linesOf("const s = { 'tasks': { a: {} } };"), [1]);
  });

  it('does not flag an empty map, property reads, types or other names', () => {
    assert.deepEqual(linesOf("writeFileSync(p, JSON.stringify({ tasks: {} }));"), []);
    assert.deepEqual(linesOf('{"tasks": { }}', 'tests/fixtures/empty.json'), []);
    assert.deepEqual(linesOf("const t = state.tasks['HOK-1'];"), []);
    assert.deepEqual(linesOf('jq ".tasks[$i] = {}" "$f"', 'tests/a.test.sh'), []);
    assert.deepEqual(linesOf('function f(tasks: Record<string, TaskRecord>) {}'), []);
    assert.deepEqual(linesOf('const subtasks: { a: 1 } = x; const $tasks = { a: 1 };'), []);
  });

  it('honours the suppression marker on the line or the line above, and skips comments', () => {
    assert.deepEqual(linesOf("const s = { tasks: { a: {} } }; // allow-task-literal: invalid row"), []);
    assert.deepEqual(linesOf("// allow-task-literal: invalid row\nconst s = { tasks: { a: {} } };"), []);
    assert.deepEqual(linesOf("# allow-task-literal: not workflow-state\necho '{\"tasks\": {\"a\": 1}}'", 'tests/a.test.sh'), []);
    assert.deepEqual(linesOf(" * e.g. { tasks: { 'HOK-1': {} } }\n// tasks: { a }\n# \"tasks\": {"), []);
    assert.deepEqual(linesOf("// allow-task-literal: one line only\nconst a = 1;\nconst s = { tasks: { a: {} } };"), [3]);
  });

  it('reports position and pattern', () => {
    const [finding] = checkTestTaskLiteralSource('tests/a.test.ts', "  x = { tasks: { a: {} } };");
    assert.equal(finding.file, 'tests/a.test.ts');
    assert.equal(finding.line, 1);
    assert.equal(finding.column, 9);
    assert.equal(finding.pattern, 'task-literal');
  });
});

describe('isTestTaskLiteralScanned', () => {
  it('scans tests/ and *.test.* files, and skips the builders, the guard and non-code files', () => {
    assert.equal(isTestTaskLiteralScanned('tests/foo.test.sh'), true);
    assert.equal(isTestTaskLiteralScanned('tests/fixtures/lifecycle/case.sh'), true);
    assert.equal(isTestTaskLiteralScanned('tests/fixtures/state.json'), true);
    assert.equal(isTestTaskLiteralScanned('shared/lib/merge-labels.test.ts'), true);
    assert.equal(isTestTaskLiteralScanned('tools/observer.test.ts'), true);
    assert.equal(isTestTaskLiteralScanned('shared/lib/wavemill-common.sh'), false, 'production writer');
    assert.equal(isTestTaskLiteralScanned('shared/lib/merge-labels.ts'), false);
    assert.equal(isTestTaskLiteralScanned('tests/README.md'), false);
    assert.equal(isTestTaskLiteralScanned('tests/lib/task-builder.ts'), false);
    assert.equal(isTestTaskLiteralScanned('tests/lib/state-fixtures.sh'), false);
    assert.equal(isTestTaskLiteralScanned('shared/lib/test-task-literal-checker.ts'), false);
    assert.equal(isTestTaskLiteralScanned('worktrees/x/tests/a.test.ts'), false);
  });
});

describe('parseTestTaskLiteralsAllowlist', () => {
  it('requires a reason on every entry', () => {
    const parsed = parseTestTaskLiteralsAllowlist('# header\n\ntests/a.test.sh  # seeded\ntests/b.test.sh\n');
    assert.deepEqual(parsed.entries, [{ path: 'tests/a.test.sh', reason: 'seeded' }]);
    assert.deepEqual(parsed.missingReason, ['tests/b.test.sh']);
  });
});

describe('checkTestTaskLiterals', () => {
  it('the repository has no unlisted task literals and no stale allowlist entries', () => {
    const result = checkTestTaskLiterals(repoRoot);
    assert.deepEqual(result.findings, [], formatTestTaskLiterals(result));
    assert.ok(result.scannedFiles > 0);
  });

  it('the seeded allowlist only names files that still need it', () => {
    const { entries, missingReason } = parseTestTaskLiteralsAllowlist(
      readFileSync(join(repoRoot, TEST_TASK_LITERALS_ALLOWLIST_FILE), 'utf-8'),
    );
    assert.deepEqual(missingReason, []);
    const paths = entries.map((entry) => entry.path);
    assert.deepEqual(paths, [...new Set(paths)], 'no duplicate entries');
  });

  it('flags unlisted literals, honours the allowlist, and enforces the shrink-only ratchet', () => {
    const repo = mkdtempSync(join(tmpdir(), 'test-task-literals-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'tests', 'fixtures'), { recursive: true });
      mkdirSync(join(repo, 'tools'), { recursive: true });
      mkdirSync(join(repo, 'shared', 'lib'), { recursive: true });
      writeFileSync(join(repo, 'tests', 'new.test.sh'), 'echo \'{"tasks": {"HOK-1": {}}}\' > "$f"\n');
      writeFileSync(join(repo, 'tests', 'listed.test.ts'), "const s = { tasks: { a: {} } };\n");
      writeFileSync(join(repo, 'tests', 'migrated.test.ts'), "const s = buildWorkflowState({ a: {} });\n");
      writeFileSync(join(repo, 'tests', 'fixtures', 'state.json'), '{"tasks": {"HOK-2": {}}}\n');
      writeFileSync(join(repo, 'shared', 'lib', 'writer.sh'), 'echo \'{"tasks": {"HOK-3": {}}}\'\n');
      writeFileSync(join(repo, TEST_TASK_LITERALS_ALLOWLIST_FILE), [
        '# header',
        'tests/listed.test.ts  # seeded',
        'tests/migrated.test.ts  # seeded',
        'tests/deleted.test.ts  # seeded',
        'tests/fixtures/state.json',
      ].join('\n'));
      execFileSync('git', ['add', '-A'], { cwd: repo });

      const result = checkTestTaskLiterals(repo);
      assert.equal(result.ok, false);
      const summary = result.findings.map((f) => `${f.pattern} ${f.pattern === 'task-literal' ? f.file : f.text}`).sort();
      assert.deepEqual(summary, [
        'allowlist-missing-reason tests/fixtures/state.json',
        'allowlist-stale-entry tests/deleted.test.ts',
        'allowlist-stale-entry tests/migrated.test.ts',
        'task-literal tests/fixtures/state.json',
        'task-literal tests/new.test.sh',
      ]);
      const message = formatTestTaskLiterals(result);
      assert.match(message, /buildTask, buildWorkflowState/);
      assert.match(message, /allow-task-literal: <reason>/);
      assert.match(message, /only shrinks/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('passes on a clean tree with no allowlist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'test-task-literals-clean-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'tests'), { recursive: true });
      writeFileSync(join(repo, 'tests', 'a.test.ts'), "const s = buildWorkflowState({ 'HOK-1': { phase: 'ready' } });\n");
      execFileSync('git', ['add', '-A'], { cwd: repo });
      const result = checkTestTaskLiterals(repo);
      assert.deepEqual(result.findings, []);
      assert.equal(formatTestTaskLiterals(result), 'test-task-literals: ok (1 files scanned)');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
