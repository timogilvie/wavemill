// ---------------------------------------------------------------------------
// HOK-3055 MCP proxy compatibility spike — deterministic, in-process suite.
//
// Every test drives the toy server through the wavemill-owned proxy adapter
// and asserts that:
//   - the provider-facing descriptor is one bounded shape;
//   - denials happen before the server is touched;
//   - discovery is lazy and cached;
//   - timeout, cancel, malformed, unknown-tool, and terminated-server errors
//     all become stable structured tool results;
//   - the returned result is capped, redacted, and tagged external-untrusted;
//   - the transcript projection reflects the same metadata.
//
// The suite never opens a socket, spawns a subprocess, or reads credentials.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { MockMcpServer } from './mock-mcp-server.ts';
import {
  MCP_PROXY_METADATA,
  MCP_PROXY_PARAMETERS,
  McpProxyAdapter,
  evaluateProxyPolicy,
  projectTranscriptEvents,
  registeredMcpProxyMetadata,
} from './mcp-adapter.ts';
import type { ToolMetadata } from '../../shared/lib/native-agent/tools/types.ts';

const WORKTREE = '/tmp/hok-3055-worktree';
const REGISTRY: readonly ToolMetadata[] = [MCP_PROXY_METADATA];

type Cleanup = () => Promise<void>;
const cleanups: Cleanup[] = [];

async function makeAdapter(opts?: {
  syntheticCatalogSize?: number;
  slowEchoDelayMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<{ server: MockMcpServer; adapter: McpProxyAdapter }> {
  const server = new MockMcpServer({
    syntheticCatalogSize: opts?.syntheticCatalogSize ?? 0,
    slowEchoDelayMs: opts?.slowEchoDelayMs ?? 25,
  });
  const adapter = new McpProxyAdapter({
    server,
    timeoutMs: opts?.timeoutMs ?? 200,
    maxOutputBytes: opts?.maxOutputBytes ?? 2048,
  });
  cleanups.push(async () => {
    await adapter.dispose();
  });
  return { server, adapter };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        // best-effort teardown
      }
    }
  }
});

describe('mcp_proxy provider surface stays bounded', () => {
  it('exposes a single bounded descriptor regardless of backing catalog size', async () => {
    const { adapter } = await makeAdapter({ syntheticCatalogSize: 128 });

    // Provider-facing metadata + schema are frozen constants — not derived
    // from the backing catalog. Adding tools cannot inflate the surface.
    assert.equal(MCP_PROXY_METADATA.family, 'mcp');
    assert.equal(MCP_PROXY_METADATA.exposure, 'opt-in');
    assert.deepEqual(MCP_PROXY_METADATA.allowedPhases, ['planning', 'coding', 'review']);
    assert.equal(
      (MCP_PROXY_PARAMETERS as { required: string[] }).required.length,
      2,
      'the model sees exactly two parameters no matter how many backing tools exist',
    );

    const backing = await adapter.listBackingTools();
    assert.ok(backing.length >= 128, 'backing catalog can grow independently');
  });
});

describe('lazy lifecycle and discovery', () => {
  it('starts the server on first allowed invoke and caches discovery', async () => {
    const { server, adapter } = await makeAdapter();

    assert.equal(server.counters.startCalls, 0);
    assert.equal(server.counters.discoverCalls, 0);

    const result = await adapter.invoke({
      tool_name: 'echo',
      arguments: { message: 'hello' },
    });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, 'echo:hello');

    // second call reuses the cached discovery
    await adapter.invoke({ tool_name: 'echo', arguments: { message: 'again' } });
    assert.equal(server.counters.startCalls, 1);
    assert.equal(server.counters.discoverCalls, 1);
    assert.equal(server.counters.invokeCalls, 2);
  });

  it('tears the server down on dispose', async () => {
    const { server, adapter } = await makeAdapter();
    await adapter.invoke({ tool_name: 'echo', arguments: { message: 'ok' } });
    assert.equal(server.isRunning(), true);
    await adapter.dispose();
    assert.equal(server.isRunning(), false);
    assert.equal(server.counters.stopCalls, 1);
  });
});

