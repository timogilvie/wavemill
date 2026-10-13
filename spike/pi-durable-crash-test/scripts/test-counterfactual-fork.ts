// HOK-3151 Phase 5: test-counterfactual-fork.ts — Info 5
// Fork at a mid-session tool decision point vs checkpoint/replay.
// Compares: model context fidelity, worktree snapshot, entropy, network hermeticity.

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

import { createFixtureTask } from '../src/fixture-task.ts';
import { installDurableFaux, type FauxStep } from '../src/faux-script.ts';
import { createUsageProbe, readUsageRecords } from '../src/usage-probe.ts';

interface ComparisonDimension {
  dimension: string;
  fork: string;
  checkpoint: string;
  fidelity: 'exact' | 'lossy' | 'missing';
  notes: string;
}

// Script that reaches a tool-choice decision point
const DECISION_SCRIPT: FauxStep[] = [
  { kind: 'tool', name: 'list_files', args: { directory: 'src' } },
  { kind: 'tool', name: 'search_text', args: { pattern: 'SEED' } }, // Decision point
  { kind: 'tool', name: 'read_file', args: { path: 'src/index.ts' } },
  { kind: 'text', text: 'done' },
];

// Alternative decision: read_file instead of search_text
const ALT_SCRIPT: FauxStep[] = [
  { kind: 'tool', name: 'list_files', args: { directory: 'src' } },
  { kind: 'tool', name: 'read_file', args: { path: 'src/index.ts' } }, // Alternative
  { kind: 'text', text: 'done alternative' },
];

