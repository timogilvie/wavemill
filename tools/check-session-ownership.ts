#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3328): fail when a session's stage label, a stage
 * window comparison, or a task-cost total is derived anywhere but the
 * session-ownership record and the `@hokusai/costs` report.
 *
 * Usage: npx tsx tools/check-session-ownership.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { SESSION_OWNERSHIP_GUARD } from '../shared/lib/session-ownership-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(SESSION_OWNERSHIP_GUARD, process.argv[2] ?? defaultRepoRoot);
}
