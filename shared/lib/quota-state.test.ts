import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { getCurrentOperatingMode } from './operating-mode.ts';
import {
  __resetQuotaStateTestState,
  __setClock,
  QUOTA_STATE_TIMINGS,
  compactQuotaState,
  estimateQuotaHealth,
  getVendorQuotaBreakdown,
  getModelStatus,
  markExhausted,
  recordNearLimit,
  recordRequest,
  readOpenRouterCredits,
  readQuotaSnapshot,
  recordLimitError,
  recordSuccess,
  writeOpenRouterCredits,
} from './quota-state.ts';

let tempRoot: string;
let repoDir: string;
const originalDeepSeekQuotaTestKey = process.env.TEST_DEEPSEEK_KEY;

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function createRepoDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  git('init', dir);
  git('config user.name "Test User"', dir);
  git('config user.email "test@example.com"', dir);
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf-8');
  git('add README.md', dir);
  git('commit -m "init"', dir);
  return dir;
}

function quotaStatePath(targetRepoDir = repoDir): string {
  return join(targetRepoDir, '.wavemill', 'quota-state.json');
}

function quotaLockPath(targetRepoDir = repoDir): string {
  return join(targetRepoDir, '.wavemill', 'quota-state.lock');
}

function rawQuotaState(targetRepoDir = repoDir): Record<string, unknown> {
  return JSON.parse(readFileSync(quotaStatePath(targetRepoDir), 'utf-8')) as Record<string, unknown>;
}

function writeRepoConfig(targetRepoDir: string, value: Record<string, unknown>): void {
  writeFileSync(join(targetRepoDir, '.wavemill-config.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  clearConfigCache(targetRepoDir);
}

function withCapturedWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }

  return warnings;
}

function makeSnapshot(models: Record<string, 'healthy' | 'degrading' | 'exhausted'>) {
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
      }]),
    ),
    snapshotAt: '2026-04-17T12:00:00.000Z',
  };
}

function writeMultiFrontierConfig(targetRepoDir: string): void {
  writeRepoConfig(targetRepoDir, {});
}

