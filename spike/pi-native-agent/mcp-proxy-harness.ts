// ---------------------------------------------------------------------------
// Wavemill-owned MCP proxy harness — HOK-3055 compatibility spike.
//
// This is the seam the spike evaluates: can an MCP proxy (pi-mcp-adapter or an
// equivalent) sit behind Wavemill's policy and provenance boundary WITHOUT
// loading every MCP tool schema into every provider turn?
//
// The answer this harness demonstrates in code:
//   * The provider sees ONE fixed `mcp_call` proxy schema ({server,tool,
//     arguments}), independent of how many tools the server discovers.
//   * Wavemill — not the adapter, not the MCP server — is the authorization
//     point. Phase/exposure, path, and a fail-closed network decision all run
//     BEFORE the server is started or reached.
//   * Server tool schemas are discovered only after dispatch and cached inside
//     the session; they never become provider-facing tools.
//   * Every result is redacted, output-capped, provenance-fingerprinted, and
//     tagged `external-untrusted`, using the same Wavemill primitives the
//     native loop uses.
//   * The server is started lazily and always terminated in a finally path.
//
// It reuses the real Wavemill modules rather than reimplementing them:
//   - tools/exposure.ts      -> default-off `nativeAgent.advanced.mcp` gate
//   - tools/policies.ts      -> phase + worktree-path denial
//   - tools/redaction.ts     -> secret redaction (content + details)
//   - provenance.ts          -> untrusted-source trust metadata
//   - tools/types.ts         -> descriptor + result metadata shapes
// The network decision mirrors network-policy.ts's fail-closed contract
// (missing rule -> deny) with an mcp-scoped rule map, since the shared
// evaluator is typed to the fixed WorkflowToolName union.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WavemillConfig } from '../../shared/lib/config.ts';
import { computeEligibility, type NativeCertificationSnapshot } from '../../shared/lib/native-agent/tools/exposure.ts';
import {
  evaluateBeforeToolCallPolicy,
  type ToolPolicyReason,
} from '../../shared/lib/native-agent/tools/policies.ts';
import { buildTrustMetadata } from '../../shared/lib/native-agent/provenance.ts';
import { redactSecrets, redactSecretsInValue } from '../../shared/lib/native-agent/tools/redaction.ts';
import { inflateToolMetadata } from '../../shared/lib/native-agent/tools/registry.ts';
import type {
  RegisteredToolMetadata,
  ToolOutputCapMetadata,
  ToolPhase,
  ToolProvenanceClass,
  ToolResultMetadata,
  WavemillToolResult,
} from '../../shared/lib/native-agent/tools/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOY_SERVER = resolve(HERE, 'mcp-toy-server.mjs');

// ---------------------------------------------------------------------------
// The single, bounded provider-facing proxy schema.
//
// This is the ONLY tool the model ever sees for MCP. Discovered server tools
// are named in the `tool` string argument; their individual schemas never
// reach the provider turn. The object is frozen so `providerSchema()` returns
// a byte-stable value regardless of the discovered tool count.
// ---------------------------------------------------------------------------
export const MCP_CALL_PROVIDER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    server: { type: 'string', description: 'Registered MCP server id.' },
    tool: { type: 'string', description: 'Name of the discovered server tool to invoke.' },
    arguments: { type: 'object', description: 'Opaque arguments forwarded to the server tool.' },
  },
  required: ['server', 'tool'],
  additionalProperties: false,
});

/** Fully-inflated descriptor for the proxy tool (advanced `mcp` family, opt-in). */
export const MCP_CALL_DESCRIPTOR: RegisteredToolMetadata = inflateToolMetadata({
  name: 'mcp_call',
  description: 'Proxy a single call to a discovered external MCP server tool.',
  class: 'read-only',
  allowedPhases: ['planning', 'coding', 'review'],
  executionMode: 'sequential',
  outputCapPolicy: { strategy: 'truncate', maxBytes: 512 },
  family: 'mcp',
  logicalId: 'mcp.call',
  exposure: 'opt-in',
  provenance: 'external-untrusted',
  certificationRequirement: 'workflow',
});

const MCP_PROVENANCE_CLASS: ToolProvenanceClass = 'external-untrusted';

// ---------------------------------------------------------------------------
// Fail-closed network decision (mirrors network-policy.ts semantics).
// ---------------------------------------------------------------------------
export type McpNetworkRule = { kind: 'deny' } | { kind: 'allowlist'; hosts: readonly string[] };
export type McpNetworkPolicy = Readonly<Partial<Record<ToolPhase, McpNetworkRule>>>;

