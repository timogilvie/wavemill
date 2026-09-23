// ---------------------------------------------------------------------------
// Wavemill-owned MCP proxy adapter (HOK-3055 compatibility spike).
//
// The provider is shown ONE bounded descriptor (`mcp_proxy`) whose schema does
// not scale with the underlying MCP catalog: adding backing tools cannot grow
// the provider-visible surface area. Discovery, validation, timeout,
// cancellation, redaction, output caps, provenance tagging, and structured
// error conversion all happen inside the adapter — before any result leaves
// the Wavemill boundary.
//
// This file lives under `spike/` because it is a compatibility exploration,
// not a shipping seam. It imports only from `shared/lib` for redaction,
// provenance, policy, and tool-metadata primitives; it does NOT ship a
// production MCP client or credentials.
// ---------------------------------------------------------------------------

import {
  buildTrustMetadata,
  type ToolTrustMetadata,
} from '../../shared/lib/native-agent/provenance.ts';
import {
  evaluateBeforeToolCallPolicy,
  resolveCandidatePath,
  toDisplayPath,
  normalizeWorktreeRoot,
  type ToolPolicyConfig,
  type ToolPolicyDecision,
} from '../../shared/lib/native-agent/tools/policies.ts';
import {
  redactSecrets,
  type RedactionResult,
} from '../../shared/lib/native-agent/tools/redaction.ts';
import type {
  RegisteredToolMetadata,
  ToolMetadata,
  ToolPhase,
  ToolResultMetadata,
} from '../../shared/lib/native-agent/tools/types.ts';
import type { MockMcpServer, MockToolResult } from './mock-mcp-server.ts';

// ---------------------------------------------------------------------------
// Provider-facing descriptor
// ---------------------------------------------------------------------------

/**
 * The provider sees exactly this metadata + JSON schema — the descriptor is a
 * constant, so adding tools to the backing catalog cannot change the model's
 * exposed surface.
 */
export const MCP_PROXY_TOOL_NAME = 'mcp_proxy';

export const MCP_PROXY_METADATA: ToolMetadata = Object.freeze({
  name: MCP_PROXY_TOOL_NAME,
  description:
    'Proxy dispatch to a Wavemill-managed MCP server. Discovery is handled inside the proxy; the model never sees per-tool schemas.',
  class: 'read-only',
  allowedPhases: ['planning', 'coding', 'review'],
  executionMode: 'sequential',
  outputCapPolicy: { strategy: 'truncate', maxBytes: 2048 },
  family: 'mcp',
  logicalId: 'mcp.proxy',
  exposure: 'opt-in',
  certificationRequirement: 'workflow',
});

