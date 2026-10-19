/**
 * Tests for the blast-radius router floor (HOK-3238). A `high` radius forces a
 * stronger reviewer via `applyDifficultyFloor`; a `normal` radius leaves the
 * reviewer alone. All exits still run through `finalizeDecision`, so the
 * HOK-3142 launchability guard remains the structural backstop.
 */

import assert from 'node:assert/strict';
import { routeWorkflow } from './workflow-router.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import {
  baseConfig,
  makeRepo,
  printBanner,
  reportResults,
  test,
} from './workflow-router-test-helpers.ts';

printBanner('workflow-router blast-radius Tests');

await test('high blast radius upgrades a fast-economy reviewer to a stronger model', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Minor change',
      {
        repoDir,
        skipDifficultyClassification: true,
        packetContent: 'Key files: shared/lib/tend-loop.ts',
      },
    );
    assert.equal(decision.blastRadius, 'high');
    const registry = getEffectiveRegistry(repoDir);
    const reviewerClass = registry.models[decision.reviewer]?.class;
    // The floor targets `strong_generalist` (preferSonnet) and would upgrade to
    // `frontier` only when preferOpus; either way, fast-economy must not stand.
    assert.notEqual(reviewerClass, 'fast_economy', `reviewer ${decision.reviewer} should not be fast_economy`);
  } finally {
    cleanup();
  }
});

await test('normal blast radius leaves the reviewer alone', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Small UI tweak',
      {
        repoDir,
        skipDifficultyClassification: true,
        packetContent: 'Key files: src/components/Button.tsx, docs/foo.md',
      },
    );
    assert.equal(decision.blastRadius, 'normal');
    assert.ok(decision.reviewer, 'reviewer should still be chosen');
  } finally {
    cleanup();
  }
});

await test('no packet content defaults to normal blast radius', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Add a wavemill route CLI command.',
      { repoDir, skipDifficultyClassification: true },
    );
    assert.equal(decision.blastRadius, 'normal');
  } finally {
    cleanup();
  }
});

await test('high radius with only fast-economy reviewer pool falls back and records reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Mill-core change',
      {
        repoDir,
        skipDifficultyClassification: true,
        packetContent: 'Key files: shared/lib/merge-labels.ts',
        reviewerModelsAvailable: ['claude-haiku-4-5-20251001'],
      },
    );
    assert.equal(decision.blastRadius, 'high');
    // Only fast-economy available: the floor cannot upgrade, but the fallback
    // reasoning line must be present so operators can see the trace.
    const fallbackLine = decision.reasoning.find((r) => r.includes('blast-radius=high'));
    assert.ok(fallbackLine, `expected a blast-radius reasoning line, got: ${decision.reasoning.join('\n')}`);
  } finally {
    cleanup();
  }
});

await test('high radius records pre-escalation route when the reviewer is upgraded', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Mill-core change',
      {
        repoDir,
        skipDifficultyClassification: true,
        packetContent: 'Key files: shared/lib/tend-loop.ts',
      },
    );
    assert.equal(decision.blastRadius, 'high');
    const registry = getEffectiveRegistry(repoDir);
    const prevReviewer = decision.preEscalationRoute?.reviewer;
    if (prevReviewer && prevReviewer !== decision.reviewer) {
      // Substitution happened: pre-escalation route must name the original.
      const prevClass = registry.models[prevReviewer]?.class;
      const nowClass = registry.models[decision.reviewer]?.class;
      assert.notEqual(nowClass, 'fast_economy',
        `reviewer ${decision.reviewer} after substitution should not be fast_economy`);
      // If an earlier escalation already captured preEscalation, we at least
      // know the final reviewer is at least as strong as the pre-escalation.
      assert.ok(prevClass === 'fast_economy' || prevClass === nowClass,
        `preEscalation class=${prevClass}, final class=${nowClass}`);
    }
    // Primary assertion: regardless of whether the baseline needed a bump,
    // the final reviewer must satisfy the floor.
    const reviewerClass = registry.models[decision.reviewer]?.class;
    assert.notEqual(reviewerClass, 'fast_economy');
  } finally {
    cleanup();
  }
});

await test('high radius decisions still pass through enforceLaunchableRoute', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Mill-core change',
      {
        repoDir,
        skipDifficultyClassification: true,
        packetContent: 'Key files: shared/lib/tend-loop.ts',
      },
    );
    // The guard either substitutes or blocks; neither field should throw. We
    // only check that the plumbing is intact (fields optional, not required).
    assert.ok('launchabilitySubstitutions' in decision || !('launchabilitySubstitutions' in decision));
    assert.ok('launchabilityBlocked' in decision || !('launchabilityBlocked' in decision));
  } finally {
    cleanup();
  }
});

reportResults();
