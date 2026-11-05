#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3425, enforced by HOK-3236): fail on a journey that
 * reads or rescales a wall-clock budget. A journey's work is bound by monitor
 * ticks (journey_set_tick_budget), not seconds.
 *
 * Usage: npx tsx tools/check-journey-wall-clock-budget.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { JOURNEY_WALL_CLOCK_BUDGET_GUARD } from '../shared/lib/journey-wall-clock-budget-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(JOURNEY_WALL_CLOCK_BUDGET_GUARD, process.argv[2] ?? defaultRepoRoot);
}
