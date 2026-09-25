import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { filterDisabledModels } from './disabled-models.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';
import { resolveModel, viableCandidatesInPool } from './routing-policy.ts';
import { routeWorkflowAuto, tryPolicyResolution } from './workflow-router.ts';

function makeSnapshot(statuses: Partial<Record<string, QuotaStatus>> = {}): QuotaSnapshot {
  const models = Object.fromEntries(
    Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [
      modelId,
      {
        status: statuses[modelId] ?? 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
      },
    ]),
  );

  return {
    models,
    snapshotAt: new Date().toISOString(),
  };
}

function makeSnapshotWithCustomModels(
  models: string[],
  statuses: Partial<Record<string, QuotaStatus>> = {},
): QuotaSnapshot {
  const modelEntries = Object.fromEntries(
    models.map((modelId) => [
      modelId,
      {
        status: statuses[modelId] ?? 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: 0,
      },
    ]),
  );

  return {
    models: modelEntries,
    snapshotAt: new Date().toISOString(),
  };
}

function baseConfig(mode: 'auto' | 'heuristic' = 'auto') {
  return {
    router: {
      enabled: true,
      mode,
      defaultAgent: 'claude',
      minRecords: 4,
      minModels: 2,
    },
    eval: {
      pricing: {
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.4': { inputCostPerMTok: 2.5, outputCostPerMTok: 10, cacheWriteCostPerMTok: 3.125, cacheReadCostPerMTok: 0.625 },
        'gpt-5.5': { inputCostPerMTok: 5, outputCostPerMTok: 30, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      },
    },
  };
}

function makeRepo(configOverride?: Record<string, unknown>): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'routing-policy-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    ...baseConfig(),
    ...configOverride,
  }));
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function writeQuotaState(repoDir: string, statuses: Partial<Record<string, QuotaStatus>>): void {
  const models = Object.fromEntries(
    Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [
      modelId,
      {
        status: statuses[modelId] ?? 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: 0,
      },
    ]),
  );

  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    models,
  }));
}

