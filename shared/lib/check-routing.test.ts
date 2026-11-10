// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { checkRoutingHealth, formatRoutingHealth } from './check-routing.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeRepo(opts: { records?: string[]; config?: Record<string, unknown> } = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-routing-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  mkdirSync(join(repoDir, 'tools'), { recursive: true });
  writeFileSync(join(repoDir, 'tools', 'route-task.ts'), '// stub\n');
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), `${(opts.records || []).join('\n')}${opts.records?.length ? '\n' : ''}`);
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 2,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
    },
    eval: {
      pricing: {
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
    ...opts.config,
  }));
  const previousGlobalAggregatedPath = process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
  process.env.WAVEMILL_AGGREGATED_EVALS_PATH = join(
    repoDir,
    '.wavemill',
    'evals',
    'aggregated-evals.jsonl',
  );
  clearConfigCache(repoDir);
  return {
    repoDir,
    cleanup: () => {
      if (previousGlobalAggregatedPath === undefined) {
        delete process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
      } else {
        process.env.WAVEMILL_AGGREGATED_EVALS_PATH = previousGlobalAggregatedPath;
      }
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function makeRecord(id: string, modelId: string, score: number, timestamp: string) {
  return JSON.stringify({
    id,
    schemaVersion: '1.0.0',
    originalPrompt: 'Fix routing bug with tests',
    modelId,
    modelVersion: modelId,
    score,
    scoreBand: 'good',
    timeSeconds: 120,
    timestamp,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'solid',
    metadata: {
      stageScores: {
        plan: { score, rationale: 'ok' },
        implementation: { score, rationale: 'ok' },
        review: { score, rationale: 'ok' },
      },
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'bugfix',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 3,
          repo_size_loc: 10000,
          description_tokens: 150,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: {
          complexity: 3,
          domain: 'backend',
          risk_flags: ['workflow'],
        },
      },
      constraints: {
        models_available: [],
        objective: 'balanced',
      },
      stages: {
        planner: { model: modelId, cost_usd: 1 },
        coder: { model: modelId, cost_usd: 2 },
        reviewer: { model: modelId, cost_usd: 1 },
      },
    },
  });
}

console.log('\n--- check-routing Tests ---\n');

await test('reports stage-aware readiness when enough data exists', async () => {
  const { repoDir, cleanup } = makeRepo({
    records: [
      makeRecord('1', 'claude-sonnet-4-5-20250929', 0.9, '2026-04-10T00:00:00.000Z'),
      makeRecord('2', 'gpt-5.3-codex', 0.91, '2026-04-11T00:00:00.000Z'),
    ],
  });

  try {
    const report = await checkRoutingHealth(repoDir, 'Fix workflow routing with tests.');
    assert.equal(report.stageAwareReady, true);
    assert.equal(report.effectiveMode, 'stage-aware');
    assert.equal(report.status, 'warn');
    assert.match(report.sampleSummary, /Planner:/);
  } finally {
    cleanup();
  }
});

await test('warns when routing data is below thresholds', async () => {
  const { repoDir, cleanup } = makeRepo({
    records: [makeRecord('1', 'claude-sonnet-4-5-20250929', 0.9, '2026-02-01T00:00:00.000Z')],
  });

  try {
    const report = await checkRoutingHealth(repoDir);
    assert.equal(report.stageAwareReady, false);
    assert.equal(report.effectiveMode, 'heuristic');
    assert.ok(report.warnings.some((warning) => warning.includes('below threshold')));
    assert.match(formatRoutingHealth(report), /Warnings:/);
  } finally {
    cleanup();
  }
});

if (failed > 0) {
  console.log(`\n--- check-routing Tests: ${passed} passed, ${failed} failed ---`);
  process.exit(1);
}

console.log(`\n--- check-routing Tests: ${passed} passed, ${failed} failed ---`);
