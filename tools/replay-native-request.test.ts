import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CapturedPayloadRecord } from '../shared/lib/native-agent/payload-capture.ts';
import { applyJqPatch, ReplayInputError } from '../shared/lib/native-agent/request-replay.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolPath = join(repoRoot, 'tools', 'replay-native-request.ts');
const fixtureDir = join(repoRoot, 'shared', 'lib', 'native-agent', 'fixtures', 'payload-capture');
const capturePath = join(fixtureDir, 'review-tool-call.payload.json');
const capture = JSON.parse(readFileSync(capturePath, 'utf-8')) as CapturedPayloadRecord;
const recordedStream = JSON.parse(readFileSync(join(fixtureDir, 'review-tool-call.sse.json'), 'utf-8')) as unknown[];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], baseUrl: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', toolPath, ...args, '--base-url', baseUrl],
      { cwd: repoRoot, env: { ...process.env, OPENROUTER_API_KEY: 'fixture-key' } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

describe('replay-native-request', () => {
  let server: Server;
  let baseUrl: string;
  let received: Array<Record<string, unknown>> = [];

  before(async () => {
    // Stands in for the provider: records the body and answers with the
    // response stream recorded alongside the capture.
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        received.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of recordedStream) {
          response.write(event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    received = [];
  });

  it('resends the captured body unchanged and reproduces the recorded reply shape', async () => {
    const result = await runCli([capturePath], baseUrl);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], capture.payload);

    const reply = JSON.parse(result.stdout);
    assert.equal(reply.stopReason, capture.stopReason);
    assert.equal(reply.responseModel, capture.responseModel);
    assert.equal(reply.responseId, capture.responseId);
    assert.equal(reply.usage.input, capture.usage?.input);
    assert.equal(reply.usage.output, capture.usage?.output);
    assert.deepEqual(reply.content, [{ type: 'toolCall', name: 'read_file', arguments: { path: 'src/index.ts' } }]);
    assert.equal(reply.patched, false);
  });

  it('applies --patch to the body before sending it', async () => {
    const result = await runCli([capturePath, '--patch', '.messages[1].content = "Review only src/index.ts."'], baseUrl);
    assert.equal(result.code, 0, result.stderr);

    const sentMessages = received[0].messages as Array<{ content: string }>;
    assert.equal(sentMessages[1].content, 'Review only src/index.ts.');
    assert.equal(sentMessages[0].content, (capture.payload as { messages: Array<{ content: string }> }).messages[0].content);
    assert.equal(JSON.parse(result.stdout).patched, true);
  });

  it('exits 2 without sending anything on an invalid jq expression', async () => {
    const result = await runCli([capturePath, '--patch', 'this is not jq'], baseUrl);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /jq rejected --patch/);
    assert.equal(received.length, 0);
  });

  it('exits 2 on a file that is not a payload capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-native-request-'));
    try {
      const bogus = join(dir, 'bogus.json');
      writeFileSync(bogus, '{"messages": []}');
      const result = await runCli([bogus], baseUrl);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /is not a native payload capture/);
      assert.equal(received.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyJqPatch', () => {
  it('rejects an expression that does not yield one object', () => {
    assert.throws(() => applyJqPatch({ a: 1 }, '.a'), ReplayInputError);
    assert.throws(() => applyJqPatch({ a: [1, 2] }, '.a[]'), /exactly one JSON value/);
  });
});
