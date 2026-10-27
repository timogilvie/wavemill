/**
 * Workflow cost metering for the eval entrypoints (HOK-3077): the one path
 * from a finished workflow's sessions to the `WorkflowCostOutcome` an eval
 * record persists.
 *
 * 1. Optionally fetch OpenRouter exact charges for the native turns' response
 *    ids (`exactPricing`; the eval orchestrator opts in, the post-completion
 *    hook does not).
 * 2. Collect SDK `TaskCostSummaryV1`s — lazily, see `lazy-collect.ts`.
 * 3. Resolve them to an outcome (`resolve.ts`).
 *
 * Never throws for a metering problem: a collector failure is logged and
 * becomes an `adapter_error` outcome, a failed exact-pricing lookup is logged
 * and the turns keep their local estimates. Cost must never fail an eval.
 *
 * Like `lazy-collect.ts`, this module has no runtime dependency on
 * `@hokusai/core`, so eval entrypoints still load under a stale install.
 *
 * @module sdk-task-cost/meter
 */

import { errorMessage } from '../error-utils.ts';
import {
  fetchOpenRouterExactCosts,
  isExactPricingEnabled,
  type ExactPricingOptions,
} from '../pricing/openrouter-exact-pricing.ts';
import type { PricingTable } from '../pricing/model-pricing.ts';
import { NativeSessionAdapter, type SessionScanOptions } from '../session-adapters.ts';
import type { CollectSdkTaskCostSummariesInput } from './collect.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { collectSdkTaskCostSummariesLazy } from './lazy-collect.ts';
import { resolveWorkflowCost, type ResolvedWorkflowCost } from './resolve.ts';

export type SdkTaskCostCollector = (
  input: CollectSdkTaskCostSummariesInput,
) => TaskCostSummaryV1[] | null | Promise<TaskCostSummaryV1[] | null>;

export interface MeterWorkflowCostInput {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  issueId?: string;
  agentType?: string | null;
  /** Pricing table for local estimates; the collector loads one when omitted. */
  pricingTable?: PricingTable;
  /** Log prefix, e.g. `Post-completion eval`. */
  label: string;
  /** Defaults to {@link collectSdkTaskCostSummariesLazy}; injected by tests. */
  collect?: SdkTaskCostCollector;
  /** Opt in to OpenRouter exact charges for native turns. */
  exactPricing?: ExactPricingOptions;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface MeteredWorkflowCost extends ResolvedWorkflowCost {
  /** Raw SDK summaries, persisted as `taskCostSummary` evidence. */
  summaries: TaskCostSummaryV1[] | null;
}

function formatSummaries(summaries: readonly TaskCostSummaryV1[]): string {
  return summaries
    .map((summary) => {
      const total = summary.total_cost_usd === null ? 'unresolved' : `$${summary.total_cost_usd.toFixed(4)}`;
      return `${summary.harness}: ${total}, coverage ${summary.coverage}, source ${summary.cost_source}`;
    })
    .join('; ');
}

/** Response ids of every native turn on the branch (OpenRouter generation ids). */
function nativeResponseIds(scanOpts: SessionScanOptions): string[] {
  const scan = new NativeSessionAdapter().scan(scanOpts);
  return scan?.nativeSessions?.flatMap((session) => session.responseIds) ?? [];
}

async function resolveExactGenerationCosts(
  scanOpts: SessionScanOptions,
  options: ExactPricingOptions | undefined,
  label: string,
  logger: Pick<Console, 'log' | 'warn'>,
): Promise<Map<string, number> | undefined> {
  if (!options || !isExactPricingEnabled(options)) return undefined;
  try {
    return await fetchOpenRouterExactCosts(nativeResponseIds(scanOpts), { logger, ...options });
  } catch (error) {
    logger.warn(`${label}: OpenRouter exact pricing skipped — ${errorMessage(error)}`);
    return undefined;
  }
}

export async function meterWorkflowCost(input: MeterWorkflowCostInput): Promise<MeteredWorkflowCost> {
  const logger = input.logger ?? console;
  const collect = input.collect ?? collectSdkTaskCostSummariesLazy;
  const scanOpts: SessionScanOptions = {
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    repoDir: input.repoDir,
    issueId: input.issueId,
  };

  const exactGenerationCosts = await resolveExactGenerationCosts(scanOpts, input.exactPricing, input.label, logger);

  let summaries: TaskCostSummaryV1[] | null = null;
  let collectionError: string | null = null;
  try {
    summaries = await collect({
      ...scanOpts,
      pricingTable: input.pricingTable,
      ...(exactGenerationCosts && exactGenerationCosts.size > 0 ? { exactGenerationCosts } : {}),
    });
    if (summaries && summaries.length > 0) {
      logger.log(`${input.label}: SDK task cost — ${formatSummaries(summaries)}`);
    }
  } catch (error) {
    summaries = null;
    collectionError = errorMessage(error);
    logger.warn(`${input.label}: SDK task cost collection failed — ${collectionError}`);
  }

  const resolved = resolveWorkflowCost({
    summaries,
    collectionError,
    agentType: input.agentType,
    pricingTable: input.pricingTable,
    repoDir: input.repoDir,
    diagnostics: { worktreePath: input.worktreePath, branchName: input.branchName },
  });
  return { ...resolved, summaries };
}
