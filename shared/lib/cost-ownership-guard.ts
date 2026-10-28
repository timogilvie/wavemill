// allow-cost-ownership: this file *is* the cost-ownership guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the cost-ownership split (HOK-3077).
 *
 * Wavemill has exactly one cost engine — `@hokusai/costs`, measured over a
 * task's owned sessions through `shared/lib/sdk-task-cost/meter.ts` (HOK-3328)
 * — plus two Wavemill-only primitives:
 *
 * - the rate table `shared/lib/pricing/model-pricing.ts` (and OpenRouter
 *   exact lookups in `pricing/openrouter-exact-pricing.ts`); per-call dollar
 *   figures are `@hokusai/costs` arithmetic via `priceUsageUsd`;
 * - the session-file join `shared/lib/wavemill-session-paths.ts`.
 *
 * This guard keeps it that way:
 *
 * 1. The retired legacy engine and its rollback/shadow switches never come
 *    back (`retired-cost-engine`, `retired-cost-switch`).
 * 2. No private per-token price formula outside the pricing primitive
 *    (`per-token-arithmetic`).
 * 3. The primitives are imported only by the SDK bridge and the named
 *    Wavemill decision-policy sites (router budgets, judge pricing, native
 *    budgets, backfills) listed with a reason in
 *    `tools/cost-ownership-allowlist.txt` (`pricing-primitive-import`,
 *    `session-path-import`, `openrouter-generation-import`). A new consumer
 *    of workflow cost reads the SDK bridge (`sdk-task-cost/meter.ts`) instead.
 *
 * The primitives themselves are the invariant source and are never scanned.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const COST_OWNERSHIP_GUARD: GuardSpec = {
  name: 'cost-ownership',
  findingNoun: 'cost-ownership violation(s)',
  suppressionMarker: 'allow-cost-ownership',
  allowlistFile: 'tools/cost-ownership-allowlist.txt',
  invariantPaths: [
    'shared/lib/pricing/model-pricing.ts',
    'shared/lib/pricing/openrouter-exact-pricing.ts',
    'shared/lib/wavemill-session-paths.ts',
    'shared/lib/cost-ownership-guard.ts',
  ],
  patterns: [
    {
      name: 'retired-cost-engine',
      description: 'retired legacy cost engine (HOK-3077) — meter workflow cost with sdk-task-cost/meter.ts (live) or sdk-task-cost/recompute.ts (backfill)',
      lang: 'ts',
      re: /\b(?:computeWorkflowCost(?:WithExactPricing)?|recalculateWorkflowCost|computeNativeWorkflowCost|resolveAuthoritativeWorkflowCost)\b/,
    },
    {
      name: 'retired-cost-switch',
      description: 'retired cost-metering switch (HOK-3077) — the SDK is the only engine; roll back with a revert, not an env flag',
      lang: 'both',
      re: /\bWAVEMILL_(?:SDK_COST_METERING_SHADOW|COST_METERING_LEGACY|DISABLE_OPENROUTER_COST)\b/,
    },
    {
      name: 'per-token-arithmetic',
      description: 'private per-token price formula — price through @hokusai/costs with priceUsageUsd() from shared/lib/sdk-task-cost/price-overrides.ts',
      lang: 'ts',
      re: /CostPerMTok\b[^;]*\/\s*1_?000_?000\b|\b1_?000_?000\b[^;]*CostPerMTok\b/,
    },
    {
      name: 'pricing-primitive-import',
      description: 'pricing primitive import outside the SDK bridge / listed decision-policy sites — read workflow cost from the SDK bridge (sdk-task-cost/meter.ts)',
      lang: 'ts',
      re: /from\s+['"][^'"]*\/pricing\/model-pricing(?:\.ts)?['"]|import\(\s*['"][^'"]*\/pricing\/model-pricing(?:\.ts)?['"]/,
    },
    {
      name: 'session-path-import',
      description: 'session-path primitive import outside the listed session-discovery sites — join sessions through shared/lib/session-adapters.ts',
      lang: 'ts',
      re: /from\s+['"][^'"]*\/wavemill-session-paths(?:\.ts)?['"]|import\(\s*['"][^'"]*\/wavemill-session-paths(?:\.ts)?['"]/,
    },
    {
      name: 'openrouter-generation-import',
      description: 'direct OpenRouter generation-cost lookup — go through shared/lib/pricing/openrouter-exact-pricing.ts so exact charges flow into the SDK events',
      lang: 'ts',
      re: /from\s+['"][^'"]*\/openrouter-generation-api(?:\.ts)?['"]|import\(\s*['"][^'"]*\/openrouter-generation-api(?:\.ts)?['"]/,
    },
  ],
  remediation: [
    'Wavemill has one cost engine: @hokusai/costs over the task\'s owned sessions (HOK-3077,',
    'HOK-3328). Live evals meter through sdk-task-cost/meter.ts, backfills recompute through',
    'sdk-task-cost/recompute.ts, and readers use the persisted WorkflowCost* shape in',
    'shared/lib/workflow-cost.ts. Rates (loadPricingTable) and session discovery',
    '(resolveProjectsDirs) are primitives: the SDK adapter only hands rates and',
    'transcript locations to @hokusai/costs; the rest are reserved for',
    'Wavemill-only decision policy (router budgets, judge pricing, native budgets, backfills).',
  ],
};
