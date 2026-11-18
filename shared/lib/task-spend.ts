/**
 * One task spend limit (HOK-3492): the recorded task budget minus what the
 * task's owned sessions have already cost.
 *
 * Before this module "how much may this task consume?" was answered in five
 * places — the stage retry bucket, the per-session coding loop budget, the
 * loop's unused `maxCostUsd`, the recorded route budget, and the OpenRouter
 * account-balance guard — and none of them was cumulative. A native challenger
 * armed with a $25 repo-config budget spent an estimated $45–75 over nine
 * launches and was stopped only when the whole provider account emptied.
 *
 * The two authoritative inputs are reused unchanged:
 *   - the budget is `resolveCarriedBudget` over the route artifact and the
 *     repo's configured default (`budget-source.ts`);
 *   - the spend is `meterWorkflowCost` over the task's `.session-ownership.jsonl`
 *     rows and the one cost engine (`sdk-task-cost/meter.ts`) — never a second
 *     price formula.
 *
 * This module only subtracts. `remainingUsd` is the single number launch and
 * relaunch sites may use to bound a task's spend.
 *
 * Metering honesty: an unreadable/failed measurement is `metering:
 * 'unavailable'` with `remainingUsd: null`, never `$0` spend. Callers must not
 * treat that as unlimited: {@link loopCostLimitUsd} falls back to the recorded
 * ceiling for the session, so a launch is always bounded, while the relaunch
 * policy keeps the HOK-3176 default (unknown → retry) rather than inventing a
 * terminal verdict from missing evidence.
 *
 * @module task-spend
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getMaxCostUsd, isDefaultMaxCostUsdExplicitlyConfigured } from './config.ts';
import { resolveCarriedBudget, type BudgetCarrier, type ResolvedBudget } from './budget-source.ts';
import { getEffectiveRegistry, resolveModelRegistryKey } from './model-registry.ts';
import { loadPricingTable, type ModelPricing, type PricingTable } from './pricing/model-pricing.ts';
import { readRouteLifecycleArtifacts } from './route-artifact.ts';
import { meterWorkflowCost } from './sdk-task-cost/meter.ts';
import { reportableWorkflowCostUsd } from './workflow-cost.ts';
import type { ExactPricingOptions } from './pricing/openrouter-exact-pricing.ts';
import type { SessionOwnershipRow } from './session-ownership.ts';

/** Whether the task's prior spend could be measured from owned sessions. */
export type TaskSpendMetering = 'measured' | 'unavailable';

export interface TaskSpendRemainder {
  /** The recorded budget and its provenance (`resolveCarriedBudget`). */
  budget: ResolvedBudget;
  /** Measured spend over the task's owned sessions, or null when unknown. */
  spentUsd: number | null;
  /** `budget.maxCostUsd - spentUsd`, floored at 0; null when spend is unknown. */
  remainingUsd: number | null;
  metering: TaskSpendMetering;
  /** The launched model's rates from the one rate table, when known. */
  pricing: ModelPricing | null;
}

export interface ResolveTaskSpendInput {
  repoDir: string;
  /** The worktree whose `features|bugs/<slug>/` holds the task record. */
  worktreePath?: string;
  /** The task's feature directory (preferred over worktreePath + slug). */
  featureDir?: string;
  issueId?: string;
  slug?: string | null;
  branchName?: string;
  /** Model the loop will run; its rates make the loop's cost stop meaningful. */
  modelId?: string;
  /** Rates already derived by the caller (the launch's model config); wins over the table. */
  modelPricing?: ModelPricing;
  pricingTable?: PricingTable;
  exactPricing?: ExactPricingOptions;
  /** Bypass the meter (tests inject owned rows). */
  ownership?: readonly SessionOwnershipRow[];
  /** Test seam: replaces the one meter. Production callers never set it. */
  meter?: typeof meterWorkflowCost;
  now?: () => Date;
  logger?: Pick<Console, 'log' | 'warn'>;
}

