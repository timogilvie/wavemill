/**
 * Router ↔ launcher launchability parity (HOK-3142).
 *
 * The router and the phase launcher used to answer "can this model run this
 * stage?" with different code: the router's native filter ran on only one of
 * its six selection paths, while the launcher (`tools/resolve-model-agent.ts`
 * → `agent_resolve_from_model`) always ran `resolveModelAgent`. A model with a
 * workflow certificate but no live coding canary was therefore routed as the
 * coder and then refused at launch on every monitor tick (HOK-3138).
 *
 * Invariant: **every router-selected model must pass `isLaunchableForStage`**
 * for the stage it was picked for. The predicate *is* the launcher's resolver
 * (same function, same effective registry), so parity holds by construction
 * rather than by keeping two implementations in sync.
 *
 * @module stage-launchability
 */

import { getEffectiveRegistry, type AgentType, type ModelRegistry } from './model-registry.ts';
import {
  resolveModelAgent,
  type AgentResolution,
  type AgentResolutionPhase,
  type UnroutableReason,
} from './model-agent-resolution.ts';

export type LaunchStage = AgentResolutionPhase;
export type LaunchRole = 'planner' | 'coder' | 'reviewer';

export const ROLE_TO_LAUNCH_STAGE: Record<LaunchRole, LaunchStage> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

export interface StageLaunchRefusal {
  ok: false;
  reason: UnroutableReason;
  /** Structured certification status, e.g. `missing_live_canary`. */
  certification?: string;
  diagnostic: string;
  certifyCommand?: string;
}

export type StageLaunchability = { ok: true; agent: AgentType } | StageLaunchRefusal;

/** Type guard usable without strictNullChecks (the static tsconfig is non-strict). */
export function isStageLaunchRefusal(result: StageLaunchability): result is StageLaunchRefusal {
  return result.ok === false;
}

function isAgentResolutionFailure(
  resolution: AgentResolution,
): resolution is Extract<AgentResolution, { ok: false }> {
  return resolution.ok === false;
}

export interface StageLaunchabilityOptions {
  repoDir: string;
  /** Defaults to `getEffectiveRegistry(repoDir)` — the registry the launcher uses. */
  registry?: ModelRegistry;
  now?: Date;
  certificationRoot?: string;
}

/**
 * Whether the phase launcher will accept `modelId` for `stage`.
 *
 * Delegates to `resolveModelAgent` — the exact resolver the launch gate runs —
 * so a `false` here is precisely the refusal the monitor would log.
 */
export function isLaunchableForStage(
  modelId: string,
  stage: LaunchStage,
  opts: StageLaunchabilityOptions,
): StageLaunchability {
  const resolution = resolveModelAgent({
    model: modelId,
    phase: stage,
    repoDir: opts.repoDir,
    registry: opts.registry ?? getEffectiveRegistry(opts.repoDir),
    now: opts.now,
    certificationRoot: opts.certificationRoot,
  });
  if (!isAgentResolutionFailure(resolution)) {
    return { ok: true, agent: resolution.agent };
  }
  return {
    ok: false,
    reason: resolution.reason,
    ...(resolution.certificationStatus ? { certification: resolution.certificationStatus } : {}),
    diagnostic: resolution.diagnostic,
    ...(resolution.certifyCommand ? { certifyCommand: resolution.certifyCommand } : {}),
  };
}

/**
 * Memoizing wrapper for one routing pass: certification checks read artifacts
 * from disk, and a single route may probe the same `(model, stage)` from the
 * pool filter, the terminal guard, and substitution search.
 */
export function createLaunchabilityChecker(
  opts: StageLaunchabilityOptions,
): (modelId: string, stage: LaunchStage) => StageLaunchability {
  const cache = new Map<string, StageLaunchability>();
  return (modelId, stage) => {
    const key = `${stage}\u0000${modelId}`;
    let result = cache.get(key);
    if (!result) {
      result = isLaunchableForStage(modelId, stage, opts);
      cache.set(key, result);
    }
    return result;
  };
}

const DETERMINISTIC_REFUSAL_REASONS: ReadonlySet<string> = new Set<UnroutableReason>([
  'uncertified',
  'no-native-capability',
  'native-unsupported',
  'lifecycle-blocked',
  'role-ineligible',
  'tool-support-insufficient',
  'context-window-insufficient',
  'codex-chatgpt-ineligible',
  'unknown-model',
]);

/**
 * True when a launch refusal will repeat identically on retry, so relaunching
 * the same route on a timer can never succeed. `invalid-model-id` is excluded
 * because it signals corrupted route state rather than an ineligible model.
 */
export function isDeterministicLaunchRefusal(reason: string | undefined | null): boolean {
  return typeof reason === 'string' && DETERMINISTIC_REFUSAL_REASONS.has(reason);
}
