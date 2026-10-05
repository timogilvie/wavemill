import {
  createAssistantMessageEventStream,
  registerApiProvider,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type StreamFunction,
  type Tool,
  type Usage,
} from '@earendil-works/pi-ai';
import type { SessionModelUsage } from '../session-adapters.ts';
import {
  createPiContext,
  mapPiUsageToSessionModelUsage,
  toNativeAssistantMessage,
  type AgentToolSchema,
  type NativeAgentMessage,
  type NativeAssistantMessage,
  type NativeToolCall,
} from './messages.ts';
import {
  buildProviderPayloadTrustMetadata,
  type ToolTrustMetadata,
} from './provenance.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './output-limits.ts';

export type ProviderFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'error'
  | 'aborted'
  | 'unknown';

/** Re-export for callers that import NativeToolCall from provider.ts */
export type { NativeToolCall } from './messages.ts';

/** @deprecated Use AgentToolSchema from messages.ts */
export type NativeToolSchema = AgentToolSchema;

export interface ProviderConversationState {
  messages: NativeAgentMessage[];
}

export interface ToolCallingProviderInput {
  model: ProviderModelConfig;
  state: ProviderConversationState;
  tools?: NativeToolSchema[];
  options?: ProviderTurnOptions;
}

export interface ProviderTurnOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  sessionId?: string;
}

export interface ProviderModelConfig {
  id: string;
  name?: string;
  api: string;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: unknown;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
}

export function toProviderRequestModelId(
  config: Pick<ProviderModelConfig, 'id' | 'name' | 'provider' | 'api'>,
): string {
  const name = config.name?.trim();
  if (isNativeOpenAiTransport(config.provider, config.api)) {
    if (name) {
      return name;
    }
    const prefix = `${config.provider}:`;
    if (config.id.startsWith(prefix)) {
      return config.id.slice(prefix.length);
    }
  }
  return config.id;
}

export interface ProviderTurnEvent {
  type: 'start' | 'text_delta' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: NativeToolCall;
  finishReason?: ProviderFinishReason;
  raw: unknown;
}

export interface ProviderTurnResult {
  message: NativeAssistantMessage;
  text: string;
  toolCalls: NativeToolCall[];
  finishReason: ProviderFinishReason;
  usage: SessionModelUsage;
  events: ProviderTurnEvent[];
  raw: unknown;
  rawMetadata: ToolTrustMetadata;
}

export interface ToolCallingProvider {
  createTurn(input: ToolCallingProviderInput): Promise<ProviderTurnResult>;
}

export interface ScriptedPiProviderTurn {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
    | { type: 'tool_call'; id: string; name: string; arguments?: Record<string, unknown> }
  >;
  usage?: Partial<Usage>;
  stopReason?: ProviderFinishReason | 'toolUse';
  errorMessage?: string;
  /**
   * Simulate the provider's `response.model` for this turn (HOK-3143).
   * Pi sets `AssistantMessage.responseModel` only when it differs from the
   * requested id — omit to simulate an echo.
   */
  responseModel?: string;
  /** Simulate the provider's `response.id` for this turn (HOK-3143). */
  responseId?: string;
}

export interface ScriptedPiProviderDefinition {
  api: string;
  provider?: string;
  turns: ScriptedPiProviderTurn[] | ((context: ScriptedProviderContext) => ScriptedPiProviderTurn);
}

export interface ScriptedProviderContext {
  messages: NativeAgentMessage[];
  sawToolResults: boolean;
  rawContext: unknown;
  /** Stream options Pi received for this turn, so tests can assert on
   *  request-shaping fields such as `maxTokens`. */
  options?: SimpleStreamOptions;
}

export function createPiToolCallingProvider(): ToolCallingProvider {
  return new PiToolCallingProvider();
}

export function registerScriptedPiProvider(definition: ScriptedPiProviderDefinition): void {
  let turnIndex = 0;
  const stream: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
    const scriptContext = toScriptedProviderContext(context, options);
    const turn = typeof definition.turns === 'function'
      ? definition.turns(scriptContext)
      : definition.turns[Math.min(turnIndex++, definition.turns.length - 1)];

    if (!turn) {
      throw new Error(`Scripted provider '${definition.api}' has no turns`);
    }

    const message = toPiAssistantMessage(model, definition.provider ?? model.provider, turn);
    const eventStream = createAssistantMessageEventStream();
    eventStream.push({ type: 'start', partial: message });
    eventStream.push({
      type: message.stopReason === 'error' || message.stopReason === 'aborted' ? 'error' : 'done',
      reason: message.stopReason,
      ...(message.stopReason === 'error' || message.stopReason === 'aborted'
        ? { error: message }
        : { message }),
    } as AssistantMessageEvent);
    return eventStream;
  };

  registerApiProvider({ api: definition.api, stream, streamSimple: stream }, `wavemill-native-agent:${definition.api}`);
}

