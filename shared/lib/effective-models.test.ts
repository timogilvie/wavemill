import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  explainEffectiveModelAvailability,
  listChallengerEligibleModelsForStage,
  listEffectiveModelsForStage,
} from './effective-models.ts';
import { DEFAULT_MODEL_REGISTRY, explainModelSupportExclusion, type ModelRegistry } from './model-registry.ts';

function cloneRegistry(): ModelRegistry {
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_REGISTRY)) as ModelRegistry;
}

describe('effective-models', () => {
  it('excludes retired native-openrouter aliases from coding availability', () => {
    const { models } = listEffectiveModelsForStage('coding');

    // grok-code-fast is retained lifecycle-blocked for attribution.
    assert.equal(models.includes('grok-code-fast'), false);
    const blocked = explainEffectiveModelAvailability('grok-code-fast', 'coding');
    assert.equal(blocked.available, false);
    assert.equal(blocked.reason, 'blocked-lifecycle');

    // HOK-2947 removed the stale aliases outright.
    for (const alias of ['deepseek-coder-v2', 'gemini-2.0-flash', 'qwen-2.5-coder-32b']) {
      assert.equal(models.includes(alias), false, `${alias} should not be effective for coding`);
      const availability = explainEffectiveModelAvailability(alias, 'coding');
      assert.equal(availability.available, false);
      assert.equal(availability.reason, 'unknown-model');
    }
  });

  it('excludes models with insufficient context window from coding availability', () => {
    // Test kimi-k2 specifically
    const availability = explainEffectiveModelAvailability('kimi-k2', 'coding');
    assert.equal(availability.available, false);
    assert.equal(availability.reason, 'context-window-insufficient');
    
    // But should be available for planning (no floor)
    const planningAvailability = explainEffectiveModelAvailability('kimi-k2', 'planning');
    assert.equal(planningAvailability.available, true);
  });

  it('listEffectiveModelsForStage excludes context-window-insufficient models', () => {
    const { models } = listEffectiveModelsForStage('coding');

    // Models actively selectable today whose declared window falls below the
    // built-in coding floor. Their exclusion reason must be
    // `context-window-insufficient`.
    const contextWindowExcluded = [
      'kimi-k2',
    ];
    for (const modelId of contextWindowExcluded) {
      assert.equal(models.includes(modelId), false, `${modelId} should not be effective for coding`);
      const availability = explainEffectiveModelAvailability(modelId, 'coding');
      assert.equal(availability.available, false);
      assert.equal(availability.reason, 'context-window-insufficient');
    }

    assert.ok(!models.includes('mistral-large-2'), 'blocked mistral-large-2 should not be effective for coding');
    assert.equal(explainEffectiveModelAvailability('mistral-large-2', 'coding').reason, 'blocked-lifecycle');

    // But kimi-k2 should still be available for planning
    const { models: planningModels } = listEffectiveModelsForStage('planning');
    assert.ok(planningModels.includes('kimi-k2'), 'kimi-k2 should be available for planning');
  });
});

describe('challenger eligibility', () => {
  it('keeps the deprecated ox-alpha out of both pools and admits promoted glm-5.3-flash', () => {
    // Disclosure day: ox-alpha is deprecated historical lineage (routing
    // ineligible), so it leaves the challenger pool too; its verified
    // successor glm-5.3-flash is certified and routing-eligible, so it enters
    // the primary pool (and therefore the challenger superset).
    for (const stage of ['planning', 'coding', 'review'] as const) {
      const primary = listEffectiveModelsForStage(stage, {}).models;
      const challenger = listChallengerEligibleModelsForStage(stage, {}).models;

      assert.equal(
        primary.includes('ox-alpha'),
        false,
        `deprecated model must never be primary-eligible for ${stage}`,
      );
      assert.equal(
        challenger.includes('ox-alpha'),
        false,
        `deprecated model must not stay challenger-eligible for ${stage}`,
      );
      assert.equal(
        primary.includes('glm-5.3-flash'),
        true,
        `promoted model should be primary-eligible for ${stage}`,
      );
      assert.equal(
        challenger.includes('glm-5.3-flash'),
        true,
        `promoted model should be challenger-eligible for ${stage}`,
      );
    }
  });

  it('matches the effective stage projection exactly', () => {
    for (const stage of ['planning', 'coding', 'review'] as const) {
      assert.deepEqual(
        listChallengerEligibleModelsForStage(stage, {}).models,
        listEffectiveModelsForStage(stage, {}).models,
      );
    }
  });

  it('does not admit provisional routing-ineligible identities to challenger pools', () => {
    const registry = cloneRegistry();
    const base = registry.models['glm-5.3-flash'];
    assert.ok(base, 'expected fixture base model to exist');
    registry.models['hok-2920-provisional'] = {
      ...base,
      qualityScores: {
        expansion: 0,
        planning: 0,
        coding: 0,
        review: 0,
      },
      supportedModel: {
        ...base.supportedModel,
        wavemillAlias: 'hok-2920-provisional',
        providerNativeId: 'test/hok-2920-provisional',
        stages: ['planning', 'coding', 'review'],
        launchEligible: true,
        routingEligible: false,
      },
      identity: {
        status: 'provisional',
        revision: 1,
        fingerprint: 'a'.repeat(64),
        displayName: 'HOK 2920 Provisional',
        family: 'unknown',
        evidencePolicy: 'held',
      },
    };

    for (const stage of ['planning', 'coding', 'review'] as const) {
      assert.equal(
        explainModelSupportExclusion('hok-2920-provisional', stage, registry),
        'provisional-identity',
      );
      assert.equal(
        listEffectiveModelsForStage(stage, { registry }).models.includes('hok-2920-provisional'),
        false,
      );
      assert.equal(
        listChallengerEligibleModelsForStage(stage, { registry }).models.includes('hok-2920-provisional'),
        false,
      );
    }
  });
});
