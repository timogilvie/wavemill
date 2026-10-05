#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certifyNativeAgent } from './native-agent-certify.ts';
import { clearConfigCache } from '../shared/lib/config.ts';
import { resolveWavemillToolPath } from '../shared/lib/native-agent/install-paths.ts';
import { filterNativeModels, type RouterRole } from '../shared/lib/native-agent/certification/router-filter.ts';
import { CERTIFICATION_SCHEMA_VERSION, type CertificationPhase, type NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from '../shared/lib/native-agent/certification/scenarios.ts';
import { resolveCertificationStorageIdentity } from '../shared/lib/native-agent/certification/identity.ts';
import { writeCertification } from '../shared/lib/native-agent/certification/store.ts';
import { isPatchCodingEnabled } from '../shared/lib/native-agent/coding-gate.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
  writePatchCodingCertification,
} from '../shared/lib/native-agent/coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../shared/lib/native-agent/smoke.ts';
import { expandIssue } from '../shared/lib/issue-expander.ts';
import { NativeExpansionUnavailableError } from '../shared/lib/native-expansion.ts';
import { reviewEngineTestUtils, runReview } from '../shared/lib/review-engine.ts';
import { routeWorkflow } from '../shared/lib/workflow-router.ts';
import type { ModelCapabilities, ModelRegistry } from '../shared/lib/model-registry.ts';
import type { ReviewContext } from '../shared/lib/review-context-gatherer.ts';

const MODELS = [
  {
    rawId: 'qwen/qwen3-coder',
    providerPath: 'qwen',
    modelPath: 'qwen3-coder',
    modelClass: 'strong_generalist' as const,
    vendor: 'qwen',
    qualityScores: { routing: 58, planning: 72, coding: 84, review: 78, classify: 58 },
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: false },
    reasoningTier: 'advanced' as const,
    inputCost: 0.35,
    outputCost: 1.05,
  },
  {
    rawId: 'z-ai/glm-5.2',
    providerPath: 'z-ai',
    modelPath: 'glm-5.2',
    modelClass: 'frontier' as const,
    vendor: 'z-ai',
    qualityScores: { routing: 60, planning: 80, coding: 80, review: 84, classify: 60 },
    contextWindowTokens: 1_048_576,
    multimodal: { text: true, image: false },
    reasoningTier: 'advanced' as const,
    inputCost: 0.93,
    outputCost: 3,
  },
  {
    rawId: 'moonshotai/kimi-k2.7-code',
    providerPath: 'moonshotai',
    modelPath: 'kimi-k2.7-code',
    modelClass: 'strong_generalist' as const,
    vendor: 'kimi',
    qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: true },
    reasoningTier: 'advanced' as const,
    inputCost: 0.74,
    outputCost: 3.5,
  },
] as const;

type ModelCase = typeof MODELS[number];

type LocalModelRegistryConfig = {
  models?: Record<string, Partial<ModelCapabilities>>;
  ladders?: ModelRegistry['ladders'];
};

function modelConfig(model: ModelCase): Partial<ModelCapabilities> {
  return {
    vendor: model.vendor,
    class: model.modelClass,
    strengths: [],
    weaknesses: [],
    qualityScores: model.qualityScores,
    contextWindowTokens: model.contextWindowTokens,
    toolSupport: 'full',
    multimodal: model.multimodal,
    latencyTier: 'standard',
    reasoningTier: model.reasoningTier,
    costPerMillionInputTokensUsd: model.inputCost,
    costPerMillionOutputTokensUsd: model.outputCost,
    agent: 'native-openrouter',
    nativeCapability: {
      nativeProvider: 'openrouter',
      piTransportKind: 'openai-completions',
      readOnlyNative: 'certified',
      compatFlags: { thinkingFormat: 'openrouter' },
      certification: {
        maxCertifiedPhase: 'workflow',
        certifiedAt: '2026-07-01T00:00:00.000Z',
        certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      },
    },
  };
}

