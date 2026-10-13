// ---------------------------------------------------------------------------
// Pi adapter edge — the only new production file that imports Pi/typebox types.
// Callers can import toPiAgentTool directly from this file; registry.ts itself
// does not re-export it, keeping Pi imports out of the registry seam.
// ---------------------------------------------------------------------------
import {
  type Api,
  type Model,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../output-limits.ts';
import {
  createNativeModelsCollection,
  getActiveNativeModels,
} from '../models.ts';
import type { ToolDescriptor } from './types.ts';

// Re-export Pi tool types through the adapter seam so callers (e.g. smoke
// harnesses) that build Pi tools can stay free of direct Pi vendor imports.
export type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
export type PiModel = Model<Api>;

/**
 * Lazy read-only collection used when neither an explicit collection nor an
 * active-models pointer is available. The AuthContext has no credentials, so
 * callers can only use it to look up providers by id — never to stream.
 */
let fallbackBuiltInModels: Models | undefined;

/**
 * Convert a Wavemill ToolDescriptor into a Pi AgentTool.
 *
 * Pi/typebox types are confined to this file. The rest of the registry API
 * returns Wavemill-native descriptors and metadata only.
 */
export function toPiAgentTool(descriptor: ToolDescriptor): AgentTool<TSchema, unknown> {
  const { metadata, parameters, label, execute } = descriptor;

  return {
    name: metadata.name,
    description: metadata.description,
    parameters: parameters as TSchema,
    label: label ?? metadata.name,
    executionMode: metadata.executionMode,

    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      const result = await execute(toolCallId, params, signal);
      return {
        content: result.content,
        details: result.details,
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
      };
    },
  } as unknown as AgentTool<TSchema, unknown>;
}

export function buildPiModel({
  id,
  name,
  api,
  provider,
  baseUrl,
  headers = {},
  compat,
}: {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  compat?: unknown;
}): PiModel {
  return {
    id,
    name,
    api,
    provider,
    baseUrl,
    headers,
    ...(compat !== undefined ? { compat } : {}),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  } as PiModel;
}

/**
 * Resolve a Pi `Provider` whose model list covers `model.api` (HOK-3162).
 * Returns the first match from the active native models (if any), then the
 * launcher-supplied collection, then a shared read-only fallback that holds
 * the built-in openai/openrouter factories.
 *
 * The lookup is advisory — it only tells callers that an api is known. The
 * returned Provider's auth may be unresolved, so callers must not drive
 * streams through it unless they also brought a configured collection.
 */
export function getRegisteredPiProviderForModel(
  model: Pick<PiModel, 'api'>,
  models?: Models,
): Provider | undefined {
  const sources = [models, getActiveNativeModels(), getFallbackBuiltInModels()];
  for (const source of sources) {
    if (!source) continue;
    const match = findProviderWithApi(source, model.api);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findProviderWithApi(models: Models, api: Api): Provider | undefined {
  for (const provider of models.getProviders()) {
    const chatModels = provider.getModels();
    for (const chatModel of chatModels) {
      if (chatModel.api === api) {
        return provider;
      }
    }
  }
  return undefined;
}

function getFallbackBuiltInModels(): Models {
  if (!fallbackBuiltInModels) {
    fallbackBuiltInModels = createNativeModelsCollection({ env: {} });
  }
  return fallbackBuiltInModels;
}
