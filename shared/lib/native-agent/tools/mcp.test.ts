import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeMcpArgumentsDigest, createMcpToolDescriptors, type McpArtifactRef } from './mcp.ts';
import type { McpCallOutcome, McpClient, McpClientSnapshot } from '../mcp-client.ts';
import type { WavemillConfig } from '../../config.ts';
import { withDefaultMetadata } from './types.ts';
import { computeEligibility } from './exposure.ts';
import { evaluateBeforeToolCallPolicy } from './policies.ts';
import { INJECTION_EXCERPT } from '../fixtures/mcp/scenarios.ts';

interface FakeInvocation {
  serverName: string;
  toolName: string;
  args: unknown;
  timeoutMs: number;
  maxOutputBytes: number;
}

function makeFakeClient(scripted: Record<string, () => McpCallOutcome>): {
  client: McpClient;
  calls: FakeInvocation[];
} {
  const calls: FakeInvocation[] = [];
  const client: McpClient = {
    async ensureStarted(serverName) {
      return { serverName, identity: { name: serverName, version: '1.2.3' }, pid: 42 };
    },
    async callTool(serverName, toolName, args, opts) {
      calls.push({
        serverName,
        toolName,
        args,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
      });
      const responder = scripted[`${serverName}/${toolName}`];
      if (!responder) {
        return { ok: false, kind: 'tool_not_allowed', message: `no fake for ${serverName}/${toolName}` };
      }
      return responder();
    },
    async stopServer() {},
    async stopAll() {},
    snapshot(): McpClientSnapshot {
      return {
        servers: [
          {
            serverName: 'mock',
            started: true,
            identity: { name: 'mock', version: '1.2.3' },
            pid: 42,
            consecutiveFailures: 0,
          },
        ],
      };
    },
  };
  return { client, calls };
}

function baseConfig(): WavemillConfig {
  return {
    nativeAgent: {
      advanced: {
        mcp: {
          enabled: true,
          allowedPhases: ['coding'],
          defaults: { callTimeoutMs: 4000, maxOutputBytes: 8192 },
          servers: {
            mock: {
              providerProxy: 'pi-mcp-proxy',
              command: 'node',
              args: [],
              envAllowlist: [],
              tools: ['echo', 'noop'],
              class: 'read-only',
            },
            other: {
              providerProxy: 'pi-mcp-proxy',
              command: 'node',
              args: [],
              envAllowlist: [],
              tools: ['ping'],
              class: 'read-only',
            },
          },
        },
      },
    },
  } as WavemillConfig;
}

