#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3312, enforced by HOK-3236): fail on a new terminal-
 * cleanup decision outside shared/lib/terminal-inbox-cleanup.ts.
 *
 * Usage: npx tsx tools/check-cleanup-decision.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { CLEANUP_DECISION_GUARD } from '../shared/lib/cleanup-decision-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(CLEANUP_DECISION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
