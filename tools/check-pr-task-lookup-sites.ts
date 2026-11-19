#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3271): fail on an ad-hoc PR-to-task lookup outside
 * shared/lib/pr-task-resolver.ts.
 *
 * Usage: npx tsx tools/check-pr-task-lookup-sites.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { PR_TASK_LOOKUP_GUARD } from '../shared/lib/pr-task-lookup-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(PR_TASK_LOOKUP_GUARD, process.argv[2] ?? defaultRepoRoot);
}
