// ---------------------------------------------------------------------------
// Wavemill-native tool types — no Pi or typebox imports.
// ---------------------------------------------------------------------------

import type { ToolTrustMetadata } from '../provenance.ts';

/** Agent workflow phase during which a tool is available. */
export type ToolPhase = 'planning' | 'coding' | 'review';

/** Whether a tool reads or mutates external state. */
export type ToolMutationClass = 'read-only' | 'mutation';

/** How tool calls within a single assistant turn are executed. */
export type ToolExecutionMode = 'parallel' | 'sequential';

/** What the registry does when output exceeds the cap. */
export type OutputCapStrategy = 'none' | 'truncate' | 'reject';

/** Output cap policy stored with the tool descriptor. No enforcement here. */
export interface OutputCapPolicy {
  strategy: OutputCapStrategy;
  /** Maximum bytes allowed in the tool result text. Only meaningful for truncate/reject. */
  maxBytes?: number;
  /** Maximum item count for structured results. Only meaningful for truncate/reject. */
  maxItems?: number;
}

// ---------------------------------------------------------------------------
// Advanced tool catalog metadata (Epic 10)
// ---------------------------------------------------------------------------

/**
 * Stable family identifier. `core` covers the Tier 1–4 catalog that ships on
 * every phase; the remaining values seat the Epic 10 advanced families whose
 * eligibility is gated by opt-in configuration.
 */
export type ToolFamilyId =
  | 'core'
  | 'browser'
  | 'screenshot'
  | 'mcp'
  | 'code_search'
  | 'ast'
  | 'eval';

/** All Epic 10 advanced families (everything except `core`). */
export const ADVANCED_TOOL_FAMILIES: readonly ToolFamilyId[] = Object.freeze([
  'browser',
  'screenshot',
  'mcp',
  'code_search',
  'ast',
  'eval',
]);

export function isAdvancedFamily(family: ToolFamilyId): boolean {
  return family !== 'core';
}

/**
 * How a tool becomes eligible to be exposed to the model.
 *
 * - `always` — Tier 1–4 tools; eligible on every phase in `allowedPhases`.
 * - `opt-in` — Advanced-family tools; eligible only when the operator has
 *   explicitly enabled the family for the requested phase.
 */
export type ToolExposureMode = 'always' | 'opt-in';

/**
 * Minimum certification the model must carry for an advanced tool family to
 * become eligible. Ordered ascendingly by the ladder used by
 * `shared/lib/native-agent/certification/schema.ts` — `none` is a sentinel
 * meaning no certification is required (Tier 1–4 tools always take this).
 */
export type NativeCertificationRequirement = 'none' | 'read-only' | 'patch' | 'workflow';

/**
 * Runtime-level per-call policy metadata. Matches `ToolPolicy` in
 * docs/native-agent-runtime-plan.md — the runtime loop consults this per call,
 * separately from the registry-level `outputCapPolicy` (which is a truncation
 * dial only).
 */
export interface ToolPolicyMetadata {
  pathMode: 'none' | 'read-only' | 'workspace-write' | 'artifact-write';
  network: 'deny' | 'allowlisted' | 'allow';
  mutatesGit: boolean;
  mutatesExternalSystems: boolean;
  requiresApproval: boolean | 'when-risky';
  /** Wall-clock timeout for a single call. */
  timeoutMs: number;
  /** Per-call maximum bytes returned to the model. */
  maxOutputBytes: number;
  /** Per-call maximum tokens returned to the model. */
  maxOutputTokens: number;
  redactionProfile: 'default' | 'secrets' | 'none';
}

/**
 * Provenance class for the tool as a *producer* — describes the trust tier of
 * any content it emits.  Matches the taxonomy used by `shared/lib/native-agent/
 * provenance.ts` for individual tool call outputs.
 */
export type ToolProvenanceClass =
  | 'wavemill-generated'
  | 'repo-trusted'
  | 'repo-untrusted'
  | 'external-untrusted'
  | 'provider-generated';

