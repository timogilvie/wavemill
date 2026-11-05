// allow-journey-wall-clock-budget: this file *is* the guard spec; its pattern
// table names every forbidden shape.
/**
 * Preflight guard for the one-journey-budget invariant (HOK-3425, enforced by
 * HOK-3236): a golden journey's work is bound by monitor ticks, never by the
 * wall clock. Each journey declares one total tick budget next to its waits
 * (journey_set_tick_budget N), and journey_finish fails on a tick overrun. The
 * runner's wall-clock elapsed time stays in the `passed in Ns / N ticks` line
 * and the `timing-journeys` artifact — reported, never gated.
 *
 * Shapes caught in the journey subtree (tests/journeys/**):
 * - the retired JOURNEY_BUDGET_SECONDS variable (read or rescaled anywhere);
 * - a bare `BUDGET` wall-clock variable (the two retired private budgets).
 *
 * The JOURNEY_BUDGET_SECONDS pattern is global (the token has no legitimate
 * use anywhere); the generic `BUDGET` pattern is scoped to tests/journeys/ so
 * production shell may keep an unrelated BUDGET variable (e.g. a token budget).
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

const JOURNEYS_PREFIX = 'tests/journeys/' as const;

export const JOURNEY_WALL_CLOCK_BUDGET_GUARD: GuardSpec = {
  name: 'journey-wall-clock-budget',
  findingNoun: 'journey wall-clock budget site(s)',
  suppressionMarker: 'allow-journey-wall-clock-budget',
  allowlistFile: 'tools/journey-wall-clock-budget-allowlist.txt',
  invariantPaths: [
    'shared/lib/journey-wall-clock-budget-guard.ts',
    // The guard's self-test necessarily spells out every forbidden shape as a
    // fixture, so it is invariant source too and is never scanned.
    'tools/check-journey-wall-clock-budget.test.ts',
  ],
  excludedPrefixes: [
    // Default list minus `tests/` so this guard still scans journey code.
    'features/', '.wavemill/', 'node_modules/', 'worktrees/', 'spike/', '.git/', 'shared/validators/',
  ],
  includeTests: true,
  patterns: [
    {
      name: 'retired-journey-budget-seconds',
      description: 'JOURNEY_BUDGET_SECONDS is retired — a journey is bound by monitor ticks (journey_set_tick_budget), not wall-clock seconds',
      lang: 'both',
      re: /JOURNEY_BUDGET_SECONDS/,
    },
    {
      name: 'journey-wall-clock-budget-var',
      description: 'a bare BUDGET wall-clock variable in a journey — declare a monitor-tick budget with journey_set_tick_budget instead',
      lang: 'sh',
      re: /\bBUDGET\b/,
      scopedPaths: [JOURNEYS_PREFIX],
    },
  ],
  remediation: [
    'A golden journey measures its work in monitor ticks, not seconds:',
    '  declare one total budget with journey_set_tick_budget N next to the',
    '  journey\'s waits; journey_finish fails on a tick overrun. Wall-clock',
    '  elapsed time is reported (the `passed in Ns / N ticks` line and the',
    '  timing-journeys artifact), never gated. A hang is caught by the CI job',
    '  timeout and the harness\'s per-wait safety deadline.',
  ],
};
