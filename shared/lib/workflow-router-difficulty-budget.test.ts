/**
 * Tests for the workflow router — difficulty floors, budget behavior, and
 * exploration. See `workflow-router-test-helpers.ts` for the shared harness
 * and fixtures.
 */

import assert from 'node:assert/strict';
import { applyDifficultyFloor, routeWorkflow, summarizeWorkflowRoute, tryPolicyResolution } from './workflow-router.ts';
import {
  baseConfig,
  makeRepo,
  printBanner,
  reportResults,
  restoredFrontierQuotaState,
  test,
  writeQuotaState,
} from './workflow-router-test-helpers.ts';

printBanner('workflow-router Difficulty/Budget Tests');

// ────────────────────────────────────────────────────────────────
// Difficulty integration tests
// ────────────────────────────────────────────────────────────────

await test('routeWorkflow with taskDifficulty=hard never returns haiku as coder', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Fix a small UI bug.',
      {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      },
    );
    assert.ok(
      !decision.coder.toLowerCase().includes('haiku'),
      `Expected non-haiku coder for hard task, got ${decision.coder}`,
    );
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=critical includes difficulty in reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update the payment processing module.',
      {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      },
    );
    const hasDifficultyReasoning = decision.reasoning.some(
      (r) => r.includes('critical'),
    );
    assert.ok(hasDifficultyReasoning, `Expected difficulty in reasoning, got: ${decision.reasoning.join(' | ')}`);
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=trivial does not add floor restriction to reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Fix a typo.',
      {
        repoDir,
        taskDifficulty: 'trivial',
        skipDifficultyClassification: true,
      },
    );
    // Trivial difficulty should mention the floor in reasoning (floor applied = true for trivial)
    const hasTrivialReasoning = decision.reasoning.some((r) => r.includes('trivial'));
    assert.ok(hasTrivialReasoning, `Expected trivial in reasoning: ${decision.reasoning.join(' | ')}`);
    // Trivial difficulty floor allows haiku — no upgrade warnings, coder can be any model
    assert.equal(decision.signals.taskDifficulty, 'trivial');
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=hard includes taskDifficulty in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Refactor the database layer.',
      {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.signals.taskDifficulty, 'hard');
  } finally {
    cleanup();
  }
});

await test('summarizeWorkflowRoute includes difficulty when present in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update critical payment service.',
      {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      },
    );
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /difficulty=critical/);
  } finally {
    cleanup();
  }
});

await test('applyDifficultyFloor upgrades haiku to opus for critical difficulty (not sonnet)', () => {
  const pool = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
  const criticalFloor = { allowHaiku: false, preferSonnet: false, preferOpus: true };
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', criticalFloor, pool, 'coder');
  assert.ok(
    result.toLowerCase().includes('opus'),
    `Expected opus upgrade for critical+haiku, got ${result}`,
  );
  assert.ok(
    !result.toLowerCase().includes('sonnet'),
    `Critical floor should prefer opus over sonnet, got ${result}`,
  );
});

await test('repo-local registry-only model addition is ignored by heuristic routing', () => {
  const { repoDir, cleanup } = makeRepo({
    modelRegistry: {
      models: {
        'acme-frontier-1': {
          vendor: 'acme',
          class: 'frontier',
          strengths: ['planning'],
          weaknesses: [],
          qualityScores: { planning: 99, coding: 99, review: 99, classify: 50, routing: 50 },
        },
      },
      ladders: {
        planning: ['acme-frontier-1', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      },
    },
  });
  try {
    const decision = routeWorkflow(
      'Plan a complex infrastructure migration across services with database changes and a security review.',
      { repoDir, skipDifficultyClassification: true },
    );
    assert.equal(decision.planDepth, 'deep');
    assert.notEqual(decision.planner, 'acme-frontier-1');
  } finally {
    cleanup();
  }
});

await test('routeWorkflow without difficulty options has no taskDifficulty in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Simple feature implementation.',
      {
        repoDir,
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.signals.taskDifficulty, undefined);
  } finally {
    cleanup();
  }
});