/** Stable, provider-agnostic metadata for a registered tool. */
export interface ToolMetadata {
  name: string;
  description: string;
  class: ToolMutationClass;
  allowedPhases: readonly ToolPhase[];
  executionMode: ToolExecutionMode;
  outputCapPolicy: OutputCapPolicy;
  /**
   * Stable family identity. Absent on legacy descriptors; the registry
   * inflates them to `core` at registration.
   */
  family?: ToolFamilyId;
  /**
   * Family-scoped short identifier, e.g. `browser.navigate`, `core.read_file`.
   * Absent on legacy descriptors; the registry inflates them from the family
   * and `name` at registration. Uniqueness is enforced per family.
   */
  logicalId?: string;
  /** Registration-time gate. Absent → `always`. */
  exposure?: ToolExposureMode;
  /** Per-call runtime policy. Inflated from defaults keyed off `class`. */
  policy?: ToolPolicyMetadata;
  /** Producer-side provenance for the tool's output. Inflated by class. */
  provenance?: ToolProvenanceClass;
  /**
   * Minimum certification maxCertifiedPhase required for this tool. Advanced
   * families default to `workflow`; core tools default to `none`.
   */
  certificationRequirement?: NativeCertificationRequirement;
}

/**
 * Fully-inflated tool metadata after registration.  The registry guarantees
 * every field is present, so consumers (exposure engine, adapters, policy
 * evaluator) can rely on the extended contract without null checks.
 */
export interface RegisteredToolMetadata extends ToolMetadata {
  family: ToolFamilyId;
  logicalId: string;
  exposure: ToolExposureMode;
  policy: ToolPolicyMetadata;
  provenance: ToolProvenanceClass;
  certificationRequirement: NativeCertificationRequirement;
}

// ---------------------------------------------------------------------------
// Defaults and inflation helpers
// ---------------------------------------------------------------------------

const READ_ONLY_POLICY_DEFAULT: ToolPolicyMetadata = {
  pathMode: 'read-only',
  network: 'deny',
  mutatesGit: false,
  mutatesExternalSystems: false,
  requiresApproval: false,
  timeoutMs: 60_000,
  maxOutputBytes: 256 * 1024,
  maxOutputTokens: 8_192,
  redactionProfile: 'default',
};

const MUTATION_POLICY_DEFAULT: ToolPolicyMetadata = {
  pathMode: 'workspace-write',
  network: 'deny',
  mutatesGit: false,
  mutatesExternalSystems: false,
  requiresApproval: 'when-risky',
  timeoutMs: 120_000,
  maxOutputBytes: 256 * 1024,
  maxOutputTokens: 8_192,
  redactionProfile: 'default',
};

function defaultPolicyFor(cls: ToolMutationClass): ToolPolicyMetadata {
  return cls === 'read-only' ? { ...READ_ONLY_POLICY_DEFAULT } : { ...MUTATION_POLICY_DEFAULT };
}

function defaultProvenanceFor(cls: ToolMutationClass): ToolProvenanceClass {
  return cls === 'read-only' ? 'repo-trusted' : 'wavemill-generated';
}

/**
 * Return a fully-inflated `RegisteredToolMetadata` from a caller-supplied
 * `ToolMetadata`.  Every missing field is filled from stable defaults so that
 * Tier 1–4 descriptors keep working without touching their registration sites.
 */
export function withDefaultMetadata(metadata: ToolMetadata): RegisteredToolMetadata {
  const family: ToolFamilyId = metadata.family ?? 'core';
  const advanced = isAdvancedFamily(family);
  const local = metadata.logicalId ?? `${family}.${metadata.name}`;
  const logicalId = local.includes('.') ? local : `${family}.${local}`;
  const exposure: ToolExposureMode = metadata.exposure ?? (advanced ? 'opt-in' : 'always');
  const policy = metadata.policy ?? defaultPolicyFor(metadata.class);
  const provenance = metadata.provenance ?? defaultProvenanceFor(metadata.class);
  const certificationRequirement: NativeCertificationRequirement =
    metadata.certificationRequirement ?? (advanced ? 'workflow' : 'none');

  return {
    ...metadata,
    family,
    logicalId,
    exposure,
    policy,
    provenance,
    certificationRequirement,
  };
}

