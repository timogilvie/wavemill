// ---------------------------------------------------------------------------
// MCP tool descriptor factory.
//
// Translates the operator-configured `nativeAgent.advanced.mcp` matrix into
// Wavemill `ToolDescriptor`s. Each descriptor delegates to the shared
// `McpClient` (bounded child-process manager) at call time, records
// provenance (proxy + logical + argument digest + server identity + artifact
// ref), and tags trust as `external-untrusted`.
//
// Nothing here spawns child processes: server startup is lazy inside the
// client. If the exposure engine or the policy layer denies the call, no
// spawn happens.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type { WavemillConfig } from '../../config.ts';
import { buildTrustMetadata } from '../provenance.ts';
import type {
  McpClient,
  McpCallFailure,
} from '../mcp-client.ts';
import type {
  McpToolResultMetadata,
  ToolDescriptor,
  ToolResultMetadata,
  WavemillToolResult,
} from './types.ts';

// Loose ArtifactRef import to avoid a hard dependency on session-stream from
// the descriptor module; the loop's storeArtifact returns this shape.
export interface McpArtifactRef {
  digest: string;
  byteSize: number;
  path: string;
  truncated?: boolean;
  originalByteSize?: number;
}

export type StoreMcpArtifact = (bytes: Uint8Array) => McpArtifactRef | undefined;

export interface CreateMcpToolDescriptorsInput {
  config: WavemillConfig;
  client: McpClient;
  storeArtifact?: StoreMcpArtifact;
}

interface McpDetailPayload {
  ok: boolean;
  server: string;
  tool: string;
  argsFingerprint: string;
  serverIdentity?: { name: string; version: string };
  resultArtifactRef?: McpArtifactRef;
  errorKind?: string;
  errorMessage?: string;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return '{' + pairs.join(',') + '}';
}

/** Descriptor-name prefix shared by every MCP proxy tool. */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_NAME_PREFIX);
}

/**
 * SHA-256 (hex) over the canonical, key-sorted JSON of an MCP call's
 * arguments. This digest, never the raw arguments, is what provenance and
 * transcripts record (HOK-3056 REQ-F4).
 */
export function computeMcpArgumentsDigest(args: unknown): string {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex');
}

/**
 * Bound the agent-visible payload text to `budgetBytes` (UTF-8), appending a
 * truncation marker when anything was cut.
 */
function capPayloadTexts(texts: string[], budgetBytes: number, originalByteSize?: number): string[] {
  const encoder = new TextEncoder();
  const capped: string[] = [];
  let remaining = Math.max(0, budgetBytes);
  let cut = false;
  for (const text of texts) {
    const bytes = encoder.encode(text);
    if (bytes.byteLength <= remaining) {
      capped.push(text);
      remaining -= bytes.byteLength;
      continue;
    }
    cut = true;
    if (remaining > 0) {
      capped.push(new TextDecoder().decode(bytes.slice(0, remaining)).replace(/\uFFFD+$/, ''));
    }
    break;
  }
  if (cut || originalByteSize !== undefined) {
    capped.push(`[mcp result truncated to ${budgetBytes} bytes${originalByteSize !== undefined ? ` of ${originalByteSize}` : ''}]`);
  }
  return capped;
}

function descriptorName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${serverName}__${toolName}`;
}

function logicalId(serverName: string, toolName: string): string {
  return `mcp.${serverName}.${toolName}`;
}

function formatSuccessSummary(server: string, tool: string, argsFingerprint: string): string {
  return `mcp:${server}/${tool} ok fingerprint=${argsFingerprint}`;
}

/**
 * Extract text blocks from an MCP `tools/call` payload. MCP's canonical shape
 * is `{ content: [{ type: 'text', text: '...' }, ...] }` — this helper is
 * permissive: anything else falls through to an empty list so an oddly-shaped
 * server never crashes the executor.
 */
function extractPayloadText(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts;
}

function formatFailureSummary(server: string, tool: string, outcome: McpCallFailure): string {
  return `mcp:${server}/${tool} failed kind=${outcome.kind} message=${outcome.message}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build one descriptor per configured (server, tool) pair, sorted
 * deterministically by (serverName, toolName). Returns an empty array when
 * the family is not enabled or has no servers configured — the exposure
 * engine still owns the `enabled` gate; this early-out keeps the registry
 * tidy when a repo has not opted in.
 */
