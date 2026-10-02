/**
 * Tests for the workflow router — native certification (phase/certification
 * eligibility and provenance). See `workflow-router-test-helpers.ts` for the
 * shared harness and fixtures.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  enforceLaunchableRoute,
  routeWorkflow,
  routeWorkflowHokusai,
  STAGE_PHASE_REQUIREMENT,
} from './workflow-router.ts';
import {
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  buildGlobalCertificationPath,
} from './native-agent/certification/index.ts';
import {
  FRESH_CERTIFIED_AT,
  baseConfig,
  makeOpenRouterReadyRepo,
  makeRepo,
  mockHokusaiFetch,
  originalFetch,
  printBanner,
  reportResults,
  test,
  writeCertArtifact,
} from './workflow-router-test-helpers.ts';

printBanner('Native Certification Router Policy Tests');

await test('STAGE_PHASE_REQUIREMENT maps reviewer→read-only, coder→patch, planner→workflow', () => {
  assert.equal(STAGE_PHASE_REQUIREMENT.reviewer, 'read-only');
  assert.equal(STAGE_PHASE_REQUIREMENT.coder, 'patch');
  assert.equal(STAGE_PHASE_REQUIREMENT.planner, 'workflow');
});

await test('valid read-only cert accepted for reviewer role', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'read-only' });

    const decision = routeWorkflow('Fix a small bug in the router.', {
      repoDir,
      reviewerModelsAvailable: ['qwen-3-coder'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    // reviewer pool had a valid read-only cert — no rejection for reviewer
    const reviewerRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'reviewer');
    assert.equal(reviewerRejection, undefined, 'valid read-only cert should not be rejected for reviewer');
  } finally {
    cleanup();
  }
});

await test('valid patch cert accepted for coder and reviewer roles', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });

    const decision = routeWorkflow('Implement a feature with tests.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder'],
      reviewerModelsAvailable: ['qwen-3-coder'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const coderRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    const reviewerRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'reviewer');
    assert.equal(coderRejection, undefined, 'patch cert should not be rejected for coder');
    assert.equal(reviewerRejection, undefined, 'patch cert satisfies read-only, should not be rejected for reviewer');
  } finally {
    cleanup();
  }
});

await test('patch cert rejects planner role which requires workflow certification', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'z-ai', 'glm-5.2', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });

    const decision = routeWorkflow('Plan and implement a new auth workflow.', {
      repoDir,
      plannerModelsAvailable: ['glm-5.2', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['glm-5.2', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const plannerRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'glm-5.2' && r.role === 'planner');
    assert.ok(plannerRejection, 'patch-cert native model should be rejected for planner (requires workflow)');
    assert.equal(plannerRejection?.reason, 'insufficient-phase');
    assert.equal(plannerRejection?.requestedPhase, 'workflow');
    assert.notEqual(decision.planner, 'glm-5.2', 'planner must not be the rejected native model');
  } finally {
    cleanup();
  }
});

await test('launch-priority roleEligibility removes coding-only aliases from planner pool with diagnostics', () => {
  // mistral-medium-3 is the remaining coding-only launch-priority row
  // (qwen-2.5-coder-32b was retired by HOK-2947).
  const previousApiKey = process.env.HOK2540_OPENROUTER_KEY;
  process.env.HOK2540_OPENROUTER_KEY = 'test-openrouter-key';
  const { repoDir, cleanup } = makeRepo({
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'HOK2540_OPENROUTER_KEY',
        models: ['mistral-medium-3'],
        stages: ['planner'],
      },
    },
    modelRegistry: {
      models: {
        'mistral-medium-3': {
          class: 'strong_generalist',
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FRESH_CERTIFIED_AT,
              certificationSuiteVersion: 'v1',
            },
          },
        },
      },
    },
  });
  try {
    writeCertArtifact(repoDir, 'mistralai', 'mistral-medium-3-5', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'workflow' });

    const decision = routeWorkflow('Plan a new multi-stage workflow.', {
      repoDir,
      plannerModelsAvailable: ['mistral-medium-3', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['mistral-medium-3', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    assert.notEqual(decision.planner, 'mistral-medium-3');
    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'mistral-medium-3' && r.role === 'planner');
    assert.ok(rejection, 'coding-only planner candidate must be rejected before selection');
    assert.equal(rejection?.reason, 'role-ineligible');
    assert.equal(rejection?.requestedLaunchPhase, 'planning');
    assert.equal(rejection?.nativeProvider, 'openrouter');
    assert.deepEqual(rejection?.eligibleRoles, ['coding']);
    assert.ok(
      decision.reasoning.some((line) => (
        line.includes('mistral-medium-3')
        && line.includes('role-ineligible')
        && line.includes('provider=openrouter')
        && line.includes('eligibleRoles=coding')
      )),
      'router reasoning should include role/provider eligibility diagnostics',
    );
  } finally {
    cleanup();
    if (previousApiKey === undefined) {
      delete process.env.HOK2540_OPENROUTER_KEY;
    } else {
      process.env.HOK2540_OPENROUTER_KEY = previousApiKey;
    }
  }
});

await test('missing artifact rejects native model and routes to non-native fallback', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // Intentionally do NOT write any cert artifact

    const decision = routeWorkflow('Build a new CLI tool.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const coderRejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(coderRejection, 'missing artifact must produce a rejection record');
    assert.equal(coderRejection?.reason, 'missing-artifact');
    assert.notEqual(decision.coder, 'qwen-3-coder', 'coder must fall back to non-native model');
    assert.ok(
      decision.reasoning.some((line) => line.includes('qwen-3-coder') && line.includes('missing')),
      'reasoning should mention the rejected native model',
    );
  } finally {
    cleanup();
  }
});

await test('stale artifact rejects native model', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // Cert older than 60 days from now (2026-06-30)
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
      phase: 'patch',
      certifiedAt: '2020-01-01T00:00:00.000Z',
    });

    const decision = routeWorkflow('Implement a feature.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'stale cert must produce a rejection');
    assert.equal(rejection?.reason, 'stale');
    assert.notEqual(decision.coder, 'qwen-3-coder');
  } finally {
    cleanup();
  }
});

await test('wrong suite version rejects native model', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
      phase: 'patch',
      suiteVersion: 'v1',
    });

    const decision = routeWorkflow('Fix a router bug.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'suite version mismatch must produce a rejection');
    assert.equal(rejection?.reason, 'wrong-suite');
    assert.notEqual(decision.coder, 'qwen-3-coder');
  } finally {
    cleanup();
  }
});

await test('malformed artifact rejects native model', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    const certPath = buildGlobalCertificationPath('qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION);
    mkdirSync(dirname(certPath), { recursive: true });
    // Write an incomplete / structurally invalid artifact
    writeFileSync(certPath, JSON.stringify({ schemaVersion: 1, provider: 'openai' }));

    const decision = routeWorkflow('Refactor a service.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'malformed artifact must produce a rejection');
    assert.equal(rejection?.reason, 'malformed');
    assert.notEqual(decision.coder, 'qwen-3-coder');
  } finally {
    cleanup();
  }
});

await test('native-only ineligible pool is rejected fail-closed, not silently treated as eligible', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // No cert artifact written — native model will be rejected

    const decision = routeWorkflow('Build a feature.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder'],
      modelsAvailable: ['qwen-3-coder'],
      skipDifficultyClassification: true,
    });

    assert.equal(decision.coder, '', 'route should surface an empty coder slot when no eligible candidates remain');
    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder' && r.role === 'coder');
    assert.ok(rejection, 'rejection must be recorded even when no fallback exists in the pool');
    assert.equal(rejection?.reason, 'missing-artifact');
    assert.ok(
      decision.reasoning.some((line) => line.includes('No eligible coder models remain')),
      'reasoning should surface the empty eligible pool failure',
    );
  } finally {
    cleanup();
  }
});

await test('repo-local openrouter-only model metadata is ignored by fallback routing', () => {
  const { repoDir, cleanup } = makeRepo({
    modelRegistry: {
      models: {
        'legacy-mistral-openrouter': {
          class: 'strong_generalist',
          vendor: 'mistral',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 70, coding: 70, review: 70, classify: 60 },
          contextWindowTokens: 128_000,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 2,
          costPerMillionOutputTokensUsd: 6,
          agent: 'claude-openrouter',
        },
      },
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['legacy-mistral-openrouter'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
  });
  const originalKey = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'test-key';
  try {
    const decision = routeWorkflow('Plan a workflow feature.', {
      repoDir,
      plannerModelsAvailable: ['legacy-mistral-openrouter'],
      modelsAvailable: ['legacy-mistral-openrouter'],
      skipDifficultyClassification: true,
    });

    assert.equal(decision.planner, 'legacy-mistral-openrouter');
    assert.equal(decision.nativeCertificationRejections?.length ?? 0, 0);
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_OPENROUTER_KEY;
    } else {
      process.env.TEST_OPENROUTER_KEY = originalKey;
    }
    cleanup();
  }
});

await test('diagnostics contain modelId, role, requestedPhase, nativeCapability, requiredSuiteVersion, and reason', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    // No artifact — triggers missing rejection

    const decision = routeWorkflow('Implement a workflow feature.', {
      repoDir,
      coderModelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((r) => r.modelId === 'qwen-3-coder');
    assert.ok(rejection, 'expected a rejection record');

    // Verify all required diagnostic fields
    assert.equal(typeof rejection?.modelId, 'string');
    assert.equal(typeof rejection?.role, 'string');
    assert.equal(typeof rejection?.requestedPhase, 'string');
    assert.equal(typeof rejection?.nativeCapability, 'string');
    assert.equal(typeof rejection?.requiredSuiteVersion, 'string');
    assert.equal(typeof rejection?.reason, 'string');

    assert.equal(rejection?.nativeCapability, 'certified');
    assert.equal(rejection?.requiredSuiteVersion, DEFAULT_CERTIFICATION_SUITE_VERSION);
  } finally {
    cleanup();
  }
});

await test('non-native models are unaffected by native certification filter', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow('Implement a new feature with tests.', {
      repoDir,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    assert.equal(
      (decision.nativeCertificationRejections ?? []).length,
      0,
      'non-native models should produce zero native certification rejections',
    );
  } finally {
    cleanup();
  }
});

await test('routeWorkflow records shared packet signals in route provenance', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const packet = readFileSync(
      join(process.cwd(), 'tests', 'fixtures', 'router-signal-corpus', 'hok-2845-greenfield.md'),
      'utf-8',
    );
    const decision = routeWorkflow(packet, {
      repoDir,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    });

    assert.equal(decision.signals.taskType, 'feature');
    assert.equal(decision.signals.complexityScore, 5);
    assert.equal(decision.signals.complexityBand, 'xl');
    assert.ok(decision.signals.riskFlags?.includes('greenfield'));
    assert.equal(decision.provenance?.signalVector?.taskType, 'feature');
    assert.equal(decision.provenance?.signalVector?.complexityScore, 5);
  } finally {
    cleanup();
  }
});

// ── HOK-3142: router ↔ launch-gate launchability parity ──────────────────────
// qwen-3-coder holds a workflow certificate but no live coding canary — the
// HOK-3138 shape (gemini-2.5-pro). The launcher refuses it for coding with
// uncertified/missing_live_canary, so no routing exit may select it as coder.

function writeWorkflowCertWithoutCanary(repoDir: string): void {
  writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
    phase: 'workflow',
    liveCanary: undefined,
  });
}

await test('HOK-3142: Hokusai-selected coder without a live canary is substituted by the launchability guard', async () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: { endpoint: 'http://localhost:8080/predict', apiKey: 'test-token', timeout: 1000 },
    },
  });
  mockHokusaiFetch({
    coder_model: 'qwen-3-coder',
    estimated_success_under_budget: 0.95,
    confidence: 0.95,
  });
  try {
    writeWorkflowCertWithoutCanary(repoDir);
    const decision = await routeWorkflowHokusai('Implement a small router feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.equal(decision.routingMode, 'hokusai');
    assert.notEqual(decision.coder, 'qwen-3-coder', 'routing must never select an unlaunchable coder');
    assert.ok(decision.coder, 'a launchable substitute coder is selected');
    const substitution = decision.launchabilitySubstitutions?.find((entry) => entry.role === 'coder');
    assert.ok(substitution, 'substitution is recorded on the decision');
    assert.equal(substitution?.from, 'qwen-3-coder');
    assert.equal(substitution?.to, decision.coder);
    assert.equal(substitution?.reason, 'uncertified');
    assert.equal(substitution?.certification, 'missing_live_canary');
    assert.equal(decision.preEscalationRoute?.coder, 'qwen-3-coder', 'the original pick is preserved');
    assert.ok(decision.reasoning.some((line) => line.includes('Launchability guard: coder qwen-3-coder')));
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('HOK-3142: enforceLaunchableRoute replaces an unlaunchable coder and recomputes cost', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeWorkflowCertWithoutCanary(repoDir);
    const options = {
      repoDir,
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'],
      skipDifficultyClassification: true,
    };
    const base = routeWorkflow('Fix a small bug in the router.', options);
    const decision = enforceLaunchableRoute({ ...base, coder: 'qwen-3-coder', expectedCostCode: 0 }, options);

    assert.notEqual(decision.coder, 'qwen-3-coder');
    assert.ok(['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'].includes(decision.coder));
    assert.equal(decision.launchabilitySubstitutions?.[0]?.certification, 'missing_live_canary');
    assert.equal(decision.launchabilityBlocked, undefined);
  } finally {
    cleanup();
  }
});

await test('HOK-3142: enforceLaunchableRoute is a no-op for launchable routes and without repoDir', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const options = {
      repoDir,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    };
    const decision = routeWorkflow('Implement a new feature with tests.', options);
    assert.equal(decision.launchabilitySubstitutions, undefined);
    assert.equal(enforceLaunchableRoute(decision, options), decision);
    const unlaunchable = { ...decision, coder: 'qwen-3-coder' };
    assert.equal(enforceLaunchableRoute(unlaunchable, {}), unlaunchable, 'repo-less routing is untouched');
  } finally {
    cleanup();
  }
});

await test('HOK-3142: excludeModels removes a refused coder from every routing pool', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const options = {
      repoDir,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    };
    const first = routeWorkflow('Implement a new feature with tests.', options);
    const rerouted = routeWorkflow('Implement a new feature with tests.', { ...options, excludeModels: [first.coder] });
    assert.notEqual(rerouted.coder, first.coder);
    assert.ok(rerouted.coder, 'the remaining pool model is selected');
  } finally {
    cleanup();
  }
});

await test('HOK-3142: no launchable coder left → launchabilityBlocked carries the canary certify command', () => {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    writeWorkflowCertWithoutCanary(repoDir);
    const options = {
      repoDir,
      modelsAvailable: ['qwen-3-coder', 'claude-haiku-4-5-20251001'],
      skipDifficultyClassification: true,
    };
    const base = routeWorkflow('Fix a small bug in the router.', options);
    const decision = enforceLaunchableRoute(
      { ...base, coder: 'qwen-3-coder' },
      { ...options, excludeModels: ['claude-haiku-4-5-20251001'] },
    );

    assert.equal(decision.coder, 'qwen-3-coder', 'the refused model stays so the monitor can terminalize');
    const blocked = decision.launchabilityBlocked?.find((entry) => entry.role === 'coder');
    assert.ok(blocked, 'expected a blocked coder record');
    assert.equal(blocked?.reason, 'uncertified');
    assert.equal(blocked?.certification, 'missing_live_canary');
    assert.match(blocked?.certifyCommand ?? '', /--live-coding-canary/);
    assert.ok(decision.reasoning.some((line) => line.startsWith('No launchable coder remains')));
  } finally {
    cleanup();
  }
});

reportResults();
