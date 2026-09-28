import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import {
  getStageAwareRouterDebugState,
  resetStageAwareRouterDebugState,
} from './stage-aware-router.ts';
import { routeBatch, routeExpandedPackets, tasksFromPlan } from './route-batch.ts';
import { routeWorkflowAuto } from './workflow-router.ts';
import { withResolvedRouteBudget } from './route-artifact.ts';
import { readRouteDecisions } from './route-decision.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function baseConfig(mode: 'auto' | 'stage-aware' = 'auto') {
  return {
    router: {
      enabled: true,
      mode,
      minRecords: 1,
      minModels: 1,
      kNeighbors: 10,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
    },
    eval: {
      pricing: {
        'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.4': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.5': { inputCostPerMTok: 5, outputCostPerMTok: 30, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      },
    },
  };
}

function makeEvalRecord(id: string, modelId: string, timestamp: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: 'Build backend routing flow with tests',
    modelId,
    modelVersion: modelId,
    score: modelId.includes('haiku') ? 0.72 : 0.9,
    scoreBand: 'good',
    timeSeconds: 120,
    timestamp,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'solid',
    metadata: {
      stageScores: {
        expansion: { score: 0.8, rationale: 'ok' },
        plan: { score: modelId.includes('haiku') ? 0.7 : 0.9, rationale: 'ok' },
        implementation: { score: modelId.includes('haiku') ? 0.72 : 0.91, rationale: 'ok' },
        review: { score: modelId.includes('haiku') ? 0.71 : 0.89, rationale: 'ok' },
      },
    },
    workflowCost: modelId.includes('haiku') ? 1.2 : 4.5,
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 5,
          repo_size_loc: 10000,
          description_tokens: 160,
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
        planner: { model: modelId, cost_usd: modelId.includes('haiku') ? 0.2 : 0.8 },
        coder: { model: modelId, cost_usd: modelId.includes('haiku') ? 0.8 : 3.0 },
        reviewer: { model: modelId, cost_usd: modelId.includes('haiku') ? 0.2 : 0.7 },
      },
    },
  };
}

function writeQuotaState(repoDir: string, models: Record<string, 'healthy' | 'degrading' | 'exhausted'>) {
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-29T12:00:00.000Z',
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
  }, null, 2));
}

function makeRepo(mode: 'auto' | 'stage-aware' = 'auto') {
  const repoDir = mkdtempSync(join(tmpdir(), 'route-batch-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(baseConfig(mode)));
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), [
    JSON.stringify(makeEvalRecord('1', 'gpt-5.3-codex', '2026-04-20T00:00:00.000Z')),
    JSON.stringify(makeEvalRecord('2', 'claude-sonnet-5', '2026-04-21T00:00:00.000Z')),
    JSON.stringify(makeEvalRecord('3', 'claude-haiku-4-5-20251001', '2026-04-22T00:00:00.000Z')),
  ].join('\n') + '\n');
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

// Batch routing additionally mints a route decision (HOK-3098) and pins the
// decided route; serial router calls do neither.
function withoutProvenance<T extends { provenance?: unknown; routeDecision?: unknown; preEscalationRoute?: unknown }>(decision: T) {
  const {
    provenance: _provenance,
    routeDecision: _routeDecision,
    preEscalationRoute: _preEscalationRoute,
    ...rest
  } = decision;
  return rest;
}

console.log('\n--- route-batch Tests ---\n');

await test('batch decisions match serial auto routing and reuse eval loading', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  const tasks = [
    { issueId: 'HOK-1', prompt: 'Build routing batch command with tests' },
    { issueId: 'HOK-2', prompt: 'Optimize startup routing path' },
    { issueId: 'HOK-3', prompt: 'Persist batch route cache for launch flow' },
  ];

  try {
    resetStageAwareRouterDebugState();
    const batchResults = await routeBatch(tasks, { repoDir, mode: 'auto', additionalEvalsPaths: [] });
    const batchLoads = getStageAwareRouterDebugState().evalLoadCount;

    resetStageAwareRouterDebugState();
    const serialDecisions = [];
    for (const task of tasks) {
      serialDecisions.push(await routeWorkflowAuto(task.prompt, { repoDir, additionalEvalsPaths: [] }));
    }
    const serialLoads = getStageAwareRouterDebugState().evalLoadCount;

    assert.equal(batchResults.length, tasks.length);
    assert.equal(batchLoads, 1);
    assert.equal(serialLoads, tasks.length);
    assert.deepEqual(
      batchResults.map(({ decision }) => withoutProvenance(decision)),
      serialDecisions.map((decision) => withoutProvenance(withResolvedRouteBudget(decision, { repoDir }))),
    );
    for (const { decision } of batchResults) {
      assert.ok(decision.provenance);
      assert.equal(decision.provenance?.source, 'live');
      assert.equal(decision.provenance?.inputKind, 'issue');
      assert.match(decision.provenance?.inputHash || '', /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(
      batchResults.map(({ task }) => task.issueId),
      tasks.map(({ issueId }) => issueId),
    );
  } finally {
    cleanup();
  }
});

await test('auto batch uses constrained degraded routing for every task', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const results = await routeBatch([
      { issueId: 'HOK-10', prompt: 'Implement routing panel cache' },
      { issueId: 'HOK-11', prompt: 'Add batch launch fallback handling' },
    ], { repoDir, mode: 'auto', operatingMode: 'constrained', additionalEvalsPaths: [] });

    for (const { decision } of results) {
      assert.match(decision.reasoning[0] || '', /Constrained mode:/);
      assert.doesNotMatch(decision.planner, /gpt-5\.3-codex|opus/i);
      assert.doesNotMatch(decision.coder, /gpt-5\.3-codex|opus/i);
      assert.doesNotMatch(decision.reviewer, /gpt-5\.3-codex|opus/i);
    }
  } finally {
    cleanup();
  }
});

