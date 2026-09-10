import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  buildGlobalCertificationPath,
  resolveCertificationSubject,
} from '../shared/lib/native-agent/certification/index.ts';
import { DEFAULT_MODEL_REGISTRY } from '../shared/lib/model-registry.ts';
import { buildLiveCodingCanaryFixture } from '../shared/lib/native-agent/certification/canary-fixtures.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from '../shared/lib/native-agent/coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../shared/lib/native-agent/smoke.ts';
import { listEffectiveModelsForStage } from '../shared/lib/effective-models.ts';
import { claimReservation } from '../shared/lib/challenge-selection-health.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolveChallengeTaskTool = resolve(__dirname, 'resolve-challenge-task.ts');
// Relative, not absolute. A hardcoded date silently becomes stale once
// CERTIFICATION_TTL_DAYS elapses from it: '2026-06-20' + 60d expired on
// 2026-08-19, at which point every seeded native certification was rejected as
// `stale`, challenge selection fell back to a non-native model, and this suite
// began failing on every branch including a pristine base.
const CERT_FRESH_OFFSET_DAYS = 1;
const CERT_DATE_FRESH = new Date(
  Date.now() - CERT_FRESH_OFFSET_DAYS * 24 * 60 * 60 * 1000,
).toISOString();

function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  phase: string = 'workflow',
) {
  const nativeProvider = provider === 'openai' ? 'openai' : 'openrouter';
  const subjectModel = provider === 'openrouter' || provider === 'openai'
    ? model
    : `${provider}/${model}`;
  const identity = resolveCertificationSubject({
    provider: nativeProvider,
    model: subjectModel,
    registry: DEFAULT_MODEL_REGISTRY,
  });
  const certPath = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
    {
    root: join(repoDir, 'global-certifications'),
    },
  );
  mkdirSync(dirname(certPath), { recursive: true });
  writeFileSync(certPath, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase,
    suiteVersion,
    certifiedAt: CERT_DATE_FRESH,
    scenarios: [{ scenarioId: 's1', passed: true }],
    // HOK-2943: coder eligibility additionally requires live canary evidence.
    ...(phase !== 'read-only'
      ? { liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, { ranAt: CERT_DATE_FRESH }) }
      : {}),
  }), 'utf-8');
}

function writePatchCodingCertification(repoDir: string) {
  const certificationPath = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(certificationPath), { recursive: true });
  writeFileSync(certificationPath, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: CERT_DATE_FRESH,
    providers: [
      { provider: 'openai', model: 'native-certified', passed: true },
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
    ],
  }), 'utf-8');
}

function makeEvalRecord(id: string, coder: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: `Test prompt ${id}`,
    modelId: coder,
    modelVersion: coder,
    score: 0.9,
    scoreBand: 'good',
    timeSeconds: 60,
    timestamp: `2026-04-${String(Number(id) + 10).padStart(2, '0')}T00:00:00.000Z`,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    metadata: {
      stageScores: {
        plan: { score: 0.9, rationale: 'ok' },
        implementation: { score: 0.9, rationale: 'ok' },
        review: { score: 0.9, rationale: 'ok' },
      },
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 2,
          repo_size_loc: 1000,
          description_tokens: 50,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: {
          complexity: 2,
          domain: 'backend',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: [],
        objective: 'balanced',
      },
      stages: {
        planner: { model: 'claude-sonnet-4-6', cost_usd: 0.2 },
        coder: { model: coder, cost_usd: 0.4 },
        reviewer: { model: 'claude-sonnet-4-6', cost_usd: 0.2 },
      },
    },
  };
}

