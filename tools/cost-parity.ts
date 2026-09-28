/**
 * Cost Parity CLI Tool
 *
 * Commands:
 *   --write      Regenerate baseline.json from current engine
 *   --case <id>  Show snapshot for a specific case
 *   --json       Output results as JSON
 *   (default)    Compare current engine against baseline
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCostParityManifest,
  loadCostParityBaseline,
  captureCorpus,
  sanitizeSnapshot,
  compareSnapshots,
  formatComparison,
  type CostEngine,
  legacyEngine,
} from '../shared/lib/cost-parity.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '..', 'shared', 'fixtures', 'cost-parity');
const manifestPath = join(fixtureDir, 'manifest.json');
const baselinePath = join(fixtureDir, 'baseline.json');

async function main() {
  const args = process.argv.slice(2);
  let mode: 'compare' | 'write' | 'case' | 'json' = 'compare';
  let caseId: string | undefined;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') {
      mode = 'write';
    } else if (args[i] === '--case') {
      mode = 'case';
      caseId = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      mode = 'json';
    }
  }

  // Load manifest and validate
  const { manifest, validation } = loadCostParityManifest(manifestPath);
  if (!validation.valid) {
    console.error('Manifest validation failed:');
    console.error(validation.errors.join('\n'));
    process.exit(2);
  }

  try {
    // Capture corpus from current engine
    console.error('[cost-parity] Capturing corpus...');
    const corpus = await captureCorpus(manifest, legacyEngine);
    const sanitized = sanitizeSnapshot(corpus);

    if (mode === 'write') {
      console.error('[cost-parity] Writing baseline.json...');
      // Write only the cases, not the wrapper
      writeFileSync(baselinePath, JSON.stringify(sanitized.cases, null, 2) + '\n');
      console.log(`Baseline written to ${baselinePath}`);
      const changedCases = Object.keys(sanitized.cases).slice(0, 5);
      console.log(`Captured ${Object.keys(sanitized.cases).length} cases`);
      if (changedCases.length > 0) {
        console.log(`Examples: ${changedCases.join(', ')}`);
      }
      process.exit(0);
    }

    if (mode === 'case') {
      if (!caseId) {
        console.error('--case requires a case id');
        process.exit(1);
      }
      const snapshot = sanitized.cases[caseId];
      if (!snapshot) {
        console.error(`Case not found: ${caseId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(snapshot, null, 2));
      process.exit(0);
    }

    if (mode === 'json') {
      console.log(JSON.stringify(sanitized, null, 2));
      process.exit(0);
    }

    // Default: regression test (compare against baseline)
    if (!existsSync(baselinePath)) {
      console.error(`Baseline not found: ${baselinePath}`);
      console.error('Run with --write to generate it first');
      process.exit(2);
    }

    const baselineCases = loadCostParityBaseline(baselinePath);
    const comparison = compareSnapshots({ cases: baselineCases }, sanitized, manifest, { mode: 'regression' });

    console.log(formatComparison(comparison, false));

    if (comparison.exitCode !== 0) {
      console.log(`\nRun with --json to see details`);
    }

    process.exit(comparison.exitCode);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(2);
});
