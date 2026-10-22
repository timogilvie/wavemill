#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3176, enforced by HOK-3236): fail on a parking failure classifier outside shared/lib/failure-policy.ts.
 *
 * Usage: npx tsx tools/check-failure-policy.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { FAILURE_POLICY_GUARD } from '../shared/lib/failure-policy-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(FAILURE_POLICY_GUARD, process.argv[2] ?? defaultRepoRoot);
}
