/**
 * Append-only JSONL transcript writer and NativeAgentEvent derivation.
 *
 * Derives transcript-level `TranscriptEvent`s from Pi's `AgentEvent` stream and
 * writes them to an append-only JSONL file. Redaction runs before serialization.
 *
 * ## Raw history vs replay history
 *
 * `assistant_message` events carry two projections of the same content:
 *
 * - `rawContent`: all content blocks (text, thinking, tool_call) with the
 *   provider-level `raw` payload stripped. Use for debugging and auditing.
 * - `replayContent`: replay-safe text, thinking, and tool_call blocks with
 *   provider raw payloads stripped. Use for context reconstruction in future
 *   resume/compaction work.
 *
 * Later epics that compact sessions for replay should consume `replayContent`
 * directly rather than re-deriving it from `rawContent`.
 *
 * ## Redaction
 *
 * Redaction runs before any event is serialized. The default policy:
 * - Strips raw provider payloads from assistant content.
 * - Masks common secret-bearing keys in tool result details
 *   (`authorization`, `apiKey`, `token`, `secret`, `password`, `key`).
 * - Preserves tool result text content so downstream debugging remains possible.
 *
 * Pass a custom `redact` function to `TranscriptWriterOptions` to override the
 * policy for a specific integration without changing transcript code.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ReplayCompactionEvent } from './compaction.ts';
import type { CommandTranscriptEventData } from './command-transcript.ts';
import { writeCleanupSummaryEvent, type CleanupDecision, type CleanupReason, type CleanupReport, type TreeState } from './cleanup.ts';
import type { ToolResultMetadata } from './tools/types.ts';
import { redactSecrets, redactSecretsInValue } from './tools/redaction.ts';
import { computeMcpArgumentsDigest, isMcpToolName } from './tools/mcp.ts';
import type { ApprovalLifecycleEntry } from './workflow-tools/approval-gate.ts';

// ---------------------------------------------------------------------------
// Transcript event types
// (distinct from provider-turn NativeAgentEvent in messages.ts)
// ---------------------------------------------------------------------------

interface TranscriptEventBase {
  seq: number;
  sessionId: string;
  timestamp: number;
}

export interface TranscriptSessionStarted extends TranscriptEventBase {
  type: 'session_started';
  model: string;
  api: string;
  provider: string;
  worktreePath?: string;
  gitBranch?: string;
}

export interface TranscriptTurnStarted extends TranscriptEventBase {
  type: 'turn_started';
  turnIndex: number;
}

export interface TranscriptTurnEnded extends TranscriptEventBase {
  type: 'turn_ended';
  turnIndex: number;
  stopReason: string;
  toolResultCount: number;
}

export type TranscriptRawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };

export type TranscriptReplayContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };

export interface TranscriptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TranscriptAssistantMessage extends TranscriptEventBase {
  type: 'assistant_message';
  model: string;
  responseModel?: string;
  responseId?: string;
  stopReason: string;
  errorMessage?: string;
  usage?: TranscriptUsage;
  /** Raw history: all content blocks, provider payload stripped. */
  rawContent: TranscriptRawContentBlock[];
  /** Replay history: replay-safe content for context reconstruction. */
  replayContent: TranscriptReplayContentBlock[];
  redacted: boolean;
}

