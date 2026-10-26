/**
 * Resend a captured native request (HOK-3261).
 *
 * `payload-capture.ts` keeps the last request bodies a native stage sent.
 * This module resends one of them, optionally edited with a jq expression, so
 * an operator can test a prompt fix against the exact request that misbehaved:
 * "would the model still have answered that way if this block were present?"
 *
 * The body goes out through Pi's own transport for the captured api: the
 * request is built as usual and `onPayload` swaps in the captured body, so
 * auth, headers, streaming and response parsing are the ones the native loop
 * uses. Operator tooling only; the mill never calls this.
 *
 * @module request-replay
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createNativeModelsCollection } from './models.ts';
import { extractProviderReportedIdentity } from './provider-identity.ts';
import {
  buildOpenAiResponsesModel,
  buildOpenRouterModel,
  OPENAI_NATIVE_PROVIDER,
  OPENROUTER_NATIVE_PROVIDER,
} from './providers.ts';
import { NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION, type CapturedPayloadRecord } from './payload-capture.ts';

/** Bad input (unreadable capture, invalid jq): the CLI exits 2. */
export class ReplayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayInputError';
  }
}

export type ReplayContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; chars: number }
  | { type: 'toolCall'; name: string; arguments: unknown };

export interface ReplayResult {
  provider: string;
  api: string;
  requestModel: string;
  responseModel: string | null;
  responseId: string | null;
  stopReason: string;
  errorMessage?: string;
  usage?: AssistantMessage['usage'];
  content: ReplayContentBlock[];
  /** True when `--patch` edited the body before it was sent. */
  patched: boolean;
}

export interface ReplayNativeRequestOptions {
  record: CapturedPayloadRecord;
  /** jq expression applied to the captured body before it is sent. */
  patch?: string;
  /** Override the provider endpoint (e.g. a local recorder). */
  baseUrl?: string;
  /** Environment the provider auth reads (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Transport override for tests; defaults to the native Models collection. */
  streamFn?: StreamFn;
  signal?: AbortSignal;
}

export function readCapturedPayload(filePath: string): CapturedPayloadRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new ReplayInputError(`cannot read captured payload ${filePath}: ${(error as Error).message}`);
  }
  const record = parsed as Partial<CapturedPayloadRecord> | null;
  if (
    !record
    || typeof record !== 'object'
    || record.schemaVersion !== NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION
    || typeof record.provider !== 'string'
    || typeof record.api !== 'string'
    || typeof record.requestModel !== 'string'
    || record.payload === null
    || typeof record.payload !== 'object'
  ) {
    throw new ReplayInputError(
      `${filePath} is not a native payload capture (schemaVersion ${NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION} with provider, api, requestModel and payload)`,
    );
  }
  return record as CapturedPayloadRecord;
}

/** Apply a jq expression to a request body. The expression must yield one JSON object. */
export function applyJqPatch(body: unknown, expression: string): Record<string, unknown> {
  const result = spawnSync('jq', ['-c', expression], { input: JSON.stringify(body), encoding: 'utf-8' });
  // jq rejecting the filter exits before reading all of stdin, so spawnSync surfaces EPIPE
  // alongside the real exit status; trust the status when the process actually ran.
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  if (spawnError && !(spawnError.code === 'EPIPE' && result.status !== null)) {
    throw new ReplayInputError(`cannot run jq: ${spawnError.message}`);
  }
  if (result.status !== 0) {
    throw new ReplayInputError(`jq rejected --patch ${JSON.stringify(expression)}: ${result.stderr.trim()}`);
  }
  const lines = result.stdout.trim().split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new ReplayInputError(`--patch must produce exactly one JSON value, got ${lines.length}`);
  }
  const patched = JSON.parse(lines[0]) as unknown;
  if (patched === null || typeof patched !== 'object' || Array.isArray(patched)) {
    throw new ReplayInputError('--patch must produce a JSON object (the request body)');
  }
  return patched as Record<string, unknown>;
}

/** Rebuild the Pi model that routes a captured request to its transport. */
export function buildReplayModel(record: CapturedPayloadRecord, baseUrl?: string): Model<string> {
  const base = record.provider === OPENROUTER_NATIVE_PROVIDER
    ? buildOpenRouterModel({ modelId: record.requestModel, ...(baseUrl ? { baseUrl } : {}) })
    : record.provider === OPENAI_NATIVE_PROVIDER
      ? buildOpenAiResponsesModel({ modelId: record.requestModel, ...(baseUrl ? { baseUrl } : {}) })
      : undefined;
  if (!base && !baseUrl) {
    throw new ReplayInputError(`no default endpoint for provider '${record.provider}'; pass --base-url`);
  }
  return {
    ...(base ?? { headers: {}, reasoning: false, input: ['text'], contextWindow: 200_000, maxTokens: 4_096 }),
    // The captured id, so a provider echo of it is not reported as a substitution.
    id: record.requestModel,
    name: record.requestModel,
    api: record.api,
    provider: record.provider,
    ...(baseUrl ? { baseUrl } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<string>;
}

function summarizeContent(message: AssistantMessage): ReplayContentBlock[] {
  return message.content.map((block): ReplayContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'thinking':
        return { type: 'thinking', chars: block.thinking.length };
      case 'toolCall':
        return { type: 'toolCall', name: block.name, arguments: block.arguments };
      default:
        return { type: 'text', text: `[${(block as { type: string }).type}]` };
    }
  });
}

/** Resend a captured request body and report the reply's shape and usage. */
export async function replayNativeRequest(options: ReplayNativeRequestOptions): Promise<ReplayResult> {
  const { record } = options;
  const body = options.patch !== undefined ? applyJqPatch(record.payload, options.patch) : record.payload;
  const model = buildReplayModel(record, options.baseUrl);
  const streamFn: StreamFn = options.streamFn ?? (() => {
    const models = createNativeModelsCollection({ env: options.env ?? process.env });
    return (streamModel, context, streamOptions) => models.streamSimple(streamModel, context, streamOptions);
  })();

  // Pi builds a request from this placeholder; onPayload replaces it wholesale.
  const context = normalizeContext({ messages: [{ role: 'user', content: 'replay', timestamp: 0 }] });
  const stream = await streamFn(model, context, {
    ...(options.signal ? { signal: options.signal } : {}),
    maxRetries: 0,
    onPayload: () => structuredClone(body),
  });
  const message = await stream.result();
  const identity = extractProviderReportedIdentity(message, record.requestModel);
  return {
    provider: record.provider,
    api: record.api,
    requestModel: record.requestModel,
    responseModel: identity.reportedModel,
    responseId: identity.responseId,
    stopReason: String(message.stopReason),
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    content: summarizeContent(message),
    patched: options.patch !== undefined,
  };
}
