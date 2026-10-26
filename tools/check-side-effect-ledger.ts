#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3183, enforced by HOK-3236): fail when external side-effect sites grow past the recorded budget.
 *
 * Usage: npx tsx tools/check-side-effect-ledger.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { SIDE_EFFECT_LEDGER_GUARD } from '../shared/lib/side-effect-ledger-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(SIDE_EFFECT_LEDGER_GUARD, process.argv[2] ?? defaultRepoRoot);
}
