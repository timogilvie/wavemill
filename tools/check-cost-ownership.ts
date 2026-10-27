#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3077): fail when a second cost engine, a retired
 * cost-metering switch, or an unlisted pricing/session-path primitive
 * consumer appears outside the SDK bridge.
 *
 * Usage: npx tsx tools/check-cost-ownership.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { COST_OWNERSHIP_GUARD } from '../shared/lib/cost-ownership-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(COST_OWNERSHIP_GUARD, process.argv[2] ?? defaultRepoRoot);
}
