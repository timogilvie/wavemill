// HOK-3151 Phase 3: fork-child.ts — child process for crash harness.
// Opens storage, runs up to a crash point (F1/F2/F3) or resumes.
//
// Env knobs:
//   HOK3151_DB_PATH         absolute SQLite path
//   HOK3151_WORKTREE        fixture worktree dir
//   HOK3151_FEATURE_DIR     features/<slug> dir
//   HOK3151_READY_FILE      file to write before blocking
//   HOK3151_CRASH_POINT     F1 | F2 | F3 | none
//   HOK3151_PARENT_CONV_ID  parent conversation id
//   HOK3151_FORK_ENTRY_ID   entry id to fork from
//   HOK3151_FORK_COMMIT     git commit SHA
//   HOK3151_PAIR_ID         pair id for idempotence
//   HOK3151_MODE            fresh | resume

import { writeFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

import { forkChallengePair, materializeArmWorktree } from '../src/fork-pair.ts';
import { installDurableFaux, type FauxStep } from '../src/faux-script.ts';
import { patchState, initializeConversationDocs } from '../src/fork-docs.ts';
import { fireAndBlock } from '../src/crash-points.ts';

const FAUX_SCRIPT: FauxStep[] = [
  { kind: 'tool', name: 'read_file', args: { path: 'src/index.ts' } },
  { kind: 'text', text: 'done' },
];

async function main() {
  const dbPath = required('HOK3151_DB_PATH');
  const worktree = required('HOK3151_WORKTREE');
  const featureDir = required('HOK3151_FEATURE_DIR');
  const readyFile = required('HOK3151_READY_FILE');
  const crashPoint = process.env.HOK3151_CRASH_POINT ?? 'none';
  const parentConvId = required('HOK3151_PARENT_CONV_ID');
  const forkEntryId = required('HOK3151_FORK_ENTRY_ID');
  const forkCommit = required('HOK3151_FORK_COMMIT');
  const pairId = required('HOK3151_PAIR_ID');
  const mode = process.env.HOK3151_MODE ?? 'fresh';

  const models = createModels();
  installDurableFaux(models, FAUX_SCRIPT, 'faux/primary');
  installDurableFaux(models, FAUX_SCRIPT, 'faux/challenger');

  const registry = createRegistry();
  const storage = await openNodeSqliteStorage(dbPath);

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree }),
      conversationCreated: (tx, convId) => {
        initializeConversationDocs(tx, convId);
        // F1: crash inside the creating commit
        if (crashPoint === 'F1') {
          void fireAndBlock(readyFile, 'F1', 5000);
        }
      },
    },
    BACKGROUND_CONTEXT,
  );

  if (mode === 'resume') {
    harness.resume();
    const out = { mode: 'resume', status: 'resumed' };
    console.log(JSON.stringify(out));
    await harness.close(BACKGROUND_CONTEXT);
    return;
  }

  // Fresh mode: create the pair
  const parent = await harness.conversation(parentConvId);
  const primaryWt = `${worktree}-primary`;
  const challengerWt = `${worktree}-challenger`;

  const pairResult = await forkChallengePair(harness, {
    parentConvId,
    atEntryId: forkEntryId,
    pairId,
    forkCommit,
    primary: {
      model: 'faux/primary',
      cwd: primaryWt,
    },
    challenger: {
      model: 'faux/challenger',
      cwd: challengerWt,
    },
  });

  // F2: crash after fork commit, before worktree
  if (crashPoint === 'F2') {
    await fireAndBlock(readyFile, 'F2', 5000);
  }

  // Materialize worktrees
  const primaryConv = await harness.conversation(pairResult.primaryConvId);
  const challengerConv = await harness.conversation(pairResult.challengerConvId);

  await materializeArmWorktree(primaryConv, worktree, forkCommit, primaryWt);
  await materializeArmWorktree(challengerConv, worktree, forkCommit, challengerWt);

  // F3: crash after worktree, during first request
  if (crashPoint === 'F3') {
    await fireAndBlock(readyFile, 'F3', 5000);
  }

  // Run challenger to completion
  const sub = await challengerConv.submit(
    { type: 'input', content: 'implement', requestId: 'challenger-1' },
    BACKGROUND_CONTEXT,
  );
  await sub.wait(BACKGROUND_CONTEXT);

  const out = {
    mode: 'fresh',
    primaryConvId: pairResult.primaryConvId,
    challengerConvId: pairResult.challengerConvId,
    status: 'settled',
  };
  console.log(JSON.stringify(out));
  await harness.close(BACKGROUND_CONTEXT);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

main().catch((err) => {
  console.error('fork-child failed:', err);
  process.exit(1);
});
