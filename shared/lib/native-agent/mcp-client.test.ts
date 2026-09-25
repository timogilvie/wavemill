import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createMcpClient } from './mcp-client.ts';
import { FAKE_SECRET_LITERAL } from './fixtures/mcp/scenarios.ts';
import type { NativeAgentMcpFamilyConfig } from '../config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCK_SERVER_PATH = resolve(__dirname, 'fixtures/mcp/mock-server.ts');

function buildFamily(scenario: string, overrides: Record<string, unknown> = {}): NativeAgentMcpFamilyConfig {
  return {
    enabled: true,
    allowedPhases: ['coding'],
    defaults: {
      startupTimeoutMs: 2000,
      callTimeoutMs: 1000,
      shutdownTimeoutMs: 500,
      maxOutputBytes: 8192,
      failureThreshold: 3,
    },
    servers: {
      mock: {
        providerProxy: 'pi-mcp-proxy',
        command: process.execPath,
        args: ['--import', 'tsx', MOCK_SERVER_PATH, '--scenario', scenario],
        envAllowlist: [],
        tools: ['echo', 'noop'],
        class: 'read-only',
        ...overrides,
      },
    },
  };
}

describe('createMcpClient', () => {
  it('starts a server, returns identity, and stops it cleanly', async () => {
    const client = createMcpClient({ family: buildFamily('success') });
    const handle = await client.ensureStarted('mock');
    assert.equal(handle.serverName, 'mock');
    assert.equal(handle.identity.name, 'mock');
    assert.ok(typeof handle.identity.version === 'string' && handle.identity.version.length > 0);
    const snap = client.snapshot();
    assert.equal(snap.servers[0]?.started, true);
    await client.stopAll('test');
    assert.equal(client.snapshot().servers[0]?.started, false);
  });

  it('bounds startup with startupTimeoutMs when the server never replies to initialize', async () => {
    const client = createMcpClient({
      family: buildFamily('crash-on-init', { startupTimeoutMs: 200 }),
    });
    let failure: unknown = null;
    try {
      await client.ensureStarted('mock');
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, 'expected startup failure');
    assert.equal((failure as { kind: string }).kind, 'startup_timeout');
    const snap = client.snapshot();
    assert.equal(snap.servers[0]?.started, false);
    await client.stopAll('test');
  });

  it('returns success outcomes with raw bytes for later artifact storage', async () => {
    const client = createMcpClient({ family: buildFamily('success') });
    try {
      const outcome = await client.callTool('mock', 'echo', { msg: 'hi' }, {
        timeoutMs: 2000,
        maxOutputBytes: 8192,
      });
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        assert.ok(outcome.rawBytes.byteLength > 0);
        const payload = outcome.payload as { content: Array<{ type: string; text: string }> };
        assert.equal(payload.content[0].type, 'text');
        assert.ok(payload.content[0].text.includes('hi'));
      }
    } finally {
      await client.stopAll('test');
    }
  });

  it('normalizes call timeouts and keeps the server alive on a single failure', async () => {
    const client = createMcpClient({
      family: buildFamily('slow'),
    });
    try {
      const outcome = await client.callTool('mock', 'echo', {}, {
        timeoutMs: 20,
        maxOutputBytes: 8192,
      });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.kind, 'timeout');
      }
      assert.equal(client.snapshot().servers[0]?.consecutiveFailures, 1);
    } finally {
      await client.stopAll('test');
    }
  });

  it('detects server crashes mid-call and reports server_crashed', async () => {
    const client = createMcpClient({ family: buildFamily('crash-mid-call') });
    try {
      const outcome = await client.callTool('mock', 'echo', {}, {
        timeoutMs: 2000,
        maxOutputBytes: 8192,
      });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.kind, 'server_crashed');
      }
    } finally {
      await client.stopAll('test');
    }
  });

  it('rejects payloads exceeding maxOutputBytes without returning raw bytes', async () => {
    const client = createMcpClient({ family: buildFamily('oversize') });
    try {
      const outcome = await client.callTool('mock', 'echo', {}, {
        timeoutMs: 2000,
        maxOutputBytes: 256,
      });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.kind, 'over_output_cap');
        assert.ok(!outcome.message.includes('xxxx'.repeat(64)));
      }
    } finally {
      await client.stopAll('test');
    }
  });

  it('redacts secret-like stderr lines instead of surfacing them verbatim', async () => {
    const stderrLines: string[] = [];
    const client = createMcpClient({
      family: buildFamily('secret-leaker'),
      logStderr: (_server, line) => stderrLines.push(line),
    });
    try {
      const outcome = await client.callTool('mock', 'echo', {}, {
        timeoutMs: 2000,
        maxOutputBytes: 8192,
      });
      assert.equal(outcome.ok, true);
      // Give stderr a moment to flush.
      await new Promise((r) => setTimeout(r, 50));
      const joined = stderrLines.join('\n');
      assert.ok(!joined.includes(FAKE_SECRET_LITERAL), `stderr must not contain raw secret: ${joined}`);
      assert.ok(joined.includes('[REDACTED'), `stderr should carry a redaction marker: ${joined}`);
    } finally {
      await client.stopAll('test');
    }
  });

  it('is idempotent under repeated stopAll calls', async () => {
    const client = createMcpClient({ family: buildFamily('success') });
    await client.ensureStarted('mock');
    await client.stopAll('first');
    await client.stopAll('second');
    assert.equal(client.snapshot().servers[0]?.started, false);
  });

  it('cascades AbortSignal cancellation into an in-flight call', async () => {
    const client = createMcpClient({
      family: buildFamily('slow', { callTimeoutMs: 5000 }),
    });
    const controller = new AbortController();
    try {
      // Warm up the child so the abort races against the tools/call, not the
      // tsx startup path.
      await client.ensureStarted('mock');
      const pending = client.callTool('mock', 'echo', {}, {
        signal: controller.signal,
        timeoutMs: 5000,
        maxOutputBytes: 8192,
      });
      setTimeout(() => controller.abort(), 20);
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.kind, 'cancelled');
      }
    } finally {
      await client.stopAll('test');
    }
  });

  it('rejects calls to servers that were never configured', async () => {
    const client = createMcpClient({ family: buildFamily('success') });
    const outcome = await client.callTool('does-not-exist', 'echo', {}, {
      timeoutMs: 1000,
      maxOutputBytes: 8192,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.kind, 'server_not_allowed');
    }
    await client.stopAll('test');
  });

  it('rejects tool names outside the per-server allowlist', async () => {
    const client = createMcpClient({ family: buildFamily('success') });
    const outcome = await client.callTool('mock', 'delete_everything', {}, {
      timeoutMs: 1000,
      maxOutputBytes: 8192,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.kind, 'tool_not_allowed');
    }
    await client.stopAll('test');
  });
});