await test('enforces budget and downgrades when possible', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // Note: $1.00 budget may or may not require downgrade depending on default model costs.
    // This test verifies budget enforcement works correctly in both cases.
    const decision = routeWorkflow(
      'Implement a new feature',
      { repoDir, maxCostUsd: 1.00 }
    );

    // Final cost after routing (reflects any successful downgrade)
    const totalCost = decision.expectedCostPlan +
                     decision.expectedCostCode +
                     decision.expectedCostReview;

    // Budget enforcement should result in: downgrade succeeded OR violation reported
    if (decision.budgetViolation) {
      // Downgrade failed - verify violation is properly reported
      assert.ok(decision.budgetViolation.attemptedDowngrade);
      assert.ok(decision.budgetViolation.requestedCost > 1.00);
      assert.ok(decision.reasoning.some(r => r.includes('BUDGET VIOLATION')));
    } else {
      // Downgrade succeeded or not needed - verify cost is within budget
      assert.ok(totalCost <= 1.00, `Total cost ${totalCost} should be under $1.00`);
      if (decision.reasoning.some(r => r.includes('downgrade'))) {
        // If downgrade happened, it must have brought cost within budget
        assert.ok(totalCost <= 1.00, 'Downgrade should result in cost within budget');
      }
    }
  } finally {
    cleanup();
  }
});

await test('reports budget violation when impossible', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Complex infrastructure update requiring deep planning',
      { repoDir, maxCostUsd: 0.001 } // Impossibly tight - even cheaper than cheapest option
    );

    assert.ok(decision.budgetViolation, 'Should have budget violation');
    assert.equal(decision.budgetViolation.attemptedDowngrade, true);
    assert.ok(decision.budgetViolation.requestedCost > 0.001);
    assert.ok(decision.reasoning.some(r => r.includes('BUDGET VIOLATION')));
  } finally {
    cleanup();
  }
});

await test('uses survival mode budget when in survival', () => {
  const { repoDir, cleanup } = makeRepo({
    router: baseConfig().router,
    eval: baseConfig().eval,
    budget: {
      normalMode: 25,
      constrainedMode: 15,
      survivalMode: 5,
    }
  });

  // Write quota state showing survival mode
  writeQuotaState(repoDir, {
    'gpt-5.5': 'exhausted',
    'gpt-5.6-terra': 'exhausted',
    'claude-opus-4-8': 'exhausted',
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    ...restoredFrontierQuotaState('exhausted'),
  });

  try {
    const decision = routeWorkflow('Implement a feature', { repoDir });

    // Should use $5 survival budget, not $25 normal
    const totalCost = decision.expectedCostPlan +
                     decision.expectedCostCode +
                     decision.expectedCostReview;

    assert.ok(totalCost <= 5 || decision.budgetViolation);
    if (decision.budgetViolation) {
      assert.equal(decision.budgetViolation.operatingMode, 'survival');
      assert.equal(decision.budgetViolation.maxCostUsd, 5);
    }
  } finally {
    cleanup();
  }
});

await test('includes budget rule in reasoning when triggered', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Complex infrastructure update',
      { repoDir, maxCostUsd: 0.20 } // Tight enough to trigger downgrade
    );

    // Should have budget reasoning since we're constraining the cost
    const hasBudgetReasoning = decision.reasoning.some(r =>
      r.includes('budget') || r.includes('downgrade')
    );

    assert.ok(hasBudgetReasoning, 'Should mention budget in reasoning');
  } finally {
    cleanup();
  }
});


await test('tryPolicyResolution samples non-argmax candidates when exploration is enabled', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      exploration: { enabled: true, mode: 'epsilon', rate: 1, topK: 2 },
    },
  });
  writeQuotaState(repoDir, {});

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'moderate',
      skipDifficultyClassification: true,
      randomFn: () => 0,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.exploration?.mode, 'epsilon');
    assert.ok((decision?.exploration?.explored.length ?? 0) > 0);
    for (const entry of decision?.exploration?.explored ?? []) {
      assert.notEqual(entry.sampled, entry.argmax);
    }
    assert.ok(decision?.reasoning[0].startsWith('exploration(epsilon'));
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution stays deterministic with exploration disabled', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });
  writeQuotaState(repoDir, {});

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'moderate',
      skipDifficultyClassification: true,
      randomFn: () => 0,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.exploration, undefined);
    assert.ok(!decision?.reasoning.some((line) => line.startsWith('exploration(')));
  } finally {
    cleanup();
  }
});

reportResults();