export function createMcpToolDescriptors(input: CreateMcpToolDescriptorsInput): ToolDescriptor[] {
  const family = input.config.nativeAgent?.advanced?.mcp;
  if (!family || family.enabled !== true) return [];
  const servers = family.servers ?? {};
  const allowedPhases = family.allowedPhases ?? [];
  const descriptors: ToolDescriptor[] = [];

  const serverNames = Object.keys(servers).sort();
  for (const serverName of serverNames) {
    const serverConfig = servers[serverName]!;
    const toolNames = [...serverConfig.tools].sort();
    for (const toolName of toolNames) {
      if (!MCP_TOOL_NAME_PATTERN.test(toolName)) continue;
      const name = descriptorName(serverName, toolName);
      const cls = serverConfig.class ?? 'read-only';
      const timeoutMs = serverConfig.callTimeoutMs ?? family.defaults?.callTimeoutMs ?? 15_000;
      const maxOutputBytes =
        serverConfig.maxOutputBytes ?? family.defaults?.maxOutputBytes ?? 64 * 1024;

      const descriptor: ToolDescriptor = {
        metadata: {
          name,
          description: `MCP proxy tool ${serverName}/${toolName} (provider=${serverConfig.providerProxy}, class=${cls}).`,
          class: cls,
          allowedPhases: allowedPhases.length > 0
            ? (allowedPhases as readonly ('planning' | 'coding' | 'review')[])
            : ['coding'],
          executionMode: 'sequential',
          outputCapPolicy: { strategy: 'truncate', maxBytes: maxOutputBytes },
          family: 'mcp',
          logicalId: logicalId(serverName, toolName),
          exposure: 'opt-in',
          provenance: 'external-untrusted',
          certificationRequirement: 'workflow',
          policy: {
            pathMode: 'none',
            network: 'allowlisted',
            mutatesGit: false,
            mutatesExternalSystems: cls === 'mutation',
            requiresApproval: cls === 'mutation' ? 'when-risky' : false,
            timeoutMs,
            maxOutputBytes,
            maxOutputTokens: Math.max(1_024, Math.min(16_384, Math.floor(maxOutputBytes / 4))),
            redactionProfile: 'secrets',
          },
        },
        parameters: {
          type: 'object',
          properties: {
            arguments: {
              type: 'object',
              description: `Arguments forwarded verbatim to logical tool ${serverName}/${toolName}.`,
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        async execute(toolCallId, params, signal) {
          const rawArgs = (params as { arguments?: unknown } | undefined)?.arguments;
          const args = rawArgs ?? {};
          const argumentsDigest = computeMcpArgumentsDigest(args);
          const argsFingerprint = argumentsDigest.slice(0, 16);
          const outcome = await input.client.callTool(serverName, toolName, args, {
            signal,
            timeoutMs,
            maxOutputBytes,
          });
          // Explicit discriminant check: the repo's non-strict tsc config does
          // not narrow the union on `!outcome.ok`.
          if (outcome.ok === false) {
            const detail: McpDetailPayload = {
              ok: false,
              server: serverName,
              tool: toolName,
              argsFingerprint,
              errorKind: outcome.kind,
              errorMessage: outcome.message,
            };
            const mcpMeta: McpToolResultMetadata = {
              providerProxy: serverConfig.providerProxy,
              logicalServer: serverName,
              logicalTool: toolName,
              // Identity is unknown after a failed call; report the config name.
              serverIdentity: { name: serverName, version: '0.0.0' },
              argsFingerprint,
              argumentsDigest,
            };
            const metadata: ToolResultMetadata = {
              mcp: mcpMeta,
              trust: buildTrustMetadata({
                sourceKind: 'mcp_result',
                content: [{ type: 'text', text: formatFailureSummary(serverName, toolName, outcome) }],
                details: detail,
              }),
            };
            const result: WavemillToolResult<McpDetailPayload> = {
              content: [
                { type: 'text', text: formatFailureSummary(serverName, toolName, outcome) },
              ],
              details: detail,
              metadata,
            };
            return result;
          }

          const snapshot = input.client.snapshot();
          const serverSnap = snapshot.servers.find((s) => s.serverName === serverName);
          const identity = serverSnap?.identity ?? { name: serverName, version: '0.0.0' };

          let artifactRef: McpArtifactRef | undefined;
          if (input.storeArtifact) {
            try {
              artifactRef = input.storeArtifact(outcome.rawBytes);
            } catch {
              artifactRef = undefined;
            }
          }
          if (artifactRef && outcome.truncated) {
            artifactRef = { ...artifactRef, truncated: true, originalByteSize: outcome.originalByteSize };
          }

          const detail: McpDetailPayload = {
            ok: true,
            server: serverName,
            tool: toolName,
            argsFingerprint,
            serverIdentity: identity,
            resultArtifactRef: artifactRef,
            ...(outcome.truncated ? { truncated: true } : {}),
          };

          const mcpMeta: McpToolResultMetadata = {
            providerProxy: serverConfig.providerProxy,
            logicalServer: serverName,
            logicalTool: toolName,
            serverIdentity: identity,
            argsFingerprint,
            argumentsDigest,
            resultArtifactRef: artifactRef,
            ...(outcome.truncated ? { truncated: true } : {}),
          };

          const summary = formatSuccessSummary(serverName, toolName, argsFingerprint);
          const summaryBytes = new TextEncoder().encode(summary).byteLength;
          const payloadTexts = capPayloadTexts(
            extractPayloadText(outcome.payload),
            Math.max(0, maxOutputBytes - summaryBytes - 128),
            outcome.truncated ? outcome.originalByteSize : undefined,
          );
          const visibleContent: Array<{ type: 'text'; text: string }> = [
            { type: 'text', text: summary },
            ...payloadTexts.map((text) => ({ type: 'text' as const, text })),
          ];
          const metadata: ToolResultMetadata = {
            mcp: mcpMeta,
            trust: buildTrustMetadata({
              sourceKind: 'mcp_result',
              content: visibleContent,
              details: detail,
            }),
          };
          const result: WavemillToolResult<McpDetailPayload> = {
            content: visibleContent,
            details: detail,
            metadata,
          };
          return result;
        },
      };
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}
