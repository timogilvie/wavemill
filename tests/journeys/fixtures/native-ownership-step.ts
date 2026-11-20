// protects: a fresh process can commit only the previous native process's verified mutations,
// including files a run_tests command created (HOK-3514), and cannot finish while any task path is dirty.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createApplyPatchTool } from '../../../shared/lib/native-agent/tools/apply-patch-tool.ts';
import { createCommandTools } from '../../../shared/lib/native-agent/tools/command-tools.ts';
import {
  createDiscardOwnedPathTool,
  createIntendedFileTracker,
  intendedFilesAfterToolCall,
} from '../../../shared/lib/native-agent/tools/intended-files.ts';
import { createGitAddTool, createGitCommitTool } from '../../../shared/lib/native-agent/tools/git.ts';
import { createCreateMarkerTool } from '../../../shared/lib/native-agent/tools/mutation-tools.ts';
const worktreePath = process.argv[3];
const feature = process.env.FEATURE_DIR!;
const tracker = createIntendedFileTracker({ worktreePath, taskId: process.env.WAVEMILL_ISSUE!, statePath: join(feature, '.native-intended-files.json') });
const runTests = createCommandTools(worktreePath).find((tool) => tool.metadata.name === 'run_tests')!;

/** One run_tests call wrapped the way the launcher wraps it: snapshot before, delta after. */
async function command(id: string, commandLine: string): Promise<void> {
  tracker.snapshotCommand(id);
  const result = await runTests.execute(id, { command: commandLine });
  assert.equal((result.details as { ok?: boolean })?.ok, true, `${commandLine}: ${result.content[0]?.text}`);
  await intendedFilesAfterToolCall({ toolCall: { name: 'run_tests', id }, result }, tracker);
}

const marker = () => createCreateMarkerTool(worktreePath).execute('marker', {
  path: `${relative(worktreePath, feature)}/.coding-complete`,
  content: JSON.stringify({ stage: 'coding', confidence: 'high' }),
});

if (process.argv[2] === 'mutate') {
  const oldText = readFileSync(join(worktreePath, 'journey-output.txt'), 'utf8');
  const result = await createApplyPatchTool(worktreePath).execute('patch', { patch: {
    version: 1, atomic: true, operations: [{ op: 'edit', path: 'journey-output.txt', oldText, newText: oldText + 'preserved native mutation\n' }],
  } });
  assert.equal(result.details?.ok, true);
  await intendedFilesAfterToolCall({ toolCall: { name: 'apply_patch' }, result }, tracker);
  // HOK-3454 shape: task output created by a command, never by a patch.
  await command('cp-fixture', 'cp journey-output.txt command-fixture.txt');
} else {
  assert.equal(tracker.isIntended('journey-output.txt'), true);
  assert.equal(tracker.isIntended('command-fixture.txt'), true, 'command output stays owned across processes');
  // HOK-3451 shape: command scratch below the root, out of the monitor's quarantine reach.
  mkdirSync(join(worktreePath, 'nested'), { recursive: true });
  await command('cp-scratch', 'cp journey-output.txt nested/scratch.txt');
  const refused = await marker();
  assert.equal(refused.details?.ok, false, 'the completion gate refuses a dirty tree');
  assert.match(refused.content[0]!.text, /command-fixture\.txt, journey-output\.txt, nested\/scratch\.txt/);
  const discarded = await createDiscardOwnedPathTool(tracker).execute('discard', { paths: ['nested/scratch.txt'] });
  assert.equal(discarded.details?.ok, true, discarded.content[0]?.text);
  const added = await createGitAddTool(worktreePath, { tracker }).execute('add', { paths: ['journey-output.txt', 'command-fixture.txt'] });
  assert.equal(added.details?.ok, true, added.content[0]?.text);
  const committed = await createGitCommitTool(worktreePath, { tracker }).execute('commit', { message: 'commit recovered native mutation' });
  assert.equal(committed.details?.ok, true);
  const accepted = await marker();
  assert.equal(accepted.details?.ok, true, accepted.content[0]?.text);
  console.log('native-ownership: marker-refused-then-clean');
}