class PiToolCallingProvider implements ToolCallingProvider {
  async createTurn(input: ToolCallingProviderInput): Promise<ProviderTurnResult> {
    const context = createPiContext(input.state.messages, input.tools?.map(toPiTool));
    const model = toPiModel(input.model);
    // An undefined ceiling makes Pi drop `max_tokens` from the payload, which
    // inflates the provider-side credit reservation. See ./output-limits.ts.
    const stream = streamSimple(model, context, {
      ...input.options,
      maxTokens: input.options?.maxTokens ?? model.maxTokens,
    });
    const events: ProviderTurnEvent[] = [];
    let finalMessage: AssistantMessage | undefined;
    let finishReason: ProviderFinishReason = 'unknown';

    for await (const event of stream) {
      events.push(toProviderTurnEvent(event));
      if (event.type === 'done') {
        finalMessage = event.message;
        finishReason = normalizeStopReason(event.reason);
      } else if (event.type === 'error') {
        finalMessage = event.error;
        finishReason = normalizeStopReason(event.reason);
      }
    }

    finalMessage ??= await stream.result();
    finishReason = normalizeStopReason(finalMessage.stopReason);

    const toolCalls = extractToolCalls(finalMessage);
    return {
      message: toNativeAssistantMessage(finalMessage),
      text: extractText(finalMessage),
      toolCalls,
      finishReason,
      usage: mapPiUsageToSessionModelUsage(finalMessage.usage),
      events,
      raw: finalMessage,
      rawMetadata: buildProviderPayloadTrustMetadata(finalMessage),
    };
  }
}

function normalizeStopReason(reason: StopReason | ProviderFinishReason | 'toolUse' | undefined): ProviderFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'error':
    case 'aborted':
      return reason;
    case 'toolUse':
    case 'tool_calls':
      return 'tool_calls';
    default:
      return 'unknown';
  }
}

function toProviderTurnEvent(event: AssistantMessageEvent): ProviderTurnEvent {
  switch (event.type) {
    case 'start':
      return { type: 'start', raw: event };
    case 'text_delta':
      return { type: 'text_delta', text: event.delta, raw: event };
    case 'toolcall_end':
      return { type: 'tool_call', toolCall: toNativeToolCall(event.toolCall), raw: event };
    case 'done':
      return { type: 'done', finishReason: normalizeStopReason(event.reason), raw: event };
    case 'error':
      return { type: 'error', finishReason: normalizeStopReason(event.reason), raw: event };
    default:
      return { type: 'start', raw: event };
  }
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

function extractToolCalls(message: AssistantMessage): NativeToolCall[] {
  return message.content
    .filter((content) => content.type === 'toolCall')
    .map(toNativeToolCall);
}

function toNativeToolCall(toolCall: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>): NativeToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  };
}

function toPiModel(config: ProviderModelConfig): Model<Api> {
  const requestModelId = toProviderRequestModelId(config);
  return {
    id: requestModelId,
    name: config.name ?? requestModelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl ?? 'http://localhost:0/mock',
    headers: config.headers ?? {},
    ...(config.compat !== undefined ? { compat: config.compat } : {}),
    reasoning: config.reasoning ?? false,
    input: config.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 200000,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

function isNativeOpenAiTransport(provider: string, api: string): boolean {
  return (provider === 'openai' && api === 'openai-responses')
    || (provider === 'openrouter' && api === 'openai-completions');
}

function toPiTool(tool: NativeToolSchema): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool['parameters'],
  };
}

function toPiAssistantMessage(
  model: Model<Api>,
  provider: string,
  turn: ScriptedPiProviderTurn,
): AssistantMessage {
  const stopReason = normalizeScriptedStopReason(turn.stopReason);
  return {
    role: 'assistant',
    content: turn.content.map((content) => {
      if (content.type === 'text') {
        return { type: 'text', text: content.text };
      }
      if (content.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: content.thinking,
          ...(content.thinkingSignature !== undefined ? { thinkingSignature: content.thinkingSignature } : {}),
          ...(content.redacted !== undefined ? { redacted: content.redacted } : {}),
        };
      }
      return {
        type: 'toolCall',
        id: content.id,
        name: content.name,
        arguments: content.arguments ?? {},
      };
    }),
    api: model.api,
    provider,
    model: model.id,
    usage: createPiUsage(turn.usage),
    stopReason,
    ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
    ...(turn.responseModel !== undefined ? { responseModel: turn.responseModel } : {}),
    ...(turn.responseId !== undefined ? { responseId: turn.responseId } : {}),
    timestamp: Date.now(),
  };
}

function normalizeScriptedStopReason(reason: ScriptedPiProviderTurn['stopReason']): StopReason {
  if (reason === 'tool_calls') {
    return 'toolUse';
  }
  return reason ?? 'stop';
}

function createPiUsage(usage: Partial<Usage> | undefined): Usage {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: usage?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toScriptedProviderContext(
  context: Context,
  options?: SimpleStreamOptions,
): ScriptedProviderContext {
  return {
    messages: context.messages.map((message): NativeAgentMessage => {
      if (message.role === 'user') {
        return { role: 'user', content: typeof message.content === 'string' ? message.content : message.content };
      }
      if (message.role === 'toolResult') {
        return {
          role: 'tool_result',
          content: [{
            type: 'tool_result',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
            content: message.content
              .filter((content) => content.type === 'text')
              .map((content) => ({ type: 'text', text: content.text })),
          }],
        };
      }
      return toNativeAssistantMessage(message);
    }),
    sawToolResults: context.messages.some((message) => message.role === 'toolResult'),
    rawContext: context,
    ...(options !== undefined ? { options } : {}),
  };
}