/** Default policy: MCP egress is denied on every phase unless an operator opts in. */
export const DEFAULT_MCP_NETWORK_POLICY: McpNetworkPolicy = Object.freeze({});

function decideNetwork(
  policy: McpNetworkPolicy,
  phase: ToolPhase,
  target: string | undefined,
): { allow: true } | { allow: false; reason: 'missing_policy' | 'not_allowed' | 'invalid_target' } {
  // No egress target -> a stdio/local server; network is not consulted.
  if (target === undefined) return { allow: true };
  const rule = policy[phase];
  if (!rule) return { allow: false, reason: 'missing_policy' }; // fail-closed
  if (rule.kind === 'deny') return { allow: false, reason: 'not_allowed' };
  let hostname: string;
  try {
    hostname = new URL(target).hostname.toLowerCase();
  } catch {
    return { allow: false, reason: 'invalid_target' };
  }
  return rule.hosts.some((h) => h.toLowerCase() === hostname)
    ? { allow: true }
    : { allow: false, reason: 'not_allowed' };
}

// ---------------------------------------------------------------------------
// Denial + dispatch result shapes.
// ---------------------------------------------------------------------------
export type McpDenialCategory = 'exposure' | 'phase' | 'path' | 'network';

export interface McpProxyCall {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** Optional filesystem paths the proxied tool will touch (validated pre-dispatch). */
  path?: string | string[];
  /** Optional network egress target for a non-stdio MCP server (fail-closed). */
  target?: string;
}

export interface McpDispatchResult {
  result: WavemillToolResult;
  /** True when a boundary denied the call before the server was reached. */
  denied: boolean;
  denial?: { category: McpDenialCategory; reason: string; message: string };
  /** True when the underlying dispatch produced an error result (timeout, malformed, ...). */
  isError: boolean;
}

export interface McpProxySessionOptions {
  phase: ToolPhase;
  worktreePath: string;
  config: WavemillConfig;
  certification: NativeCertificationSnapshot;
  networkPolicy?: McpNetworkPolicy;
  /** Per-call wall-clock timeout. */
  timeoutMs?: number;
  /** Content byte cap for normalized results. Defaults to the descriptor policy. */
  maxOutputBytes?: number;
  /** Extra env for the toy server (e.g. TOY_MCP_TOOL_COUNT). */
  serverEnv?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Session — one per task, owning at most one child server process.
// ---------------------------------------------------------------------------
export class McpProxySession {
  private readonly options: McpProxySessionOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
  private discoveryCache: Array<{ name: string }> | null = null;
  /** Count of requests the harness actually forwarded to the server process. */
  dispatchedToServer = 0;

  constructor(options: McpProxySessionOptions) {
    this.options = options;
  }

  /** The single fixed provider-facing schema — never varies with tool count. */
  providerSchema(): typeof MCP_CALL_PROVIDER_SCHEMA {
    return MCP_CALL_PROVIDER_SCHEMA;
  }

  /** True once the server process has been spawned. */
  get started(): boolean {
    return this.child !== null;
  }

  /** PID of the child server process, or undefined before lazy start. */
  get serverPid(): number | undefined {
    return this.child?.pid;
  }

  /** Discover server tools (lazy start + session-scoped cache). */
  async discover(): Promise<Array<{ name: string }>> {
    if (this.discoveryCache) return this.discoveryCache;
    this.ensureStarted();
    const response = (await this.sendRequest('tools/list', {})) as { result?: { tools?: Array<{ name: string }> } };
    this.discoveryCache = response.result?.tools ?? [];
    return this.discoveryCache;
  }

