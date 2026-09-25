import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { readEvalRecords } from './eval-persistence.ts';
import { SCHEMA_VERSION } from './eval-schema.ts';
import { callLLM, LLMQuotaError, parseJsonFromLLM } from './llm-cli.ts';
import { markExhausted, readQuotaSnapshot } from './quota-state.ts';

let tempRoot: string;
let repoDir: string;

function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; stderr: string }> {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, stderr: output }))
    .finally(() => {
      process.stderr.write = originalWrite;
    });
}

function captureStderrError(fn: () => Promise<unknown>): Promise<{ error: unknown; stderr: string }> {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  return Promise.resolve()
    .then(fn)
    .then(() => {
      throw new Error('Expected function to throw');
    })
    .catch((error) => ({ error, stderr: output }))
    .finally(() => {
      process.stderr.write = originalWrite;
    });
}

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

function createMockCli(
  name: string,
  behavior: Record<string, Array<Record<string, unknown>> | Record<string, unknown>>
): { cliPath: string; logPath: string } {
  const cliPath = join(tempRoot, `${name}.mjs`);
  const logPath = join(tempRoot, `${name}.log`);
  const statePath = join(tempRoot, `${name}.state.json`);
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const behavior = ${JSON.stringify(behavior)};
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : '(default)';
const stdinChunks = [];

function readState() {
  if (!existsSync(statePath)) {
    return {};
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state), 'utf-8');
}