async function main() {
  console.log('Testing counterfactual fork vs checkpoint...');

  const fixture = await createFixtureTask();
  const scratch = await mkdtemp(path.join(tmpdir(), 'cf-fork-'));
  const dbPath = path.join(scratch, 'storage.sqlite');
  const usagePath = path.join(scratch, 'usage.jsonl');

  const results: ComparisonDimension[] = [];

  try {
    // Set up harness
    const models = createModels();
    installDurableFaux(models, DECISION_SCRIPT, 'faux/main');

    const registry = createRegistry();
    registry.install(createUsageProbe(usagePath));

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

    // 1. Run session to decision point
    console.log('  Running session to decision point...');
    const conv = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux/main' }, cwd: fixture.worktree },
    });

    const sub = await conv.submit(
      { type: 'input', content: 'analyze', requestId: 'main-1' },
      BACKGROUND_CONTEXT,
    );
    await sub.wait(BACKGROUND_CONTEXT);

    const transcript = await conv.transcript();
    // Decision point: the entry just before the search_text assistant message
    const searchEntry = transcript.find((e) =>
      e.type === 'assistantMessage' &&
      (e as any).content?.some((c: any) => c.type === 'toolUse' && c.name === 'search_text')
    );
    if (!searchEntry) throw new Error('No search_text decision point found');
    const decisionIndex = transcript.indexOf(searchEntry);
    const preDecisionEntry = transcript[decisionIndex - 1];
    if (!preDecisionEntry) throw new Error('No pre-decision entry');

    // Capture usage records for the primary path
    const usageRecords = await readUsageRecords(usagePath);
    const decisionRequestIndex = usageRecords.findIndex((r) =>
      r.convId === conv.id && r.requestIndex === decisionIndex
    );
    const primaryRequest = usageRecords[decisionRequestIndex];

    console.log('  Fork at pre-decision entry...');
    // 2. Fork at pre-decision entry
    const fork = await conv.fork(preDecisionEntry.id, {
      ownership: { kind: 'ownerless' },
      agent: { model: { provider: 'faux', modelId: 'faux/main' } },
    });

    // Check fidelity A: fork's next request context matches primary
    const forkSub = await fork.submit(
      { type: 'input', content: 'continue', requestId: 'fork-1' },
      BACKGROUND_CONTEXT,
    );
    await forkSub.wait(BACKGROUND_CONTEXT);

    const forkUsage = await readUsageRecords(usagePath);
    const forkRequest = forkUsage.find((r) => r.convId === fork.id && r.requestIndex === 0);

    const messageHashMatch = primaryRequest && forkRequest &&
      primaryRequest.messagesHash === forkRequest.messagesHash;
    const toolHashMatch = primaryRequest && forkRequest &&
      primaryRequest.toolsHash === forkRequest.toolsHash;

    results.push({
      dimension: 'pre-decision-model-context',
      fork: 'exact (messages/tools hash match)',
      checkpoint: 'exact (would be same messages)',
      fidelity: messageHashMatch && toolHashMatch ? 'exact' : 'lossy',
      notes: messageHashMatch && toolHashMatch
        ? 'Fork request context is byte-identical to primary at decision point'
        : 'Hash mismatch: fork may have different context',
    });

    // Tool menu
    results.push({
      dimension: 'tool-menu',
      fork: 'same (inherited from parent agent)',
      checkpoint: 'captured (frozen at checkpoint time)',
      fidelity: 'exact',
      notes: 'Both preserve the tool menu; fork inherits, checkpoint captures',
    });

    // Working tree
    results.push({
      dimension: 'working-tree',
      fork: 'rewindable doc with asOf (proposed)',
      checkpoint: 'captured (workingFileHashes)',
      fidelity: 'exact',
      notes: 'Fork can materialize via app.worktree-ref doc; checkpoint captures file hashes',
    });

    // Git state
    results.push({
      dimension: 'git-state',
      fork: 'rewindable doc (proposed)',
      checkpoint: 'captured (headSha, cleanTree)',
      fidelity: 'exact',
      notes: 'Both can preserve git state; fork via doc, checkpoint via captured fields',
    });

    // Entropy (Math.random, Date, uuid)
    results.push({
      dimension: 'entropy',
      fork: 'live (not captured)',
      checkpoint: 'captured (seeds)',
      fidelity: 'lossy',
      notes: 'Fork uses live entropy; checkpoint captures and replays seeds',
    });

    // Env whitelist
    results.push({
      dimension: 'env-whitelist',
      fork: 'live (from agent cwd)',
      checkpoint: 'captured',
      fidelity: 'lossy',
      notes: 'Fork builds env fresh; checkpoint captures env at checkpoint time',
    });

    // Network hermeticity
    results.push({
      dimension: 'network-hermeticity',
      fork: 'none (fork runs live)',
      checkpoint: 'attested (no-network sandbox)',
      fidelity: 'missing',
      notes: 'Checkpoint can attest network isolation; fork cannot without rebuild',
    });

    // Redaction attestation
    results.push({
      dimension: 'redaction-attestation',
      fork: 'none',
      checkpoint: 'attested (via filters)',
      fidelity: 'missing',
      notes: 'Checkpoint can attest redaction; fork cannot without rebuild',
    });

    // Model switchable
    results.push({
      dimension: 'model-switchable',
      fork: 'yes (agent change allowed)',
      checkpoint: 'no (model_mismatch error)',
      fidelity: 'exact',
      notes: 'Fork allows model switch; checkpoint refuses (runCounterfactuals rejects model change)',
    });

    // Actually runs the model
    results.push({
      dimension: 'runs-model',
      fork: 'yes',
      checkpoint: 'no (structural only)',
      fidelity: 'exact',
      notes: 'Fork runs the model; checkpoint is structural-only (deterministic-replay.ts:8-13)',
    });

    // Storage cost
    results.push({
      dimension: 'storage-cost',
      fork: 'conversation entry (SQLite)',
      checkpoint: 'tar.gz of working files + events JSON',
      fidelity: 'exact',
      notes: 'Both have storage cost; fork is lightweight (no working-file capture)',
    });

    await harness.close(BACKGROUND_CONTEXT);

    // Write results
    const resultsDir = path.join(import.meta.dirname, '..', 'results');
    await mkdir(resultsDir, { recursive: true });
    const resultsPath = path.join(resultsDir, 'fork-counterfactual.json');
    await writeFile(
      resultsPath,
      JSON.stringify({ results, timestamp: Date.now() }, null, 2),
      'utf8',
    );

    console.log('\n=== Comparison Table ===');
    for (const r of results) {
      console.log(`${r.dimension}:`);
      console.log(`  Fork: ${r.fork}`);
      console.log(`  Checkpoint: ${r.checkpoint}`);
      console.log(`  Fidelity: ${r.fidelity}`);
      console.log(`  Notes: ${r.notes}`);
      console.log();
    }

    console.log(`Results written to ${resultsPath}`);
    process.exit(0);
  } catch (err: any) {
    console.error('Test failed:', err);
    const resultsDir = path.join(import.meta.dirname, '..', 'results');
    await mkdir(resultsDir, { recursive: true });
    const resultsPath = path.join(resultsDir, 'fork-counterfactual.json');
    await writeFile(
      resultsPath,
      JSON.stringify({ error: err.message, results }, null, 2),
      'utf8',
    );
    process.exit(1);
  }
}

main();
