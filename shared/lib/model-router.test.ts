import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { aggregateEvalHistory, recommendModel, resolveAgent, tryResolveAgent } from './model-router.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  buildGlobalCertificationPath,
  resolveCertificationStorageIdentity,
  resolveCertificationSubject,
} from './native-agent/certification/index.ts';
import { computeIdentityFingerprint, DEFAULT_MODEL_REGISTRY } from './model-registry.ts';

function writeRepoConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
}

function useGlobalCertificationRoot(repoDir: string): void {
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(repoDir, 'global-certifications');
}

function writeGlobalCertification(repoDir: string, provider: string, model: string): void {
  useGlobalCertificationRoot(repoDir);
  const identity = (() => {
    try {
      return resolveCertificationSubject({
        provider,
        model,
        registry: DEFAULT_MODEL_REGISTRY,
      });
    } catch {
      const storageIdentity = resolveCertificationStorageIdentity(provider, model);
      return {
        storageIdentity,
        subject: {
          registryKey: model,
          nativeProvider: provider,
          providerId: storageIdentity.provider,
          providerModelId: storageIdentity.model,
          providerNativeId: model,
          identityRevision: 1,
          identityFingerprint: computeIdentityFingerprint({
            alias: model,
            providerNativeId: model,
            provider,
            revision: 1,
          }),
          catalogHash: 'registry',
        },
      };
    }
  })();
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    DEFAULT_CERTIFICATION_SUITE_VERSION,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'workflow',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    // Dynamic so the artifact stays inside CERTIFICATION_TTL_DAYS regardless of run date.
    certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: '2099-12-31T23:59:59.999Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }));
}

