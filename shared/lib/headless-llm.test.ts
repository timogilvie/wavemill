import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveProviderForModel } from './llm-cli.ts';
import { callHeadlessLLM } from './headless-llm.ts';

let tempRoot: string;

// Mock `claude` CLI: logs argv + stdin, emits a Claude JSON envelope.
function writeMockClaude(logPath: string): string {
  const cliPath = join(tempRoot, 'claude.mjs');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf-8') }) + '\\n');
  process.stdout.write(JSON.stringify({ result: 'CLAUDE_OK' }));
  process.exit(0);
});
process.stdin.resume();
`,
    'utf-8',
  );
  chmodSync(cliPath, 0o755);
  return cliPath;
}

// Mock `codex` CLI: logs argv + stdin, emits the codex exec --json JSONL stream.
function writeMockCodex(logPath: string): string {
  const cliPath = join(tempRoot, 'codex.mjs');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf-8') }) + '\\n');
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'CODEX_OK' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
});
process.stdin.resume();
`,
    'utf-8',
  );
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function readLog(logPath: string): Array<{ args: string[]; stdin: string }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `headless-llm-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.CLAUDE_CMD;
  delete process.env.CODEX_CMD;
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe('resolveProviderForModel', () => {
  it('routes registry OpenAI/gpt models to codex', () => {
    assert.equal(resolveProviderForModel('gpt-5.6-terra'), 'codex');
    assert.equal(resolveProviderForModel('gpt-5.4'), 'codex');
  });

  it('routes anthropic models to claude', () => {
    assert.equal(resolveProviderForModel('claude-sonnet-4-6'), 'claude');
  });

  it('falls back to claude for an undefined model', () => {
    assert.equal(resolveProviderForModel(undefined), 'claude');
  });

  it('uses a name heuristic for ids not in the registry', () => {
    assert.equal(resolveProviderForModel('gpt-6-experimental'), 'codex');
    assert.equal(resolveProviderForModel('o5-preview'), 'codex');
    assert.equal(resolveProviderForModel('some-random-model'), 'claude');
  });
});

describe('callHeadlessLLM', () => {
  it('routes a gpt-* model to codex and folds the system instruction into the prompt', async () => {
    const logPath = join(tempRoot, 'codex.log');
    process.env.CODEX_CMD = writeMockCodex(logPath);

    const result = await callHeadlessLLM('USER PROMPT', {
      mode: 'sync',
      model: 'gpt-5.6-terra',
      systemInstruction: 'OUTPUT ONLY JSON',
      noTools: true,
    });

    assert.equal(result.text, 'CODEX_OK');
    assert.equal(result.provider, 'codex');

    const [invocation] = readLog(logPath);
    assert.ok(invocation.args.includes('exec') && invocation.args.includes('--json'));
    // codex has no append-system-prompt flag → instruction is prepended to the prompt.
    assert.equal(invocation.stdin, 'OUTPUT ONLY JSON\n\nUSER PROMPT');
    assert.ok(!invocation.args.includes('--append-system-prompt'));
    assert.ok(!invocation.args.includes('--tools'));
  });

  it('routes a claude-* model to claude with --tools and --append-system-prompt flags', async () => {
    const logPath = join(tempRoot, 'claude.log');
    process.env.CLAUDE_CMD = writeMockClaude(logPath);

    // Stream mode (spawn) preserves empty-string args; this is the mode all the
    // noTools call sites use.
    const result = await callHeadlessLLM('USER PROMPT', {
      mode: 'stream',
      model: 'claude-sonnet-4-6',
      systemInstruction: 'OUTPUT ONLY JSON',
      noTools: true,
    });

    assert.equal(result.text, 'CLAUDE_OK');
    assert.equal(result.provider, 'claude');

    const [invocation] = readLog(logPath);
    const toolsIdx = invocation.args.indexOf('--tools');
    assert.ok(toolsIdx >= 0 && invocation.args[toolsIdx + 1] === '');
    const sysIdx = invocation.args.indexOf('--append-system-prompt');
    assert.ok(sysIdx >= 0 && invocation.args[sysIdx + 1] === 'OUTPUT ONLY JSON');
    // claude keeps the instruction as a system prompt, so the prompt stays clean.
    assert.equal(invocation.stdin, 'USER PROMPT');
  });

  it('defaults to the codex/gpt-5.6-terra headless model when none is given', async () => {
    const logPath = join(tempRoot, 'codex.log');
    process.env.CODEX_CMD = writeMockCodex(logPath);

    const result = await callHeadlessLLM('hi', { mode: 'sync' });

    assert.equal(result.provider, 'codex');
    const [invocation] = readLog(logPath);
    const modelIdx = invocation.args.indexOf('--model');
    assert.equal(invocation.args[modelIdx + 1], 'gpt-5.6-terra');
  });
});
