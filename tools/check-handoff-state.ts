#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3450, enforced by HOK-3236): fail on a private
 * Ready→Tend handoff-state comparison outside the handoff module.
 *
 * Usage: npx tsx tools/check-handoff-state.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { HANDOFF_STATE_GUARD } from '../shared/lib/handoff-state-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(HANDOFF_STATE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
