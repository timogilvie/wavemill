/**
 * Tests for the workflow router — Hokusai routing and escalation thresholds.
 * See `workflow-router-test-helpers.ts` for the shared harness and fixtures.
 */

import assert from 'node:assert/strict';
import { routeWorkflowAuto, routeWorkflowHokusai } from './workflow-router.ts';
import {
  baseConfig,
  makeRepo,
  mockHokusaiFetch,
  originalFetch,
  printBanner,
  reportResults,
  test,
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

await test('low expected success escalates cheap hokusai coder when budget allows', async () => {
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

  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    confidence: 0.8,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.outcome, 'escalated');
    assert.equal(decision.provenance?.escalation?.initialRoute.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.finalRoute.coder, decision.coder);
    assert.deepEqual(
      decision.provenance?.escalation?.triggers.map((trigger) => trigger.metric),
      ['expectedSuccess'],
    );
    assert.ok(decision.provenance?.escalation?.finalRoute.cost ?? Infinity <= 25);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('low confidence independently escalates when expected success is above floor', async () => {
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

  mockHokusaiFetch({
    estimated_success_under_budget: 0.8,
    confidence: 0.29,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.outcome, 'escalated');
    assert.deepEqual(
      decision.provenance?.escalation?.triggers.map((trigger) => trigger.metric),
      ['confidence'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('low success at budget ceiling keeps original route and records affordability reason', async () => {
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

  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    estimated_cost_usd: 0.01,
    confidence: 0.8,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 0.01,
    });
    assert.equal(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation?.outcome, 'no_affordable_stronger_candidate');
    assert.match(decision.provenance?.escalation?.reason ?? '', /budget/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('escalation floors are strict and do not trigger at equality', async () => {
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

  mockHokusaiFetch({
    estimated_success_under_budget: 0.5,
    confidence: 0.4,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.equal(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('escalation can be disabled by router config', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      escalation: { enabled: false },
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  mockHokusaiFetch({
    estimated_success_under_budget: 0.3,
    confidence: 0.29,
  });

  try {
    const decision = await routeWorkflowAuto('Fix a backend routing bug with tests.', {
      repoDir,
      maxCostUsd: 25,
    });
    assert.equal(decision.coder, 'claude-haiku-4-5-20251001');
    assert.equal(decision.provenance?.escalation, undefined);
  } finally {
    globalThis.fetch = originalFetch;
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

reportResults();
