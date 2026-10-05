import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import { writeOpenRouterCredits } from '../quota-state.ts';
import { filterOpenRouterByBalance } from './openrouter-balance-filter.ts';

let tempRoot: string;
let repoDir: string;

function git(command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function writeConfig(value: Record<string, unknown>): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
}

function writeBalance(balanceUsd: number): void {
  writeOpenRouterCredits(repoDir, {
    totalCredits: 10,
    totalUsage: 10 - balanceUsd,
    balanceUsd,
    usageDaily: 1,
    updatedAt: new Date().toISOString(),
    lastFetchError: null,
  });
}

describe('filterOpenRouterByBalance (HOK-3155)', () => {
  beforeEach(() => {
    tempRoot = join(tmpdir(), `openrouter-balance-filter-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    repoDir = join(tempRoot, 'repo');
    mkdirSync(repoDir, { recursive: true });
    git('init');
    git('config user.name "Test User"');
    git('config user.email "test@example.com"');
    writeFileSync(join(repoDir, 'README.md'), 'seed\n', 'utf-8');
    git('add README.md');
    git('commit -m "init"');
    delete process.env.OPENROUTER_API_KEY;
    clearConfigCache(repoDir);
  });

  afterEach(() => {
    clearConfigCache(repoDir);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns pool unchanged when no OpenRouter model is present', () => {
    const result = filterOpenRouterByBalance(
      ['claude-opus-4-7', 'claude-sonnet-5'],
      { repoDir },
    );
    assert.deepEqual(result.models, ['claude-opus-4-7', 'claude-sonnet-5']);
    assert.deepEqual(result.refusedModels, []);
    assert.equal(result.evaluation, null);
  });

  it('is a no-op on an empty pool', () => {
    const result = filterOpenRouterByBalance([], { repoDir });
    assert.deepEqual(result.models, []);
    assert.deepEqual(result.refusedModels, []);
    assert.equal(result.evaluation, null);
  });

  it('fails open with no cached snapshot (fail-open; launch guard is the backstop)', () => {
    const result = filterOpenRouterByBalance(
      ['claude-opus-4-7', 'qwen-3-coder'],
      { repoDir },
    );
    // No snapshot → evaluateOpenRouterBalance returns status=ok with balanceUsd=null.
    assert.deepEqual(result.models, ['claude-opus-4-7', 'qwen-3-coder']);
    assert.deepEqual(result.refusedModels, []);
    assert.ok(result.evaluation);
    assert.equal(result.evaluation?.balanceUsd, null);
  });

  it('leaves the pool unchanged when the balance is healthy', () => {
    writeConfig({
      nativeAgent: {
        providers: {
          openrouter: { minCreditsUsd: 0.02, warnCreditsUsd: 2 },
        },
      },
    });
    writeBalance(10);
    const result = filterOpenRouterByBalance(
      ['claude-opus-4-7', 'qwen-3-coder'],
      { repoDir },
    );
    assert.deepEqual(result.models, ['claude-opus-4-7', 'qwen-3-coder']);
    assert.deepEqual(result.refusedModels, []);
    assert.equal(result.evaluation?.status, 'ok');
  });

  it('drops every OpenRouter model when the balance is below minCreditsUsd', () => {
    writeConfig({
      nativeAgent: {
        providers: {
          openrouter: { minCreditsUsd: 0.02, warnCreditsUsd: 2 },
        },
      },
    });
    writeBalance(0.001);
    const result = filterOpenRouterByBalance(
      ['claude-opus-4-7', 'qwen-3-coder'],
      { repoDir },
    );
    assert.deepEqual(result.models, ['claude-opus-4-7']);
    assert.deepEqual(result.refusedModels, ['qwen-3-coder']);
    assert.equal(result.evaluation?.status, 'refuse');
    assert.equal(result.evaluation?.balanceUsd, 0.001);
  });

  it('drops OpenRouter models on a negative balance too', () => {
    writeConfig({
      nativeAgent: {
        providers: {
          openrouter: { minCreditsUsd: 0.02, warnCreditsUsd: 2 },
        },
      },
    });
    writeBalance(-0.16);
    const result = filterOpenRouterByBalance(
      ['qwen-3-coder'],
      { repoDir },
    );
    assert.deepEqual(result.models, []);
    assert.deepEqual(result.refusedModels, ['qwen-3-coder']);
    assert.equal(result.evaluation?.status, 'refuse');
  });
});
