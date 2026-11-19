#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3476, enforced by HOK-3236): fail on a hand-built
 * TaskAttemptRef-shaped object literal or a retry_of/retryOf assignment
 * outside shared/lib/attempt-identity.{ts,sh}.
 *
 * Usage: npx tsx tools/check-attempt-lineage.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { ATTEMPT_LINEAGE_GUARD } from '../shared/lib/attempt-lineage-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(ATTEMPT_LINEAGE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
