import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

function runSmoke(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['tools/smoke-deepseek.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      ...env,
    },
  });
}

describe('smoke-deepseek tool', () => {
  it('defaults to a dry-run that succeeds without DEEPSEEK_API_KEY', () => {
    const result = runSmoke([]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /dry-run: Dry-run validated DeepSeek launcher construction\./);
    assert.match(result.stdout, /live validation would skip cleanly/i);
  });

  it('emits valid JSON for dry-run mode', () => {
    const result = runSmoke(['--json']);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun.mode, 'dry-run');
    assert.equal(Array.isArray(parsed.dryRun.checks), true);
    assert.ok(parsed.dryRun.checks.some((check: { name: string }) => check.name === 'launcher.env.key_resolution'));
  });

  it('skips live smoke cleanly when the key is missing', () => {
    const result = runSmoke(['--live']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /live: DEEPSEEK_API_KEY is not set; skipping live DeepSeek smoke\./);
  });

  it('lets --no-live win when both flags are present', () => {
    const result = runSmoke(['--live', '--no-live']);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /^live:/m);
  });

  it('supports a stubbed live success path without leaking the API key', () => {
    const result = runSmoke(['--live'], {
      DEEPSEEK_API_KEY: 'deepseek-secret-value',
      WAVEMILL_DEEPSEEK_SMOKE_STUB: '1',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /live: Live DeepSeek smoke completed via stub\./);
    assert.ok(!result.stdout.includes('deepseek-secret-value'));
    assert.ok(!result.stderr.includes('deepseek-secret-value'));
  });
});
