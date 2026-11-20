import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  const featureDir = path.join(worktree, 'features', 'slug');
  mkdirSync(featureDir, { recursive: true });
  return { worktree, featureDir };
}

function writeInstruction(featureDir: string): void {
  writeFileSync(
    path.join(featureDir, '.coding-recovery-instruction.md'),
    'Your previous coding run wrote `.coding-complete` but left these paths uncommitted:\n\n- `stale.ts`\n',
    'utf-8',
  );
}

describe('readCodingRecoveryGuard', () => {
  it('returns null when the instruction file is absent', () => {
    const { worktree, featureDir } = fixture();
    assert.equal(readCodingRecoveryGuard(featureDir, worktree), null);
  });

  it('reads dirty paths from the worktree, not from the instruction text', () => {
    const { worktree, featureDir } = fixture();
    writeInstruction(featureDir);
    mkdirSync(path.join(worktree, 'shared/lib'), { recursive: true });
    writeFileSync(path.join(worktree, 'shared/lib/scratch.txt'), 'scratch\n');
    const guard = readCodingRecoveryGuard(featureDir, worktree);
    assert.ok(guard);
    // The instruction names `stale.ts`; only the real dirt is reported, and
    // the instruction file itself is Wavemill-owned feature metadata.
    assert.deepEqual(guard!.dirtyPaths, ['shared/lib/scratch.txt']);
    const decision = guard!.evaluate({ name: 'apply_patch', args: { patch: '…' } });
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.match(decision.reason, /recovery_mode_denied/);
  });
});

describe('CodingRecoveryGuard.evaluate', () => {
  function makeGuard() {
    const { worktree, featureDir } = fixture();
    return { worktree, featureDir, guard: buildGuard({ featureDir, worktreePath: worktree, dirtyPaths: ['a.ts'] }) };
  }

  it('allows read-only tools', () => {
    const { guard } = makeGuard();
    for (const name of ['read_file', 'list_files', 'search_text', 'git_status', 'git_diff', 'git_diff_stat', 'git_log']) {
      assert.equal(guard.evaluate({ name, args: {} }).allow, true, name);
    }
  });

  it('delegates commit and discard to the tracker-backed tools for any path', () => {
    const { guard } = makeGuard();
    // Ownership is decided by the intended-file tracker inside these tools,
    // so the guard never second-guesses the path list.
    assert.equal(guard.evaluate({ name: 'git_add', args: { paths: ['not-listed.ts'] } }).allow, true);
    assert.equal(guard.evaluate({ name: 'git_commit', args: { message: 'wip' } }).allow, true);
    assert.equal(guard.evaluate({ name: 'discard_owned_path', args: { paths: ['scratch.txt'] } }).allow, true);
  });

  it('denies every command tool, including git and rm recipes', () => {
    const { guard } = makeGuard();
    for (const command of ['git checkout -- a.ts', 'git restore a.ts', 'rm scratch.txt', 'npm test']) {
      const decision = guard.evaluate({ name: 'run_tests', args: { command } });
      assert.equal(decision.allow, false, command);
      if (!decision.allow) assert.match(decision.reason, /discard_owned_path/);
    }
    assert.equal(guard.evaluate({ name: 'run_format', args: { command: 'prettier -w a.ts' } }).allow, false);
  });

  it('allows completion markers and denies other whole-file writes', () => {
    const { guard } = makeGuard();
    assert.equal(guard.evaluate({ name: 'create_marker', args: { path: 'features/slug/.coding-complete' } }).allow, true);
    assert.equal(guard.evaluate({ name: 'write_artifact', args: { path: 'features/slug/.coding-blocked-completion.json' } }).allow, true);
    assert.equal(guard.evaluate({ name: 'create_marker', args: { path: 'features/slug/plan.md' } }).allow, false);
    assert.equal(guard.evaluate({ name: 'create_marker', args: { path: '../outside/.coding-complete' } }).allow, false);
  });

  it('denies apply_patch and unknown tools', () => {
    const { guard } = makeGuard();
    assert.equal(guard.evaluate({ name: 'apply_patch', args: {} }).allow, false);
    assert.equal(guard.evaluate({ name: 'mystery_tool', args: {} }).allow, false);
  });
});