describe('quota-state', () => {
  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `quota-state-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    repoDir = createRepoDir('repo');
    process.env.TEST_DEEPSEEK_KEY = 'quota-test-key';
    __resetQuotaStateTestState();
    clearConfigCache();
  });

  afterEach(() => {
    __resetQuotaStateTestState();
    clearConfigCache();
    if (originalDeepSeekQuotaTestKey === undefined) {
      delete process.env.TEST_DEEPSEEK_KEY;
    } else {
      process.env.TEST_DEEPSEEK_KEY = originalDeepSeekQuotaTestKey;
    }

    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty snapshot when no state file exists', () => {
    const snapshot = readQuotaSnapshot(repoDir);

    assert.deepEqual(snapshot.models, {});
    assert.equal(snapshot.providers, undefined);
    assert.match(snapshot.snapshotAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('migrates v1 model-only state to v2 on read', () => {
    mkdirSync(dirname(quotaStatePath(repoDir)), { recursive: true });
    writeFileSync(quotaStatePath(repoDir), `${JSON.stringify({
      version: 1,
      updatedAt: '2026-04-17T12:00:00.000Z',
      models: {
        'glm-5.2': {
          status: 'healthy',
          remainingEstimate: null,
          resetAt: null,
          confidence: 1,
          lastLimitErrorAt: null,
          lastSuccessAt: null,
          lastReason: null,
          consecutiveLimitErrors: 0,
          requestHistory: [],
          consecutiveNearLimitSignals: 0,
          lastNearLimitAt: null,
          budgetSignal: null,
        },
      },
    }, null, 2)}\n`, 'utf-8');

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['glm-5.2']?.status, 'healthy');
    assert.equal(snapshot.providers, undefined);
    recordSuccess({ modelId: 'kimi-k2' }, repoDir);
    assert.equal(rawQuotaState(repoDir).version, 2);
  });

  it('round-trips OpenRouter provider credits through quota state', () => {
    writeOpenRouterCredits(repoDir, {
      totalCredits: 110,
      totalUsage: 110.157967615,
      balanceUsd: -0.157967615,
      usageDaily: 10.05,
      updatedAt: '2026-08-19T12:00:00.000Z',
      lastFetchError: null,
    });

    const credits = readOpenRouterCredits(repoDir);
    assert.equal(credits?.balanceUsd, -0.157967615);
    assert.equal(readQuotaSnapshot(repoDir).providers?.openrouter?.totalCredits, 110);

    writeOpenRouterCredits(repoDir, { error: 'network down' });
    const failed = readOpenRouterCredits(repoDir);
    assert.equal(failed?.balanceUsd, -0.157967615);
    assert.equal(failed?.lastFetchError?.message, 'network down');
  });

  it('records limit errors, escalates to exhausted, and returns to healthy on success', () => {
    const firstErrorAt = Date.parse('2026-04-17T12:00:00.000Z');
    __setClock(() => firstErrorAt);
    recordLimitError({
      modelId: 'claude-opus-4-1',
      remainingEstimate: 1200,
      resetAt: '2026-04-17T12:30:00.000Z',
      reason: '429 rate_limit',
    }, repoDir);

    let snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-opus-4-1']?.status, 'degrading');
    assert.equal(snapshot.models['claude-opus-4-1']?.remainingEstimate, 1200);
    assert.equal(snapshot.models['claude-opus-4-1']?.confidence, 0.5);

    __setClock(() => firstErrorAt + 60_000);
    recordLimitError({
      modelId: 'claude-opus-4-1',
      reason: 'quota_exhausted',
    }, repoDir);

    snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-opus-4-1']?.status, 'exhausted');
    assert.equal(snapshot.models['claude-opus-4-1']?.confidence, 0.9);

    __setClock(() => firstErrorAt + 120_000);
    recordSuccess({ modelId: 'claude-opus-4-1' }, repoDir);

    snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-opus-4-1']?.status, 'healthy');
    assert.equal(snapshot.models['claude-opus-4-1']?.confidence, 1);
    assert.equal(getModelStatus('claude-opus-4-1', repoDir), 'healthy');

    const models = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    assert.equal(models['claude-opus-4-1']?.consecutiveLimitErrors, 0);
  });

  it('marks a model exhausted immediately without requiring consecutive errors', () => {
    __setClock(() => Date.parse('2026-04-17T12:05:00.000Z'));
    markExhausted({
      modelId: 'claude-opus-4-7',
      reason: '429 rate_limit',
      resetAt: '2026-04-17T12:35:00.000Z',
    }, repoDir);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-opus-4-7']?.status, 'exhausted');
    assert.equal(snapshot.models['claude-opus-4-7']?.resetAt, '2026-04-17T12:35:00.000Z');

    const models = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    assert.equal(models['claude-opus-4-7']?.consecutiveLimitErrors, 2);
  });

  it('tracks DeepSeek models in quota state without special casing', () => {
    __setClock(() => Date.parse('2026-04-17T12:10:00.000Z'));
    recordRequest({ modelId: 'deepseek-v4-pro' }, repoDir);
    recordNearLimit({ modelId: 'deepseek-v4-pro', remainingEstimate: 1000, limitEstimate: 2000 }, repoDir);
    recordLimitError({ modelId: 'deepseek-v4-pro', reason: '429 rate_limit' }, repoDir);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['deepseek-v4-pro']?.status, 'degrading');

    const models = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    assert.equal((models['deepseek-v4-pro']?.requestHistory as unknown[]).length, 1);
    assert.equal(models['deepseek-v4-pro']?.consecutiveNearLimitSignals, 1);
  });

  it('persists quota state across reads without relying on process-local caches', () => {
    const recordedAt = Date.parse('2026-04-17T13:00:00.000Z');
    __setClock(() => recordedAt);
    recordLimitError({
      modelId: 'claude-sonnet-4-5',
      reason: '429 rate_limit',
    }, repoDir);

    __resetQuotaStateTestState();
    __setClock(() => recordedAt);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-5']?.status, 'degrading');
    assert.equal(snapshot.models['claude-sonnet-4-5']?.lastReason, '429 rate_limit');
  });

  it('uses atomic rename and leaves no temporary state files behind', () => {
    __setClock(() => Date.parse('2026-04-17T14:00:00.000Z'));
    recordSuccess({ modelId: 'gpt-5.4' }, repoDir);

    const files = readdirSync(dirname(quotaStatePath(repoDir)));
    assert.deepEqual(files.sort(), ['quota-state.json']);
  });

  it('preserves all writes when many models update concurrently', async () => {
    QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => {
        recordLimitError({
          modelId: `model-${index}`,
          reason: '429 rate_limit',
        }, repoDir);
      })),
    );

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(Object.keys(snapshot.models).length, 20);
    for (let index = 0; index < 20; index += 1) {
      assert.equal(snapshot.models[`model-${index}`]?.status, 'degrading');
    }
  });

  it('increments consecutive limit errors without losing writes under contention', async () => {
    QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
    await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => {
        recordLimitError({
          modelId: 'shared-model',
          reason: '429 rate_limit',
        }, repoDir);
      })),
    );

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['shared-model']?.status, 'exhausted');

    const rawModels = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    assert.equal(rawModels['shared-model']?.consecutiveLimitErrors, 20);
  });

  it('auto-promotes expired reset windows at read time and only rewrites on compact', () => {
    const baseTime = Date.parse('2026-04-17T15:00:00.000Z');
    __setClock(() => baseTime);
    recordLimitError({
      modelId: 'claude-opus-4-7',
      resetAt: '2026-04-17T15:05:00.000Z',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-7',
      resetAt: '2026-04-17T15:05:00.000Z',
      reason: 'quota_exhausted',
    }, repoDir);

    __setClock(() => Date.parse('2026-04-17T15:06:00.000Z'));
    const projected = readQuotaSnapshot(repoDir);
    assert.equal(projected.models['claude-opus-4-7']?.status, 'healthy');
    assert.equal(projected.models['claude-opus-4-7']?.resetAt, null);

    const rawBeforeCompact = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    assert.equal(rawBeforeCompact['claude-opus-4-7']?.status, 'exhausted');
    assert.equal(rawBeforeCompact['claude-opus-4-7']?.resetAt, '2026-04-17T15:05:00.000Z');

    compactQuotaState(repoDir);

    const rawAfterCompact = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    assert.equal(rawAfterCompact['claude-opus-4-7']?.status, 'healthy');
    assert.equal(rawAfterCompact['claude-opus-4-7']?.resetAt, null);
  });

  it('decays degrading and exhausted states toward healthy when no recent errors exist', () => {
    const baseTime = Date.parse('2026-04-17T16:00:00.000Z');
    __setClock(() => baseTime);
    recordLimitError({
      modelId: 'degrading-model',
      reason: '429 rate_limit',
    }, repoDir);

    recordLimitError({
      modelId: 'exhausted-model',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'exhausted-model',
      reason: 'quota_exhausted',
    }, repoDir);

    __setClock(() => baseTime + QUOTA_STATE_TIMINGS.DEGRADING_DECAY_MS + 1);
    let snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['degrading-model']?.status, 'healthy');

    __setClock(() => baseTime + QUOTA_STATE_TIMINGS.EXHAUSTED_DECAY_MS + 1);
    snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['exhausted-model']?.status, 'degrading');
  });

  it('steals stale locks and cleans them up after writing', () => {
    mkdirSync(dirname(quotaLockPath(repoDir)), { recursive: true });
    writeFileSync(quotaLockPath(repoDir), JSON.stringify({
      pid: 99999,
      acquiredAt: '2026-04-17T16:59:49.000Z',
    }), 'utf-8');

    __setClock(() => Date.parse('2026-04-17T17:00:00.000Z'));
    recordLimitError({
      modelId: 'claude-haiku-4-5',
      reason: '429 rate_limit',
    }, repoDir);

    assert.equal(existsSync(quotaLockPath(repoDir)), false);
    assert.equal(readQuotaSnapshot(repoDir).models['claude-haiku-4-5']?.status, 'degrading');
  });

  it('logs and swallows lock timeouts on writes', () => {
    QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS = 20;
    mkdirSync(dirname(quotaLockPath(repoDir)), { recursive: true });
    writeFileSync(quotaLockPath(repoDir), JSON.stringify({
      pid: 12345,
      acquiredAt: '2026-04-17T18:00:00.000Z',
    }), 'utf-8');

    __setClock(() => Date.parse('2026-04-17T18:00:00.100Z'));
    const warnings = withCapturedWarnings(() => {
      recordLimitError({
        modelId: 'blocked-model',
        reason: '429 rate_limit',
      }, repoDir);
    });

    assert.equal(existsSync(quotaStatePath(repoDir)), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Failed to record limit-error quota state/);
  });

  it('recovers from malformed state files on the next write', () => {
    mkdirSync(dirname(quotaStatePath(repoDir)), { recursive: true });
    writeFileSync(quotaStatePath(repoDir), '{', 'utf-8');

    assert.deepEqual(readQuotaSnapshot(repoDir).models, {});

    recordLimitError({
      modelId: 'recovered-model',
      reason: '429 rate_limit',
    }, repoDir);

    assert.equal(readQuotaSnapshot(repoDir).models['recovered-model']?.status, 'degrading');
    assert.doesNotThrow(() => rawQuotaState(repoDir));
  });

  it('returns deeply frozen snapshots', () => {
    recordLimitError({
      modelId: 'immutable-model',
      reason: '429 rate_limit',
    }, repoDir);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.models), true);
    assert.equal(Object.isFrozen(snapshot.models['immutable-model']), true);
    assert.throws(() => {
      (snapshot.models as Record<string, unknown>).extra = {};
    });
  });

  it('isolates quota state by repo path', () => {
    const otherRepoDir = createRepoDir('other-repo');

    recordLimitError({
      modelId: 'repo-one-model',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'repo-two-model',
      reason: '429 rate_limit',
    }, otherRepoDir);

    const firstSnapshot = readQuotaSnapshot(repoDir);
    const secondSnapshot = readQuotaSnapshot(otherRepoDir);

    assert.equal(firstSnapshot.models['repo-one-model']?.status, 'degrading');
    assert.equal(firstSnapshot.models['repo-two-model'], undefined);
    assert.equal(secondSnapshot.models['repo-two-model']?.status, 'degrading');
    assert.equal(secondSnapshot.models['repo-one-model'], undefined);
  });

  it('tracks rolling request history and proactively degrades before first 429', () => {
    const baseTime = Date.parse('2026-04-17T19:00:00.000Z');
    __setClock(() => baseTime);

    for (let index = 0; index < 150; index += 1) {
      recordRequest({ modelId: 'claude-sonnet-4-6' }, repoDir);
    }

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'degrading');
    assert.equal(snapshot.models['claude-sonnet-4-6']?.lastLimitErrorAt, null);

    const rawModels = rawQuotaState(repoDir).models as Record<string, Record<string, unknown>>;
    const history = rawModels['claude-sonnet-4-6']?.requestHistory as Array<{ timestamp: string }>;
    assert.equal(history.length, 100);
  });

  it('respects configured volume threshold override', () => {
    writeRepoConfig(repoDir, {
      quota: {
        thresholds: {
          volumeThresholdPercent: 95,
        },
      },
    });

    const baseTime = Date.parse('2026-04-17T19:05:00.000Z');
    __setClock(() => baseTime);
    for (let index = 0; index < 70; index += 1) {
      recordRequest({ modelId: 'claude-sonnet-4-6' }, repoDir);
    }

    let snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'healthy');

    for (let index = 0; index < 30; index += 1) {
      recordRequest({ modelId: 'claude-sonnet-4-6' }, repoDir);
    }
    snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'degrading');
  });

  it('transitions to degrading after repeated near-limit signals and resets on success', () => {
    const baseTime = Date.parse('2026-04-17T20:00:00.000Z');
    __setClock(() => baseTime);

    recordNearLimit({ modelId: 'claude-sonnet-4-6', reason: 'header warning' }, repoDir);
    __setClock(() => baseTime + 30_000);
    recordNearLimit({ modelId: 'claude-sonnet-4-6', reason: 'header warning' }, repoDir);
    __setClock(() => baseTime + 60_000);
    recordNearLimit({ modelId: 'claude-sonnet-4-6', reason: 'header warning' }, repoDir);

    let snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'degrading');

    recordSuccess({ modelId: 'claude-sonnet-4-6' }, repoDir);
    snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'healthy');
    assert.equal(estimateQuotaHealth('claude-sonnet-4-6', repoDir), 'healthy');
  });

  it('proactively degrades from low budget signals', () => {
    const baseTime = Date.parse('2026-04-17T20:10:00.000Z');
    __setClock(() => baseTime);
    recordRequest({
      modelId: 'claude-sonnet-4-6',
      budgetSignal: {
        remaining: 20,
        limit: 100,
        window: 'minute',
      },
    }, repoDir);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'degrading');
  });

  it('applies manual overrides and ignores expired overrides', () => {
    const nowMs = Date.parse('2026-04-17T21:00:00.000Z');
    __setClock(() => nowMs);
    recordRequest({ modelId: 'claude-sonnet-4-6' }, repoDir);

    writeRepoConfig(repoDir, {
      quota: {
        manualOverrides: {
          'claude-sonnet-4-6': {
            status: 'degrading',
            reason: 'planned maintenance',
            expiresAt: '2026-04-17T22:00:00.000Z',
          },
          'claude-opus-4-7': {
            status: 'exhausted',
            reason: 'expired override',
            expiresAt: '2026-04-17T20:00:00.000Z',
          },
        },
      },
    });

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-sonnet-4-6']?.status, 'degrading');
    assert.equal(snapshot.models['claude-sonnet-4-6']?.lastReason, 'planned maintenance');
    assert.equal(snapshot.models['claude-opus-4-7'], undefined);
  });

  it('drives constrained operating mode before 429 via proactive degradation', () => {
    writeRepoConfig(repoDir, {
      quota: {
        manualOverrides: {
          'claude-fable-5': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'claude-opus-5-5': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'claude-opus-4-8': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'claude-opus-4-7': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'claude-opus-4-6': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'gpt-5.5': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'gpt-6-sol': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
        },
      },
    });

    const baseTime = Date.parse('2026-04-17T22:00:00.000Z');
    __setClock(() => baseTime);
    for (let index = 0; index < 100; index += 1) {
      recordRequest({ modelId: 'claude-opus-4-6' }, repoDir);
    }

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['claude-opus-4-6']?.lastLimitErrorAt, null);
    assert.equal(getCurrentOperatingMode(repoDir), 'constrained');
  });

  it('derives normal operating mode when a cross-vendor frontier sibling remains healthy', () => {
    writeMultiFrontierConfig(repoDir);

    recordLimitError({
      modelId: 'claude-opus-4-8',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-8',
      reason: 'quota_exhausted',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-7',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-7',
      reason: 'quota_exhausted',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-6',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-6',
      reason: 'quota_exhausted',
    }, repoDir);
    recordSuccess({ modelId: 'gpt-5.5' }, repoDir);

    assert.equal(getCurrentOperatingMode(repoDir), 'normal');
    assert.deepEqual(getVendorQuotaBreakdown(readQuotaSnapshot(repoDir), [
      { modelId: 'claude-opus-4-8', vendor: 'anthropic' },
      { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
      { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
      { modelId: 'gpt-5.5', vendor: 'openai' },
    ]), {
      anthropic: { healthy: 0, degraded: 0, exhausted: 3, total: 3 },
      openai: { healthy: 1, degraded: 0, exhausted: 0, total: 1 },
    });
  });

  it('derives constrained operating mode when every frontier vendor is degrading', () => {
    writeMultiFrontierConfig(repoDir);

    recordLimitError({
      modelId: 'claude-fable-5',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-5-5',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-8',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-7',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'claude-opus-4-6',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'gpt-5.5',
      reason: '429 rate_limit',
    }, repoDir);
    recordLimitError({
      modelId: 'gpt-6-sol',
      reason: '429 rate_limit',
    }, repoDir);

    assert.equal(getCurrentOperatingMode(repoDir), 'constrained');
  });

  it('derives survival operating mode when every frontier vendor is exhausted', () => {
    writeMultiFrontierConfig(repoDir);

    markExhausted({ modelId: 'claude-fable-5', reason: 'quota_exhausted' }, repoDir);
    markExhausted({ modelId: 'claude-opus-5-5', reason: 'quota_exhausted' }, repoDir);
    markExhausted({ modelId: 'claude-opus-4-8', reason: 'quota_exhausted' }, repoDir);
    markExhausted({ modelId: 'claude-opus-4-7', reason: 'quota_exhausted' }, repoDir);
    markExhausted({ modelId: 'claude-opus-4-6', reason: 'quota_exhausted' }, repoDir);
    markExhausted({ modelId: 'gpt-5.5', reason: 'quota_exhausted' }, repoDir);
    markExhausted({ modelId: 'gpt-6-sol', reason: 'quota_exhausted' }, repoDir);

    assert.equal(getCurrentOperatingMode(repoDir), 'survival');
  });

  describe('getVendorQuotaBreakdown', () => {
    it('returns an empty object for an empty frontier set', () => {
      assert.deepEqual(getVendorQuotaBreakdown(makeSnapshot({}), []), {});
    });

    it('counts a single healthy vendor', () => {
      const snapshot = makeSnapshot({});

      assert.deepEqual(getVendorQuotaBreakdown(snapshot, [
        { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
      ]), {
        anthropic: { healthy: 2, degraded: 0, exhausted: 0, total: 2 },
      });
    });

    it('counts mixed healthy and degraded models for one vendor', () => {
      const snapshot = makeSnapshot({
        'claude-opus-4-7': 'degrading',
      });

      assert.deepEqual(getVendorQuotaBreakdown(snapshot, [
        { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
      ]), {
        anthropic: { healthy: 1, degraded: 1, exhausted: 0, total: 2 },
      });
    });

    it('counts all exhausted models for one vendor', () => {
      const snapshot = makeSnapshot({
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
        'claude-opus-4-5': 'exhausted',
      });

      assert.deepEqual(getVendorQuotaBreakdown(snapshot, [
        { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-5', vendor: 'anthropic' },
      ]), {
        anthropic: { healthy: 0, degraded: 0, exhausted: 3, total: 3 },
      });
    });

    it('groups mixed model states by vendor', () => {
      const snapshot = makeSnapshot({
        'gpt-5.4': 'exhausted',
      });

      assert.deepEqual(getVendorQuotaBreakdown(snapshot, [
        { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
        { modelId: 'gpt-5.4', vendor: 'openai' },
      ]), {
        anthropic: { healthy: 2, degraded: 0, exhausted: 0, total: 2 },
        openai: { healthy: 0, degraded: 0, exhausted: 1, total: 1 },
      });
    });

    it('distinguishes exhausted and healthy counts across vendors', () => {
      const snapshot = makeSnapshot({
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
        'gpt-5.4': 'healthy',
      });

      assert.deepEqual(getVendorQuotaBreakdown(snapshot, [
        { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
        { modelId: 'gpt-5.4', vendor: 'openai' },
      ]), {
        anthropic: { healthy: 0, degraded: 0, exhausted: 2, total: 2 },
        openai: { healthy: 1, degraded: 0, exhausted: 0, total: 1 },
      });
    });

    it('treats models missing from the snapshot as healthy', () => {
      const snapshot = makeSnapshot({
        'claude-opus-4-7': 'exhausted',
      });

      assert.deepEqual(getVendorQuotaBreakdown(snapshot, [
        { modelId: 'claude-opus-4-7', vendor: 'anthropic' },
        { modelId: 'claude-opus-4-6', vendor: 'anthropic' },
      ]), {
        anthropic: { healthy: 1, degraded: 0, exhausted: 1, total: 2 },
      });
    });
  });
});
