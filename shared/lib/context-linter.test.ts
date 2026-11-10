// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { formatLintResults, lintSubsystemSpecs } from './context-linter.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${(err as Error).message}`);
    });
}

function write(repoDir: string, relPath: string, content: string) {
  const filePath = join(repoDir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function commitAll(repoDir: string, message: string) {
  execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
  execSync(`git commit -m "${message}"`, { cwd: repoDir, stdio: 'ignore' });
}

console.log('\n--- context-linter Tests ---\n');

test('lintSubsystemSpecs finds orphaned, missing, stale, contradiction, and constraint results', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'context-linter-'));

  try {
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });

    write(repoDir, 'shared/foo/a.ts', 'export const alpha = 1;\n');
    write(repoDir, 'shared/foo/b.ts', 'export const beta = 2;\n');
    write(repoDir, 'shared/foo/c.ts', 'export const gamma = 3;\n');
    write(repoDir, 'shared/bar/a.ts', 'export const one = 1;\n');
    write(repoDir, 'shared/bar/b.ts', 'export const two = 2;\n');
    write(repoDir, 'shared/bar/c.ts', 'export const three = 3;\n');
    write(repoDir, 'shared/baz/a.ts', 'export const start = 1;\n');
    write(repoDir, 'shared/baz/b.ts', 'export const middle = 2;\n');
    write(repoDir, 'shared/baz/c.ts', 'export const end = 3;\n');
    write(
      repoDir,
      '.wavemill/context/shared-foo.md',
      `# Subsystem: Shared Foo

## Related Subsystems
- [Bar](shared-bar.md)
- [Missing](missing-subsystem.md)

## Related Concepts
- [Missing Concept](concepts/missing-concept.md)

## Architectural Constraints
### DON'T
- DON'T add \`process.exit(1)\` to \`shared/foo/a.ts\`
- DON'T mutate \`shared/foo/a.ts\`
`,
    );
    write(
      repoDir,
      '.wavemill/context/shared-baz.md',
      `# Subsystem: Shared Baz

## Related Subsystems
- [Foo](shared-foo.md)

## Architectural Constraints
### DO
- DO mutate \`shared/foo/a.ts\`
`,
    );
    write(
      repoDir,
      '.wavemill/context/orphaned-spec.md',
      `# Subsystem: Orphaned Spec

## Key Files
| File | Role | Notes |
|---|---|---|
| \`shared/removed/no-longer-exists.ts\` | Implementation | TypeScript |

## Related Subsystems
- [Foo](shared-foo.md)
`,
    );
    write(
      repoDir,
      '.wavemill/context/concepts/existing-concept.md',
      '# Concept: Existing Concept\n',
    );

    commitAll(repoDir, 'initial context');

    write(repoDir, 'shared/foo/a.ts', 'export const alpha = 1;\nprocess.exit(1);\n');
    commitAll(repoDir, 'introduce violating change');

    const results = await lintSubsystemSpecs(repoDir);

    assert.ok(results.some((result) => result.rule === 'orphaned-spec' && result.subsystem === 'orphaned-spec'));
    assert.ok(results.some((result) => result.rule === 'missing-spec' && result.subsystem === 'shared-bar'));
    assert.ok(results.some((result) => result.rule === 'stale-crossref' && result.message.includes('missing-subsystem.md')));
    assert.ok(results.some((result) => result.rule === 'stale-crossref' && result.message.includes('missing-concept.md')));
    assert.ok(results.some((result) => result.rule === 'contradiction' && result.subsystem === 'shared-foo'));
    assert.ok(results.some((result) => result.rule === 'constraint-violation' && result.subsystem === 'shared-foo'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('lintSubsystemSpecs filters rules and formatter orders errors before warnings', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'context-linter-filter-'));

  try {
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });

    write(repoDir, 'shared/foo/a.ts', 'export const a = 1;\n');
    write(repoDir, 'shared/foo/b.ts', 'export const b = 2;\n');
    write(repoDir, 'shared/foo/c.ts', 'export const c = 3;\n');
    write(
      repoDir,
      '.wavemill/context/shared-foo.md',
      `# Subsystem: Shared Foo

## Related Subsystems
- [Missing](missing.md)
`,
    );
    commitAll(repoDir, 'setup filter test');

    const results = await lintSubsystemSpecs(repoDir, { rules: ['stale-crossref'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].rule, 'stale-crossref');

    const formatted = formatLintResults([
      { level: 'warn', rule: 'missing-spec', subsystem: 'shared-bar', message: 'warn message' },
      { level: 'error', rule: 'orphaned-spec', subsystem: 'orphaned-spec', message: 'error message' },
    ]);
    const lines = formatted.split('\n');
    assert.match(lines[0], /^❌ \[orphaned-spec]/);
    assert.match(lines[1], /^⚠️ \[missing-spec]/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

  if (failed > 0) {
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
