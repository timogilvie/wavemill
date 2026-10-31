#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3369): fail when a site reintroduces one of the three
 * bugs the one executed-model resolver fixes.
 *
 * Usage: npx tsx tools/check-executed-model-resolver.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { EXECUTED_MODEL_RESOLVER_GUARD } from '../shared/lib/executed-model-resolver-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(EXECUTED_MODEL_RESOLVER_GUARD, process.argv[2] ?? defaultRepoRoot);
}
