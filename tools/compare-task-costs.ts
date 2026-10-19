#!/usr/bin/env -S npx tsx
/**
 * SDK cost-migration release gate (HOK-3076).
 *
 * Runs the legacy engine and the SDK task-cost bridge on the cost-parity
 * corpus (and, optionally, a bounded sample of local eval records), prints a
 * per-case report, and exits non-zero on any unexplained difference, SDK bug,
 * or coverage invariant violation.
 *
 * Exit codes: 0 gate passed, 1 gate failed, 2 corpus/manifest error.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import { loadCostParityManifest } from '../shared/lib/cost-parity.ts';
import {
  buildCostMigrationReport,
  compareCostParityCorpus,
  compareHistoricalEvalRecords,
  compareLocalSessionSample,
  formatCostMigrationReport,
  type LocalSessionSampleEntry,
} from '../shared/lib/cost-migration.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { loadPricingTable } from '../shared/lib/workflow-cost.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '..', 'shared', 'fixtures', 'cost-parity', 'manifest.json');
const REPO_DIR = join(__dirname, '..');
const DEFAULT_HISTORY_LIMIT = 25;

function readEvalRecords(path: string): EvalRecord[] {
  const records: EvalRecord[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as EvalRecord);
    } catch {
      // A torn line in an append-only store is skipped, not fatal.
    }
  }
  return records;
}

runTool({
  name: 'compare-task-costs',
  description: 'Shadow-compare legacy vs SDK task cost and enforce the cutover release gate',
  options: {
    'eval-store': { type: 'string', description: 'Also compare persisted legacy cost vs SDK summary in a local evals.jsonl (cost fields only)' },
    sample: { type: 'string', description: 'Also re-scan local sessions for a JSON array of {id, worktreePath, branchName, issueId?, agentType?}' },
    'repo-dir': { type: 'string', description: 'Repo whose .wavemill/runs and pricing the sample uses (default: this checkout)' },
    limit: { type: 'string', description: `Max historical records/sample entries per source (default ${DEFAULT_HISTORY_LIMIT})` },
    'no-fixtures': { type: 'boolean', description: 'Skip the fixture corpus (historical sample only)' },
    json: { type: 'boolean', description: 'Print the machine-readable report' },
    out: { type: 'string', description: 'Also write the JSON report to this path' },
  },
  examples: [
    'npx tsx tools/compare-task-costs.ts',
    'npx tsx tools/compare-task-costs.ts --eval-store .wavemill/evals/evals.jsonl --limit 50',
    'npx tsx tools/compare-task-costs.ts --no-fixtures --sample /tmp/cost-sample.json --limit 10',
    'npx tsx tools/compare-task-costs.ts --json --out /tmp/cost-migration.json',
  ],
  async run({ args }) {
    const cases = [];
    let skipped = 0;

    if (!args['no-fixtures']) {
      const { manifest, validation } = loadCostParityManifest(MANIFEST_PATH);
      if (!validation.valid) {
        console.error(`Manifest validation failed:\n${validation.errors.join('\n')}`);
        process.exit(2);
      }
      cases.push(...(await compareCostParityCorpus(manifest)).cases);
    }

    const limit = Number.parseInt(args.limit ?? `${DEFAULT_HISTORY_LIMIT}`, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      console.error(`--limit must be a positive integer, got ${args.limit}`);
      process.exit(2);
    }
    for (const path of [args['eval-store'], args.sample]) {
      if (path && !existsSync(path)) {
        console.error(`Input not found: ${path}`);
        process.exit(2);
      }
    }

    if (args['eval-store']) {
      const history = compareHistoricalEvalRecords(readEvalRecords(args['eval-store']), { limit });
      cases.push(...history.cases);
      skipped = history.skipped;
    }

    if (args.sample) {
      const entries = JSON.parse(readFileSync(args.sample, 'utf-8')) as LocalSessionSampleEntry[];
      const repoDir = args['repo-dir'] ?? REPO_DIR;
      cases.push(...await compareLocalSessionSample(entries, {
        limit,
        repoDir,
        pricingTable: loadPricingTable(repoDir),
      }));
    }

    const report = buildCostMigrationReport(cases);
    if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatCostMigrationReport(report));
      if (skipped > 0) console.log(`(${skipped} historical record(s) skipped: no attribution or no SDK summary)`);
    }
    process.exit(report.gate.exitCode);
  },
});
