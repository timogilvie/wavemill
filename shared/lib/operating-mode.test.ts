import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';
import {
  __resetQuotaStateTestState,
  __setClock,
  recordRequest,
} from './quota-state.ts';
import {
  CONSTRAINED_TRIGGER_STATUS,
  deriveOperatingMode,
  getCurrentOperatingMode,
  getOperatingModeResult,
  getModelOperatingMode,
  hasAnyHealthyModel,
  PREMIUM_MODEL_CLASS,
  SURVIVAL_TRIGGER_STATUS,
} from './operating-mode.ts';
import { getEffectiveRegistry, resetWarningState } from './model-registry.ts';

let tempRoot: string;
let repoDir: string;
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function runOperatingModeTool(args: string[]): { stdout: string; status: number } {
  const result = execFileSync(process.execPath, ['--import', 'tsx', 'tools/get-operating-mode.ts', ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  return { stdout: result.trim(), status: 0 };
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

function makeSnapshot(models: Record<string, QuotaStatus>): QuotaSnapshot {
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

function writeQuotaState(models: Record<string, QuotaStatus>): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-17T12:00:00.000Z',
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      }]),
    ),
  }, null, 2), 'utf-8');
}

function writeMultiFrontierConfig(targetRepoDir: string): void {
  writeFileSync(join(targetRepoDir, '.wavemill-config.json'), '{}\n', 'utf-8');
  clearConfigCache(targetRepoDir);
}

