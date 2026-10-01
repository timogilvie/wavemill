/**
 * Canonical session event stream schema.
 *
 * Versioned discriminated union for canonical provenance: session lifecycle,
 * model requests/responses, tool calls/results, policy decisions, recovery, lineage.
 *
 * All events share:
 * - eventId: Unique, deterministic event identifier
 * - seq: Monotonic sequence number per session
 * - timestamp: ISO 8601 or milliseconds since epoch
 * - sessionId: Wavemill session ID
 * - traceId: Request trace ID (correlates across retries)
 * - phase: Execution phase (planning, coding, review, etc.)
 * - schemaVersion: Stream schema version (top-level: "1")
 * - causedByEventId: Optional causal link to triggering event
 */

// ---------------------------------------------------------------------------
// Shared types and base event shape
// ---------------------------------------------------------------------------

export const SESSION_STREAM_SCHEMA_VERSION = '1';

export interface EventBase {
  /** Unique, stable event ID (UUID or hash-based). */
  eventId: string;
  /** Monotonic sequence number within session. */
  seq: number;
  /** ISO 8601 timestamp or milliseconds since epoch. */
  timestamp: string | number;
  /** Wavemill session ID. */
  sessionId: string;
  /** Request trace ID correlating across retries. */
  traceId: string;
  /** Execution phase (planning, coding, review, etc.). */
  phase: string;
  /** Top-level schema version. */
  schemaVersion: string;
  /** Optional causal link to triggering event. */
  causedByEventId?: string;
}

// ---------------------------------------------------------------------------
// Digest and artifact reference types
// ---------------------------------------------------------------------------

/** Reference to a resource by stable ID and hash. */
export interface ResourceRef {
  resourceId: string;
  contentHash: string;
  version?: string;
}

/** Reference to a content-addressed artifact. */
export interface ArtifactRef {
  /** SHA-256 digest. */
  digest: string;
  /** Byte size of retained content. */
  byteSize: number;
  /** Path relative to .wavemill/artifacts/ or full artifact store path. */
  path: string;
  /** Truncation status. */
  truncated?: boolean;
  /** Original byte size before truncation (if truncated). */
  originalByteSize?: number;
}

/** Redaction metadata for tool results. */
export interface RedactionMetadata {
  /** Whether content was redacted. */
  redacted: boolean;
  /** Summary of what was redacted (e.g., "secrets, apiKeys"). */
  redactionSummary?: string;
  /** Trust level (verified, inferred, unknown). */
  trustLevel?: 'verified' | 'inferred' | 'unknown';
}

// ---------------------------------------------------------------------------
// Session lifecycle and lineage
// ---------------------------------------------------------------------------

export interface SessionStartedEvent extends EventBase {
  type: 'session_started';
  /** Wavemill session ID (repeated for clarity). */
  sessionId: string;
  /** Parent session ID if this is a child (subagent, fork, recovery). */
  parentSessionId?: string;
  /** Initial model/provider/runtime config digest. */
  initialConfigDigest: string;
  /** Manifest ID for this session's resources. */
  manifestId?: string;
}

export interface SessionEndedEvent extends EventBase {
  type: 'session_ended';
  /** Stop reason (completion, error, abort, etc.). */
  stopReason: string;
  /** Total turns completed. */
  totalTurns: number;
  /** Total tool calls. */
  totalToolCalls: number;
  /** Total tokens used (if available). */
  totalTokens?: number;
}

/** Recovery/resume event: session reconstituted after crash or interruption. */
export interface SessionResumeEvent extends EventBase {
  type: 'session_resume';
  /** Event ID of last committed event in prior session. */
  lastCommittedEventId?: string;
  /** Sequence number of resume point. */
  resumeFromSeq?: number;
  /** Reason for resume (timeout, manual, crash, interrupt). */
  reason: string;
}

/** Fork event: child session spawned from parent. */
export interface SessionForkEvent extends EventBase {
  type: 'session_fork';
  /** Parent session ID. */
  parentSessionId: string;
  /** Child session ID being forked. */
  childSessionId: string;
  /** Subagent type (if applicable). */
  subagentType?: string;
  /** Fork reason (delegation, parallel work, etc.). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Model turn provenance
// ---------------------------------------------------------------------------

/** Request event: before model call, records context assembly provenance. */
export interface ModelRequestEvent extends EventBase {
  type: 'model_request';
  /** Call ID for linking response/tool events. */
  callId: string;
  /** Turn index. */
  turnIndex: number;
  /** Model provider (openai, anthropic, etc.). */
  provider: string;
  /** Model ID sent to provider. */
  modelId: string;
  /** Temperature, max tokens, and other config. */
  config: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
  };
  /** Final context digest (all messages + system prompt). */
  contextDigest: string;
  /** Context size in tokens (if known). */
  contextTokens?: number;
  /** Prompt resource references and hashes. */
  promptRefs: ResourceRef[];
  /** Injected context references (from features, epics, etc.). */
  injectedContextRefs?: ResourceRef[];
  /** Policy-exposed tool menu digest. */
  toolMenuDigest?: string;
  /** Provider-sent tool schemas digest. */
  providerToolsDigest?: string;
  /** Policy config version/digest. */
  policyConfigDigest?: string;
  /** Turns remaining in the loop budget before this request fired. */
  turnBudgetRemaining?: number;
  /** Tool calls remaining in the loop budget before this request fired. */
  toolCallBudgetRemaining?: number;
  /** Cumulative tokens (input + output) spent on the trace before this request fired. */
  tokensUsedSoFar?: number;
}