/**
 * Certification ladder order used by the exposure engine. Lower index →
 * weaker certification; the required level is satisfied when the actual level
 * appears at the same or higher index.
 */
export const CERTIFICATION_LEVEL_ORDER: readonly NativeCertificationRequirement[] = Object.freeze([
  'none',
  'read-only',
  'patch',
  'workflow',
]);

// ---------------------------------------------------------------------------
// Tool result metadata (attached additively; optional on all consumers)
// ---------------------------------------------------------------------------

/** Output cap status derived from tool policy and actual details. */
export interface ToolOutputCapMetadata {
  capped: boolean;
  strategy?: OutputCapStrategy;
  limit?: number;
  limitKind?: 'bytes' | 'items' | 'lines';
  originalLength?: number;
  retainedLength?: number;
}

/** Stable provenance fingerprint for a tool invocation. */
export interface ToolProvenanceMetadata {
  tool: string;
  /** First 16 hex chars of SHA-256 over stable-JSON-encoded args. */
  argsFingerprint: string;
}

/** Redaction status for a tool result (content + details). */
export interface ToolRedactionMetadata {
  redacted: boolean;
  matchCount: number;
  categories: string[];
}

/** Identity reported by an external MCP server during `initialize`. */
export interface McpServerIdentity {
  name: string;
  version: string;
}

/**
 * Provenance block attached to results returned by the MCP tool bridge. Every
 * field is derived deterministically — provider proxy identity is config, the
 * logical (server, tool) pair is the descriptor coordinate, the argument
 * digest is the same fingerprint the loop stamps into provenance, and the
 * artifact reference points at the content-addressed raw payload.
 */
export interface McpToolResultMetadata {
  providerProxy: string;
  logicalServer: string;
  logicalTool: string;
  serverIdentity: McpServerIdentity;
  argsFingerprint: string;
  resultArtifactRef?: {
    digest: string;
    byteSize: number;
    path: string;
    truncated?: boolean;
    originalByteSize?: number;
  };
}

/** Aggregate tool result metadata embedded in details.__wavemill and transcript events. */
export interface ToolResultMetadata {
  outputCap?: ToolOutputCapMetadata;
  provenance?: ToolProvenanceMetadata;
  redaction?: ToolRedactionMetadata;
  trust?: ToolTrustMetadata;
  mcp?: McpToolResultMetadata;
}

/** Minimal result shape returned by a Wavemill tool executor. */
export interface WavemillToolResult<TDetails = unknown> {
  /** Text content returned to the model. */
  content: Array<{ type: 'text'; text: string }>;
  /** Structured details for logging or UI rendering. */
  details: TDetails;
  /** Hint to stop the agent loop after this tool batch. */
  terminate?: boolean;
  /** Optional enrichment metadata — attached by the loop, not by executors. */
  metadata?: ToolResultMetadata;
}

/** Tool executor function — Wavemill-owned, compatible with Pi AgentTool.execute. */
export type ToolExecutor<TParameters = unknown, TDetails = unknown> = (
  toolCallId: string,
  params: TParameters,
  signal?: AbortSignal,
) => Promise<WavemillToolResult<TDetails>>;

/**
 * Full descriptor for a Wavemill tool.
 *
 * `parameters` is typed as `unknown` to keep Pi/typebox details out of this
 * interface. The pi-adapter edge casts it when constructing the Pi AgentTool.
 */
export interface ToolDescriptor<TParameters = unknown, TDetails = unknown> {
  metadata: ToolMetadata;
  /** JSON Schema or typebox schema for tool parameters (opaque at this seam). */
  parameters: unknown;
  /** Override the display label; defaults to metadata.name at the adapter edge. */
  label?: string;
  execute: ToolExecutor<TParameters, TDetails>;
}