export const MCP_PROXY_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['tool_name', 'arguments'],
  properties: {
    tool_name: {
      type: 'string',
      description: 'Name of a tool advertised by the backing MCP server.',
    },
    arguments: {
      type: 'object',
      description: 'Arguments to forward to the backing tool.',
      additionalProperties: true,
    },
  },
});

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface McpProxyArguments {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export type McpProxyErrorCode =
  | 'not_exposed'
  | 'phase_denied'
  | 'path_denied'
  | 'network_denied'
  | 'unknown_tool'
  | 'timeout'
  | 'aborted'
  | 'malformed_result'
  | 'server_terminated'
  | 'invalid_arguments';

export interface McpProxyResult {
  isError: boolean;
  errorCode?: McpProxyErrorCode;
  content: Array<{ type: 'text'; text: string }>;
  metadata: ToolResultMetadata;
}

export interface McpProxyAdapterOptions {
  server: MockMcpServer;
  /** Wall-clock upper bound for a single proxied call. */
  timeoutMs?: number;
  /** Byte ceiling for the model-visible text after redaction. */
  maxOutputBytes?: number;
}

interface DiscoveryCacheEntry {
  names: Set<string>;
}

/**
 * Bounded proxy adapter. Owns lifecycle (lazy start, mandatory stop),
 * discovery caching, argument validation, timeout, and structured error
 * conversion. Every result carries `external-untrusted` provenance metadata
 * and passes through Wavemill redaction + caps before it is returned.
 */
export class McpProxyAdapter {
  private readonly server: MockMcpServer;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private discovery: DiscoveryCacheEntry | null = null;
  private started = false;

  constructor(opts: McpProxyAdapterOptions) {
    this.server = opts.server;
    this.timeoutMs = opts.timeoutMs ?? 500;
    this.maxOutputBytes = opts.maxOutputBytes ?? 2048;
  }

  getMetadata(): ToolMetadata {
    return MCP_PROXY_METADATA;
  }

  getParameters(): unknown {
    return MCP_PROXY_PARAMETERS;
  }

  /** Cached list of backing tool names. Advertised to logs, never to the model. */
  async listBackingTools(): Promise<readonly string[]> {
    await this.ensureStarted();
    await this.ensureDiscovered();
    return Array.from(this.discovery!.names);
  }

  isRunning(): boolean {
    return this.started && this.server.isRunning();
  }

  async invoke(
    params: unknown,
    externalSignal?: AbortSignal,
  ): Promise<McpProxyResult> {
    const validated = validateArguments(params);
    if (!validated.ok) {
      return errorResult('invalid_arguments', validated.message);
    }

    try {
      await this.ensureStarted();
      await this.ensureDiscovered();
    } catch (err) {
      return errorResult(
        'server_terminated',
        `MCP server lifecycle failed: ${(err as Error).message}`,
      );
    }

    if (!this.discovery!.names.has(validated.value.tool_name)) {
      return errorResult(
        'unknown_tool',
        `MCP proxy: no backing tool "${validated.value.tool_name}"`,
      );
    }

    const controller = new AbortController();
    const linkedAbort = () => controller.abort(externalSignal?.reason ?? new Error('aborted'));
    if (externalSignal?.aborted) {
      linkedAbort();
    } else if (externalSignal) {
      externalSignal.addEventListener('abort', linkedAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new Error('mcp_proxy_timeout'));
    }, this.timeoutMs);

    let raw: MockToolResult;
    try {
      raw = await this.server.invoke(
        validated.value.tool_name,
        validated.value.arguments,
        controller.signal,
      );
    } catch (err) {
      const isAbort =
        externalSignal?.aborted === true ||
        (err instanceof Error && /abort/i.test(err.message));
      const isTimeout = err instanceof Error && err.message === 'mcp_proxy_timeout';
      if (isTimeout) {
        return errorResult('timeout', `MCP proxy: call timed out after ${this.timeoutMs}ms`);
      }
      if (isAbort) {
        return errorResult('aborted', 'MCP proxy: call aborted');
      }
      return errorResult('server_terminated', `MCP proxy error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', linkedAbort);
    }

    if (raw.kind === 'malformed') {
      return errorResult(
        'malformed_result',
        'MCP proxy: backing tool returned a payload that did not match the declared shape',
      );
    }

    return this.buildSuccessResult(raw.text);
  }

  async dispose(): Promise<void> {
    try {
      await this.server.stop();
    } finally {
      this.started = false;
      this.discovery = null;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.server.start();
    this.started = true;
  }

  private async ensureDiscovered(): Promise<void> {
    if (this.discovery) return;
    const tools = await this.server.discover();
    this.discovery = { names: new Set(tools.map((t) => t.name)) };
  }

  private buildSuccessResult(rawText: string): McpProxyResult {
    const capped = capText(rawText, this.maxOutputBytes);
    const redaction: RedactionResult = redactSecrets(capped.text);
    const trust: ToolTrustMetadata = buildTrustMetadata({
      sourceKind: 'provider_payload',
      content: [{ type: 'text', text: redaction.text }],
    });
    // Trust is forcibly marked external-untrusted — an MCP server's own
    // permission model is not treated as authorization.
    const externallyUntrustedTrust: ToolTrustMetadata = {
      ...trust,
      trust: 'untrusted',
    };

    const metadata: ToolResultMetadata = {
      outputCap: capped.capped
        ? {
            capped: true,
            strategy: 'truncate',
            limit: this.maxOutputBytes,
            limitKind: 'bytes',
            originalLength: capped.originalLength,
            retainedLength: capped.text.length,
          }
        : { capped: false },
      provenance: {
        tool: MCP_PROXY_TOOL_NAME,
        argsFingerprint: 'na',
      },
      redaction: {
        redacted: redaction.redacted,
        matchCount: redaction.matchCount,
        categories: redaction.categories,
      },
      trust: externallyUntrustedTrust,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: redaction.text }],
      metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Policy gate — applied BEFORE the adapter is touched
// ---------------------------------------------------------------------------

export interface ProxyPolicyGateInput {
  phase: ToolPhase;
  worktreePath: string;
  toolCall: { name: string; arguments: Record<string, unknown> };
  eligibleNames: readonly string[];
  pathFieldsByTool?: Readonly<Record<string, readonly string[]>>;
  network: {
    /** Target host or 'none' for calls that make no external request. */
    target: string;
    /** Default-deny allowlist. Empty → all hosts denied. */
    allowlist: readonly string[];
  };
  registry: readonly ToolMetadata[];
  readOnlyPhases?: readonly ToolPhase[];
}

export type ProxyPolicyResult =
  | { kind: 'allow' }
  | { kind: 'deny'; code: McpProxyErrorCode; message: string };

/**
 * Evaluate phase/path/exposure via the native-agent policy, then apply a
 * default-deny network rule. The result decides whether the adapter is ever
 * touched.
 */
export function evaluateProxyPolicy(input: ProxyPolicyGateInput): ProxyPolicyResult {
  const config: ToolPolicyConfig = {
    eligibleNames: input.eligibleNames,
    ...(input.readOnlyPhases ? { readOnlyPhases: input.readOnlyPhases } : {}),
  };
  const decision: ToolPolicyDecision = evaluateBeforeToolCallPolicy({
    phase: input.phase,
    worktreePath: input.worktreePath,
    registry: input.registry,
    toolCall: input.toolCall,
    config,
  });
  if (decision.kind === 'deny') {
    const code: McpProxyErrorCode =
      decision.reason === 'phase_denied'
        ? 'phase_denied'
        : decision.reason === 'path_denied'
          ? 'path_denied'
          : 'not_exposed';
    return { kind: 'deny', code, message: decision.message };
  }

  // Proxy-specific path check: path fields live INSIDE the inner `arguments`
  // envelope, one level down from the shared policy's `toolCall.arguments`.
  const pathFields = input.pathFieldsByTool?.[input.toolCall.name] ?? [];
  if (pathFields.length > 0) {
    const inner = input.toolCall.arguments.arguments;
    if (inner !== undefined && typeof inner === 'object' && inner !== null) {
      const innerArgs = inner as Record<string, unknown>;
      const worktreeRoot = normalizeWorktreeRoot(input.worktreePath);
      for (const field of pathFields) {
        const value = innerArgs[field];
        const candidates = Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : typeof value === 'string'
            ? [value]
            : [];
        for (const candidate of candidates) {
          const resolved = resolveCandidatePath(worktreeRoot, candidate);
          if (resolved.kind === 'outside') {
            return {
              kind: 'deny',
              code: 'path_denied',
              message: `path_denied: '${toDisplayPath(candidate)}' resolves outside the worktree`,
            };
          }
        }
      }
    }
  }

  if (input.network.target !== 'none') {
    if (!input.network.allowlist.includes(input.network.target)) {
      return {
        kind: 'deny',
        code: 'network_denied',
        message: `network_denied: target "${input.network.target}" is not on the mcp_proxy allowlist`,
      };
    }
  }

  return { kind: 'allow' };
}

// ---------------------------------------------------------------------------
// Registered-metadata inflation for exposure gates
// ---------------------------------------------------------------------------

/**
 * Test/spike convenience: return the descriptor as if the native registry had
 * inflated it. Useful when driving the exposure engine directly.
 */
export function registeredMcpProxyMetadata(): RegisteredToolMetadata {
  return {
    ...MCP_PROXY_METADATA,
    family: 'mcp',
    logicalId: 'mcp.proxy',
    exposure: 'opt-in',
    provenance: 'external-untrusted',
    certificationRequirement: 'workflow',
    policy: {
      pathMode: 'read-only',
      network: 'deny',
      mutatesGit: false,
      mutatesExternalSystems: false,
      requiresApproval: false,
      timeoutMs: 500,
      maxOutputBytes: 2048,
      maxOutputTokens: 512,
      redactionProfile: 'default',
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ArgumentValidation {
  ok: true;
  value: McpProxyArguments;
}
interface ArgumentValidationError {
  ok: false;
  message: string;
}

function validateArguments(
  params: unknown,
): ArgumentValidation | ArgumentValidationError {
  if (typeof params !== 'object' || params === null) {
    return { ok: false, message: 'mcp_proxy requires an object argument' };
  }
  const record = params as Record<string, unknown>;
  const toolName = record.tool_name;
  if (typeof toolName !== 'string' || toolName === '') {
    return { ok: false, message: 'mcp_proxy: "tool_name" must be a non-empty string' };
  }
  const args = record.arguments;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, message: 'mcp_proxy: "arguments" must be an object' };
  }
  return {
    ok: true,
    value: { tool_name: toolName, arguments: args as Record<string, unknown> },
  };
}

interface CappedText {
  text: string;
  capped: boolean;
  originalLength: number;
}

function capText(text: string, maxBytes: number): CappedText {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text, capped: false, originalLength: text.length };
  }
  const truncated = buf.subarray(0, maxBytes).toString('utf8');
  return { text: truncated, capped: true, originalLength: text.length };
}

function errorResult(code: McpProxyErrorCode, message: string): McpProxyResult {
  return {
    isError: true,
    errorCode: code,
    content: [{ type: 'text', text: message }],
    metadata: {
      provenance: { tool: MCP_PROXY_TOOL_NAME, argsFingerprint: 'na' },
      trust: {
        sourceKind: 'provider_payload',
        trust: 'untrusted',
        diagnostics: [],
      },
      redaction: { redacted: false, matchCount: 0, categories: [] },
      outputCap: { capped: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript projection
// ---------------------------------------------------------------------------

export interface TranscriptEnvelope {
  seq: number;
  type: 'tool_started' | 'tool_result';
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  content?: string;
  metadata?: ToolResultMetadata;
}

/**
 * Project a proxy call into the two transcript events wavemill's
 * `TranscriptWriter` already knows how to persist. Kept as a plain-object
 * projection so the spike can be driven without pulling in the full writer.
 */
export function projectTranscriptEvents(
  toolCallId: string,
  args: McpProxyArguments,
  result: McpProxyResult,
): [TranscriptEnvelope, TranscriptEnvelope] {
  const started: TranscriptEnvelope = {
    seq: 0,
    type: 'tool_started',
    toolCallId,
    toolName: MCP_PROXY_TOOL_NAME,
    args: { tool_name: args.tool_name, arguments: args.arguments },
  };
  const finished: TranscriptEnvelope = {
    seq: 1,
    type: 'tool_result',
    toolCallId,
    toolName: MCP_PROXY_TOOL_NAME,
    isError: result.isError,
    content: result.content[0]?.text ?? '',
    metadata: result.metadata,
  };
  return [started, finished];
}