  /**
   * Proxy one MCP call through the full Wavemill boundary. Boundary denials
   * short-circuit BEFORE the server is started or reached.
   */
  async dispatch(call: McpProxyCall, signal?: AbortSignal): Promise<McpDispatchResult> {
    const denial = this.evaluateBoundary(call);
    if (denial) {
      return {
        result: this.normalize({
          content: [{ type: 'text', text: denial.message }],
          details: { denied: true, category: denial.category, reason: denial.reason },
          isError: true,
        }),
        denied: true,
        denial,
        isError: true,
      };
    }

    // Allowed -> lazily start and dispatch. Any transport failure becomes a
    // stable error result rather than throwing out of the harness.
    try {
      this.ensureStarted();
      const response = (await this.sendRequest(
        'tools/call',
        { name: call.tool, arguments: call.arguments ?? {} },
        signal,
      )) as { result?: { content?: Array<{ type: string; text: string }>; details?: unknown }; error?: { message?: string } };

      if (response.error) {
        return {
          result: this.normalize({
            content: [{ type: 'text', text: `mcp_error: ${response.error.message ?? 'unknown'}` }],
            details: { error: response.error },
            isError: true,
          }),
          denied: false,
          isError: true,
        };
      }

      return {
        result: this.normalize({
          content: response.result?.content ?? [],
          details: response.result?.details,
          isError: false,
        }),
        denied: false,
        isError: false,
      };
    } catch (error) {
      const reason = (error as Error).message;
      return {
        result: this.normalize({
          content: [{ type: 'text', text: `mcp_transport_error: ${reason}` }],
          details: { transportError: reason },
          isError: true,
        }),
        denied: false,
        isError: true,
      };
    }
  }