function baseConfig(): Record<string, unknown> {
  const registryModels = Object.fromEntries(
    MODELS.map((model) => [model.rawId, modelConfig(model)]),
  ) as LocalModelRegistryConfig['models'];

  return {
    configVersion: '1.4.1',
    eval: {
      judge: {
        model: 'claude-sonnet-5',
        provider: 'anthropic',
      },
      pricing: {
        'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15 },
        'gpt-5.4': { inputCostPerMTok: 2.5, outputCostPerMTok: 15 },
      },
    },
    router: {
      enabled: true,
      mode: 'heuristic',
      defaultAgent: 'codex',
      defaultModel: 'gpt-5.4',
      minRecords: 1,
      minModels: 1,
      agentMap: {
        'claude-sonnet-5': 'claude',
        'gpt-5.4': 'codex',
        ...Object.fromEntries(MODELS.map((model) => [model.rawId, 'native-openrouter'])),
      },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['task-expansion', 'planning', 'review'],
      patchCoding: {
        enabled: false,
      },
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
          models: MODELS.map((model) => model.rawId),
        },
      },
    },
    modelRegistry: {
      models: registryModels,
    },
  };
}

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'hok2421-native-patch-path-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'records.jsonl'), '', 'utf-8');
  writeConfig(repoDir, baseConfig());
  return repoDir;
}

function writeConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
}

function getRegistry(repoDir: string): ModelRegistry {
  const config = JSON.parse(readFileSync(join(repoDir, '.wavemill-config.json'), 'utf-8')) as {
    modelRegistry?: LocalModelRegistryConfig;
  };
  return {
    models: config.modelRegistry?.models ?? {},
    ladders: config.modelRegistry?.ladders ?? {},
  } as unknown as ModelRegistry;
}

function writePhaseArtifact(repoDir: string, model: ModelCase, phase: CertificationPhase, overrides: Partial<NativeCertificationArtifact> = {}): string {
  const identity = resolveCertificationStorageIdentity('openrouter', model.rawId);
  return writeCertification(repoDir, {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase,
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: '2026-07-09T12:00:00.000Z',
    scenarios: [{ scenarioId: `hok2421.${phase}`, passed: true }],
    ...overrides,
  });
}

function writeArtifactAtRequiredPath(repoDir: string, model: ModelCase, artifact: NativeCertificationArtifact): string {
  const identity = resolveCertificationStorageIdentity('openrouter', model.rawId);
  const artifactDir = join(repoDir, '.wavemill', 'native-agent-certifications', identity.provider, identity.model);
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifactPath;
}

