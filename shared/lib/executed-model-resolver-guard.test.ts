/**
 * protects: HOK-3369 — the executed-model-resolver guard reports every
 * forbidden shape named by its spec (shell resolver spawn, private import,
 * second eligibility reason site).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourceGuard } from '../../tools/lib/source-guard.ts';
import { EXECUTED_MODEL_RESOLVER_GUARD } from './executed-model-resolver-guard.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'resolver-guard-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'ci'], { cwd: dir });
  return dir;
}

function track(repo: string, relPath: string, content: string): void {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  execFileSync('git', ['add', relPath], { cwd: repo });
}

function commit(repo: string): void {
  execFileSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: repo });
}

describe('EXECUTED_MODEL_RESOLVER_GUARD', () => {
  it('fails on a shell that spawns resolve-executed-model.ts', () => {
    const repo = tempRepo();
    track(repo, 'scripts/offender.sh', `#!/usr/bin/env bash\nnpx tsx tools/resolve-executed-model.ts --feature-dir f --stage coding\n`);
    commit(repo);
    const result = runSourceGuard(EXECUTED_MODEL_RESOLVER_GUARD, repo);
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.pattern === 'shell-invokes-retired-resolver-tool'),
      `expected shell-invokes-retired-resolver-tool, got ${result.findings.map((f) => f.pattern).join(', ')}`,
    );
  });

  it('fails on a TS file that imports resolveExecutedModelFromSessions', () => {
    const repo = tempRepo();
    track(repo, 'shared/lib/offender.ts', `import { resolveExecutedModelFromSessions } from './executed-model-resolver.ts';\nexport const x = resolveExecutedModelFromSessions;\n`);
    commit(repo);
    const result = runSourceGuard(EXECUTED_MODEL_RESOLVER_GUARD, repo);
    assert.ok(
      result.findings.some((f) => f.pattern === 'imports-session-resolver-internals'),
      `expected imports-session-resolver-internals finding, got ${result.findings.map((f) => f.pattern).join(', ')}`,
    );
  });

  it('fails on a second site that writes runtime_fallback', () => {
    const repo = tempRepo();
    track(repo, 'shared/lib/offender.ts', `export const reason = 'runtime_fallback';\n`);
    commit(repo);
    const result = runSourceGuard(EXECUTED_MODEL_RESOLVER_GUARD, repo);
    assert.ok(
      result.findings.some((f) => f.pattern === 'runtime-fallback-literal-outside-stage-result'),
      `expected runtime-fallback finding, got ${result.findings.map((f) => f.pattern).join(', ')}`,
    );
  });

  it('passes when no offending shape appears', () => {
    const repo = tempRepo();
    track(repo, 'shared/lib/benign.ts', `// talks about executed-model resolver in a comment\nexport const x = 1;\n`);
    commit(repo);
    const result = runSourceGuard(EXECUTED_MODEL_RESOLVER_GUARD, repo);
    assert.equal(result.ok, true);
  });
});
