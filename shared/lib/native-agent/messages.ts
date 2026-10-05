import type {
  AssistantMessage,
  Context,
  JsonObject,
  JsonValue,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { SessionModelUsage } from '../session-adapters.ts';

// Re-export raw Pi message content types through the messages seam so callers
// can reference them without importing Pi vendor packages directly.
export type { AssistantMessage, Message, TextContent } from '@earendil-works/pi-ai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

const DEFAULT_PI_TIMESTAMP = 0;

// ---------------------------------------------------------------------------
// Native content types
// ---------------------------------------------------------------------------

export interface NativeTextContent {
  type: 'text';
  text: string;
}

export interface NativeThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface NativeToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface NativeToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  content: NativeTextContent[];
}

export type NativeMessageContent =
  | NativeTextContent
  | NativeThinkingContent
  | NativeToolCallContent
  | NativeToolResultContent;

// ---------------------------------------------------------------------------
// Standalone tool types  (canonical; moved from provider.ts)
// ---------------------------------------------------------------------------

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NativeToolResult {
  toolCallId: string;
  toolName: string;
  content: NativeTextContent[];
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
}

export interface AgentToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

/** Backward-compatible alias; prefer AgentToolSchema for new code. */
export type NativeToolSchema = AgentToolSchema;

// ---------------------------------------------------------------------------
// Native usage – structurally matches Pi Usage to keep round-trips lossless
// ---------------------------------------------------------------------------

export interface NativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Canonical AgentMessage variants
// ---------------------------------------------------------------------------

export interface NativeUserMessage {
  role: 'user';
  content: string | NativeTextContent[];
  timestamp?: number;
}

/**
 * AgentTurn is the canonical Wavemill representation of an assistant response.
 * It preserves all Pi metadata fields needed for a lossless round-trip.
 */
export interface AgentTurn {
  role: 'assistant';
  content: (NativeTextContent | NativeThinkingContent | NativeToolCallContent)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: NativeUsage;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
  raw: unknown;
}

export interface NativeToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  toolName: string;
  content: NativeTextContent[];
  details?: unknown;
  isError: boolean;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Declaration-merging extension hook for Wavemill-specific message types
// ---------------------------------------------------------------------------

/**
 * Augment this interface to add custom message variants to AgentMessage.
 *
 * @example
 * ```ts
 * declare module './messages.ts' {
 *   interface CustomAgentMessages {
 *     artifact: { role: 'artifact'; artifactId: string };
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {}

// ---------------------------------------------------------------------------
// Canonical AgentMessage union
// ---------------------------------------------------------------------------

export type AgentMessage =
  | NativeUserMessage
  | AgentTurn
  | NativeToolResultMessage
  | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// Session-level types
// ---------------------------------------------------------------------------

export interface NativeAgentSessionHeader {
  sessionId: string;
  model: string;
  api: string;
  provider: string;
  timestamp: number;
}

export type NativeAgentEvent =
  | { type: 'start'; raw: unknown }
  | { type: 'text_delta'; text: string; raw: unknown }
  | { type: 'tool_call'; toolCall: NativeToolCall; raw: unknown }
  | { type: 'done'; finishReason: string; raw: unknown }
  | { type: 'error'; finishReason: string; raw: unknown };

// ---------------------------------------------------------------------------
// Backward-compatible "history" types used by createPiContext
// (include system role and simpler content shape)
// ---------------------------------------------------------------------------

export type NativeAgentRole = 'system' | 'user' | 'assistant' | 'tool_result';

export interface NativeAgentMessage {
  role: NativeAgentRole;
  content: string | NativeMessageContent[];
  timestamp?: number;
}

/**
 * Backward-compatible alias; AgentTurn is the canonical name.
 * provider.ts ProviderTurnResult.message continues to use this name.
 */
export type NativeAssistantMessage = AgentTurn;

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