function makeRepo(coderHistory: string[], opts: {
  patchCodingEnabled?: boolean;
  aliases?: string[];
  primaryModels?: string[];
  suiteVersion?: string;
  certificationPhase?: string;
} = {}): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resolve-challenge-task-'));
  const aliases = opts.aliases ?? ['qwen-3-coder', 'glm-5.2'];
  const primaryModels = opts.primaryModels ?? [];
  const suiteVersion = opts.suiteVersion ?? 'v1';
  const certificationPhase = opts.certificationPhase ?? 'workflow';
  void certificationPhase;
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    challenge: {
      enabled: true,
      rate: 1,
      recommendationRate: 1,
    },
    router: {
      defaultAgent: 'claude',
    },
    ...(opts.patchCodingEnabled
      ? { nativeAgent: { patchCoding: { enabled: true } } }
      : {}),
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_RESOLVE_OPENROUTER_KEY',
      },
    },
  }), 'utf-8');
  writeFileSync(join(repoDir, '.env'), 'TEST_RESOLVE_OPENROUTER_KEY=test-key\n', 'utf-8');
  for (const alias of aliases) {
    writeCertArtifact(repoDir, 'openrouter', alias, suiteVersion, certificationPhase);
  }
  if (opts.patchCodingEnabled) {
    writePatchCodingCertification(repoDir);
  }
  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'evals.jsonl'),
    `${coderHistory.map((coder, index) => JSON.stringify(makeEvalRecord(String(index + 1), coder))).join('\n')}\n`,
    'utf-8',
  );
  return repoDir;
}

function runResolveChallengeTask(repoDir: string, args: string[]): Record<string, unknown> {
  const stdout = execFileSync('npx', ['tsx', resolveChallengeTaskTool, ...args], {
    encoding: 'utf-8',
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      [GLOBAL_CERTIFICATION_ROOT_ENV]: join(repoDir, 'global-certifications'),
    },
  });
  return JSON.parse(stdout);
}

