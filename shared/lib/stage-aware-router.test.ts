/**
 * Tests for the stage-aware router.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import type { QuotaStatus } from './quota-state.ts';
import {
  cosineSimilarity,
  findKNearest,
  loadStageAwareEvalRecords,
  loadStageAwareRouterContext,
  rankModelsPerStage,
  routeStageAware,
  vectorizeDescriptor,
} from './stage-aware-router.ts';
import { resolveExplorationConfig } from './router-exploration.ts';
import { clearConfigCache } from './config.ts';
import { routeWorkflowAuto, routeWorkflowStageAware, summarizeWorkflowRoute } from './workflow-router.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
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

function makeDescriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript', 'sql'],
        framework_tags: [],
        files_touched: 6,
        repo_size_loc: 50_000,
        description_tokens: 250,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 4,
        domain: 'backend',
        risk_flags: ['schema-migration'],
      },
    },
    constraints: {
      models_available: [],
      objective: 'balanced',
    },
    stages: {},
    ...overrides,
  };
}

function makeEvalRecord(id: string, modelId: string, stageScores: {
  plan: number;
  implementation: number;
  review: number;
}, overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: 'Implement a backend feature with tests',
    modelId,
    modelVersion: modelId,
    score: overrides.score ?? 0.8,
    scoreBand: 'good',
    timeSeconds: 120,
    timestamp: '2026-04-05T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'solid',
    metadata: {
      stageScores: {
        expansion: { score: 0.8, rationale: 'ok' },
        plan: { score: stageScores.plan, rationale: 'ok' },
        implementation: { score: stageScores.implementation, rationale: 'ok' },
        review: { score: stageScores.review, rationale: 'ok' },
      },
    },
    workflowCost: overrides.workflowCost ?? 9,
    workflowTokenUsage: overrides.workflowTokenUsage,
    taskDescriptor: overrides.taskDescriptor || makeDescriptor({
      stages: {
        planner: { model: modelId, cost_usd: 1.5 },
        coder: { model: modelId, cost_usd: 6 },
        reviewer: { model: modelId, cost_usd: 1.5 },
      },
    }),
    ...overrides,
  } as EvalRecord;
}

function makeRubricDescriptor(modelId: string, meanScore: number, overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return makeDescriptor({
    stages: {
      planner: { model: modelId, cost_usd: 1.5 },
      coder: { model: modelId, cost_usd: 6 },
      reviewer: { model: modelId, cost_usd: 1.5 },
    },
    rubric: {
      has_rubric: true,
      criterion_count: 5,
      mean_score: meanScore,
      criteria_scores: {
        completeness: meanScore,
        correctness: meanScore,
        code_quality: meanScore,
        intervention_impact: meanScore,
        autonomy: meanScore,
      },
    },
    ...overrides,
  });
}

function makeRubricEvalRecord(id: string, modelId: string, stageScores: {
  plan: number;
  implementation: number;
  review: number;
}, meanScore: number, overrides: Partial<EvalRecord> = {}): EvalRecord {
  return makeEvalRecord(id, modelId, stageScores, {
    taskDescriptor: makeRubricDescriptor(modelId, meanScore),
    ...overrides,
  });
}

function makeRouterConfigWithRubricAware(rubricAware: Record<string, unknown>) {
  return {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 50,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
      rubricAware,
    },
  };
}

function makeSchemaV1Descriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    ...makeDescriptor(overrides),
    stages: undefined,
  } as TaskDescriptor;
}

function writeJsonl(repoDir: string, relativePath: string, records: EvalRecord[]) {
  writeFileSync(
    join(repoDir, relativePath),
    records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
  );
}

function writeQuotaState(
  repoDir: string,
  models: Record<string, QuotaStatus>,
): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-17T12:00:00.000Z',
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
        requestHistory: [],
        consecutiveNearLimitSignals: 0,
        lastNearLimitAt: null,
        budgetSignal: null,
      }]),
    ),
  }, null, 2), 'utf-8');
}

function makeRepoWithStageAwareData(
  recordsOrSources: EvalRecord[] | {
    local?: EvalRecord[];
    backfilled?: EvalRecord[];
    aggregated?: EvalRecord[];
  },
  configOverrides: Record<string, unknown> = {},
) {
  const repoDir = mkdtempSync(join(tmpdir(), 'stage-aware-router-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });

  const sources = Array.isArray(recordsOrSources)
    ? { local: recordsOrSources, backfilled: recordsOrSources, aggregated: [] }
    : recordsOrSources;

  writeJsonl(repoDir, '.wavemill/evals/aggregated-evals.backfilled.jsonl', sources.backfilled || []);
  writeJsonl(repoDir, '.wavemill/evals/aggregated-evals.jsonl', sources.aggregated || []);
  writeJsonl(repoDir, '.wavemill/evals/evals.jsonl', sources.local || []);
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
    },
    eval: {
      pricing: {
        'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.4': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.4': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
    ...configOverrides,
  }));

  clearConfigCache(repoDir);
  const previousGlobalAggregatedPath = process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
  process.env.WAVEMILL_AGGREGATED_EVALS_PATH = join(
    repoDir,
    '.wavemill',
    'evals',
    'aggregated-evals.jsonl',
  );

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

console.log('\n--- stage-aware-router Tests ---\n');

test('vectorizeDescriptor produces bounded fixed-length vectors', () => {
  const vector = vectorizeDescriptor(makeDescriptor());
  assert.equal(vector.length, 31);
  assert.ok(vector.every((value) => value >= 0 && value <= 1));
});

test('cosineSimilarity handles identical and orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('findKNearest sorts records by descriptor similarity', () => {
  const query = makeDescriptor();
  const exact = makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.8, implementation: 0.8, review: 0.8 });
  const different = makeEvalRecord('2', 'gpt-5.4', { plan: 0.7, implementation: 0.7, review: 0.7 }, {
    taskDescriptor: makeDescriptor({
      signals: {
        heuristic: {
          task_type: 'infra',
          languages: ['go'],
          framework_tags: [],
          files_touched: 20,
          repo_size_loc: 250_000,
          description_tokens: 1000,
          is_greenfield: true,
          has_migration: false,
          has_ui: false,
          has_tests: false,
          cross_service: true,
        },
        learned: {
          complexity: 5,
          domain: 'infrastructure',
          risk_flags: ['cross-service', 'large-scope-refactor'],
        },
      },
    }),
  });

  const neighbors = findKNearest(query, [different, exact], 2);
  assert.equal(neighbors[0].record.id, '1');
  assert.ok(neighbors[0].similarity >= neighbors[1].similarity);
});

test('loadStageAwareRouterContext excludes held router history before routing', () => {
  const verified = makeEvalRecord('verified', 'gpt-5.4', { plan: 0.8, implementation: 0.8, review: 0.8 });
  const held = makeEvalRecord('held', 'ox-alpha', { plan: 0.99, implementation: 0.99, review: 0.99 }, {
    modelIdentityAttribution: {
      observedAt: '2026-08-01T00:00:00.000Z',
      roles: {},
      provisionalRoles: ['planner', 'coder', 'reviewer'],
      candidateOnlyProvisional: [],
    },
  });
  const { repoDir, cleanup } = makeRepoWithStageAwareData({ local: [verified, held], backfilled: [], aggregated: [] });

  try {
    const context = loadStageAwareRouterContext({ repoDir });
    assert.deepEqual(context.records.map((record) => record.id), ['verified']);
  } finally {
    cleanup();
  }
});

test('rankModelsPerStage picks the best model combination under constraints', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.4', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];

  const unconstrained = rankModelsPerStage(neighbors);
  assert.equal(unconstrained.selection?.planner.modelId, 'claude-opus-4-6');
  assert.equal(unconstrained.selection?.coder.modelId, 'gpt-5.4');
  assert.equal(unconstrained.selection?.reviewer.modelId, 'claude-haiku-4-5-20251001');

  const allowlist = rankModelsPerStage(neighbors, { modelsAvailable: ['claude-opus-4-6', 'gpt-5.4'] });
  assert.equal(allowlist.selection?.reviewer.modelId, 'claude-opus-4-6');
});

test('rankModelsPerStage supports per-stage model allowlists', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.4', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];

  const constrained = rankModelsPerStage(neighbors, {
    plannerModelsAvailable: ['gpt-5.4'],
    coderModelsAvailable: ['claude-opus-4-6'],
    reviewerModelsAvailable: ['claude-opus-4-6', 'gpt-5.4'],
  });

  assert.equal(constrained.selection?.planner.modelId, 'gpt-5.4');
  assert.equal(constrained.selection?.coder.modelId, 'claude-opus-4-6');
  assert.equal(constrained.selection?.reviewer.modelId, 'claude-opus-4-6');
});

test('rankModelsPerStage gives runtime flat allowlist precedence over per-stage defaults', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.4', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];

  const constrained = rankModelsPerStage(neighbors, {
    modelsAvailable: ['claude-haiku-4-5-20251001'],
    plannerModelsAvailable: ['claude-opus-4-6'],
    coderModelsAvailable: ['gpt-5.4'],
    reviewerModelsAvailable: ['claude-opus-4-6'],
  });

  assert.equal(constrained.selection?.planner.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(constrained.selection?.coder.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(constrained.selection?.reviewer.modelId, 'claude-haiku-4-5-20251001');
});

test('rankModelsPerStage applies per-role capability filters without affecting other roles', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.4', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData([]);

  try {
    const constrained = rankModelsPerStage(neighbors, {
      coderCapabilityConstraints: {
        requiresTools: true,
        minContextWindow: 1_000_000,
      },
      reviewerCapabilityConstraints: {
        maxLatencyTier: 'fast',
      },
    }, 0.3, 0, repoDir);

    assert.equal(constrained.selection?.planner.modelId, 'claude-opus-4-6');
    assert.equal(constrained.selection?.coder.modelId, 'gpt-5.4');
    assert.equal(constrained.selection?.reviewer.modelId, 'claude-haiku-4-5-20251001');
  } finally {
    cleanup();
  }
});

test('rankModelsPerStage falls back when capability filtering empties a role', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.4', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData([]);

  try {
    const constrained = rankModelsPerStage(neighbors, {
      reviewerCapabilityConstraints: {
        minContextWindow: 2_000_000,
      },
    }, 0.3, 0, repoDir);

    const reviewerRanking = constrained.rankings.find((ranking) => ranking.role === 'reviewer');
    assert.ok(reviewerRanking);
    assert.equal(reviewerRanking?.capabilityFallbackUsed, true);
    assert.equal(constrained.selection?.reviewer.modelId, 'claude-opus-4-6');
  } finally {
    cleanup();
  }
});

test('routeStageAware returns a stage-aware decision from backfilled evals', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.6-terra', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.coder, 'gpt-5.6-terra');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
    assert.equal(decision?.neighborCount, 3);
    assert.ok((decision?.expectedCost || 0) > 0);
    assert.ok((decision?.confidence || 0) >= 0.6);
  } finally {
    cleanup();
  }
});

test('routeStageAware records capability fallback reasoning when a role filter empties out', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.4', { plan: 0.72, implementation: 0.97, review: 0.68 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      ...makeRouterConfigWithRubricAware({ mode: 'off' }).router,
      capabilityFiltering: {
        enabled: true,
      },
    },
  });

  try {
    const decision = routeStageAware('Review the screenshot-backed UI change quickly.', {
      repoDir,
      reviewerCapabilityConstraints: {
        minContextWindow: 2_000_000,
      },
    });

    assert.ok(decision);
    assert.match(decision?.reasoning[0] || '', /capability-filter-empty-fallback/);
  } finally {
    cleanup();
  }
});

test('routeStageAware uses global stage pools instead of repo stage constraints', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.coder, 'claude-opus-4-6');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
  } finally {
    cleanup();
  }
});

test('routeStageAware uses global stage pools without repo stage lists', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.coder, 'claude-opus-4-6');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
  } finally {
    cleanup();
  }
});

test('routeStageAware carries maxCostUsd through the decision', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.4', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', {
      repoDir,
      maxCostUsd: 12,
    });
    assert.ok(decision);
    assert.deepEqual(decision?.constraints, { maxCostUsd: 12 });
  } finally {
    cleanup();
  }
});

test('loadStageAwareEvalRecords merges sources and prefers richer local duplicates', () => {
  const duplicateAggregate = makeEvalRecord('dup', 'claude-opus-4-6', { plan: 0.4, implementation: 0.4, review: 0.4 }, {
    taskDescriptor: undefined,
    metadata: undefined,
    workflowTokenUsage: undefined,
  });
  const duplicateLocal = makeEvalRecord('dup', 'gpt-5.4', { plan: 0.9, implementation: 0.95, review: 0.92 }, {
    workflowTokenUsage: {
      'gpt-5.4': { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 3.25 },
    },
  });
  const uniqueBackfilled = makeEvalRecord('unique', 'claude-haiku-4-5-20251001', { plan: 0.7, implementation: 0.72, review: 0.91 });
  const { repoDir, cleanup } = makeRepoWithStageAwareData({
    local: [duplicateLocal],
    backfilled: [uniqueBackfilled],
    aggregated: [duplicateAggregate],
  });

  try {
    const records = loadStageAwareEvalRecords({ repoDir });
    assert.equal(records.length, 2);
    const deduped = records.find((record) => record.id === 'dup');
    assert.equal(deduped?.modelId, 'gpt-5.4');
    assert.ok(deduped?.workflowTokenUsage);
    assert.ok(records.some((record) => record.id === 'unique'));
  } finally {
    cleanup();
  }
});

test('routeWorkflowStageAware falls back to heuristic when data is insufficient', () => {
  const records = [
    makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.9, review: 0.9 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 3,
      minModels: 2,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeWorkflowStageAware('Create a CLI command with JSON output.', { repoDir });
    assert.equal(decision.routingMode, 'heuristic-fallback');
    assert.equal(decision.neighborCount, 0);
    assert.ok(decision.confidence >= 0.1 && decision.confidence <= 0.85);
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Router:\s+heuristic-fallback/);
  } finally {
    cleanup();
  }
});

test('routeStageAware uses fresh local evals even when aggregate history exists', () => {
  const aggregated = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.97, implementation: 0.61, review: 0.96 }),
    makeEvalRecord('2', 'claude-opus-4-6', { plan: 0.95, implementation: 0.62, review: 0.95 }),
    makeEvalRecord('3', 'claude-opus-4-6', { plan: 0.94, implementation: 0.63, review: 0.94 }),
  ];
  const local = [
    makeEvalRecord('4', 'gpt-5.6-terra', { plan: 0.7, implementation: 0.98, review: 0.68 }),
    makeEvalRecord('5', 'gpt-5.6-terra', { plan: 0.69, implementation: 0.97, review: 0.67 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData({ local, backfilled: aggregated });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 5,
    });
    assert.ok(decision);
    assert.equal(decision?.coder, 'gpt-5.6-terra');
    assert.equal(decision?.planner, 'claude-opus-4-6');
  } finally {
    cleanup();
  }
});

test('routeStageAware does not overweight duplicate records across sources', () => {
  const opus = makeEvalRecord('opus-1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.82, review: 0.93 });
  const codex = makeEvalRecord('codex-1', 'gpt-5.6-terra', { plan: 0.74, implementation: 0.97, review: 0.7 });
  const haiku = makeEvalRecord('haiku-1', 'claude-haiku-4-5-20251001', { plan: 0.68, implementation: 0.62, review: 0.95 });
  const { repoDir, cleanup } = makeRepoWithStageAwareData({
    local: [codex],
    backfilled: [opus, codex, haiku],
  });

  try {
    const records = loadStageAwareEvalRecords({ repoDir });
    assert.equal(records.length, 3);
    assert.equal(records.filter((record) => record.id === 'codex-1').length, 1);

    const decision = routeStageAware('Build a backend feature with tests and review.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 5,
    });
    assert.ok(decision);
    assert.equal(decision?.coder, 'gpt-5.6-terra');
    assert.equal(decision?.neighborCount, 3);
  } finally {
    cleanup();
  }
});

test('routeStageAware still uses aggregate history when local evals are empty', () => {
  const backfilled = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.4', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData({ local: [], backfilled });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    assert.equal(decision?.neighborCount, 3);
  } finally {
    cleanup();
  }
});

test('routeWorkflowStageAware attaches a challenge recommendation when policy triggers', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.4', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      defaultAgent: 'claude',
    },
    challengeScheduler: {
      enabled: true,
      confidenceThreshold: 0.99,
      newModelChallengeCount: 1,
      minEvalRecordsPerStage: 1,
    },
  });

  try {
    const decision = routeWorkflowStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.equal(decision.challengeRecommendation?.shouldChallenge, true);
    assert.equal(decision.challengeRecommendation?.reason, 'new-model');
    assert.match(summarizeWorkflowRoute(decision, repoDir), /Challenge:\s+new-model/);
  } finally {
    cleanup();
  }
});

test('routeWorkflowStageAware uses partial routing when neighbors lack model diversity', () => {
  // All records are the same model — enough data, but no model diversity in neighbors
  const records = [
    makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.85, review: 0.88 }),
    makeEvalRecord('2', 'claude-sonnet-4-5-20250929', { plan: 0.88, implementation: 0.82, review: 0.9 }),
    makeEvalRecord('3', 'claude-sonnet-4-5-20250929', { plan: 0.92, implementation: 0.87, review: 0.86 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeWorkflowStageAware('Build a backend feature with tests.', { repoDir });
    assert.equal(decision.routingMode, 'stage-aware-partial');
    assert.ok(decision.neighborCount > 0, 'should have neighbors');
    // Model selection comes from heuristic, not from the single-model neighbors
    assert.ok(decision.planner, 'should have a planner model');
    assert.ok(decision.coder, 'should have a coder model');
    // Stage calibration comes from neighbors — verify depths are set
    assert.ok(['light', 'deep'].includes(decision.planDepth));
    assert.ok(['light', 'medium', 'deep'].includes(decision.codeDepth));
    assert.ok(decision.confidence >= 0.1 && decision.confidence < 0.8);
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Router:\s+stage-aware-partial/);
  } finally {
    cleanup();
  }
});

test('routeStageAware returns stage-aware-partial when neighbors have single model', () => {
  const records = [
    makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.85, review: 0.88 }),
    makeEvalRecord('2', 'claude-sonnet-4-5-20250929', { plan: 0.88, implementation: 0.82, review: 0.9 }),
    makeEvalRecord('3', 'claude-sonnet-4-5-20250929', { plan: 0.92, implementation: 0.87, review: 0.86 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
    });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware-partial');
    assert.equal(decision?.neighborCount, 3);
    assert.ok((decision?.confidence || 0) < 0.8);
  } finally {
    cleanup();
  }
});

test('routeStageAware retries without constraints when allowlist filters all neighbors', () => {
  // Records carry real per-stage attribution so the router actually has
  // something to rank; the test exercises the unconstrained-retry path when
  // the caller's allowlist filters every attributed model out.
  const records = Array.from({ length: 20 }, (_, index) => makeEvalRecord(
    `${index + 1}`,
    'claude-opus-4-6',
    { plan: 0.91, implementation: 0.84, review: 0.89 },
  ));
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 20,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeStageAware('Build a TypeScript backend feature with tests and review.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 20,
      modelsAvailable: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware-partial');
    assert.equal(decision?.neighborCount, 20);
  } finally {
    cleanup();
  }
});

await testAsync('routeWorkflowAuto preserves neighbor counts in survival mode when degraded pool filters neighbors', async () => {
  // Stage costs must sum under the survival-mode budget ($5 default) so the
  // degraded-pool retry doesn't fail on cost grounds — this test is about
  // neighbor-count preservation, not cost filtering.
  const records = Array.from({ length: 20 }, (_, index) => makeEvalRecord(
    `${index + 1}`,
    'claude-sonnet-4-5-20250929',
    { plan: 0.89, implementation: 0.83, review: 0.87 },
    {
      workflowCost: 1.2,
      taskDescriptor: makeDescriptor({
        stages: {
          planner: { model: 'claude-sonnet-4-5-20250929', cost_usd: 0.4 },
          coder: { model: 'claude-sonnet-4-5-20250929', cost_usd: 0.4 },
          reviewer: { model: 'claude-sonnet-4-5-20250929', cost_usd: 0.4 },
        },
      }),
    },
  ));
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'auto',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 20,
      defaultAgent: 'claude',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
  });

  try {
    const decision = await routeWorkflowAuto('Build a TypeScript backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'heuristic-fallback');
    assert.ok(decision.neighborCount > 0);
  } finally {
    cleanup();
  }
});

test('routeWorkflowStageAware still uses heuristic-fallback when there are no records', () => {
  const { repoDir, cleanup } = makeRepoWithStageAwareData([], {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 20,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeWorkflowStageAware('Build a TypeScript backend feature with tests and review.', { repoDir });
    assert.equal(decision.routingMode, 'heuristic-fallback');
    assert.equal(decision.neighborCount, 0);
  } finally {
    cleanup();
  }
});

test('loadStageAwareEvalRecords merges additionalEvalsPaths into final record set', () => {
  const localRecords = [
    makeEvalRecord('local-1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.85, review: 0.88 }),
    makeEvalRecord('local-2', 'claude-opus-4-6', { plan: 0.92, implementation: 0.87, review: 0.91 }),
  ];
  const { repoDir, cleanup: cleanupMain } = makeRepoWithStageAwareData({ local: localRecords });

  const additionalDir = mkdtempSync(join(tmpdir(), 'stage-aware-additional-'));
  mkdirSync(join(additionalDir, '.wavemill', 'evals'), { recursive: true });
  const additionalRecords = [
    makeEvalRecord('additional-1', 'gpt-5.4', { plan: 0.88, implementation: 0.97, review: 0.7 }),
    makeEvalRecord('additional-2', 'claude-haiku-4-5-20251001', { plan: 0.68, implementation: 0.62, review: 0.95 }),
  ];
  const additionalPath = join(additionalDir, '.wavemill', 'evals', 'aggregated-evals.jsonl');
  writeJsonl(additionalDir, '.wavemill/evals/aggregated-evals.jsonl', additionalRecords);

  try {
    const records = loadStageAwareEvalRecords({
      repoDir,
      additionalEvalsPaths: [additionalPath],
    });

    assert.equal(records.length, 4);
    assert.ok(records.some((record) => record.id === 'local-1'));
    assert.ok(records.some((record) => record.id === 'local-2'));
    assert.ok(records.some((record) => record.id === 'additional-1'));
    assert.ok(records.some((record) => record.id === 'additional-2'));
  } finally {
    cleanupMain();
    rmSync(additionalDir, { recursive: true, force: true });
  }
});

test('rubric-aware: mode=off is byte-identical to baseline', () => {
  const records = [
    makeRubricEvalRecord('rubric-off-1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }, 0.2),
    makeEvalRecord('rubric-off-2', 'gpt-5.4', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeRubricEvalRecord('rubric-off-3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }, 0.9),
  ];
  const baseline = makeRepoWithStageAwareData(records);
  const off = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({ mode: 'off' }));

  try {
    const baselineDecision = routeStageAware('Build a backend feature with tests and review.', { repoDir: baseline.repoDir, kNeighbors: 3 });
    const offDecision = routeStageAware('Build a backend feature with tests and review.', { repoDir: off.repoDir, kNeighbors: 3 });
    assert.deepEqual(offDecision, baselineDecision);
  } finally {
    baseline.cleanup();
    off.cleanup();
  }
});

test('rubric-aware: records without rubric participate via scalar path', () => {
  const records = [
    ...Array.from({ length: 40 }, (_, index) => makeEvalRecord(
      `rubric-mixed-legacy-${index}`,
      'claude-opus-4-6',
      { plan: 0.82, implementation: 0.82, review: 0.82 },
    )),
    ...Array.from({ length: 10 }, (_, index) => makeRubricEvalRecord(
      `rubric-mixed-aware-${index}`,
      'gpt-5.6-terra',
      { plan: 0.78, implementation: 0.78, review: 0.78 },
      0.9,
    )),
  ];
  const neighbors = records.map((record) => ({
    record,
    descriptor: record.taskDescriptor as TaskDescriptor,
    similarity: 0.9,
  }));

  const { rankings } = rankModelsPerStage(neighbors, {}, 0.3, 0.3);
  const totalSupport = rankings[0].candidates.reduce((sum, candidate) => sum + candidate.support, 0);
  assert.equal(totalSupport, 50);
});

test('rubric-aware: sparse coverage triggers fallback with rationale', () => {
  const records = [
    ...Array.from({ length: 45 }, (_, index) => makeEvalRecord(
      `rubric-sparse-legacy-${index}`,
      index % 2 === 0 ? 'claude-opus-4-6' : 'gpt-5.4',
      { plan: 0.85, implementation: 0.85, review: 0.85 },
    )),
    ...Array.from({ length: 5 }, (_, index) => makeRubricEvalRecord(
      `rubric-sparse-aware-${index}`,
      'claude-haiku-4-5-20251001',
      { plan: 0.7, implementation: 0.7, review: 0.7 },
      1,
    )),
  ];
  const baseline = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({ mode: 'off' }));
  const sparse = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({
    mode: 'on',
    minCoverage: 0.3,
    weight: 0.5,
  }));

  try {
    const baselineDecision = routeStageAware('Build a backend feature with tests and review.', { repoDir: baseline.repoDir, kNeighbors: 50 });
    const sparseDecision = routeStageAware('Build a backend feature with tests and review.', { repoDir: sparse.repoDir, kNeighbors: 50 });
    assert.ok(baselineDecision);
    assert.ok(sparseDecision);
    assert.equal(sparseDecision?.planner, baselineDecision?.planner);
    assert.equal(sparseDecision?.coder, baselineDecision?.coder);
    assert.equal(sparseDecision?.reviewer, baselineDecision?.reviewer);
    assert.match(sparseDecision?.reasoning[0] || '', /rubric-aware fallback/);
    assert.match(sparseDecision?.reasoning[0] || '', /coverage 0\.10 < minCoverage 0\.30/);
  } finally {
    baseline.cleanup();
    sparse.cleanup();
  }
});

test('rubric-aware: mode=on with sufficient coverage uses rubric scores', () => {
  const records = [
    ...Array.from({ length: 15 }, (_, index) => makeRubricEvalRecord(
      `rubric-on-opus-${index}`,
      'claude-opus-4-6',
      { plan: 0.9, implementation: 0.9, review: 0.9 },
      0.1,
    )),
    ...Array.from({ length: 15 }, (_, index) => makeRubricEvalRecord(
      `rubric-on-codex-${index}`,
      'gpt-5.6-terra',
      { plan: 0.7, implementation: 0.7, review: 0.7 },
      1,
    )),
  ];
  const neighbors = records.map((record) => ({
    record,
    descriptor: record.taskDescriptor as TaskDescriptor,
    similarity: 0.9,
  }));
  const scalar = rankModelsPerStage(neighbors, {}, 0.3, 0);
  const rubric = rankModelsPerStage(neighbors, {}, 0.3, 0.5);
  const scalarTopScore = scalar.rankings[0].candidates[0].score;
  const rubricTopScore = rubric.rankings[0].candidates[0].score;
  assert.notEqual(Number(rubricTopScore.toFixed(3)), Number(scalarTopScore.toFixed(3)));

  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({
    mode: 'on',
    minCoverage: 1,
    weight: 0.5,
  }));

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir, kNeighbors: 30 });
    assert.ok(decision);
    assert.equal(decision?.planner, 'gpt-5.6-terra');
    assert.match(decision?.reasoning[0] || '', /rubric-aware \(mode=on/);
  } finally {
    cleanup();
  }
});

test('rubric-aware: schema config loads with partial rubricAware section', () => {
  const records = [
    makeRubricEvalRecord('rubric-partial-1', 'claude-opus-4-6', { plan: 0.9, implementation: 0.9, review: 0.9 }, 0.8),
    makeRubricEvalRecord('rubric-partial-2', 'gpt-5.4', { plan: 0.8, implementation: 0.8, review: 0.8 }, 0.8),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({ mode: 'on' }));

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir, kNeighbors: 2 });
    assert.ok(decision);
    assert.match(decision?.reasoning[0] || '', /rubric-aware \(mode=on, coverage=1\.00, weight=0\.3\)/);
  } finally {
    cleanup();
  }
});

test('rubric-aware: comparison test non-regression on mixed dataset', () => {
  const models = ['claude-opus-4-6', 'gpt-5.4', 'claude-haiku-4-5-20251001'];
  const records = Array.from({ length: 100 }, (_, index) => {
    const modelId = models[index % models.length];
    const score = 0.72 + ((index % 9) * 0.02);
    if (index < 60) {
      return makeRubricEvalRecord(
        `rubric-regression-aware-${index}`,
        modelId,
        { plan: score, implementation: score, review: score },
        Math.min(1, Math.max(0, score + (((index % 3) - 1) * 0.03))),
      );
    }
    return makeEvalRecord(
      `rubric-regression-legacy-${index}`,
      modelId,
      { plan: score, implementation: score, review: score },
    );
  });
  const scalar = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({ mode: 'off' }));
  const rubric = makeRepoWithStageAwareData(records, makeRouterConfigWithRubricAware({
    mode: 'on',
    minCoverage: 0.3,
    weight: 0.3,
  }));

  try {
    let agreements = 0;
    for (let index = 0; index < 20; index += 1) {
      const prompt = `Build backend feature ${index} with tests and review.`;
      const scalarDecision = routeStageAware(prompt, { repoDir: scalar.repoDir, kNeighbors: 50 });
      const rubricDecision = routeStageAware(prompt, { repoDir: rubric.repoDir, kNeighbors: 50 });
      assert.ok(scalarDecision);
      assert.ok(rubricDecision);
      if (
        scalarDecision?.planner === rubricDecision?.planner &&
        scalarDecision?.coder === rubricDecision?.coder &&
        scalarDecision?.reviewer === rubricDecision?.reviewer
      ) {
        agreements += 1;
      }
    }
    assert.ok(agreements / 20 >= 0.8, `agreement was ${agreements}/20`);
  } finally {
    scalar.cleanup();
    rubric.cleanup();
  }
});


function explorationRouterConfig(exploration: Record<string, unknown>) {
  return {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
      exploration,
    },
  };
}

function explorationRecords(): EvalRecord[] {
  return [
    makeEvalRecord('a1', 'claude-opus-4-6', { plan: 0.92, implementation: 0.9, review: 0.91 }),
    makeEvalRecord('a2', 'claude-opus-4-6', { plan: 0.9, implementation: 0.88, review: 0.9 }),
    makeEvalRecord('a3', 'claude-opus-4-6', { plan: 0.91, implementation: 0.89, review: 0.92 }),
    makeEvalRecord('b1', 'claude-sonnet-4-5-20250929', { plan: 0.7, implementation: 0.68, review: 0.69 }),
    makeEvalRecord('b2', 'claude-sonnet-4-5-20250929', { plan: 0.72, implementation: 0.7, review: 0.71 }),
    makeEvalRecord('b3', 'claude-sonnet-4-5-20250929', { plan: 0.71, implementation: 0.69, review: 0.7 }),
  ];
}

test('exploration disabled keeps stage-aware routing argmax with no attribution', () => {
  const { repoDir, cleanup } = makeRepoWithStageAwareData(
    explorationRecords(),
    explorationRouterConfig({ enabled: false }),
  );

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
    });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.coder, 'claude-opus-4-6');
    assert.equal(decision?.reviewer, 'claude-opus-4-6');
    assert.equal(decision?.exploration, undefined);
    assert.ok(!decision?.reasoning.some((line) => line.startsWith('exploration(')));
  } finally {
    cleanup();
  }
});

test('exploration samples non-argmax candidates with a seeded randomFn', () => {
  const { repoDir, cleanup } = makeRepoWithStageAwareData(
    explorationRecords(),
    explorationRouterConfig({ enabled: true, mode: 'epsilon', rate: 1, topK: 2 }),
  );

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      randomFn: () => 0,
    });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    // rate=1 with two candidates per stage: every role samples the runner-up
    assert.equal(decision?.planner, 'claude-sonnet-4-5-20250929');
    assert.equal(decision?.coder, 'claude-sonnet-4-5-20250929');
    assert.equal(decision?.reviewer, 'claude-sonnet-4-5-20250929');
    assert.equal(decision?.exploration?.mode, 'epsilon');
    assert.equal(decision?.exploration?.explored.length, 3);
    for (const entry of decision?.exploration?.explored ?? []) {
      assert.equal(entry.sampled, 'claude-sonnet-4-5-20250929');
      assert.equal(entry.argmax, 'claude-opus-4-6');
    }
    assert.ok(decision?.reasoning[0].startsWith('exploration(epsilon'));
  } finally {
    cleanup();
  }
});

test('exploration cost guard reverts to exploit when the sampled combo exceeds maxCostUsd', () => {
  const expensiveDescriptor = (modelId: string) => makeDescriptor({
    stages: {
      planner: { model: modelId, cost_usd: 20 },
      coder: { model: modelId, cost_usd: 60 },
      reviewer: { model: modelId, cost_usd: 20 },
    },
  });
  const records = [
    ...explorationRecords().slice(0, 3),
    makeEvalRecord('b1', 'claude-sonnet-4-5-20250929', { plan: 0.7, implementation: 0.68, review: 0.69 }, {
      taskDescriptor: expensiveDescriptor('claude-sonnet-4-5-20250929'),
    }),
    makeEvalRecord('b2', 'claude-sonnet-4-5-20250929', { plan: 0.72, implementation: 0.7, review: 0.71 }, {
      taskDescriptor: expensiveDescriptor('claude-sonnet-4-5-20250929'),
    }),
    makeEvalRecord('b3', 'claude-sonnet-4-5-20250929', { plan: 0.71, implementation: 0.69, review: 0.7 }, {
      taskDescriptor: expensiveDescriptor('claude-sonnet-4-5-20250929'),
    }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(
    records,
    explorationRouterConfig({ enabled: true, mode: 'epsilon', rate: 1, topK: 2 }),
  );

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      maxCostUsd: 20,
      randomFn: () => 0,
    });
    assert.ok(decision);
    // Sampled combo costs ~100; exploit combo costs ~9 and stays selected.
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.coder, 'claude-opus-4-6');
    assert.equal(decision?.reviewer, 'claude-opus-4-6');
    assert.equal(decision?.exploration?.costGuardReverted, true);
    assert.equal(decision?.exploration?.explored.length, 0);
    assert.ok(decision?.reasoning.some((line) => line.includes('exploration(epsilon) reverted')));
  } finally {
    cleanup();
  }
});



const PRIORS_ON = resolveExplorationConfig({ priors: { enabled: true, blendSamples: 10 } });

function priorNeighbors(modelId: string, count: number, planScore: number, recordScore = 0.8) {
  return Array.from({ length: count }, (_, index) => ({
    record: makeEvalRecord(`${modelId}-${index}`, modelId, {
      plan: planScore,
      implementation: planScore,
      review: planScore,
    }, { score: recordScore }),
    descriptor: makeDescriptor(),
    similarity: 0.95,
  }));
}

test('priors seed zero-record allowlisted models and rank the high-prior model first for planning', () => {
  // Uses claude-opus-4-8 as the high-prior example (claude-fable-5 would be a
  // higher prior but is temporarily disabled — see disabled-models.ts).
  const neighbors = priorNeighbors('claude-sonnet-4-5-20250929', 3, 0.9);
  const allowlists = {
    plannerModelsAvailable: ['claude-opus-4-8', 'claude-sonnet-4-5-20250929'],
    coderModelsAvailable: ['claude-opus-4-8', 'claude-sonnet-4-5-20250929'],
    reviewerModelsAvailable: ['claude-opus-4-8', 'claude-sonnet-4-5-20250929'],
  };

  const withoutPriors = rankModelsPerStage(neighbors, allowlists, 0.3, 0);
  assert.ok(!withoutPriors.rankings[0].candidates.some((candidate) => candidate.modelId === 'claude-opus-4-8'));

  const withPriors = rankModelsPerStage(neighbors, allowlists, 0.3, 0, undefined, PRIORS_ON);
  const plannerCandidates = withPriors.rankings[0].candidates;
  const seeded = plannerCandidates.find((candidate) => candidate.modelId === 'claude-opus-4-8');
  assert.ok(seeded, 'zero-record opus-4-8 should be seeded into planner candidates');
  assert.equal(seeded!.support, 0);
  // Zero support means pure registry prior (planning quality 97 -> 0.97)
  assert.ok(Math.abs(seeded!.score - 0.97) < 1e-9, `expected prior score 0.97, got ${seeded!.score}`);
  assert.equal(plannerCandidates[0].modelId, 'claude-opus-4-8');
  assert.equal(withPriors.selection?.planner.modelId, 'claude-opus-4-8');
});

test('blended score converges to empirical as support reaches blendSamples', () => {
  const neighbors = [
    // 10 opus-4-8 records with weak plan outcomes: support >= blendSamples -> pure empirical 0.5
    ...priorNeighbors('claude-opus-4-8', 10, 0.5, 0.5),
    ...priorNeighbors('claude-sonnet-4-5-20250929', 3, 0.9),
  ];
  const allowlists = {
    plannerModelsAvailable: ['claude-opus-4-8', 'claude-sonnet-4-5-20250929'],
    coderModelsAvailable: ['claude-opus-4-8', 'claude-sonnet-4-5-20250929'],
    reviewerModelsAvailable: ['claude-opus-4-8', 'claude-sonnet-4-5-20250929'],
  };

  const { rankings, selection } = rankModelsPerStage(neighbors, allowlists, 0.3, 0, undefined, PRIORS_ON);
  const blended = rankings[0].candidates.find((candidate) => candidate.modelId === 'claude-opus-4-8');
  assert.ok(blended);
  assert.equal(blended!.support, 10);
  // Full support: the registry planning prior no longer props up the weak empirical score
  assert.ok(Math.abs(blended!.score - 0.5) < 1e-9, `expected converged empirical 0.5, got ${blended!.score}`);
  assert.equal(selection?.planner.modelId, 'claude-sonnet-4-5-20250929');
});

test('ucbConstant boosts undersampled candidates in ranking without inflating reported score', () => {
  const neighbors = [
    ...priorNeighbors('claude-sonnet-4-5-20250929', 10, 0.8),
    ...priorNeighbors('claude-opus-4-6', 1, 0.75),
  ];
  const ucbConfig = resolveExplorationConfig({ ucbConstant: 0.3 });

  const baseline = rankModelsPerStage(neighbors, {}, 0.3, 0);
  assert.equal(baseline.rankings[0].candidates[0].modelId, 'claude-sonnet-4-5-20250929');

  const boosted = rankModelsPerStage(neighbors, {}, 0.3, 0, undefined, ucbConfig);
  const [first, second] = boosted.rankings[0].candidates;
  assert.equal(first.modelId, 'claude-opus-4-6');
  // The bonus reorders selection, but the reported score stays bonus-free
  assert.ok(first.score < second.score);
  assert.equal(boosted.selection?.planner.modelId, 'claude-opus-4-6');
  assert.ok(boosted.selection!.expectedSuccess <= 1);
});

test('routeStageAware with priors selects a zero-record allowlisted model end to end', () => {
  const records = [
    makeEvalRecord('s1', 'claude-sonnet-4-5-20250929', { plan: 0.85, implementation: 0.84, review: 0.86 }),
    makeEvalRecord('s2', 'claude-sonnet-4-5-20250929', { plan: 0.86, implementation: 0.83, review: 0.85 }),
    makeEvalRecord('g1', 'gpt-5.4', { plan: 0.8, implementation: 0.82, review: 0.79 }),
    makeEvalRecord('g2', 'gpt-5.4', { plan: 0.81, implementation: 0.8, review: 0.8 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
      exploration: { priors: { enabled: true, blendSamples: 10 } },
    },
  });

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
    });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    // The globally certified pool supplies the highest-prior zero-record model.
    assert.equal(decision?.planner, 'claude-fable-5');
    assert.equal(decision?.coder, 'claude-fable-5');
    assert.equal(decision?.reviewer, 'claude-fable-5');
  } finally {
    cleanup();
  }
});



test('stage-less records do not crowd usable neighbors out of the KNN window', () => {
  // Stage-less legacy records whose pre-task-style descriptors (empty
  // languages, zero counts) are near-identical to fresh query descriptors —
  // these used to win the whole neighbor window and force a null selection.
  const queryLikeDescriptor = () => makeDescriptor({
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: [],
        framework_tags: [],
        files_touched: 0,
        repo_size_loc: 0,
        description_tokens: 10,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: false,
        cross_service: false,
      },
      learned: { complexity: 3, domain: 'backend', risk_flags: [] },
    },
    stages: undefined,
  } as Parameters<typeof makeDescriptor>[0]);

  const records = [
    ...Array.from({ length: 10 }, (_, index) => makeEvalRecord(
      `legacy-${index}`,
      'claude-opus-4-6',
      { plan: 0.9, implementation: 0.9, review: 0.9 },
      { taskDescriptor: queryLikeDescriptor() },
    )),
    // Attributed records with realistic (less query-similar) descriptors
    makeEvalRecord('a1', 'claude-opus-4-6', { plan: 0.92, implementation: 0.85, review: 0.9 }),
    makeEvalRecord('a2', 'claude-opus-4-6', { plan: 0.9, implementation: 0.84, review: 0.91 }),
    makeEvalRecord('b1', 'claude-sonnet-4-5-20250929', { plan: 0.7, implementation: 0.72, review: 0.7 }),
    makeEvalRecord('b2', 'claude-sonnet-4-5-20250929', { plan: 0.71, implementation: 0.7, review: 0.72 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 4,
    });
    assert.ok(decision, 'expected a stage-aware decision, not null');
    assert.equal(decision?.routingMode, 'stage-aware');
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.neighborCount, 4);
  } finally {
    cleanup();
  }
});

test('KNN keeps the full pool when too few records carry stage attribution', () => {
  const records = [
    ...Array.from({ length: 5 }, (_, index) => makeEvalRecord(
      `legacy-${index}`,
      'claude-opus-4-6',
      { plan: 0.9, implementation: 0.9, review: 0.9 },
      { taskDescriptor: makeSchemaV1Descriptor() },
    )),
    makeEvalRecord('a1', 'claude-opus-4-6', { plan: 0.92, implementation: 0.85, review: 0.9 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    // rankable (1) < minRecords (3): the full pool is used, and with every
    // neighbor stage-less the selection is null as before
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 3,
      minModels: 2,
      kNeighbors: 5,
    });
    // Single rankable record cannot satisfy the previous behavior contract:
    // decision may be null (no constraints configured in this fixture)
    assert.equal(decision, null);
  } finally {
    cleanup();
  }
});

test('records for disabled models never become stage candidates', () => {
  const records = [
    makeEvalRecord('d1', 'gpt-5.3-codex', { plan: 0.99, implementation: 0.99, review: 0.99 }),
    makeEvalRecord('d2', 'gpt-5.3-codex', { plan: 0.98, implementation: 0.98, review: 0.98 }),
    makeEvalRecord('a1', 'claude-opus-4-6', { plan: 0.8, implementation: 0.8, review: 0.8 }),
    makeEvalRecord('a2', 'claude-opus-4-6', { plan: 0.81, implementation: 0.79, review: 0.8 }),
    makeEvalRecord('b1', 'claude-sonnet-4-5-20250929', { plan: 0.7, implementation: 0.72, review: 0.7 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 5,
    });
    assert.ok(decision);
    // gpt-5.3-codex has the best historical scores but is disabled
    assert.notEqual(decision?.planner, 'gpt-5.3-codex');
    assert.notEqual(decision?.coder, 'gpt-5.3-codex');
    assert.notEqual(decision?.reviewer, 'gpt-5.3-codex');
    assert.equal(decision?.planner, 'claude-opus-4-6');
  } finally {
    cleanup();
  }
});



function recencyBoostRepo(multiplier: number, windowDays = 45) {
  const records = [
    makeEvalRecord('a1', 'claude-opus-4-6', { plan: 0.9, implementation: 0.9, review: 0.9 }),
    makeEvalRecord('a2', 'claude-opus-4-6', { plan: 0.91, implementation: 0.89, review: 0.9 }),
    makeEvalRecord('b1', 'claude-sonnet-5', { plan: 0.8, implementation: 0.8, review: 0.8 }),
    makeEvalRecord('b2', 'claude-sonnet-5', { plan: 0.81, implementation: 0.79, review: 0.8 }),
    makeEvalRecord('c1', 'claude-sonnet-4-5-20250929', { plan: 0.7, implementation: 0.7, review: 0.7 }),
    makeEvalRecord('c2', 'claude-sonnet-4-5-20250929', { plan: 0.71, implementation: 0.69, review: 0.7 }),
  ];
  return makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
      exploration: {
        enabled: true,
        mode: 'epsilon',
        rate: 0.9,
        topK: 3,
        newModelBoost: { windowDays, multiplier },
      },
    },
  });
}

// Explore only the planner: rate 0.9, rolls [explore, pick, skip, skip]
const recencySequence = () => {
  const values = [0, 0.6, 0.95, 0.95];
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

// Keep these tests independent of the calendar: Sonnet 5 was released on
// 2026-06-30, so this fixed clock places it squarely inside the 45-day window.
const recencyTestNow = Date.UTC(2026, 6, 1);

test('recency boost steers exploration toward recently released models', () => {
  const { repoDir, cleanup } = recencyBoostRepo(5);
  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      randomFn: recencySequence(),
      nowMs: recencyTestNow,
    });
    assert.ok(decision);
    // Boosted weights [~5, 1]: the 0.6 roll lands on the recent runner-up
    assert.equal(decision?.planner, 'claude-sonnet-5');
    assert.equal(decision?.exploration?.explored[0]?.recencyBoosted, true);
    assert.ok(decision?.reasoning[0].includes('[recency-boosted]'));
  } finally {
    cleanup();
  }
});

test('the same roll without the boost picks the older alternative', () => {
  const { repoDir, cleanup } = recencyBoostRepo(1);
  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      randomFn: recencySequence(),
      nowMs: recencyTestNow,
    });
    assert.ok(decision);
    // Uniform weights [1, 1]: the 0.6 roll lands on the second alternative
    assert.equal(decision?.planner, 'claude-sonnet-4-5-20250929');
    assert.ok(!decision?.exploration?.explored[0]?.recencyBoosted);
  } finally {
    cleanup();
  }
});

test('models outside the recency window get no boost', () => {
  const { repoDir, cleanup } = recencyBoostRepo(5, 1);
  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 6,
      randomFn: recencySequence(),
      nowMs: recencyTestNow,
    });
    assert.ok(decision);
    // A one-day global recency window makes this identical to the no-boost outcome.
    assert.equal(decision?.planner, 'claude-sonnet-4-5-20250929');
  } finally {
    cleanup();
  }
});


console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
