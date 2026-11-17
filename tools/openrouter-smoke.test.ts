import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDryRunEntries,
  runOpenRouterSmokeCli,
  sanitizeSmokeDetail,
  selectSmokeEntries,
  WATCHLIST_SMOKE_MODELS,
} from './openrouter-smoke.ts';

async function runSmoke(args: string[], env: Record<string, string | undefined> = {}) {
  const originalLog = console.log;
  const originalEnv = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_LIVE_SMOKE: process.env.OPENROUTER_LIVE_SMOKE,
  };
  const stdout: string[] = [];
  console.log = (...values: unknown[]) => stdout.push(values.join(' '));
  process.env.OPENROUTER_API_KEY = '';
  process.env.OPENROUTER_LIVE_SMOKE = '';
  Object.assign(process.env, env);
  try {
    await runOpenRouterSmokeCli(args);
    return { status: 0, stdout: stdout.join('\n') };
  } finally {
    console.log = originalLog;
    if (originalEnv.OPENROUTER_API_KEY === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalEnv.OPENROUTER_API_KEY;
    }
    if (originalEnv.OPENROUTER_LIVE_SMOKE === undefined) {
      delete process.env.OPENROUTER_LIVE_SMOKE;
    } else {
      process.env.OPENROUTER_LIVE_SMOKE = originalEnv.OPENROUTER_LIVE_SMOKE;
    }
  }
}

describe('openrouter-smoke tool', () => {
  it('defaults to a dry-run that succeeds without environment configuration', async () => {
    const result = await runSmoke([]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^dry-run:/m);
    assert.doesNotMatch(result.stdout, /BLOCKER/);
  });

  it('emits machine-readable JSON output', async () => {
    const result = await runSmoke(['--json']);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(Array.isArray(parsed.reports), true);
    assert.equal(parsed.reports.length, createDryRunEntries().length);
    assert.equal(parsed.reports.some((report: { modelId: string }) => report.modelId.startsWith('gpt-')), false);
  });

  it('skips live runs cleanly when the env gate is missing', async () => {
    const result = await runSmoke(['--live']);

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /OPENROUTER_LIVE_SMOKE=1 and OPENROUTER_API_KEY are required/,
    );
  });

  it('filters dry-run smoke to requested models', async () => {
    const result = await runSmoke(['--models', 'glm-5.3', '--json']);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.reports.map((report: { modelId: string }) => report.modelId), ['glm-5.3']);
  });

  it('targets the HOK-2582 watchlist with an explicit dry-run flag', async () => {
    const result = await runSmoke(['--watchlist', '--json']);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(
      parsed.reports.map((report: { modelId: string }) => report.modelId),
      [...WATCHLIST_SMOKE_MODELS],
    );
  });

  it('sweeps current watchlist models and excludes retired aliases', () => {
    for (const model of ['minimax-m3.1-flash', 'glm-5.3-flashx', 'mistral-large-4']) {
      assert.ok(WATCHLIST_SMOKE_MODELS.includes(model), model);
    }
    for (const model of ['qwen-3-235b', 'kimi-k2-thinking', 'mistral-medium-3']) {
      assert.equal(WATCHLIST_SMOKE_MODELS.includes(model), false, model);
    }
  });

  it('filters entries by family and model id helpers', () => {
    const entries = createDryRunEntries();
    const qwen = selectSmokeEntries(entries, { families: ['qwen'] });
    assert.ok(qwen.length > 0);
    assert.ok(qwen.every((entry) => entry.family === 'qwen'));

    const glm = selectSmokeEntries(entries, { models: ['z-ai/glm-5.3'] });
    assert.deepEqual(glm.map((entry) => entry.wavemillAlias), ['glm-5.3']);
  });

  it('does not include OpenAI-hosted models in an OpenRouter smoke sweep', () => {
    const entries = createDryRunEntries();
    assert.equal(entries.some((entry) => entry.openrouterId.startsWith('openai/')), false);
    assert.throws(
      () => selectSmokeEntries(entries, { models: ['gpt-5.5'] }),
      /Unknown launch-priority model/,
    );
  });

  it('redacts OpenRouter management URLs from blocker details', () => {
    assert.equal(
      sanitizeSmokeDetail('visit https://openrouter.ai/workspaces/default/keys/abc123 and retry'),
      'visit [openrouter-url-redacted] and retry',
    );
  });
});
