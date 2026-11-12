#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3451, enforced by HOK-3236): fail on a private
 * challenge-arm state comparison outside the authoritative predicate helpers.
 *
 * Usage: npx tsx tools/check-challenge-arm-state.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { CHALLENGE_ARM_STATE_GUARD } from '../shared/lib/challenge-arm-state-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(CHALLENGE_ARM_STATE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
