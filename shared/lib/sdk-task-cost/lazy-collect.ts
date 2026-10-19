/**
 * Lazy entrypoint for the SDK task-cost collector.
 *
 * The eval entrypoints (post-completion hook and eval orchestrator) must load
 * even when the installed `@hokusai/core` predates the task-cost contract —
 * a stale `node_modules` once turned a shadow-only feature into a module-load
 * `SyntaxError` that failed every eval with the switch off. This module has
 * no runtime dependency on `@hokusai/core`: the collector (and the SDK) are
 * imported only when `runSdkTaskCostShadow` actually invokes it, so a load
 * failure surfaces inside the shadow runner and gets its `on`/`strict`
 * semantics (logged-and-swallowed vs rethrown).
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
