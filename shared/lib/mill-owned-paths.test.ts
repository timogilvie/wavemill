import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { filterMillOwnedDirtyStatus, MILL_OWNED_PATHS, millOwnedEntry, renderMillOwnedShell } from './mill-owned-paths.ts';
import { archiveTaskEvidence, evidenceReleaseList } from './task-evidence-archive.ts';

test('declares telemetry, evidence and runtime paths and leaves task context visible', () => {
  assert.equal(millOwnedEntry('.wavemill/task-size-estimates.jsonl')?.disposition, 'telemetry');
  assert.equal(millOwnedEntry('features/task/.review-result.json')?.disposition, 'evidence');
  assert.equal(millOwnedEntry('.wavemill/audits/report.json')?.disposition, 'runtime');
  assert.equal(millOwnedEntry('.wavemill/context/task-notes.md'), undefined);
  assert.equal(millOwnedEntry('.wavemill/unknown.json'), undefined);
  // Nested mill state under a feature dot-directory (the challenge fork snapshot)
  // stays owned, so an active arm's coding completion is not read as dirty.
  assert.equal(millOwnedEntry('features/task/.fork-snapshot/JRN-5_c/plan.md')?.disposition, 'runtime');
  assert.equal(millOwnedEntry('features/task/sub/.hidden/notes.md'), undefined);
  assert.ok(MILL_OWNED_PATHS.length > 10);
});

test('dirty status drops only untracked or ignored declared output', () => {
  assert.deepEqual(filterMillOwnedDirtyStatus([
    '?? .wavemill/task-size-estimates.jsonl',
    '!! .wavemill/evals/prompt-registry.jsonl',
    ' M prompt-registry.jsonl',
    'M  .wavemill/task-size-estimates.jsonl',
    '?? .wavemill/context/task-notes.md',
    '?? .wavemill/unknown.json',
  ].join('\n')), [
    ' M prompt-registry.jsonl',
    'M  .wavemill/task-size-estimates.jsonl',
    '?? .wavemill/context/task-notes.md',
    '?? .wavemill/unknown.json',
  ]);
});

