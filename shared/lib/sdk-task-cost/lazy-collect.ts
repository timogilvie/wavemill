/**
 * Lazy entrypoint for the SDK task-cost collector.
 *
 * The eval entrypoints (post-completion hook and eval orchestrator) must load
 * even when the installed `@hokusai/core` predates the task-cost contract —
 * a stale `node_modules` once turned a cost feature into a module-load
 * `SyntaxError` that failed every eval. This module has no runtime dependency
 * on `@hokusai/core`: the collector (and the SDK) are imported only when
 * `meterWorkflowCost` actually invokes it, so a load failure surfaces inside
 * the metering runner, which logs it and records an `adapter_error` cost.
 *
 * @module sdk-task-cost/lazy-collect
 */

import type { TaskCostSummaryV1 } from './contract.ts';
import type { CollectSdkTaskCostSummariesInput } from './collect.ts';

type CollectModule = Pick<typeof import('./collect.ts'), 'collectSdkTaskCostSummaries'>;

/** Import `./collect.ts` on first use, then collect summaries for one task. */
export async function collectSdkTaskCostSummariesLazy(
  input: CollectSdkTaskCostSummariesInput,
  load: () => Promise<CollectModule> = () => import('./collect.ts'),
): Promise<TaskCostSummaryV1[] | null> {
  const { collectSdkTaskCostSummaries } = await load();
  return collectSdkTaskCostSummaries(input);
}
