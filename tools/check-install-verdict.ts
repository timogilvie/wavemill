#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3315): fail when code decides dependency-install
 * health with a private lockfile byte-hash/diff instead of the one
 * semantic verdict (shared/lib/deps-drift.ts).
 *
 * Usage: npx tsx tools/check-install-verdict.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { INSTALL_VERDICT_GUARD } from '../shared/lib/install-verdict-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(INSTALL_VERDICT_GUARD, process.argv[2] ?? defaultRepoRoot);
}