test('generated Bash matcher agrees with the TypeScript corpus', () => {
  const root = join(import.meta.dirname, '..', '..');
  const shellFile = join(root, 'shared/lib/mill-owned-paths.sh');
  assert.equal(readFileSync(shellFile, 'utf8'), renderMillOwnedShell());
  const tmp = mkdtempSync(join(tmpdir(), 'mill-owned-parity-'));
  try {
    const cases = [
      '.wavemill/task-size-estimates.jsonl', './.wavemill/task-size-estimates.jsonl', '.wavemill/audits/report.json', '.wavemill/audits/deep/report.json',
      '.wavemill/evals/prompt-registry.jsonl', '.wavemill/evals/other.jsonl', '.wavemill/ledger.sqlite-wal', '.wavemill/cache/a/b', '.wavemill/context/task.md', '.wavemill/unknown',
      'features/a/.coding-complete', 'features/a/.review-result.json', 'features/a/plan.md', 'features/a/subdir/.env', 'features/a/subdir/plan.md', 'features/a/file.txt',
      'prompt-registry.jsonl', '.claude/settings.local.json', '.wavemill-config.local.json', 'src/app.ts', 'features/a/.stale-artifacts/x', 'features/a/.retry-coding-dirty-handoff-1',
      'features/a/.fork-snapshot/JRN-5_c/plan.md', 'features/a/sub/.hidden/notes.md', 'features/a/sub/.stale-artifacts/x', '?? features/a/.fork-snapshot/JRN-5_c/.plan-approved',
      'M  .wavemill/task-size-estimates.jsonl', ' M .wavemill/task-size-estimates.jsonl', '?? .wavemill/task-size-estimates.jsonl', '!! .wavemill/evals/prompt-registry.jsonl',
      '?? ./ .wavemill/task-size-estimates.jsonl', 'R  old.ts -> .wavemill/task-size-estimates.jsonl', '?? src/quoted name.ts', '?? features/a/subdir/.env', '?? features/a/.coding-complete',
    ];
    const shell = `source ${JSON.stringify(shellFile)}; for value in "$@"; do if [[ "$value" == *'  '* || "$value" == '?? '* || "$value" == '!! '* ]]; then wavemill_mill_owned_dirty_line "$value" && echo 1 || echo 0; else wavemill_mill_owned_path "$value" && echo 1 || echo 0; fi; done`;
    const result = execFileSync('bash', ['-c', shell, 'bash', ...cases], { encoding: 'utf8' }).trim().split('\n');
    const expected = cases.map(value => (value.startsWith('?? ') || value.startsWith('!! ') || value.startsWith('M  '))
      ? Number((value.startsWith('?? ') || value.startsWith('!! ')) && !!millOwnedEntry(value.slice(3)))
      : Number(!!millOwnedEntry(value))).map(String);
    assert.deepEqual(result, expected);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('cleanup migrates declared telemetry, removes owned output, and leaves unknown dirt', () => {
  const root = mkdtempSync(join(tmpdir(), 'mill-owned-discard-'));
  const main = join(root, 'main');
  const worktree = join(root, 'task-worktree');
  const shellFile = join(import.meta.dirname, 'mill-owned-paths.sh');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    execFileSync('git', ['-C', main, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Test']);
    writeFileSync(join(main, 'README.md'), 'seed\n');
    execFileSync('git', ['-C', main, 'add', 'README.md']);
    execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'seed']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'task/test', worktree]);
    // Git reports this ignored directory as one `!! .wavemill/evals/` line;
    // cleanup must still find and migrate its declared telemetry child.
    writeFileSync(join(main, '.git', 'info', 'exclude'), '.wavemill/evals/\n');
    mkdirSync(join(worktree, '.wavemill/evals'), { recursive: true });
    writeFileSync(join(worktree, '.wavemill/task-size-estimates.jsonl'), 'estimate-row\n');
    writeFileSync(join(worktree, '.wavemill/evals/prompt-registry.jsonl'), 'eval-row\n');
    writeFileSync(join(worktree, 'prompt-registry.jsonl'), 'legacy-row\n');
    writeFileSync(join(worktree, '.wavemill/observer-findings.jsonl'), 'observer-row\n');
    mkdirSync(join(worktree, '.wavemill/context'), { recursive: true });
    writeFileSync(join(worktree, '.wavemill/context/notes.md'), 'task work\n');
    execFileSync('bash', ['-c', 'source "$1"; wavemill_discard_mill_owned_untracked "$2"', 'bash', shellFile, worktree], {
      env: { ...process.env, REPO_DIR: main },
    });
    assert.equal(existsSync(join(worktree, '.wavemill/task-size-estimates.jsonl')), false);
    assert.equal(existsSync(join(worktree, '.wavemill/evals/prompt-registry.jsonl')), false);
    assert.equal(existsSync(join(worktree, 'prompt-registry.jsonl')), false);
    assert.equal(existsSync(join(worktree, '.wavemill/observer-findings.jsonl')), false);
    assert.equal(existsSync(join(worktree, '.wavemill/context/notes.md')), true);
    assert.equal(readFileSync(join(main, '.wavemill/task-size-estimates.jsonl'), 'utf8'), 'estimate-row\n');
    assert.deepEqual(readFileSync(join(main, '.wavemill/evals/prompt-registry.jsonl'), 'utf8').trim().split('\n').sort(), ['eval-row', 'legacy-row']);
    assert.equal(readFileSync(join(main, '.wavemill/observer-findings.jsonl'), 'utf8'), 'observer-row\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup retains telemetry symlinks without migrating their targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'mill-owned-symlink-'));
  const main = join(root, 'main');
  const worktree = join(root, 'worktree');
  const shellFile = join(import.meta.dirname, 'mill-owned-paths.sh');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    execFileSync('git', ['-C', main, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Test']);
    writeFileSync(join(main, 'README.md'), 'seed\n');
    execFileSync('git', ['-C', main, 'add', 'README.md']);
    execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'seed']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'task/test', worktree]);
    const secret = join(root, 'secret');
    writeFileSync(secret, 'private\n');
    mkdirSync(join(worktree, '.wavemill'));
    const link = join(worktree, '.wavemill/task-size-estimates.jsonl');
    symlinkSync(secret, link);
    execFileSync('bash', ['-c', 'source "$1"; wavemill_discard_mill_owned_untracked "$2"', 'bash', shellFile, worktree], {
      env: { ...process.env, REPO_DIR: main }, stdio: 'pipe',
    });
    assert.equal(existsSync(link), true);
    assert.equal(existsSync(join(main, '.wavemill/task-size-estimates.jsonl')), false);
    assert.equal(readFileSync(secret, 'utf8'), 'private\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evidence is discarded only after the shared archive verified its current bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mill-owned-evidence-'));
  const main = join(root, 'main');
  const worktree = join(main, 'worktrees', 'demo');
  const feature = join(worktree, 'features', 'demo');
  const shellFile = join(import.meta.dirname, 'mill-owned-paths.sh');
  const discard = (list: string) => execFileSync('bash', ['-c', 'source "$1"; wavemill_discard_mill_owned_untracked "$2" "$3"', 'bash', shellFile, worktree, list], {
    env: { ...process.env, REPO_DIR: main },
  });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    execFileSync('git', ['-C', main, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Test']);
    writeFileSync(join(main, '.wavemill-config.json'), '{}');
    writeFileSync(join(main, '.gitignore'), 'worktrees/\n.wavemill/\n');
    execFileSync('git', ['-C', main, 'add', '.']);
    execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'seed']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'task/demo', worktree]);
    mkdirSync(feature, { recursive: true });
    writeFileSync(join(feature, 'plan.md'), '# plan\n');
    writeFileSync(join(feature, '.review-result.json'), '{"stage":"review"}\n');
    writeFileSync(join(feature, '.coding-complete'), '');

    // No release list: evidence stays even though runtime output is discarded.
    discard('');
    assert.equal(existsSync(join(feature, 'plan.md')), true);
    assert.equal(existsSync(join(feature, '.coding-complete')), false);

    const list = join(root, 'release-list');
    writeFileSync(list, evidenceReleaseList(archiveTaskEvidence({ issueId: 'HOK-9503', slug: 'demo', repoDir: main, worktreeDir: worktree }, { warn() {} })));
    // Bytes written after the capture are not the archived bytes: retained.
    writeFileSync(join(feature, '.review-result.json'), '{"stage":"review","late":true}\n');
    discard(list);
    assert.equal(existsSync(join(feature, 'plan.md')), false);
    assert.equal(existsSync(join(feature, '.review-result.json')), true);
    assert.equal(readFileSync(join(main, '.wavemill/evals/artifacts/HOK-9503/plan.md'), 'utf8'), '# plan\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
