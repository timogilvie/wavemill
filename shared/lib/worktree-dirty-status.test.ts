import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  filterWorktreeDirtyStatus,
  readWorktreeDirtyStatus,
  WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT,
  WAVEMILL_PROMPT_REGISTRY_ARTIFACT,
} from './worktree-dirty-status.ts';

// HOK-3088 unit coverage for the shared at-risk predicate. The filter must
// match the shell helper `wavemill_worktree_dirty_status` in wavemill-common.sh
// exactly - anything that leaks past the filter here will silently disagree
// with cleanup's dirty_worktree refusal and with the shell safety guards.

test('filter drops the exact controller-owned artifacts and nothing else', () => {
  const raw = [
    `?? ${WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT}`,
    `?? ${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`,
    ` M ${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`,
    ' M src/app.ts',
    '?? tools/new-tool.ts',
    '?? tests/new-fixture.ts',
  ].join('\n');
  const filtered = filterWorktreeDirtyStatus(raw);
  assert.deepEqual(filtered, [
    ' M src/app.ts',
    '?? tools/new-tool.ts',
    '?? tests/new-fixture.ts',
  ]);
});

test('filter keeps a staged prompt-registry.jsonl edit (shell filter drops only the exact "?? " / " M " forms)', () => {
  const raw = [
    `M  ${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`,
    `?? some/other/${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`,
  ].join('\n');
  const filtered = filterWorktreeDirtyStatus(raw);
  assert.deepEqual(filtered, [
    `M  ${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`,
    `?? some/other/${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`,
  ]);
});

test('filter treats empty and trailing-blank porcelain output as clean', () => {
  assert.deepEqual(filterWorktreeDirtyStatus(''), []);
  assert.deepEqual(filterWorktreeDirtyStatus('\n\n'), []);
});

test('filter keeps every non-controller change under .wavemill/', () => {
  const raw = [
    `?? ${WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT}`,
    '?? .wavemill/evals/artifacts/HOK-3056/notes.md',
    ' M .wavemill/registry/session.jsonl',
  ].join('\n');
  const filtered = filterWorktreeDirtyStatus(raw);
  assert.deepEqual(filtered, [
    '?? .wavemill/evals/artifacts/HOK-3056/notes.md',
    ' M .wavemill/registry/session.jsonl',
  ]);
});

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-dirty-status-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], { stdio: 'ignore' });
  return dir;
}

test('readWorktreeDirtyStatus reports absent when the worktree directory does not exist', () => {
  const result = readWorktreeDirtyStatus({ worktree: '/tmp/definitely-not-a-worktree-12345' });
  assert.equal(result.state, 'absent');
  assert.deepEqual(result.lines, []);
});

