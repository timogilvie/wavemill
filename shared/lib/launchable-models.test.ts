import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CANONICAL_CONFIG_TEMPLATE } from './config-sync.ts';
import { buildLaunchabilityMatrix, LAUNCHABILITY_STAGES, type LaunchabilityStage } from './launchable-models.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import { resolveCertificationSubject } from './native-agent/certification/identity.ts';
import { CERTIFICATION_SCHEMA_VERSION } from './native-agent/certification/schema.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';
import { loadLaunchPriorityList } from './openrouter-catalog.ts';

const WATCHLIST_STAGE_MAP = {
  'qwen-3-235b': ['planner', 'coder', 'reviewer'],
  'kimi-k2-thinking': ['planner', 'coder', 'reviewer'],
  'mistral-medium-3': ['coder'],
  'devstral-medium': ['coder'],
  'grok-code-fast': ['coder'],
} satisfies Record<string, LaunchabilityStage[]>;
const RETIRED_MODELS = new Set([
  'grok-code-fast',
  'devstral-medium',
]);
// Watchlist models whose declared coding-stage context window falls below the
// built-in coding floor (STAGE_CONTEXT_WINDOW_FLOORS.coding = 144_384). These
// are correctly rejected by the new context-window gate; the assertions below
// treat them as `context-window-insufficient` rather than resolving OK.
function contextWindowInsufficientForStage(
  modelId: string,
  stage: LaunchabilityStage,
): boolean {
  if (stage !== 'coder') return false;
  const window = DEFAULT_MODEL_REGISTRY.models[modelId]?.contextWindowTokens;
  return typeof window === 'number' && window < 144_384;
}

const NOW = new Date('2026-07-30T12:00:00.000Z');
const priorOpenRouterKey = process.env.OPENROUTER_API_KEY;
const priorCertificationRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];

before(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  // Certification lookup falls back to a global store under the user's home
  // directory. Without this override the matrix reads whatever certifications
  // the developer happens to have run locally, so the suite passes on a
  // populated machine and fails on a clean CI runner. Point it at an empty
  // directory so launchability depends only on what each test writes.
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = mkdtempSync(
    join(tmpdir(), 'wavemill-cert-root-'),
  );
});

after(() => {
  if (priorOpenRouterKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = priorOpenRouterKey;
  }
  if (priorCertificationRoot === undefined) {
    delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  } else {
    process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = priorCertificationRoot;
  }
});

function writeMinimalConfig(repoDir: string): void {
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      configVersion: CANONICAL_CONFIG_TEMPLATE.configVersion,
      providers: CANONICAL_CONFIG_TEMPLATE.providers,
      router: {
        availableModels: CANONICAL_CONFIG_TEMPLATE.router?.availableModels,
      },
    }),
    'utf-8',
  );
}

function writeCertification(modelId: string, certificationRoot?: string): void {
  const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
  const suiteVersion = capabilities.nativeCapability?.certification?.certificationSuiteVersion;
  const provider = capabilities.nativeCapability?.nativeProvider;
  assert.ok(suiteVersion);
  assert.ok(provider);
  // Write to the global scope, which is what the launchability matrix reads.
  // The repo-scoped legacy path is never consulted here, so writing there left
  // these assertions depending on the developer's real ~/.wavemill store.
  const identity = resolveCertificationSubject({
    provider,
    model: modelId,
    registry: DEFAULT_MODEL_REGISTRY,
  });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
    { root: certificationRoot },
  );
  mkdirSync(dirname(path), { recursive: true });
  const artifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: '2026-07-15T00:00:00.000Z',
    expiresAt: '2026-09-13T00:00:00.000Z',
    scenarios: [{ scenarioId: 'native-openrouter-workflow-launch', passed: true }],
    // HOK-2943: coder launchability additionally requires live canary evidence.
    liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, {
      ranAt: '2026-07-29T00:00:00.000Z',
    }),
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf-8');
}

