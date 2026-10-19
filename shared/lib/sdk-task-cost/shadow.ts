/**
 * Shadow runner shared by the eval entrypoints (post-completion hook and eval
 * orchestrator) so both apply `WAVEMILL_SDK_COST_METERING_SHADOW` with the
 * same semantics (HOK-3075).
 *
 * - `off`: the collector is never invoked; returns `null`.
 * - `on`: failures are logged and swallowed; returns `null` on failure.
 * - `strict`: failures are rethrown (tests/CI only).
 *
 * The legacy cost outcome is computed before and independently of this call,
 * so a shadow failure can never change what the eval record reports today.
 *
 * @module sdk-task-cost/shadow
 */

import { errorMessage } from '../error-utils.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { resolveSdkTaskCostShadowMode } from './feature-switch.ts';

export interface SdkTaskCostShadowOptions {
  /** Log prefix, e.g. `Post-completion eval`. */
  label: string;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export async function runSdkTaskCostShadow(
  collect: () => TaskCostSummaryV1[] | null | Promise<TaskCostSummaryV1[] | null>,
  options: SdkTaskCostShadowOptions,
): Promise<TaskCostSummaryV1[] | null> {
  const mode = resolveSdkTaskCostShadowMode(options.env);
  if (mode === 'off') return null;
  const logger = options.logger ?? console;
  try {
    const summaries = await collect();
    if (summaries && summaries.length > 0) {
      const detail = summaries
        .map((summary) => {
          const total = summary.total_cost_usd === null ? 'unresolved' : `$${summary.total_cost_usd.toFixed(4)}`;
          return `${summary.harness}: ${total}, coverage ${summary.coverage}, source ${summary.cost_source}`;
        })
        .join('; ');
      logger.log(`${options.label}: SDK task-cost shadow — ${detail}`);
    }
    return summaries;
  } catch (error) {
    if (mode === 'strict') throw error;
    logger.warn(`${options.label}: SDK task-cost shadow failed — ${errorMessage(error)}`);
    return null;
  }
}