await test('auto batch uses survival degraded routing for every task', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const results = await routeBatch([
      { issueId: 'HOK-20', prompt: 'Recover routing with reduced model pool' },
      { issueId: 'HOK-21', prompt: 'Route selected tasks under quota pressure' },
    ], { repoDir, mode: 'auto', operatingMode: 'survival', additionalEvalsPaths: [] });

    for (const { decision } of results) {
      assert.match(decision.reasoning[0] || '', /Survival mode:/);
      assert.match(decision.planner, /haiku/i);
      assert.match(decision.coder, /haiku/i);
      assert.match(decision.reviewer, /haiku/i);
    }
  } finally {
    cleanup();
  }
});

await test('batch rejects missing files', async () => {
  await assert.rejects(
    routeBatch([{ issueId: 'HOK-404', file: '/tmp/does-not-exist-route-batch.md' }], { repoDir: process.cwd(), mode: 'auto' }),
    /ENOENT|no such file/i,
  );
});

await test('file-based task includes provenance path/hash and stable hash', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  const packetPath = join(repoDir, 'task-packet.md');
  writeFileSync(packetPath, 'Persist route provenance and input hash.\n');
  try {
    const [first] = await routeBatch([{ issueId: 'HOK-1511', file: packetPath }], { repoDir, mode: 'auto', additionalEvalsPaths: [] });
    const [second] = await routeBatch([{ issueId: 'HOK-1511', file: packetPath }], { repoDir, mode: 'auto', additionalEvalsPaths: [] });
    assert.equal(first.decision.provenance?.source, 'expanded');
    assert.equal(first.decision.provenance?.inputKind, 'task-packet');
    assert.equal(first.decision.provenance?.inputPath, packetPath);
    assert.match(first.decision.provenance?.inputHash || '', /^[a-f0-9]{64}$/);
    assert.equal(first.decision.provenance?.inputHash, second.decision.provenance?.inputHash);
  } finally {
    cleanup();
  }
});

await test('tasksFromPlan preserves task model as workspaceSelector', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  const packetPath = join(repoDir, 'plan-task-packet.md');
  writeFileSync(packetPath, 'Plan packet\n');
  try {
    const tasks = tasksFromPlan({
      tasks: [
        {
          issue: 'HOK-1635',
          taskPacketFile: packetPath,
          model: 'haiku',
          parentResolvedModel: 'claude-opus-4-7',
        },
        {
          issue: 'HOK-1636',
          prompt: 'Route inline task',
        },
      ],
    });

    assert.equal(tasks[0]?.workspaceSelector, 'haiku');
    assert.equal(tasks[0]?.parentResolvedModel, 'claude-opus-4-7');
    assert.equal(tasks[0]?.file, packetPath);
    assert.equal(tasks[1]?.workspaceSelector, undefined);
  } finally {
    cleanup();
  }
});