function featureDirFor(input: ResolveTaskSpendInput): string | undefined {
  if (input.featureDir) return input.featureDir;
  const slug = input.slug?.trim();
  if (!slug) return undefined;
  for (const root of [input.worktreePath, input.repoDir]) {
    if (!root) continue;
    for (const kind of ['features', 'bugs']) {
      const candidate = join(root, kind, slug);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The recorded budget for a task, read from its route artifact and repo config. */
export function resolveTaskBudget(input: Pick<ResolveTaskSpendInput, 'repoDir' | 'featureDir' | 'issueId' | 'worktreePath' | 'slug'>): ResolvedBudget | null {
  const featureDir = featureDirFor(input);
  const archiveDir = input.repoDir && input.issueId
    ? join(input.repoDir, '.wavemill', 'evals', 'artifacts', input.issueId)
    : undefined;
  const artifacts = readRouteLifecycleArtifacts(featureDir, archiveDir);
  const carriers: Array<BudgetCarrier | null | undefined> = [
    artifacts.expanded?.carriedBudget,
    artifacts.active?.carriedBudget,
    artifacts.bootstrap?.carriedBudget,
  ];
  const configuredSource = isDefaultMaxCostUsdExplicitlyConfigured(input.repoDir) ? 'repo-config' : 'default';
  return resolveCarriedBudget(carriers, getMaxCostUsd(input.repoDir), configuredSource);
}

function pricingForModel(repoDir: string, modelId: string | undefined, table?: PricingTable): ModelPricing | null {
  if (!modelId) return null;
  try {
    const rates = table ?? loadPricingTable(repoDir);
    const key = resolveModelRegistryKey(getEffectiveRegistry(repoDir), modelId);
    return rates[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * The task's remaining spend, or null when no budget is recorded (the launch
 * is then unbounded, exactly as before this change).
 */
export async function resolveTaskSpendRemainder(input: ResolveTaskSpendInput): Promise<TaskSpendRemainder | null> {
  const budget = resolveTaskBudget(input);
  if (!budget) return null;
  const pricing = input.modelPricing ?? pricingForModel(input.repoDir, input.modelId, input.pricingTable);
  const logger = input.logger ?? console;
  const featureDir = featureDirFor(input);
  const slug = input.slug ?? (featureDir ? basename(featureDir) : null);

  let spentUsd: number | null;
  try {
    const metered = await (input.meter ?? meterWorkflowCost)({
      worktreePath: input.worktreePath ?? input.repoDir,
      branchName: input.branchName ?? '',
      repoDir: input.repoDir,
      issueId: input.issueId,
      slug,
      ...(featureDir ? { featureDir } : {}),
      ...(input.ownership ? { ownership: input.ownership } : {}),
      ...(input.pricingTable ? { pricingTable: input.pricingTable } : {}),
      label: 'Task spend',
      exactPricing: input.exactPricing ?? { logger },
      ...(input.now ? { now: input.now } : {}),
    });
    if (metered.reason === 'no_owned_sessions') {
      // No owned session has usage yet (first launch) or the recorded launches
      // left nothing behind: the measured spend is genuinely zero.
      spentUsd = 0;
    } else {
      // A missing/incomplete price is unknown spend, never zero (see module doc).
      spentUsd = reportableWorkflowCostUsd(metered.outcome) ?? null;
    }
  } catch (error) {
    logger.warn(`Task spend: meter unavailable — ${(error as Error).message}`);
    spentUsd = null;
  }

  if (spentUsd === null) {
    logger.warn(`Task spend: prior spend unknown for budget ${budget.budgetSource} $${budget.maxCostUsd.toFixed(2)}; bounding this session by the full recorded ceiling`);
    return { budget, spentUsd: null, remainingUsd: null, metering: 'unavailable', pricing };
  }
  return {
    budget,
    spentUsd,
    remainingUsd: Math.max(0, budget.maxCostUsd - spentUsd),
    metering: 'measured',
    pricing,
  };
}

/**
 * The loop `maxCostUsd` for one launch. When prior spend is unknown the launch
 * is bounded by the recorded ceiling rather than left unlimited; it is never
 * interpreted as the full remainder.
 */
export function loopCostLimitUsd(spend: TaskSpendRemainder | null | undefined): number | undefined {
  if (!spend) return undefined;
  return spend.remainingUsd ?? spend.budget.maxCostUsd;
}
