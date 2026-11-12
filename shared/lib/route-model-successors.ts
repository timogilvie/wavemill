import { getEffectiveRegistry, resolveModelRegistryKey, resolveModelSuccessor } from './model-registry.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

type RouteRole = 'planner' | 'coder' | 'reviewer';
const ROLE_TO_STAGE = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
} as const;

/**
 * Normalizes the model IDs in a routing decision before it is persisted or
 * launched. This covers decisions received from Hokusai and decisions restored
 * from the expanded-route cache.
 *
 * - A provider-form ID (`qwen/qwen3-coder`, `qwen3-coder`) becomes the
 *   registry key the mill launches by (`qwen-3-coder`). It is the same model
 *   under another name, not a substitution: left as-is, launchability rejects
 *   it as an unknown model and the stage falls back to a different one.
 * - An explicitly retired model ID becomes its lineage successor.
 */
export function upgradeRouteModelSuccessors(
  decision: WorkflowRouteDecision,
  repoDir?: string,
): WorkflowRouteDecision {
  const registry = getEffectiveRegistry(repoDir);
  const renames: Array<{ role: RouteRole; from: string; to: string }> = [];
  const upgrades: Array<{ role: RouteRole; from: string; to: string }> = [];
  const upgraded = { ...decision };

  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const recommended = decision[role];
    const from = recommended ? resolveModelRegistryKey(registry, recommended) : recommended;
    if (from !== recommended) {
      upgraded[role] = from;
      renames.push({ role, from: recommended, to: from });
    }
    const to = resolveModelSuccessor(from, registry, { stage: ROLE_TO_STAGE[role] });
    if (!to || to === from) continue;
    upgraded[role] = to;
    upgrades.push({ role, from, to });
  }

  if (renames.length === 0 && upgrades.length === 0) return decision;

  return {
    ...upgraded,
    reasoning: [
      ...decision.reasoning,
      ...renames.map(({ role, from, to }) =>
        `Read ${role} model ${from} as registry model ${to} (same model, provider-form ID).`,
      ),
      ...upgrades.map(({ role, from, to }) =>
        `Upgraded retired ${role} model ${from} to successor ${to} via model lineage.`,
      ),
    ],
  };
}
