import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { runWavemillLoop } from './loop.ts';
import { createRecordingProvider } from './fixtures/recording-provider.ts';
import {
  getPayloadCaptureDir,
  listCapturedPayloadFiles,
  PayloadRingBuffer,
  snapshotPayloadsForFailure,
  type CapturedPayloadRecord,
} from './payload-capture.ts';

const MODEL = { id: 'capture-model', provider: 'capture-fake', api: 'openai-completions' };
const FIXTURE_SECRET = 'fixture-secret-0f3c9a7e51';

let featureDir: string;

beforeEach(() => {
  featureDir = mkdtempSync(join(tmpdir(), 'payload-capture-'));
});

afterEach(() => {
  rmSync(featureDir, { recursive: true, force: true });
});

function reply(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

function readRecords(dir = getPayloadCaptureDir(featureDir, 'coding')): CapturedPayloadRecord[] {
  return listCapturedPayloadFiles(dir).map((file) => JSON.parse(readFileSync(file, 'utf-8')) as CapturedPayloadRecord);
}

function captureTurns(ring: PayloadRingBuffer, count: number, body: (turn: number) => unknown): void {
  for (let turn = 0; turn < count; turn++) {
    ring.recordRequest(body(turn), MODEL);
    ring.recordResponse(reply(`reply ${turn}`));
  }
}

describe('PayloadRingBuffer', () => {
  it('keeps only the newest maxFiles request bodies', () => {
    const ring = new PayloadRingBuffer({ featureDir, stage: 'coding' });
    captureTurns(ring, 10, (turn) => ({ messages: [{ role: 'user', content: `turn ${turn}` }] }));

    const records = readRecords();
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.turnIndex), [7, 8, 9]);
    assert.deepEqual(records[2].payload, { messages: [{ role: 'user', content: 'turn 9' }] });
    assert.equal(records[2].stopReason, 'stop');
    assert.equal(records[2].usage?.cacheRead, 4);
    assert.equal(records[2].requestModel, MODEL.id);
  });

  it('drops the oldest bodies once the directory passes the byte cap', () => {
    const ring = new PayloadRingBuffer({ featureDir, stage: 'coding', maxFiles: 10, maxBytes: 3_000 });
    captureTurns(ring, 5, (turn) => ({ turn, filler: 'f'.repeat(600) }));

    const dir = getPayloadCaptureDir(featureDir, 'coding');
    const files = listCapturedPayloadFiles(dir);
    const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
    assert.ok(files.length < 5, `expected eviction, kept ${files.length}`);
    assert.ok(totalBytes <= 3_000, `directory holds ${totalBytes} bytes`);
    assert.equal(readRecords().at(-1)?.turnIndex, 4, 'the newest body is kept');
  });

  it('keeps the newest body even when it alone exceeds the byte cap', () => {
    const ring = new PayloadRingBuffer({ featureDir, stage: 'coding', maxBytes: 100 });
    captureTurns(ring, 3, (turn) => ({ turn, filler: 'f'.repeat(1_000) }));

    assert.deepEqual(readRecords().map((record) => record.turnIndex), [2]);
  });

  it('never writes a secret from the environment or a secret-shaped string', () => {
    const ring = new PayloadRingBuffer({
      featureDir,
      stage: 'coding',
      env: { OPENROUTER_API_KEY: FIXTURE_SECRET },
    });
    captureTurns(ring, 1, () => ({
      messages: [
        { role: 'system', content: `key is ${FIXTURE_SECRET}` },
        { role: 'tool', content: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123' },
      ],
      tools: [{ function: { name: 'kv_get', parameters: { properties: { key: { type: 'string' } } } } }],
    }));

    const raw = readFileSync(listCapturedPayloadFiles(getPayloadCaptureDir(featureDir, 'coding'))[0], 'utf-8');
    assert.ok(!raw.includes(FIXTURE_SECRET), 'env secret value leaked');
    assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'secret pattern leaked');
    const payload = readRecords()[0].payload as { tools: Array<{ function: { parameters: unknown } }>; messages: unknown[] };
    // Tool schemas are kept verbatim: a `key` property is not a secret.
    assert.deepEqual(payload.tools[0].function.parameters, { properties: { key: { type: 'string' } } });
    assert.equal(payload.messages.length, 2);
  });

  it('records a request whose response never arrived', () => {
    const ring = new PayloadRingBuffer({ featureDir, stage: 'coding' });
    ring.recordRequest({ n: 1 }, MODEL);
    ring.flushPending();

    const [record] = readRecords();
    assert.equal(record.stopReason, 'no-response');
    assert.equal(record.responseModel, null);
  });

  it('never throws when the capture directory cannot be written', () => {
    const blocker = join(featureDir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const ring = new PayloadRingBuffer({ featureDir: blocker, stage: 'coding' });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => { warnings.push(message); };
    try {
      assert.doesNotThrow(() => captureTurns(ring, 2, () => ({ n: 1 })));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /native payload capture: failed to write coding payload/);
  });
});

