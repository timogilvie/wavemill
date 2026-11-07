/**
 * Tests for the workflow router — Hokusai routing and escalation thresholds.
 * See `workflow-router-test-helpers.ts` for the shared harness and fixtures.
 */

import assert from 'node:assert/strict';
import { deriveRoutingObjectiveForIssue } from './routing-objective-split.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';
import { routeWorkflowAuto, routeWorkflowHokusai } from './workflow-router.ts';
import {
  baseConfig,
  makeOpenRouterReadyRepo,
  makeRepo,
  mockHokusaiFetch,
  mockHokusaiFetchSequence,
  originalFetch,
  printBanner,
  reportResults,
  test,
  writeNativeCertificationArtifact,
} from './workflow-router-test-helpers.ts';

printBanner('workflow-router Hokusai Tests');

await test('auto mode uses hokusai first when configured', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.6-terra',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'medium',
        code_depth: 'medium',
        review_mode: 'light',
        estimated_success_under_budget: 0.88,
        estimated_cost_usd: 1.75,
        confidence: 0.81,
        rationale: 'Estimated highest_reliability strategy from 0 exact route match(es) across 40 nearest Wavemill router row(s).',
      },
    },
    metadata: {},
  }), { status: 200 });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.equal(decision.routingMode, 'hokusai');
    assert.equal(decision.coder, 'gpt-5.6-terra');
    assert.equal(decision.neighborCount, 40);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode rejects disabled hokusai model selections', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.3-codex',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'medium',
        code_depth: 'medium',
        review_mode: 'light',
        estimated_success_under_budget: 0.88,
        estimated_cost_usd: 1.75,
        confidence: 0.81,
      },
    },
    metadata: {},
  }), { status: 200 });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
    assert.notEqual(decision.coder, 'gpt-5.3-codex');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

function hokusaiRepo(routerOverrides: Record<string, unknown> = {}) {
  return makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      ...routerOverrides,
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });
}

const HAIKU = 'claude-haiku-4-5-20251001';
const OPUS = 'claude-opus-4-7';

function issueIdForObjective(objective: 'lowest_cost' | 'highest_reliability'): string {
  for (let number = 1; number <= 1000; number += 1) {
    const issueId = `HOK-${number}`;
    if (deriveRoutingObjectiveForIssue(issueId) === objective) return issueId;
  }
  throw new Error(`No test issue ID found for ${objective}`);
}

