// ---------------------------------------------------------------------------
// HOK-3055 — Pi MCP proxy compatibility spike (deterministic, offline).
//
// Every fixture drives the Wavemill-owned McpProxySession against the toy
// stdio MCP server. No provider credentials, no network service, no pi /
// @modelcontextprotocol dependency. Run focused:
//
//   node --test spike/pi-native-agent/mcp-proxy-spike.test.ts
//
// Coverage maps 1:1 onto the acceptance criteria: discovery + one successful
// proxy call; bounded provider schema as tool count grows; phase, path, and
// network denials proven to occur before the server is reached; timeout/cancel;
// malformed result; secret redaction + output cap + provenance; and guaranteed
// server termination. A final case shows results represented with Wavemill
// transcript semantics.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';

import type { WavemillConfig } from '../../shared/lib/config.ts';
import type { NativeCertificationSnapshot } from '../../shared/lib/native-agent/tools/exposure.ts';
import { parseTranscriptJsonl, TranscriptWriter, type TranscriptToolResult } from '../../shared/lib/native-agent/transcript.ts';
import type { ToolPhase } from '../../shared/lib/native-agent/tools/types.ts';
import {
  MCP_CALL_PROVIDER_SCHEMA,
  McpProxySession,
  type McpDispatchResult,
  type McpProxySessionOptions,
} from './mcp-proxy-harness.ts';

const WORKTREE = '/tmp/wavemill-mcp-spike-worktree';
const CERTIFIED: NativeCertificationSnapshot = { maxCertifiedPhase: 'workflow' };

/** Config enabling the advanced `mcp` family for the given phases only. */
function configWithMcp(allowedPhases: ToolPhase[]): WavemillConfig {
  return { nativeAgent: { advanced: { mcp: { enabled: true, allowedPhases } } } } as WavemillConfig;
}

