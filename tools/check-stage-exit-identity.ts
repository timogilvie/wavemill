#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3313, enforced by HOK-3236): fail on a direct
 * `wavemill_reconcile_terminal … recovery_failure` outside the bounded-retry
 * exhaustion sites, and on any pane-capture pipeline that uses identity-
 * signalling text to decide agent identity.
 *
 * Usage: npx tsx tools/check-stage-exit-identity.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STAGE_EXIT_IDENTITY_GUARD } from '../shared/lib/stage-exit-identity-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(STAGE_EXIT_IDENTITY_GUARD, process.argv[2] ?? defaultRepoRoot);
}
