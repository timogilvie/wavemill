/**
 * SDK task-cost collection runner shared by the eval entrypoints
 * (post-completion hook and eval orchestrator) so both apply the engine and
 * shadow switches with the same semantics (HOK-3075, HOK-3076).
 *
 * The collector runs when the SDK engine is authoritative (the default) or
 * the shadow switch is on under the legacy rollback; otherwise it is never
 * invoked and the runner returns `null`. Failures are logged and swallowed —
 * the caller then falls back to the legacy outcome — except in shadow
 * `strict` mode, where they are rethrown (tests/CI only).
 *
 * @module sdk-task-cost/shadow
 */

import { errorMessage } from '../error-utils.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { resolveCostMeteringEngine, resolveSdkTaskCostShadowMode } from './feature-switch.ts';

export interface SdkTaskCostCollectionOptions {
  /** Log prefix, e.g. `Post-completion eval`. */
  label: string;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export async function runSdkTaskCostCollection(
  collect: () => TaskCostSummaryV1[] | null | Promise<TaskCostSummaryV1[] | null>,
  options: SdkTaskCostCollectionOptions,
): Promise<TaskCostSummaryV1[] | null> {
  const engine = resolveCostMeteringEngine(options.env);
  const shadow = resolveSdkTaskCostShadowMode(options.env);
  if (engine === 'legacy' && shadow === 'off') return null;
  const logger = options.logger ?? console;
  const kind = engine === 'sdk' ? 'SDK task cost' : 'SDK task-cost shadow';
  try {
    const summaries = await collect();
    if (summaries && summaries.length > 0) {
      const detail = summaries
        .map((summary) => {
          const total = summary.total_cost_usd === null ? 'unresolved' : `$${summary.total_cost_usd.toFixed(4)}`;
          return `${summary.harness}: ${total}, coverage ${summary.coverage}, source ${summary.cost_source}`;
        })
        .join('; ');
      logger.log(`${options.label}: ${kind} — ${detail}`);
    }
    return summaries;
  } catch (error) {
    if (shadow === 'strict') throw error;
    logger.warn(`${options.label}: ${kind} collection failed — ${errorMessage(error)}`);
    return null;
  }
}
