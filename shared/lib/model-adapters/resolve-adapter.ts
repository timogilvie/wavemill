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
import type { CliTransportAdapter, TransportAdapter } from './transport-adapter.ts';

/** A CLI provider `llm-cli` can spawn directly. */
export type CliProvider = 'claude' | 'codex';

export interface AdapterForProviderOptions {
  model: string;
  repoDir?: string;
  /** Fail-closed invocation (no fallback ladder). Defaults to true. */
  failClosed?: boolean;
  reservedOutputTokens?: number;
}

/**
 * The CLI adapter for a provider/model pair (HOK-3460).
 *
 * Constructs the adapter directly rather than through `resolveModelAgent`:
 * `callLLM` iterates a candidate ladder and must not re-run launch
 * certification for each rung. Vendor compatibility is the adapter's
 * `incompatibilityReason`.
 */
export function adapterForProvider(
  provider: CliProvider,
  opts: AdapterForProviderOptions,
): CliTransportAdapter {
  const common = {
    model: opts.model,
    repoDir: opts.repoDir,
    reservedOutputTokens: opts.reservedOutputTokens,
  };
  return provider === 'codex'
    ? new CodexCliAdapter({ ...common, failClosed: opts.failClosed ?? true })
    : new ClaudeCliAdapter({ ...common, failClosed: opts.failClosed ?? true });
}

export interface ResolveModelAdapterOptions {
  model: string;
  phase: AgentResolutionPhase;
  repoDir?: string;
  /** Fail-closed invocation (no fallback ladder). Defaults to true. */
  failClosed?: boolean;
  /** Max output tokens the adapter will reserve on top of input in preflight. */
  reservedOutputTokens?: number;
  /**
   * Freeze certification freshness. `resolveModelAgent` already accepts it;
   * exposed here so a replay test can assert the agent a model maps to
   * without depending on today's artifact TTL (HOK-3460).
   */
  now?: Date;
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
    now: opts.now,
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
