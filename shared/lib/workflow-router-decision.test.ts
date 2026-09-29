/**
 * Tests for the route-decision capture in the workflow router (HOK-3098):
 * every route path (hokusai, fallback, local) must expose what it decided
 * before escalation, and Hokusai rejections must carry a typed reason.
 * See `workflow-router-test-helpers.ts` for the shared harness and fixtures.
 */

import assert from 'node:assert/strict';
import { buildRouteDecision, LOCAL_ROUTER_POLICY_VERSION, recommendedRouteOf } from './route-decision.ts';
import {
  routeWorkflow,
  routeWorkflowAuto,
  routeWorkflowHokusai,
  routeWorkflowStageAware,
} from './workflow-router.ts';
import {
  baseConfig,
  makeRepo,
  mockHokusaiFetch,
  originalFetch,
  printBanner,
  reportResults,
  test,
} from './workflow-router-test-helpers.ts';

printBanner('workflow-router route-decision Tests');

function hokusaiRepo() {
  return makeRepo({
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
}

await test('hokusai success: source hokusai with the Model 30 version as policy_version', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  mockHokusaiFetch({
    coder_model: 'gpt-5.6-terra',
    estimated_success_under_budget: 0.9,
    confidence: 0.9,
  }, { model_version: 'model30-2026.09' });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.equal(decision.routingMode, 'hokusai');
    assert.equal(decision.fallbackReason, undefined);

    const record = buildRouteDecision(decision, { traceId: 'trace-1' });
    assert.equal(record.source, 'hokusai');
    assert.equal(record.policy_version, 'model30-2026.09');
    assert.equal(record.recommended.coder, 'gpt-5.6-terra');
    assert.equal(record.fallback_reason, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('hokusai escalation: recommended keeps the Model 30 coder, final route has the stronger one', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    confidence: 0.8,
  }, { model_version: 'model30-2026.09' });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.equal(decision.provenance?.escalation?.outcome, 'escalated');
    assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.preEscalationRoute?.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.preEscalationRoute?.planner, 'claude-sonnet-4-5-20250929');

    // The escalation retry is a locally routed decision; the record must
    // still attribute the recommendation to Model 30.
    const record = buildRouteDecision(decision);
    assert.equal(record.source, 'hokusai');
    assert.equal(record.policy_version, 'model30-2026.09');
    assert.equal(record.recommended.coder, 'claude-haiku-4-5-20251001');
    assert.notEqual(record.recommended.coder, decision.coder);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('hokusai retained route (no stronger affordable coder) keeps recommended == final', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    confidence: 0.8,
    estimated_cost_usd: 4.55,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 0.01,
    });
    assert.notEqual(decision.provenance?.escalation?.outcome, 'escalated');
    assert.deepEqual(recommendedRouteOf(decision), {
      planner: decision.planner,
      coder: decision.coder,
      reviewer: decision.reviewer,
    });
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('hokusai null response: local route tagged fallback/null_response', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  globalThis.fetch = async () => {
    throw new Error('unreachable');
  };

  try {
    const decision = await routeWorkflowHokusai('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
    assert.equal(decision.fallbackReason, 'null_response');

    const record = buildRouteDecision(decision);
    assert.equal(record.source, 'fallback');
    assert.equal(record.fallback_reason, 'null_response');
    assert.equal(record.policy_version, LOCAL_ROUTER_POLICY_VERSION);
    assert.deepEqual(record.recommended, recommendedRouteOf(decision));
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('hokusai HTTP error is also a null_response fallback', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  globalThis.fetch = async () => new Response('boom', { status: 503 });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.equal(decision.fallbackReason, 'null_response');
    assert.equal(buildRouteDecision(decision).source, 'fallback');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('hokusai disabled model: local route tagged fallback/disabled_model', async () => {
  const { repoDir, cleanup } = hokusaiRepo();
  mockHokusaiFetch({
    coder_model: 'gpt-5.3-codex',
    estimated_success_under_budget: 0.88,
    confidence: 0.81,
  });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
    assert.equal(decision.fallbackReason, 'disabled_model');

    const record = buildRouteDecision(decision);
    assert.equal(record.source, 'fallback');
    assert.equal(record.fallback_reason, 'disabled_model');
    // The rejected Hokusai model is never recorded as the recommendation.
    assert.notEqual(record.recommended.coder, 'gpt-5.3-codex');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('local auto routing without hokusai: source local', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.equal(decision.fallbackReason, undefined);
    const record = buildRouteDecision(decision);
    assert.equal(record.source, 'local');
    assert.equal(record.policy_version, LOCAL_ROUTER_POLICY_VERSION);
    assert.deepEqual(record.recommended, recommendedRouteOf(decision));
  } finally {
    cleanup();
  }
});

await test('stage-aware and heuristic paths: source local', async () => {
  const { repoDir, cleanup } = makeRepo();

  try {
    for (const decision of [
      routeWorkflowStageAware('Build a backend feature with tests and review.', { repoDir }),
      routeWorkflow('Build a backend feature with tests and review.', { repoDir }),
    ]) {
      assert.equal(decision.fallbackReason, undefined, decision.routingMode);
      assert.equal(buildRouteDecision(decision).source, 'local', decision.routingMode);
    }
  } finally {
    cleanup();
  }
});

reportResults();