// protects: highest-reliability routing re-asks Hokusai instead of ranking coders locally (HOK-3363).
await test('low Hokusai confidence re-asks Hokusai for highest_reliability without the low-confidence coder', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  const { requests } = mockHokusaiFetchSequence([
    {
      strategy: { estimated_success_under_budget: 0.8, confidence: 0.334 },
      metadata: { request_id: 'req-1' },
      inferenceLogId: 'req-1',
    },
    {
      strategy: { coder_model: OPUS, estimated_success_under_budget: 0.82, confidence: 0.71 },
      metadata: { request_id: 'req-2' },
      inferenceLogId: 'req-2',
    },
  ]);

  try {
    const issueId = issueIdForObjective('highest_reliability');
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25, issueId });

    assert.equal(requests.length, 2, 'exactly one re-ask');
    const first = requests[0].inputs.routing ?? {};
    const reask = requests[1].inputs.routing ?? {};
    assert.equal(first.objective, 'highest_reliability');
    assert.equal(reask.objective, 'highest_reliability');
    assert.ok(Array.isArray(reask.available_coder_models) && reask.available_coder_models.length > 0);
    assert.ok(!reask.available_coder_models.includes(HAIKU), 'the low-confidence coder is excluded');
    assert.deepEqual(reask.available_planner_models, ['claude-sonnet-4-5-20250929'], 'planner pinned');
    assert.deepEqual(reask.available_reviewer_models, [HAIKU], 'reviewer pinned');

    assert.equal(decision.routingMode, 'hokusai', 'the escalated route is still Hokusai\'s decision');
    assert.equal(decision.coder, OPUS);
    assert.equal(decision.routingObjective, 'highest_reliability');
    assert.equal(decision.confidence, 0.71);
    assert.equal(decision.provenance?.inferenceLogId, 'req-1', 'the first request stays the join key');

    const coder = decision.stageRoutes?.coder;
    assert.deepEqual(coder?.hokusai, { requestId: 'req-1', recommended: HAIKU });
    assert.equal(coder?.executed, OPUS);
    assert.equal(coder?.overrides.length, 1);
    const [override] = coder!.overrides;
    assert.equal(override.source, 'escalation');
    assert.equal(override.from, HAIKU);
    assert.equal(override.to, OPUS);
    assert.equal(override.reason, 'hokusai_reask_below_floor');
    assert.ok(override.source === 'escalation');
    assert.deepEqual(override.triggers, [{ metric: 'confidence', value: 0.334, threshold: 0.4 }]);
    assert.deepEqual(override.hokusai, { requestId: 'req-2' });
    assert.equal(decision.stageRoutes?.planner.overrides.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: cheap Hokusai routes being replaced solely because their prior confidence is below the floor.
await test('lowest_cost routing keeps a low-confidence Hokusai recommendation without a re-ask', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  const { requests } = mockHokusaiFetchSequence([
    { strategy: { estimated_success_under_budget: 0.62, confidence: 0.26 } },
  ]);

  try {
    const issueId = issueIdForObjective('lowest_cost');
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25, issueId });

    assert.equal(requests.length, 1, 'lowest_cost routes never receive a confidence-floor re-ask');
    assert.equal(requests[0].inputs.routing?.objective, 'lowest_cost');
    assert.equal(decision.routingObjective, 'lowest_cost');
    assert.equal(decision.coder, HAIKU);
    assert.ok(!decision.stageRoutes?.coder.overrides.some((override) => override.reason === 'hokusai_reask_below_floor'));
    assert.ok(decision.reasoning.includes('Router escalation skipped: objective=lowest_cost exempts low-confidence routes from the re-ask.'));
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: non-task/ad-hoc routing changing Hokusai's server-default objective.
await test('ad-hoc Hokusai routing leaves objective undefined', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  const { requests } = mockHokusaiFetchSequence([
    { strategy: { estimated_success_under_budget: 0.8, confidence: 0.8 } },
  ]);

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].inputs.routing?.objective, undefined);
    assert.equal(decision.routingObjective, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: a challenge pair's primary and challenger drifting into different routing-objective arms.
await test('challenge arms share their base issue routing objective', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  const { requests } = mockHokusaiFetchSequence([
    { strategy: { estimated_success_under_budget: 0.8, confidence: 0.8 } },
    { strategy: { estimated_success_under_budget: 0.8, confidence: 0.8 } },
  ]);

  try {
    const issueId = issueIdForObjective('lowest_cost');
    const primary = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, issueId });
    const challenger = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, issueId: `${issueId}_c` });

    assert.equal(primary.routingObjective, 'lowest_cost');
    assert.equal(challenger.routingObjective, primary.routingObjective);
    assert.equal(requests[0].inputs.routing?.objective, requests[1].inputs.routing?.objective);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: the expected-success floor silently not triggering the re-ask.
await test('low expected success alone triggers the re-ask with an expectedSuccess trigger', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  const { requests } = mockHokusaiFetchSequence([
    { strategy: { estimated_success_under_budget: 0.3, confidence: 0.8 } },
    { strategy: { coder_model: OPUS, estimated_success_under_budget: 0.6, confidence: 0.8 } },
  ]);

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25 });
    assert.equal(requests.length, 2);
    assert.equal(decision.coder, OPUS);
    const override = decision.stageRoutes?.coder.overrides[0];
    assert.ok(override?.source === 'escalation');
    assert.deepEqual(override.triggers?.map((trigger) => trigger.metric), ['expectedSuccess']);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: a failed re-ask replacing Hokusai's route with a local guess.