describe('operating-mode', () => {
  beforeEach(() => {
    resetWarningState();
    clearConfigCache();
    tempRoot = join(
      tmpdir(),
      `operating-mode-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    repoDir = createRepoDir('repo');
  });

  afterEach(() => {
    __resetQuotaStateTestState();
    clearConfigCache();
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('exports the premium model class and trigger statuses', () => {
    assert.equal(PREMIUM_MODEL_CLASS, 'frontier');
    assert.equal(CONSTRAINED_TRIGGER_STATUS, 'degrading');
    assert.equal(SURVIVAL_TRIGGER_STATUS, 'exhausted');
  });

  it('returns normal for an empty snapshot', () => {
    assert.equal(deriveOperatingMode(makeSnapshot({}), ['claude-opus-4-7']), 'normal');
  });

  it('returns normal when only non-premium models are tracked', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-sonnet-4-6': 'degrading',
        'claude-haiku-4-5-20251001': 'exhausted',
      }), ['claude-opus-4-7']),
      'normal',
    );
  });

  it('returns normal when tracked premium models are healthy', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': 'healthy' }), ['claude-opus-4-7']),
      'normal',
    );
  });

  it('returns constrained when a premium model is degrading', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': 'degrading' }), ['claude-opus-4-7']),
      'constrained',
    );
  });

  it('returns survival when a premium model is exhausted', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': 'exhausted' }), ['claude-opus-4-7']),
      'survival',
    );
  });

  it('returns normal when one premium model is degrading and another is healthy', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'healthy',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'normal',
    );
  });

  it('returns constrained when one premium model is exhausted and another is degrading', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'exhausted',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'constrained',
    );
  });

  it('returns survival when all premium models are exhausted', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'survival',
    );
  });

  it('returns constrained when all premium models are degrading', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'degrading',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'constrained',
    );
  });

  it('treats premium models missing from the snapshot as healthy capacity', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'exhausted',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'normal',
    );
  });

  it('treats degrading as the constrained boundary', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': CONSTRAINED_TRIGGER_STATUS }), ['claude-opus-4-7']),
      'constrained',
    );
  });

  it('treats exhausted as the survival boundary', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': SURVIVAL_TRIGGER_STATUS }), ['claude-opus-4-7']),
      'survival',
    );
  });

  it('reads the persisted quota state and returns the matching mode', () => {
    writeQuotaState({
      'claude-fable-5': 'degrading',
      'claude-opus-5-5': 'degrading',
      'claude-opus-4-8': 'degrading',
      'claude-opus-4-7': 'degrading',
      'claude-opus-4-6': 'degrading',
      'gpt-5.5': 'degrading',
      'gpt-5.6-terra': 'degrading',
      'gpt-6-sol': 'degrading',
      'gpt-6-luna': 'degrading',
    });

    assert.equal(getCurrentOperatingMode(repoDir), 'constrained');
  });

  it('returns normal when no quota state file exists', () => {
    assert.equal(getCurrentOperatingMode(repoDir), 'normal');
  });

  it('reports healthy capacity when a tracked model is healthy', () => {
    writeQuotaState({ 'claude-opus-4-7': 'healthy' });

    assert.equal(hasAnyHealthyModel(repoDir), true);
  });

  it('treats untracked models as healthy capacity for fallback purposes', () => {
    writeQuotaState({ 'claude-opus-4-7': 'exhausted' });

    assert.equal(hasAnyHealthyModel(repoDir), true);
  });

  it('reports no healthy capacity when every tracked model is degraded or exhausted', () => {
    const registry = getEffectiveRegistry(repoDir);
    const statuses = Object.fromEntries(
      Object.keys(registry.models).map((modelId, index) => [
        modelId,
        index === 0 ? 'exhausted' : 'degrading',
      ] satisfies [string, QuotaStatus]),
    );
    writeQuotaState(statuses);

    assert.equal(hasAnyHealthyModel(repoDir), false);
  });

  describe('multi-vendor frontier operating mode', () => {
    it('returns normal when one frontier vendor is exhausted and another vendor is healthy', () => {
      writeMultiFrontierConfig(repoDir);
      writeQuotaState({
        'claude-fable-5': 'exhausted',
        'claude-opus-5-5': 'exhausted',
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
        'claude-opus-4-8': 'exhausted',
        'gpt-5.5': 'healthy',
        'gpt-6-sol': 'healthy',
      });

      assert.equal(getCurrentOperatingMode(repoDir), 'normal');
      assert.equal(hasAnyHealthyModel(repoDir), true);
      assert.deepEqual(getOperatingModeResult(repoDir).vendorBreakdown, {
        anthropic: { healthy: 0, degraded: 0, exhausted: 5, total: 5 },
        openai: { healthy: 2, degraded: 0, exhausted: 0, total: 2 },
      });
    });

    it('returns constrained when every frontier vendor is degrading', () => {
      writeMultiFrontierConfig(repoDir);
      writeQuotaState({
        'claude-fable-5': 'degrading',
        'claude-opus-5-5': 'degrading',
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'degrading',
        'claude-opus-4-8': 'degrading',
        'gpt-5.5': 'degrading',
        'gpt-6-sol': 'degrading',
      });

      assert.equal(getCurrentOperatingMode(repoDir), 'constrained');
      assert.deepEqual(getOperatingModeResult(repoDir).vendorBreakdown, {
        anthropic: { healthy: 0, degraded: 5, exhausted: 0, total: 5 },
        openai: { healthy: 0, degraded: 2, exhausted: 0, total: 2 },
      });
    });

    it('returns survival when every frontier vendor is exhausted', () => {
      writeMultiFrontierConfig(repoDir);
      writeQuotaState({
        'claude-fable-5': 'exhausted',
        'claude-opus-5-5': 'exhausted',
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
        'claude-opus-4-8': 'exhausted',
        'gpt-5.5': 'exhausted',
        'gpt-6-sol': 'exhausted',
      });

      assert.equal(getCurrentOperatingMode(repoDir), 'survival');
    });
  });

  it('returns the operating mode for an individual model', () => {
    writeQuotaState({
      'claude-opus-4-7': 'exhausted',
      'gpt-5.6-terra': 'degrading',
    });

    assert.equal(getModelOperatingMode('claude-opus-4-7', repoDir), 'survival');
    assert.equal(getModelOperatingMode('gpt-5.6-terra', repoDir), 'constrained');
    assert.equal(getModelOperatingMode('claude-sonnet-4-6', repoDir), 'normal');
  });

  it('exposes global and model modes through the CLI tool', () => {
    writeQuotaState({
      'claude-fable-5': 'exhausted',
      'claude-opus-5-5': 'exhausted',
      'claude-opus-4-8': 'exhausted',
      'claude-opus-4-7': 'exhausted',
      'claude-opus-4-6': 'exhausted',
      'gpt-5.6-terra': 'degrading',
      'gpt-5.5': 'degrading',
      'gpt-6-sol': 'degrading',
      'gpt-6-luna': 'degrading',
    });

    assert.equal(runOperatingModeTool(['global', '--repo-dir', repoDir]).stdout, 'constrained');
    assert.equal(runOperatingModeTool(['model', 'gpt-5.6-terra', '--repo-dir', repoDir]).stdout, 'constrained');
  });

  it('prints a vendor breakdown in verbose global mode', () => {
    writeQuotaState({
      'claude-opus-4-7': 'healthy',
      'claude-opus-4-6': 'degrading',
      'claude-opus-4-8': 'healthy',
      'gpt-5.5': 'exhausted',
    });

    assert.equal(
      runOperatingModeTool(['global', '--verbose', '--repo-dir', repoDir]).stdout,
      ['normal', 'Vendor breakdown:', '  anthropic: 4/5 healthy (1 degraded)', '  openai   : 1/2 healthy (1 exhausted)'].join('\n'),
    );
  });

  it('uses proactive degradation to enter constrained mode before 429', () => {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
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
          'claude-opus-4-7': {
            status: 'degrading',
            reason: 'aggregate frontier capacity check',
          },
          'claude-opus-4-8': {
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
    }, null, 2), 'utf-8');
    clearConfigCache(repoDir);

    const baseTime = Date.parse('2026-04-17T12:10:00.000Z');
    __setClock(() => baseTime);
    for (let index = 0; index < 100; index += 1) {
      recordRequest({ modelId: 'claude-opus-4-6' }, repoDir);
    }

    assert.equal(getCurrentOperatingMode(repoDir), 'constrained');
  });

  describe('getOperatingModeResult', () => {
    it('returns normal mode with healthy vendor counts', () => {
      const result = getOperatingModeResult(repoDir);

      assert.equal(result.mode, 'normal');
      assert.deepEqual(result.vendorBreakdown, {
        anthropic: { healthy: 5, degraded: 0, exhausted: 0, total: 5 },
        openai: { healthy: 2, degraded: 0, exhausted: 0, total: 2 },
      });
    });

    it('returns constrained mode with degraded vendor counts', () => {
      writeQuotaState({
        'claude-opus-4-8': 'healthy',
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'exhausted',
        'gpt-5.5': 'degrading',
        'gpt-5.6-terra': 'exhausted',
      });

      const result = getOperatingModeResult(repoDir);

      assert.equal(result.mode, 'normal');
      assert.deepEqual(result.vendorBreakdown, {
        anthropic: { healthy: 3, degraded: 1, exhausted: 1, total: 5 },
        openai: { healthy: 1, degraded: 1, exhausted: 0, total: 2 },
      });
    });

    it('returns survival mode when all frontier models are exhausted', () => {
      writeQuotaState({
        'claude-fable-5': 'exhausted',
        'claude-opus-5-5': 'exhausted',
        'claude-opus-4-8': 'exhausted',
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
        'gpt-5.5': 'exhausted',
        'gpt-5.6-terra': 'exhausted',
        'gpt-6-sol': 'exhausted',
      });

      const result = getOperatingModeResult(repoDir);

      assert.equal(result.mode, 'survival');
      assert.deepEqual(result.vendorBreakdown, {
        anthropic: { healthy: 0, degraded: 0, exhausted: 5, total: 5 },
        openai: { healthy: 0, degraded: 0, exhausted: 2, total: 2 },
      });
    });

    it('returns multi-vendor counts from the global frontier set', () => {
      writeQuotaState({
        'claude-fable-5': 'healthy',
        'claude-opus-4-8': 'healthy',
        'claude-opus-4-7': 'healthy',
        'claude-opus-4-6': 'degrading',
        'gpt-5.5': 'exhausted',
      });

      const result = getOperatingModeResult(repoDir);

      assert.equal(result.mode, 'normal');
      assert.deepEqual(result.vendorBreakdown, {
        anthropic: { healthy: 4, degraded: 1, exhausted: 0, total: 5 },
        openai: { healthy: 1, degraded: 0, exhausted: 1, total: 2 },
      });
    });

    it('rejects repo-local attempts to remove frontier models from the global set', () => {
      writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
        modelRegistry: {
          models: {
            'claude-fable-5': {
              class: 'strong_generalist',
            },
            'claude-opus-4-7': {
              class: 'strong_generalist',
            },
            'claude-opus-4-8': {
              class: 'strong_generalist',
            },
            'claude-opus-4-6': {
              class: 'strong_generalist',
            },
            'gpt-5.5': {
              class: 'strong_generalist',
            },
            'gpt-5.6-terra': {
              class: 'strong_generalist',
            },
          },
        },
      }, null, 2), 'utf-8');
      clearConfigCache(repoDir);

      assert.throws(() => getOperatingModeResult(repoDir), /Repo-local model configuration removed/);
    });
  });
});
