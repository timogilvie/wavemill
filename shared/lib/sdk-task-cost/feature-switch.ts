/**
 * Feature switches for SDK task-cost metering (HOK-3075, HOK-3076).
 *
 * **Engine** — `WAVEMILL_COST_METERING_LEGACY` is the HOK-3076 rollback
 * switch. The SDK bridge is the authoritative workflow/eval cost source by
 * default; setting the switch makes the legacy `workflow-cost.ts` outcome
 * authoritative again.
 *
 * - unset, `0`, `false`, `off` → `sdk` (default)
 * - `1`, `true`, `on`          → `legacy` (rollback)
 *
 * Unrecognised values resolve to `sdk`, the release-gated default: a typo
 * never silently flips every reader to a different engine.
 *
 * **Shadow** — `WAVEMILL_SDK_COST_METERING_SHADOW` is retained for
 * diagnostics. Under the SDK engine the summaries are always collected; under
 * the legacy rollback it decides whether they are still collected and
 * attached as `taskCostSummary` evidence.
 *
 * - unset, `0`, `false`, `off` → `off`
 * - `1`, `true`, `on`          → `on` (failures are logged and swallowed)
 * - `strict`                   → `strict` (failures throw — tests/CI only; applies under either engine)
 *
 * Unrecognised shadow values resolve to `off`.
 *
 * @module sdk-task-cost/feature-switch
 */

export const COST_METERING_LEGACY_ENV = 'WAVEMILL_COST_METERING_LEGACY';
export const SDK_TASK_COST_SHADOW_ENV = 'WAVEMILL_SDK_COST_METERING_SHADOW';

export type CostMeteringEngine = 'sdk' | 'legacy';
export type SdkTaskCostShadowMode = 'off' | 'on' | 'strict';

const ON_VALUES = new Set(['1', 'true', 'on']);

/** Resolve the authoritative cost engine from the environment (defaults to `process.env`). */
export function resolveCostMeteringEngine(
  env: Record<string, string | undefined> = process.env,
): CostMeteringEngine {
  const raw = env[COST_METERING_LEGACY_ENV]?.trim().toLowerCase();
  return raw && ON_VALUES.has(raw) ? 'legacy' : 'sdk';
}

/** Resolve the shadow mode from the environment (defaults to `process.env`). */
export function resolveSdkTaskCostShadowMode(
  env: Record<string, string | undefined> = process.env,
): SdkTaskCostShadowMode {
  const raw = env[SDK_TASK_COST_SHADOW_ENV]?.trim().toLowerCase();
  if (!raw) return 'off';
  if (raw === 'strict') return 'strict';
  return ON_VALUES.has(raw) ? 'on' : 'off';
}

/** True when the shadow switch alone would run the bridge (`on` or `strict`). */
export function isSdkTaskCostShadowEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveSdkTaskCostShadowMode(env) !== 'off';
}