function capturePlanningEligibility(repoDir: string, env: Record<string, string | undefined>): {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const checkTool = resolveWavemillToolPath('check-native-eligibility.ts');
  const command = `npx tsx ${checkTool} ${repoDir} planning`;
  const result = spawnSync('npx', ['tsx', checkTool, repoDir, 'planning'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf-8',
  });

  return {
    command,
    exitCode: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function makeReviewContext(): ReviewContext {
  return {
    diff: 'diff --git a/file.ts b/file.ts',
    taskPacket: '# Task Packet',
    plan: '# Plan',
    designContext: null,
    metadata: {
      branch: 'task/hok2421',
      files: ['file.ts'],
      lineCount: { added: 1, removed: 0 },
      hasUiChanges: false,
    },
  };
}

async function verifyExpansionDispatch(repoDir: string): Promise<{
  native: string;
  rollback: string;
}> {
  const native = await expandIssue({
    promptTemplate: 'prompt',
    issueContext: 'issue',
    repoDir,
  }, {
    importNativeExpansion: async () => ({
      NativeExpansionUnavailableError,
      runNativeExpansion: async () => ({
        text: 'native task expansion',
        native: {
          agent: 'native-openrouter',
          model: MODELS[0]!.rawId,
          provider: 'openrouter',
          api: 'openai-completions',
          transcriptPath: '/tmp/hok2421-native-expansion.jsonl',
          cost: 0,
          durationMs: 1,
          stopReason: 'stop',
          totalInputTokens: 1,
          totalOutputTokens: 1,
          deniedToolCalls: [],
        },
      }),
    }),
  });

  assert.equal(native.text, 'native task expansion');

  const rollbackConfig = {
    ...baseConfig(),
    nativeAgent: {
      ...((baseConfig().nativeAgent ?? {}) as Record<string, unknown>),
      allowedPhases: ['planning', 'review'],
    },
  };
  writeConfig(repoDir, rollbackConfig);

  const rollback = await expandIssue({
    promptTemplate: 'prompt',
    issueContext: 'issue',
    repoDir,
  }, {
    expandIssueWithClaude: async () => 'claude task expansion rollback',
    importNativeExpansion: async () => {
      throw new Error('native expansion should not be imported after task-expansion rollback');
    },
  });

  assert.equal(rollback.text, 'claude task expansion rollback');

  writeConfig(repoDir, baseConfig());
  return { native: native.text, rollback: rollback.text };
}

async function verifyReviewDispatch(repoDir: string): Promise<{
  nativeLoaderCalls: number;
  fallbackPersonaCalls: number;
}> {
  const context = makeReviewContext();
  let nativeLoaderCalls = 0;
  let fallbackPersonaCalls = 0;

  reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
    nativeLoaderCalls += 1;
    return {
      async runNativeReview() {
        return {
          verdict: 'ready',
          codeReviewFindings: [],
          metadata: context.metadata,
        };
      },
    };
  });

  const nativeResult = await runReview(context, repoDir, { skipClaudePreflight: true });
  assert.equal(nativeResult.verdict, 'ready');

  writeConfig(repoDir, {
    ...baseConfig(),
    nativeAgent: {
      ...((baseConfig().nativeAgent ?? {}) as Record<string, unknown>),
      allowedPhases: ['task-expansion', 'planning'],
    },
  });

  reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
    nativeLoaderCalls += 1;
    throw new Error('native review should not run after review rollback');
  });
  reviewEngineTestUtils.setRunPersonaReview(async () => {
    fallbackPersonaCalls += 1;
    return {
      verdict: 'ready',
      codeReviewFindings: [],
      metadata: context.metadata,
    };
  });

  const fallbackResult = await runReview(context, repoDir, { skipClaudePreflight: true });
  assert.equal(fallbackResult.verdict, 'ready');
  assert.equal(fallbackPersonaCalls, 1);

  reviewEngineTestUtils.resetDeps();
  writeConfig(repoDir, baseConfig());
  return { nativeLoaderCalls, fallbackPersonaCalls };
}

function verifyRouterEligibility(repoDir: string): {
  acceptedPatchArtifacts: Array<{ modelId: string; artifactPath: string }>;
  rejectedDiagnostics: Record<string, string>;
} {
  const registry = getRegistry(repoDir);
  const acceptedPatchArtifacts = MODELS.map((model) => ({
    modelId: model.rawId,
    artifactPath: writePhaseArtifact(repoDir, model, 'patch'),
  }));

  for (const item of acceptedPatchArtifacts) {
    const result = filterNativeModels([item.modelId], 'coder', registry, repoDir);
    assert.deepEqual(result.eligible, [item.modelId]);
    assert.deepEqual(result.rejected, []);
  }

  const target = MODELS[0]!;
  const rejectedDiagnostics: Record<string, string> = {};

  rmSync(acceptedPatchArtifacts[0]!.artifactPath, { force: true });
  const missingResult = filterNativeModels([target.rawId], 'coder', registry, repoDir);
  rejectedDiagnostics.missing = missingResult.rejected[0]!.reason;

  writePhaseArtifact(repoDir, target, 'patch', {
    certifiedAt: '2020-01-01T00:00:00.000Z',
  });
  rejectedDiagnostics.stale = filterNativeModels([target.rawId], 'coder', registry, repoDir).rejected[0]!.reason;

  writeArtifactAtRequiredPath(repoDir, target, {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: target.providerPath,
    model: target.modelPath,
    phase: 'patch',
    suiteVersion: 'v0',
    certifiedAt: '2026-07-09T12:00:00.000Z',
    scenarios: [{ scenarioId: 'hok2421.patch', passed: true }],
  });
  rejectedDiagnostics['wrong-suite'] = filterNativeModels([target.rawId], 'coder', registry, repoDir).rejected[0]!.reason;

  const readOnlyOnlyPath = writePhaseArtifact(repoDir, target, 'read-only');
  rejectedDiagnostics['read-only-only'] = filterNativeModels([target.rawId], 'coder', registry, repoDir).rejected[0]!.reason;

  writeFileSync(readOnlyOnlyPath, '{ invalid json', 'utf-8');
  rejectedDiagnostics.malformed = filterNativeModels([target.rawId], 'coder', registry, repoDir).rejected[0]!.reason;

  assert.deepEqual(rejectedDiagnostics, {
    missing: 'missing',
    stale: 'stale',
    'wrong-suite': 'wrong-suite',
    'read-only-only': 'insufficient-phase',
    malformed: 'malformed',
  });

  writePhaseArtifact(repoDir, target, 'patch');

  return {
    acceptedPatchArtifacts,
    rejectedDiagnostics,
  };
}

