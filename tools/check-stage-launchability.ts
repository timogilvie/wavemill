#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3142, enforced by HOK-3236): fail when a routing exit can return without finalizeDecision.
 *
 * Usage: npx tsx tools/check-stage-launchability.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STAGE_LAUNCHABILITY_GUARD } from '../shared/lib/stage-launchability-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(STAGE_LAUNCHABILITY_GUARD, process.argv[2] ?? defaultRepoRoot);
}