  /** Always terminate the child server. Safe to call multiple times. */
  terminate(): void {
    if (this.pending) {
      this.pending.reject(new Error('session terminated'));
      this.pending = null;
    }
    this.rl?.close();
    this.rl = null;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  // -------------------------------------------------------------------------
  // Boundary: exposure -> phase/path -> network. Pure and pre-dispatch.
  // -------------------------------------------------------------------------
  private evaluateBoundary(
    call: McpProxyCall,
  ): { category: McpDenialCategory; reason: string; message: string } | null {
    // 1) Exposure: default-off advanced `mcp` family gate.
    const eligibility = computeEligibility({
      phase: this.options.phase,
      config: this.options.config,
      certification: this.options.certification,
      registry: [MCP_CALL_DESCRIPTOR],
    });
    if (!eligibility.eligibleNames.includes('mcp_call')) {
      const denial = eligibility.denials.find((d) => 'toolName' in d && d.toolName === 'mcp_call');
      const reason = denial?.reason ?? 'not_exposed';
      return {
        category: 'exposure',
        reason,
        message: `not_exposed: mcp_call is not eligible for ${this.options.phase} (${reason})`,
      };
    }

    // 2) Phase + worktree-path denial, reusing the real evaluator. The proxied
    //    arguments are presented to the policy so path fields are validated.
    const flattened: Record<string, unknown> = { ...(call.arguments ?? {}) };
    if (call.path !== undefined) flattened.path = call.path;
    const decision = evaluateBeforeToolCallPolicy({
      phase: this.options.phase,
      config: {
        eligibleNames: eligibility.eligibleNames,
        pathFieldsByTool: { mcp_call: ['path'] },
      },
      worktreePath: this.options.worktreePath,
      registry: [MCP_CALL_DESCRIPTOR],
      toolCall: { name: 'mcp_call', arguments: flattened },
    });
    if (decision.kind === 'deny') {
      const category: McpDenialCategory = decision.reason === 'path_denied' ? 'path' : 'phase';
      return { category, reason: decision.reason satisfies ToolPolicyReason, message: decision.message };
    }

    // 3) Fail-closed network decision for any declared egress target.
    const net = decideNetwork(this.options.networkPolicy ?? DEFAULT_MCP_NETWORK_POLICY, this.options.phase, call.target);
    if (!net.allow) {
      return {
        category: 'network',
        reason: net.reason,
        message: `network_denied: MCP egress to '${call.target}' denied (${net.reason})`,
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Result normalization: redaction -> cap -> provenance/trust metadata.
  // Mirrors shared/lib/native-agent/loop.ts's per-result enrichment.
  // -------------------------------------------------------------------------
  private normalize(input: {
    content: Array<{ type: string; text: string }>;
    details: unknown;
    isError: boolean;
  }): WavemillToolResult {
    // Redact content text and details.
    const contentCategories: string[] = [];
    let contentMatchCount = 0;
    let contentRedacted = false;
    const redactedContent = input.content.map((block) => {
      if (block.type === 'text') {
        const r = redactSecrets(block.text);
        if (r.redacted) {
          contentRedacted = true;
          contentMatchCount += r.matchCount;
          for (const c of r.categories) contentCategories.push(c);
        }
        return { type: 'text' as const, text: r.text };
      }
      return { type: 'text' as const, text: '' };
    });
    const detailsResult =
      input.details !== undefined && input.details !== null
        ? redactSecretsInValue(input.details)
        : { value: input.details, redacted: false, matchCount: 0, categories: [] as string[] };

    // Output cap: truncate combined content text to maxBytes.
    const maxBytes = this.options.maxOutputBytes ?? MCP_CALL_DESCRIPTOR.outputCapPolicy.maxBytes ?? 512;
    const combined = redactedContent.map((b) => b.text).join('');
    const originalBytes = Buffer.byteLength(combined, 'utf8');
    let outputCap: ToolOutputCapMetadata = { capped: false, strategy: 'truncate', limit: maxBytes, limitKind: 'bytes' };
    let cappedContent = redactedContent;
    let cappedDetails = detailsResult.value;
    if (originalBytes > maxBytes) {
      const truncated = Buffer.from(combined, 'utf8').subarray(0, maxBytes).toString('utf8');
      cappedContent = [{ type: 'text' as const, text: truncated }];
      const retainedBytes = Buffer.byteLength(truncated, 'utf8');
      cappedDetails =
        cappedDetails !== null && typeof cappedDetails === 'object' && !Array.isArray(cappedDetails)
          ? { ...(cappedDetails as Record<string, unknown>), truncated: true, originalBytes, retainedBytes }
          : { truncated: true, originalBytes, retainedBytes };
      outputCap = {
        capped: true,
        strategy: 'truncate',
        limit: maxBytes,
        limitKind: 'bytes',
        originalLength: originalBytes,
        retainedLength: retainedBytes,
      };
    }

    // Provenance fingerprint + untrusted trust metadata (external content).
    const argsFingerprint = createHash('sha256')
      .update(JSON.stringify({ content: cappedContent, details: cappedDetails }))
      .digest('hex')
      .slice(0, 16);
    const trust = buildTrustMetadata({
      sourceKind: 'provider_payload',
      content: cappedContent,
      details: cappedDetails,
    });
    const allCategories = [...new Set([...contentCategories, ...detailsResult.categories])];

    const metadata: ToolResultMetadata = {
      provenance: { tool: 'mcp_call', argsFingerprint },
      outputCap,
      redaction: {
        redacted: contentRedacted || detailsResult.redacted,
        matchCount: contentMatchCount + detailsResult.matchCount,
        categories: allCategories,
      },
      trust,
    };

    const enrichedDetails =
      cappedDetails !== null && cappedDetails !== undefined && typeof cappedDetails === 'object' && !Array.isArray(cappedDetails)
        ? { ...(cappedDetails as Record<string, unknown>), provenanceClass: MCP_PROVENANCE_CLASS, __wavemill: metadata }
        : { value: cappedDetails, provenanceClass: MCP_PROVENANCE_CLASS, __wavemill: metadata };

    return { content: cappedContent, details: enrichedDetails, metadata };
  }

  // -------------------------------------------------------------------------
  // Transport: lazy child spawn + one-in-flight line-delimited JSON exchange.
  // -------------------------------------------------------------------------
  private ensureStarted(): void {
    if (this.child) return;
    const child = spawn('node', [TOY_SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...(this.options.serverEnv ?? {}) },
    });
    this.child = child;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    child.on('exit', () => {
      if (this.pending) {
        this.pending.reject(new Error('server exited'));
        this.pending = null;
      }
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '' || !this.pending) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed server payload -> stable error to the awaiting caller.
      this.pending.reject(new Error('malformed server response'));
      this.pending = null;
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.resolve(parsed);
  }

  private sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.child) throw new Error('server not started');
    const id = this.nextId++;
    if (method === 'tools/call') this.dispatchedToServer++;

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timeoutMs = this.options.timeoutMs ?? MCP_CALL_DESCRIPTOR.policy.timeoutMs;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        if (this.pending?.id === id) this.pending = null;
        finish(() => rejectPromise(new Error('timeout')));
      }, timeoutMs);
      const onAbort = () => {
        if (this.pending?.id === id) this.pending = null;
        finish(() => rejectPromise(new Error('cancelled')));
      };
      if (signal) {
        if (signal.aborted) {
          finish(() => rejectPromise(new Error('cancelled')));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending = {
        id,
        resolve: (v) => finish(() => resolvePromise(v)),
        reject: (e) => finish(() => rejectPromise(e)),
      };
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
}
