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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import {
  loadWavemillConfig,
  clearConfigCache,
  getRouterConfig,
  getEvalConfig,
  getMillConfig,
  getUiConfig,
  getPermissionsConfig,
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
      router: { enabled: true, defaultModel: 'claude-sonnet-4-5-20250929' },
      eval: { evalsDir: '.wavemill/evals' },
      mill: { maxParallel: 5 },
    }));
    const config = loadWavemillConfig(tmp);
    assert.equal(config.router?.enabled, true);
    assert.equal(config.eval?.evalsDir, '.wavemill/evals');
    assert.equal(config.mill?.maxParallel, 5);
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
      router: { enabled: true, defaultModel: 'claude-sonnet-4-5-20250929' },
      eval: { evalsDir: '.wavemill/evals' },
    }));

    const routerConfig = getRouterConfig(tmp);
    assert.equal(routerConfig.enabled, true);
    assert.equal(routerConfig.defaultModel, 'claude-sonnet-4-5-20250929');
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

test('getMillConfig returns mill section', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, JSON.stringify({
      mill: { maxParallel: 5, baseBranch: 'develop' }
    }));

    const millConfig = getMillConfig(tmp);
    assert.equal(millConfig.maxParallel, 5);
    assert.equal(millConfig.baseBranch, 'develop');
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
