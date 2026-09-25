/**
 * Tests for the workflow router — quota-driven degraded/survival modes,
 * frontier substitution, and policy diagnostics. See
 * `workflow-router-test-helpers.ts` for the shared harness and fixtures.
 */

import assert from 'node:assert/strict';
import { routeWorkflowAuto, tryPolicyResolution } from './workflow-router.ts';
import {
  baseConfig,
  captureStderr,
  frontierSiblingConfig,
  makeRepo,
  originalFetch,
  printBanner,
  reportResults,
  restoredFrontierQuotaState,
  test,
  writeQuotaState,
} from './workflow-router-test-helpers.ts';

printBanner('workflow-router Quota/Policy Tests');

await test('auto mode uses degraded haiku-only routing in survival mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'exhausted',
    'gpt-5.6-terra': 'exhausted',
    'gpt-6-luna': 'exhausted',
    ...restoredFrontierQuotaState('exhausted'),
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    const selectedModels = [decision.planner, decision.coder, decision.reviewer];

    assert.ok(selectedModels.every((modelId) => modelId.toLowerCase().includes('haiku')));
    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('opus')));
    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('sonnet')));
    assert.match(decision.reasoning[0], /Survival mode/);
    assert.equal(typeof decision.planner, 'string');
    assert.equal(typeof decision.coder, 'string');
    assert.equal(typeof decision.reviewer, 'string');
    assert.ok(['stage-aware', 'stage-aware-partial', 'heuristic-fallback'].includes(decision.routingMode));
    assert.equal(typeof decision.neighborCount, 'number');
    assert.ok(Array.isArray(decision.neighborSimilarityRange));
  } finally {
    cleanup();
  }
});

await test('auto mode excludes opus in constrained mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    const selectedModels = [decision.planner, decision.coder, decision.reviewer];

    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('opus')));
    assert.match(decision.reasoning[0], /Constrained mode/);
  } finally {
    cleanup();
  }
});

await test('auto mode emits a constrained router transparency line when quota is degrading', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] constrained mode: claude-opus-5-5 quota is degrading; reserving it for high-complexity steps/);
    assert.ok(result.reasoning[0].includes('Constrained mode'));
  } finally {
    cleanup();
  }
});

await test('auto mode does not prepend degraded reasoning in normal mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'healthy',
    'claude-opus-4-6': 'healthy',
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.doesNotMatch(decision.reasoning[0], /Survival mode|Constrained mode/);
  } finally {
    cleanup();
  }
});

await test('auto mode stays silent in normal routing mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'healthy',
    'claude-opus-4-6': 'healthy',
  });

  try {
    const { stderr } = await captureStderr(() =>
      routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir })
    );
    assert.doesNotMatch(stderr, /\[(router|coder|planner|reviewer|classifier)]/);
  } finally {
    cleanup();
  }
});

await test('policy routing excludes retired frontier from substitution', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-5-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
    'gpt-6-sol': 'exhausted',
    'gpt-6-luna': 'exhausted',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      Promise.resolve(tryPolicyResolution(
        'Implement a backend feature with tests and review.',
        { repoDir, taskDifficulty: 'hard', skipDifficultyClassification: true }
      ))
    );
    assert.equal(result?.routingMode, 'policy');
    assert.match(stderr, /\[coder] policy adjustment: claude-fable-5 -> claude-sonnet-5 \(quota=exhausted\)/);
    assert.doesNotMatch(stderr, /gpt-5\.5/);
    assert.doesNotMatch(stderr, /same-class=frontier/);
    assert.doesNotMatch(stderr, /\[router] constrained mode:/);
  } finally {
    cleanup();
  }
});

await test('policy routing logs class downgrade without same-class metadata', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const { stderr } = await captureStderr(() =>
      Promise.resolve(tryPolicyResolution(
        'Implement a backend feature with tests and review.',
        { repoDir, taskDifficulty: 'hard', skipDifficultyClassification: true }
      ))
    );
    assert.match(stderr, /\[(planner|coder|reviewer)] policy adjustment: claude-fable-5 -> claude-sonnet-5 \(quota=degrading\)/);
    assert.doesNotMatch(stderr, /same-class=/);
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution records capability fallback rationale when constraints over-filter Layer 3', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      capabilityFiltering: {
        enabled: true,
      },
    },
  });

  writeQuotaState(repoDir, {});

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'moderate',
      skipDifficultyClassification: true,
      capabilityConstraints: {
        minContextWindow: 2_000_000,
      },
    });

    assert.equal(decision?.routingMode, 'policy');
    assert.ok(decision?.reasoning.some((line) => line.includes('Capability constraints filtered every in-pool policy candidate')));
  } finally {
    cleanup();
  }
});