describe('model-router resolveAgent', () => {
  it('routes known DeepSeek models to claude', () => {
    assert.equal(resolveAgent('deepseek-v4-pro', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-flash', {}, 'codex'), 'claude');
  });

  it('throws for unknown DeepSeek-like models instead of falling back', () => {
    assert.throws(
      () => resolveAgent('deepseek-v4-ultra', {}, 'claude'),
      /Unknown DeepSeek model "deepseek-v4-ultra"/,
    );
  });

  it('resolves hosted claude and gpt models from registry-backed metadata', () => {
    assert.equal(resolveAgent('claude-sonnet-4-6', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('gpt-5.6-terra', {}, 'claude'), 'codex');
    assert.equal(resolveAgent('claude-opus-5-5', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('gpt-6-sol', {}, 'claude', undefined, 'planning'), 'codex');
    assert.equal(resolveAgent('gpt-6-luna', {}, 'claude', undefined, 'coding'), 'codex');
  });

  it('fails closed when an OpenAI model is not eligible for the ChatGPT Codex surface', () => {
    assert.throws(
      () => resolveAgent('gpt-5.6-sol', {}, 'codex', undefined, 'planning'),
      /agent-resolution.*gpt-5\.6-sol.*codex-chatgpt-ineligible/,
    );
  });

  it('returns structured rejection details from tryResolveAgent', () => {
    const result = tryResolveAgent('gpt-5.6-sol', {}, 'codex', undefined, 'planning');
    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected gpt-5.6-sol planning resolution to fail');
    }
    assert.equal(result.reason, 'codex-chatgpt-ineligible');
    assert.match(result.diagnostic, /surface=codex-chatgpt/);
  });

  it('does not allow repo-local metadata to restore a retired Codex model', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-openai-'));

    try {
      writeRepoConfig(repoDir, {
        modelRegistry: { models: { 'gpt-5.4': { agent: 'native-openai' } } },
      });

      assert.throws(
        () => resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'planning'),
        /agent-resolution.*gpt-5\.4.*codex-chatgpt-ineligible/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps global Codex routing authoritative despite a global certification', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-default-off-'));

    try {
      writeGlobalCertification(repoDir, 'openai', 'gpt-5.6-terra');

      assert.equal(resolveAgent('gpt-5.6-terra', {}, 'codex', repoDir, 'planning'), 'codex');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('resolves a globally certified native OpenRouter model', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-provider-mismatch-'));

    try {
      writeGlobalCertification(repoDir, 'openrouter', 'z-ai/glm-5.2');

      assert.equal(
        resolveAgent('glm-5.2', {}, 'codex', repoDir, 'planning'),
        'native-openrouter',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('computes success rate with the shared eval success policy', () => {
    const stats = aggregateEvalHistory([
      {
        id: 'eval-1',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.8,
        scoreBand: 'Minor Feedback',
        timeSeconds: 10,
        timestamp: '2026-05-01T00:00:00.000Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'good',
      },
      {
        id: 'eval-2',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.7,
        scoreBand: 'Assisted Success',
        timeSeconds: 12,
        timestamp: '2026-05-01T00:01:00.000Z',
        interventionRequired: true,
        interventionCount: 1,
        interventionDetails: [],
        rationale: 'below threshold',
      },
    ], 'bugfix');

    assert.equal(stats[0]?.successRate, 0.5);
  });

  it('counts terminal arm failures as attempts in successRate', () => {
    // Two completed successes and five terminal stalls: 2/7, not 2/2. Without
    // this the failures are absent from the denominator entirely, so a model
    // that stalls more is sampled more selectively and scores higher.
    const evalRecord = (id: string, score: number) => ({
      id,
      schemaVersion: '1.15.0',
      originalPrompt: 'Fix a bug in routing',
      modelId: 'llama-4-maverick',
      modelVersion: 'llama-4-maverick',
      score,
      scoreBand: 'Minor Feedback',
      timeSeconds: 10,
      timestamp: '2026-05-01T00:00:00.000Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'completed',
    });

    const failure = (n: number) => ({
      schemaVersion: '1.0.0' as const,
      id: `fail-${n}`,
      timestamp: '2026-05-01T00:00:00.000Z',
      issueId: `HOK-100${n}_c`,
      challengePairId: `HOK-100${n}`,
      challengeRole: 'challenger' as const,
      stage: 'implementation',
      model: 'llama-4-maverick',
      completed: false,
      abortReason: 'terminal_stage_failure:native-provider-error',
      failureKind: 'native-provider-error',
      faultClass: 'unknown-fault' as const,
      qualitySignalEligible: false,
      source: 'challenge_abort_pair' as const,
    });

    const stats = aggregateEvalHistory(
      [evalRecord('ok-1', 0.9), evalRecord('ok-2', 0.9)],
      'bugfix',
      { terminalFailures: [1, 2, 3, 4, 5].map(failure) as never },
    );

    assert.equal(stats[0]?.successRate, 2 / 7);
  });

  it('ranks a model whose every attempt failed, rather than omitting it', () => {
    // With no eval records at all, such a model would otherwise be absent from
    // the stats entirely and get scored on its optimistic registry prior --
    // rewarded for never having succeeded.
    const stats = aggregateEvalHistory([], 'bugfix', {
      terminalFailures: [{
        schemaVersion: '1.0.0',
        id: 'fail-1',
        timestamp: '2026-05-01T00:00:00.000Z',
        issueId: 'HOK-1001_c',
        challengePairId: 'HOK-1001',
        challengeRole: 'challenger',
        stage: 'implementation',
        model: 'llama-4-maverick',
        completed: false,
        abortReason: 'terminal_stage_failure:native-provider-error',
        failureKind: 'native-provider-error',
        faultClass: 'unknown-fault',
        qualitySignalEligible: false,
        source: 'challenge_abort_pair',
      }] as never,
    });

    const entry = stats.find((s) => s.modelId === 'llama-4-maverick');
    assert.ok(entry, 'failure-only model should appear in stats');
    assert.equal(entry?.successRate, 0);
    assert.equal(entry?.totalRecords, 0);
  });

  it('keeps avgScore free of terminal failures', () => {
    // A provider stall says nothing about output quality, so it must not drag
    // the quality average down the way a genuinely poor run would.
    const record = {
      id: 'ok-1',
      schemaVersion: '1.15.0',
      originalPrompt: 'Fix a bug in routing',
      modelId: 'llama-4-maverick',
      modelVersion: 'llama-4-maverick',
      score: 0.9,
      scoreBand: 'Minor Feedback',
      timeSeconds: 10,
      timestamp: '2026-05-01T00:00:00.000Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'completed',
    };

    const withFailures = aggregateEvalHistory([record], 'bugfix', {
      terminalFailures: [{
        schemaVersion: '1.0.0',
        id: 'fail-1',
        timestamp: '2026-05-01T00:00:00.000Z',
        issueId: 'HOK-1001_c',
        challengePairId: 'HOK-1001',
        challengeRole: 'challenger',
        stage: 'implementation',
        model: 'llama-4-maverick',
        completed: false,
        abortReason: 'terminal_stage_failure:native-provider-error',
        failureKind: 'native-provider-error',
        faultClass: 'unknown-fault',
        qualitySignalEligible: false,
        source: 'challenge_abort_pair',
      }] as never,
    });

    assert.equal(withFailures[0]?.avgScore, 0.9);
    assert.equal(withFailures[0]?.successRate, 0.5);
  });

  it('never produces a NaN average from a non-numeric score', () => {
    // score is required by the schema, but a malformed or legacy line can still
    // reach here. NaN would poison the sort silently, since NaN comparisons are
    // always false.
    const stats = aggregateEvalHistory([
      {
        id: 'bad',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: undefined as never,
        scoreBand: 'Minor Feedback',
        timeSeconds: 10,
        timestamp: '2026-05-01T00:00:00.000Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'malformed',
      },
    ], 'bugfix');

    assert.ok(Number.isFinite(stats[0]?.avgScore), `avgScore was ${stats[0]?.avgScore}`);
  });

  it('excludes held records from aggregate router history stats', () => {
    const stats = aggregateEvalHistory([
      {
        id: 'verified',
        schemaVersion: '1.43.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.8,
        scoreBand: 'Minor Feedback',
        timeSeconds: 10,
        timestamp: '2026-05-01T00:00:00.000Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'good',
      },
      {
        id: 'held',
        schemaVersion: '1.43.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'ox-alpha',
        modelVersion: 'ox-alpha',
        score: 1,
        scoreBand: 'Strong',
        timeSeconds: 1,
        timestamp: '2026-05-01T00:01:00.000Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'held',
        modelIdentityAttribution: {
          observedAt: '2026-08-01T00:00:00.000Z',
          roles: {},
          provisionalRoles: ['coder'],
          candidateOnlyProvisional: [],
        },
      },
    ], 'bugfix');

    assert.deepEqual(stats.map((entry) => entry.modelId), ['gpt-5.4']);
  });

  it('loads global aggregated evals when per-repo aggregated file is missing', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-global-fallback-'));
    const globalAggregatedPath = join(repoDir, 'global-aggregated.jsonl');
    const previousOverride = process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
    const previousCwd = process.cwd();

    try {
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), '', 'utf-8');
      writeFileSync(
        globalAggregatedPath,
        [
          JSON.stringify({
            id: 'global-1',
            schemaVersion: '1.15.0',
            originalPrompt: 'Fix router bug',
            modelId: 'gpt-5.6-terra',
            modelVersion: 'gpt-5.6-terra',
            score: 0.95,
            scoreBand: 'Strong',
            timeSeconds: 20,
            timestamp: '2026-05-01T00:00:00.000Z',
            interventionRequired: false,
            interventionCount: 0,
            interventionDetails: [],
            rationale: 'strong',
          }),
          JSON.stringify({
            id: 'global-2',
            schemaVersion: '1.15.0',
            originalPrompt: 'Fix router bug',
            modelId: 'claude-sonnet-4-6',
            modelVersion: 'claude-sonnet-4-6',
            score: 0.85,
            scoreBand: 'Strong',
            timeSeconds: 18,
            timestamp: '2026-05-01T00:01:00.000Z',
            interventionRequired: false,
            interventionCount: 0,
            interventionDetails: [],
            rationale: 'solid',
          }),
        ].join('\n') + '\n',
        'utf-8',
      );

      process.env.WAVEMILL_AGGREGATED_EVALS_PATH = globalAggregatedPath;
      process.chdir(repoDir);
      const recommendation = recommendModel('Fix a routing bug', {
        mode: 'heuristic',
        repoDir,
        minRecords: 2,
        minModels: 2,
      });

      assert.equal(recommendation.insufficientData, false);
      assert.equal(recommendation.recommendedModel, 'gpt-5.6-terra');
      assert.equal(recommendation.candidates.length, 2);
    } finally {
      if (previousOverride === undefined) {
        delete process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
      } else {
        process.env.WAVEMILL_AGGREGATED_EVALS_PATH = previousOverride;
      }
      process.chdir(previousCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