await test('routeBatch resolves inherit selectors from the parentResolvedModel option', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const [result] = await routeBatch([
      {
        issueId: 'HOK-1634',
        prompt: 'Preserve inherited routing across nested subagents',
        modelSelector: 'inherit',
      },
    ], {
      repoDir,
      mode: 'auto',
      parentResolvedModel: 'claude-haiku-4-5-20251001',
      additionalEvalsPaths: [],
    });

    assert.equal(result.decision.coder, 'claude-haiku-4-5-20251001');
  } finally {
    cleanup();
  }
});

await test('routeBatch keeps explicit per-task selectors over inherited parent models', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const [result] = await routeBatch([
      {
        issueId: 'HOK-1635',
        prompt: 'Preserve explicit routing in batch tasks',
        modelSelector: 'opus',
      },
    ], {
      repoDir,
      mode: 'auto',
      parentResolvedModel: 'claude-haiku-4-5-20251001',
      additionalEvalsPaths: [],
    });

    assert.equal(result.decision.coder, 'claude-opus-4-8');
  } finally {
    cleanup();
  }
});

await test('routeBatch embeds a route decision even without a feature dir', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const [result] = await routeBatch([
      { issueId: 'HOK-3098', prompt: 'Record the route decision for this task' },
    ], { repoDir, mode: 'auto', additionalEvalsPaths: [] });

    const record = result.decision.routeDecision;
    assert.ok(record);
    assert.equal(record.kind, 'route_decision');
    assert.equal(record.source, 'local');
    assert.match(record.decision_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(record.recommended, {
      planner: result.decision.planner,
      coder: result.decision.coder,
      reviewer: result.decision.reviewer,
    });
  } finally {
    cleanup();
  }
});

await test('routeBatch persists the decision to the feature dir keyed off the traceId', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const featureDir = join(repoDir, 'features', 'hok-3098');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.trace-context.json'), JSON.stringify({
      schemaVersion: '1.0',
      traceId: 'trace-batch-1',
      issueId: 'HOK-3098',
      slug: 'hok-3098',
      createdAt: '2026-09-28T00:00:00.000Z',
    }));

    const [result] = await routeBatch([
      { issueId: 'HOK-3098', prompt: 'Record the route decision for this task', featureDir },
    ], { repoDir, mode: 'auto', additionalEvalsPaths: [] });

    assert.equal(result.decision.routeDecision?.decision_id, 'trace-batch-1');
    const recorded = await readRouteDecisions(featureDir);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0], result.decision.routeDecision);
  } finally {
    cleanup();
  }
});

await test('routeBatch records the recommendation before a workspace selector override', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const [result] = await routeBatch([
      {
        issueId: 'HOK-3098',
        prompt: 'Preserve explicit routing in batch tasks',
        modelSelector: 'opus',
      },
    ], { repoDir, mode: 'auto', additionalEvalsPaths: [] });

    assert.equal(result.decision.coder, 'claude-opus-4-8');
    assert.notEqual(result.decision.routeDecision?.recommended.coder, 'claude-opus-4-8');
    assert.equal(result.decision.routeDecision?.recommended.coder, result.decision.preEscalationRoute?.coder);
  } finally {
    cleanup();
  }
});

await test('expanded reroute records a superseding decision and replays cache hits idempotently', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const featureDir = join(repoDir, 'features', 'hok-3098-expanded');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.trace-context.json'), JSON.stringify({
      schemaVersion: '1.0',
      traceId: 'trace-expanded',
      issueId: 'HOK-3098',
      slug: 'hok-3098-expanded',
      createdAt: '2026-09-28T00:00:00.000Z',
    }));
    const packetFile = join(featureDir, 'task-packet.md');
    writeFileSync(packetFile, 'Expanded packet for decision recording\n');

    // Initial launch route, then the post-expansion re-route.
    await routeBatch([{ issueId: 'HOK-3098', prompt: 'Initial launch route', featureDir }], {
      repoDir, mode: 'auto', additionalEvalsPaths: [],
    });
    const first = await routeExpandedPackets([{ issueId: 'HOK-3098', featureDir, packetFile }], {
      repoDir, mode: 'auto', additionalEvalsPaths: [],
    });
    const second = await routeExpandedPackets([{ issueId: 'HOK-3098', featureDir, packetFile }], {
      repoDir, mode: 'auto', additionalEvalsPaths: [],
    });

    assert.equal(first[0]?.cache_hit, false);
    assert.equal(second[0]?.cache_hit, true);
    const recorded = await readRouteDecisions(featureDir);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].decision_id, 'trace-expanded');
    assert.equal(recorded[1].trace_id, 'trace-expanded');
    assert.equal(recorded[1].supersedes, 'trace-expanded');
    assert.equal(first[0]?.decision?.routeDecision?.decision_id, recorded[1].decision_id);
  } finally {
    cleanup();
  }
});