await test('auto mode logs frontier substitution without constrained banner when healthy sibling exists', async () => {
  const { repoDir, cleanup } = makeRepo({
    ...frontierSiblingConfig(),
    router: {
      ...frontierSiblingConfig().router,
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        apiKey: 'test-token',
        timeout: 1000,
      },
    },
  });

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-5-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
    'gpt-6-sol': 'exhausted',
    'gpt-6-luna': 'exhausted',
  });

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      predictions: {
        recommended_strategy: {
          planner_model: 'gpt-5.6-terra',
          coder_model: 'gpt-5.6-terra',
          reviewer_model: 'gpt-5.6-terra',
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
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.equal(result.routingMode, 'hokusai');
    assert.doesNotMatch(stderr, /policy adjustment:/);
    assert.doesNotMatch(stderr, /\[router] constrained mode:/);
    assert.doesNotMatch(result.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode excludes retired frontier when anthropic frontier is exhausted', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-5-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
    'gpt-6-sol': 'exhausted',
    'gpt-6-luna': 'exhausted',
  });

  try {
    const decision = await routeWorkflowAuto('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'hard',
      skipDifficultyClassification: true,
    });
    assert.equal(decision.planner, 'gpt-5.6-terra');
    assert.equal(decision.coder, 'claude-sonnet-5');
    assert.equal(decision.reviewer, 'gpt-5.6-terra');
    assert.ok(![decision.planner, decision.coder, decision.reviewer].includes('gpt-5.5'));
    assert.doesNotMatch(decision.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution pools exclude retired frontier for all three roles', () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-5-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
    'gpt-6-sol': 'exhausted',
    'gpt-6-luna': 'exhausted',
  });

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'hard',
      skipDifficultyClassification: true,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.planner, 'gpt-5.6-terra');
    assert.equal(decision?.coder, 'claude-sonnet-5');
    assert.equal(decision?.reviewer, 'gpt-5.6-terra');
    assert.ok(![decision?.planner, decision?.coder, decision?.reviewer].includes('gpt-5.5'));
  } finally {
    cleanup();
  }
});

await test('emits supported substitutions without selecting the retired frontier in case (a)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-5-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'healthy',
    'gpt-5.6-terra': 'healthy',
    'gpt-6-sol': 'exhausted',
    'gpt-6-luna': 'exhausted',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      })
    );
    assert.equal(result.planner, 'gpt-5.6-terra');
    assert.equal(result.coder, 'claude-sonnet-5');
    assert.equal(result.reviewer, 'gpt-5.6-terra');
    assert.match(stderr, /\[planner] policy adjustment: claude-fable-5 -> gpt-5\.6-terra \(quota=exhausted\)/);
    assert.match(stderr, /\[coder] policy adjustment: claude-fable-5 -> claude-sonnet-5 \(quota=exhausted\)/);
    assert.doesNotMatch(stderr, /gpt-5\.5/);
    assert.doesNotMatch(stderr, /\[router] (constrained|survival) mode:/);
    assert.doesNotMatch(result.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    cleanup();
  }
});

await test('emits constrained-mode banner when every frontier vendor is degrading (case b)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'degrading',
    'claude-opus-4-8': 'degrading',
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.5': 'degrading',
    'gpt-5.6-terra': 'degrading',
    ...restoredFrontierQuotaState('degrading'),
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] constrained mode: .* quota is degrading; reserving it for high-complexity steps/);
    assert.ok(result.reasoning[0].includes('Constrained mode'));
    assert.doesNotMatch(stderr, /same-class=frontier/);
  } finally {
    cleanup();
  }
});

await test('emits survival-mode banner when every frontier vendor is exhausted (case c)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-fable-5': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.5': 'exhausted',
    'gpt-5.6-terra': 'exhausted',
    'gpt-6-luna': 'exhausted',
    ...restoredFrontierQuotaState('exhausted'),
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] survival mode: .* quota is exhausted; restricting routing to fast-economy models/);
    assert.ok(result.reasoning[0].includes('Survival mode'));
    assert.ok([result.planner, result.coder, result.reviewer].every((modelId) => modelId.toLowerCase().includes('haiku')));
    assert.doesNotMatch(stderr, /same-class=frontier/);
  } finally {
    cleanup();
  }
});

reportResults();