describe('snapshotPayloadsForFailure', () => {
  it('returns undefined when nothing was captured', () => {
    assert.equal(snapshotPayloadsForFailure(featureDir, 'review', join(featureDir, 'evidence')), undefined);
  });

  it('copies the ring so it survives removal of the feature dir, replacing an earlier snapshot', () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'payload-evidence-'));
    const destDir = join(evidenceRoot, 'session.native-payloads');
    try {
      const ring = new PayloadRingBuffer({ featureDir, stage: 'review' });
      captureTurns(ring, 2, (turn) => ({ turn }));
      assert.equal(snapshotPayloadsForFailure(featureDir, 'review', destDir), destDir);
      captureTurns(ring, 3, (turn) => ({ turn: turn + 2 }));
      snapshotPayloadsForFailure(featureDir, 'review', destDir);

      rmSync(featureDir, { recursive: true, force: true });
      const records = readRecords(destDir);
      assert.equal(records.length, 3);
      assert.deepEqual(records.map((record) => record.payload), [{ turn: 2 }, { turn: 3 }, { turn: 4 }]);
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe('runWavemillLoop payload capture', () => {
  const tool = {
    name: 'read_note',
    description: 'Read a note',
    label: 'read_note',
    executionMode: 'sequential',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    async execute(): Promise<AgentToolResult<void>> {
      return { content: [{ type: 'text', text: 'note body' }], details: undefined as void };
    },
  } as unknown as AgentTool<any, void>;

  async function runCaptured(turns: Parameters<typeof createRecordingProvider>[0], env?: Record<string, string>) {
    const provider = createRecordingProvider(turns);
    const result = await runWavemillLoop({
      model: { id: MODEL.id, api: MODEL.api, provider: MODEL.provider, maxTokens: 512 },
      context: {
        systemPrompt: `You are a capture test. Token: ${FIXTURE_SECRET}`,
        messages: [{ role: 'user', content: 'Go.', timestamp: 0 }],
        tools: [tool],
      },
      convertToLlm: (messages) => messages as unknown as Message[],
      streamFn: provider.streamFn,
      providerErrorRetry: { maxAttempts: 0 },
      payloadCapture: { featureDir, stage: 'coding', ...(env ? { env } : {}) },
    });
    return { result, requests: provider.requests };
  }

  it('keeps the last three bodies exactly as sent, with usage, stop reason and reported model', async () => {
    const { result, requests } = await runCaptured([
      ...Array.from({ length: 4 }, (_, turn) => ({
        toolCalls: [{ id: `call_${turn}`, name: 'read_note', arguments: { id: String(turn) } }],
      })),
      { text: 'Done.', responseModel: 'capture-model-2026-10-01', usage: { prompt_tokens: 40, completion_tokens: 3, cached_tokens: 30 } },
    ]);
    assert.equal(result.stopReason, 'stop');
    assert.equal(requests.length, 5);

    const records = readRecords();
    assert.deepEqual(records.map((record) => record.turnIndex), [2, 3, 4]);
    assert.deepEqual(records.map((record) => record.payload), requests.slice(2).map((request) => JSON.parse(request.body)));
    assert.deepEqual(records.map((record) => record.stopReason), ['toolUse', 'toolUse', 'stop']);
    const last = records[2];
    assert.equal(last.responseModel, 'capture-model-2026-10-01');
    assert.equal(last.responseId, 'chatcmpl-recording-4');
    assert.equal(last.usage?.cacheRead, 30);
  });

  it('records a failed request with its error stop reason', async () => {
    await runCaptured(() => {
      throw new Error('upstream exploded');
    });

    const [record] = readRecords();
    assert.equal(record.stopReason, 'error');
    // The OpenAI SDK reports a rejected fetch as a connection error.
    assert.match(record.errorMessage ?? '', /Connection error/);
    assert.equal(record.turnIndex, 0);
  });

  it('never writes an environment secret that reached the request', async () => {
    const { requests } = await runCaptured([{ text: 'Done.' }], { OPENROUTER_API_KEY: FIXTURE_SECRET });
    assert.ok(requests[0].body.includes(FIXTURE_SECRET), 'precondition: the secret was on the wire');

    const dir = getPayloadCaptureDir(featureDir, 'coding');
    for (const file of readdirSync(dir)) {
      assert.ok(!readFileSync(join(dir, file), 'utf-8').includes(FIXTURE_SECRET), `${file} leaked the secret`);
    }
  });

  it('leaves nothing behind once the feature dir is reaped', async () => {
    await runCaptured([{ text: 'Done.' }]);
    assert.equal(readRecords().length, 1);

    rmSync(featureDir, { recursive: true, force: true });
    assert.equal(existsSync(getPayloadCaptureDir(featureDir, 'coding')), false);
  });
});