export interface TranscriptToolStarted extends TranscriptEventBase {
  type: 'tool_started';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface TranscriptToolResult extends TranscriptEventBase {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** First text line of the result, redacted. */
  content: string;
  /** Redacted structured details, if present. */
  details?: unknown;
  redacted: boolean;
  /** Optional enrichment metadata extracted from details.__wavemill by the loop. */
  metadata?: ToolResultMetadata;
}

export interface TranscriptCommandResult extends TranscriptEventBase, CommandTranscriptEventData {}

export interface TranscriptCompactionEvent extends TranscriptEventBase, ReplayCompactionEvent {}

export interface TranscriptCleanupReport extends TranscriptEventBase {
  type: 'cleanup_report';
  reason: CleanupReason;
  finalTreeState: TreeState;
  cleanupDecision: CleanupDecision;
  notes?: string[];
}

export interface TranscriptSessionEnded extends TranscriptEventBase {
  type: 'session_ended';
  messageCount: number;
}

/** Approval lifecycle event written to the transcript for each request/resolution (HOK-2364). */
export interface TranscriptApprovalEvent extends TranscriptEventBase, ApprovalLifecycleEntry {}

export type TranscriptEvent =
  | TranscriptSessionStarted
  | TranscriptTurnStarted
  | TranscriptTurnEnded
  | TranscriptAssistantMessage
  | TranscriptToolStarted
  | TranscriptToolResult
  | TranscriptCommandResult
  | TranscriptCompactionEvent
  | TranscriptCleanupReport
  | TranscriptSessionEnded
  | TranscriptApprovalEvent;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Default redaction function.
 *
 * Delegates to redactSecretsInValue which:
 * - Masks values under known secret key names (authorization, apiKey, token, …)
 * - Pattern-redacts all string leaves using high-confidence secret regexes.
 *
 * Replace to customize policy without changing transcript code.
 */
export function defaultRedact(value: unknown): unknown {
  return redactSecretsInValue(value).value;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Tool-call arguments as persisted in the transcript. MCP proxy calls never
 * persist their raw arguments (HOK-3056): they are replaced by the canonical
 * SHA-256 digest recorded in the tool result's `metadata.mcp`, so replay can
 * still match calls to results without the raw values.
 */
function persistedToolCallArguments(name: string, args: unknown): Record<string, unknown> {
  if (isMcpToolName(name)) {
    const inner = (args as { arguments?: unknown } | undefined)?.arguments;
    return { argumentsDigest: computeMcpArgumentsDigest(inner ?? {}), redacted: 'mcp-arguments' };
  }
  return redactSecretsInValue(args as Record<string, unknown>).value as Record<string, unknown>;
}

function extractRawContent(message: AssistantMessage): TranscriptRawContentBlock[] {
  const blocks: TranscriptRawContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: redactSecrets(block.text).text });
    } else if (block.type === 'thinking') {
      const tb: TranscriptRawContentBlock & { type: 'thinking' } = {
        type: 'thinking',
        thinking: redactSecrets(block.thinking).text,
      };
      if (block.thinkingSignature !== undefined) tb.thinkingSignature = block.thinkingSignature;
      if (block.redacted !== undefined) tb.redacted = block.redacted;
      blocks.push(tb);
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: persistedToolCallArguments(block.name, block.arguments),
      });
    }
  }
  return blocks;
}

function extractReplayContent(message: AssistantMessage): TranscriptReplayContentBlock[] {
  const blocks: TranscriptReplayContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: redactSecrets(block.text).text });
    } else if (block.type === 'thinking') {
      const tb: TranscriptReplayContentBlock & { type: 'thinking' } = {
        type: 'thinking',
        thinking: redactSecrets(block.thinking).text,
      };
      if (block.thinkingSignature !== undefined) tb.thinkingSignature = block.thinkingSignature;
      if (block.redacted !== undefined) tb.redacted = block.redacted;
      blocks.push(tb);
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: persistedToolCallArguments(block.name, block.arguments),
      });
    }
  }
  return blocks;
}

