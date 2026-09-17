import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRegistry } from './model-registry.ts';
import { resolveModelAgent, resolveLaunchPreflight, type AgentResolution } from './model-agent-resolution.ts';
import { getStageContextWindowFloor } from './model-registry.ts';

function makeRegistry(modelId: string, model: ModelRegistry['models'][string]): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 70, coding: 70, review: 70, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: 'basic',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        ...model,
      },
    },
    ladders: {},
  };
}

describe('resolveModelAgent', () => {
  it('rejects openrouter aliases without native capability metadata', () => {
    const registry = makeRegistry('legacy-openrouter-model', {
      agent: 'claude-openrouter',
    });
    const result = resolveModelAgent({
      model: 'legacy-openrouter-model',
      phase: 'planning',
      registry,
    });

    assert.deepEqual(result.ok, false);
    if (result.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(result.reason, 'no-native-capability');
    assert.match(result.diagnostic, /legacy-openrouter-model/);
    assert.match(result.diagnostic, /phase=planning/);
    assert.match(result.diagnostic, /provider=openrouter/);
  });

  it('rejects unknown models instead of routing by prefix', () => {
    const result = resolveModelAgent({
      model: 'gpt-99-turbo',
      phase: 'coding',
    });

    assert.deepEqual(result, {
      ok: false,
      reason: 'unknown-model',
      diagnostic: result.ok ? '' : result.diagnostic,
    });
  });

  it('rejects invalid model ids without throwing', () => {
    for (const model of ['', '   ', 'mistral; rm -rf /']) {
      const result = resolveModelAgent({ model, phase: 'review' });
      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail('expected invalid model id rejection');
      }
      assert.equal(result.reason, 'invalid-model-id');
    }
  });

  it('resolves hosted claude models to claude', () => {
    const result = resolveModelAgent({
      model: 'claude-sonnet-5',
      phase: 'coding',
    });
    assert.deepEqual(result, { ok: true, agent: 'claude' });
  });

  it('keeps Anthropic models on the Claude harness despite a native override', () => {
    const registry = makeRegistry('anthropic-misconfigured', {
      vendor: 'anthropic',
      agent: 'native-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    assert.deepEqual(
      resolveModelAgent({ model: 'anthropic-misconfigured', phase: 'planning', registry }),
      { ok: true, agent: 'claude' },
    );
  });

  it('keeps OpenAI models on the ChatGPT Codex harness despite native overrides', () => {
    for (const agent of ['native-openai', 'native-openrouter'] as const) {
      const registry = makeRegistry(`openai-misconfigured-${agent}`, {
        vendor: 'openai',
        agent,
        codexChatgptCapability: { supported: true },
        nativeCapability: {
          nativeProvider: agent === 'native-openai' ? 'openai' : 'openrouter',
          piTransportKind: 'openai-completions',
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: 'workflow',
            certifiedAt: '2099-01-01T00:00:00.000Z',
            certificationSuiteVersion: 'v1',
          },
        },
      });

      assert.deepEqual(
        resolveModelAgent({ model: `openai-misconfigured-${agent}`, phase: 'planning', registry }),
        { ok: true, agent: 'codex' },
      );
    }
  });

  it('rejects an OpenAI native override when the model is not ChatGPT Codex eligible', () => {
    const registry = makeRegistry('openai-native-ineligible', {
      vendor: 'openai',
      agent: 'native-openrouter',
      codexChatgptCapability: { supported: false, reason: 'Not available in the ChatGPT Codex app.' },
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
      },
    });

    const result = resolveModelAgent({ model: 'openai-native-ineligible', phase: 'planning', registry });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected ChatGPT Codex eligibility rejection');
    assert.equal(result.reason, 'codex-chatgpt-ineligible');
  });

  it('rejects retired gpt-5.5 with lifecycle-blocked', () => {
    const result = resolveModelAgent({
      model: 'gpt-5.5',
      phase: 'review',
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected gpt-5.5 to be rejected');
    assert.equal(result.reason, 'lifecycle-blocked');
    assert.match(result.diagnostic, /gpt-5\.5/);
    assert.match(result.diagnostic, /lifecycle-blocked/);
  });

  it('routes the GPT-5.6 Terra Codex replacement and rejects retired GPT-5.4 launches', () => {
    assert.deepEqual(
      resolveModelAgent({ model: 'gpt-5.6-terra', phase: 'coding' }),
      { ok: true, agent: 'codex' },
    );
    const retired = resolveModelAgent({ model: 'gpt-5.4', phase: 'coding' });
    assert.equal(retired.ok, false);
    if (retired.ok) assert.fail('expected retired model rejection');
    assert.equal(retired.reason, 'codex-chatgpt-ineligible');
    assert.match(retired.diagnostic, /gpt-5\.6-terra/);
  });

  it('rejects GPT models not certified for the ChatGPT Codex surface', () => {
    for (const model of ['gpt-5', 'gpt-5-mini']) {
      const result = resolveModelAgent({ model, phase: 'coding' });
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('expected rejection');
      assert.equal(result.reason, 'codex-chatgpt-ineligible');
      assert.match(result.diagnostic, new RegExp(`model=${model}`));
      assert.match(result.diagnostic, /surface=codex-chatgpt/);
      assert.match(result.diagnostic, /source=globalModelRegistry/);
    }
  });

  it('resolves certified role-eligible claude-openrouter models to native-openrouter', () => {
    const registry = makeRegistry('qwen-3-coder', {
      agent: 'claude-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    const result = resolveModelAgent({
      model: 'qwen-3-coder',
      phase: 'review',
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.deepEqual(result, { ok: true, agent: 'native-openrouter' });
  });

  it('rejects launch-priority models that are not eligible for the requested phase', () => {
    // mistral-medium-3 is the remaining coding-only launch-priority row
    // (qwen-2.5-coder-32b was retired by HOK-2947).
    const registry = makeRegistry('mistral-medium-3', {
      agent: 'claude-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    const result = resolveModelAgent({
      model: 'mistral-medium-3',
      phase: 'planning',
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(result.reason, 'role-ineligible');
    assert.match(result.diagnostic, /phase=planning/);
    assert.match(result.diagnostic, /certification=eligible-roles:coding/);
  });

  it('rejects stale or phase-insufficient native metadata as uncertified', () => {
    const registry = makeRegistry('native-plan-model', {
      agent: 'claude-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'read-only',
          certifiedAt: '2025-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    const stale = resolveModelAgent({
      model: 'native-plan-model',
      phase: 'planning',
      registry,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    assert.equal(stale.ok, false);
    if (stale.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(stale.reason, 'uncertified');
    assert.match(stale.diagnostic, /provider=openrouter/);
    assert.match(stale.diagnostic, /certification=stale|certification=phase-insufficient/);

    const phaseInsufficient = resolveModelAgent({
      model: 'native-plan-model',
      phase: 'planning',
      registry: makeRegistry('native-plan-model', {
        agent: 'claude-openrouter',
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          readOnlyNative: 'certified',
          compatFlags: { thinkingFormat: 'openrouter' },
          certification: {
            maxCertifiedPhase: 'read-only',
            certifiedAt: '2099-01-01T00:00:00.000Z',
            certificationSuiteVersion: 'v1',
          },
        },
      }),
      now: new Date('2098-01-01T00:00:00.000Z'),
    });
    assert.equal(phaseInsufficient.ok, false);
    if (phaseInsufficient.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(phaseInsufficient.reason, 'uncertified');
    assert.match(phaseInsufficient.diagnostic, /certification=phase-insufficient/);
    assert.match(phaseInsufficient.diagnostic, /native-agent-certify\.ts --provider openrouter --model native-plan-model --phase workflow/);
  });

  it('rejects retired native-openrouter models before certification checks', () => {
    for (const model of ['grok-code-fast']) {
      const result = resolveModelAgent({ model, phase: 'coding' });
      assert.equal(result.ok, false, `${model} should reject`);
      if (result.ok) assert.fail('expected rejection');
      assert.equal(result.reason, 'lifecycle-blocked');
      assert.match(result.diagnostic, /certification=retired/);
    }
    // Aliases removed outright by HOK-2947 reject as unknown models.
    for (const model of ['deepseek-coder-v2', 'gemini-2.0-flash', 'qwen-2.5-coder-32b']) {
      const result = resolveModelAgent({ model, phase: 'coding' });
      assert.equal(result.ok, false, `${model} should reject`);
      if (result.ok) assert.fail('expected rejection');
      assert.equal(result.reason, 'unknown-model');
    }
  });

  it('rejects supported native-openrouter models with no tool support', () => {
    const registry = makeRegistry('native-no-tools', {
      agent: 'native-openrouter',
      toolSupport: 'none',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
      supportedModel: {
        lifecycle: 'supported',
        stages: ['coding'],
      },
    });

    const result = resolveModelAgent({
      model: 'native-no-tools',
      phase: 'coding',
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected rejection');
    assert.equal(result.reason, 'tool-support-insufficient');
    assert.match(result.diagnostic, /certification=tool-support:none/);
  });

  it('rejects models with insufficient context window for the coding stage', () => {
    const registry = makeRegistry('kimi-k2', {
      agent: 'native-openrouter',
      contextWindowTokens: 131_072, // Below the coding floor of 144,384
      toolSupport: 'basic',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
      supportedModel: {
        wavemillAlias: 'kimi-k2',
        providerNativeId: 'moonshotai/kimi-k2',
        stages: ['planning', 'coding', 'review'],
        lifecycle: 'supported',
      },
    });

    const result = resolveModelAgent({
      model: 'kimi-k2',
      phase: 'coding',
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected rejection');
    assert.equal(result.reason, 'context-window-insufficient');
    const floor = getStageContextWindowFloor('coding');
    assert.ok(floor !== undefined);
    assert.match(result.diagnostic, new RegExp(`context-window:131072<${floor}`));
  });

  it('allows models with sufficient context window for the coding stage', () => {
    const registry = makeRegistry('claude-sonnet-5', {
      agent: 'claude',
      vendor: 'anthropic',
      contextWindowTokens: 1_000_000, // Above the coding floor
      toolSupport: 'full',
    });

    const result = resolveModelAgent({
      model: 'claude-sonnet-5',
      phase: 'coding',
      registry,
    });

    assert.equal(result.ok, true);
    if (!result.ok) assert.fail('expected successful resolution');
    assert.equal(result.agent, 'claude');
  });

  it('still allows models with insufficient context window for stages without floors', () => {
    const registry = makeRegistry('kimi-k2', {
      agent: 'native-openrouter',
      contextWindowTokens: 131_072, // Below the coding floor but acceptable for planning (no floor)
      toolSupport: 'basic',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
      supportedModel: {
        wavemillAlias: 'kimi-k2',
        providerNativeId: 'moonshotai/kimi-k2',
        stages: ['planning', 'coding', 'review'],
        lifecycle: 'supported',
      },
    });

    const result = resolveModelAgent({
      model: 'kimi-k2',
      phase: 'planning', // Planning has no floor
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    if (!result.ok) assert.fail('expected successful resolution for planning stage');
    assert.equal(result.agent, 'native-openrouter');
  });
});

describe('resolveLaunchPreflight', () => {
  it('succeeds for valid non-retired models', () => {
    const registry = makeRegistry('claude-sonnet-5', {
      vendor: 'anthropic',
    });
    const result = resolveLaunchPreflight({
      requestedModel: 'claude-sonnet-5',
      phase: 'coding',
      registry,
    });

    assert.equal(result.ok, true);
    if (!result.ok) assert.fail('expected success');
    assert.equal(result.requestedModel, 'claude-sonnet-5');
    assert.equal(result.resolvedModel, 'claude-sonnet-5');
    assert.equal(result.agent, 'claude');
  });

  it('resolves deprecated models through successor chain', () => {
    const registry: ModelRegistry = {
      models: {
        'gpt-5.5': {
          vendor: 'openai',
          class: 'frontier',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 70, coding: 70, review: 70, classify: 70 },
          contextWindowTokens: 400_000,
          toolSupport: 'full',
          multimodal: { text: true, image: true },
          latencyTier: 'slow',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 5,
          costPerMillionOutputTokensUsd: 30,
          agent: 'codex',
          codexChatgptCapability: { supported: false, reason: 'Retired model' },
          identity: {
            status: 'verified',
            revision: 1,
            fingerprint: 'test',
            displayName: 'gpt-5.5',
            family: 'gpt',
            evidencePolicy: 'eligible',
            lineage: {
              successor: 'gpt-5.6-terra',
            },
          },
          supportedModel: {
            lifecycle: 'deprecated',
            launchEligible: false,
            routingEligible: false,
          },
        },
        'gpt-5.6-terra': {
          vendor: 'openai',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 70, coding: 70, review: 70, classify: 70 },
          contextWindowTokens: 1_050_000,
          toolSupport: 'full',
          multimodal: { text: true, image: true },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 2.5,
          costPerMillionOutputTokensUsd: 15,
          agent: 'codex',
          codexChatgptCapability: { supported: true },
          identity: {
            status: 'verified',
            revision: 1,
            fingerprint: 'test',
            displayName: 'gpt-5.6-terra',
            family: 'gpt',
            evidencePolicy: 'eligible',
          },
        },
      },
      ladders: { coding: ['gpt-5.6-terra'] },
    };

    const result = resolveLaunchPreflight({
      requestedModel: 'gpt-5.5',
      phase: 'coding',
      registry,
    });

    assert.equal(result.ok, true);
    if (!result.ok) assert.fail('expected successor resolution');
    assert.equal(result.requestedModel, 'gpt-5.5');
    assert.equal(result.resolvedModel, 'gpt-5.6-terra');
    assert.equal(result.agent, 'codex');
  });

  it('fails for retired models without a valid successor', () => {
    const registry: ModelRegistry = {
      models: {
        'gpt-5.5': {
          vendor: 'openai',
          class: 'frontier',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 70, coding: 70, review: 70, classify: 70 },
          contextWindowTokens: 400_000,
          toolSupport: 'full',
          multimodal: { text: true, image: true },
          latencyTier: 'slow',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 5,
          costPerMillionOutputTokensUsd: 30,
          agent: 'codex',
          codexChatgptCapability: { supported: false },
          identity: {
            status: 'verified',
            revision: 1,
            fingerprint: 'test',
            displayName: 'gpt-5.5',
            family: 'gpt',
            evidencePolicy: 'eligible',
          },
          supportedModel: {
            lifecycle: 'deprecated',
            launchEligible: false,
            routingEligible: false,
          },
        },
      },
      ladders: {},
    };

    const result = resolveLaunchPreflight({
      requestedModel: 'gpt-5.5',
      phase: 'coding',
      registry,
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected rejection');
    assert.equal(result.requestedModel, 'gpt-5.5');
    assert.equal(result.resolvedModel, null);
    assert.equal(result.reason, 'retired-model-no-successor');
    assert.match(result.diagnostic, /retired-model-no-successor/);
  });

  it('fails for unknown models', () => {
    const registry: ModelRegistry = {
      models: {},
      ladders: {},
    };

    const result = resolveLaunchPreflight({
      requestedModel: 'gpt-99-turbo',
      phase: 'coding',
      registry,
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected unknown model rejection');
    assert.equal(result.requestedModel, 'gpt-99-turbo');
    assert.equal(result.resolvedModel, null);
    assert.equal(result.reason, 'unknown-model');
  });
});