test('readWorktreeDirtyStatus reports unreadable when git fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-dirty-status-notgit-'));
  try {
    const result = readWorktreeDirtyStatus({ worktree: dir });
    assert.equal(result.state, 'unreadable');
    assert.deepEqual(result.lines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeDirtyStatus reports clean on an empty tree', () => {
  const dir = makeGitRepo();
  try {
    const result = readWorktreeDirtyStatus({ worktree: dir });
    assert.equal(result.state, 'clean');
    assert.deepEqual(result.lines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeDirtyStatus surfaces the HOK-3056 shape: modified tracked file + untracked new files', () => {
  const dir = makeGitRepo();
  try {
    writeFileSync(join(dir, 'README.md'), 'seed\nedited\n');
    mkdirSync(join(dir, 'shared', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'shared', 'lib', 'mcp-client.ts'), 'export {};\n');
    writeFileSync(join(dir, 'tools', 'mcp.ts'), 'export {};\n');
    const result = readWorktreeDirtyStatus({ worktree: dir });
    assert.equal(result.state, 'dirty');
    // Exact set of paths (order-independent) so path-cap trimming stays deterministic.
    const paths = result.lines.map((line) => line.slice(3)).sort();
    assert.deepEqual(paths, [
      'README.md',
      'shared/lib/mcp-client.ts',
      'tools/mcp.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeDirtyStatus reports clean when only the excluded controller artifacts are present', () => {
  const dir = makeGitRepo();
  try {
    mkdirSync(join(dir, '.wavemill'), { recursive: true });
    writeFileSync(join(dir, WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT), '{"finding":"ignored"}\n');
    writeFileSync(join(dir, WAVEMILL_PROMPT_REGISTRY_ARTIFACT), '{"prompt":"ignored"}\n');
    const result = readWorktreeDirtyStatus({ worktree: dir });
    assert.equal(result.state, 'clean');
    assert.deepEqual(result.lines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeDirtyStatus reports dirty when the observer artifact sits next to a real change', () => {
  const dir = makeGitRepo();
  try {
    mkdirSync(join(dir, '.wavemill'), { recursive: true });
    writeFileSync(join(dir, WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT), '{"finding":"ignored"}\n');
    writeFileSync(join(dir, 'src.ts'), 'real change\n');
    const result = readWorktreeDirtyStatus({ worktree: dir });
    assert.equal(result.state, 'dirty');
    assert.deepEqual(result.lines, ['?? src.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HOK-3160 Class B: generated-artifact allowlist expansion. The dashboard
// kept delivered tasks indefinitely when the only "dirt" was a tool-written
// audit, review-result, or trace-metadata file. These must not retain.

test('filter drops .wavemill/audits/* untracked files (HOK-3160 Class B)', () => {
  const raw = [
    '?? .wavemill/audits/openrouter-alias-drift.json',
    '?? .wavemill/audits/launch-priority-coverage.json',
    '?? .wavemill/audits/certifications/some-report.json',
    '?? src/real-change.ts',
  ].join('\n');
  assert.deepEqual(filterWorktreeDirtyStatus(raw), ['?? src/real-change.ts']);
});

test('filter drops features/<slug>/.review-result.json and trace-metadata siblings (HOK-3160 Class B)', () => {
  const raw = [
    '?? features/some-slug/.review-result.json',
    ' M features/some-slug/.review-result.json',
    '?? features/some-slug/.needs-attention',
    '?? features/some-slug/.terminal-history.jsonl',
    ' M features/some-slug/.terminal-history.jsonl',
    '?? features/some-slug/.ready-bypass-warned',
    '?? features/some-slug/.coding-complete',
    '?? features/some-slug/.workflow-aborted',
    '?? features/some-slug/.coding-blocked-completion.json',
    '?? features/some-slug/user-notes.md',
  ].join('\n');
  assert.deepEqual(filterWorktreeDirtyStatus(raw), ['?? features/some-slug/user-notes.md']);
});

test('filter does NOT drop arbitrary files under .wavemill/ outside the audits allowlist', () => {
  const raw = [
    '?? .wavemill/notes.md',
    '?? .wavemill/registry/session.jsonl',
    '?? .wavemill/evals/artifacts/HOK-3056/user-notes.md',
  ].join('\n');
  assert.deepEqual(filterWorktreeDirtyStatus(raw), [
    '?? .wavemill/notes.md',
    '?? .wavemill/registry/session.jsonl',
    '?? .wavemill/evals/artifacts/HOK-3056/user-notes.md',
  ]);
});

test('filter does NOT drop audits paths with a tracked porcelain code', () => {
  // A tracked and modified audit file is a declared change in the branch;
  // keep it as dirt. Only untracked audits are tool output.
  const raw = [
    ' M .wavemill/audits/openrouter-alias-drift.json',
    'MM .wavemill/audits/openrouter-alias-drift.json',
    '?? .wavemill/audits/openrouter-alias-drift.json',
  ].join('\n');
  assert.deepEqual(filterWorktreeDirtyStatus(raw), [
    ' M .wavemill/audits/openrouter-alias-drift.json',
    'MM .wavemill/audits/openrouter-alias-drift.json',
  ]);
});