/** Response event: after model call, captures assistant message. */
export interface ModelResponseEvent extends EventBase {
  type: 'model_response';
  /** Refers to model_request eventId. */
  requestEventId: string;
  /** Call ID linking to request. */
  callId: string;
  /** Model actually used (may differ from requested). */
  actualModel?: string;
  /** Stop reason (end_turn, tool_use, max_tokens, error). */
  stopReason: string;
  /** Content summary: brief text, tool call count, etc. */
  contentSummary?: {
    textLength?: number;
    toolCallCount?: number;
  };
  /** Token usage if available. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Tool policy and execution
// ---------------------------------------------------------------------------

/** Policy decision event: before tool call, records policy allow/deny. */
export interface ToolPolicyDecisionEvent extends EventBase {
  type: 'tool_policy_decision';
  /** Call ID of the proposed tool call. */
  callId: string;
  /** Tool name. */
  toolName: string;
  /** Policy decision: allow or deny. */
  decision: 'allow' | 'deny';
  /** Reason for denial (if denied). */
  denialReason?: string;
  /** Policy config digest applied. */
  policyConfigDigest?: string;
}

/** Tool call event: tool execution initiated. */
export interface ToolCallEvent extends EventBase {
  type: 'tool_call';
  /** Unique call ID. */
  callId: string;
  /** Tool name. */
  toolName: string;
  /** Arguments digest (secure summary, not full content). */
  argumentsDigest?: string;
  /** Argument count/structure summary. */
  argumentsSummary?: string;
}

/** Tool result event: tool execution completed. */
export interface ToolResultEvent extends EventBase {
  type: 'tool_result';
  /** Call ID linking to tool_call. */
  callId: string;
  /** Tool name. */
  toolName: string;
  /** Success or error. */
  isError: boolean;
  /** Result content summary (first line or structured summary). */
  contentSummary?: string;
  /** Result byte size. */
  byteSize?: number;
  /** If result was truncated in transcript, artifact reference. */
  artifactRef?: ArtifactRef;
  /** Redaction metadata. */
  redaction?: RedactionMetadata;
  /** Wavemill metadata extracted from tool result. */
  wavemillMetadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Compaction and command/mutation outcomes
// ---------------------------------------------------------------------------

/** Compaction event: context compaction applied. */
export interface CompactionEvent extends EventBase {
  type: 'compaction';
  /** Compaction strategy (replay, summary, truncation). */
  strategy: string;
  /** Events/messages affected. */
  affectedEventCount?: number;
  /** Context digest before compaction. */
  beforeContextDigest?: string;
  /** Context digest after compaction. */
  afterContextDigest?: string;
  /** Artifact reference if compacted history stored. */
  artifactRef?: ArtifactRef;
}

/** Command or mutation outcome event. */
export interface MutationOutcomeEvent extends EventBase {
  type: 'mutation_outcome';
  /** Command/mutation type (git, filesystem, API, etc.). */
  commandType: string;
  /** Command summary (e.g., "git commit message"). */
  commandSummary?: string;
  /** Success or error. */
  isError: boolean;
  /** Outcome summary. */
  outcomeSummary?: string;
  /** Linked tool call if this is a tool result artifact. */
  toolCallId?: string;
}

/** Approval event: approval request, grant, or denial. */
export interface ApprovalEvent extends EventBase {
  type: 'approval';
  /** Approval stage (requesting, ready, approved, denied). */
  stage: 'requesting' | 'ready' | 'approved' | 'denied';
  /** Human approval ID if available. */
  approvalId?: string;
  /** Reason for denial or notes. */
  notes?: string;
}

/** Retry event: retry initiated after prior failure. */
export interface RetryEvent extends EventBase {
  type: 'retry';
  /** Event ID of the failed attempt. */
  failedEventId: string;
  /** Retry reason. */
  reason: string;
  /** Retry count. */
  retryCount: number;
}

// ---------------------------------------------------------------------------
// Menu and provider schemas
// ---------------------------------------------------------------------------

/** Tool menu event: policy-exposed tool menu snapshot. */
export interface ToolMenuEvent extends EventBase {
  type: 'tool_menu';
  /** Tools exposed by policy. */
  toolNames: string[];
  /** Menu digest. */
  digest: string;
  /** Tool menu artifact reference (if large). */
  artifactRef?: ArtifactRef;
}

/** Provider tools event: provider-sent tool schemas snapshot. */
export interface ProviderToolsEvent extends EventBase {
  type: 'provider_tools';
  /** Tool count from provider. */
  toolCount: number;
  /** Schemas digest. */
  digest: string;
  /** Artifact reference. */
  artifactRef?: ArtifactRef;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type SessionEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | SessionResumeEvent
  | SessionForkEvent
  | ModelRequestEvent
  | ModelResponseEvent
  | ToolPolicyDecisionEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompactionEvent
  | MutationOutcomeEvent
  | ApprovalEvent
  | RetryEvent
  | ToolMenuEvent
  | ProviderToolsEvent;

// ---------------------------------------------------------------------------
// Validation and parsing helpers
// ---------------------------------------------------------------------------

export class SessionStreamParseError extends Error {
  readonly line: string;
  readonly lineNumber: number;

  constructor(message: string, line: string, lineNumber: number) {
    super(message);
    this.name = 'SessionStreamParseError';
    this.line = line;
    this.lineNumber = lineNumber;
  }
}

/**
 * Parse a session event stream JSONL string into typed SessionEvent records.
 * Skips blank lines, fails fast on malformed JSON.
 */
export function parseSessionEventJsonl(content: string): SessionEvent[] {
  const lines = content.split('\n');
  const events: SessionEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SessionStreamParseError(
        `Malformed JSONL at line ${i + 1}: ${line.slice(0, 80)}`,
        line,
        i + 1,
      );
    }
    events.push(parsed as SessionEvent);
  }
  return events;
}

/**
 * Filter events by type name.
 */
export function filterEventsByType<T extends SessionEvent['type']>(
  events: SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
}
