import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { buildGuard, readCodingRecoveryGuard } from './coding-recovery-guard.ts';

const tempDirs = new Set<string>();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function fixture() {
  const worktree = makeTempDir('recovery-wt-');
  const featureDir = path.join(worktree, 'features', 'slug');
  mkdirSync(featureDir, { recursive: true });
  return { worktree, featureDir };
}

describe('readCodingRecoveryGuard', () => {
  it('returns null when the instruction file is absent', () => {
    const { worktree, featureDir } = fixture();
    assert.equal(readCodingRecoveryGuard(featureDir, worktree), null);
  });

  it('parses dirty paths from bullets and still denies apply_patch', () => {
    const { worktree, featureDir } = fixture();
    writeFileSync(
      path.join(featureDir, '.coding-recovery-instruction.md'),
      'Your previous coding run wrote `.coding-complete` but left these paths uncommitted:\n\n'
      + '- `src/a.ts`\n- `scratch.txt`\n',
      'utf-8',
    );
    const guard = readCodingRecoveryGuard(featureDir, worktree);
    assert.ok(guard);
    assert.deepEqual(guard!.dirtyPaths, ['src/a.ts', 'scratch.txt']);
    const decision = guard!.evaluate({ name: 'apply_patch', args: { patch: '…' } });
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.match(decision.reason, /recovery_mode_denied/);
  });

  it('yields an empty dirtyPaths guard when parsing finds no bullets', () => {
    const { worktree, featureDir } = fixture();
    writeFileSync(path.join(featureDir, '.coding-recovery-instruction.md'), 'free prose, no bullets.\n', 'utf-8');
    const guard = readCodingRecoveryGuard(featureDir, worktree);
    assert.ok(guard);
    assert.deepEqual(guard!.dirtyPaths, []);
    assert.equal(guard!.evaluate({ name: 'apply_patch', args: {} }).allow, false);
  });
});

describe('CodingRecoveryGuard.evaluate', () => {
  const dirtyPaths = ['src/a.ts', 'scratch.txt'];

  function makeGuard() {
    const { worktree, featureDir } = fixture();
    return { worktree, featureDir, guard: buildGuard({ featureDir, worktreePath: worktree, dirtyPaths }) };
  }

  it('allows read-only tools', () => {
    const { guard } = makeGuard();
    for (const name of ['read_file', 'list_files', 'search_text', 'git_status', 'git_diff', 'git_diff_stat', 'git_log']) {
      assert.equal(guard.evaluate({ name, args: {} }).allow, true, name);
    }
  });

  it('allows git_commit unconditionally', () => {
    const { guard } = makeGuard();
    assert.equal(guard.evaluate({ name: 'git_commit', args: { message: 'wip' } }).allow, true);
  });

  it('allows git_add on listed paths and denies off-list paths', () => {
    const { guard } = makeGuard();
    assert.equal(guard.evaluate({ name: 'git_add', args: { paths: ['src/a.ts'] } }).allow, true);
    const bad = guard.evaluate({ name: 'git_add', args: { paths: ['other.ts'] } });
    assert.equal(bad.allow, false);
    if (!bad.allow) assert.match(bad.reason, /must be in the recovery list/);
  });

  it('allows run_tests "git checkout -- <listed>" and denies others', () => {
    const { guard } = makeGuard();
    assert.equal(
      guard.evaluate({ name: 'run_tests', args: { command: 'git checkout -- src/a.ts' } }).allow,
      true,
    );
    assert.equal(
      guard.evaluate({ name: 'run_tests', args: { command: 'git restore --staged -- scratch.txt' } }).allow,
      true,
    );
    const offList = guard.evaluate({ name: 'run_tests', args: { command: 'git checkout -- other.ts' } });
    assert.equal(offList.allow, false);
    if (!offList.allow) assert.match(offList.reason, /listed path/);

    const npmTest = guard.evaluate({ name: 'run_tests', args: { command: 'npm test' } });
    assert.equal(npmTest.allow, false);
    const nodeTest = guard.evaluate({ name: 'run_tests', args: { command: 'node --test x.ts' } });
    assert.equal(nodeTest.allow, false);
  });

  it('allows create_marker for the completion artifact and denies elsewhere', () => {
    const { worktree, featureDir, guard } = makeGuard();
    const okRel = path.relative(worktree, path.join(featureDir, '.coding-complete')).split(path.sep).join('/');
    assert.equal(guard.evaluate({ name: 'create_marker', args: { path: okRel } }).allow, true);
    assert.equal(guard.evaluate({ name: 'create_marker', args: { path: 'other.txt' } }).allow, false);
  });

  it('denies apply_patch and run_format in recovery mode', () => {
    const { guard } = makeGuard();
    assert.equal(guard.evaluate({ name: 'apply_patch', args: {} }).allow, false);
    assert.equal(guard.evaluate({ name: 'run_format', args: {} }).allow, false);
  });

  it('allows update_status', () => {
    const { guard } = makeGuard();
    assert.equal(guard.evaluate({ name: 'update_status', args: { text: 'ok' } }).allow, true);
  });
});
