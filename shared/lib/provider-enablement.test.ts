/**
 * A model whose provider is turned off in the repo config, or that needs
 * native execution while `nativeAgent.enabled` is not true, is not launchable
 * for any stage — so the router, the challenge pool and the challenge
 * scheduler never offer it. Before this, enablement was enforced only by the
 * launcher, and the router kept selecting DeepSeek models that every launch
 * then refused.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pickChallengeModelsWithReason } from './challenge-mode.ts';
import { evaluateChallenge, type EvalSummary } from './challenge-scheduler.ts';
import { clearConfigCache } from './config.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';
import {
  isDeterministicLaunchRefusal,
  isLaunchableForStage,
  isProviderEnablementRefusal,
  isStageLaunchRefusal,
} from './stage-launchability.ts';
import { enforceLaunchableRoute, routeWorkflow, type WorkflowRouteDecision } from './workflow-router.ts';
import { makeOpenRouterReadyRepo, makeRepo } from './workflow-router-test-helpers.ts';

const STAGES = ['planning', 'coding', 'review'] as const;
const DEEPSEEK_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3'];
const NATIVE_MODEL = 'qwen-3-coder';

function makeDecision(overrides: Partial<WorkflowRouteDecision>): WorkflowRouteDecision {
  return {
    planner: 'claude-opus-4-6',
    coder: 'claude-opus-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewRecommended: 'llm',
    expectedSuccess: 0.5,
    confidence: 0.1,
    expectedCostPlan: 1,
    expectedCostCode: 1,
    expectedCostReview: 1,
    reasoning: [],
    signals: { taskType: 'feature', promptLength: 'medium', complexityScore: 2, fileTypes: ['.ts'], riskScore: 3 },
    ...overrides,
  } as WorkflowRouteDecision;
}

function withEnv(name: string, value: string, fn: () => void): void {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function withRepo(config: Record<string, unknown>, fn: (repoDir: string) => void): void {
  const { repoDir, cleanup } = makeRepo(config);
  try {
    fn(repoDir);
  } finally {
    cleanup();
  }
}

function withOpenRouterRepo(config: Record<string, unknown>, fn: (repoDir: string) => void): void {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo(config);
  try {
    fn(repoDir);
  } finally {
    cleanup();
  }
}

function deepseekConfig(enabled: boolean): Record<string, unknown> {
  return { providers: { deepseek: { enabled, apiKeyEnv: 'TEST_DEEPSEEK_KEY' } } };
}

describe('provider enablement in the launchability predicate', () => {
  it('refuses a DeepSeek model for every stage when providers.deepseek.enabled=false', () => {
    withRepo(deepseekConfig(false), (repoDir) => {
      for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
        for (const stage of STAGES) {
          const result = isLaunchableForStage(model, stage, { repoDir });
          assert.ok(isStageLaunchRefusal(result), `${model}:${stage} should be refused`);
          assert.equal(result.reason, 'provider-disabled');
          assert.equal(result.certification, 'providers.deepseek.enabled:off');
          assert.match(result.diagnostic, /provider=deepseek reason=provider-disabled/);
          assert.equal(isProviderEnablementRefusal(result), true);

          const launcher = resolveModelAgent({ model, phase: stage, repoDir });
          assert.equal(launcher.ok, false);
        }
      }
    });
  });

  it('leaves a DeepSeek model launchable on the Claude CLI when the provider is enabled', () => {
    withRepo(deepseekConfig(true), (repoDir) => {
      const result = isLaunchableForStage('deepseek-v4-flash', 'coding', { repoDir });
      assert.deepEqual(result, { ok: true, agent: 'claude' });
    });
  });

  it('honours a .wavemill-config.local.json overlay that turns DeepSeek off', () => {
    withRepo(deepseekConfig(true), (repoDir) => {
      writeFileSync(
        join(repoDir, '.wavemill-config.local.json'),
        JSON.stringify({ providers: { deepseek: { enabled: false } } }),
      );
      clearConfigCache(repoDir);
      const result = isLaunchableForStage('deepseek-v4-pro', 'planning', { repoDir });
      assert.ok(isStageLaunchRefusal(result));
      assert.equal(result.reason, 'provider-disabled');
    });
  });

  it('refuses a native-only model for every stage when nativeAgent.enabled=false', () => {
    withOpenRouterRepo({ nativeAgent: { enabled: false } }, (repoDir) => {
      for (const stage of STAGES) {
        const result = isLaunchableForStage(NATIVE_MODEL, stage, { repoDir });
        assert.ok(isStageLaunchRefusal(result), `${NATIVE_MODEL}:${stage} should be refused`);
        assert.equal(result.reason, 'native-disabled');
        assert.equal(result.certification, 'nativeAgent.enabled:off');
      }
    });
  });

  it('does not refuse a native model for enablement when nativeAgent and OpenRouter are on', () => {
    withOpenRouterRepo({}, (repoDir) => {
      for (const stage of STAGES) {
        const result = isLaunchableForStage(NATIVE_MODEL, stage, { repoDir });
        assert.equal(isProviderEnablementRefusal(result), false, `${NATIVE_MODEL}:${stage}`);
      }
    });
  });

  it('refuses a native OpenRouter model when providers.openrouter.enabled=false', () => {
    withOpenRouterRepo({ providers: { openrouter: { enabled: false } } }, (repoDir) => {
      const result = isLaunchableForStage(NATIVE_MODEL, 'coding', { repoDir });
      assert.ok(isStageLaunchRefusal(result));
      assert.equal(result.reason, 'provider-disabled');
      assert.equal(result.certification, 'providers.openrouter.enabled:off');
    });
  });

  it('does not gate hosted Anthropic models on provider config', () => {
    withRepo({ ...deepseekConfig(false), nativeAgent: { enabled: false } }, (repoDir) => {
      assert.deepEqual(isLaunchableForStage('claude-opus-4-6', 'coding', { repoDir }), { ok: true, agent: 'claude' });
    });
  });

  it('classifies enablement refusals as deterministic so the monitor reroutes instead of retrying', () => {
    assert.equal(isDeterministicLaunchRefusal('provider-disabled'), true);
    assert.equal(isDeterministicLaunchRefusal('native-disabled'), true);
  });
});

describe('consumers never offer a disabled-provider model', () => {
  it('the router never selects a DeepSeek model while the provider is disabled', () => {
    withEnv('TEST_DEEPSEEK_KEY', 'test-deepseek-key', () => {
      withRepo(deepseekConfig(false), (repoDir) => {
        const decision = routeWorkflow('Implement a new CLI command for routing reports.', {
          repoDir,
          modelsAvailable: [...DEEPSEEK_MODELS, 'claude-opus-4-6'],
          plannerModelsAvailable: ['deepseek-v4-pro', 'claude-opus-4-6'],
          coderModelsAvailable: ['deepseek-v4-flash', 'claude-opus-4-6'],
          reviewerModelsAvailable: ['deepseek-v4-pro', 'claude-opus-4-6'],
          skipDifficultyClassification: true,
        });
        for (const model of [decision.planner, decision.coder, decision.reviewer]) {
          assert.ok(!DEEPSEEK_MODELS.includes(model), `router selected disabled-provider model ${model}`);
        }
      });
    });
  });

  it('the terminal launchability guard replaces a DeepSeek route (e.g. from Hokusai) when the provider is disabled', () => {
    withRepo(deepseekConfig(false), (repoDir) => {
      // The HOK-3461 route: every stage on DeepSeek, as a remote recommendation returned it.
      const decision = makeDecision({
        planner: 'deepseek-v4-pro',
        coder: 'deepseek-v4-flash',
        reviewer: 'deepseek-v4-pro',
      });
      const guarded = enforceLaunchableRoute(decision, { repoDir });
      for (const role of ['planner', 'coder', 'reviewer'] as const) {
        const model = guarded[role];
        const blocked = (guarded.launchabilityBlocked ?? []).some((entry) => entry.role === role);
        assert.ok(
          !DEEPSEEK_MODELS.includes(model) || blocked,
          `${role} kept disabled-provider model ${model} without recording it as blocked`,
        );
        if (!blocked) {
          assert.equal(isLaunchableForStage(model, ({ planner: 'planning', coder: 'coding', reviewer: 'review' } as const)[role], { repoDir }).ok, true);
        }
      }
      assert.ok(guarded.reasoning.some((line) => /provider-disabled/.test(line)));
    });
  });

  it('the challenge pool never pairs a DeepSeek challenger while the provider is disabled', () => {
    withEnv('TEST_DEEPSEEK_KEY', 'test-deepseek-key', () => {
      withRepo({ ...deepseekConfig(false), challenge: { allowDeepseek: true } }, (repoDir) => {
        const result = pickChallengeModelsWithReason(
          ['claude-opus-4-6', 'deepseek-v4-flash'],
          {
            pairId: 'PE-1',
            issueId: 'PE-1',
            slug: 'pe-1',
            primaryModel: 'claude-opus-4-6',
            suggestedChallengerModel: 'deepseek-v4-flash',
            repoDir,
            randomFn: () => 0,
          },
        );
        assert.notEqual(result.pair?.challenger.model, 'deepseek-v4-flash');
        assert.notEqual(result.pair?.primary.model, 'deepseek-v4-flash');
      });
    });
  });

  it('the challenge scheduler never recommends a disabled-provider challenger', () => {
    withRepo({ ...deepseekConfig(false), nativeAgent: { enabled: false } }, (repoDir) => {
      const decision = makeDecision({});
      const summary = {
        recordsByModel: { 'claude-opus-4-6': 100, 'claude-sonnet-5': 100 },
        recordsByStage: { plan: 100, implementation: 100, review: 100 },
      } as unknown as EvalSummary;
      const result = evaluateChallenge({
        routingDecision: decision,
        evalSummary: summary,
        config: { enabled: true, confidenceThreshold: 0.9, newModelChallengeCount: 25, minEvalRecordsPerStage: 1 },
        challengeModels: [...DEEPSEEK_MODELS, NATIVE_MODEL, 'claude-sonnet-5'],
        repoDir,
      });
      assert.ok(
        ![...DEEPSEEK_MODELS, NATIVE_MODEL].includes(result.challengerModel ?? ''),
        `scheduler recommended disabled-provider challenger ${result.challengerModel}`,
      );
    });
  });
});
