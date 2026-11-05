/**
 * Budget provenance (HOK-3390).
 *
 * Every place that records a task's `maxCostUsd` also records where that
 * number came from, so downstream training (Model 30's "success under
 * budget" label) can tell a real constraint from the hard-coded default.
 *
 * - `request`        — the caller passed an explicit budget (router request
 *                      `max_cost_usd`, `route-task --max-cost`).
 * - `issue-override` — a per-issue override (reserved; no writer yet).
 * - `repo-config`    — the repo's `.wavemill-config.json` set the budget
 *                      (`mill.defaultMaxCostUsd` or `budget.<mode>`).
 * - `default`        — nothing configured; Wavemill's built-in 25/15/5.
 *
 * The source is derived, never configured. Wavemill only records the truth;
 * the data pipeline decides what a `default` budget means for training.
 */

export const BUDGET_SOURCES = ['request', 'issue-override', 'repo-config', 'default'] as const;

export type BudgetSource = typeof BUDGET_SOURCES[number];

export interface ResolvedBudget {
  maxCostUsd: number;
  budgetSource: BudgetSource;
}

export function isBudgetSource(value: unknown): value is BudgetSource {
  return typeof value === 'string' && (BUDGET_SOURCES as readonly string[]).includes(value);
}

export function isFiniteNonNegativeBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Anything that carries a budget: a route decision, `.routing-complete`, an eval record. */
export interface BudgetCarrier {
  maxCostUsd?: number | null;
  constraints?: {
    maxCostUsd?: number;
    budgetSource?: unknown;
  } | null;
}

/**
 * The one budget-provenance derivation (HOK-3390). Returns the first carrier's
 * budget with the source recorded beside it — a carried budget without a
 * recorded source predates HOK-3390 and only ever came from an explicit
 * caller, so it is `request` — else the repo's `mill.defaultMaxCostUsd` as
 * `repo-config`, else null.
 */
export function resolveCarriedBudget(
  carriers: ReadonlyArray<BudgetCarrier | null | undefined>,
  configuredMaxCostUsd: unknown,
): ResolvedBudget | null {
  for (const carrier of carriers) {
    if (!carrier) continue;
    const recordedSource = carrier.constraints?.budgetSource;
    const budgetSource = isBudgetSource(recordedSource) ? recordedSource : 'request';
    for (const maxCostUsd of [carrier.constraints?.maxCostUsd, carrier.maxCostUsd]) {
      if (isFiniteNonNegativeBudget(maxCostUsd)) return { maxCostUsd, budgetSource };
    }
  }
  return isFiniteNonNegativeBudget(configuredMaxCostUsd)
    ? { maxCostUsd: configuredMaxCostUsd, budgetSource: 'repo-config' }
    : null;
}

/** CLI option definitions shared by the route tools. */
export const BUDGET_CLI_OPTIONS = {
  'max-cost': {
    type: 'string',
    description: 'Maximum cost budget in USD for routing',
  },
  'budget-source': {
    type: 'string',
    description: `Provenance of --max-cost (${BUDGET_SOURCES.join(', ')}; default: request)`,
  },
} as const;

/**
 * Parse `--max-cost` / `--budget-source` into router options. The source is
 * only meaningful with a budget, so it is dropped when `--max-cost` is absent.
 */
export function parseCliBudget(args: {
  'max-cost'?: string;
  'budget-source'?: string;
}): { maxCostUsd?: number; budgetSource?: BudgetSource } {
  const rawSource = args['budget-source'];
  if (rawSource !== undefined && !isBudgetSource(rawSource)) {
    throw new Error(`--budget-source must be one of ${BUDGET_SOURCES.join(', ')}, got ${rawSource}`);
  }
  if (!args['max-cost']) return {};
  const maxCostUsd = Number(args['max-cost']);
  if (!isFiniteNonNegativeBudget(maxCostUsd)) {
    throw new Error(`--max-cost must be a non-negative number, got ${args['max-cost']}`);
  }
  return rawSource ? { maxCostUsd, budgetSource: rawSource } : { maxCostUsd };
}
