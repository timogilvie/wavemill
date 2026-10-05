// ---------------------------------------------------------------------------
// Pi adapter edge — the only new production file that imports Pi/typebox types.
// Callers can import toPiAgentTool directly from this file; registry.ts itself
// does not re-export it, keeping Pi imports out of the registry seam.
// ---------------------------------------------------------------------------
// Pi 1.0 moved the global API-provider registry to the temporary `compat`
// entrypoint (HOK-3161).
import {
  getApiProvider,
  registerBuiltInApiProviders,
  type Api,
  type Model,
} from '@earendil-works/pi-ai/compat';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../output-limits.ts';
import type { ToolDescriptor } from './types.ts';

// Re-export Pi tool types through the adapter seam so callers (e.g. smoke
// harnesses) that build Pi tools can stay free of direct Pi vendor imports.
export type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
export type PiModel = Model<Api>;

let builtInProvidersRegistered = false;

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

export function getRegisteredPiProviderForModel(
  model: Pick<PiModel, 'api'>,
): ReturnType<typeof getApiProvider> | undefined {
  ensureBuiltInApiProvidersRegistered();

  try {
    return getApiProvider(model.api);
  } catch {
    return undefined;
  }
}

function ensureBuiltInApiProvidersRegistered(): void {
  if (builtInProvidersRegistered) {
    return;
  }

  try {
    registerBuiltInApiProviders();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already registered|duplicate/i.test(message)) {
      throw error;
    }
  }

  builtInProvidersRegistered = true;
}