describe('launch-priority watchlist launchability', () => {
  it('has registry metadata and resolves every allowed watchlist stage without identity rewrite', () => {
    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
      assert.ok(capabilities, `${modelId} should exist in registry`);
      assert.equal(capabilities.supportedModel?.wavemillAlias, modelId);
      assert.equal(capabilities.agent, 'native-openrouter');
      assert.equal(capabilities.nativeCapability?.nativeProvider, 'openrouter');
      assert.equal(capabilities.nativeCapability?.piTransportKind, 'openai-completions');
      assert.equal(capabilities.nativeCapability?.readOnlyNative, 'certified');
      assert.equal(capabilities.nativeCapability?.compatFlags?.thinkingFormat, 'openrouter');

      for (const stage of LAUNCHABILITY_STAGES) {
        const phase = stage === 'planner' ? 'planning' : stage === 'coder' ? 'coding' : 'review';
        const result = resolveModelAgent({ model: modelId, phase, now: NOW });
        if (RETIRED_MODELS.has(modelId)) {
          assert.equal(result.ok, false, `${modelId}:${stage} should reject as retired`);
          if (result.ok) assert.fail('expected retired rejection');
          assert.equal(result.reason, 'lifecycle-blocked');
          continue;
        }
        if (allowedStages.includes(stage) && contextWindowInsufficientForStage(modelId, stage)) {
          assert.equal(result.ok, false, `${modelId}:${stage} should reject on context window`);
          if (result.ok) assert.fail('expected context-window rejection');
          assert.equal(result.reason, 'context-window-insufficient');
        } else if (allowedStages.includes(stage)) {
          assert.deepEqual(result, { ok: true, agent: 'native-openrouter' }, `${modelId}:${stage}`);
        } else {
          assert.equal(result.ok, false, `${modelId}:${stage} should reject`);
          if (result.ok) assert.fail('expected role rejection');
          assert.equal(result.reason, 'role-ineligible');
        }
      }
    }
  });

  it('standard config advertises watchlist models only for eligible stages and omits Sol/Luna', () => {
    const pools = CANONICAL_CONFIG_TEMPLATE.router?.availableModels;
    if (!pools) return;
    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      for (const stage of LAUNCHABILITY_STAGES) {
        assert.equal(
          pools[stage]?.includes(modelId),
          RETIRED_MODELS.has(modelId) ? false : allowedStages.includes(stage),
          `${modelId}:${stage} config eligibility mismatch`,
        );
      }
    }
    assert.equal(pools.planner?.includes('gpt-5.6-sol'), false);
    assert.equal(pools.coder?.includes('gpt-5.6-sol'), false);
    assert.equal(pools.reviewer?.includes('gpt-5.6-sol'), false);
    assert.equal(pools.planner?.includes('gpt-5.6-luna'), false);
    assert.equal(pools.coder?.includes('gpt-5.6-luna'), false);
    assert.equal(pools.reviewer?.includes('gpt-5.6-luna'), false);
    assert.equal(pools.coder?.includes('gpt-5.6-terra'), true);
    assert.equal(pools.coder?.includes('gpt-4.1'), false);
  });


  it('launch-priority catalog advertises watchlist models only for eligible stages and omits Sol/Luna', () => {
    const catalog = loadLaunchPriorityList();
    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      const entry = catalog.find((candidate) => candidate.wavemillAlias === modelId);
      assert.ok(entry, `${modelId} should exist in launch-priority catalog`);
      for (const stage of LAUNCHABILITY_STAGES) {
        const phase = stage === 'planner' ? 'planning' : stage === 'coder' ? 'coding' : 'review';
        assert.equal(
          entry.roleEligibility.includes(phase),
          allowedStages.includes(stage),
          `${modelId}:${stage} config eligibility mismatch`,
        );
      }
    }
    assert.equal(catalog.some((entry) => entry.wavemillAlias === 'gpt-5.6-sol'), false);
    assert.equal(catalog.some((entry) => entry.wavemillAlias === 'gpt-5.6-luna'), false);
    assert.equal(catalog.some((entry) => entry.wavemillAlias === 'gpt-4.1'), false);
  });

  it('builds a deterministic matrix that rejects role-ineligible and missing-certification cells', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-launchability-'));
    const certificationRoot = mkdtempSync(join(tmpdir(), 'wavemill-launchability-certs-'));
    writeMinimalConfig(repoDir);
    for (const modelId of Object.keys(WATCHLIST_STAGE_MAP)) {
      if (!RETIRED_MODELS.has(modelId)) writeCertification(modelId, certificationRoot);
    }

    const catalog = loadLaunchPriorityList()
      .filter((entry) => Object.hasOwn(WATCHLIST_STAGE_MAP, entry.wavemillAlias));
    const matrix = buildLaunchabilityMatrix({ repoDir, catalog, now: NOW, certificationRoot });

    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      for (const stage of LAUNCHABILITY_STAGES) {
        const cell = matrix.cells.find((entry) => entry.modelId === modelId && entry.stage === stage);
        assert.ok(cell, `${modelId}:${stage} should have a matrix cell`);
        if (RETIRED_MODELS.has(modelId)) {
          assert.equal(cell.launchable, false);
          assert.equal(cell.blocker, 'retired');
          assert.match(cell.diagnostic ?? '', /reason=lifecycle-blocked/);
        } else if (!allowedStages.includes(stage)) {
          assert.equal(cell.launchable, false);
          assert.equal(cell.blocker, 'role-ineligible');
        } else if (cell.certificationRejection?.reason === 'identity-reidentified') {
          // Revision-aware subjects must fail closed when the stored artifact
          // was certified for a different registry identity at the same
          // provider wire ID, instead of letting the later artifact silently
          // certify the other identity. Retired aliases such as devstral-medium
          // take the blocked branch above and never reach this case.
          assert.equal(cell.launchable, false);
          assert.equal(cell.blocker, 'certification');
        } else if (contextWindowInsufficientForStage(modelId, stage)) {
          assert.equal(cell.launchable, false, `${modelId}:${stage} should not be launchable (context window)`);
          assert.equal(cell.blocker, 'context-window');
        } else {
          assert.equal(cell.launchable, true, `${modelId}:${stage} should be launchable`);
          assert.equal(cell.agent, 'native-openrouter');
        }
      }
    }
  });

  it('builds a matrix that excludes models with insufficient context window for coding', () => {
    // Models with context windows below the coding floor (144,384) should be blocked
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-launchability-context-window-'));
    writeMinimalConfig(repoDir);
    
    // Add certifications for models we want to test
    writeCertification('kimi-k2');
    writeCertification('mistral-large-2');
    
    const catalog = loadLaunchPriorityList()
      .filter((entry) => ['kimi-k2', 'mistral-large-2'].includes(entry.wavemillAlias));
    const matrix = buildLaunchabilityMatrix({ repoDir, catalog, now: NOW });

    // Check kimi-k2 for coding - should be blocked due to context window
    const kimiCodingCell = matrix.cells.find(cell => cell.modelId === 'kimi-k2' && cell.stage === 'coder');
    assert.ok(kimiCodingCell, 'kimi-k2 coding cell should exist');
    assert.equal(kimiCodingCell.launchable, false, 'kimi-k2 should not be launchable for coding');
    assert.equal(kimiCodingCell.blocker, 'context-window', 'kimi-k2 should be blocked due to context window');
    
    // Check kimi-k2 for planning - should be launchable (no floor)
    const kimiPlanningCell = matrix.cells.find(cell => cell.modelId === 'kimi-k2' && cell.stage === 'planner');
    assert.ok(kimiPlanningCell, 'kimi-k2 planning cell should exist');
    assert.equal(kimiPlanningCell.launchable, true, 'kimi-k2 should be launchable for planning');
    assert.equal(kimiPlanningCell.agent, 'native-openrouter', 'kimi-k2 should resolve to native-openrouter');
    
    // The non-batch mistral-large-2512 endpoint disappeared from the live
    // catalog, so the retained historical alias must fail closed.
    const mistralCodingCell = matrix.cells.find(cell => cell.modelId === 'mistral-large-2' && cell.stage === 'coder');
    assert.ok(mistralCodingCell, 'mistral-large-2 coding cell should exist');
    assert.equal(mistralCodingCell.launchable, false, 'blocked mistral-large-2 should not be launchable for coding');
    assert.equal(mistralCodingCell.blocker, 'retired');
  });

  it('uses explicit certificationRoot instead of the ambient global root', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-launchability-explicit-'));
    const populatedAmbientRoot = mkdtempSync(join(tmpdir(), 'wavemill-launchability-ambient-'));
    const otherAmbientRoot = mkdtempSync(join(tmpdir(), 'wavemill-launchability-other-'));
    const explicitEmptyRoot = mkdtempSync(join(tmpdir(), 'wavemill-launchability-empty-'));
    const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    writeMinimalConfig(repoDir);
    writeCertification('qwen-3-235b', populatedAmbientRoot);

    const catalog = loadLaunchPriorityList()
      .filter((entry) => entry.wavemillAlias === 'qwen-3-235b');

    try {
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = populatedAmbientRoot;
      const matrixWithPopulatedAmbient = buildLaunchabilityMatrix({
        repoDir,
        catalog,
        now: NOW,
        certificationRoot: explicitEmptyRoot,
      });

      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = otherAmbientRoot;
      const matrixWithEmptyAmbient = buildLaunchabilityMatrix({
        repoDir,
        catalog,
        now: NOW,
        certificationRoot: explicitEmptyRoot,
      });

      assert.deepEqual(matrixWithPopulatedAmbient, matrixWithEmptyAmbient);
      const plannerCell = matrixWithPopulatedAmbient.cells.find((cell) =>
        cell.modelId === 'qwen-3-235b' && cell.stage === 'planner');
      assert.ok(plannerCell);
      assert.equal(plannerCell.launchable, false);
      assert.equal(plannerCell.blocker, 'certification');
      assert.match(plannerCell.diagnostic ?? '', /reason=missing-artifact/);
    } finally {
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
    }
  });
});
