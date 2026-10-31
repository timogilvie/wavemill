#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3371): fail on a Ready-failure branch that bypasses the
 * single failure policy.
 *
 * Usage: npx tsx tools/check-ready-failure-policy.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { READY_FAILURE_POLICY_GUARD } from '../shared/lib/ready-failure-policy-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(READY_FAILURE_POLICY_GUARD, process.argv[2] ?? defaultRepoRoot);
}