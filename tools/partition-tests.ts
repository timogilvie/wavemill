/**
 * partition-tests - Deterministic weighted shard selection for CI test runners.
 *
 * Reads a test-file list from stdin (one per line), partitions it with the
 * checked-in weights manifest, and prints the files assigned to the requested
 * shard. tests/run-shell-suite.sh, tests/run-unit-tests.sh and
 * tests/run-custom-tests.sh call this for --shard N/M with M > 1; every matrix leg computes the identical full
 * partition and selects only its own shard, so assignment is exactly-once by
 * construction.
 *
 * Any validation problem (malformed manifest, bad weight, unknown suite,
 * empty input, empty shard) exits non-zero with a diagnostic naming the
 * problem — a partitioner failure must fail the shard loudly rather than
 * fall back and risk dropping or duplicating tests across the matrix.
 */

import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { partitionTests, analyzeBalance } from '../shared/lib/test-partitioner.ts';
import { loadWeightsManifest, WEIGHTS_MANIFEST_PATH } from '../shared/lib/shard-balance.ts';

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

runTool({
  name: 'partition-tests',
  description: 'Deterministically assign test files (from stdin) to weighted CI shards',
  options: {
    suite: { type: 'string', description: 'Suite name in the weights manifest (shell|unit|custom)' },
    shard: { type: 'string', description: 'Shard to select, as INDEX/TOTAL (e.g. 2/5)' },
    weights: { type: 'string', description: `Weights manifest path (default: ${WEIGHTS_MANIFEST_PATH})` },
    report: { type: 'boolean', description: 'Print the full partition and balance analysis as JSON instead of a shard selection' },
  },
  examples: [
    'printf "%s\\n" a.test.ts b.test.ts | npx tsx tools/partition-tests.ts --suite unit --shard 1/2',
    'bash tests/run-unit-tests.sh --list | npx tsx tools/partition-tests.ts --suite unit --shard 1/5 --report',
  ],
  async run({ args }) {
    const suite = args.suite;
    if (!suite) {
      throw new Error('--suite is required');
    }
    const shardSpec = args.shard;
    if (!shardSpec || !/^\d+\/\d+$/.test(shardSpec)) {
      throw new Error('--shard is required as INDEX/TOTAL (e.g. 2/5)');
    }
    const [shardIndex, shardTotal] = shardSpec.split('/').map(Number);
    if (shardTotal < 1 || shardIndex < 1 || shardIndex > shardTotal) {
      throw new Error(`invalid shard ${shardSpec}: index must be within 1..total`);
    }

    const manifestPath = args.weights ?? join(process.cwd(), WEIGHTS_MANIFEST_PATH);
    const manifest = loadWeightsManifest(manifestPath);
    const weights = manifest.suites[suite];
    if (weights === undefined) {
      throw new Error(`suite "${suite}" not present in ${manifestPath} (known: ${Object.keys(manifest.suites).join(', ') || 'none'})`);
    }

    const files = await readStdinLines();
    if (files.length === 0) {
      throw new Error('no test files on stdin (expected one per line)');
    }

    const partition = partitionTests({
      files,
      weights,
      defaultMs: manifest.defaultMs,
      shardCount: shardTotal,
    });

    if (args.report) {
      const balance = analyzeBalance(partition);
      console.log(JSON.stringify({ suite, shardTotal, partition, balance }, null, 2));
      return;
    }

    const selected = partition.shards[shardIndex - 1].files;
    if (selected.length === 0) {
      throw new Error(`shard ${shardSpec} for suite "${suite}" is empty`);
    }
    // Single write after all validation: a consumer never sees partial output
    // followed by a failure exit.
    process.stdout.write(selected.join('\n') + '\n');
  },
});
