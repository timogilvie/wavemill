import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { filterMillOwnedDirtyStatus, MILL_OWNED_PATHS, millOwnedEntry, renderMillOwnedShell } from './mill-owned-paths.ts';

test('declares telemetry, evidence and runtime paths and leaves task context visible', () => {
  assert.equal(millOwnedEntry('.wavemill/task-size-estimates.jsonl')?.disposition, 'telemetry');
  assert.equal(millOwnedEntry('features/task/.review-result.json')?.disposition, 'evidence');
  assert.equal(millOwnedEntry('.wavemill/audits/report.json')?.disposition, 'runtime');
  assert.equal(millOwnedEntry('.wavemill/context/task-notes.md'), undefined);
  assert.equal(millOwnedEntry('.wavemill/unknown.json'), undefined);
  assert.ok(MILL_OWNED_PATHS.length > 10);
});

test('dirty status drops only untracked declared output', () => {
  assert.deepEqual(filterMillOwnedDirtyStatus([
    '?? .wavemill/task-size-estimates.jsonl',
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
      '.wavemill/task-size-estimates.jsonl', '.wavemill/audits/report.json',
      'features/a/.coding-complete', '.wavemill/context/task.md', '.wavemill/unknown',
      'M  .wavemill/task-size-estimates.jsonl', '?? .wavemill/task-size-estimates.jsonl',
    ];
    const shell = `source ${JSON.stringify(shellFile)}; for value in "$@"; do if [[ "$value" == *'  '* || "$value" == '?? '* ]]; then wavemill_mill_owned_dirty_line "$value" && echo 1 || echo 0; else wavemill_mill_owned_path "$value" && echo 1 || echo 0; fi; done`;
    const result = execFileSync('bash', ['-c', shell, 'bash', ...cases], { encoding: 'utf8' }).trim().split('\n');
    const expected = cases.map(value => (value.startsWith('?? ') || value.startsWith('M  '))
      ? Number(value.startsWith('?? ') && !!millOwnedEntry(value.slice(3)))
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
