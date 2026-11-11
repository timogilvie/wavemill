/**
 * Transport replays through `callLLM` (HOK-3460).
 *
 * One captured output shape per transport, fed through a mock CLI exactly as
 * the real CLI emits it. The assertions pin the `LLMCallResult` contract the
 * pre-HOK-3460 `callLLM` produced: text, usage, cost, CLI-reported model,
 * session ownership, and the thrown error text.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import { callLLM, LLMQuotaError, type LLMCallResult } from '../llm-cli.ts';
import { readOwnershipRows } from '../session-ownership.ts';
import { adapterForProvider, resolveModelAdapter } from './resolve-adapter.ts';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'transport-replay-'));
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  if (existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createRepoDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  execSync('git init -q && git config user.email test@example.com && git config user.name Test', {
    cwd: dir,
    stdio: 'ignore',
  });
  return dir;
}

/**
 * A mock CLI that logs its argv/stdin and writes `payloadJs` to stdout.
 * `payloadJs` is a JS expression evaluated with `sessionId` in scope, so a
 * replay can echo the `--session-id` the adapter minted, as the real CLI does.
 */
function createReplayCli(
  dir: string,
  name: string,
  payloadJs: string,
  options: { stderr?: string; exitCode?: number } = {},
): { cliPath: string; logPath: string } {
  const cliPath = join(dir, `${name}.mjs`);
  const logPath = join(dir, `${name}.log`);
  const script = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf-8') }) + '\\n');
  const sessionFlag = args.indexOf('--session-id');
  const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : undefined;
  const raw = (${payloadJs});
  const payload = typeof raw === 'function' ? raw(sessionId) : raw;
  process.stdout.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
  process.stderr.write(${JSON.stringify(options.stderr ?? '')});
  process.exit(${options.exitCode ?? 0});
});
process.stdin.resume();
`;
  writeFileSync(cliPath, script, 'utf-8');
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

function readInvocations(logPath: string): Array<{ args: string[]; stdin: string }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; stdin: string });
}

describe('Claude CLI transport replay (HOK-3460)', () => {
  // protects: the object envelope through callLLM keeps text/usage/cost/model.
  it('replays an object envelope into the same LLMCallResult', async () => {
    const dir = createRepoDir('claude-object');
    const featureDir = join(dir, 'features', 'replay');
    const { cliPath } = createReplayCli(dir, 'claude-object', `(sessionId) => ({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'replayed answer',
      ...(sessionId ? { session_id: sessionId } : {}),
      usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 40 },
      total_cost_usd: 0.00123,
      modelUsage: { 'claude-opus-5-5': { outputTokens: 40 } },
    })`);

    const result = await callLLM('replay prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      model: 'claude-opus-5-5',
      repoDir: dir,
      featureDir,
      helperPurpose: 'transport-replay',
    });

    assert.equal(result.text, 'replayed answer');
    assert.equal(result.provider, 'claude');
    assert.equal(result.model, 'claude-opus-5-5');
    // input_tokens + cache_read_input_tokens; cache_read is not output.
    assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 40, totalTokens: 190 });
    assert.equal(result.costUsd, 0.00123);
    assert.equal(result.reportedModel, 'claude-opus-5-5');
    assert.equal(result.rawOutput.length > 0, true);

    // Session ownership: the adapter minted the id and recorded the row.
    assert.ok(result.sessionRef);
    const rows = readOwnershipRows(featureDir);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].sessionRef, rows[0].harness, rows[0].kind], [
      result.sessionRef,
      'claude-code',
      'helper:transport-replay',
    ]);
  });

  // protects: the verbose array envelope (--verbose review output) through callLLM.
  it('replays a verbose array envelope into the same LLMCallResult', async () => {
    const dir = createRepoDir('claude-verbose');
    const { cliPath } = createReplayCli(dir, 'claude-verbose', `(sessionId) => ([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', content: [{ type: 'text', text: 'intermediate' }] },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'verbose answer',
        ...(sessionId ? { session_id: sessionId } : {}),
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.002,
        modelUsage: { 'claude-sonnet-5': { outputTokens: 3 } },
      },
    ])`);

    const result = await callLLM('verbose prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      model: 'claude-opus-5-5',
      repoDir: dir,
      cliFlags: ['--verbose'],
    });

    assert.equal(result.text, 'verbose answer');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    assert.equal(result.costUsd, 0.002);
    assert.equal(result.reportedModel, 'claude-sonnet-5');
    assert.equal(result.sessionRef, undefined);
  });

  // protects: the is_error envelope keeps its historic thrown message.
  it('throws the historic is_error message', async () => {
    const dir = createRepoDir('claude-is-error');
    const { cliPath } = createReplayCli(
      dir,
      'claude-is-error',
      `({ type: 'result', is_error: true, error: 'upstream overloaded' })`,
    );

    await assert.rejects(
      () => callLLM('p', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        model: 'claude-opus-5-5',
        repoDir: dir,
      }),
      /claude CLI returned is_error: upstream overloaded/,
    );
  });

  // protects: the exit-1 envelope keeps its historic thrown message.
  it('throws the historic exit-code message', async () => {
    const dir = createRepoDir('claude-exit-1');
    const { cliPath } = createReplayCli(
      dir,
      'claude-exit-1',
      `({ type: 'result', result: 'partial' })`,
      { stderr: 'boom', exitCode: 1 },
    );

    await assert.rejects(
      () => callLLM('p', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        model: 'claude-opus-5-5',
        repoDir: dir,
      }),
      /claude CLI exited with code 1: stdout=.*"result":"partial".*; stderr=boom/,
    );
  });
});

describe('Codex CLI transport replay (HOK-3460)', () => {
  const CODEX_STREAM = [
    JSON.stringify({ type: 'thread.started', thread_id: 't-replay-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'first part' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'second part' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 16922, cached_input_tokens: 4992, output_tokens: 6, reasoning_output_tokens: 4 },
    }),
  ].join('\n') + '\n';

  // protects: the HOK-3409 seam — one usage mapping, unchanged semantics.
  it('replays a codex exec --json stream into the same LLMCallResult', async () => {
    const dir = createRepoDir('codex-stream');
    const featureDir = join(dir, 'features', 'replay');
    const { cliPath } = createReplayCli(dir, 'codex-stream', JSON.stringify(CODEX_STREAM));

    const result = await callLLM('codex prompt', {
      provider: 'codex',
      mode: 'stream',
      cliCmd: cliPath,
      model: 'gpt-5.5',
      repoDir: dir,
      featureDir,
      helperPurpose: 'transport-replay',
    });

    assert.equal(result.text, 'first part\nsecond part');
    assert.equal(result.provider, 'codex');
    // input_tokens is inclusive (cache is a subset); reasoning is billed output.
    assert.deepEqual(result.usage, { inputTokens: 16922, outputTokens: 10, totalTokens: 16932 });
    assert.equal(result.reportedModel, undefined);
    assert.equal(result.costUsd, undefined);

    const rows = readOwnershipRows(featureDir);
    assert.deepEqual(rows.map((row) => [row.sessionRef, row.harness, row.kind]), [
      ['t-replay-1', 'codex', 'helper:transport-replay'],
    ]);
  });

  // protects: the codex char-cap rejection keeps its actionable diagnostic.
  it('replays the char-cap rejection from stderr', async () => {
    const dir = createRepoDir('codex-cap');
    const { cliPath } = createReplayCli(dir, 'codex-cap', `''`, {
      stderr: 'Error: Input exceeds the maximum length of 1048576 characters (actual_chars: 2809877)',
      exitCode: 1,
    });

    await assert.rejects(
      () => callLLM('p', {
        provider: 'codex',
        mode: 'stream',
        cliCmd: cliPath,
        model: 'gpt-5.5',
        repoDir: dir,
      }),
      /codex CLI exited with code 1.*Input exceeds the maximum length/,
    );
  });

  // protects: a 429 from codex stays quota-classified in a fallback ladder.
  it('replays a 429 as a quota failure', async () => {
    const dir = createRepoDir('codex-429');
    const { cliPath } = createReplayCli(dir, 'codex-429', `''`, {
      stderr: 'HTTP 429 rate_limit_exceeded',
      exitCode: 1,
    });

    await assert.rejects(
      () => callLLM('p', {
        provider: 'codex',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir: dir,
        fallbackModels: ['gpt-5.5'],
      }),
      (error: unknown) => {
        assert.ok(error instanceof LLMQuotaError, 'a 429 must exhaust the candidate as quota');
        assert.equal(error.reason, 'quota');
        assert.match(error.message, /gpt-5\.5/);
        return true;
      },
    );
  });
});

describe('Mode parity (HOK-3460)', () => {
  const ENVELOPE = `({
    type: 'result',
    is_error: false,
    result: 'same answer',
    usage: { input_tokens: 5, output_tokens: 2 },
    total_cost_usd: 0.0005,
    modelUsage: { 'claude-opus-5-5': { outputTokens: 2 } },
  })`;

  // protects: sync and stream return one LLMCallResult, with the observer firing in both.
  it('returns an equal result and fires start/complete under sync and stream', async () => {
    const dir = createRepoDir('parity');
    const sync = createReplayCli(dir, 'parity-sync', ENVELOPE);
    const stream = createReplayCli(dir, 'parity-stream', ENVELOPE);

    const events: Record<string, string[]> = { sync: [], stream: [] };
    const run = (mode: 'sync' | 'stream', cliCmd: string) => callLLM('parity prompt', {
      provider: 'claude',
      mode,
      cliCmd,
      model: 'claude-opus-5-5',
      repoDir: dir,
      observer: {
        onAttemptStart: () => { events[mode].push('start'); },
        onAttemptComplete: () => { events[mode].push('complete'); },
      },
    });

    const syncResult = await run('sync', sync.cliPath);
    const streamResult = await run('stream', stream.cliPath);

    assert.deepEqual(syncResult, streamResult);
    assert.deepEqual(events, {
      sync: ['start', 'complete'],
      stream: ['start', 'complete'],
    });
  });
});

describe('OpenRouter transport replay (HOK-3460)', () => {
  const OPENROUTER_MODEL = 'kimi-k2'; // nativeProvider: openrouter, vendor: moonshotai

  // protects: an OpenRouter model is skipped from a CLI ladder, never spawned.
  it('skips an OpenRouter-vendored id from a claude ladder with no spawn', async () => {
    const dir = createRepoDir('openrouter-ladder');
    const { cliPath, logPath } = createReplayCli(
      dir,
      'claude-openrouter',
      `(sessionId) => ({ type: 'result', is_error: false, result: 'served by claude', ...(sessionId ? { session_id: sessionId } : {}) })`,
    );

    // The claude CLI's servable vendor depends on ANTHROPIC_BASE_URL; pin it
    // to the default (Anthropic) so the ladder outcome is deterministic.
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    let result: LLMCallResult;
    try {
      result = await callLLM('openrouter prompt', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir: dir,
        fallbackModels: [OPENROUTER_MODEL, 'claude-opus-5-5'],
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }

    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(result.text, 'served by claude');
    const invoked = readInvocations(logPath);
    assert.equal(invoked.length, 1);
    assert.ok(!invoked.some((entry) => entry.args.includes(OPENROUTER_MODEL)));
  });

  // protects: the skip reason is the adapter's vendor-compatibility statement.
  it('names the transport and vendor when skipping it', () => {
    const dir = createRepoDir('openrouter-reason');
    const reason = adapterForProvider('claude', { model: OPENROUTER_MODEL, repoDir: dir })
      .incompatibilityReason(OPENROUTER_MODEL);
    assert.equal(reason, 'transport claude-cli cannot serve vendor moonshotai');
  });

  // protects: a native OpenRouter model still resolves to its native adapter,
  // whose invoke refuses transport-level dispatch.
  it('resolves the id to native-openrouter, whose invoke throws', async () => {
    const resolved = resolveModelAdapter({
      model: OPENROUTER_MODEL,
      phase: 'planning',
      // Freeze certification freshness so the replay does not depend on the
      // checked-in artifact TTL.
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    assert.equal(resolved.resolution.ok, true);
    assert.equal(resolved.adapter?.kind, 'native-openrouter');
    await assert.rejects(
      () => resolved.adapter!.invoke('p'),
      /no transport-level invoke/,
    );
  });
});