export function mapPiUsageToSessionModelUsage(
  usage: Partial<Usage> | null | undefined,
): SessionModelUsage {
  return {
    inputTokens: usage?.input ?? 0,
    cacheCreationTokens: usage?.cacheWrite ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    outputTokens: usage?.output ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Bidirectional Pi ↔ Native mapping
// ---------------------------------------------------------------------------

export function fromPiMessage(message: Message): AgentMessage {
  switch (message.role) {
    case 'user':
      return fromPiUserMessage(message);
    case 'assistant':
      return fromPiAssistantMessage(message);
    case 'toolResult':
      return fromPiToolResultMessage(message);
    case 'system':
      // Pi 1.0 carries the prompt and tool declarations as transcript system
      // messages; Wavemill keeps the prompt in AgentContext.systemPrompt, so
      // there is no canonical AgentMessage for them (HOK-3161).
      throw new Error('fromPiMessage: Pi system messages have no Wavemill AgentMessage representation');
    default:
      return assertNever(message);
  }
}

export function toPiMessage(message: AgentMessage): Message {
  switch (message.role) {
    case 'user':
      return toPiUserMessage(message);
    case 'assistant':
      return toPiAssistantMessage(message);
    case 'tool_result':
      return toPiToolResultMessage(message);
    default:
      throw new Error(
        `toPiMessage: no Pi representation for custom message variant with role "${(message as { role: unknown }).role}"`,
      );
  }
}

// ---------------------------------------------------------------------------
// fromPi helpers
// ---------------------------------------------------------------------------

function fromPiUserMessage(message: UserMessage): NativeUserMessage {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content, timestamp: message.timestamp };
  }
  return {
    role: 'user',
    content: message.content
      .filter((c) => c.type === 'text')
      .map((c) => ({ type: 'text', text: c.text }) satisfies NativeTextContent),
    timestamp: message.timestamp,
  };
}

function fromPiAssistantMessage(message: AssistantMessage): AgentTurn {
  const turn: AgentTurn = {
    role: 'assistant',
    content: message.content.flatMap(
      (c): (NativeTextContent | NativeThinkingContent | NativeToolCallContent)[] => {
        if (c.type === 'text') {
          return [{ type: 'text', text: c.text }];
        }
        if (c.type === 'thinking') {
          const block: NativeThinkingContent = { type: 'thinking', thinking: c.thinking };
          if (c.thinkingSignature !== undefined) block.thinkingSignature = c.thinkingSignature;
          if (c.redacted !== undefined) block.redacted = c.redacted;
          return [block];
        }
        if (c.type === 'toolCall') {
          const block: NativeToolCallContent = {
            type: 'tool_call',
            id: c.id,
            name: c.name,
            arguments: c.arguments as JsonObject,
          };
          if (c.thoughtSignature !== undefined) block.thoughtSignature = c.thoughtSignature;
          return [block];
        }
        return [];
      },
    ),
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    stopReason: message.stopReason,
    timestamp: message.timestamp,
    raw: message,
  };
  if (message.responseModel !== undefined) turn.responseModel = message.responseModel;
  if (message.responseId !== undefined) turn.responseId = message.responseId;
  if (message.errorMessage !== undefined) turn.errorMessage = message.errorMessage;
  return turn;
}

function fromPiToolResultMessage(message: ToolResultMessage): NativeToolResultMessage {
  const result: NativeToolResultMessage = {
    role: 'tool_result',
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content
      .filter((c) => c.type === 'text')
      .map((c) => ({ type: 'text', text: c.text }) satisfies NativeTextContent),
    isError: message.isError,
    timestamp: message.timestamp,
  };
  if (message.details !== undefined) result.details = message.details;
  return result;
}

// ---------------------------------------------------------------------------
// toPi helpers
// ---------------------------------------------------------------------------

function toPiUserMessage(message: NativeUserMessage): UserMessage {
  const content = typeof message.content === 'string'
    ? message.content
    : message.content.map((c) => ({ type: 'text', text: c.text }) satisfies TextContent);
  return {
    role: 'user',
    content,
    timestamp: message.timestamp ?? DEFAULT_PI_TIMESTAMP,
  };
}