function verifyPatchCodingGate(repoDir: string): {
  certificationPath: string;
  missingWhenEnabled: ReturnType<typeof isPatchCodingEnabled>;
  validWhenEnabled: ReturnType<typeof isPatchCodingEnabled>;
  validWhenDisabled: ReturnType<typeof isPatchCodingEnabled>;
} {
  const enabledConfig = {
    ...baseConfig(),
    nativeAgent: {
      ...((baseConfig().nativeAgent ?? {}) as Record<string, unknown>),
      patchCoding: { enabled: true },
    },
  };
  writeConfig(repoDir, enabledConfig);

  const missingWhenEnabled = isPatchCodingEnabled(repoDir);
  assert.deepEqual(missingWhenEnabled, {
    enabled: false,
    reason: 'missing',
    certification: undefined,
  });

  const certificationPath = writePatchCodingCertification(repoDir, {
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: '2026-07-09T12:00:00.000Z',
    providers: [
      { provider: 'openrouter', model: MODELS[0]!.rawId, passed: true },
      { provider: 'openai', model: 'gpt-4o', passed: true },
    ],
  });

  const validWhenEnabled = isPatchCodingEnabled(repoDir);
  assert.equal(validWhenEnabled.enabled, true);

  writeConfig(repoDir, {
    ...baseConfig(),
    nativeAgent: {
      ...((baseConfig().nativeAgent ?? {}) as Record<string, unknown>),
      patchCoding: { enabled: false },
    },
  });
  const validWhenDisabled = isPatchCodingEnabled(repoDir);
  assert.deepEqual(validWhenDisabled, {
    enabled: false,
    reason: 'config_disabled',
  });

  return {
    certificationPath,
    missingWhenEnabled,
    validWhenEnabled,
    validWhenDisabled,
  };
}

function verifyRouteFixture(repoDir: string): {
  planning: { planner: string; rejections: unknown[] };
  review: { reviewer: string; rejections: unknown[] };
  coding: { coder: string; rejections: unknown[] };
  blockedCoding: { coder: string; rejectionReason: string | undefined };
} {
  writePhaseArtifact(repoDir, MODELS[0]!, 'workflow');
  writePhaseArtifact(repoDir, MODELS[1]!, 'patch');
  writePhaseArtifact(repoDir, MODELS[2]!, 'read-only');

  const planning = routeWorkflow('Plan a small workflow change.', {
    repoDir,
    plannerModelsAvailable: [MODELS[0]!.rawId],
    modelsAvailable: [MODELS[0]!.rawId],
    skipDifficultyClassification: true,
  });
  assert.equal(planning.planner, MODELS[0]!.rawId);

  const review = routeWorkflow('Review a small patch safely.', {
    repoDir,
    reviewerModelsAvailable: [MODELS[2]!.rawId],
    modelsAvailable: [MODELS[2]!.rawId],
    skipDifficultyClassification: true,
  });
  assert.equal(review.reviewer, MODELS[2]!.rawId);

  const coding = routeWorkflow('Implement a small patch safely.', {
    repoDir,
    coderModelsAvailable: [MODELS[1]!.rawId],
    modelsAvailable: [MODELS[1]!.rawId],
    skipDifficultyClassification: true,
  });
  assert.equal(coding.coder, MODELS[1]!.rawId);

  const blockedCoding = routeWorkflow('Implement a small patch safely.', {
    repoDir,
    coderModelsAvailable: [MODELS[2]!.rawId],
    modelsAvailable: [MODELS[2]!.rawId],
    skipDifficultyClassification: true,
  });
  assert.equal(blockedCoding.coder, '');

  return {
    planning: {
      planner: planning.planner,
      rejections: planning.nativeCertificationRejections ?? [],
    },
    review: {
      reviewer: review.reviewer,
      rejections: review.nativeCertificationRejections ?? [],
    },
    coding: {
      coder: coding.coder,
      rejections: coding.nativeCertificationRejections ?? [],
    },
    blockedCoding: {
      coder: blockedCoding.coder,
      rejectionReason: (blockedCoding.nativeCertificationRejections ?? [])[0]?.reason,
    },
  };
}

