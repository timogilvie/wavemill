import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { validateNativeOpenRouterConfig } from './native-openrouter-config-validation.ts';

function makeRepo(config: Record<string, unknown>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-openrouter-config-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2), 'utf-8');
  clearConfigCache(repoDir);
  return repoDir;
}

function cleanup(repoDir: string): void {
  clearConfigCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      },
    },
    ...overrides,
  };
}

describe('validateNativeOpenRouterConfig', () => {
  it('accepts equivalent Kimi/Qwen/GLM aliases and provider ids and returns launcher metadata', () => {
    const repoDir = makeRepo(baseConfig());
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'z-ai/glm-5.3',
        phase: 'planning',
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.blockers, []);
      assert.equal(result.identity?.wavemillAlias, 'glm-5.3');
      assert.equal(result.identity?.openrouterId, 'z-ai/glm-5.3');
      assert.equal(result.command?.agent, 'native-openrouter');
      assert.equal(result.command?.commandModel, 'z-ai/glm-5.3');
      assert.equal(result.command?.providerName, 'z-ai');
      assert.equal(result.command?.providerModel, 'glm-5.3');
    } finally {
      cleanup(repoDir);
    }
  });

  it('rejects unknown native OpenRouter models before launch', () => {
    const repoDir = makeRepo(baseConfig());
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'qwen/not-in-launch-priority',
        phase: 'coding',
      });

      assert.equal(result.ok, false);
      assert.equal(result.blockers[0]?.code, 'unknown-openrouter-model');
      assert.equal(result.blockers[0]?.surface, 'launch.model');
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports disabled provider with actionable config surface', () => {
    const repoDir = makeRepo(baseConfig({
      providers: {
        openrouter: {
          enabled: false,
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      },
    }));
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'glm-5.3',
        phase: 'planning',
      });

      assert.equal(result.ok, false);
      assert.equal(result.blockers[0]?.code, 'provider-disabled');
      assert.equal(result.blockers[0]?.surface, 'providers.openrouter.enabled');
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports global projection misses before launch', () => {
    const repoDir = makeRepo(baseConfig());
    try {
      // gemini-3.8-flash is coding-only, so it misses the planning projection
      // (qwen-2.5-coder-32b was retired by HOK-2947).
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'gemini-3.8-flash',
        phase: 'planning',
      });

      assert.equal(result.ok, false);
      const mismatch = result.blockers.find((blocker) => blocker.code === 'global-projection-missing');
      assert.ok(mismatch, 'expected a global projection blocker');
      assert.equal(mismatch?.surface, 'globalEffectiveModels.planning');
    } finally {
      cleanup(repoDir);
    }
  });

  it('accepts qwen-3-coder as a native planning projection candidate', () => {
    const repoDir = makeRepo(baseConfig());
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'qwen-3-coder',
        phase: 'planning',
      });

      assert.equal(result.blockers.some((blocker) => blocker.code === 'global-projection-missing'), false);
      assert.equal(result.identity?.wavemillAlias, 'qwen-3-coder');
      assert.equal(result.command?.openrouterId, 'qwen/qwen3-coder');
    } finally {
      cleanup(repoDir);
    }
  });
});
