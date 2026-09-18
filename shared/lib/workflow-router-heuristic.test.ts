/**
 * Tests for the workflow router — heuristic routing, provider-pool filtering,
 * prompt-file parsing, and summary output. See `workflow-router-test-helpers.ts`
 * for the shared harness and fixtures.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskPromptFromFile, routeWorkflow, summarizeWorkflowRoute, tryPolicyResolution } from './workflow-router.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './native-agent/certification/index.ts';
import { getHarnessId, openManifest } from './resource-manifest.ts';
import {
  FRESH_CERTIFIED_AT,
  baseConfig,
  makeRepo,
  printBanner,
  reportResults,
  test,
  writeNativeCertificationArtifact,
  writeQuotaState,
} from './workflow-router-test-helpers.ts';

printBanner('workflow-router Tests');

await test('routes broad CLI workflow work to deep planning and medium-or-higher review', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Create a wavemill route CLI command that extends the router, outputs planner coder and reviewer, prints JSON and stdout, and estimates cost and success.',
      { repoDir },
    );
    assert.equal(decision.planDepth, 'deep');
    // Capable coders for broad workflow work. Keep in sync with the top of the
    // coding ladder in model-registry.ts when new frontier models land.
    assert.ok([
      'claude-fable-5',
      'gpt-5.5',
      'gpt-5.6-terra',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
    ].includes(decision.coder));
    assert.ok(['llm', 'static+llm'].includes(decision.reviewRecommended));
    assert.ok(['medium', 'deep'].includes(decision.codeDepth));
    assert.ok(decision.expectedCostCode >= 0);
    assert.ok(decision.expectedCostPlan >= 0);
    assert.ok(decision.expectedSuccess <= 0.97 && decision.expectedSuccess >= 0.35);
    assert.ok(decision.confidence >= 0.1 && decision.confidence <= 0.95);
  } finally {
    cleanup();
  }
});

await test('stamps route decisions with harnessId when a session manifest exists', () => {
  const { repoDir, cleanup } = makeRepo();
  const previousSession = process.env.WAVEMILL_SESSION;
  try {
    process.env.WAVEMILL_SESSION = 'route-harness-session';
    openManifest('route-harness-session', { workflowType: 'feature', repoDir });

    const decision = routeWorkflow('Implement a backend workflow feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.equal(decision.harnessId, getHarnessId('route-harness-session', repoDir));
  } finally {
    if (previousSession === undefined) {
      delete process.env.WAVEMILL_SESSION;
    } else {
      process.env.WAVEMILL_SESSION = previousSession;
    }
    cleanup();
  }
});

await test('omits route harnessId when no session is active', () => {
  const { repoDir, cleanup } = makeRepo();
  const previousSession = process.env.WAVEMILL_SESSION;
  try {
    delete process.env.WAVEMILL_SESSION;
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.equal(decision.harnessId, undefined);
  } finally {
    if (previousSession === undefined) {
      delete process.env.WAVEMILL_SESSION;
    } else {
      process.env.WAVEMILL_SESSION = previousSession;
    }
    cleanup();
  }
});

await test('routes documentation work to lighter review', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update the README.md documentation for the route command and add usage examples.',
      { repoDir },
    );
    assert.equal(decision.reviewRecommended, 'static');
    assert.equal(decision.planDepth, 'light');
    assert.equal(decision.routingMode, 'heuristic');
  } finally {
    cleanup();
  }
});

await test('includes budget constraints in heuristic routing decisions when provided', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      { repoDir, maxCostUsd: 3.5 },
    );
    assert.deepEqual(decision.constraints, { maxCostUsd: 3.5 });
  } finally {
    cleanup();
  }
});

await test('heuristic routing ignores repo-local stage-specific model pools', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['gpt-5.6-terra'],
        reviewer: ['claude-sonnet-5'],
      },
    },
  });
  try {
    const decision = routeWorkflow(
      'Create a wavemill route CLI command that extends the router, outputs planner coder and reviewer, prints JSON and stdout, and estimates cost and success.',
      { repoDir, maxCostUsd: 25, skipDifficultyClassification: true }
    );
    assert.notEqual(decision.planner, 'gpt-5.6-terra');
    assert.notEqual(decision.reviewer, 'claude-sonnet-5');
  } finally {
    cleanup();
  }
});

await test('disabled DeepSeek provider does not rely on repo-local stage pools', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['deepseek-v4-pro', 'claude-sonnet-5'],
        coder: ['deepseek-v4-pro', 'claude-sonnet-5'],
        reviewer: ['deepseek-v4-pro', 'claude-sonnet-5'],
      },
    },
    providers: {
      deepseek: {
        enabled: false,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'deepseek-v4-pro': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    },
  });
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
  } finally {
    cleanup();
  }
});

await test('default routing does not surface DeepSeek without explicit opt-in', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      { repoDir, skipDifficultyClassification: true },
    );
    assert.notEqual(decision.planner, 'deepseek-v4-pro');
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
    assert.notEqual(decision.reviewer, 'deepseek-v4-flash');
  } finally {
    cleanup();
  }
});

await test('explicit modelsAvailable opt-in can return DeepSeek', () => {
  const { repoDir, cleanup } = makeRepo({
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-flash'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      {
        repoDir,
        modelsAvailable: ['deepseek-v4-flash'],
        plannerModelsAvailable: ['deepseek-v4-flash'],
        coderModelsAvailable: ['deepseek-v4-flash'],
        reviewerModelsAvailable: ['deepseek-v4-flash'],
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.planner, 'deepseek-v4-flash');
    assert.equal(decision.coder, 'deepseek-v4-flash');
    assert.equal(decision.reviewer, 'deepseek-v4-flash');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('unknown DeepSeek in repo-local stage availability is ignored', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['deepseek-v4-ultra'],
      },
    },
  });
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.planner, 'deepseek-v4-ultra');
  } finally {
    cleanup();
  }
});

await test('policy routing can return DeepSeek when explicitly configured', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      models: ['deepseek-v4-pro'],
      difficulty: {
        enabled: false,
      },
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  try {
    writeQuotaState(repoDir, {
      'claude-fable-5': 'exhausted',
      'claude-opus-4-8': 'exhausted',
      'claude-opus-4-7': 'exhausted',
      'claude-opus-4-6': 'exhausted',
      'claude-sonnet-5': 'exhausted',
      'claude-sonnet-4-6': 'exhausted',
      'claude-sonnet-4-5-20250929': 'exhausted',
      'claude-haiku-4-5-20251001': 'exhausted',
      'gpt-5.3-codex': 'exhausted',
      'gpt-5': 'exhausted',
      'gpt-5-mini': 'exhausted',
      'gpt-5.5': 'exhausted',
      'gpt-5.6-terra': 'exhausted',
      'deepseek-r1': 'exhausted',
      'deepseek-v3': 'exhausted',
      'deepseek-reasoner': 'exhausted',
      'deepseek-v4-flash': 'exhausted',
      'deepseek-v4-pro': 'healthy',
    });
    const decision = tryPolicyResolution(
      'Implement a backend workflow feature with tests.',
      { repoDir, taskDifficulty: 'moderate' },
    );
    assert.ok(decision);
    assert.equal(decision?.planner, 'deepseek-v4-pro');
    assert.equal(decision?.coder, 'deepseek-v4-pro');
    assert.equal(decision?.reviewer, 'deepseek-v4-pro');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('DeepSeek provider config does not add repo-local stage candidates', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['claude-sonnet-5'],
        coder: ['deepseek-v4-pro'],
        reviewer: ['claude-sonnet-5'],
      },
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['coder'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'deepseek-v4-pro': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('missing DeepSeek API key is not reported for ignored repo-local stage candidates', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['claude-sonnet-5'],
        coder: ['deepseek-v4-pro', 'claude-sonnet-5'],
        reviewer: ['claude-sonnet-5'],
      },
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        models: ['deepseek-v4-pro'],
        stages: ['coder'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'deepseek-v4-pro': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    },
  });
  const originalKey = process.env.TEST_DEEPSEEK_KEY;
  delete process.env.TEST_DEEPSEEK_KEY;
  try {
    const decision = routeWorkflow('Implement a backend workflow feature with tests.', { repoDir });
    assert.notEqual(decision.coder, 'deepseek-v4-pro');
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalKey;
    }
    cleanup();
  }
});

await test('OpenRouter aliases in repo-local stage pools do not force selection', () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      availableModels: {
        planner: ['glm-5.2'],
        coder: ['kimi-k2.7-code'],
        reviewer: ['glm-5.2'],
      },
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['glm-5.2', 'kimi-k2.7-code'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    eval: {
      pricing: {
        ...baseConfig().eval.pricing,
        'glm-5.2': { inputCostPerMTok: 0.9, outputCostPerMTok: 4.2 },
        'kimi-k2.7-code': { inputCostPerMTok: 1.2, outputCostPerMTok: 3.6 },
      },
    },
    modelRegistry: {
      models: {
        'glm-5.2': {
          vendor: 'z-ai',
          class: 'strong_generalist',
          strengths: ['planning'],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 92, coding: 84, review: 90, classify: 60 },
          contextWindowTokens: 131_072,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 0.9,
          costPerMillionOutputTokensUsd: 4.2,
          agent: 'claude-openrouter',
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
        'kimi-k2.7-code': {
          vendor: 'moonshotai',
          class: 'strong_generalist',
          strengths: ['coding'],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 80, coding: 93, review: 82, classify: 58 },
          contextWindowTokens: 262_144,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 1.2,
          costPerMillionOutputTokensUsd: 3.6,
          agent: 'claude-openrouter',
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
  const originalKey = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'test-key';
  try {
    writeNativeCertificationArtifact(repoDir, 'z-ai', 'glm-5.2', 'v1', 'workflow');
    writeNativeCertificationArtifact(repoDir, 'moonshotai', 'kimi-k2.7-code', 'v1', 'workflow', FRESH_CERTIFIED_AT);

    const decision = routeWorkflow('Implement a backend workflow feature with tests.', {
      repoDir,
      skipDifficultyClassification: true,
    });

    assert.notEqual(decision.planner, 'glm-5.2');
    assert.notEqual(decision.coder, 'kimi-k2.7-code');
    assert.notEqual(decision.reviewer, 'glm-5.2');
    assert.ok((decision.nativeCertificationRejections ?? []).some((entry) =>
      entry.nativeProvider === 'openrouter'
      && entry.requiredSuiteVersion === DEFAULT_CERTIFICATION_SUITE_VERSION
      && entry.reason === 'missing-artifact'
    ));
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_OPENROUTER_KEY;
    } else {
      process.env.TEST_OPENROUTER_KEY = originalKey;
    }
    cleanup();
  }
});

await test('heuristic routing confidence varies across prompts instead of staying constant', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const featureDecision = routeWorkflow('Implement a feature for the workflow router.', { repoDir });
    const bugfixDecision = routeWorkflow('Fix the auth migration router bug in config.ts.', { repoDir });
    assert.notEqual(featureDecision.confidence, bugfixDecision.confidence);
    assert.ok(featureDecision.confidence >= 0.1 && featureDecision.confidence <= 0.95);
    assert.ok(bugfixDecision.confidence >= 0.1 && bugfixDecision.confidence <= 0.95);
  } finally {
    cleanup();
  }
});

await test('reads selected-task style json files', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const filePath = join(repoDir, 'selected-task.json');
    writeFileSync(filePath, JSON.stringify({
      title: 'Create route command',
      description: 'Add JSON output and CLI wiring.',
    }));
    assert.equal(readTaskPromptFromFile(filePath), 'Create route command\n\nAdd JSON output and CLI wiring.');
  } finally {
    cleanup();
  }
});

await test('reads markdown task-packet files without JSON parsing', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const filePath = join(repoDir, 'task-packet.md');
    writeFileSync(filePath, '# Task Packet\n\n## 1. Objective\n\nRoute against this content.\n');
    assert.equal(readTaskPromptFromFile(filePath), '# Task Packet\n\n## 1. Objective\n\nRoute against this content.');
  } finally {
    cleanup();
  }
});

await test('summary output includes stage lines and success', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow('Build a new CLI tool with JSON output and review support.', { repoDir });
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Planner:/);
    assert.match(summary, /Coder:/);
    assert.match(summary, /Reviewer:/);
    assert.match(summary, /Success:/);
    assert.match(summary, /confidence=\d+\.\d{2}/);
  } finally {
    cleanup();
  }
});

reportResults();
