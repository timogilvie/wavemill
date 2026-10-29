import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCodingArtifacts } from '../coding-artifacts.ts';
import { createIntendedFileTracker, intendedFilesAfterToolCall } from './intended-files.ts';

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