await test('expanded reroute batches misses and loads shared context once', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const packetFiles = ['a', 'b', 'c'].map((suffix) => {
      const packetFile = join(repoDir, `${suffix}-task-packet.md`);
      writeFileSync(packetFile, `Packet ${suffix}\n`);
      return packetFile;
    });

    resetStageAwareRouterDebugState();
    const results = await routeExpandedPackets(packetFiles.map((packetFile, index) => ({
      issueId: `HOK-${index + 100}`,
      packetFile,
      outputFile: join(repoDir, `output-${index}.json`),
    })), { repoDir, mode: 'auto', additionalEvalsPaths: [] });

    assert.equal(results.length, 3);
    assert.equal(getStageAwareRouterDebugState().evalLoadCount, 1);
    for (const result of results) {
      assert.equal(result.route_source, 'batch');
      assert.equal(result.cache_hit, false);
      assert.ok(result.decision);
    }
  } finally {
    cleanup();
  }
});

await test('expanded reroute reuses cache and skips router for unchanged packets', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const packetFile = join(repoDir, 'cached-task-packet.md');
    writeFileSync(packetFile, 'Cached packet\n');

    const first = await routeExpandedPackets([{ issueId: 'HOK-200', packetFile }], {
      repoDir,
      mode: 'auto',
      additionalEvalsPaths: [],
    });
    assert.equal(first[0]?.route_source, 'single');

    resetStageAwareRouterDebugState();
    const second = await routeExpandedPackets([{ issueId: 'HOK-200', packetFile }], {
      repoDir,
      mode: 'auto',
      additionalEvalsPaths: [],
    });
    assert.equal(second[0]?.route_source, 'cache');
    assert.equal(second[0]?.cache_hit, true);
    assert.equal(getStageAwareRouterDebugState().evalLoadCount, 0);
  } finally {
    cleanup();
  }
});

await test('expanded reroute falls back to single-task routing after batch failure', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const packetFiles = ['a', 'b'].map((suffix) => {
      const packetFile = join(repoDir, `${suffix}-fallback-task-packet.md`);
      writeFileSync(packetFile, `Packet ${suffix}\n`);
      return packetFile;
    });

    const results = await routeExpandedPackets(packetFiles.map((packetFile, index) => ({
      issueId: `HOK-${index + 300}`,
      packetFile,
    })), {
      repoDir,
      mode: 'auto',
      additionalEvalsPaths: [],
      async routeBatchImpl(tasks, options) {
        if (tasks.length > 1) {
          throw new Error('simulated batch failure');
        }
        return routeBatch(tasks, options);
      },
    });

    for (const result of results) {
      assert.equal(result.route_source, 'single');
      assert.ok(result.decision);
    }
  } finally {
    cleanup();
  }
});

await test('expanded reroute retries only missing batch results individually', async () => {
  const { repoDir, cleanup } = makeRepo('auto');
  try {
    const packetFiles = ['a', 'b', 'c'].map((suffix) => {
      const packetFile = join(repoDir, `${suffix}-partial-task-packet.md`);
      writeFileSync(packetFile, `Packet ${suffix}\n`);
      return packetFile;
    });

    const results = await routeExpandedPackets(packetFiles.map((packetFile, index) => ({
      issueId: `HOK-${index + 400}`,
      packetFile,
    })), {
      repoDir,
      mode: 'auto',
      additionalEvalsPaths: [],
      async routeBatchImpl(tasks, options) {
        const routed = await routeBatch(tasks, options);
        if (tasks.length > 1) {
          return routed.slice(0, 2);
        }
        return routed;
      },
    });

    assert.equal(results.filter((result) => result.route_source === 'batch').length, 2);
    assert.equal(results.filter((result) => result.route_source === 'single').length, 1);
    assert.equal(results.filter((result) => result.error).length, 0);
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
