import { isOpenRouterModel } from '../openrouter-provider.ts';
import {
  evaluateOpenRouterBalance,
  type OpenRouterBalanceEvaluation,
} from './openrouter-credits-guard.ts';

/**
 * HOK-3155: challenge-selection balance filter.
 *
 * Before a challenge pair is formed, drop every OpenRouter model from the
 * eligible pool when the cached OpenRouter balance is below `minCreditsUsd`.
 * This moves the credit refusal upstream from `openrouter-credits-guard.ts`
 * (which only refuses at launch, after a pair plus its worktrees already
 * exist). The cached snapshot is best-effort; when no snapshot exists the
 * filter is a no-op (fail-open) and the launch guard remains the backstop.
 */
export interface OpenRouterBalanceFilterResult {
  models: string[];
  refusedModels: string[];
  evaluation: OpenRouterBalanceEvaluation | null;
}

export function filterOpenRouterByBalance(
  models: readonly string[],
  opts: { repoDir?: string } = {},
): OpenRouterBalanceFilterResult {
  const pool = Array.from(models);
  const openRouterModels = pool.filter((modelId) => isOpenRouterModel(modelId));
  if (openRouterModels.length === 0) {
    return { models: pool, refusedModels: [], evaluation: null };
  }

  const evaluation = evaluateOpenRouterBalance({ repoDir: opts.repoDir });
  if (evaluation.status !== 'refuse') {
    return { models: pool, refusedModels: [], evaluation };
  }

  const refusedModels = openRouterModels;
  const remaining = pool.filter((modelId) => !isOpenRouterModel(modelId));
  return { models: remaining, refusedModels, evaluation };
}
