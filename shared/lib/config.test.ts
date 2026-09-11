/**
 * Unit tests for config — centralized config loader with caching and validation.
 *
 * Tests:
 * - Schema validation (valid/invalid configs)
 * - Caching behavior
 * - File handling (missing, malformed, empty)
 * - Path resolution
 * - Typed accessors
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import {
  loadWavemillConfig,
  loadWavemillBaseConfig,
  clearConfigCache,
  CURRENT_CONFIG_VERSION,
  INTEGRATION_DEFAULTS,
  PROMOTION_DEFAULTS,
  REVIEW_MERGE_DEFAULTS,
  getChallengeConfig,
  getChallengeSchedulerConfig,
  getRouterConfig,
  getEvalConfig,
  getHarnessRetentionConfig,
  getCleanupConfig,
  getIntegrationConfig,
  getPromotionConfig,
  getReviewMergeConfig,
  getIntegrationReadyPolicy,
  getMillConfig,
  getExpansionHandshakeConfig,
  getMaxCostUsd,
  getUiConfig,
  getPermissionsConfig,
  getDashboardConfig,
  getProjectContextConfig,
  getDeepSeekProviderConfig,
  getDeepSeekLauncherConfig,
  getAgentsConfig,
  getHokusaiRouterConfig,
  getHokusaiSubmissionConfig,
  getHokusaiContributionsConfig,
  getProvidersConfig,
  getNativeAgentConfig,
  getNativeContextManagementConfig,
  getNativeExpansionConfig,
  getNativePatchCodingConfig,
  getReadyConfig,
  getReadyFailureClassifierConfig,
  getReadyVerificationConfig,
  getReadyWatchdogConfig,
  getMigrationChecksConfig,
  getMergeQueueConfig,
  getMintEligibilityConfig,
  getEvalContextUpdatesConfig,
  isRouterCapabilityFilteringEnabled,
  getQuotaConfig,
  getRuntimeResourceSelectionConfig,
  getEffectiveModelExclusions,
  getIncidentConfig,
  getPrePrVerificationConfig,
  getObserverLinearConfig,
  getChallengeEvalHardFailureRetryMaxAttempts,
} from './config.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const hasAjv = (() => {
  try {
    createRequire(import.meta.url)('ajv');
    return true;
  } catch {
    return false;
  }
})();

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        passed++;
        console.log(`  PASS  ${name}`);
      }).catch((err) => {
        failed++;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${(err as Error).message}`);
      });
    } else {
      passed++;
      console.log(`  PASS  ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'config-test-'));
}

function cleanUp(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

function writeConfig(repoDir: string, content: string) {
  writeFileSync(join(repoDir, '.wavemill-config.json'), content, 'utf-8');
}

// ────────────────────────────────────────────────────────────────
// File Handling Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- File Handling Tests ---\n');

test('missing config file returns empty object', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache(); // Clear cache to ensure fresh load
    const config = loadWavemillConfig(tmp);
    assert.deepEqual(config, {});
  } finally {
    cleanUp(tmp);
  }
});

test('empty config file returns empty object', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');
    const config = loadWavemillConfig(tmp);
    assert.deepEqual(config, {});
  } finally {
    cleanUp(tmp);
  }
});

test('malformed JSON throws error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{ invalid json }');
    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /Failed to parse/);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Schema Validation Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Schema Validation Tests ---\n');

test('valid config passes validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: {
        enabled: true,
        minRecords: 20,
        minModels: 2,
      },
      resources: {
        runtimeSelection: {
          enabled: true,
          defaultVariant: 'optimized',
          fallbackToBaseline: true,
          canaryRate: 0.2,
          surfaces: {
            planner: {
              enabled: true,
              variant: 'optimized',
              path: 'dspy/artifacts/optimized-planner.json',
            },
          },
        },
      },
      challenge: {
        enabled: true,
        rate: 0.25,
        allowDeepseek: true,
      },
      challengeScheduler: { enabled: true, confidenceThreshold: 0.65, newModelChallengeCount: 4 },
      providers: {
        deepseek: {
          enabled: true,
          apiKeyEnv: 'DEEPSEEK_API_KEY',
        },
      },
      eval: { evalsDir: '.wavemill/evals' },
      cleanup: { branchDeletion: { enabled: true, mode: 'enforce' } },
      mill: { maxParallel: 5 },
    }));
    const config = loadWavemillConfig(tmp);
    assert.equal(config.router?.enabled, true);
    assert.equal(config.challenge?.enabled, true);
    assert.equal(config.challenge?.rate, 0.25);
    assert.equal(config.challenge?.allowDeepseek, true);
    assert.equal(config.challengeScheduler?.confidenceThreshold, 0.65);
    assert.equal(config.providers?.deepseek?.enabled, true);
    assert.equal(config.eval?.evalsDir, '.wavemill/evals');
    assert.equal(config.cleanup?.branchDeletion?.mode, 'enforce');
    assert.equal(config.mill?.maxParallel, 5);
    assert.equal(config.resources?.runtimeSelection?.defaultVariant, 'optimized');
  } finally {
    cleanUp(tmp);
  }
});

test('cleanup config defaults branch deletion to shadow mode', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');
    const cleanup = getCleanupConfig(tmp);
    assert.equal(cleanup.branchDeletion.enabled, true);
    assert.equal(cleanup.branchDeletion.mode, 'shadow');
    assert.equal(cleanup.episodes.enabled, true);
  } finally {
    cleanUp(tmp);
  }
});

test('removed repo-local model fields are rejected with migration guidance', () => {
  const cases: Array<{ path: string; config: Record<string, unknown> }> = [
    { path: 'modelRegistry', config: { modelRegistry: { models: { local: {} } } } },
    { path: 'router.defaultModel', config: { router: { defaultModel: 'local-model' } } },
    { path: 'router.models', config: { router: { models: ['local-model'] } } },
    { path: 'router.availableModels', config: { router: { availableModels: { coder: ['local-model'] } } } },
    { path: 'router.agentMap', config: { router: { agentMap: { 'local-model': 'codex' } } } },
    { path: 'challenge.models', config: { challenge: { models: ['local-model'] } } },
    { path: 'challenge.comparisonModel', config: { challenge: { comparisonModel: 'local-model' } } },
    { path: 'providers.openrouter.models', config: { providers: { openrouter: { models: ['local-model'] } } } },
    { path: 'providers.openrouter.stages', config: { providers: { openrouter: { stages: ['coder'] } } } },
    { path: 'providers.deepseek.models', config: { providers: { deepseek: { models: ['deepseek-local'] } } } },
    { path: 'providers.deepseek.stages', config: { providers: { deepseek: { stages: ['coder'] } } } },
    { path: 'nativeAgent.providers.openai.models', config: { nativeAgent: { providers: { openai: { models: ['local-model'] } } } } },
    { path: 'nativeAgent.providers.openrouter.models', config: { nativeAgent: { providers: { openrouter: { models: ['local-model'] } } } } },
  ];

  for (const testCase of cases) {
    const tmp = makeTempRepo();
    try {
      clearConfigCache();
      writeConfig(tmp, JSON.stringify(testCase.config));
      assert.throws(
        () => loadWavemillConfig(tmp),
        (err: unknown) => {
          const message = String((err as Error).message);
          return message.includes(testCase.path) && message.includes('wavemill config migrate-model-settings');
        },
      );
    } finally {
      cleanUp(tmp);
    }
  }
});

test('uses the schema checked out with the target worktree', () => {
  const tmp = makeTempRepo();
  try {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'wavemill-config.schema.json'), 'utf-8')
    );
    schema.properties.prePrVerification = {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      additionalProperties: false,
    };
    writeFileSync(
      join(tmp, 'wavemill-config.schema.json'),
      JSON.stringify(schema)
    );
    clearConfigCache();
    writeFileSync(
      join(tmp, '.wavemill-config.json'),
      JSON.stringify({ prePrVerification: { enabled: true } })
    );

    assert.equal(loadWavemillConfig(tmp).prePrVerification?.enabled, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The compiled validator is cached across clearConfigCache() calls, so it must
// notice when the schema file at a given path is replaced -- otherwise a
// worktree that changed on disk would be validated against a stale validator.
test('recompiles the validator when the schema at the same path changes', () => {
  const tmp = makeTempRepo();
  try {
    const baseSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'wavemill-config.schema.json'), 'utf-8')
    );
    const schemaPath = join(tmp, 'wavemill-config.schema.json');

    // First schema rejects the property outright.
    const strict = JSON.parse(JSON.stringify(baseSchema));
    strict.additionalProperties = false;
    writeFileSync(schemaPath, JSON.stringify(strict));
    writeFileSync(
      join(tmp, '.wavemill-config.json'),
      JSON.stringify({ totallyUnknownKey: true })
    );
    clearConfigCache();
    assert.throws(
      () => loadWavemillConfig(tmp),
      /validation failed/i,
      'strict schema should reject the unknown key'
    );

    // Replace the schema at the SAME path with one that permits it.
    const permissive = JSON.parse(JSON.stringify(baseSchema));
    permissive.additionalProperties = true;
    writeFileSync(schemaPath, JSON.stringify(permissive));
    clearConfigCache();

    // A stale cached validator would still reject here.
    assert.doesNotThrow(
      () => loadWavemillConfig(tmp),
      'validator should recompile after the schema file changes'
    );
  } finally {
    cleanUp(tmp);
  }
});

test('eval prompt size config loads through getEvalConfig', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        evalsDir: '.wavemill/evals',
        maxPromptBytes: 1234567,
        oversizePolicy: 'truncate',
      },
    }));

    const evalConfig = getEvalConfig(tmp);
    assert.equal(evalConfig.maxPromptBytes, 1234567);
    assert.equal(evalConfig.oversizePolicy, 'truncate');
  } finally {
    cleanUp(tmp);
  }
});

test('invalid eval oversizePolicy is rejected by schema validation', () => {
  if (!hasAjv) {
    console.log('        SKIP  Ajv not installed');
    return;
  }

  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: { oversizePolicy: 'compress' },
    }));
    assert.throws(() => loadWavemillConfig(tmp), /Config validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('too-small eval maxPromptBytes is rejected by schema validation', () => {
  if (!hasAjv) {
    console.log('        SKIP  Ajv not installed');
    return;
  }

  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: { maxPromptBytes: 512 },
    }));
    assert.throws(() => loadWavemillConfig(tmp), /Config validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('eval postMergeTimeoutSeconds is accepted by schema validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: { postMergeTimeoutSeconds: 600 },
    }));

    assert.equal(getEvalConfig(tmp).postMergeTimeoutSeconds, 600);
  } finally {
    cleanUp(tmp);
  }
});

test('too-small eval postMergeTimeoutSeconds is rejected by schema validation', () => {
  if (!hasAjv) {
    console.log('        SKIP  Ajv not installed');
    return;
  }

  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: { postMergeTimeoutSeconds: 29 },
    }));
    assert.throws(() => loadWavemillConfig(tmp), /Config validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('evalContextUpdates accessor returns defaults when absent', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getEvalContextUpdatesConfig(tmp), {
      enabled: true,
      timeoutSeconds: 60,
      maxRetries: 0,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('ready watchdog defaults are returned when config is absent', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    assert.deepEqual(getReadyWatchdogConfig(tmp), {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 4,
      safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    });
    assert.deepEqual(getMigrationChecksConfig(tmp), {
      enabled: true,
      autoDetectAlembic: true,
      baseRefresh: {
        enabled: true,
        timeoutSeconds: 30,
      },
    });
  } finally {
    cleanUp(tmp);
  }
});

test('evalContextUpdates accessor returns explicit config values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      evalContextUpdates: {
        enabled: false,
        timeoutSeconds: 90,
        maxRetries: 2,
      },
    }));

    assert.deepEqual(getEvalContextUpdatesConfig(tmp), {
      enabled: false,
      timeoutSeconds: 90,
      maxRetries: 2,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('harness retention accessor defaults to shadow tolerance one', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getHarnessRetentionConfig(tmp), {
      enabled: false,
      mode: 'shadow',
      tolerance: 1,
      suitePath: 'shared/fixtures/harness-replay/harness-retention-v1/manifest.json',
      reportDir: '.wavemill/harness-replay/reports',
      baselineHarnessId: '',
      candidateHarnessId: '',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('harness retention accessor returns explicit config values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      harness: {
        retention: {
          enabled: true,
          mode: 'enforce',
          tolerance: 2,
          suitePath: 'fixtures/replay.json',
          reportDir: '.wavemill/custom-reports',
          baselineHarnessId: 'baseline',
          candidateHarnessId: 'candidate',
        },
      },
    }));

    assert.deepEqual(getHarnessRetentionConfig(tmp), {
      enabled: true,
      mode: 'enforce',
      tolerance: 2,
      suitePath: 'fixtures/replay.json',
      reportDir: '.wavemill/custom-reports',
      baselineHarnessId: 'baseline',
      candidateHarnessId: 'candidate',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('ready watchdog supports canonical and legacy alias config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      monitor: {
        readyWatchdog: {
          thresholdMinutes: 20,
          autoRecover: false,
        },
      },
      ready: {
        watchdog: {
          enabled: false,
          timeoutSeconds: 45,
          stableFailureConsecutivePolls: 3,
        },
        migrationChecks: {
          enabled: false,
          autoDetectAlembic: false,
          baseRefresh: {
            enabled: false,
            timeoutSeconds: 12,
          },
        },
      },
    }));

    assert.deepEqual(getReadyWatchdogConfig(tmp), {
      enabled: false,
      thresholdMinutes: 20,
      autoRecover: false,
      timeoutSeconds: 45,
      stableFailureConsecutivePolls: 3,
      stableFailureEscalateAfterPolls: 4,
      safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    });
    assert.deepEqual(getMigrationChecksConfig(tmp), {
      enabled: false,
      autoDetectAlembic: false,
      baseRefresh: {
        enabled: false,
        timeoutSeconds: 12,
      },
    });
  } finally {
    cleanUp(tmp);
  }
});

test('invalid evalContextUpdates values fail validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      evalContextUpdates: {
        enabled: 'yes',
        timeoutSeconds: 4,
        maxRetries: 4,
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('ready watchdog schema rejects thresholdMinutes below 1', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        watchdog: {
          thresholdMinutes: 0,
        },
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/i);
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid runtime resource variant fails validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      resources: {
        runtimeSelection: {
          surfaces: {
            planner: {
              variant: 'beta',
            },
          },
        },
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});


test('invalid type in config throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    // mill.maxParallel should be integer, not string
    writeConfig(tmp, JSON.stringify({
      mill: { maxParallel: 'five' }
    }));
    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('missing providers block loads with empty provider accessors', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ router: { enabled: true } }));
    assert.deepEqual(getProvidersConfig(tmp), {});
    assert.deepEqual(getDeepSeekProviderConfig(tmp), {});
  } finally {
    cleanUp(tmp);
  }
});

test('enabled deepseek provider without apiKeyEnv fails validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      providers: {
        deepseek: {
          enabled: true,
        },
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('deepseek provider accessor returns typed config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      providers: {
        deepseek: {
          enabled: true,
          apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY',
          baseUrl: 'https://api.deepseek.com/anthropic',
          effortLevel: 'high',
        },
      },
    }));

    assert.deepEqual(getDeepSeekProviderConfig(tmp), {
      enabled: true,
      apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/anthropic',
      effortLevel: 'high',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getDeepSeekLauncherConfig returns empty object when not configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ router: { enabled: true } }));
    assert.deepEqual(getDeepSeekLauncherConfig(tmp), {});
  } finally {
    cleanUp(tmp);
  }
});

test('getDeepSeekLauncherConfig returns launcher sub-config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      providers: {
        deepseek: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          launcher: {
            model: 'deepseek-v4-pro',
            subagentModel: 'deepseek-v4-flash',
            stateDir: '.wavemill/deepseek-state/custom',
          },
        },
      },
    }));

    assert.deepEqual(getDeepSeekLauncherConfig(tmp), {
      model: 'deepseek-v4-pro',
      subagentModel: 'deepseek-v4-flash',
      stateDir: '.wavemill/deepseek-state/custom',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('launcher config with secretSource is returned', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      providers: {
        deepseek: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          launcher: {
            secretSource: 'MY_CUSTOM_KEY_ENV',
          },
        },
      },
    }));

    const launcherConfig = getDeepSeekLauncherConfig(tmp);
    assert.equal(launcherConfig.secretSource, 'MY_CUSTOM_KEY_ENV');
  } finally {
    cleanUp(tmp);
  }
});

test('deepseek provider accessor still returns typed config with launcher present', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      providers: {
        deepseek: {
          enabled: true,
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          launcher: { model: 'deepseek-v4-flash' },
        },
      },
    }));

    const provider = getDeepSeekProviderConfig(tmp);
    assert.equal(provider.enabled, true);
    assert.equal(provider.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.deepEqual(provider.launcher, { model: 'deepseek-v4-flash' });
  } finally {
    cleanUp(tmp);
  }
});

test('invalid challenge rate throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { enabled: true, rate: 2 }
    }));
    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid challenge scheduler threshold throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challengeScheduler: { confidenceThreshold: 2 }
    }));
    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('challenge.allowDeepseek accepts boolean true', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: {
        allowDeepseek: true,
      },
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.challenge?.allowDeepseek, true);
  } finally {
    cleanUp(tmp);
  }
});

test('challenge.allowDeepseek rejects non-boolean values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: {
        allowDeepseek: 'yes',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('challenge hard-failure retry max defaults to 2', () => {
  const tmp = makeTempRepo();
  const previous = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
  try {
    delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.equal(getChallengeEvalHardFailureRetryMaxAttempts(tmp), 2);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    } else {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previous;
    }
    cleanUp(tmp);
  }
});

test('challenge hard-failure retry max uses explicit config', () => {
  const tmp = makeTempRepo();
  const previous = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
  try {
    delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { eval: { hardFailureRetryMaxAttempts: 5 } },
    }));

    assert.equal(getChallengeEvalHardFailureRetryMaxAttempts(tmp), 5);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    } else {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previous;
    }
    cleanUp(tmp);
  }
});

test('challenge hard-failure env override wins over config', () => {
  const tmp = makeTempRepo();
  const previous = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
  try {
    process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = '3';
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { eval: { hardFailureRetryMaxAttempts: 5 } },
    }));

    assert.equal(getChallengeEvalHardFailureRetryMaxAttempts(tmp), 3);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    } else {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previous;
    }
    cleanUp(tmp);
  }
});

test('challenge soft retry max does not affect hard-failure retry max', () => {
  const tmp = makeTempRepo();
  const previous = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
  try {
    delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { eval: { retryMaxAttempts: 7 } },
    }));

    assert.equal(getChallengeEvalHardFailureRetryMaxAttempts(tmp), 2);
    assert.equal(loadWavemillConfig(tmp).challenge?.eval?.retryMaxAttempts, 7);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    } else {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previous;
    }
    cleanUp(tmp);
  }
});

test('invalid challenge hard-failure config fails schema validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { eval: { hardFailureRetryMaxAttempts: -1 } },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('hard-failure accessor ignores invalid config when validation is disabled', () => {
  const tmp = makeTempRepo();
  const previousValidation = process.env.WAVEMILL_DISABLE_AJV_VALIDATION;
  const previousRetry = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
  try {
    process.env.WAVEMILL_DISABLE_AJV_VALIDATION = '1';
    delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { eval: { retryMaxAttempts: 9, hardFailureRetryMaxAttempts: -1 } },
    }));

    assert.equal(getChallengeEvalHardFailureRetryMaxAttempts(tmp), 2);
  } finally {
    if (previousValidation === undefined) {
      delete process.env.WAVEMILL_DISABLE_AJV_VALIDATION;
    } else {
      process.env.WAVEMILL_DISABLE_AJV_VALIDATION = previousValidation;
    }
    if (previousRetry === undefined) {
      delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    } else {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previousRetry;
    }
    clearConfigCache();
    cleanUp(tmp);
  }
});

test('invalid hard-failure env falls through to hard-failure config only', () => {
  const tmp = makeTempRepo();
  const previous = process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
  try {
    process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = 'bad';
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: { eval: { retryMaxAttempts: 9, hardFailureRetryMaxAttempts: 4 } },
    }));

    assert.equal(getChallengeEvalHardFailureRetryMaxAttempts(tmp), 4);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES;
    } else {
      process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES = previous;
    }
    cleanUp(tmp);
  }
});

test('invalid quota override status throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      quota: {
        manualOverrides: {
          sonnet: {
            status: 'warning',
          },
        },
      },
    }));
    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('loads config without schema validation when Ajv validation is disabled', () => {
  const tmp = makeTempRepo();
  const previous = process.env.WAVEMILL_DISABLE_AJV_VALIDATION;
  try {
    clearConfigCache();
    process.env.WAVEMILL_DISABLE_AJV_VALIDATION = '1';
    writeConfig(tmp, JSON.stringify({
      mill: { maxParallel: 'five' }
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.mill?.maxParallel, 'five');
  } finally {
    clearConfigCache();
    if (previous === undefined) {
      delete process.env.WAVEMILL_DISABLE_AJV_VALIDATION;
    } else {
      process.env.WAVEMILL_DISABLE_AJV_VALIDATION = previous;
    }
    cleanUp(tmp);
  }
});

test('unknown fields are allowed (schema additionalProperties: false)', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: { enabled: true },
      unknownField: 'should be rejected'
    }));
    if (hasAjv) {
      // Schema has additionalProperties: false, so this should throw
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('getQuotaConfig returns configured overrides and thresholds', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      quota: {
        manualOverrides: {
          'claude-sonnet-4-6': {
            status: 'degrading',
            reason: 'known provider load',
            expiresAt: '2026-04-20T00:00:00.000Z',
          },
        },
        thresholds: {
          volumeThresholdPercent: 75,
          budgetThresholdPercent: 30,
          nearLimitCount: 4,
        },
      },
    }));

    const quota = getQuotaConfig(tmp);
    assert.equal(quota.manualOverrides?.['claude-sonnet-4-6']?.status, 'degrading');
    assert.equal(quota.thresholds?.volumeThresholdPercent, 75);
    assert.equal(quota.thresholds?.budgetThresholdPercent, 30);
    assert.equal(quota.thresholds?.nearLimitCount, 4);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Caching Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Caching Tests ---\n');

test('second load returns cached config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ router: { enabled: true } }));

    const config1 = loadWavemillConfig(tmp);
    const config2 = loadWavemillConfig(tmp);

    // Should be the exact same object (cached)
    assert.equal(config1, config2);
  } finally {
    cleanUp(tmp);
  }
});

test('challenge scheduler accessor returns configured values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challengeScheduler: {
        enabled: true,
        confidenceThreshold: 0.55,
        newModelChallengeCount: 3,
        minEvalRecordsPerStage: 8,
        maxConcurrentChallenges: 2,
      },
    }));

    const config = getChallengeSchedulerConfig(tmp);
    assert.equal(config.enabled, true);
    assert.equal(config.confidenceThreshold, 0.55);
    assert.equal(config.newModelChallengeCount, 3);
    assert.equal(config.minEvalRecordsPerStage, 8);
    assert.equal(config.maxConcurrentChallenges, 2);
  } finally {
    cleanUp(tmp);
  }
});

test('different repoDirs load separate configs', () => {
  const tmp1 = makeTempRepo();
  const tmp2 = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp1, JSON.stringify({ router: { enabled: true } }));
    writeConfig(tmp2, JSON.stringify({ router: { enabled: false } }));

    const config1 = loadWavemillConfig(tmp1);
    const config2 = loadWavemillConfig(tmp2);

    assert.equal(config1.router?.enabled, true);
    assert.equal(config2.router?.enabled, false);
  } finally {
    cleanUp(tmp1);
    cleanUp(tmp2);
  }
});

test('clearConfigCache forces reload', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ router: { enabled: true } }));

    const config1 = loadWavemillConfig(tmp);
    assert.equal(config1.router?.enabled, true);

    // Change config on disk
    writeConfig(tmp, JSON.stringify({ router: { enabled: false } }));

    // Without clearing cache, should get old value
    const config2 = loadWavemillConfig(tmp);
    assert.equal(config2.router?.enabled, true);

    // After clearing cache, should get new value
    clearConfigCache(tmp);
    const config3 = loadWavemillConfig(tmp);
    assert.equal(config3.router?.enabled, false);
  } finally {
    cleanUp(tmp);
  }
});

test('clearConfigCache forces reload for base-only config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ router: { enabled: true } }));

    const config1 = loadWavemillBaseConfig(tmp);
    assert.equal(config1.router?.enabled, true);

    writeConfig(tmp, JSON.stringify({ router: { enabled: false } }));

    const config2 = loadWavemillBaseConfig(tmp);
    assert.equal(config2.router?.enabled, true);

    clearConfigCache(tmp);
    const config3 = loadWavemillBaseConfig(tmp);
    assert.equal(config3.router?.enabled, false);
  } finally {
    cleanUp(tmp);
  }
});

test('clearConfigCache() without args clears all caches', () => {
  const tmp1 = makeTempRepo();
  const tmp2 = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp1, JSON.stringify({ router: { enabled: true } }));
    writeConfig(tmp2, JSON.stringify({ mill: { maxParallel: 5 } }));

    // Load both
    loadWavemillConfig(tmp1);
    loadWavemillConfig(tmp2);

    // Clear all
    clearConfigCache();

    // Modify both
    writeConfig(tmp1, JSON.stringify({ router: { enabled: false } }));
    writeConfig(tmp2, JSON.stringify({ mill: { maxParallel: 10 } }));

    // Should get new values
    const config1 = loadWavemillConfig(tmp1);
    const config2 = loadWavemillConfig(tmp2);
    assert.equal(config1.router?.enabled, false);
    assert.equal(config2.mill?.maxParallel, 10);
  } finally {
    cleanUp(tmp1);
    cleanUp(tmp2);
  }
});

test('clearConfigCache() without args clears base-only caches for all repos', () => {
  const tmp1 = makeTempRepo();
  const tmp2 = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp1, JSON.stringify({ router: { enabled: true } }));
    writeConfig(tmp2, JSON.stringify({ mill: { maxParallel: 5 } }));

    loadWavemillBaseConfig(tmp1);
    loadWavemillBaseConfig(tmp2);

    clearConfigCache();

    writeConfig(tmp1, JSON.stringify({ router: { enabled: false } }));
    writeConfig(tmp2, JSON.stringify({ mill: { maxParallel: 10 } }));

    const config1 = loadWavemillBaseConfig(tmp1);
    const config2 = loadWavemillBaseConfig(tmp2);
    assert.equal(config1.router?.enabled, false);
    assert.equal(config2.mill?.maxParallel, 10);
  } finally {
    cleanUp(tmp1);
    cleanUp(tmp2);
  }
});

// ────────────────────────────────────────────────────────────────
// Path Resolution Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Path Resolution Tests ---\n');

test('relative and absolute paths to same dir share cache', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ router: { enabled: true } }));

    // Load with absolute path
    const config1 = loadWavemillConfig(tmp);

    // Load with same path (both resolve to same absolute path)
    const config2 = loadWavemillConfig(tmp);

    // Should be cached (same object)
    assert.equal(config1, config2);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Typed Accessor Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Typed Accessor Tests ---\n');

test('getRouterConfig returns router section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: { enabled: true, minRecords: 10 },
      eval: { evalsDir: '.wavemill/evals' },
    }));

    const routerConfig = getRouterConfig(tmp);
    assert.equal(routerConfig.enabled, true);
    assert.equal(routerConfig.minRecords, 10);
  } finally {
    cleanUp(tmp);
  }
});

test('getRouterConfig accepts router.capabilityFiltering.enabled', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: {
        capabilityFiltering: {
          enabled: true,
        },
      },
    }));

    const routerConfig = getRouterConfig(tmp);
    assert.equal(routerConfig.capabilityFiltering?.enabled, true);
    assert.equal(isRouterCapabilityFilteringEnabled(tmp), true);
  } finally {
    cleanUp(tmp);
  }
});

test('router capability filtering defaults to disabled when omitted', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: {
        enabled: true,
      },
    }));

    assert.equal(isRouterCapabilityFilteringEnabled(tmp), false);
  } finally {
    cleanUp(tmp);
  }
});

test('router capability filtering rejects unexpected nested properties', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: {
        capabilityFiltering: {
          enabled: true,
          mode: 'strict',
        },
      },
    }));

    assert.throws(
      () => loadWavemillConfig(tmp),
      /capabilityFiltering/,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('getChallengeConfig returns challenge section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      challenge: {
        enabled: true,
        rate: 0.5,
        allowDeepseek: true,
        autoMergeWinner: true,
      },
    }));

    const challengeConfig = getChallengeConfig(tmp);
    assert.equal(challengeConfig.enabled, true);
    assert.equal(challengeConfig.rate, 0.5);
    assert.equal(challengeConfig.allowDeepseek, true);
    assert.equal(challengeConfig.autoMergeWinner, true);
  } finally {
    cleanUp(tmp);
  }
});

test('challenge autoMergeWinner schema default matches runtime default', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    const schema = JSON.parse(readFileSync(join(process.cwd(), 'wavemill-config.schema.json'), 'utf-8'));
    const schemaDefault = schema.properties.challenge.properties.autoMergeWinner.default;
    const runtimeDefault = getChallengeConfig(tmp).autoMergeWinner ?? false;

    assert.equal(schemaDefault, false);
    assert.equal(runtimeDefault, schemaDefault);
  } finally {
    cleanUp(tmp);
  }
});

test('getEvalConfig returns eval section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        evalsDir: '.wavemill/evals',
        judge: { model: 'claude-haiku-4-5-20251001' }
      }
    }));

    const evalConfig = getEvalConfig(tmp);
    assert.equal(evalConfig.evalsDir, '.wavemill/evals');
    assert.equal(evalConfig.judge?.model, 'claude-haiku-4-5-20251001');
  } finally {
    cleanUp(tmp);
  }
});

test('getMintEligibilityConfig returns eval mintEligibility section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        mintEligibility: {
          coverageThreshold: 0.9,
          maxInvalidRouteRate: 0.05,
        },
      },
    }));

    const mintConfig = getMintEligibilityConfig(tmp);
    assert.equal(mintConfig?.coverageThreshold, 0.9);
    assert.equal(mintConfig?.maxInvalidRouteRate, 0.05);
  } finally {
    cleanUp(tmp);
  }
});

test('getMillConfig returns mill section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      git: {
        fetchTtlSeconds: 30,
      },
      mill: { maxParallel: 5, baseBranch: 'develop', defaultMaxCostUsd: 12.5 }
    }));

    const millConfig = getMillConfig(tmp);
    const config = loadWavemillConfig(tmp);
    assert.equal(millConfig.maxParallel, 5);
    assert.equal(millConfig.baseBranch, 'develop');
    assert.equal(millConfig.defaultMaxCostUsd, 12.5);
    assert.equal(config.git?.fetchTtlSeconds, 30);
  } finally {
    cleanUp(tmp);
  }
});

test('getExpansionHandshakeConfig defaults to recover when section absent', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ mill: { maxParallel: 5 } }));
    assert.deepEqual(getExpansionHandshakeConfig(tmp), {
      policy: 'recover',
      timeoutSeconds: 300,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getExpansionHandshakeConfig defaults to recover when mill absent', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));
    assert.deepEqual(getExpansionHandshakeConfig(tmp), {
      policy: 'recover',
      timeoutSeconds: 300,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getExpansionHandshakeConfig returns recover when configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: {
        expansionHandshake: {
          policy: 'recover',
        },
      },
    }));
    assert.deepEqual(getExpansionHandshakeConfig(tmp), {
      policy: 'recover',
      timeoutSeconds: 300,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getExpansionHandshakeConfig returns warn when configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: {
        expansionHandshake: {
          policy: 'warn',
        },
      },
    }));
    assert.deepEqual(getExpansionHandshakeConfig(tmp), {
      policy: 'warn',
      timeoutSeconds: 300,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getExpansionHandshakeConfig returns configured recovery timeout', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: {
        expansionHandshake: {
          policy: 'recover',
          timeoutSeconds: 180,
        },
      },
    }));
    assert.deepEqual(getExpansionHandshakeConfig(tmp), {
      policy: 'recover',
      timeoutSeconds: 180,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('invalid expansionHandshake policy fails validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: {
        expansionHandshake: {
          policy: 'silent',
        },
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid expansionHandshake timeout fails validation', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: {
        expansionHandshake: {
          timeoutSeconds: 0,
        },
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('getMaxCostUsd returns configured budget', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: { defaultMaxCostUsd: 4.25 }
    }));

    assert.equal(getMaxCostUsd(tmp), 4.25);
  } finally {
    cleanUp(tmp);
  }
});

test('getMaxCostUsd returns undefined when unset', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: { maxParallel: 5 }
    }));

    assert.equal(getMaxCostUsd(tmp), undefined);
  } finally {
    cleanUp(tmp);
  }
});

test('shell defaults define a 25 USD mill budget', () => {
  const commonLib = join(process.cwd(), 'shared', 'lib', 'wavemill-common.sh');
  const content = readFileSync(commonLib, 'utf-8');
  assert.match(content, /"defaultMaxCostUsd": 25(?:\.00)?/);
});

test('shell defaults define a 60 second git fetch TTL', () => {
  const commonLib = join(process.cwd(), 'shared', 'lib', 'wavemill-common.sh');
  const content = readFileSync(commonLib, 'utf-8');
  assert.match(content, /"fetchTtlSeconds": 60/);
});

test('getDashboardConfig returns dashboard section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      dashboard: {
        verbosity: 'debug',
        logToFile: false,
      },
    }));

    const dashboardConfig = getDashboardConfig(tmp);
    assert.equal(dashboardConfig.verbosity, 'debug');
    assert.equal(dashboardConfig.logToFile, false);
  } finally {
    cleanUp(tmp);
  }
});

test('getProjectContextConfig returns defaults when section missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ mill: { maxParallel: 5 } }));

    assert.deepEqual(getProjectContextConfig(tmp), {
      compactionThresholdKb: 100,
      recentWorkKeep: 25,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getProjectContextConfig returns explicit overrides', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      projectContext: {
        compactionThresholdKb: 180,
        recentWorkKeep: 40,
      },
    }));

    assert.deepEqual(getProjectContextConfig(tmp), {
      compactionThresholdKb: 180,
      recentWorkKeep: 40,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getHokusaiSubmissionConfig returns hokusai section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      hokusai: {
        dataSubmission: {
          enabled: false,
          consentVersion: '2.0',
          endpoint: 'https://example.com/hokusai',
        },
      },
    }));

    const hokusaiConfig = getHokusaiSubmissionConfig(tmp);
    assert.equal(hokusaiConfig.enabled, false);
    assert.equal(hokusaiConfig.consentVersion, '2.0');
    assert.equal(hokusaiConfig.endpoint, 'https://example.com/hokusai');
  } finally {
    cleanUp(tmp);
  }
});

test('getHokusaiRouterConfig returns router.hokusai section including apiKeyEnv', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: {
        hokusai: {
          endpoint: 'https://api.hokus.ai/api/v1/models/30/predict',
          apiKeyEnv: 'CUSTOM_HOKUSAI_TOKEN',
          timeout: 9000,
        },
      },
    }));

    const hokusaiConfig = getHokusaiRouterConfig(tmp);
    assert.equal(hokusaiConfig.endpoint, 'https://api.hokus.ai/api/v1/models/30/predict');
    assert.equal(hokusaiConfig.apiKeyEnv, 'CUSTOM_HOKUSAI_TOKEN');
    assert.equal(hokusaiConfig.timeout, 9000);
  } finally {
    cleanUp(tmp);
  }
});

test('getHokusaiContributionsConfig returns normalized defaults when unset', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getHokusaiContributionsConfig(tmp), {
      enabled: false,
      endpoint: null,
      endpointTokenEnv: '',
      batchSize: 50,
      exportPath: null,
      maxRetries: 5,
      backoffInitialMs: 1000,
      backoffMaxMs: 300000,
      timeoutMs: 30000,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getHokusaiContributionsConfig returns configured values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      hokusai: {
        contributions: {
          enabled: true,
          endpoint: 'https://example.com/contributions',
          endpointTokenEnv: 'HOKUSAI_TOKEN',
          batchSize: 25,
          exportPath: '.wavemill/hokusai-export',
          maxRetries: 7,
          backoffInitialMs: 2000,
          backoffMaxMs: 600000,
          timeoutMs: 45000,
        },
      },
    }));

    assert.deepEqual(getHokusaiContributionsConfig(tmp), {
      enabled: true,
      endpoint: 'https://example.com/contributions',
      endpointTokenEnv: 'HOKUSAI_TOKEN',
      batchSize: 25,
      exportPath: '.wavemill/hokusai-export',
      maxRetries: 7,
      backoffInitialMs: 2000,
      backoffMaxMs: 600000,
      timeoutMs: 45000,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getUiConfig returns ui section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ui: { visualVerification: false, devServer: 'http://localhost:3000' }
    }));

    const uiConfig = getUiConfig(tmp);
    assert.equal(uiConfig.visualVerification, false);
    assert.equal(uiConfig.devServer, 'http://localhost:3000');
  } finally {
    cleanUp(tmp);
  }
});

test('accessor returns empty object when section missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ mill: { maxParallel: 5 } }));

    const routerConfig = getRouterConfig(tmp);
    assert.deepEqual(routerConfig, {});
  } finally {
    cleanUp(tmp);
  }
});

test('runtime resource selection accessor returns stable defaults', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ mill: { maxParallel: 5 } }));

    assert.deepEqual(getRuntimeResourceSelectionConfig(tmp), {
      enabled: false,
      defaultVariant: 'baseline',
      fallbackToBaseline: true,
      canaryRate: 0,
      surfaces: {},
    });
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Complex Config Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Complex Config Tests ---\n');

test('nested config values are accessible', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        judge: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        interventionPenalties: {
          reviewComment: 0.1,
          postPrCommit: 0.15,
          manualEdit: 0.2
        },
        pricing: {
          'claude-opus-4-6': {
            inputCostPerMTok: 15,
            outputCostPerMTok: 75
          }
        }
      }
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.eval?.judge?.model, 'claude-sonnet-4-5-20250929');
    assert.equal(config.eval?.interventionPenalties?.reviewComment, 0.1);
    assert.equal(config.eval?.pricing?.['claude-opus-4-6']?.inputCostPerMTok, 15);
  } finally {
    cleanUp(tmp);
  }
});

test('all top-level sections can coexist', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      linear: { project: 'My Project' },
      mill: { maxParallel: 3 },
      expand: { maxSelect: 2 },
      plan: { maxDisplay: 5 },
      eval: { evalsDir: '.wavemill/evals' },
      autoEval: true,
      hokusai: {
        dataSubmission: { enabled: false, consentVersion: '1.0' },
        contributions: { enabled: true, endpoint: null, batchSize: 10 },
      },
      router: { enabled: true },
      validation: { enabled: true },
      constraints: { enabled: false },
      ui: { visualVerification: true },
      review: { maxIterations: 3 },
      permissions: { autoApprovePatterns: ['git status*'], worktreeMode: { enabled: true } }
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.linear?.project, 'My Project');
    assert.equal(config.mill?.maxParallel, 3);
    assert.equal(config.expand?.maxSelect, 2);
    assert.equal(config.plan?.maxDisplay, 5);
    assert.equal(config.eval?.evalsDir, '.wavemill/evals');
    assert.equal(config.autoEval, true);
    assert.equal(config.hokusai?.dataSubmission?.enabled, false);
    assert.equal(config.hokusai?.contributions?.enabled, true);
    assert.equal(config.router?.enabled, true);
    assert.equal(config.validation?.enabled, true);
    assert.equal(config.constraints?.enabled, false);
    assert.equal(config.ui?.visualVerification, true);
    assert.equal(config.review?.maxIterations, 3);
    assert.equal(config.permissions?.autoApprovePatterns?.[0], 'git status*');
    assert.equal(config.permissions?.worktreeMode?.enabled, true);
  } finally {
    cleanUp(tmp);
  }
});

test('getPermissionsConfig returns permissions section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      permissions: {
        autoApprovePatterns: ['git status*', 'gh pr view*', 'ls *'],
        worktreeMode: { enabled: true, autoApproveReadOnly: true }
      }
    }));

    const permissionsConfig = getPermissionsConfig(tmp);
    assert.equal(permissionsConfig.autoApprovePatterns?.length, 3);
    assert.equal(permissionsConfig.autoApprovePatterns?.[0], 'git status*');
    assert.equal(permissionsConfig.autoApprovePatterns?.[1], 'gh pr view*');
    assert.equal(permissionsConfig.worktreeMode?.enabled, true);
    assert.equal(permissionsConfig.worktreeMode?.autoApproveReadOnly, true);
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig returns empty check lists by default', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');

    const readyConfig = getReadyConfig(tmp);
    assert.deepEqual(readyConfig.checks, []);
    assert.deepEqual(readyConfig.requiredChecks, []);
    assert.deepEqual(readyConfig.migrationPatterns, ['migrations/', 'alembic/versions/']);
    assert.deepEqual(readyConfig.migrationDangerLabels, {
      drop_column: 'migration:destructive',
      drop_table: 'migration:destructive',
      alter_column_type: 'migration:long-running',
    });
    assert.deepEqual(readyConfig.migrationForbiddenPatterns, []);
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig returns remediation defaults when unset', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');

    const readyConfig = getReadyConfig(tmp);
    assert.deepEqual(readyConfig.remediation, {
      enabled: true,
      maxAttempts: 3,
      agentCmd: '',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig honors explicit check lists', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        checks: ['ci-status', 'merge-conflicts'],
        requiredChecks: ['merge-conflicts']
      }
    }));

    const readyConfig = getReadyConfig(tmp);
    assert.deepEqual(readyConfig.checks, ['ci-status', 'merge-conflicts']);
    assert.deepEqual(readyConfig.requiredChecks, ['merge-conflicts']);
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig honors explicit migration patterns', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        migrationPatterns: ['db/revisions/', 'custom_migrations/']
      }
    }));

    const readyConfig = getReadyConfig(tmp);
    assert.deepEqual(readyConfig.migrationPatterns, ['db/revisions/', 'custom_migrations/']);
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig returns migrationKind when configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        migrationKind: 'sql',
      }
    }));

    const readyConfig = getReadyConfig(tmp);
    assert.equal(readyConfig.migrationKind, 'sql');
  } finally {
    cleanUp(tmp);
  }
});

test('ready.requiredChecks must be a subset of ready.checks', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        checks: ['ci-status'],
        requiredChecks: ['forbidden-ddl'],
      }
    }));

    assert.throws(() => loadWavemillConfig(tmp), /ready\/requiredChecks/);
  } finally {
    cleanUp(tmp);
  }
});

test('ready.requiredChecks accepts merge-conflicts alias when checks uses merge-conflict', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        checks: ['merge-conflict', 'ci-status'],
        requiredChecks: ['merge-conflicts'],
      }
    }));

    assert.doesNotThrow(() => loadWavemillConfig(tmp));
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig respects explicit remediation overrides', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        remediation: {
          enabled: false,
          maxAttempts: 5,
          agentCmd: 'claude',
        }
      }
    }));

    const readyConfig = getReadyConfig(tmp);
    assert.deepEqual(readyConfig.remediation, {
      enabled: false,
      maxAttempts: 5,
      agentCmd: 'claude',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('ready failure classifier and verification accessors return configured values', () => {
  const tmp = makeTempRepo();
  try {
    writeConfig(tmp, JSON.stringify({
      ready: {
        transientRetryBudget: 5,
        remediationLogMaxBytes: 1234,
        verificationGatingEnabled: false,
        localCommandMap: {
          'Unit Tests': 'npm test',
        },
      },
    }));

    assert.deepEqual(getReadyFailureClassifierConfig(tmp), {
      transientRetryBudget: 5,
      remediationLogMaxBytes: 1234,
      localCommandMap: {
        'Unit Tests': 'npm test',
      },
    });
    assert.deepEqual(getReadyVerificationConfig(tmp), {
      gatingEnabled: false,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('getMergeQueueConfig returns defaults when unset', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');

    assert.deepEqual(getMergeQueueConfig(tmp), {
      enabled: true,
      maxConcurrentCandidates: 2,
      stuckTimeoutSeconds: 900,
      conflictGroupingEnabled: true,
      skipCooldownSeconds: 60,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getMergeQueueConfig honors explicit overrides', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mergeQueue: {
        enabled: false,
        maxConcurrentCandidates: 3,
        stuckTimeoutSeconds: 1200,
        conflictGroupingEnabled: false,
        skipCooldownSeconds: 0,
      },
    }));

    assert.deepEqual(getMergeQueueConfig(tmp), {
      enabled: false,
      maxConcurrentCandidates: 3,
      stuckTimeoutSeconds: 1200,
      conflictGroupingEnabled: false,
      skipCooldownSeconds: 0,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('mergeQueue schema rejects invalid maxConcurrentCandidates', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mergeQueue: {
        maxConcurrentCandidates: 0,
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /Config validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('mergeQueue local overlay merges onto base config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeFileSync(join(tmp, '.wavemill-config.json'), JSON.stringify({
      mergeQueue: {
        enabled: true,
        maxConcurrentCandidates: 2,
        stuckTimeoutSeconds: 900,
      },
    }));
    writeFileSync(join(tmp, '.wavemill-config.local.json'), JSON.stringify({
      mergeQueue: {
        maxConcurrentCandidates: 4,
      },
    }));

    assert.deepEqual(getMergeQueueConfig(tmp), {
      enabled: true,
      maxConcurrentCandidates: 4,
      stuckTimeoutSeconds: 900,
      conflictGroupingEnabled: true,
      skipCooldownSeconds: 60,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getReadyConfig honors explicit danger labels and forbidden patterns', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        migrationDangerLabels: {
          drop_table: 'db-risk-approved',
        },
        migrationForbiddenPatterns: ['custom-online-ddl'],
      }
    }));

    const readyConfig = getReadyConfig(tmp);
    assert.deepEqual(readyConfig.migrationDangerLabels, {
      drop_column: 'migration:destructive',
      drop_table: 'db-risk-approved',
      alter_column_type: 'migration:long-running',
    });
    assert.deepEqual(readyConfig.migrationForbiddenPatterns, ['custom-online-ddl']);
  } finally {
    cleanUp(tmp);
  }
});

test('getIntegrationConfig returns defaults when section is missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');

    assert.deepEqual(getIntegrationConfig(tmp), INTEGRATION_DEFAULTS);
  } finally {
    cleanUp(tmp);
  }
});

test('getIntegrationConfig returns defaults for an empty section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {},
    }));

    assert.deepEqual(getIntegrationConfig(tmp), INTEGRATION_DEFAULTS);
  } finally {
    cleanUp(tmp);
  }
});

test('getIntegrationConfig uses mill base branch when integration branch is not configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: {
        baseBranch: 'main',
      },
    }));

    assert.deepEqual(getIntegrationConfig(tmp), {
      ...INTEGRATION_DEFAULTS,
      integrationBranch: 'main',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getIntegrationConfig merges partial overrides with defaults', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        enabled: true,
        mergeMethod: 'merge',
      },
    }));

    assert.deepEqual(getIntegrationConfig(tmp), {
      ...INTEGRATION_DEFAULTS,
      enabled: true,
      mergeMethod: 'merge',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getIntegrationConfig returns a full valid integration block', () => {
  const tmp = makeTempRepo();
  const integration = {
    enabled: true,
    integrationBranch: 'auto/staging',
    promotionBranch: 'release',
    autoUpdatePromotionBranch: true,
    mergeMethod: 'rebase' as const,
    deleteBranchAfterMerge: false,
    haltOnRed: false,
    requiredChecks: ['ci'],
    highRiskPolicy: 'allow' as const,
    useMillSession: false,
    mergeLockTimeoutMinutes: 60,
  };
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ integration }));

    assert.deepEqual(getIntegrationConfig(tmp), integration);
  } finally {
    cleanUp(tmp);
  }
});

test('getPromotionConfig returns defaults when section is missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');

    assert.deepEqual(getPromotionConfig(tmp), PROMOTION_DEFAULTS);
  } finally {
    cleanUp(tmp);
  }
});

test('getReviewMergeConfig returns defaults when section is missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, '{}');

    assert.deepEqual(getReviewMergeConfig(tmp), REVIEW_MERGE_DEFAULTS);
  } finally {
    cleanUp(tmp);
  }
});

test('getReviewMergeConfig merges partial overrides with defaults', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      reviewMerge: {
        crossPrRevertCheck: {
          maxRecentMerges: 12,
        },
      },
    }));

    assert.deepEqual(getReviewMergeConfig(tmp), {
      crossPrRevertCheck: {
        enabled: true,
        maxRecentMerges: 12,
      },
    });
  } finally {
    cleanUp(tmp);
  }
});

test('schema rejects invalid reviewMerge.crossPrRevertCheck.maxRecentMerges values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      reviewMerge: {
        crossPrRevertCheck: {
          maxRecentMerges: 0,
        },
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /maxRecentMerges/);
  } finally {
    cleanUp(tmp);
  }
});

test('getPromotionConfig merges partial overrides with defaults', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      promotion: {
        protectedIntegrationStrategy: 'block',
      },
    }));

    assert.deepEqual(getPromotionConfig(tmp), {
      ...PROMOTION_DEFAULTS,
      protectedIntegrationStrategy: 'block',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('getPromotionConfig returns a full valid promotion block', () => {
  const tmp = makeTempRepo();
  const promotion = {
    protectedIntegrationStrategy: 'use-promotion-head' as const,
    promotionHeadBranch: 'auto/release-transport',
  };
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({ promotion }));

    assert.deepEqual(getPromotionConfig(tmp), promotion);
  } finally {
    cleanUp(tmp);
  }
});

test('invalid promotion protectedIntegrationStrategy throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      promotion: {
        protectedIntegrationStrategy: 'rewrite-anyway',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid integration mergeMethod throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        mergeMethod: 'fast-forward',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid integration highRiskPolicy throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        highRiskPolicy: 'yolo',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid integration enabled type throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        enabled: 'yes',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('invalid integration autoUpdatePromotionBranch type throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        autoUpdatePromotionBranch: 'yes',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('repo config remains valid and integration defaults stay opt-in', () => {
  clearConfigCache();
  const config = loadWavemillConfig(process.cwd());
  assert.ok(config);

  // Assert on the shipped base file directly, not the merged config. A
  // developer running with `.wavemill-config.local.json` may have integration
  // enabled locally; this test guards the canonical default that ships in main.
  const shipped = JSON.parse(
    readFileSync(join(process.cwd(), '.wavemill-config.json'), 'utf-8'),
  ) as { integration?: unknown };
  if (shipped.integration !== undefined) {
    assert.equal((shipped.integration as { enabled?: unknown }).enabled, false);
  }
});

test('ready remediation maxAttempts must be at least 1', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      ready: {
        remediation: {
          maxAttempts: 0,
        }
      }
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      const config = loadWavemillConfig(tmp);
      assert.equal(config.ready?.remediation?.maxAttempts, 0);
    }
  } finally {
    cleanUp(tmp);
  }
});

test('integration ready policy accessor returns defaults with branch fallback', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        integrationBranch: 'auto/staging',
        readyPolicy: {
          enabled: true,
        },
      },
    }));

    assert.deepEqual(getIntegrationReadyPolicy(tmp), {
      enabled: true,
      integrationBranch: 'auto/staging',
      riskPolicy: 'require-label',
      enforceMigrationCoupling: true,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('invalid integration ready policy risk setting throws validation error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: {
        readyPolicy: {
          riskPolicy: 'manual',
        },
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('eval success threshold accepts values between 0 and 1', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        successThreshold: 0.65,
      },
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.eval?.successThreshold, 0.65);
  } finally {
    cleanUp(tmp);
  }
});

test('eval success threshold rejects values above 1', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        successThreshold: 1.1,
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('eval success threshold rejects values below 0', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        successThreshold: -0.1,
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('eval success threshold rejects non-numeric values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      eval: {
        successThreshold: '0.5',
      },
    }));

    if (hasAjv) {
      assert.throws(() => {
        loadWavemillConfig(tmp);
      }, /validation failed/);
    } else {
      assert.doesNotThrow(() => {
        loadWavemillConfig(tmp);
      });
    }
  } finally {
    cleanUp(tmp);
  }
});

test('agents config accepts family alias, pinned ID, and inherit selectors', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      agents: {
        planner: { model: 'claude-opus-4-7' },
        coder: { model: 'opus' },
        reviewer: { model: 'inherit' },
      },
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.agents?.planner?.model, 'claude-opus-4-7');
    assert.equal(config.agents?.coder?.model, 'opus');
    assert.equal(config.agents?.reviewer?.model, 'inherit');
    assert.deepEqual(getAgentsConfig(tmp), config.agents);
  } finally {
    cleanUp(tmp);
  }
});

test('agents config rejects invalid model selector strings with path context', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      agents: {
        coder: { model: 'not a valid selector' },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /\/agents\/coder\/model[\s\S]*not a valid selector[\s\S]*valid model selector/i);
  } finally {
    cleanUp(tmp);
  }
});

test('agents config rejects empty model selectors', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      agents: {
        coder: { model: '' },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /\/agents\/coder\/model[\s\S]*not a valid model selector/i);
  } finally {
    cleanUp(tmp);
  }
});

test('agents config still enforces string shape validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      agents: {
        coder: { model: 123 },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /\/agents\/coder\/model: must be string/i);
  } finally {
    cleanUp(tmp);
  }
});

test('getAgentsConfig returns empty object when agents config is absent', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: { maxParallel: 3 },
    }));

    assert.deepEqual(getAgentsConfig(tmp), {});
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Local Overlay Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Local Overlay Tests ---\n');

function writeLocalConfig(repoDir: string, content: string) {
  writeFileSync(join(repoDir, '.wavemill-config.local.json'), content, 'utf-8');
}

test('local overlay deep-merges objects onto base', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: { baseBranch: 'main', maxParallel: 7 },
      integration: { enabled: false, integrationBranch: 'auto/integration' },
    }));
    writeLocalConfig(tmp, JSON.stringify({
      mill: { baseBranch: 'auto/integration' },
      integration: { enabled: true },
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.mill?.baseBranch, 'auto/integration');
    assert.equal(config.mill?.maxParallel, 7);
    assert.equal(config.integration?.enabled, true);
    assert.equal(config.integration?.integrationBranch, 'auto/integration');
  } finally {
    cleanUp(tmp);
  }
});

test('base-only loader ignores local overlay values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      configVersion: '1.3.0',
      mill: { maxParallel: 5 },
      router: { enabled: false },
    }));
    writeLocalConfig(tmp, JSON.stringify({
      configVersion: '1.4.0',
      mill: { maxParallel: 12 },
      router: { enabled: true },
    }));

    const baseConfig = loadWavemillBaseConfig(tmp);
    const runtimeConfig = loadWavemillConfig(tmp);

    assert.equal(baseConfig.configVersion, '1.3.0');
    assert.equal(baseConfig.mill?.maxParallel, 5);
    assert.equal(baseConfig.router?.enabled, false);
    assert.equal(runtimeConfig.configVersion, '1.4.0');
    assert.equal(runtimeConfig.mill?.maxParallel, 12);
    assert.equal(runtimeConfig.router?.enabled, true);
  } finally {
    cleanUp(tmp);
  }
});

test('local overlay deep-merges promotion config onto base', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      promotion: {
        protectedIntegrationStrategy: 'skip-reconciliation',
        promotionHeadBranch: 'auto/base-promotion',
      },
    }));
    writeLocalConfig(tmp, JSON.stringify({
      promotion: {
        protectedIntegrationStrategy: 'use-promotion-head',
      },
    }));

    assert.deepEqual(getPromotionConfig(tmp), {
      protectedIntegrationStrategy: 'use-promotion-head',
      promotionHeadBranch: 'auto/base-promotion',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('local overlay replaces arrays entirely rather than concatenating', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      permissions: { autoApprovePatterns: ['git status*', 'ls *'] },
    }));
    writeLocalConfig(tmp, JSON.stringify({
      permissions: { autoApprovePatterns: ['rg *'] },
    }));

    const config = loadWavemillConfig(tmp);
    assert.deepEqual(config.permissions?.autoApprovePatterns, ['rg *']);
  } finally {
    cleanUp(tmp);
  }
});

test('local overlay alone (no base file) acts as the entire config', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeLocalConfig(tmp, JSON.stringify({
      mill: { maxParallel: 3 },
    }));

    const config = loadWavemillConfig(tmp);
    assert.equal(config.mill?.maxParallel, 3);
  } finally {
    cleanUp(tmp);
  }
});

test('base-only loader returns empty object when only local overlay exists', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeLocalConfig(tmp, JSON.stringify({
      configVersion: CURRENT_CONFIG_VERSION,
      mill: { maxParallel: 3 },
    }));

    const baseConfig = loadWavemillBaseConfig(tmp);
    const runtimeConfig = loadWavemillConfig(tmp);

    assert.deepEqual(baseConfig, {});
    assert.equal(runtimeConfig.configVersion, CURRENT_CONFIG_VERSION);
    assert.equal(runtimeConfig.mill?.maxParallel, 3);
  } finally {
    cleanUp(tmp);
  }
});

test('local overlay with no overrides yields the base config unchanged', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: { maxParallel: 5 },
    }));
    writeLocalConfig(tmp, '{}');

    const config = loadWavemillConfig(tmp);
    assert.equal(config.mill?.maxParallel, 5);
  } finally {
    cleanUp(tmp);
  }
});

test('schema validation runs against the merged config, catching bad overlay keys', () => {
  if (!hasAjv) return; // Skip if Ajv not installed
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      integration: { enabled: false },
    }));
    writeLocalConfig(tmp, JSON.stringify({
      integration: { mergeMethod: 'not-a-real-method' },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('malformed local overlay throws a clear parse error', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));
    writeLocalConfig(tmp, '{ broken json }');

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /Failed to parse.*\.wavemill-config\.local\.json/);
  } finally {
    cleanUp(tmp);
  }
});

test('missing nativeAgent config returns an empty object', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getNativeAgentConfig(tmp), {});
  } finally {
    cleanUp(tmp);
  }
});

test('nativeAgent remains default-off when only providers are configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        providers: {
          openai: {
            apiKeyEnv: 'OPENAI_API_KEY',
          },
        },
      },
    }));

    assert.equal(getNativeAgentConfig(tmp).enabled, undefined);
    assert.equal(loadWavemillConfig(tmp).nativeAgent?.enabled, undefined);
  } finally {
    cleanUp(tmp);
  }
});

test('valid nativeAgent allowedPhases validate and are returned by the accessor', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion', 'planning', 'coding', 'review'],
      },
    }));

    assert.deepEqual(getNativeAgentConfig(tmp), {
      enabled: true,
      allowedPhases: ['task-expansion', 'planning', 'coding', 'review'],
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native expansion config defaults to disabled and no fallback', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getNativeExpansionConfig(tmp), {
      enabled: false,
      allowedForExpansion: false,
      fallbackOnUnavailable: false,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native context management config defaults and validates overrides', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        contextManagement: {
          compactionThreshold: 0.75,
          safetyMarginPct: 7,
          minRetainedToolResults: 6,
          minOutputTokens: 2048,
          packetBudgetFraction: 0.4,
        },
      },
    }));

    assert.deepEqual(getNativeContextManagementConfig(tmp), {
      compactionThreshold: 0.75,
      safetyMarginPct: 7,
      minRetainedToolResults: 6,
      minOutputTokens: 2048,
      packetBudgetFraction: 0.4,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native context management config supplies defaults when omitted', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getNativeContextManagementConfig(tmp), {
      compactionThreshold: 0.80,
      safetyMarginPct: 5,
      minRetainedToolResults: 4,
      minOutputTokens: 1024,
      packetBudgetFraction: 0.5,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native patch coding config defaults to disabled when nativeAgent is missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({}));

    assert.deepEqual(getNativePatchCodingConfig(tmp), {
      enabled: false,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native patch coding config defaults to disabled when patchCoding is missing', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        enabled: true,
      },
    }));

    assert.deepEqual(getNativePatchCodingConfig(tmp), {
      enabled: false,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native patch coding config returns enabled when explicitly set', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        patchCoding: {
          enabled: true,
        },
      },
    }));

    assert.deepEqual(getNativePatchCodingConfig(tmp), {
      enabled: true,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('native expansion config returns enabled, allowed, and fallback values', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        expansion: {
          fallbackOnUnavailable: true,
        },
      },
    }));

    assert.deepEqual(getNativeExpansionConfig(tmp), {
      enabled: true,
      allowedForExpansion: true,
      fallbackOnUnavailable: true,
    });
  } finally {
    cleanUp(tmp);
  }
});

test('nativeAgent planning limits validate and are returned by the accessor', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        planning: {
          maxTurns: 12,
          maxToolCalls: 34,
          maxWallClockMs: 56000,
          toolStagnation: {
            maxRepeatedSignatureCalls: 5,
            maxNoNovelProgressCalls: 3,
          },
        },
      },
    }));

    assert.deepEqual(getNativeAgentConfig(tmp).planning, {
      maxTurns: 12,
      maxToolCalls: 34,
      maxWallClockMs: 56000,
      toolStagnation: {
        maxRepeatedSignatureCalls: 5,
        maxNoNovelProgressCalls: 3,
      },
    });
  } finally {
    cleanUp(tmp);
  }
});

test('invalid nativeAgent planning limits are rejected by schema validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        planning: {
          maxTurns: 0,
        },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/i);
  } finally {
    cleanUp(tmp);
  }
});

test('invalid nativeAgent expansion keys are rejected by schema validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        expansion: {
          fallbackOnUnavailable: true,
          extra: true,
        },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/i);
  } finally {
    cleanUp(tmp);
  }
});

test('invalid nativeAgent patchCoding.enabled values are rejected by schema validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        patchCoding: {
          enabled: 'yes',
        },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/i);
  } finally {
    cleanUp(tmp);
  }
});

test('invalid nativeAgent patchCoding keys are rejected by schema validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        patchCoding: {
          enabled: true,
          extra: true,
        },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/i);
  } finally {
    cleanUp(tmp);
  }
});

test('invalid nativeAgent allowedPhases are rejected by schema validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning', 'deploy'],
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('valid nativeAgent provider config validates and is returned by the accessor', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning', 'review'],
        providers: {
          openai: {
            apiKeyEnv: 'OPENAI_API_KEY',
            baseUrl: 'https://api.openai.com/v1',
            headers: {
              'X-Trace': 'wavemill',
            },
          },
          openrouter: {
            enabled: true,
            apiKeyEnv: 'OPENROUTER_API_KEY',
            baseUrl: 'https://openrouter.ai/api/v1',
          },
        },
      },
    }));

    assert.deepEqual(getNativeAgentConfig(tmp), {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      providers: {
        openai: {
          apiKeyEnv: 'OPENAI_API_KEY',
          baseUrl: 'https://api.openai.com/v1',
          headers: {
            'X-Trace': 'wavemill',
          },
        },
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
      },
    });
  } finally {
    cleanUp(tmp);
  }
});

test('unsupported nativeAgent provider names fail schema validation', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {
        providers: {
          foobar: {
            apiKeyEnv: 'NOPE',
          },
        },
      },
    }));

    assert.throws(() => {
      loadWavemillConfig(tmp);
    }, /validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

test('configs that omit nativeAgent providers still validate', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      nativeAgent: {},
      integration: {
        enabled: false,
      },
    }));

    const config = loadWavemillConfig(tmp);
    assert.deepEqual(config.nativeAgent, {});
    assert.equal(config.integration?.enabled, false);
  } finally {
    cleanUp(tmp);
  }
});

test('modelExclusions validates and preserves repo/local source diagnostics', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      modelExclusions: [
        { model: 'qwen-3-coder', stages: ['coding'], reason: 'cost' },
      ],
    }));
    writeFileSync(join(tmp, '.wavemill-config.local.json'), JSON.stringify({
      modelExclusions: [
        { model: 'gpt-5.5', stages: ['reviewer'], reason: 'policy' },
      ],
    }), 'utf-8');

    assert.deepEqual(getEffectiveModelExclusions(tmp), [
      { model: 'qwen-3-coder', stages: ['coding'], reason: 'cost', source: 'repo' },
      { model: 'gpt-5.5', stages: ['reviewer'], reason: 'policy', source: 'local' },
    ]);
  } finally {
    cleanUp(tmp);
  }
});

test('modelExclusions rejects invalid stages', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      modelExclusions: [
        { model: 'gpt-5.5', stages: ['unknown-stage'] },
      ],
    }));

    assert.throws(() => loadWavemillConfig(tmp), /validation failed/);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Pre-PR Verification Config Tests
// ────────────────────────────────────────────────────────────────

test('pre-PR verification: loads empty config when not configured', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: { enabled: true },
    }));

    const config = getPrePrVerificationConfig(tmp);
    assert.deepEqual(config, {});
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: loads full configuration', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        required: true,
        source: 'explicit',
        recipe: {
          commands: ['npm test', 'npm run lint'],
          timeoutSeconds: 600,
          retryPolicy: {
            enabled: true,
            maxAttempts: 2,
            backoffSeconds: 5,
          },
        },
        logCaptureLines: 100,
        draftFallback: false,
        staleTtlSeconds: 7200,
        compatibility: {
          mode: 'warn',
          warnAfterDays: 14,
        },
        remoteOnlyExceptions: [
          {
            checkName: 'Security Scan',
            reason: 'Requires org secrets unavailable locally',
            acknowledgedBy: 'security@example.com',
            acknowledgedAt: '2026-08-04T12:00:00Z',
          },
        ],
        nonEnforcedJobs: ['Aggregate Status'],
        driftValidation: {
          enabled: true,
          blockOnUnmapped: true,
          warnOnDrift: true,
          autoAcknowledgeThreshold: 0.9,
        },
        mappingAcknowledgements: {
          checks: {
            'Lint Check': 'npm run lint',
            'Unit Tests': {
              localCommand: 'npm test',
              workflowPath: '.github/workflows/ci.yml',
              jobName: 'unit',
            },
          },
          acknowledgedBy: 'maintainer@example.com',
          acknowledgedAt: '2026-08-04T12:00:00Z',
        },
      },
    }));

    const config = getPrePrVerificationConfig(tmp);
    assert.equal(config.enabled, true);
    assert.equal(config.required, true);
    assert.equal(config.source, 'explicit');
    assert.deepEqual(config.recipe?.commands, ['npm test', 'npm run lint']);
    assert.equal(config.recipe?.timeoutSeconds, 600);
    assert.equal(config.logCaptureLines, 100);
    assert.equal(config.draftFallback, false);
    assert.equal(config.staleTtlSeconds, 7200);
    assert.equal(config.compatibility?.mode, 'warn');
    assert.equal(config.compatibility?.warnAfterDays, 14);
    assert.equal(config.remoteOnlyExceptions?.[0]?.checkName, 'Security Scan');
    assert.equal(config.remoteOnlyExceptions?.[0]?.reason, 'Requires org secrets unavailable locally');
    assert.deepEqual(config.nonEnforcedJobs, ['Aggregate Status']);
    assert.equal(config.driftValidation?.blockOnUnmapped, true);
    assert.equal(config.driftValidation?.autoAcknowledgeThreshold, 0.9);
    assert.equal(config.mappingAcknowledgements?.checks?.['Lint Check'], 'npm run lint');
    assert.deepEqual(config.mappingAcknowledgements?.checks?.['Unit Tests'], {
      localCommand: 'npm test',
      workflowPath: '.github/workflows/ci.yml',
      jobName: 'unit',
    });
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: handles github-enforced source', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'github-enforced',
        requiredChecks: ['Shell and Unit Tests', 'Type Check'],
        recipe: {
          commands: ['npm test'],
        },
      },
    }));

    const config = getPrePrVerificationConfig(tmp);
    assert.equal(config.source, 'github-enforced');
    assert.deepEqual(config.requiredChecks, ['Shell and Unit Tests', 'Type Check']);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects empty commands when required is true', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        required: true,
        recipe: {
          commands: [], // Empty when required should fail schema validation
        },
      },
    }));

    // Schema should reject empty commands (minItems: 1 when required is true)
    assert.throws(() => loadWavemillConfig(tmp), /validation failed|commands.*must NOT have fewer/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects empty requiredChecks when source is github-enforced', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'github-enforced',
        requiredChecks: [], // Empty when source is github-enforced should fail
        recipe: {
          commands: ['npm test'],
        },
      },
    }));

    // Schema validates minItems: 1 when source is github-enforced
    assert.throws(() => loadWavemillConfig(tmp), /validation failed|requiredChecks.*must NOT have fewer/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects invalid source enum', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'invalid-source',
        recipe: {
          commands: ['npm test'],
        },
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /validation failed|source/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects invalid compatibility mode', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        recipe: {
          commands: ['npm test'],
        },
        compatibility: {
          mode: 'invalid-mode',
        },
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /validation failed|mode/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects remote-only exception without rationale', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        recipe: {
          commands: ['npm test'],
        },
        remoteOnlyExceptions: [
          {
            checkName: 'Security Scan',
          },
        ],
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /validation failed|reason/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects drift threshold outside confidence range', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        recipe: {
          commands: ['npm test'],
        },
        driftValidation: {
          autoAcknowledgeThreshold: 1.5,
        },
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /validation failed|autoAcknowledgeThreshold/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: rejects timeoutSeconds below minimum', () => {
  if (!hasAjv) return;
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        recipe: {
          commands: ['npm test'],
          timeoutSeconds: 5, // Minimum is 10
        },
      },
    }));

    assert.throws(() => loadWavemillConfig(tmp), /validation failed|timeoutSeconds/);
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: merges local config over base', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: false,
        recipe: {
          commands: ['npm test'],
        },
      },
    }));
    writeFileSync(join(tmp, '.wavemill-config.local.json'), JSON.stringify({
      prePrVerification: {
        enabled: true,
        required: true,
      },
    }), 'utf-8');

    const config = getPrePrVerificationConfig(tmp);
    assert.equal(config.enabled, true); // From local
    assert.equal(config.required, true); // From local
    assert.deepEqual(config.recipe?.commands, ['npm test']); // From base
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: handles multiple commands in recipe', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      prePrVerification: {
        enabled: true,
        recipe: {
          commands: [
            'npx tsx tools/check-pi-version.ts',
            'npm test',
            'npm run test:native-launch-certification',
          ],
        },
      },
    }));

    const config = getPrePrVerificationConfig(tmp);
    assert.equal(config.recipe?.commands?.length, 3);
    assert.equal(config.recipe?.commands?.[0], 'npx tsx tools/check-pi-version.ts');
    assert.equal(config.recipe?.commands?.[2], 'npm run test:native-launch-certification');
  } finally {
    cleanUp(tmp);
  }
});

test('pre-PR verification: backward compatible with legacy configs', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      router: { enabled: true },
      ready: { checks: ['ci-status'] },
      verification: { enabled: true },
      // No prePrVerification field
    }));

    const config = loadWavemillConfig(tmp);
    assert.ok(config.router?.enabled);
    assert.deepEqual(config.ready?.checks, ['ci-status']);
    assert.ok(config.verification?.enabled);
    assert.deepEqual(getPrePrVerificationConfig(tmp), {});
  } finally {
    cleanUp(tmp);
  }
});

test('incident config defaults include resolutionAfterCycles and honor overrides', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    const defaults = getIncidentConfig(tmp);
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.detection?.resolutionAfterCycles, 5);

    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      incident: { detection: { resolutionAfterCycles: 12 } },
    }));
    const overridden = getIncidentConfig(tmp);
    assert.equal(overridden.detection?.resolutionAfterCycles, 12);
    assert.equal(overridden.detection?.dependencyThreshold, 3);
  } finally {
    cleanUp(tmp);
  }
});

test('observer linear config defaults disabled with safe policy defaults', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    const config = getObserverLinearConfig(tmp);
    assert.equal(config.enabled, false);
    assert.equal(config.retryQueuePath, '.wavemill/registry/linear-incident-queue.jsonl');
    assert.equal(config.maxIncidentsPerPass, 10);
    assert.equal(config.maxRetryEntriesPerPass, 5);
    assert.equal(config.requestDelayMs, 250);
    assert.equal(config.rateLimitBackoffMs, 1000);
    assert.equal(config.policies.product_defect.strategy, 'create');
    assert.equal(config.policies.model_task_harness_outcome.strategy, 'no_create');
    assert.deepEqual(config.policies.model_task_harness_outcome.correlateIssueIds, ['HOK-2593']);
    assert.equal(config.redaction.enabled, true);
  } finally {
    cleanUp(tmp);
  }
});

test('observer linear config normalizes partial policies and env project override', () => {
  const tmp = makeTempRepo();
  const previousProject = process.env.WAVEMILL_OBSERVER_LINEAR_PROJECT;
  const previousEnabled = process.env.WAVEMILL_OBSERVER_LINEAR_ENABLED;
  try {
    clearConfigCache();
    process.env.WAVEMILL_OBSERVER_LINEAR_PROJECT = 'Env Project';
    process.env.WAVEMILL_OBSERVER_LINEAR_ENABLED = 'true';
    writeConfig(tmp, JSON.stringify({
      observer: {
        linear: {
          enabled: false,
          team: 'HOK',
          policies: {
            external_transient_dependency: {
              strategy: 'threshold',
              threshold: 5,
            },
          },
          redaction: {
            patterns: ['custom_secret'],
          },
        },
      },
    }));
    const config = getObserverLinearConfig(tmp);
    assert.equal(config.enabled, true);
    assert.equal(config.project, 'Env Project');
    assert.equal(config.team, 'HOK');
    assert.equal(config.policies.external_transient_dependency.threshold, 5);
    assert.equal(config.policies.product_defect.strategy, 'create');
    assert.deepEqual(config.redaction.patterns, ['custom_secret']);
    assert.equal(config.redaction.redactPaths, true);
  } finally {
    if (previousProject === undefined) delete process.env.WAVEMILL_OBSERVER_LINEAR_PROJECT;
    else process.env.WAVEMILL_OBSERVER_LINEAR_PROJECT = previousProject;
    if (previousEnabled === undefined) delete process.env.WAVEMILL_OBSERVER_LINEAR_ENABLED;
    else process.env.WAVEMILL_OBSERVER_LINEAR_ENABLED = previousEnabled;
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

// Give async tests time to complete
setTimeout(() => {
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  if (failed > 0) {
    process.exit(1);
  }
}, 100);