describe('policy gate short-circuits before the server is touched', () => {
  it('denies when the tool is not exposed to the phase', async () => {
    const { server } = await makeAdapter();
    const decision = evaluateProxyPolicy({
      phase: 'coding',
      worktreePath: WORKTREE,
      registry: REGISTRY,
      toolCall: { name: 'mcp_proxy', arguments: { tool_name: 'echo', arguments: {} } },
      eligibleNames: [],
      network: { target: 'none', allowlist: [] },
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.kind === 'deny' && decision.code, 'not_exposed');
    assert.equal(server.counters.startCalls, 0);
    assert.equal(server.counters.invokeCalls, 0);
  });

  it('denies phase when a read-only phase gets a mutation tool', async () => {
    const { server } = await makeAdapter();
    const decision = evaluateProxyPolicy({
      phase: 'planning',
      worktreePath: WORKTREE,
      registry: [
        { ...MCP_PROXY_METADATA, class: 'mutation', allowedPhases: ['coding'] },
      ],
      toolCall: { name: 'mcp_proxy', arguments: { tool_name: 'echo', arguments: {} } },
      eligibleNames: ['mcp_proxy'],
      network: { target: 'none', allowlist: [] },
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.kind === 'deny' && decision.code, 'phase_denied');
    assert.equal(server.counters.invokeCalls, 0);
  });

  it('denies path when a proxied argument references outside the worktree', async () => {
    const { server } = await makeAdapter();
    const decision = evaluateProxyPolicy({
      phase: 'coding',
      worktreePath: WORKTREE,
      registry: REGISTRY,
      toolCall: {
        name: 'mcp_proxy',
        arguments: { tool_name: 'echo', arguments: { path: '../../etc/passwd' } },
      },
      eligibleNames: ['mcp_proxy'],
      pathFieldsByTool: { mcp_proxy: ['path'] },
      network: { target: 'none', allowlist: [] },
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.kind === 'deny' && decision.code, 'path_denied');
    assert.equal(server.counters.startCalls, 0);
  });

  it('default-deny network refuses any target outside the allowlist', async () => {
    const { server } = await makeAdapter();
    const decision = evaluateProxyPolicy({
      phase: 'coding',
      worktreePath: WORKTREE,
      registry: REGISTRY,
      toolCall: { name: 'mcp_proxy', arguments: { tool_name: 'echo', arguments: {} } },
      eligibleNames: ['mcp_proxy'],
      network: { target: 'evil.example.com', allowlist: [] },
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.kind === 'deny' && decision.code, 'network_denied');
    assert.equal(server.counters.invokeCalls, 0);
  });

  it('allows only when phase, path, and network all pass', async () => {
    const decision = evaluateProxyPolicy({
      phase: 'coding',
      worktreePath: WORKTREE,
      registry: [
        { ...MCP_PROXY_METADATA, class: 'read-only', allowedPhases: ['coding'] },
      ],
      toolCall: { name: 'mcp_proxy', arguments: { tool_name: 'echo', arguments: {} } },
      eligibleNames: ['mcp_proxy'],
      pathFieldsByTool: { mcp_proxy: ['path'] },
      network: { target: 'none', allowlist: [] },
    });
    assert.equal(decision.kind, 'allow');
  });
});

describe('structured error conversion', () => {
  it('converts unknown tool names into a stable tool error', async () => {
    const { adapter } = await makeAdapter();
    const result = await adapter.invoke({
      tool_name: 'does_not_exist',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'unknown_tool');
  });

  it('converts a malformed backing payload into a stable tool error', async () => {
    const { adapter } = await makeAdapter();
    const result = await adapter.invoke({
      tool_name: 'malformed_result',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'malformed_result');
  });

  it('converts a timeout into a stable tool error and cleans up', async () => {
    const { server, adapter } = await makeAdapter({
      slowEchoDelayMs: 500,
      timeoutMs: 25,
    });
    const result = await adapter.invoke({
      tool_name: 'slow_echo',
      arguments: { message: 'never' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'timeout');
    // Server did receive the invoke — timeout is enforced by the proxy — but
    // it stays running for future calls.
    assert.equal(server.counters.invokeCalls, 1);
    assert.equal(server.isRunning(), true);
  });

  it('propagates external abort as an aborted error', async () => {
    const { adapter } = await makeAdapter({
      slowEchoDelayMs: 500,
      timeoutMs: 5_000,
    });
    const controller = new AbortController();
    const pending = adapter.invoke(
      { tool_name: 'slow_echo', arguments: { message: 'x' } },
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('user cancel')), 10);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'aborted');
  });

  it('converts a terminated server into a stable tool error', async () => {
    const { server, adapter } = await makeAdapter();
    await adapter.invoke({ tool_name: 'echo', arguments: { message: 'warm' } });
    await server.stop();
    const result = await adapter.invoke({
      tool_name: 'echo',
      arguments: { message: 'after stop' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'server_terminated');
  });

  it('rejects invalid arguments before touching the server', async () => {
    const { server, adapter } = await makeAdapter();
    const result = await adapter.invoke({ tool_name: '', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'invalid_arguments');
    assert.equal(server.counters.startCalls, 0);
  });
});

describe('result envelope: caps, redaction, provenance', () => {
  it('redacts secrets in the returned content and marks metadata', async () => {
    const { adapter } = await makeAdapter();
    const result = await adapter.invoke({
      tool_name: 'leak_secret',
      arguments: {},
    });
    assert.equal(result.isError, false);
    assert.ok(!result.content[0].text.includes('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'));
    assert.ok(result.metadata.redaction?.redacted, 'redaction metadata must record the hit');
    assert.ok((result.metadata.redaction?.matchCount ?? 0) >= 1);
  });

  it('caps large output and records the truncation in metadata', async () => {
    const { adapter } = await makeAdapter({ maxOutputBytes: 128 });
    const result = await adapter.invoke({
      tool_name: 'big_result',
      arguments: {},
    });
    assert.equal(result.isError, false);
    assert.equal(result.metadata.outputCap?.capped, true);
    assert.equal(result.metadata.outputCap?.strategy, 'truncate');
    assert.equal(result.content[0].text.length, 128);
  });

  it('always tags trust as external-untrusted', async () => {
    const { adapter } = await makeAdapter();
    const result = await adapter.invoke({
      tool_name: 'echo',
      arguments: { message: 'hi' },
    });
    assert.equal(result.metadata.trust?.trust, 'untrusted');
    // The registry inflation confirms the descriptor advertises this too.
    assert.equal(registeredMcpProxyMetadata().provenance, 'external-untrusted');
  });
});

describe('transcript projection', () => {
  it('emits tool_started and tool_result envelopes compatible with TranscriptWriter', async () => {
    const { adapter } = await makeAdapter();
    const args = { tool_name: 'echo', arguments: { message: 'trace' } };
    const result = await adapter.invoke(args);
    const [started, finished] = projectTranscriptEvents('call-1', args, result);
    assert.equal(started.type, 'tool_started');
    assert.equal(started.toolName, 'mcp_proxy');
    assert.deepEqual(started.args?.arguments, { message: 'trace' });
    assert.equal(finished.type, 'tool_result');
    assert.equal(finished.isError, false);
    assert.equal(finished.metadata?.trust?.trust, 'untrusted');
  });
});