describe('routing-policy ranking', () => {
  it('ranks the top healthy coding model first when quota is healthy', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
    });

    assert.equal(ranked[0].modelId, 'claude-fable-5');
    assert.equal(ranked[0].viable, true);
  });

  it('penalizes degrading models without excluding them', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot({ 'gpt-5.5': 'degrading' }),
    });

    const degraded = ranked.find((candidate) => candidate.modelId === 'gpt-5.5');
    assert.ok(degraded);
    assert.equal(degraded.viable, true);
    assert.equal(degraded.adjustedScore, 78.2);
    assert.equal(ranked[0].modelId, 'claude-fable-5');
  });

  it('excludes exhausted primary models and promotes the next viable candidate', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot({ 'gpt-5.5': 'exhausted' }),
    });

    const exhausted = ranked.find((candidate) => candidate.modelId === 'gpt-5.5');
    assert.ok(exhausted);
    assert.equal(exhausted.viable, false);
    assert.equal(exhausted.exclusionReason, 'quota-exhausted');
    assert.equal(ranked[0].modelId, 'claude-fable-5');
  });

  it('falls back to strong generalists on critical tasks when all frontier models are exhausted', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'critical',
      quotaState: makeSnapshot(Object.fromEntries(
        Object.entries(DEFAULT_MODEL_REGISTRY.models)
          .filter(([, model]) => model.class === 'frontier')
          .map(([modelId]) => [modelId, 'exhausted']),
      )),
    });

    assert.equal(DEFAULT_MODEL_REGISTRY.models[ranked[0].modelId]?.class, 'strong_generalist');
    assert.equal(ranked[0].viable, true);
    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, false);
    assert.equal(haiku.exclusionReason, 'below-difficulty-floor');
  });

  it('returns no viable candidates when every model is exhausted', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(
        Object.fromEntries(
          Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [modelId, 'exhausted']),
        ),
      ),
    });

    assert.equal(ranked.some((candidate) => candidate.viable), false);
  });

  it('allows fast economy models on trivial difficulty', () => {
    const ranked = resolveModel({
      taskType: 'classify',
      difficulty: 'trivial',
      quotaState: makeSnapshot(),
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, true);
  });

  it('keeps fast economy viable on moderate difficulty', () => {
    const ranked = resolveModel({
      taskType: 'classify',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, true);
  });

  it('rejects fast economy on hard difficulty', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'hard',
      quotaState: makeSnapshot(),
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, false);
    assert.equal(haiku.exclusionReason, 'below-difficulty-floor');
  });

  it('rejects non-frontier models on critical difficulty while frontier is viable', () => {
    const ranked = resolveModel({
      taskType: 'planning',
      difficulty: 'critical',
      quotaState: makeSnapshot(),
    });

    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-5');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, false);
    assert.equal(sonnet.exclusionReason, 'below-difficulty-floor');
  });

  it('applies cost tier filters before ranking', () => {
    const ranked = resolveModel({
      taskType: 'planning',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      maxCostTier: 'strong_generalist',
    });

    const frontier = ranked.find((candidate) => candidate.modelId === 'claude-opus-4-7');
    assert.ok(frontier);
    assert.equal(frontier.viable, false);
    assert.equal(frontier.exclusionReason, 'exceeds-cost-tier');
    assert.equal(ranked[0].modelId, 'gpt-5.6-terra');
    assert.equal(ranked[0].viable, true);

    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-5');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, true);
  });

  it('applies minimum quality thresholds after floor and cost checks', () => {
    const ranked = resolveModel({
      taskType: 'planning',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      minQualityScore: 80,
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, false);
    assert.equal(haiku.exclusionReason, 'below-quality-threshold');
  });

  it('combines cost tier and quality filters deterministically', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      maxCostTier: 'strong_generalist',
      minQualityScore: 87,
    });

    assert.equal(ranked[0].modelId, 'claude-sonnet-5');
    assert.equal(ranked[0].viable, true);
    const sonnet45 = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-4-5-20250929');
    assert.ok(sonnet45);
    assert.equal(sonnet45.viable, false);
    assert.equal(sonnet45.exclusionReason, 'below-quality-threshold');
  });

  it('promotes a healthy frontier sibling over strong_generalist when top-of-ladder frontier is degrading', () => {
    const testRegistry = {
      models: {
        'claude-opus-4-7': {
          vendor: 'anthropic' as const,
          class: 'frontier' as const,
          strengths: ['reasoning'],
          weaknesses: ['cost'],
          qualityScores: { planning: 95, coding: 95, review: 85, classify: 95, routing: 60 },
        },
        'gpt-5.4': {
          vendor: 'openai' as const,
          class: 'frontier' as const,
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
        'claude-sonnet-5': {
          vendor: 'anthropic' as const,
          class: 'strong_generalist' as const,
          strengths: ['balanced'],
          weaknesses: [],
          qualityScores: { planning: 75, coding: 90, review: 90, classify: 82, routing: 78 },
        },
        'claude-haiku-4-5-20251001': {
          vendor: 'anthropic' as const,
          class: 'fast_economy' as const,
          strengths: ['speed'],
          weaknesses: [],
          qualityScores: { planning: 88, coding: 55, review: 60, classify: 55, routing: 92 },
        },
      },
      ladders: {
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.4'],
      },
    };

    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'hard',
      quotaState: makeSnapshotWithCustomModels(['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], { 'claude-opus-4-7': 'degrading' }),
      repoDir: undefined,
    }, testRegistry);

    assert.equal(ranked[0].modelId, 'gpt-5.4');
    assert.equal(ranked[0].viable, true);
    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-5');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, false);
    assert.equal(sonnet.exclusionReason, 'below-frontier-substitute');
  });

  it('promotes a healthy frontier sibling over strong_generalist when top-of-ladder frontier is exhausted', () => {
    const testRegistry = {
      models: {
        'claude-opus-4-7': {
          vendor: 'anthropic' as const,
          class: 'frontier' as const,
          strengths: ['reasoning'],
          weaknesses: ['cost'],
          qualityScores: { planning: 95, coding: 95, review: 85, classify: 95, routing: 60 },
        },
        'gpt-5.4': {
          vendor: 'openai' as const,
          class: 'frontier' as const,
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
        'claude-sonnet-5': {
          vendor: 'anthropic' as const,
          class: 'strong_generalist' as const,
          strengths: ['balanced'],
          weaknesses: [],
          qualityScores: { planning: 75, coding: 90, review: 90, classify: 82, routing: 78 },
        },
        'claude-haiku-4-5-20251001': {
          vendor: 'anthropic' as const,
          class: 'fast_economy' as const,
          strengths: ['speed'],
          weaknesses: [],
          qualityScores: { planning: 88, coding: 55, review: 60, classify: 55, routing: 92 },
        },
      },
      ladders: {
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.4'],
      },
    };

    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'hard',
      quotaState: makeSnapshotWithCustomModels(['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], { 'claude-opus-4-7': 'exhausted' }),
      repoDir: undefined,
    }, testRegistry);

    assert.equal(ranked[0].modelId, 'gpt-5.4');
    assert.equal(ranked[0].viable, true);
    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-5');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, false);
    assert.equal(sonnet.exclusionReason, 'below-frontier-substitute');
  });

  it('does not substitute when every frontier is degrading', () => {
    const testRegistry = {
      models: {
        'claude-opus-4-7': {
          vendor: 'anthropic' as const,
          class: 'frontier' as const,
          strengths: ['reasoning'],
          weaknesses: ['cost'],
          qualityScores: { planning: 95, coding: 95, review: 85, classify: 95, routing: 60 },
        },
        'gpt-5.4': {
          vendor: 'openai' as const,
          class: 'frontier' as const,
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
        'claude-sonnet-5': {
          vendor: 'anthropic' as const,
          class: 'strong_generalist' as const,
          strengths: ['balanced'],
          weaknesses: [],
          qualityScores: { planning: 75, coding: 90, review: 90, classify: 82, routing: 78 },
        },
        'claude-haiku-4-5-20251001': {
          vendor: 'anthropic' as const,
          class: 'fast_economy' as const,
          strengths: ['speed'],
          weaknesses: [],
          qualityScores: { planning: 88, coding: 55, review: 60, classify: 55, routing: 92 },
        },
      },
      ladders: {
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.4'],
      },
    };

    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'hard',
      quotaState: makeSnapshotWithCustomModels(['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], { 'claude-opus-4-7': 'degrading', 'gpt-5.4': 'degrading' }),
      repoDir: undefined,
    }, testRegistry);

    // Sonnet should be viable when both frontiers are degrading
    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-5');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, true);
  });

  it('does not substitute in normal mode (all frontiers healthy)', () => {
    const testRegistry = {
      models: {
        'claude-opus-4-7': {
          vendor: 'anthropic' as const,
          class: 'frontier' as const,
          strengths: ['reasoning'],
          weaknesses: ['cost'],
          qualityScores: { planning: 95, coding: 95, review: 85, classify: 95, routing: 60 },
        },
        'gpt-5.4': {
          vendor: 'openai' as const,
          class: 'frontier' as const,
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
        'claude-sonnet-5': {
          vendor: 'anthropic' as const,
          class: 'strong_generalist' as const,
          strengths: ['balanced'],
          weaknesses: [],
          qualityScores: { planning: 75, coding: 90, review: 90, classify: 82, routing: 78 },
        },
        'claude-haiku-4-5-20251001': {
          vendor: 'anthropic' as const,
          class: 'fast_economy' as const,
          strengths: ['speed'],
          weaknesses: [],
          qualityScores: { planning: 88, coding: 55, review: 60, classify: 55, routing: 92 },
        },
      },
      ladders: {
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.4'],
      },
    };

    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshotWithCustomModels(['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']),
      repoDir: undefined,
    }, testRegistry);

    // In normal mode when all are healthy, no substitution rule applies, so ranking is purely by quality score
    // opus-4-7 (95) > sonnet (90) > gpt-5.4 (82), so opus-4-7 ranks first
    assert.equal(ranked[0].modelId, 'claude-opus-4-7');
  });

  it('healthy frontier outranks degrading frontier via sort rule', () => {
    const testRegistry = {
      models: {
        'claude-opus-4-7': {
          vendor: 'anthropic' as const,
          class: 'frontier' as const,
          strengths: ['reasoning'],
          weaknesses: ['cost'],
          qualityScores: { planning: 95, coding: 95, review: 85, classify: 95, routing: 60 },
        },
        'gpt-5.4': {
          vendor: 'openai' as const,
          class: 'frontier' as const,
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
        'claude-sonnet-5': {
          vendor: 'anthropic' as const,
          class: 'strong_generalist' as const,
          strengths: ['balanced'],
          weaknesses: [],
          qualityScores: { planning: 75, coding: 90, review: 90, classify: 82, routing: 78 },
        },
        'claude-haiku-4-5-20251001': {
          vendor: 'anthropic' as const,
          class: 'fast_economy' as const,
          strengths: ['speed'],
          weaknesses: [],
          qualityScores: { planning: 88, coding: 55, review: 60, classify: 55, routing: 92 },
        },
      },
      ladders: {
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.4'],
      },
    };

    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'hard',
      quotaState: makeSnapshotWithCustomModels(['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], { 'claude-opus-4-7': 'degrading' }),
      repoDir: undefined,
    }, testRegistry);

    const opusIdx = ranked.findIndex((candidate) => candidate.modelId === 'claude-opus-4-7');
    const gptIdx = ranked.findIndex((candidate) => candidate.modelId === 'gpt-5.4');
    assert.ok(opusIdx !== -1);
    assert.ok(gptIdx !== -1);
    // gpt-5.4 (healthy frontier) should rank before opus (degrading frontier)
    assert.ok(gptIdx < opusIdx);
  });

  it('still allows strong_generalist fallback when all frontiers are exhausted', () => {
    const testRegistry = {
      models: {
        'claude-opus-4-7': {
          vendor: 'anthropic' as const,
          class: 'frontier' as const,
          strengths: ['reasoning'],
          weaknesses: ['cost'],
          qualityScores: { planning: 95, coding: 95, review: 85, classify: 95, routing: 60 },
        },
        'gpt-5.4': {
          vendor: 'openai' as const,
          class: 'frontier' as const,
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
        'claude-sonnet-5': {
          vendor: 'anthropic' as const,
          class: 'strong_generalist' as const,
          strengths: ['balanced'],
          weaknesses: [],
          qualityScores: { planning: 75, coding: 90, review: 90, classify: 82, routing: 78 },
        },
        'claude-haiku-4-5-20251001': {
          vendor: 'anthropic' as const,
          class: 'fast_economy' as const,
          strengths: ['speed'],
          weaknesses: [],
          qualityScores: { planning: 88, coding: 55, review: 60, classify: 55, routing: 92 },
        },
      },
      ladders: {
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.4'],
      },
    };

    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'critical',
      quotaState: makeSnapshotWithCustomModels(['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], { 'claude-opus-4-7': 'exhausted', 'gpt-5.4': 'exhausted' }),
      repoDir: undefined,
    }, testRegistry);

    // Sonnet should be viable when all frontiers are exhausted
    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-5');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, true);
  });
});

describe('routing-policy integration', () => {
  it('uses policy routing in auto mode when difficulty is available', async () => {
    const { repoDir, cleanup } = makeRepo();
    writeQuotaState(repoDir, {});

    try {
      const decision = await routeWorkflowAuto('Implement a backend feature with tests.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      });

      assert.equal(decision.routingMode, 'policy');
      assert.equal(decision.signals.taskDifficulty, 'hard');
      assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    } finally {
      cleanup();
    }
  });

  it('returns null from tryPolicyResolution when task difficulty is unavailable', () => {
    const { repoDir, cleanup } = makeRepo();
    writeQuotaState(repoDir, {});

    try {
      const decision = tryPolicyResolution('Implement a backend feature with tests.', {
        repoDir,
        skipDifficultyClassification: true,
      });

      assert.equal(decision, null);
    } finally {
      cleanup();
    }
  });

  it('falls through to stage-aware or heuristic routing when policy finds no viable models', async () => {
    const { repoDir, cleanup } = makeRepo();
    writeQuotaState(
      repoDir,
      Object.fromEntries(
        Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [modelId, 'exhausted']),
      ),
    );

    try {
      const decision = await routeWorkflowAuto('Implement a backend feature with tests.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      });

      assert.notEqual(decision.routingMode, 'policy');
    } finally {
      cleanup();
    }
  });

  it('keeps hokusai as the higher-level override while feeding policy-filtered pools', async () => {
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
    writeQuotaState(repoDir, {});

    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        predictions: {
          recommended_strategy: {
            planner_model: 'claude-opus-4-7',
            coder_model: 'claude-sonnet-5',
            reviewer_model: 'claude-opus-4-6',
            plan_depth: 'medium',
            code_depth: 'medium',
            review_mode: 'standard',
            estimated_success_under_budget: 0.88,
            estimated_cost_usd: 4.2,
            confidence: 0.81,
          },
        },
        metadata: {},
      }), { status: 200 });
    };

    try {
      const decision = await routeWorkflowAuto('Secure the payment workflow integration.', {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      });

      assert.equal(decision.routingMode, 'hokusai');
      assert.ok(requestBody);
      const availableModels = (requestBody?.inputs as { routing?: Record<string, string[]> } | undefined)?.routing;
      // Disabled models are filtered from the pools fed to Hokusai, so apply
      // the same filter to the expected sets (robust to the disable set).
      assert.deepEqual(
        availableModels?.available_coder_models?.sort(),
        filterDisabledModels(['claude-fable-5', 'claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'gpt-6-sol']).sort(),
      );
      assert.deepEqual(
        availableModels?.available_planner_models?.sort(),
        filterDisabledModels(['claude-fable-5', 'claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'gpt-6-sol']).sort(),
      );
      assert.equal(decision.signals.taskDifficulty, 'critical');
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });

  it('leaves policy selection unchanged when capability filtering is disabled', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      capabilityConstraints: {
        minContextWindow: 1_000_000,
      },
    });

    assert.equal(ranked[0].modelId, 'claude-fable-5');
    assert.equal(ranked[0].exclusionReason, undefined);
  });

  it('filters candidates by capability constraints when enabled', () => {
    const { repoDir, cleanup } = makeRepo({
      router: {
        ...baseConfig().router,
        capabilityFiltering: {
          enabled: true,
        },
      },
    });

    const registry = {
      models: {
        'slow-no-tools': {
          ...DEFAULT_MODEL_REGISTRY.models['claude-sonnet-5'],
          qualityScores: { routing: 70, planning: 90, coding: 95, review: 82, classify: 60 },
          contextWindowTokens: 128_000,
          toolSupport: 'none' as const,
          multimodal: { text: true, image: false },
          latencyTier: 'slow' as const,
        },
        'fast-tools-mm': {
          ...DEFAULT_MODEL_REGISTRY.models['gpt-5.4'],
          qualityScores: { routing: 68, planning: 85, coding: 88, review: 80, classify: 60 },
          contextWindowTokens: 1_000_000,
          toolSupport: 'full' as const,
          multimodal: { text: true, image: true },
          latencyTier: 'fast' as const,
        },
      },
      ladders: {
        coding: ['slow-no-tools', 'fast-tools-mm'],
      },
    };

    try {
      const ranked = resolveModel({
        taskType: 'coding',
        difficulty: 'moderate',
        quotaState: makeSnapshotWithCustomModels(['slow-no-tools', 'fast-tools-mm']),
        repoDir,
        capabilityConstraints: {
          minContextWindow: 200_000,
          requiresTools: true,
          requiresMultimodal: true,
          maxLatencyTier: 'standard',
        },
      }, registry);

      assert.equal(ranked[0].modelId, 'fast-tools-mm');
      assert.equal(ranked[0].viable, true);
      const filtered = ranked.find((candidate) => candidate.modelId === 'slow-no-tools');
      assert.ok(filtered);
      assert.equal(filtered.exclusionReason, 'missing-capability');
      assert.deepEqual(filtered.capabilityFailures, [
        'minContextWindow',
        'requiresTools',
        'requiresMultimodal',
        'maxLatencyTier',
      ]);
    } finally {
      cleanup();
    }
  });

  it('ANDs combined constraints after quota and difficulty checks', () => {
    const { repoDir, cleanup } = makeRepo({
      router: {
        ...baseConfig().router,
        capabilityFiltering: {
          enabled: true,
        },
      },
    });

    try {
      const ranked = resolveModel({
        taskType: 'coding',
        difficulty: 'critical',
        quotaState: makeSnapshot({
          'gpt-5.4': 'exhausted',
        }),
        repoDir,
        capabilityConstraints: {
          minContextWindow: 1_000_000,
          requiresTools: true,
        },
      });

      const exhausted = ranked.find((candidate) => candidate.modelId === 'gpt-5.4');
      assert.ok(exhausted);
      assert.equal(exhausted.exclusionReason, 'quota-exhausted');
      const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
      assert.ok(haiku);
      assert.equal(haiku.exclusionReason, 'below-difficulty-floor');
      assert.ok(ranked.some((candidate) => candidate.exclusionReason === 'missing-capability'));
    } finally {
      cleanup();
    }
  });

  it('falls back to the unfiltered viable pool when capability filters empty the pool', () => {
    const { repoDir, cleanup } = makeRepo({
      router: {
        ...baseConfig().router,
        capabilityFiltering: {
          enabled: true,
        },
      },
    });

    try {
      const result = viableCandidatesInPool({
        taskType: 'coding',
        difficulty: 'moderate',
        quotaState: makeSnapshot(),
        repoDir,
        capabilityConstraints: {
          minContextWindow: 2_000_000,
        },
      }, ['gpt-5.5', 'gpt-5.4']);

      assert.equal(result.capabilityFallbackUsed, true);
      assert.deepEqual(result.modelIds, ['gpt-5.5', 'gpt-5.4']);
    } finally {
      cleanup();
    }
  });
});
