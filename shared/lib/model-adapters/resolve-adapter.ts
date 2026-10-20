/**
 * Factory that attaches a `TransportAdapter` to the result of
 * `resolveModelAgent` (HOK-3248). Callers that previously branched on
 * `provider` or re-derived a transport cap go through this one seam.
 */
import {
  resolveModelAgent,
  type AgentResolution,
  type AgentResolutionPhase,
} from '../model-agent-resolution.ts';
import { ClaudeCliAdapter } from './claude-cli-adapter.ts';
import { CodexCliAdapter } from './codex-cli-adapter.ts';
import { NativeOpenAIAdapter, NativeOpenRouterAdapter } from './native-adapter.ts';
import type { TransportAdapter } from './transport-adapter.ts';

export interface ResolveModelAdapterOptions {
  model: string;
  phase: AgentResolutionPhase;
  repoDir?: string;
  /** Fail-closed invocation (no fallback ladder). Defaults to true. */
  failClosed?: boolean;
  /** Max output tokens the adapter will reserve on top of input in preflight. */
  reservedOutputTokens?: number;
}

export interface ResolveModelAdapterResult {
  resolution: AgentResolution;
  adapter: TransportAdapter | null;
}

/**
 * Resolve a model to the adapter that owns its transport (claude-cli, codex-
 * cli, native-openai, native-openrouter). Returns `adapter: null` when the
 * model is unroutable; the caller consults `resolution` for the diagnostic.
 */
export function resolveModelAdapter(opts: ResolveModelAdapterOptions): ResolveModelAdapterResult {
  const resolution = resolveModelAgent({
    model: opts.model,
    phase: opts.phase,
    repoDir: opts.repoDir,
  });
  if (!resolution.ok) {
    return { resolution, adapter: null };
  }
  const common = {
    model: opts.model,
    repoDir: opts.repoDir,
    reservedOutputTokens: opts.reservedOutputTokens,
  };
  switch (resolution.agent) {
    case 'claude':
      return {
        resolution,
        adapter: new ClaudeCliAdapter({ ...common, failClosed: opts.failClosed ?? true }),
      };
    case 'codex':
      return {
        resolution,
        adapter: new CodexCliAdapter({ ...common, failClosed: opts.failClosed ?? true }),
      };
    case 'native-openai':
      return { resolution, adapter: new NativeOpenAIAdapter(common) };
    case 'native-openrouter':
      return { resolution, adapter: new NativeOpenRouterAdapter(common) };
    default:
      return { resolution, adapter: null };
  }
}