async function main(): Promise<void> {
  const repoDir = makeRepo();
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  try {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const certificationRuns = [];
    for (const model of MODELS) {
      const result = await certifyNativeAgent({
        provider: 'openrouter',
        model: model.rawId,
        phase: 'workflow',
        repoDir,
      });
      assert.equal(result.harnessPassed, true);
      assert.equal(result.liveCertifiable, true);
      assert.ok(result.artifactPath);
      certificationRuns.push({
        modelId: model.rawId,
        phase: result.phase,
        harnessPassed: result.harnessPassed,
        liveCertifiable: result.liveCertifiable,
        artifactPath: result.artifactPath,
      });
    }

    const routerEligibility = verifyRouterEligibility(repoDir);
    const patchCodingGate = verifyPatchCodingGate(repoDir);
    const fixture = verifyRouteFixture(repoDir);
    const expansionDispatch = await verifyExpansionDispatch(repoDir);
    const reviewDispatch = await verifyReviewDispatch(repoDir);

    writeConfig(repoDir, baseConfig());
    const planningReady = capturePlanningEligibility(repoDir, { OPENROUTER_API_KEY: 'test-openrouter-key' });

    writeConfig(repoDir, {
      ...baseConfig(),
      nativeAgent: {
        ...((baseConfig().nativeAgent ?? {}) as Record<string, unknown>),
        enabled: false,
      },
    });
    const planningDisabled = capturePlanningEligibility(repoDir, { OPENROUTER_API_KEY: 'test-openrouter-key' });

    writeConfig(repoDir, {
      ...baseConfig(),
      nativeAgent: {
        ...((baseConfig().nativeAgent ?? {}) as Record<string, unknown>),
        allowedPhases: ['task-expansion', 'review'],
      },
    });
    const planningPhaseRemoved = capturePlanningEligibility(repoDir, { OPENROUTER_API_KEY: 'test-openrouter-key' });

    assert.equal(planningReady.exitCode, 0);
    assert.notEqual(planningDisabled.exitCode, 0);
    assert.notEqual(planningPhaseRemoved.exitCode, 0);

    process.stdout.write(`${JSON.stringify({
      verification: 'HOK-2421',
      tempRepo: repoDir,
      cleanupCommand: `rm -rf ${repoDir}`,
      certificationRuns,
      routerEligibility,
      patchCodingGate: {
        certificationPath: patchCodingGate.certificationPath,
        missingWhenEnabled: patchCodingGate.missingWhenEnabled,
        validWhenEnabled: patchCodingGate.validWhenEnabled,
        validWhenDisabled: patchCodingGate.validWhenDisabled,
        expectedPath: getPatchCodingCertificationPath(repoDir),
      },
      fixture: {
        route: fixture,
        expansionDispatch,
        reviewDispatch,
        planningEligibility: {
          ready: planningReady,
          disabled: planningDisabled,
          phaseRemoved: planningPhaseRemoved,
        },
      },
    }, null, 2)}\n`);
  } finally {
    reviewEngineTestUtils.resetDeps();
    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