function newSession(overrides: Partial<McpProxySessionOptions> = {}): McpProxySession {
  return new McpProxySession({
    phase: 'coding',
    worktreePath: WORKTREE,
    config: configWithMcp(['coding']),
    certification: CERTIFIED,
    timeoutMs: 2_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1) Discovery + one successful proxy call.
// ---------------------------------------------------------------------------
test('discovers server tools and proxies one successful call', async () => {
  const session = newSession();
  after(() => session.terminate());

  const tools = await session.discover();
  assert.ok(tools.some((t) => t.name === 'echo'), 'discovery lists the echo tool');
  assert.equal(session.started, true, 'server started lazily on discovery');

  const outcome = await session.dispatch({ server: 'toy', tool: 'echo', arguments: { hello: 'world' } });
  assert.equal(outcome.denied, false);
  assert.equal(outcome.isError, false);
  assert.match(outcome.result.content[0].text, /hello/, 'echoed argument round-trips through the proxy');
  assert.equal(outcome.result.metadata?.trust?.trust, 'untrusted', 'external content is untrusted');
});

// ---------------------------------------------------------------------------
// 2) Provider-facing schema stays bounded as the discovered tool count grows.
// ---------------------------------------------------------------------------
test('provider schema is bounded regardless of discovered tool count', async () => {
  const small = newSession({ serverEnv: { TOY_MCP_TOOL_COUNT: '5' } });
  const large = newSession({ serverEnv: { TOY_MCP_TOOL_COUNT: '200' } });
  after(() => {
    small.terminate();
    large.terminate();
  });

  const smallTools = await small.discover();
  const largeTools = await large.discover();
  assert.equal(smallTools.length, 5);
  assert.equal(largeTools.length, 200);
  assert.ok(largeTools.length > smallTools.length, 'discovered catalog grows');

  // The provider-facing schema is byte-identical no matter how many tools exist.
  assert.deepEqual(small.providerSchema(), large.providerSchema());
  assert.equal(JSON.stringify(small.providerSchema()), JSON.stringify(MCP_CALL_PROVIDER_SCHEMA));
  const keys = Object.keys(MCP_CALL_PROVIDER_SCHEMA.properties);
  assert.deepEqual(keys, ['server', 'tool', 'arguments'], 'schema exposes only the fixed proxy shape');
});

// ---------------------------------------------------------------------------
// 3) Phase denial occurs before the server is reached.
// ---------------------------------------------------------------------------
test('phase denial short-circuits before the server starts', async () => {
  // mcp enabled for coding only; dispatch during planning.
  const session = newSession({ phase: 'planning', config: configWithMcp(['coding']) });
  after(() => session.terminate());

  const outcome = await session.dispatch({ server: 'toy', tool: 'echo', arguments: {} });
  assert.equal(outcome.denied, true);
  assert.match(outcome.denial?.reason ?? '', /phase/, 'denied for the wrong phase');
  assert.equal(session.started, false, 'server never started');
  assert.equal(session.dispatchedToServer, 0, 'no request reached the server');
});

// ---------------------------------------------------------------------------
// 4) Path denial occurs before the server is reached.
// ---------------------------------------------------------------------------
test('path denial short-circuits before the server starts', async () => {
  const session = newSession();
  after(() => session.terminate());

  const outcome = await session.dispatch({
    server: 'toy',
    tool: 'echo',
    arguments: { note: 'read the file' },
    path: '../../etc/passwd',
  });
  assert.equal(outcome.denied, true);
  assert.equal(outcome.denial?.category, 'path');
  assert.match(outcome.denial?.reason ?? '', /path_denied/);
  assert.equal(session.started, false, 'server never started');
  assert.equal(session.dispatchedToServer, 0);
});

// ---------------------------------------------------------------------------
// 5) Network denial is fail-closed and occurs before the server is reached.
// ---------------------------------------------------------------------------
test('network egress is denied fail-closed before the server starts', async () => {
  const session = newSession(); // default (empty) network policy
  after(() => session.terminate());

  const outcome = await session.dispatch({
    server: 'toy',
    tool: 'echo',
    arguments: {},
    target: 'https://exfil.example.com/rpc',
  });
  assert.equal(outcome.denied, true);
  assert.equal(outcome.denial?.category, 'network');
  assert.match(outcome.denial?.reason ?? '', /missing_policy/);
  assert.equal(session.started, false, 'server never started');
  assert.equal(session.dispatchedToServer, 0);
});

// ---------------------------------------------------------------------------
// 6) Timeout and cancellation become stable error results.
// ---------------------------------------------------------------------------
test('per-call timeout becomes a stable error result', async () => {
  const session = newSession({ timeoutMs: 100 });
  after(() => session.terminate());

  const outcome = await session.dispatch({ server: 'toy', tool: 'slow', arguments: { ms: 60_000 } });
  assert.equal(outcome.denied, false);
  assert.equal(outcome.isError, true);
  assert.match(outcome.result.content[0].text, /timeout/);
  assert.equal(session.dispatchedToServer, 1, 'the allowed call did reach the server');
});

test('AbortSignal cancellation becomes a stable error result', async () => {
  const session = newSession({ timeoutMs: 10_000 });
  after(() => session.terminate());

  const controller = new AbortController();
  const pending = session.dispatch({ server: 'toy', tool: 'slow', arguments: { ms: 60_000 } }, controller.signal);
  await delay(50);
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.isError, true);
  assert.match(outcome.result.content[0].text, /cancelled/);
});

// ---------------------------------------------------------------------------
// 7) Malformed server payloads become a stable error result.
// ---------------------------------------------------------------------------
test('malformed server payload becomes a stable error result', async () => {
  const session = newSession();
  after(() => session.terminate());

  const outcome = await session.dispatch({ server: 'toy', tool: 'emit_malformed', arguments: {} });
  assert.equal(outcome.isError, true);
  assert.match(outcome.result.content[0].text, /malformed/);
});

// ---------------------------------------------------------------------------
// 8) Secret redaction, output cap, and provenance on external content.
// ---------------------------------------------------------------------------
test('secret-bearing results are redacted, tagged, and fingerprinted', async () => {
  const session = newSession();
  after(() => session.terminate());

  const outcome = await session.dispatch({ server: 'toy', tool: 'emit_secret', arguments: {} });
  assert.equal(outcome.isError, false);
  const text = outcome.result.content[0].text;
  assert.doesNotMatch(text, /sk-abcdEFGH/, 'raw secret is not present');
  assert.match(text, /REDACTED/, 'secret is masked');
  assert.equal(outcome.result.metadata?.redaction?.redacted, true);
  assert.ok((outcome.result.metadata?.redaction?.matchCount ?? 0) > 0);
  assert.equal(outcome.result.metadata?.trust?.trust, 'untrusted');
  const details = outcome.result.details as { provenanceClass?: string; apiKey?: string };
  assert.equal(details.provenanceClass, 'external-untrusted', 'content tagged external-untrusted');
  assert.equal(details.apiKey, '[REDACTED]', 'secret-bearing detail key is redacted');
  assert.ok(outcome.result.metadata?.provenance?.argsFingerprint, 'provenance fingerprint present');
});

test('oversized results are capped to the configured byte ceiling', async () => {
  const session = newSession({ maxOutputBytes: 64 });
  after(() => session.terminate());

  const big = 'x'.repeat(500);
  const outcome = await session.dispatch({ server: 'toy', tool: 'echo', arguments: { big } });
  assert.equal(outcome.result.metadata?.outputCap?.capped, true);
  assert.equal(outcome.result.metadata?.outputCap?.limit, 64);
  assert.ok(Buffer.byteLength(outcome.result.content[0].text, 'utf8') <= 64);
});

// ---------------------------------------------------------------------------
// 9) The server is started lazily and always terminable.
// ---------------------------------------------------------------------------
test('server starts lazily and terminates cleanly', async () => {
  const session = newSession();
  assert.equal(session.started, false, 'not started before first dispatch');

  await session.dispatch({ server: 'toy', tool: 'echo', arguments: {} });
  assert.equal(session.started, true);
  const pid = session.serverPid;
  assert.ok(pid && pid > 0);

  session.terminate();
  assert.equal(session.started, false, 'terminate() clears the child');
  session.terminate(); // idempotent

  // The OS should reap the killed child; confirm it is gone.
  await delay(100);
  assert.throws(() => process.kill(pid as number, 0), /ESRCH/, 'child process was terminated');
});

// ---------------------------------------------------------------------------
// 10) Results are represented with Wavemill transcript semantics.
// ---------------------------------------------------------------------------
test('proxy results serialize as valid Wavemill transcript records', async () => {
  const session = newSession();
  const dir = mkdtempSync(join(tmpdir(), 'mcp-spike-transcript-'));
  const path = join(dir, 'native-session.jsonl');
  after(() => {
    session.terminate();
    rmSync(dir, { recursive: true, force: true });
  });

  const outcome = await session.dispatch({ server: 'toy', tool: 'emit_secret', arguments: {} });

  const writer = new TranscriptWriter({
    sessionId: 'mcp-spike',
    model: 'mock',
    api: 'mock',
    provider: 'mock',
    path,
    clock: () => 1,
  });
  writer.write(toTranscriptToolResult(outcome));

  const events = parseTranscriptJsonl(readFileSync(path, 'utf8'));
  assert.equal(events.length, 1);
  const event = events[0] as TranscriptToolResult;
  assert.equal(event.type, 'tool_result');
  assert.equal(event.toolName, 'mcp_call');
  assert.ok(event.metadata?.outputCap, 'transcript carries output-cap metadata');
  assert.ok(event.metadata?.provenance, 'transcript carries provenance metadata');
  assert.ok(event.metadata?.redaction, 'transcript carries redaction metadata');
  assert.equal(event.metadata?.trust?.trust, 'untrusted');
});

function toTranscriptToolResult(outcome: McpDispatchResult): TranscriptToolResult {
  return {
    seq: 1,
    sessionId: 'mcp-spike',
    timestamp: 1,
    type: 'tool_result',
    toolCallId: 'call_1',
    toolName: 'mcp_call',
    isError: outcome.isError,
    content: outcome.result.content[0]?.text ?? '',
    details: outcome.result.details,
    redacted: outcome.result.metadata?.redaction?.redacted ?? false,
    metadata: outcome.result.metadata,
  };
}
