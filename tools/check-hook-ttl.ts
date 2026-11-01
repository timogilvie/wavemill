#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3101, enforced by HOK-3236): fail on a private hook-TTL liveness check outside the task-progress primitive.
 *
 * Usage: npx tsx tools/check-hook-ttl.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { HOOK_TTL_GUARD } from '../shared/lib/hook-ttl-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(HOOK_TTL_GUARD, process.argv[2] ?? defaultRepoRoot);
}
