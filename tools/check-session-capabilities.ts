#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3102, enforced by HOK-3236): fail when a producer re-derives a session capability instead of asking the resolver.
 *
 * Usage: npx tsx tools/check-session-capabilities.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { SESSION_CAPABILITIES_GUARD } from '../shared/lib/session-capabilities-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(SESSION_CAPABILITIES_GUARD, process.argv[2] ?? defaultRepoRoot);
}
