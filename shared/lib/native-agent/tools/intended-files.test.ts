import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCodingArtifacts } from '../coding-artifacts.ts';
import {
  createDiscardOwnedPathTool,
  createIntendedFileTracker,
  intendedFilesAfterToolCall,
  type DiscardOwnedPathDetails,
} from './intended-files.ts';

function makeRepo(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  writeFileSync(join(root, 'preexisting.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const context = { worktreePath: root, taskId: 'HOK-3514', statePath: join(root, '.git', 'ownership.json') };
  return { root, git, context };
}

/** Run `mutate` between a command snapshot and its after-call delta, the way the launcher does. */
async function runCommand(tracker: ReturnType<typeof createIntendedFileTracker>, id: string, mutate: () => void) {
  tracker.snapshotCommand(id);
  mutate();
  await intendedFilesAfterToolCall({ toolCall: { name: 'run_tests', id }, result: { details: { ok: true } } }, tracker);
}

describe('intended file tracker', () => {
  it('normalizes, dedupes, and queries intended paths', () => {
    const tracker = createIntendedFileTracker();

    tracker.record(['src/app.ts', './src/app.ts', 'src//nested/file.ts', '../outside.ts', '']);

    assert.deepEqual(tracker.list(), ['src/app.ts', 'src/nested/file.ts']);
    assert.equal(tracker.isIntended('src/app.ts'), true);
    assert.equal(tracker.isIntended('./src/app.ts'), true);
    assert.equal(tracker.isIntended('src\\nested\\file.ts'), true);
    assert.equal(tracker.isIntended('../outside.ts'), false);
  });

  it('records successful mutation outputs through the after-tool-call hook', async () => {
    const tracker = createIntendedFileTracker();

    await intendedFilesAfterToolCall(
      {
        toolCall: { name: 'apply_patch' },
        result: {
          details: {
            ok: true,
            tool: 'apply_patch',
            atomic: true,
            appliedOperations: 1,
            changedFiles: ['src/app.ts'],
            fileChanges: [{ path: 'src/app.ts', linesAdded: 1, linesRemoved: 0 }],
            linesAdded: 1,
            linesRemoved: 0,
          },
        },
      },
      tracker,
    );

    await intendedFilesAfterToolCall(
      {
        toolCall: { name: 'write_artifact' },
        result: {
          details: {
            ok: true,
            tool: 'write_artifact',
            resolvedPath: 'features/demo/output.json',
            bytesWritten: 12,
          },
        },
      },
      tracker,
    );

    await intendedFilesAfterToolCall(
      {
        toolCall: { name: 'create_marker' },
        result: {
          details: {
            ok: false,
            tool: 'create_marker',
            error: 'io_error',
            message: 'failed',
          },
        },
      },
      tracker,
    );

    assert.deepEqual(tracker.list(), ['features/demo/output.json', 'src/app.ts']);
  });

  it('tracks commit count for CodingArtifacts', () => {
    const tracker = createIntendedFileTracker();

    assert.equal(tracker.recordCommit(), 1);
    assert.equal(tracker.recordCommit(), 2);
    assert.equal(tracker.commitCount, 2);

    const validation = validateCodingArtifacts({
      type: 'coding',
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 1,
      commitCount: tracker.commitCount,
    });

    assert.equal(validation.ok, true);
  });
});

// protects: native process replacement retains only verified task-owned mutations.
it('recovers content-bound ownership and refuses unrelated, changed, stale and escaping files', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-ownership-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'owned.txt'), 'base'); git('add', 'owned.txt'); git('commit', '-qm', 'base');
    const context = { worktreePath: root, taskId: 'HOK-3255', statePath: join(root, '.git', 'ownership.json') };
    const original = createIntendedFileTracker(context);
    writeFileSync(join(root, 'owned.txt'), 'native edit');
    writeFileSync(join(root, 'unrelated.txt'), 'operator edit');
    original.record(['owned.txt']);
    const replacement = createIntendedFileTracker(context);
    assert.equal(replacement.isIntended('owned.txt'), true);
    assert.equal(replacement.isIntended('unrelated.txt'), false);
    assert.equal(createIntendedFileTracker({ ...context, taskId: 'other' }).isIntended('owned.txt'), false);
    writeFileSync(join(root, 'owned.txt'), 'operator changed the native edit');
    assert.equal(replacement.isIntended('owned.txt'), false);
    assert.equal(createIntendedFileTracker(context).isIntended('owned.txt'), false);
    writeFileSync(join(root, 'owned.txt'), 'native edit');
    git('add', 'owned.txt'); git('commit', '-qm', 'changed head');
    assert.equal(createIntendedFileTracker(context).isIntended('owned.txt'), false);
    symlinkSync('/missing/outside', join(root, 'escape'));
    replacement.record(['escape', '../outside']);
    assert.equal(replacement.isIntended('escape'), false);
    writeFileSync(context.statePath, '{broken');
    assert.deepEqual(createIntendedFileTracker(context).list(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// protects: HOK-3514 — files a run_tests command creates or changes are owned, so they can be committed or discarded.
describe('command provenance and owned-path discard (HOK-3514)', () => {
  it('owns command-created untracked and command-modified tracked output, never untouched pre-existing dirt', async () => {
    const { root, context } = makeRepo('native-command-delta-');
    try {
      writeFileSync(join(root, 'preexisting.txt'), 'operator dirt\n');
      const tracker = createIntendedFileTracker(context);
      await runCommand(tracker, 'call-1', () => {
        mkdirSync(join(root, 'shared/lib'), { recursive: true });
        writeFileSync(join(root, 'shared/lib/scratch.txt'), 'cp output\n');
        writeFileSync(join(root, 'tracked.txt'), 'command changed\n');
      });
      assert.equal(tracker.isIntended('shared/lib/scratch.txt'), true);
      assert.equal(tracker.isIntended('tracked.txt'), true);
      assert.equal(tracker.isIntended('preexisting.txt'), false);
      // Ownership survives a recovery relaunch at the same head.
      assert.equal(createIntendedFileTracker(context).isIntended('shared/lib/scratch.txt'), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a delta without a snapshot claims nothing', async () => {
    const { root, context } = makeRepo('native-command-nosnap-');
    try {
      const tracker = createIntendedFileTracker(context);
      writeFileSync(join(root, 'untracked.txt'), 'x');
      await intendedFilesAfterToolCall({ toolCall: { name: 'run_tests', id: 'never-snapshotted' }, result: { details: {} } }, tracker);
      assert.equal(tracker.isIntended('untracked.txt'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('discards owned paths: unlinks untracked, restores tracked, reports already-clean', async () => {
    const { root, git, context } = makeRepo('native-discard-');
    try {
      const tracker = createIntendedFileTracker(context);
      await runCommand(tracker, 'call-1', () => {
        writeFileSync(join(root, 'scratch.txt'), 'scratch\n');
        writeFileSync(join(root, 'tracked.txt'), 'changed\n');
      });
      git('add', 'tracked.txt');
      assert.deepEqual(tracker.discard('scratch.txt'), { ok: true, path: 'scratch.txt', action: 'unlinked' });
      assert.equal(existsSync(join(root, 'scratch.txt')), false);
      assert.deepEqual(tracker.discard('tracked.txt'), { ok: true, path: 'tracked.txt', action: 'restored' });
      assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'base\n');
      assert.deepEqual(tracker.discard('scratch.txt'), { ok: true, path: 'scratch.txt', action: 'already_clean' });
      assert.equal(git('status', '--porcelain'), '');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses unowned, changed-after-record, escaping and symlinked paths', async () => {
    const { root, context } = makeRepo('native-discard-refuse-');
    try {
      const tracker = createIntendedFileTracker(context);
      writeFileSync(join(root, 'preexisting.txt'), 'operator dirt\n');
      await runCommand(tracker, 'call-1', () => {
        writeFileSync(join(root, 'owned.txt'), 'v1\n');
        symlinkSync('/etc/hosts', join(root, 'link'));
      });
      writeFileSync(join(root, 'owned.txt'), 'changed after record\n');
      for (const candidate of ['preexisting.txt', 'owned.txt', 'link']) {
        const outcome = tracker.discard(candidate);
        assert.equal(outcome.ok, false, candidate);
        if (!outcome.ok) assert.equal(outcome.reason, 'not_owned', candidate);
      }
      const escape = tracker.discard('../outside.txt');
      assert.equal(escape.ok, false);
      if (!escape.ok) assert.equal(escape.reason, 'invalid_path');
      assert.equal(readFileSync(join(root, 'preexisting.txt'), 'utf8'), 'operator dirt\n');
      assert.equal(existsSync(join(root, 'owned.txt')), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('discard_owned_path reports refusals as a failed tool result', async () => {
    const { root, context } = makeRepo('native-discard-tool-');
    try {
      const tracker = createIntendedFileTracker(context);
      await runCommand(tracker, 'call-1', () => writeFileSync(join(root, 'scratch.txt'), 'x'));
      writeFileSync(join(root, 'preexisting.txt'), 'operator dirt\n');
      const tool = createDiscardOwnedPathTool(tracker);
      const ok = await tool.execute('d1', { paths: ['scratch.txt'] });
      assert.equal((ok.details as DiscardOwnedPathDetails).ok, true);
      const refused = await tool.execute('d2', { paths: ['preexisting.txt'] });
      const details = refused.details as DiscardOwnedPathDetails;
      assert.equal(details.ok, false);
      assert.match(refused.content[0]!.text, /preexisting\.txt: refused \(not_owned\)/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
