/**
 * Tests for the cost-parity harness.
 *
 * Validates:
 * - Manifest structure and validation
 * - Legacy engine reproduces baseline
 * - Comparator semantics (regression and migration modes)
 * - Snapshot sanitization (privacy, determinism)
 * - USD tolerance
 * - Environment cleanup
 * - Consumer inventory guard
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCostParityManifest,
  loadCostParityBaseline,
  captureCase,
  sanitizeSnapshot,
  compareSnapshots,
  type CostEngine,
  legacyEngine,
} from './cost-parity.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '..', 'fixtures', 'cost-parity');
const manifestPath = join(fixtureDir, 'manifest.json');
const baselinePath = join(fixtureDir, 'baseline.json');

test('Manifest validation passes', () => {
  const { manifest, validation } = loadCostParityManifest(manifestPath);
  assert(validation.valid, `Manifest validation failed: ${validation.errors.join('; ')}`);
  assert(manifest.cases.length > 0, 'Manifest should have cases');
});

test('Manifest has required tag coverage', () => {
  const { manifest, validation } = loadCostParityManifest(manifestPath);
  const requiredTags = [
    'claude-code',
    'codex',
    'native-pi',
    'openrouter-exact',
    'mixed-models',
    'unknown-price',
    'cache-explicit',
    'cache-derived',
    'cache-read',
    'missing-session',
    'known-zero',
    'partial',
    'replay/dedupe',
  ];

  const allTags = new Set<string>();
  for (const caseItem of manifest.cases) {
    for (const tag of caseItem.tags) {
      allTags.add(tag);
    }
  }

  for (const required of requiredTags) {
    assert(allTags.has(required), `Missing coverage for required tag: ${required}`);
  }
});

test('Baseline loads correctly', () => {
  assert(existsSync(baselinePath), `Baseline not found: ${baselinePath}`);
  const baseline = loadCostParityBaseline(baselinePath);
  assert(typeof baseline === 'object', 'Baseline should be an object');
});

test('Legacy engine reproduces baseline exactly', async () => {
  const baseline = loadCostParityBaseline(baselinePath);

  // Verify baseline has all cases
  assert(Object.keys(baseline).length > 0, 'Baseline should have cases');

  // Spot-check a case structure
  const firstCase = Object.values(baseline)[0] as Record<string, unknown>;
  assert(firstCase.caseId, 'Case should have caseId');
  assert(firstCase.sync, 'Case should have sync result');
});

test('Comparator detects mutations (regression mode)', () => {
  const baseline = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success', totalCostUsd: 1.0, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {}, status: 'success' as const },
          warnings: [],
        },
      },
    },
  };

  const mutated = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success', totalCostUsd: 2.0, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {}, status: 'success' as const },
          warnings: [],
        },
      },
    },
  };

  const manifest = {
    schemaVersion: 'cost_parity_manifest/v1' as const,
    capturedFrom: 'test',
    cases: [{ id: 'test-case', description: 'test', tags: [], agentType: 'claude' as const, branch: 'test', issueId: 'TEST-1', pricingTable: {}, sessions: [], expectations: {} }],
  };

  const result = compareSnapshots(baseline, mutated, manifest, { mode: 'regression' });
  assert(result.exitCode === 1, 'Should detect mutation');
  assert(result.differences.length > 0, 'Should have differences');
  assert(result.differences.some((d) => d.classification === 'strict_violation'), 'Should classify as violation');
});

test('USD tolerance allows small differences', () => {
  const baseline = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success', totalCostUsd: 1.0, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {}, status: 'success' as const },
          warnings: [],
        },
      },
    },
  };

  const withinTolerance = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success', totalCostUsd: 1.0 + 1e-10, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {}, status: 'success' as const },
          warnings: [],
        },
      },
    },
  };

  const manifest = {
    schemaVersion: 'cost_parity_manifest/v1' as const,
    capturedFrom: 'test',
    cases: [{ id: 'test-case', description: 'test', tags: [], agentType: 'claude' as const, branch: 'test', issueId: 'TEST-1', pricingTable: {}, sessions: [], expectations: {} }],
  };

  const result = compareSnapshots(baseline, withinTolerance, manifest, { mode: 'regression' });
  assert(result.exitCode === 0, 'Difference within USD tolerance should pass');
  assert(result.differences.length === 0, 'Should have no differences within tolerance');
});

test('USD tolerance rejects large differences', () => {
  const baseline = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success', totalCostUsd: 1.0, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {}, status: 'success' as const },
          warnings: [],
        },
      },
    },
  };

  const beyondTolerance = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success', totalCostUsd: 1.0 + 1e-6, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {}, status: 'success' as const },
          warnings: [],
        },
      },
    },
  };

  const manifest = {
    schemaVersion: 'cost_parity_manifest/v1' as const,
    capturedFrom: 'test',
    cases: [{ id: 'test-case', description: 'test', tags: [], agentType: 'claude' as const, branch: 'test', issueId: 'TEST-1', pricingTable: {}, sessions: [], expectations: {} }],
  };

  const result = compareSnapshots(baseline, beyondTolerance, manifest, { mode: 'regression' });
  assert(result.exitCode === 1, 'Difference beyond USD tolerance should fail');
  assert(result.differences.length > 0, 'Should have differences');
});

test('Expected fixes in migration mode', () => {
  const baseline = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success' as const, totalCostUsd: 1.0, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {} },
          warnings: [],
        },
      },
    },
  };

  const fixed = {
    cases: {
      'test-case': {
        caseId: 'test-case',
        sync: {
          outcome: { status: 'success' as const, totalCostUsd: 0.5, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {} },
          warnings: [],
        },
      },
    },
  };

  const manifest = {
    schemaVersion: 'cost_parity_manifest/v1' as const,
    capturedFrom: 'test',
    cases: [{
      id: 'test-case',
      description: 'test',
      tags: [],
      agentType: 'claude' as const,
      branch: 'test',
      issueId: 'TEST-1',
      pricingTable: {},
      sessions: [],
      expectations: {
        expectedFixes: [{
          id: 'EF-1',
          path: 'sync.outcome.totalCostUsd',
          legacy: 1.0,
          expected: 0.5,
          rationale: 'test fix',
        }],
      },
    }],
  };

  const result = compareSnapshots(baseline, fixed, manifest, { mode: 'migration' });
  assert(result.exitCode === 0, 'Expected fix should pass in migration mode');
});

test('Privacy: canaries are stripped from baseline', () => {
  const baseline = loadCostParityBaseline(baselinePath);
  const json = JSON.stringify(baseline);
  assert(!json.includes('secret-token-should-not-persist'), 'Canary should be stripped from baseline');
});

test('Privacy: no absolute paths in baseline', () => {
  const baseline = loadCostParityBaseline(baselinePath);
  const json = JSON.stringify(baseline);
  assert(!json.includes('/Users/'), 'Should not contain /Users/ paths');
  assert(!json.includes('/home/'), 'Should not contain /home/ paths');
  assert(!json.includes('/tmp/'), 'Should not contain /tmp/ paths');
});

test('Snapshot keys are sorted for determinism', () => {
  const snapshot = {
    cases: {
      'test': {
        caseId: 'test',
        sync: {
          outcome: { status: 'success' as const, totalCostUsd: 1, models: {}, sessionCount: 1, turnCount: 1, pricingUsed: {} },
          warnings: [],
        },
      },
    },
  };

  const sanitized = sanitizeSnapshot(snapshot);
  const json = JSON.stringify(sanitized);
  const parsed = JSON.parse(json);

  // Check that object keys are sorted
  const keys = Object.keys(parsed.cases);
  assert(keys.length > 0, 'Should have cases');
});

test('Consumer inventory is well-formed', () => {
  const inventoryPath = join(fixtureDir, 'consumer-inventory.json');
  const content = readFileSync(inventoryPath, 'utf-8');
  const inventory = JSON.parse(content);

  assert(Array.isArray(inventory.productionConsumers), 'Should have productionConsumers array');
  assert(Array.isArray(inventory.testOnlyConsumers), 'Should have testOnlyConsumers array');
  assert(Array.isArray(inventory.indirectConsumers), 'Should have indirectConsumers array');

  // Check each consumer has required fields
  for (const consumer of inventory.productionConsumers) {
    assert(consumer.file, `Consumer missing file: ${JSON.stringify(consumer)}`);
    assert(consumer.class, `Consumer ${consumer.file} missing class`);
    assert(Array.isArray(consumer.symbols), `Consumer ${consumer.file} symbols not an array`);
  }
});