function toPiAssistantMessage(message: AgentTurn): AssistantMessage {
  const piMsg: AssistantMessage = {
    role: 'assistant',
    content: message.content.flatMap(
      (c): (TextContent | ThinkingContent | ToolCall)[] => {
        if (c.type === 'text') {
          return [{ type: 'text', text: c.text }];
        }
        if (c.type === 'thinking') {
          const block: ThinkingContent = { type: 'thinking', thinking: c.thinking };
          if (c.thinkingSignature !== undefined) block.thinkingSignature = c.thinkingSignature;
          if (c.redacted !== undefined) block.redacted = c.redacted;
          return [block];
        }
        if (c.type === 'tool_call') {
          const block: ToolCall = {
            type: 'toolCall',
            id: c.id,
            name: c.name,
            arguments: c.arguments as JsonObject,
          };
          if (c.thoughtSignature !== undefined) block.thoughtSignature = c.thoughtSignature;
          return [block];
        }
        return assertNever(c);
      },
    ),
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage as Usage,
    stopReason: message.stopReason as AssistantMessage['stopReason'],
    timestamp: message.timestamp,
  };
  if (message.responseModel !== undefined) piMsg.responseModel = message.responseModel;
  if (message.responseId !== undefined) piMsg.responseId = message.responseId;
  if (message.errorMessage !== undefined) piMsg.errorMessage = message.errorMessage;
  return piMsg;
}

function toPiToolResultMessage(message: NativeToolResultMessage): ToolResultMessage {
  const piMsg: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content.map((c) => ({ type: 'text', text: c.text }) satisfies TextContent),
    isError: message.isError,
    timestamp: message.timestamp ?? DEFAULT_PI_TIMESTAMP,
  };
  if (message.details !== undefined) piMsg.details = message.details as JsonValue;
  return piMsg;
}

// ---------------------------------------------------------------------------
// Backward-compatible helpers for createPiContext / provider seam
// ---------------------------------------------------------------------------

export function toNativeAssistantMessage(message: AssistantMessage): NativeAssistantMessage {
  return fromPiAssistantMessage(message);
}

export function createPiContext(
  messages: NativeAgentMessage[],
  tools?: Context['tools'],
): Context {
  let systemPrompt: string | undefined;
  const piMessages: Message[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text = nativeContentToText(message.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      continue;
    }

    piMessages.push(nativeAgentMessageToPi(message));
  }

  return { systemPrompt, messages: piMessages, tools };
}

// ---------------------------------------------------------------------------
// Internal helpers for NativeAgentMessage → Pi (thin/history-context path)
// ---------------------------------------------------------------------------

function nativeAgentMessageToPi(message: NativeAgentMessage): Message {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: toPiUserContent(message.content),
        timestamp: message.timestamp ?? DEFAULT_PI_TIMESTAMP,
      } satisfies UserMessage;
    case 'assistant':
      return nativeAgentAssistantToPi(message);
    case 'tool_result':
      return nativeAgentToolResultToPi(message);
    case 'system':
      throw new Error('System messages are represented as Pi context.systemPrompt');
    default:
      return assertNever(message.role);
  }
}

function toPiUserContent(content: NativeAgentMessage['content']): UserMessage['content'] {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((item): item is NativeTextContent => item.type === 'text')
    .map((item) => ({ type: 'text', text: item.text }) satisfies TextContent);
}

function nativeAgentAssistantToPi(message: NativeAgentMessage): AssistantMessage {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text' as const, text: message.content }];

  return {
    role: 'assistant',
    content: content.flatMap((item): (TextContent | ThinkingContent | ToolCall)[] => {
      if (item.type === 'text') {
        return [{ type: 'text', text: item.text }];
      }
      if (item.type === 'thinking') {
        return [{ type: 'thinking', thinking: item.thinking, thinkingSignature: item.thinkingSignature, redacted: item.redacted }];
      }
      if (item.type === 'tool_call') {
        return [{ type: 'toolCall', id: item.id, name: item.name, arguments: item.arguments as JsonObject }];
      }
      return [];
    }),
    api: 'wavemill-native-history',
    provider: 'wavemill',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: message.timestamp ?? DEFAULT_PI_TIMESTAMP,
  };
}

function nativeAgentToolResultToPi(message: NativeAgentMessage): ToolResultMessage {
  const result = firstToolResult(message.content);
  if (!result) {
    throw new Error('tool_result messages require tool_result content');
  }
  return {
    role: 'toolResult',
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    content: result.content.map((item) => ({ type: 'text', text: item.text }) satisfies TextContent),
    isError: result.isError ?? false,
    timestamp: message.timestamp ?? DEFAULT_PI_TIMESTAMP,
  };
}

function firstToolResult(content: NativeAgentMessage['content']): NativeToolResultContent | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.find((item): item is NativeToolResultContent => item.type === 'tool_result');
}

function nativeContentToText(content: NativeAgentMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((item): item is NativeTextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}