await test('a failed re-ask keeps Hokusai\'s first route and records no override', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) throw new Error('unreachable');
    return new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'claude-sonnet-4-5-20250929',
          coder_model: HAIKU,
          reviewer_model: HAIKU,
          estimated_cost_usd: 4.55,
          estimated_success_under_budget: 0.8,
          confidence: 0.2,
        },
      },
    }), { status: 200 });
  };

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25 });
    assert.equal(calls, 2);
    assert.equal(decision.routingMode, 'hokusai');
    assert.equal(decision.coder, HAIKU);
    assert.equal(decision.stageRoutes?.coder.overrides.length, 0);
    assert.ok(decision.reasoning.some((line) => /retained claude-haiku-4-5-20251001: Hokusai re-ask returned no route/.test(line)));
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: floors triggering at equality (strict comparison).
await test('escalation floors are strict and do not trigger at equality', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  const { requests } = mockHokusaiFetchSequence([
    { strategy: { estimated_success_under_budget: 0.5, confidence: 0.4 } },
  ]);

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25 });
    assert.equal(requests.length, 1, 'no re-ask');
    assert.equal(decision.coder, HAIKU);
    assert.equal(decision.stageRoutes?.coder.overrides.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: the escalation kill switch being ignored.
await test('escalation can be disabled by router config', async () => {
  const { repoDir, cleanup } = hokusaiRepo({ escalation: { enabled: false } });
  const { requests } = mockHokusaiFetchSequence([
    { strategy: { estimated_success_under_budget: 0.3, confidence: 0.29 } },
  ]);

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25 });
    assert.equal(requests.length, 1, 'no re-ask');
    assert.equal(decision.coder, HAIKU);
    assert.equal(decision.stageRoutes?.coder.overrides.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: locally routed decisions being "escalated" by a local stronger-coder ranking.
await test('locally routed decisions never escalate, even below the floors', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      escalation: { enabled: true, expectedSuccessFloor: 1, confidenceFloor: 1 },
    },
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', { repoDir, maxCostUsd: 25 });
    assert.notEqual(decision.routingMode, 'hokusai');
    const reasons = Object.values(decision.stageRoutes ?? {}).flatMap((record) => record.overrides.map((o) => o.reason));
    assert.ok(!reasons.includes('hokusai_reask_below_floor'), reasons.join(','));
    assert.ok(!decision.reasoning.some((line) => /Router escalation/.test(line)));
  } finally {
    cleanup();
  }
});

await test('auto mode falls back to stage-aware chain without hokusai config', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
  } finally {
    cleanup();
  }
});

await test('explicit hokusai mode falls back gracefully to stage-aware', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'hokusai',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 100,
      },
    },
  });

  globalThis.fetch = async () => {
    throw new Error('unreachable');
  };

  try {
    const decision = await routeWorkflowHokusai('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

// protects: acceptance #3 — a native coder recommended by Model 30 stays the
// decided coder, resolves to the native-openrouter agent with no override, and
// the pool that was offered actually contained it (HOK-3429).
await test('a native coder recommended by Model 30 launches through native-openrouter with no override', async () => {
  // Pin the Hokusai credential in the fixture: without it the router reads the
  // developer's repo `.env` (or ambient env) locally but finds none in CI, so
  // routing falls back to heuristic and this test fails only outside a dev box.
  const { repoDir, cleanup } = makeOpenRouterReadyRepo({
    router: {
      ...baseConfig().router,
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });
  writeNativeCertificationArtifact(repoDir, 'openrouter', 'qwen-3-coder', 'v3', 'workflow');
  const { requests } = mockHokusaiFetchSequence([
    {
      strategy: {
        coder_model: 'qwen-3-coder',
        estimated_success_under_budget: 0.85,
        confidence: 0.7,
      },
    },
  ]);

  try {
    const decision = await routeWorkflowHokusai('Add a JSON export command with tests.', { repoDir, maxCostUsd: 25 });
    assert.equal(decision.routingMode, 'hokusai');
    assert.equal(decision.coder, 'qwen-3-coder');
    assert.ok(
      requests[0].inputs.routing.available_coder_models.includes('qwen-3-coder'),
      'the certified native coder must be offered to Model 30',
    );
    assert.deepEqual(decision.stageRoutes?.coder.overrides, []);

    const resolution = resolveModelAgent({ model: decision.coder, phase: 'coding', repoDir });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.agent, 'native-openrouter');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

reportResults();
