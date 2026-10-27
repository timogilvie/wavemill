#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3314): fail on a private queue-alert state / severity /
 * episode decision outside shared/lib/queue-inference-status.ts and
 * tools/queue-alert-projection.ts.
 *
 * Usage: npx tsx tools/check-queue-alert.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { QUEUE_ALERT_GUARD } from '../shared/lib/queue-alert-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(QUEUE_ALERT_GUARD, process.argv[2] ?? defaultRepoRoot);
}
