#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3313): fail on an ad-hoc `recovery_failure`
 * terminalization or pane-text identity sniffing outside the two allowed
 * sites (maybe_retry_failed_stage, phase_launch_gate).
 *
 * Usage: npx tsx tools/check-recovery-failure-paths.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { RECOVERY_FAILURE_PATHS_GUARD } from '../shared/lib/recovery-failure-paths-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(RECOVERY_FAILURE_PATHS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
