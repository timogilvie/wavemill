/**
 * A fake provider that records the request bytes it receives (HOK-3261).
 *
 * Unlike the scripted provider in `provider.ts`, which answers before any
 * request body exists, this one drives Pi's real `openai-completions`
 * transport: Pi builds the body, runs `onPayload`, serialises it and hands it
 * to `fetch`. The injected `fetch` records those exact bytes and answers with a
 * scripted SSE stream. Tests that care about what goes on the wire (payload
 * capture, request-prefix stability, request replay) use this.
 */

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { streamSimple as streamSimpleOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';

export interface RecordingProviderTurn {
  text?: string;
  /** Reasoning-only content, streamed as `delta.reasoning`. */
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Provider-reported model for this response; defaults to the requested id. */
  responseModel?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
}

export interface RecordedRequest {
  url: string;
  /** Request body exactly as sent. */
  body: string;
}

export interface RecordingProvider {
  streamFn: StreamFn;
  requests: RecordedRequest[];
}

export function createRecordingProvider(
  turns: RecordingProviderTurn[] | ((requestIndex: number, body: Record<string, unknown>) => RecordingProviderTurn),
): RecordingProvider {
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    const index = requests.length;
    requests.push({ url: String(input instanceof Request ? input.url : input), body });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const turn = typeof turns === 'function'
      ? turns(index, parsed)
      : turns[Math.min(index, turns.length - 1)];
    return createSseResponse(toChunks(turn, String(parsed.model), index));
  };

  const streamFn: StreamFn = (model, context, options) => streamSimpleOpenAICompletions(
    model as Parameters<typeof streamSimpleOpenAICompletions>[0],
    context,
    { ...options, apiKey: 'fixture-key', fetch: fetchImpl as typeof fetch, maxRetries: 0 },
  );

  return { streamFn, requests };
}

function toChunks(turn: RecordingProviderTurn, requestModel: string, index: number): unknown[] {
  const id = `chatcmpl-recording-${index}`;
  const model = turn.responseModel ?? requestModel;
  const chunks: unknown[] = [];
  if (turn.reasoning) {
    chunks.push({ id, model, choices: [{ index: 0, delta: { reasoning: turn.reasoning } }] });
  }
  if (turn.text) {
    chunks.push({ id, model, choices: [{ index: 0, delta: { content: turn.text } }] });
  }
  for (const [callIndex, call] of (turn.toolCalls ?? []).entries()) {
    chunks.push({
      id,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: callIndex,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
      }],
    });
  }
  const usage = turn.usage ?? { prompt_tokens: 10, completion_tokens: 5 };
  chunks.push({
    id,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
      ...(usage.cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
    },
  });
  chunks.push('[DONE]');
  return chunks;
}

function createSseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        const line = event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
