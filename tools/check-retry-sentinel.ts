#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-2924, enforced by HOK-3236): fail on a private retry counter outside shared/lib/bounded-retry.{sh,ts}.
 *
 * Usage: npx tsx tools/check-retry-sentinel.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { RETRY_SENTINEL_GUARD } from '../shared/lib/retry-sentinel-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(RETRY_SENTINEL_GUARD, process.argv[2] ?? defaultRepoRoot);
}