describe('createMcpToolDescriptors', () => {
  it('returns zero descriptors when the family is disabled', () => {
    const { client } = makeFakeClient({});
    const config = baseConfig();
    config.nativeAgent!.advanced!.mcp!.enabled = false;
    const descriptors = createMcpToolDescriptors({ config, client });
    assert.equal(descriptors.length, 0);
  });

  it('emits one descriptor per (server, tool) pair in deterministic order', () => {
    const { client } = makeFakeClient({});
    const descriptors = createMcpToolDescriptors({ config: baseConfig(), client });
    const names = descriptors.map((d) => d.metadata.name);
    assert.deepEqual(names, ['mcp__mock__echo', 'mcp__mock__noop', 'mcp__other__ping']);
    for (const descriptor of descriptors) {
      assert.equal(descriptor.metadata.family, 'mcp');
      assert.equal(descriptor.metadata.provenance, 'external-untrusted');
      assert.equal(descriptor.metadata.exposure, 'opt-in');
      assert.equal(descriptor.metadata.certificationRequirement, 'workflow');
      assert.equal(descriptor.metadata.policy?.network, 'allowlisted');
      assert.equal(descriptor.metadata.policy?.pathMode, 'none');
      assert.equal(descriptor.metadata.policy?.redactionProfile, 'secrets');
    }
  });

  it('blocks a denied logical id before any client dispatch happens', async () => {
    const scripted: Record<string, () => McpCallOutcome> = {
      'mock/echo': () => ({ ok: true, payload: {}, rawBytes: new Uint8Array() }),
    };
    const { client, calls } = makeFakeClient(scripted);
    const config = baseConfig();
    // Restrict the exposure to a tool other than echo.
    config.nativeAgent!.advanced!.mcp!.logicalIds = ['mcp.mock.noop'];
    const descriptors = createMcpToolDescriptors({ config, client }).map((d) => ({
      ...d,
      metadata: withDefaultMetadata(d.metadata),
    }));
    const eligibility = computeEligibility({
      phase: 'coding',
      config,
      certification: { maxCertifiedPhase: 'workflow' },
      registry: descriptors.map((d) => d.metadata),
    });
    assert.ok(!eligibility.eligibleNames.includes('mcp__mock__echo'));

    const denial = evaluateBeforeToolCallPolicy({
      phase: 'coding',
      config: { eligibleNames: eligibility.eligibleNames },
      worktreePath: '/tmp/mcp-test',
      registry: descriptors.map((d) => d.metadata),
      toolCall: { name: 'mcp__mock__echo', arguments: {} },
    });
    assert.equal(denial.kind, 'deny');
    if (denial.kind === 'deny') {
      assert.equal(denial.reason, 'not_exposed');
    }
    // Never dispatched.
    assert.equal(calls.length, 0);
  });

  it('threads argsFingerprint, provenance, and mcp metadata on success', async () => {
    const rawBytes = new TextEncoder().encode('{"content":[{"type":"text","text":"echo"}]}');
    const scripted: Record<string, () => McpCallOutcome> = {
      'mock/echo': () => ({
        ok: true,
        payload: { content: [{ type: 'text', text: 'echo' }] },
        rawBytes,
      }),
    };
    const { client } = makeFakeClient(scripted);
    let storedBytes: Uint8Array | null = null;
    const storeArtifact = (bytes: Uint8Array): McpArtifactRef => {
      storedBytes = bytes;
      return { digest: 'deadbeef', byteSize: bytes.byteLength, path: 'artifacts/deadbeef' };
    };
    const descriptors = createMcpToolDescriptors({
      config: baseConfig(),
      client,
      storeArtifact,
    });
    const echo = descriptors.find((d) => d.metadata.name === 'mcp__mock__echo');
    assert.ok(echo);
    const result = await echo!.execute('call-1', { arguments: { msg: 'hi' } });
    assert.ok(result.metadata?.mcp);
    const mcpMeta = result.metadata!.mcp!;
    assert.equal(mcpMeta.providerProxy, 'pi-mcp-proxy');
    assert.equal(mcpMeta.logicalServer, 'mock');
    assert.equal(mcpMeta.logicalTool, 'echo');
    assert.equal(mcpMeta.serverIdentity.name, 'mock');
    assert.match(mcpMeta.argsFingerprint, /^[0-9a-f]{16}$/);
    assert.equal(mcpMeta.resultArtifactRef?.digest, 'deadbeef');
    assert.equal(storedBytes, rawBytes);
    assert.equal(result.metadata!.trust?.sourceKind, 'mcp_result');
    assert.equal(result.metadata!.trust?.trust, 'untrusted');
  });

  it('surfaces a normalized error and no artifact on failure', async () => {
    const scripted: Record<string, () => McpCallOutcome> = {
      'mock/echo': () => ({
        ok: false,
        kind: 'timeout',
        message: 'boom',
      }),
    };
    const { client } = makeFakeClient(scripted);
    let stored = 0;
    const descriptors = createMcpToolDescriptors({
      config: baseConfig(),
      client,
      storeArtifact: () => {
        stored += 1;
        return { digest: 'x', byteSize: 0, path: 'artifacts/x' };
      },
    });
    const echo = descriptors.find((d) => d.metadata.name === 'mcp__mock__echo');
    assert.ok(echo);
    const result = await echo!.execute('call-2', { arguments: { msg: 'hi' } });
    assert.equal(stored, 0);
    const detail = result.details as { ok: boolean; errorKind?: string };
    assert.equal(detail.ok, false);
    assert.equal(detail.errorKind, 'timeout');
    // No leaked argument values in the visible text.
    const summaryText = result.content.map((c) => c.text).join('\n');
    assert.ok(!summaryText.includes('hi'));
  });

  it('records the full SHA-256 argumentsDigest alongside the short fingerprint (REQ-F4)', async () => {
    const { client } = makeFakeClient({
      'mock/echo': () => ({ ok: true, payload: { content: [] }, rawBytes: new Uint8Array() }),
    });
    const echo = createMcpToolDescriptors({ config: baseConfig(), client })
      .find((d) => d.metadata.name === 'mcp__mock__echo')!;
    const result = await echo.execute('call', { arguments: { b: 2, a: 1 } });
    const digest = computeMcpArgumentsDigest({ a: 1, b: 2 });
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(result.metadata?.mcp?.argumentsDigest, digest, 'digest is key-order independent');
    assert.equal(result.metadata?.mcp?.argsFingerprint, digest.slice(0, 16));
    assert.ok(!JSON.stringify(result).includes('"a":1'), 'raw arguments never appear in the result');
  });

  it('truncates an over-cap result to the cap and flags it instead of failing (REQ-F5)', async () => {
    const big = 'x'.repeat(20_000);
    const rawBytes = new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: big }] }));
    const cap = 8192;
    const { client } = makeFakeClient({
      'mock/echo': () => ({
        ok: true,
        payload: { content: [{ type: 'text', text: big }] },
        rawBytes: rawBytes.slice(0, cap),
        truncated: true,
        originalByteSize: rawBytes.byteLength,
      }),
    });
    const echo = createMcpToolDescriptors({
      config: baseConfig(),
      client,
      storeArtifact: (bytes) => ({ digest: 'trunc', byteSize: bytes.byteLength, path: 'artifacts/trunc' }),
    }).find((d) => d.metadata.name === 'mcp__mock__echo')!;
    assert.equal(echo.metadata.outputCapPolicy.strategy, 'truncate');
    const result = await echo.execute('call', { arguments: {} });
    const visibleBytes = new TextEncoder().encode(
      result.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    ).byteLength;
    assert.ok(visibleBytes <= cap, `visible content ${visibleBytes} must fit the ${cap}-byte cap`);
    const last = result.content[result.content.length - 1];
    assert.ok(last.type === 'text' && last.text.startsWith('[mcp result truncated to'), 'truncation marker present');
    assert.equal(result.metadata?.mcp?.truncated, true);
    assert.equal(result.metadata?.mcp?.resultArtifactRef?.truncated, true);
    assert.equal(result.metadata?.mcp?.resultArtifactRef?.originalByteSize, rawBytes.byteLength);
    assert.equal(result.metadata?.mcp?.resultArtifactRef?.byteSize, cap);
    assert.equal(result.metadata?.trust?.sourceKind, 'mcp_result');
  });

  it('flags prompt-injection excerpts in payload text via mcp_result trust', async () => {
    const scripted: Record<string, () => McpCallOutcome> = {
      'mock/echo': () => ({
        ok: true,
        payload: { content: [{ type: 'text', text: INJECTION_EXCERPT }] },
        rawBytes: new Uint8Array(),
      }),
    };
    const { client } = makeFakeClient(scripted);
    const descriptors = createMcpToolDescriptors({ config: baseConfig(), client });
    const echo = descriptors.find((d) => d.metadata.name === 'mcp__mock__echo');
    assert.ok(echo);
    const result = await echo!.execute('call-3', { arguments: {} });
    const detail = result.details as { ok: boolean };
    assert.equal(detail.ok, true);
    // Trust metadata on the descriptor result should be `untrusted` (mcp_result
    // routes there). Injection scan is invoked by the loop over the returned
    // content/details — the descriptor pre-runs it so tests can pin the wiring
    // without booting the loop.
    assert.equal(result.metadata!.trust?.sourceKind, 'mcp_result');
    assert.equal(result.metadata!.trust?.trust, 'untrusted');
    const diagnostics = result.metadata!.trust?.diagnostics ?? [];
    assert.ok(diagnostics.length > 0, 'expected at least one injection diagnostic');
  });
});
