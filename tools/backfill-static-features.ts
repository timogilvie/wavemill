/**
 * backfill-static-features — Sidecar backfill for historical eval records.
 *
 * Reads an eval JSONL (default `.wavemill/evals/evals.jsonl`), and for each
 * record that carries a `prUrl` and a resolvable head SHA:
 *   1. Fetches `refs/pull/<n>/head` if the SHA is not local.
 *   2. Creates a disposable worktree at that SHA.
 *   3. Runs `collectStaticFeatures` inside it.
 *   4. Appends the result to `.wavemill/evals/static-backfill.jsonl` keyed
 *      by `{ recordId, prUrl, headSha, collectedAt, backfill: true, ... }`.
 *
 * Rationale for a sidecar rather than in-place mutation: eval JSONLs are
 * append-only and lock-free by repo convention with live concurrent writers.
 * HOK-2807's feature extractor can join on `id` / `prUrl`.
 *
 * Feasibility caveat (see docs/arbiter/static-features.md §Backfill):
 *   - `complexity_delta` and `build_ok` (via CI evidence) can be reconstructed
 *     for every historical PR whose head is still fetchable.
 *   - `type_errors` and `lint_errors` are honestly null for trees that
 *     pre-date the measurement config being committed, because per S1 the
 *     tool-completed value is what counts. Injecting today's tsconfig into a
 *     historical tree would violate bare-checkout parity.
 *
 * HOK-2806.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readJsonlFile, appendJsonlRecord } from '../shared/lib/jsonl-utils.ts';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import {
  collectStaticFeatures,
  type StaticFeaturesResult,
} from '../shared/lib/static-features.ts';

interface EvalRecordSubset {
  id?: string;
  prUrl?: string;
  evaluatedPrHeadSha?: string;
}

interface BackfillRow extends StaticFeaturesResult {
  recordId: string;
  prUrl: string;
  headSha: string;
  collectedAt: string;
  backfill: true;
  outcome: 'collected' | 'skipped' | 'failed';
  reason?: string;
}

runTool({
  name: 'backfill-static-features',
  description:
    'Append S1 Static-group values to a sidecar JSONL for historical eval records. HOK-2806.',
  options: {
    input: {
      type: 'string',
      description: 'Path to the eval JSONL to read (default .wavemill/evals/evals.jsonl).',
    },
    output: {
      type: 'string',
      description: 'Path to the sidecar JSONL to append (default .wavemill/evals/static-backfill.jsonl).',
    },
    repo: {
      type: 'string',
      description: 'Repo directory used for gh + worktree operations (default cwd).',
    },
    limit: {
      type: 'string',
      description: 'Maximum records to process this run.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be collected without writing to the sidecar.',
    },
  },
  examples: [
    'npx tsx tools/backfill-static-features.ts',
    'npx tsx tools/backfill-static-features.ts --limit 20',
    'npx tsx tools/backfill-static-features.ts --input .wavemill/evals/challenge-records.jsonl --output .wavemill/evals/static-backfill-challenges.jsonl',
    'npx tsx tools/backfill-static-features.ts --dry-run',
  ],
  async run({ args }) {
    const repoDir = resolve(args.repo ?? process.cwd());
    const inputPath = resolve(args.input ?? join(repoDir, '.wavemill/evals/evals.jsonl'));
    const outputPath = resolve(args.output ?? join(repoDir, '.wavemill/evals/static-backfill.jsonl'));
    const limit = args.limit ? Number.parseInt(args.limit, 10) : Number.POSITIVE_INFINITY;
    const dryRun = args['dry-run'] === true;

    if (!existsSync(inputPath)) {
      console.error(`Input JSONL does not exist: ${inputPath}`);
      process.exit(2);
    }

    // Load existing sidecar ids so we skip records already backfilled.
    const alreadyDone = new Set<string>();
    if (existsSync(outputPath)) {
      for (const row of readJsonlFile<BackfillRow>(outputPath)) {
        if (row.recordId) alreadyDone.add(row.recordId);
      }
    }

    const records = readJsonlFile<EvalRecordSubset>(inputPath);
    let processed = 0;
    let collected = 0;
    let skipped = 0;
    let failed = 0;

    for (const record of records) {
      if (processed >= limit) break;
      if (!record.id || !record.prUrl) continue;
      if (alreadyDone.has(record.id)) continue;

      processed++;
      const prNumber = extractPrNumber(record.prUrl);
      if (!prNumber) {
        skipped++;
        emit(outputPath, {
          recordId: record.id,
          prUrl: record.prUrl,
          headSha: '',
          collectedAt: new Date().toISOString(),
          backfill: true,
          outcome: 'skipped',
          reason: 'pr-number-unparseable',
          type_errors: null,
          lint_errors: null,
          build_ok: null,
          complexity_delta: null,
          build_evidence: null,
          complexity_metric: null,
        }, dryRun);
        continue;
      }

      const headSha = record.evaluatedPrHeadSha ?? resolveHeadSha(prNumber, repoDir);
      if (!headSha) {
        skipped++;
        emit(outputPath, {
          recordId: record.id,
          prUrl: record.prUrl,
          headSha: '',
          collectedAt: new Date().toISOString(),
          backfill: true,
          outcome: 'skipped',
          reason: 'head-sha-unresolvable',
          type_errors: null,
          lint_errors: null,
          build_ok: null,
          complexity_delta: null,
          build_evidence: null,
          complexity_metric: null,
        }, dryRun);
        continue;
      }

      const workDir = join(repoDir, '.static-collect-worktrees', `backfill-${prNumber}-${process.pid}-${processed}`);
      const setupOk = ensureWorktree(repoDir, headSha, prNumber, workDir);
      if (!setupOk) {
        failed++;
        emit(outputPath, {
          recordId: record.id,
          prUrl: record.prUrl,
          headSha,
          collectedAt: new Date().toISOString(),
          backfill: true,
          outcome: 'failed',
          reason: 'worktree-setup-failed',
          type_errors: null,
          lint_errors: null,
          build_ok: null,
          complexity_delta: null,
          build_evidence: null,
          complexity_metric: null,
        }, dryRun);
        continue;
      }

      try {
        const result = collectStaticFeatures({
          checkoutDir: workDir,
          prNumber,
          repoDir,
        });
        collected++;
        emit(outputPath, {
          recordId: record.id,
          prUrl: record.prUrl,
          headSha,
          collectedAt: new Date().toISOString(),
          backfill: true,
          outcome: 'collected',
          ...result,
        }, dryRun);
      } finally {
        removeWorktree(repoDir, workDir);
      }
    }

    console.log(
      `Backfill summary: processed=${processed} collected=${collected} skipped=${skipped} failed=${failed}`,
    );
    console.log(`Sidecar: ${outputPath}${dryRun ? ' (dry-run, nothing written)' : ''}`);
  },
});

function extractPrNumber(url: string): string | null {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? match[1] : null;
}

function resolveHeadSha(prNumber: string, repoDir: string): string | null {
  const result = execArgvCommand(
    'gh',
    ['pr', 'view', prNumber, '--json', 'headRefOid', '-q', '.headRefOid'],
    { cwd: repoDir, timeout: 15_000, encoding: 'utf-8' },
  );
  if (result.failed || result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length === 40 ? sha : null;
}

function ensureWorktree(
  repoDir: string,
  headSha: string,
  prNumber: string,
  workDir: string,
): boolean {
  mkdirSync(dirname(workDir), { recursive: true });
  const shaExists = execArgvCommand('git', ['cat-file', '-e', headSha], {
    cwd: repoDir, timeout: 10_000, encoding: 'utf-8',
  });
  if (shaExists.exitCode !== 0) {
    const fetchResult = execArgvCommand(
      'git',
      ['fetch', 'origin', `refs/pull/${prNumber}/head:refs/wavemill/static/backfill-${prNumber}`],
      { cwd: repoDir, timeout: 120_000, encoding: 'utf-8' },
    );
    if (fetchResult.exitCode !== 0) return false;
  }
  const add = execArgvCommand(
    'git',
    ['worktree', 'add', '--detach', workDir, headSha],
    { cwd: repoDir, timeout: 60_000, encoding: 'utf-8' },
  );
  return add.exitCode === 0;
}

function removeWorktree(repoDir: string, workDir: string): void {
  execArgvCommand('git', ['worktree', 'remove', '--force', workDir], {
    cwd: repoDir, timeout: 30_000, encoding: 'utf-8',
  });
}

function emit(path: string, row: BackfillRow, dryRun: boolean): void {
  if (dryRun) {
    console.log(JSON.stringify(row));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendJsonlRecord(path, row);
}