function updateRepoConfig(repoDir: string, update: (config: Record<string, unknown>) => void): void {
  const configPath = join(repoDir, '.wavemill-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  update(config);
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

describe('resolve-challenge-task CLI', () => {
  it('claims reservations so sequential selectors choose distinct zero-record challengers', () => {
    const aliases = ['qwen-3-coder', 'glm-5.2'];
    const repoDir = makeRepo([], {
      aliases,
      patchCodingEnabled: true,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certificationPhase: 'patch',
    });
    try {
      const first = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2942-A',
        '--slug', 'selection-health-a',
        '--title', 'Reserve first challenger',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);
      const second = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2942-B',
        '--slug', 'selection-health-b',
        '--title', 'Reserve second challenger',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);

      assert.equal(first.mode, 'challenge');
      assert.equal(second.mode, 'challenge');
      const firstChallenger = (first.entries as Array<Record<string, unknown>>)
        .find((entry) => entry.role === 'challenger')?.model;
      const secondChallenger = (second.entries as Array<Record<string, unknown>>)
        .find((entry) => entry.role === 'challenger')?.model;
      assert.ok(firstChallenger);
      assert.ok(secondChallenger);
      assert.notEqual(firstChallenger, secondChallenger);
      assert.ok((second.selectionHealth as Record<string, unknown> & {
        excludedByReservation: unknown[];
      }).excludedByReservation.length >= 1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns typed selection-health defer when health filtering exhausts candidates', async () => {
    const repoDir = makeRepo([], {
      aliases: ['qwen-3-coder'],
      patchCodingEnabled: true,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certificationPhase: 'patch',
    });
    try {
      updateRepoConfig(repoDir, (config) => {
        config.challenge = {
          ...(config.challenge as Record<string, unknown>),
          rate: 0.1,
          recommendationRate: 1,
        };
      });
      const featureDir = join(repoDir, 'features', 'selection-health-only');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
        coder: 'claude-sonnet-4-6',
        reviewer: 'claude-sonnet-4-6',
        codeDepth: 'medium',
        reviewMode: 'llm',
        challengeRecommendation: {
          shouldChallenge: true,
          reason: 'new-model',
          challengerModel: 'qwen-3-coder',
          priority: 200,
        },
      }), 'utf-8');
      const candidates = listEffectiveModelsForStage('coding').models
        .filter((model) => model !== 'claude-sonnet-4-6');
      for (const [index, model] of candidates.entries()) {
        await claimReservation({
          repoDir,
          model,
          stage: 'implementation',
          owner: { issueId: `HOK-OTHER-${index}`, pairId: `HOK-OTHER-${index}` },
        });
      }
      const args = [
        '--slug', 'selection-health-only',
        '--title', 'Reserve only challenger',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
      ];
      const result = runResolveChallengeTask(repoDir, ['--issue', 'HOK-2942-D', ...args]);
      assert.equal(result.mode, 'single');
      assert.equal(result.reason, 'challenge_deferred_selection_health');
      assert.ok((result.selectionHealth as Record<string, unknown> & {
        excludedByReservation: unknown[];
      }).excludedByReservation.length >= 1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('honors challenge.selectionHealth.enabled=false without writing health state', () => {
    const repoDir = makeRepo([], {
      aliases: ['qwen-3-coder', 'glm-5.2'],
      patchCodingEnabled: true,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certificationPhase: 'patch',
    });
    try {
      updateRepoConfig(repoDir, (config) => {
        config.challenge = {
          ...(config.challenge as Record<string, unknown>),
          selectionHealth: { enabled: false },
        };
      });
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2942-E',
        '--slug', 'selection-health-disabled',
        '--title', 'Disabled selection health',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);
      assert.equal(result.mode, 'challenge');
      assert.equal(result.selectionHealth, undefined);
      assert.equal(existsSync(join(repoDir, '.wavemill', 'challenge-selection-health.json')), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('falls back to global challenge candidates when repo-local native challengers are not launchable', () => {
    const repoDir = makeRepo(['glm-5.2']);
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2500-A',
        '--slug', 'least-used-zero-record',
        '--title', 'Route least-used challenge task',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.reason, 'selected');
      const entries = result.entries as Array<Record<string, unknown>>;
      const challenger = entries.find((entry) => entry.role === 'challenger');
      assert.ok(challenger);
      assert.ok(!['qwen-3-coder', 'glm-5.2'].includes(challenger.model as string));
      const rejections = result.nativeCertificationRejections as Array<Record<string, unknown>>;
      assert.ok(rejections.some((entry) => entry.modelId === 'qwen-3-coder' && entry.reason === 'missing-artifact'));
      assert.ok(rejections.some((entry) => entry.modelId === 'glm-5.2' && entry.reason === 'missing-artifact'));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns challenge mode for HOK-2569 v3 native patch OpenRouter challengers', () => {
    const aliases = ['qwen-3-coder', 'glm-5.2', 'kimi-k2.7-code'];
    const repoDir = makeRepo([], {
      aliases,
      patchCodingEnabled: true,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certificationPhase: 'patch',
    });
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-CONFIG-VERIFY',
        '--slug', 'config-verify',
        '--title', 'Configuration verification',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.slotsRequired, 2);
      assert.equal(result.challengeStage, 'implementation');
      const entries = result.entries as Array<Record<string, unknown>>;
      assert.equal(entries.length, 2);
      const challenger = entries.find((entry) => entry.role === 'challenger');
      assert.ok(challenger);
      assert.ok(aliases.includes(challenger!.model as string), 'challenger should be a globally certified native alias');
      const rejections = (result.nativeCertificationRejections || []) as Array<Record<string, unknown>>;
      for (const alias of aliases) {
        assert.equal(
          rejections.find((entry) => entry.modelId === alias),
          undefined,
          `${alias} should not be rejected`,
        );
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns challenge_unavailable instead of single mode when a required challenge has no pair', () => {
    const repoDir = makeRepo([], { aliases: [] });
    try {
      const configPath = join(repoDir, '.wavemill-config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      config.modelExclusions = listEffectiveModelsForStage('coding').models
        .filter((model) => model !== 'qwen-3-coder')
        .map((model) => ({ model, stages: ['coding'], reason: 'strict challenge no-pair fixture' }));
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2588-NO-PAIR',
        '--slug', 'no-pair',
        '--title', 'No pair fixture',
        '--primary-model', 'qwen-3-coder',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);

      assert.equal(result.mode, 'challenge_unavailable');
      assert.equal(result.reason, 'challenge_unavailable');
      assert.equal(result.slotsRequired, 0);
      assert.equal(result.cleanupHint, 'no_worktree_created');
      assert.ok(Array.isArray(result.blockers));
      assert.ok((result.blockers as Array<Record<string, unknown>>)
        .some((blocker) => blocker.kind === 'insufficient_certified_pool'));
      assert.ok(!('single' in result), 'strict challenge must not carry a single launch payload');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps recommendation-driven implementation native challengers excluded before launch', () => {
    const repoDir = makeRepo(['qwen-3-coder', 'qwen-3-coder', 'glm-5.2', 'glm-5.2', 'glm-5.2']);
    const featureDir = join(repoDir, 'features', 'fallforward');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
      coder: 'claude-sonnet-4-6',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewMode: 'llm',
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'new-model',
        challengerModel: 'glm-5.2',
        priority: 200,
      },
    }), 'utf-8');

    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2500-B',
        '--slug', 'least-used-fallforward',
        '--title', 'Route recommendation fallforward task',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.reason, 'selected');
      assert.equal(result.selectionPath, 'recommendation-driven');
      const entries = result.entries as Array<Record<string, unknown>>;
      const challenger = entries.find((entry) => entry.role === 'challenger');
      assert.ok(challenger);
      assert.notEqual(challenger!.model, 'glm-5.2');
      const rejections = result.nativeCertificationRejections as Array<Record<string, unknown>>;
      assert.ok(rejections.some((entry) => entry.modelId === 'glm-5.2' && entry.reason === 'missing-artifact'));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('finalizes expanded top-level implementation recommendations into native coder intent', () => {
    const repoDir = makeRepo([], {
      aliases: ['glm-5.2'],
      primaryModels: ['gpt-5.5'],
      patchCodingEnabled: true,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certificationPhase: 'patch',
    });
    const featureDir = join(repoDir, 'features', 'hok-2570-timing');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.5',
      reviewer: 'gpt-5.5',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'low-data-stage',
        challengerModel: 'glm-5.2',
        stage: 'implementation',
        priority: 200,
      },
    }), 'utf-8');
    writeFileSync(join(featureDir, 'task-packet.md'), '# Task\n\nImplement the feature.\n', 'utf-8');

    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2570',
        '--slug', 'hok-2570-timing',
        '--title', 'Make registry reusable',
        '--primary-model', 'gpt-5.5',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
        '--file', join(featureDir, 'task-packet.md'),
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.decisionSource, 'expanded');
      assert.equal(result.selectionPath, 'recommendation-driven');
      assert.equal(result.challengeStage, 'implementation');
      const entries = result.entries as Array<Record<string, unknown>>;
      const primary = entries.find((entry) => entry.role === 'primary');
      const challenger = entries.find((entry) => entry.role === 'challenger');
      assert.equal(primary?.model, 'gpt-5.5');
      assert.equal(primary?.agent, 'codex');
      assert.equal(challenger?.model, 'glm-5.2');
      assert.equal(challenger?.agent, 'native-openrouter');

      const intent = result.challengeExecutionIntent as Record<string, unknown>;
      assert.equal(intent.selectedStage, 'implementation');
      assert.equal(intent.decisionSource, 'expanded');
      assert.equal(intent.selectionPath, 'recommendation-driven');
      assert.equal((intent.challenger as Record<string, unknown> & { coder: Record<string, unknown> }).coder.model, 'glm-5.2');
      assert.equal((intent.challenger as Record<string, unknown> & { coder: Record<string, unknown> }).coder.agent, 'native-openrouter');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('uses expanded planner route for planner-stage challenge intent', () => {
    const repoDir = makeRepo([], {
      aliases: [],
      primaryModels: ['gpt-5.6-terra', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    });
    const featureDir = join(repoDir, 'features', 'hok-2586-planner');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
      planner: 'claude-haiku-4-5-20251001',
      coder: 'gpt-5.6-terra',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'light',
      codeDepth: 'medium',
      reviewMode: 'static',
      provenance: { source: 'bootstrap' },
    }), 'utf-8');
    writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.6-terra',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'static',
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'low-data-stage',
        challengerModel: 'claude-haiku-4-5-20251001',
        stage: 'plan',
        priority: 200,
      },
    }), 'utf-8');
    writeFileSync(join(featureDir, 'task-packet.md'), '# Task\n\nPlan the expanded feature.\n', 'utf-8');

    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2586',
        '--slug', 'hok-2586-planner',
        '--title', 'Publish certification matrix',
        '--primary-model', 'gpt-5.6-terra',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
        '--file', join(featureDir, 'task-packet.md'),
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.decisionSource, 'expanded');
      assert.equal(result.challengeStage, 'plan');
      const entries = result.entries as Array<Record<string, unknown>>;
      const primary = entries.find((entry) => entry.role === 'primary');
      const challenger = entries.find((entry) => entry.role === 'challenger');
      assert.equal(primary?.planner, 'claude-opus-4-7');
      // The scheduler recommended claude-haiku-4-5-20251001, but a plan-stage
      // recommendation is advisory: the challenger still comes from the
      // launch-priority ranking, same as an implementation-stage challenge.
      // This repo has no launchable natives, so the ranking falls back to the
      // highest-priority incumbent that is not already the primary planner.
      assert.notEqual(challenger?.planner, primary?.planner);
      assert.equal(challenger?.planner, 'claude-opus-4-8');

      const intent = result.challengeExecutionIntent as Record<string, unknown>;
      assert.equal(intent.decisionSource, 'expanded');
      assert.equal((intent.primary as Record<string, unknown> & { planner: Record<string, unknown> }).planner.model, 'claude-opus-4-7');
      assert.equal((intent.challenger as Record<string, unknown> & { planner: Record<string, unknown> }).planner.model, 'claude-opus-4-8');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // A refresh that re-samples the stage turns an already-selected arm into an
  // unrelated pair. The mill pins the stage it chose the first time; nothing
  // downstream — not even a scheduler recommendation — may override it.
  function makePlannerRecommendationRepo() {
    const repoDir = makeRepo([], {
      aliases: [],
      primaryModels: ['gpt-5.6-terra', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    });
    const featureDir = join(repoDir, 'features', 'pinned-stage');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
      planner: 'claude-haiku-4-5-20251001',
      coder: 'gpt-5.6-terra',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'light',
      codeDepth: 'medium',
      reviewMode: 'static',
      provenance: { source: 'bootstrap' },
    }), 'utf-8');
    writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.6-terra',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'static',
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'low-data-stage',
        challengerModel: 'claude-haiku-4-5-20251001',
        stage: 'plan',
        priority: 200,
      },
    }), 'utf-8');
    writeFileSync(join(featureDir, 'task-packet.md'), '# Task\n\nPlan the expanded feature.\n', 'utf-8');
    return { repoDir, featureDir };
  }

  it('honors --pinned-stage over a scheduler stage recommendation', () => {
    const { repoDir, featureDir } = makePlannerRecommendationRepo();
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-PIN-1',
        '--slug', 'pinned-stage',
        '--title', 'Publish certification matrix',
        '--primary-model', 'gpt-5.6-terra',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
        '--file', join(featureDir, 'task-packet.md'),
        '--pinned-stage', 'implementation',
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.challengeStage, 'implementation');
      const intent = result.challengeExecutionIntent as Record<string, unknown>;
      assert.equal(intent.selectedStage, 'implementation');
      assert.equal(intent.challengeStage, 'implementation');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('accepts stage aliases from shell state when pinning', () => {
    const { repoDir, featureDir } = makePlannerRecommendationRepo();
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-PIN-2',
        '--slug', 'pinned-stage',
        '--title', 'Publish certification matrix',
        '--primary-model', 'gpt-5.6-terra',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
        '--file', join(featureDir, 'task-packet.md'),
        '--pinned-stage', 'coding',
      ]);

      assert.equal(result.challengeStage, 'implementation');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('ignores an unrecognized pinned stage instead of pinning a bogus one', () => {
    const { repoDir, featureDir } = makePlannerRecommendationRepo();
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-PIN-3',
        '--slug', 'pinned-stage',
        '--title', 'Publish certification matrix',
        '--primary-model', 'gpt-5.6-terra',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
        '--file', join(featureDir, 'task-packet.md'),
        '--pinned-stage', 'not-a-stage',
      ]);

      // Falls through to the recommendation, which pins 'plan'.
      assert.equal(result.challengeStage, 'plan');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
