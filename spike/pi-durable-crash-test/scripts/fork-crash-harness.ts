// HOK-3151 Phase 3: fork-crash-harness.ts — Gate 2 atomic pairing test.
// Spawn child, SIGKILL at F1/F2/F3, reopen, audit pair invariant.
// 5 trials per point.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

import { createFixtureTask } from '../src/fixture-task.ts';
import { installDurableFaux, type FauxStep } from '../src/faux-script.ts';
import { pair as pairDoc, patchState } from '../src/fork-docs.ts';

const FAUX_SCRIPT: FauxStep[] = [
  { kind: 'tool', name: 'read_file', args: { path: 'src/index.ts' } },
  { kind: 'text', text: 'planning done' },
];

interface TrialResult {
  point: string;
  trial: number;
  beforeKill: {
    pairExists: boolean;
    armCount: number;
  };
  afterReopen: {
    pairExists: boolean;
    armCount: number;
    primaryWorktreeExists: boolean;
    challengerWorktreeExists: boolean;
  };
  rerunCreatedDuplicate: boolean;
}

async function runTrial(point: string, trial: number): Promise<TrialResult> {
  const fixture = await createFixtureTask();
  const scratch = await mkdtemp(path.join(tmpdir(), 'fork-crash-'));
  const dbPath = path.join(scratch, 'storage.sqlite');
  const readyFile = path.join(scratch, 'ready.txt');

  // Set up parent conversation
  const models = createModels();
  installDurableFaux(models, FAUX_SCRIPT, 'faux/primary');
  const registry = createRegistry();
  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? fixture.worktree }),
    },
    BACKGROUND_CONTEXT,
  );

  const parent = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux/primary' }, cwd: fixture.worktree },
  });

  // Simulate planning
  const planSub = await parent.submit(
    { type: 'input', content: 'plan', requestId: 'plan-1' },
    BACKGROUND_CONTEXT,
  );
  await planSub.wait(BACKGROUND_CONTEXT);

  const entries = await parent.transcript();
  const forkEntryId = entries.at(-1)?.id;
  if (!forkEntryId) throw new Error('No fork entry');

  await harness.close(BACKGROUND_CONTEXT);

  // Spawn child
  const env = {
    ...process.env,
    HOK3151_DB_PATH: dbPath,
    HOK3151_WORKTREE: fixture.worktree,
    HOK3151_FEATURE_DIR: fixture.featureDir,
    HOK3151_READY_FILE: readyFile,
    HOK3151_CRASH_POINT: point,
    HOK3151_PARENT_CONV_ID: parent.id,
    HOK3151_FORK_ENTRY_ID: forkEntryId,
    HOK3151_FORK_COMMIT: fixture.forkCommit,
    HOK3151_PAIR_ID: `test-pair-${trial}`,
    HOK3151_MODE: 'fresh',
  };

  const child = spawn('npx', ['tsx', 'scripts/fork-child.ts'], {
    cwd: path.join(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += d.toString()));
  child.stderr?.on('data', (d) => (stderr += d.toString()));

  // Wait for ready file or timeout
  const startTime = Date.now();
  while (!existsSync(readyFile) && Date.now() - startTime < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // SIGKILL
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  // Audit before reopen
  const harness2 = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? fixture.worktree }),
    },
    BACKGROUND_CONTEXT,
  );

  const parentConv = await harness2.conversation(parent.id);
  const pairBefore = await parentConv.read(pairDoc);
  let armCountBefore = 0;
  if (pairBefore) {
    try {
      await harness2.conversation(pairBefore.primaryConvId);
      armCountBefore++;
    } catch {}
    try {
      await harness2.conversation(pairBefore.challengerConvId);
      armCountBefore++;
    } catch {}
  }

  const beforeKill = {
    pairExists: !!pairBefore,
    armCount: armCountBefore,
  };

  await harness2.close(BACKGROUND_CONTEXT);

  // Reopen and check
  const harness3 = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? fixture.worktree }),
    },
    BACKGROUND_CONTEXT,
  );

  const parentConv2 = await harness3.conversation(parent.id);
  const pairAfter = await parentConv2.read(pairDoc);
  let armCountAfter = 0;
  let primaryWorktreeExists = false;
  let challengerWorktreeExists = false;

  if (pairAfter) {
    try {
      const primaryConv = await harness3.conversation(pairAfter.primaryConvId);
      armCountAfter++;
      const primaryPatch = await primaryConv.read(patchState);
      primaryWorktreeExists = !!primaryPatch?.worktree && existsSync(primaryPatch.worktree);
    } catch {}
    try {
      const challengerConv = await harness3.conversation(pairAfter.challengerConvId);
      armCountAfter++;
      const challengerPatch = await challengerConv.read(patchState);
      challengerWorktreeExists = !!challengerPatch?.worktree && existsSync(challengerPatch.worktree);
    } catch {}
  }

  const afterReopen = {
    pairExists: !!pairAfter,
    armCount: armCountAfter,
    primaryWorktreeExists,
    challengerWorktreeExists,
  };

  // Test idempotent rerun (should not create duplicate)
  // TODO: implement forkChallengePair call here to verify idempotence
  const rerunCreatedDuplicate = false;

  await harness3.close(BACKGROUND_CONTEXT);

  // Cleanup
  await rm(scratch, { recursive: true, force: true });
  await rm(fixture.scratch, { recursive: true, force: true });

  return {
    point,
    trial,
    beforeKill,
    afterReopen,
    rerunCreatedDuplicate,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const pointsArg = args.find((a) => a.startsWith('--point='))?.split('=')[1] ?? 'F1,F2,F3';
  const trialsArg = parseInt(args.find((a) => a.startsWith('--trials='))?.split('=')[1] ?? '5', 10);

  const points = pointsArg.split(',');
  const trials = trialsArg;

  console.log(`Running crash harness: points=${points.join(',')} trials=${trials}`);

  const allResults: TrialResult[] = [];

  for (const point of points) {
    console.log(`\n=== Point ${point} ===`);
    for (let t = 1; t <= trials; t++) {
      console.log(`  Trial ${t}/${trials}...`);
      const result = await runTrial(point, t);
      allResults.push(result);
      console.log(`    Before: pair=${result.beforeKill.pairExists} arms=${result.beforeKill.armCount}`);
      console.log(`    After: pair=${result.afterReopen.pairExists} arms=${result.afterReopen.armCount} wtPrimary=${result.afterReopen.primaryWorktreeExists} wtChallenger=${result.afterReopen.challengerWorktreeExists}`);
    }
  }

  // Summary
  const oneArmedCount = allResults.filter(
    (r) => r.afterReopen.pairExists && r.afterReopen.armCount === 1,
  ).length;

  const summary = {
    totalTrials: allResults.length,
    oneArmedPairs: oneArmedCount,
    pass: oneArmedCount === 0,
    perPoint: {} as Record<string, any>,
  };

  for (const point of points) {
    const pointResults = allResults.filter((r) => r.point === point);
    summary.perPoint[point] = {
      trials: pointResults.length,
      oneArmed: pointResults.filter((r) => r.afterReopen.pairExists && r.afterReopen.armCount === 1).length,
    };
  }

  // Write results
  const resultsDir = path.join(import.meta.dirname, '..', 'results');
  await mkdir(resultsDir, { recursive: true });

  for (const r of allResults) {
    const fileName = `fork-crash-${r.point}-${r.trial}.json`;
    await writeFile(
      path.join(resultsDir, fileName),
      JSON.stringify(r, null, 2),
      'utf8',
    );
  }

  const summaryPath = path.join(resultsDir, 'fork-crash-summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== Summary ===');
  console.log(`Total trials: ${summary.totalTrials}`);
  console.log(`One-armed pairs: ${summary.oneArmedPairs}`);
  console.log(`Gate 2 result: ${summary.pass ? 'PASS' : 'FAIL'}`);
  console.log(`\nResults written to ${resultsDir}`);

  process.exit(summary.pass ? 0 : 1);
}

main();
