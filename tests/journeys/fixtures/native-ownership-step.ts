// protects: a fresh process can commit only the previous native process's verified mutations.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplyPatchTool } from '../../../shared/lib/native-agent/tools/apply-patch-tool.ts';
import { createIntendedFileTracker, intendedFilesAfterToolCall } from '../../../shared/lib/native-agent/tools/intended-files.ts';
import { createGitAddTool, createGitCommitTool } from '../../../shared/lib/native-agent/tools/git.ts';
const worktreePath = process.argv[3];
const feature = process.env.FEATURE_DIR!;
const tracker = createIntendedFileTracker({ worktreePath, taskId: process.env.WAVEMILL_ISSUE!, statePath: join(feature, '.native-intended-files.json') });
if (process.argv[2] === 'mutate') {
  const oldText = readFileSync(join(worktreePath, 'journey-output.txt'), 'utf8');
  const result = await createApplyPatchTool(worktreePath).execute('patch', { patch: {
    version: 1, atomic: true, operations: [{ op: 'edit', path: 'journey-output.txt', oldText, newText: oldText + 'preserved native mutation\n' }],
  } });
  assert.equal(result.details?.ok, true);
  await intendedFilesAfterToolCall({ toolCall: { name: 'apply_patch' }, result }, tracker);
} else {
  assert.equal(tracker.isIntended('journey-output.txt'), true);
  const added = await createGitAddTool(worktreePath, { tracker }).execute('add', { paths: ['journey-output.txt'] });
  assert.equal(added.details?.ok, true);
  const committed = await createGitCommitTool(worktreePath, { tracker }).execute('commit', { message: 'commit recovered native mutation' });
  assert.equal(committed.details?.ok, true);
  writeFileSync(join(feature, '.coding-complete'), JSON.stringify({ stage: 'coding', confidence: 'high', commit: committed.details?.ok ? committed.details.oid : '' }));
}