function resolveAction() {
  const state = readState();
  const attempt = state[model] ?? 0;
  state[model] = attempt + 1;
  writeState(state);

  const configured = behavior[model] ?? behavior.default ?? { type: 'success', text: \`ok from \${model}\` };
  if (Array.isArray(configured)) {
    return configured[Math.min(attempt, configured.length - 1)];
  }
  return configured;
}

process.stdin.on('data', (chunk) => stdinChunks.push(chunk));
process.stdin.on('end', () => {
  const action = resolveAction();
  appendFileSync(logPath, JSON.stringify({ model, args, stdin: Buffer.concat(stdinChunks).toString('utf-8') }) + '\\n');

  if (action.type === 'success') {
    process.stdout.write(JSON.stringify({
      result: action.text,
      usage: action.usage,
      total_cost_usd: action.costUsd,
    }));
    process.exit(0);
  }

  if (action.type === 'sleep') {
    setTimeout(() => {
      process.stderr.write(String(action.message ?? 'slept'));
      process.exit(Number(action.code ?? 1));
    }, Number(action.ms ?? 1000));
    return;
  }

  process.stderr.write(String(action.message ?? 'error'));
  process.exit(Number(action.code ?? 1));
});

process.stdin.resume();
`;

  writeFileSync(cliPath, script, 'utf-8');
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

function readInvocations(logPath: string): Array<{ model: string }> {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { model: string });
}

function readFallbackRecords() {
  return readEvalRecords({ dir: join(repoDir, '.wavemill', 'evals') }).filter(
    (record) => record.agentType === 'llm-cli' && record.fallbackEvent,
  );
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `llm-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  repoDir = createRepoDir('repo');
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  if (existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('parseJsonFromLLM', () => {
  describe('valid JSON extraction', () => {
    it('parses a plain JSON object', () => {
      assert.deepEqual(parseJsonFromLLM('{ "score": 10 }'), { score: 10 });
    });

    it('parses JSON wrapped in markdown fences', () => {
      assert.deepEqual(parseJsonFromLLM('```json\n{ "score": 10 }\n```'), { score: 10 });
    });

    it('extracts JSON from mixed content', () => {
      assert.deepEqual(parseJsonFromLLM('Here is the result: { "score": 10 } done'), { score: 10 });
    });

    it('handles nested objects and arrays', () => {
      assert.deepEqual(parseJsonFromLLM('{ "outer": { "items": [1, 2, 3] } }'), {
        outer: { items: [1, 2, 3] },
      });
    });

    it('preserves escaped unicode characters', () => {
      assert.deepEqual(parseJsonFromLLM('{ "text": "hello \\u4e16\\u754c" }'), {
        text: 'hello \u4e16\u754c',
      });
    });

    it('allows JavaScript-looking text inside valid JSON strings', () => {
      assert.deepEqual(parseJsonFromLLM('{ "note": "Use => only in code examples" }'), {
        note: 'Use => only in code examples',
      });
    });

    it('allows assignment-looking text inside valid JSON strings', () => {
      assert.deepEqual(parseJsonFromLLM('{ "note": "const result = value" }'), {
        note: 'const result = value',
      });
    });
  });

  describe('JavaScript syntax detection', () => {
    it('rejects JavaScript destructuring syntax', () => {
      assert.throws(
        () => parseJsonFromLLM('{ datasetFile, ...rest }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects unquoted property names', () => {
      assert.throws(
        () => parseJsonFromLLM('{ winner: "primary", score: 10 }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects spread syntax', () => {
      assert.throws(
        () => parseJsonFromLLM('{ ...config, override: true }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects JavaScript variable assignments wrapping JSON', () => {
      assert.throws(
        () => parseJsonFromLLM('const result = { "score": 10 }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects arrow functions in invalid JSON candidates', () => {
      assert.throws(
        () => parseJsonFromLLM('{ "fn": () => 10 }'),
        /JavaScript code instead of JSON/
      );
    });
  });

  describe('error handling', () => {
    it('throws on an empty string', () => {
      assert.throws(() => parseJsonFromLLM(''), /Failed to parse JSON from LLM output/);
    });

    it('throws on text with no JSON object', () => {
      assert.throws(() => parseJsonFromLLM('not json at all'), /Failed to parse JSON from LLM output/);
    });

    it('includes a preview in generic parse errors', () => {
      assert.throws(
        () => parseJsonFromLLM('invalid { "broken": true'),
        /First 500 chars:\ninvalid \{ "broken": true/
      );
    });
  });
});

describe('quota fallback', () => {
  it('falls back to the next model, marks exhaustion, and returns the successful model', async () => {
    const { cliPath } = createMockCli('quota-to-success', {
      'model-a': { type: 'quota', message: 'Error: 429 rate_limit_exceeded', code: 1 },
      'model-b': { type: 'success', text: 'ok from b', costUsd: 0.12 },
    });

    const { result, stderr } = await captureStderr(() => callLLM('test prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      difficulty: 'hard',
      fallbackModels: ['model-a', 'model-b'],
    }));

    assert.match(stderr, /\[coder] model-a unavailable \(quota\); falling back to model-b/);
    assert.equal(result.text, 'ok from b');
    assert.equal(result.model, 'model-b');
    assert.deepEqual(result.fallbackChain, [{ model: 'model-a', reason: 'quota' }]);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['model-a']?.status, 'exhausted');
    assert.equal(snapshot.models['model-b']?.status, 'healthy');

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].schemaVersion, SCHEMA_VERSION);
    assert.equal(records[0].modelId, 'model-b');
    assert.equal(records[0].score, 1);
    assert.equal(records[0].fallbackEvent?.preferred_model, 'model-a');
    assert.equal(records[0].fallbackEvent?.fallback_model, 'model-b');
    assert.equal(records[0].fallbackEvent?.task_type, 'coding');
    assert.equal(records[0].fallbackEvent?.difficulty, 'hard');
    assert.equal(records[0].fallbackEvent?.outcome, 'success');
    assert.equal(records[0].fallbackEvent?.cost_usd, 0.12);
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [{ model: 'model-a', reason: 'quota' }]);
  });

  it('stays silent when an observer handles quota fallback telemetry', async () => {
    const { cliPath } = createMockCli('quota-observer', {
      'model-a': { type: 'quota', message: 'Error: 429 rate_limit_exceeded', code: 1 },
      'model-b': { type: 'success', text: 'ok from b' },
    });

    const fallbackEvents: Array<{ failedModel: string; nextModel?: string; reason?: string; resetAt?: string | null }> = [];
    const { result, stderr } = await captureStderr(() => callLLM('observer prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
      observer: {
        onQuotaFallback(event) {
          fallbackEvents.push(event);
          return Promise.resolve();
        },
      },
    }));

    assert.equal(stderr, '');
    assert.equal(result.model, 'model-b');
    assert.deepEqual(fallbackEvents, [{ failedModel: 'model-a', nextModel: 'model-b', reason: 'quota', resetAt: null }]);
  });

  it('throws LLMQuotaError when every candidate is exhausted', async () => {
    const { cliPath } = createMockCli('all-quota', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'quota', message: '429 quota exceeded', code: 1 },
    });

    const { error, stderr } = await captureStderrError(() => callLLM('all fail', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    }));

    assert.ok(error instanceof LLMQuotaError);
    assert.match((error as Error).message, /model-a/);
    assert.match((error as Error).message, /model-b/);

    assert.match(
      stderr,
      /\[coder] model-b unavailable \(quota\); no remaining fallback candidates after: model-a -> model-b/,
    );

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].modelId, 'model-a');
    assert.equal(records[0].score, 0);
    assert.equal(records[0].fallbackEvent?.outcome, 'all_exhausted');
    assert.equal(records[0].fallbackEvent?.fallback_model, null);
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [
      { model: 'model-a', reason: 'quota' },
      { model: 'model-b', reason: 'quota' },
    ]);
  });

  it('uses task-specific ladders from the global registry', async () => {
    const codingCli = createMockCli('coding-ladder', {
      'claude-opus-5-5': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'gpt-6-sol': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'claude-fable-5': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'gpt-5.6-terra': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'deepseek-v4-pro': { type: 'success', text: 'coding winner' },
    });
    const codingResult = await callLLM('coding prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: codingCli.cliPath,
      repoDir,
      taskType: 'coding',
    });
    assert.equal(codingResult.model, 'deepseek-v4-pro');

    repoDir = createRepoDir('planning-repo');
    clearConfigCache(repoDir);

    const planningCli = createMockCli('planning-ladder', {
      'claude-opus-5-5': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'gpt-6-sol': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'claude-fable-5': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'claude-opus-4-8': { type: 'success', text: 'planning winner' },
    });
    const planningResult = await callLLM('planning prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: planningCli.cliPath,
      repoDir,
      taskType: 'planning',
    });
    assert.equal(planningResult.model, 'claude-opus-4-8');
  });

  it('filters task ladders to models supported by the selected provider', async () => {
    // gpt-5.5 is not Claude-compatible. The resolver should skip it and use
    // the highest-ranked Claude-compatible planning model.
    const { cliPath, logPath } = createMockCli('provider-filter', {
      'gpt-5.5': { type: 'other', message: 'invalid model for claude cli', code: 1 },
      'gpt-6-sol': { type: 'other', message: 'invalid model for claude cli', code: 1 },
      'claude-opus-5-5': { type: 'success', text: 'opus 5.5 planning winner' },
      'claude-opus-4-8': { type: 'success', text: 'anthropic planning winner' },
    });

    const result = await callLLM('planning prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'planning',
    });

    assert.equal(result.model, 'claude-opus-5-5');
    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['claude-opus-5-5']);
  });

  it('excludes globally disabled models from explicit fallback candidates', async () => {
    // gpt-5.3-codex is permanently disabled in DISABLED_MODEL_IDS. Even when a
    // caller asks for it explicitly, the resolver should skip straight to the
    // next globally usable candidate.
    const { cliPath, logPath } = createMockCli('disabled-filter', {
      'gpt-5.3-codex': { type: 'other', message: 'codex access restricted', code: 1 },
      'claude-opus-4-8': { type: 'success', text: 'planning winner' },
    });

    const result = await callLLM('planning prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'planning',
      fallbackModels: ['gpt-5.3-codex', 'claude-opus-4-8'],
    });

    assert.equal(result.model, 'claude-opus-4-8');
    const invoked = readInvocations(logPath).map((entry) => entry.model);
    assert.ok(!invoked.includes('gpt-5.3-codex'), 'disabled model must not be invoked');
  });

  it('keeps DeepSeek Claude-compatible models in provider-filtered ladders', async () => {
    const { cliPath, logPath } = createMockCli('deepseek-provider-filter', {
      'claude-opus-5-5': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'gpt-6-sol': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'claude-fable-5': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'gpt-5.6-terra': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'deepseek-v4-pro': { type: 'success', text: 'deepseek coding winner' },
    });

    const result = await callLLM('coding prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
    });

    assert.equal(result.model, 'deepseek-v4-pro');
    assert.deepEqual(
      readInvocations(logPath).map((entry) => entry.model),
      ['claude-opus-5-5', 'claude-fable-5', 'deepseek-v4-pro'],
    );
  });

  it('persists an all_exhausted fallback event when later candidates fail for mixed reasons', async () => {
    const { cliPath } = createMockCli('quota-then-other-error', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'other', message: 'syntax explosion', code: 1 },
    });

    await assert.rejects(
      () => callLLM('mixed failure', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir,
        taskType: 'review',
        fallbackModels: ['model-a', 'model-b'],
      }),
      /All fallback candidates failed: model-a \(quota\), model-b \(other\)\. Last error:.*syntax explosion/s,
    );

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].score, 0);
    assert.equal(records[0].fallbackEvent?.outcome, 'all_exhausted');
    assert.equal(records[0].fallbackEvent?.task_type, 'review');
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [
      { model: 'model-a', reason: 'quota' },
      { model: 'model-b', reason: 'other' },
    ]);
  });

  it('advances past non-quota transient error on the first candidate', async () => {
    const { cliPath } = createMockCli('transient-to-success', {
      'model-a': { type: 'transient', message: 'socket hang up', code: 1 },
      'model-b': { type: 'success', text: 'ok from b' },
    });

    const { result, stderr } = await captureStderr(() => callLLM('transient fallback', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    }));

    assert.match(stderr, /\[coder] model-a unavailable \(transient\); falling back to model-b/);
    assert.equal(result.model, 'model-b');
    assert.deepEqual(result.fallbackChain, [{ model: 'model-a', reason: 'transient' }]);

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].fallbackEvent?.outcome, 'success');
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [{ model: 'model-a', reason: 'transient' }]);
  });

  it('throws a combined error when all candidates fail with retryable non-quota errors', async () => {
    const { cliPath } = createMockCli('all-non-quota', {
      'model-a': { type: 'other', message: 'cli crash', code: 1 },
      'model-b': { type: 'transient', message: '500 server_error temporarily unavailable', code: 1 },
    });

    const { error, stderr } = await captureStderrError(() => callLLM('all non quota', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    }));

    assert.ok(!(error instanceof LLMQuotaError));
    assert.match((error as Error).message, /model-a \(other\)/);
    assert.match((error as Error).message, /model-b \(transient\)/);
    assert.match((error as Error).message, /500 server_error temporarily unavailable/);
    assert.match(
      stderr,
      /\[coder] model-b unavailable \(transient\); no remaining fallback candidates after: model-a -> model-b/,
    );

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].fallbackEvent?.outcome, 'all_exhausted');
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [
      { model: 'model-a', reason: 'other' },
      { model: 'model-b', reason: 'transient' },
    ]);
  });

  it('fails fast on auth error without trying further candidates', async () => {
    const { cliPath, logPath } = createMockCli('auth-fast-fail', {
      'model-a': { type: 'other', message: '401 authentication_error invalid_api_key', code: 1 },
      'model-b': { type: 'success', text: 'should not run' },
    });

    await assert.rejects(
      () => callLLM('auth fail', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir,
        taskType: 'coding',
        fallbackModels: ['model-a', 'model-b'],
      }),
      /authentication_error|authentication failed/i,
    );

    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['model-a']);
    assert.deepEqual(readFallbackRecords(), []);
  });

  it('emits non_quota_error and fails fast on auth after a prior quota fallback', async () => {
    const { cliPath, logPath } = createMockCli('quota-then-auth', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'other', message: '401 authentication_error invalid_api_key', code: 1 },
      'model-c': { type: 'success', text: 'should not run' },
    });

    await assert.rejects(
      () => callLLM('quota then auth', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir,
        taskType: 'review',
        fallbackModels: ['model-a', 'model-b', 'model-c'],
      }),
      /authentication_error|authentication failed/i,
    );

    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['model-a', 'model-b']);

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].fallbackEvent?.outcome, 'non_quota_error');
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [{ model: 'model-a', reason: 'quota' }]);
  });

  it('does not persist fallback evals when logFallbackEvents is false', async () => {
    const { cliPath } = createMockCli('fallback-opt-out', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'success', text: 'ok from b' },
    });

    const result = await callLLM('opt-out prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
      logFallbackEvents: false,
    });

    assert.equal(result.model, 'model-b');
    assert.deepEqual(readFallbackRecords(), []);
  });

  it('stops the classifier ladder when its absolute deadline is spent', async () => {
    const { cliPath, logPath } = createMockCli('deadline-stop', {
      'model-a': { type: 'sleep', ms: 2_000, message: 'too slow', code: 1 },
      'model-b': { type: 'success', text: 'should not run' },
    });

    const { error } = await captureStderrError(() => callLLM('deadline prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'classify',
      fallbackModels: ['model-a', 'model-b'],
      fallbackDeadlineMs: Date.now() + 1_300,
      fallbackPerAttemptTimeoutMs: 900,
      fallbackDeadlineGraceMs: 100,
      logFallbackEvents: false,
    }));

    assert.match((error as Error).message, /LLM fallback deadline exhausted before model-[ab]/);
    assert.ok(!readInvocations(logPath).map((entry) => entry.model).includes('model-b'));
  });

  it('skips classifier candidates whose provider credential is missing', async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

      const { cliPath, logPath } = createMockCli('credential-skip', {
        'claude-haiku-4-5-20251001': { type: 'success', text: 'should not run' },
        'deepseek-v4-flash': { type: 'success', text: 'deepseek ok' },
      });

      const { result, stderr } = await captureStderr(() => callLLM('credential prompt', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir,
        taskType: 'classify',
        fallbackModels: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash'],
        fallbackDeadlineMs: Date.now() + 15_000,
        fallbackPerAttemptTimeoutMs: 10_000,
        logFallbackEvents: false,
      }));

      assert.match(stderr, /\[classifier] claude-haiku-4-5-20251001 skipped \(missing ANTHROPIC_API_KEY\)/);
      assert.equal(result.model, 'deepseek-v4-flash');
      assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['deepseek-v4-flash']);
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalDeepSeek;
    }
  });

  it('does not fall through to an unbudgeted classifier call when every credential is missing', async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const { cliPath, logPath } = createMockCli('credential-skip-empty', {
        default: { type: 'success', text: 'should not run' },
      });

      await assert.rejects(
        () => callLLM('credential prompt', {
          provider: 'claude',
          mode: 'stream',
          cliCmd: cliPath,
          repoDir,
          taskType: 'classify',
          fallbackModels: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash'],
          fallbackDeadlineMs: Date.now() + 5_000,
          fallbackPerAttemptTimeoutMs: 1_000,
          logFallbackEvents: false,
        }),
        /No eligible classify fallback candidates/,
      );

      assert.deepEqual(readInvocations(logPath), []);
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalDeepSeek;
    }
  });

  it('bypasses exponential backoff for quota fallbacks', async () => {
    const { cliPath } = createMockCli('quota-fast-fallback', {
      'model-a': { type: 'quota', message: '429 rate_limit_exceeded', code: 1 },
      'model-b': { type: 'success', text: 'fast fallback' },
    });

    const startedAt = Date.now();
    const result = await callLLM('timing prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      retry: true,
      maxRetries: 2,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.model, 'model-b');
    assert.ok(elapsedMs < 5500, `expected quota fallback without an added retry backoff, got ${elapsedMs}ms`);
  });

  it('treats DeepSeek 401 auth failures as non-quota and does not exhaust the model', async () => {
    const { cliPath } = createMockCli('deepseek-auth', {
      'deepseek-v4-pro': { type: 'other', message: '401 authentication_error invalid_api_key', code: 1 },
      'claude-sonnet-4-6': { type: 'success', text: 'should not be used' },
    });

    await assert.rejects(
      () => callLLM('auth prompt', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir,
        taskType: 'coding',
        fallbackModels: ['deepseek-v4-pro', 'claude-sonnet-4-6'],
      }),
      /authentication_error|authentication failed/i,
    );

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['deepseek-v4-pro']?.status, undefined);
    assert.deepEqual(readFallbackRecords(), []);
  });

  it('retries DeepSeek transient server errors without marking quota exhaustion', async () => {
    const { cliPath } = createMockCli('deepseek-server-error', {
      'deepseek-v4-pro': [
        { type: 'other', message: '500 server_error temporarily unavailable', code: 1 },
        { type: 'success', text: 'recovered from server error' },
      ],
    });

    const result = await callLLM('transient prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      retry: true,
      maxRetries: 1,
      taskType: 'coding',
      fallbackModels: ['deepseek-v4-pro'],
    });

    assert.equal(result.model, 'deepseek-v4-pro');
    const snapshot = readQuotaSnapshot(repoDir);
    assert.notEqual(snapshot.models['deepseek-v4-pro']?.status, 'exhausted');
  });

  it('keeps exponential backoff for transient errors on the same model', async () => {
    const { cliPath, logPath } = createMockCli('transient-retry', {
      'model-a': [
        { type: 'transient', message: 'socket hang up', code: 1 },
        { type: 'success', text: 'recovered' },
      ],
      'model-b': { type: 'success', text: 'should not run' },
    });

    const startedAt = Date.now();
    const result = await callLLM('retry prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      retry: true,
      maxRetries: 1,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.model, 'model-a');
    assert.ok(elapsedMs >= 1900, `expected retry backoff, got ${elapsedMs}ms`);
    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['model-a', 'model-a']);
  });

  it('preserves backward compatibility when fallback is not enabled', async () => {
    const { cliPath } = createMockCli('backward-compat', {
      default: { type: 'quota', message: '429 rate limit exceeded', code: 1 },
    });

    await assert.rejects(
      () => callLLM('legacy prompt', {
        provider: 'claude',
        mode: 'sync',
        cliCmd: cliPath,
        repoDir,
      }),
      /rate limit or quota exceeded/
    );

    assert.equal(existsSync(join(repoDir, '.wavemill', 'quota-state.json')), false);
  });

  it('skips models already marked exhausted before invoking the CLI', async () => {
    markExhausted({ modelId: 'model-a', reason: 'quota' }, repoDir);
    const { cliPath, logPath } = createMockCli('skip-exhausted', {
      'model-b': { type: 'success', text: 'started on b' },
    });

    const result = await callLLM('skip prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    });

    assert.equal(result.model, 'model-b');
    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['model-b']);
  });
});

// A mock `codex` CLI that emits the real `codex exec --json` JSONL event stream
// (codex-cli 0.139.0 shape) instead of Claude's single JSON envelope.
function createMockCodexCli(
  name: string,
  behavior: { messages?: string[]; usage?: Record<string, number>; extraLines?: string[] }
): { cliPath: string; logPath: string } {
  const cliPath = join(tempRoot, `${name}.mjs`);
  const logPath = join(tempRoot, `${name}.log`);
  const messages = behavior.messages ?? ['ok from codex'];
  const usage = behavior.usage ?? {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 10,
    reasoning_output_tokens: 5,
  };
  const extraLines = behavior.extraLines ?? [];
  const script = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdinChunks = [];
process.stdin.on('data', (c) => stdinChunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: Buffer.concat(stdinChunks).toString('utf-8') }) + '\\n');
  const lines = [];
  lines.push(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }));
  lines.push(JSON.stringify({ type: 'turn.started' }));
  for (const [i, text] of ${JSON.stringify(messages)}.entries()) {
    lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'item_' + i, type: 'agent_message', text } }));
  }
  for (const extra of ${JSON.stringify(extraLines)}) {
    lines.push(extra);
  }
  lines.push(JSON.stringify({ type: 'turn.completed', usage: ${JSON.stringify(usage)} }));
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
});
process.stdin.resume();
`;
  writeFileSync(cliPath, script, 'utf-8');
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

describe('codex provider', () => {
  it('extracts the agent message text and token usage from JSONL output', async () => {
    const { cliPath } = createMockCodexCli('codex-basic', {
      messages: ['PONG'],
      usage: { input_tokens: 16922, cached_input_tokens: 4992, output_tokens: 6, reasoning_output_tokens: 0 },
    });

    const result = await callLLM('ping', {
      provider: 'codex',
      mode: 'sync',
      cliCmd: cliPath,
      model: 'gpt-5.5',
      repoDir,
    });

    assert.equal(result.text, 'PONG');
    assert.equal(result.provider, 'codex');
    // input_tokens already includes cached; cached is not double-counted.
    assert.equal(result.usage?.inputTokens, 16922);
    // reasoning tokens are billed as output.
    assert.equal(result.usage?.outputTokens, 6);
    assert.equal(result.usage?.totalTokens, 16928);
    assert.equal(result.costUsd, undefined);
  });

  it('concatenates multiple agent_message items in order', async () => {
    const { cliPath } = createMockCodexCli('codex-multi', {
      messages: ['first part', 'second part'],
    });

    const result = await callLLM('multi', {
      provider: 'codex',
      mode: 'stream',
      cliCmd: cliPath,
      model: 'gpt-5.5',
      repoDir,
      stripToolCalls: false,
    });

    assert.equal(result.text, 'first part\nsecond part');
    assert.equal(result.usage?.outputTokens, 15);
  });

  it('passes the codex exec/--json/sandbox args and the prompt via stdin', async () => {
    const { cliPath, logPath } = createMockCodexCli('codex-args', { messages: ['done'] });

    await callLLM('the actual prompt', {
      provider: 'codex',
      mode: 'sync',
      cliCmd: cliPath,
      model: 'gpt-5.5',
      repoDir,
    });

    const [invocation] = readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(invocation.args.includes('exec'), 'expected `exec` subcommand');
    assert.ok(invocation.args.includes('--json'), 'expected `--json` flag');
    const sandboxIdx = invocation.args.indexOf('--sandbox');
    assert.equal(invocation.args[sandboxIdx + 1], 'read-only');
    assert.equal(invocation.stdin, 'the actual prompt');
  });

  it('ignores non-agent_message events and stray non-JSON lines', async () => {
    const { cliPath } = createMockCodexCli('codex-noise', {
      messages: ['real answer'],
      extraLines: [
        JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking...' } }),
        'not json at all',
      ],
    });

    const result = await callLLM('noise', {
      provider: 'codex',
      mode: 'sync',
      cliCmd: cliPath,
      model: 'gpt-5.5',
      repoDir,
    });

    assert.equal(result.text, 'real answer');
  });
});
