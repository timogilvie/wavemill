/**
 * Feature switch for SDK task-cost shadow metering (HOK-3075).
 *
 * `WAVEMILL_SDK_COST_METERING_SHADOW` controls whether eval entrypoints
 * compute an SDK `TaskCostSummaryV1` alongside the legacy workflow-cost
 * outcome. It never switches a read: legacy `workflowCost` /
 * `workflowCostAttribution` / `executionEconomics` stay authoritative until
 * the HOK-3076 cutover.
 *
 * - unset, `0`, `false`, `off` → `off` (default; the bridge never runs)
 * - `1`, `true`, `on`          → `on` (bridge runs; failures are logged and swallowed)
 * - `strict`                   → `strict` (bridge runs; failures throw — tests/CI only)
 *
 * Unrecognised values resolve to `off`: an operator typo must never turn on
 * new computation in the eval path.
 *
 * @module sdk-task-cost/feature-switch
 */

export const SDK_TASK_COST_SHADOW_ENV = 'WAVEMILL_SDK_COST_METERING_SHADOW';

export type SdkTaskCostShadowMode = 'off' | 'on' | 'strict';

const ON_VALUES = new Set(['1', 'true', 'on']);

/** Resolve the shadow mode from the environment (defaults to `process.env`). */
export function resolveSdkTaskCostShadowMode(
  env: Record<string, string | undefined> = process.env,
): SdkTaskCostShadowMode {
  const raw = env[SDK_TASK_COST_SHADOW_ENV]?.trim().toLowerCase();
  if (!raw) return 'off';
  if (raw === 'strict') return 'strict';
  return ON_VALUES.has(raw) ? 'on' : 'off';
}

/** True when the bridge should run (`on` or `strict`). */
export function isSdkTaskCostShadowEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveSdkTaskCostShadowMode(env) !== 'off';
}