function extractUsage(message: AssistantMessage): TranscriptUsage | undefined {
  const u = message.usage;
  if (!u) return undefined;
  const usage: TranscriptUsage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
  if (u.cost) {
    usage.cost = {
      input: u.cost.input,
      output: u.cost.output,
      cacheRead: u.cost.cacheRead,
      cacheWrite: u.cost.cacheWrite,
      total: u.cost.total,
    };
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Pluggable redaction function. Receives an arbitrary value and returns a redacted copy. */
export type RedactFn = (value: unknown) => unknown;

export interface TranscriptWriterOptions {
  /** Session identifier written to every event. */
  sessionId: string;
  /** Initial model identifier (from AgentLoopConfig). Individual message events carry the actual model used. */
  model: string;
  api: string;
  provider: string;
  worktreePath?: string;
  gitBranch?: string;
  /** Absolute path to the JSONL transcript file. Parent directory is created if needed. */
  path: string;
  /** Override to pin timestamps in tests. Defaults to Date.now. */
  clock?: () => number;
  /** Override to apply a custom redaction policy. Defaults to defaultRedact. */
  redact?: RedactFn;
}

/**
 * Append-only JSONL transcript writer.
 *
 * Call `handleEvent(piEvent)` for every event from the Pi `agentLoop` stream.
 * Derived `TranscriptEvent`s are redacted and appended to the JSONL file one
 * line at a time. Returns the derived event (or null for skipped events) so
 * callers can inspect events without re-reading the file.
 */
export class TranscriptWriter {
  private seq = 0;
  private turnIndex = 0;
  private readonly options: TranscriptWriterOptions;
  private readonly redactFn: RedactFn;
  private readonly clockFn: () => number;

  constructor(options: TranscriptWriterOptions) {
    this.options = options;
    this.redactFn = options.redact ?? defaultRedact;
    this.clockFn = options.clock ?? (() => Date.now());
    mkdirSync(dirname(options.path), { recursive: true });
  }

  /** Derive and write a transcript event. Returns null for skipped Pi events. */
  handleEvent(event: AgentEvent): TranscriptEvent | null {
    const derived = this.derive(event);
    if (derived !== null) {
      this.append(derived);
    }
    return derived;
  }

  /**
   * Write a pre-built transcript event directly. Useful for error or sentinel
   * events that are not derived from a Pi AgentEvent.
   */
  write(event: TranscriptEvent): void {
    this.append(event);
  }

  writeCommandEvent(event: CommandTranscriptEventData): TranscriptCommandResult {
    const transcriptEvent: TranscriptCommandResult = {
      ...this.base(),
      ...event,
    };
    this.append(transcriptEvent);
    return transcriptEvent;
  }

  /** Write an approval lifecycle event (requested, granted, denied, expired) to the transcript. */
  writeApprovalEvent(entry: ApprovalLifecycleEntry): TranscriptApprovalEvent {
    const transcriptEvent: TranscriptApprovalEvent = {
      ...this.base(),
      ...entry,
    };
    this.append(transcriptEvent);
    return transcriptEvent;
  }

  writeCompactionEvent(event: ReplayCompactionEvent): TranscriptCompactionEvent {
    const transcriptEvent: TranscriptCompactionEvent = {
      ...this.base(),
      ...event,
    };
    this.append(transcriptEvent);
    return transcriptEvent;
  }

  writeCleanupReport(report: CleanupReport): TranscriptCleanupReport {
    const transcriptEvent: TranscriptCleanupReport = {
      ...this.base(),
      ...writeCleanupSummaryEvent(report),
    };
    this.append(transcriptEvent);
    return transcriptEvent;
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private base(): TranscriptEventBase {
    return {
      seq: this.nextSeq(),
      sessionId: this.options.sessionId,
      timestamp: this.clockFn(),
    };
  }

  private derive(event: AgentEvent): TranscriptEvent | null {
    switch (event.type) {
      case 'agent_start':
        return {
          ...this.base(),
          type: 'session_started',
          model: this.options.model,
          api: this.options.api,
          provider: this.options.provider,
          ...(this.options.worktreePath !== undefined && { worktreePath: this.options.worktreePath }),
          ...(this.options.gitBranch !== undefined && { gitBranch: this.options.gitBranch }),
        } satisfies TranscriptSessionStarted;

      case 'turn_start':
        return {
          ...this.base(),
          type: 'turn_started',
          turnIndex: this.turnIndex,
        } satisfies TranscriptTurnStarted;

      case 'turn_end': {
        const assistantMsg = event.message as AssistantMessage;
        const stopReason = (typeof assistantMsg?.stopReason === 'string')
          ? assistantMsg.stopReason
          : 'unknown';
        const result: TranscriptTurnEnded = {
          ...this.base(),
          type: 'turn_ended',
          turnIndex: this.turnIndex,
          stopReason,
          toolResultCount: event.toolResults.length,
        };
        this.turnIndex++;
        return result;
      }

      case 'message_end': {
        const msg = event.message;
        if ((msg as { role?: string }).role !== 'assistant') return null;
        const assistantMsg = msg as AssistantMessage;
        const rawContent = extractRawContent(assistantMsg);
        const replayContent = extractReplayContent(assistantMsg);
        const usage = extractUsage(assistantMsg);
        const result: TranscriptAssistantMessage = {
          ...this.base(),
          type: 'assistant_message',
          model: assistantMsg.model,
          stopReason: assistantMsg.stopReason,
          rawContent,
          replayContent,
          redacted: true,
          ...(usage !== undefined && { usage }),
        };
        if (assistantMsg.responseModel !== undefined) result.responseModel = assistantMsg.responseModel;
        if (assistantMsg.responseId !== undefined) result.responseId = assistantMsg.responseId;
        if (assistantMsg.errorMessage !== undefined) {
          result.errorMessage = redactSecrets(assistantMsg.errorMessage).text;
        }
        return result;
      }

      case 'tool_execution_start':
        return {
          ...this.base(),
          type: 'tool_started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args as Record<string, unknown>,
        } satisfies TranscriptToolStarted;

      case 'tool_execution_end': {
        const resultObj = event.result as {
          content?: Array<{ type?: string; text?: string }>;
          details?: unknown;
        } | null | undefined;

        // Redact content text before transcript persistence.
        const rawText = resultObj?.content?.find((c) => c?.type === 'text')?.text ?? '';
        const contentRedaction = redactSecrets(rawText);
        const redactedText = contentRedaction.text;

        // Extract __wavemill metadata block embedded by the loop's afterToolCall.
        let metadata: ToolResultMetadata | undefined;
        let rawDetailsForRedact = resultObj?.details;
        if (
          resultObj &&
          typeof resultObj === 'object' &&
          'metadata' in resultObj
        ) {
          metadata = (resultObj as { metadata?: ToolResultMetadata }).metadata;
        }
        if (
          rawDetailsForRedact !== null &&
          rawDetailsForRedact !== undefined &&
          typeof rawDetailsForRedact === 'object' &&
          !Array.isArray(rawDetailsForRedact) &&
          '__wavemill' in (rawDetailsForRedact as Record<string, unknown>)
        ) {
          const d = rawDetailsForRedact as Record<string, unknown>;
          metadata = (d.__wavemill as ToolResultMetadata) ?? metadata;
          // Strip __wavemill so it is not stored in transcript details.
          const { __wavemill: _dropped, ...rest } = d;
          rawDetailsForRedact = Object.keys(rest).length > 0 ? rest : undefined;
        }

        // Apply caller-supplied redact fn (default: defaultRedact via redactSecretsInValue).
        const redactedDetails = rawDetailsForRedact !== undefined
          ? this.redactFn(rawDetailsForRedact)
          : undefined;

        const anyRedacted =
          contentRedaction.redacted ||
          (redactedDetails !== undefined && !isDeepStrictEqual(redactedDetails, rawDetailsForRedact));

        const toolResult: TranscriptToolResult = {
          ...this.base(),
          type: 'tool_result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          content: redactedText,
          redacted: anyRedacted,
        };
        if (redactedDetails !== undefined) toolResult.details = redactedDetails;
        if (metadata !== undefined) toolResult.metadata = metadata;
        return toolResult;
      }

      case 'agent_end':
        return {
          ...this.base(),
          type: 'session_ended',
          messageCount: event.messages.length,
        } satisfies TranscriptSessionEnded;

      // Intentionally skipped: message_start, message_update, tool_execution_update
      default:
        return null;
    }
  }

  private append(event: TranscriptEvent): void {
    appendFileSync(this.options.path, JSON.stringify(event) + '\n', 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Pure derivation (stateless, for testing or batch processing)
// ---------------------------------------------------------------------------

/**
 * Derive all transcript events from a sequence of Pi AgentEvents without writing to disk.
 *
 * @param events - Full ordered sequence from one agentLoop run.
 * @param opts - Session metadata and optional overrides.
 * @returns Ordered array of derived TranscriptEvents (skipped Pi events omitted).
 */
export function deriveTranscriptEvents(
  events: AgentEvent[],
  opts: Omit<TranscriptWriterOptions, 'path'>,
): TranscriptEvent[] {
  const writer = new TranscriptWriter({
    ...opts,
    path: '/dev/null',
  });
  const result: TranscriptEvent[] = [];
  for (const ev of events) {
    const derived = writer.handleEvent(ev);
    if (derived !== null) result.push(derived);
  }
  return result;
}

// ---------------------------------------------------------------------------
// JSONL parse utilities
// ---------------------------------------------------------------------------

export class TranscriptParseError extends Error {
  readonly line: string;
  readonly lineNumber: number;

  constructor(message: string, line: string, lineNumber: number) {
    super(message);
    this.name = 'TranscriptParseError';
    this.line = line;
    this.lineNumber = lineNumber;
  }
}

/**
 * Parse a session JSONL string into typed TranscriptEvent records.
 *
 * Fails fast on malformed lines — throws `TranscriptParseError` on the first
 * line that cannot be parsed as JSON. Blank lines are skipped.
 */
export function parseTranscriptJsonl(content: string): TranscriptEvent[] {
  const lines = content.split('\n');
  const events: TranscriptEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TranscriptParseError(
        `Malformed JSONL at line ${i + 1}: ${line.slice(0, 80)}`,
        line,
        i + 1,
      );
    }
    events.push(parsed as TranscriptEvent);
  }
  return events;
}

/**
 * Extract replay-safe history from a parsed transcript.
 *
 * Returns only the `replayContent` from each `assistant_message` event, in order.
 * Suitable for reconstructing LLM context without full debug payloads.
 */
export function extractReplayHistory(events: TranscriptEvent[]): TranscriptReplayContentBlock[][] {
  return events
    .filter((e): e is TranscriptAssistantMessage => e.type === 'assistant_message')
    .map((e) => e.replayContent);
}

/**
 * Extract raw debug history from a parsed transcript.
 *
 * Returns the `rawContent` from each `assistant_message` event, in order.
 * Includes thinking blocks; provider payloads are stripped.
 */
export function extractRawHistory(events: TranscriptEvent[]): TranscriptRawContentBlock[][] {
  return events
    .filter((e): e is TranscriptAssistantMessage => e.type === 'assistant_message')
    .map((e) => e.rawContent);
}
