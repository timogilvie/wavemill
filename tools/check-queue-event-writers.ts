#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3339): fail on any queue/CI/repair event write
 * outside the canonical module `shared/lib/queue-events.ts`.
 *
 * Usage: npx tsx tools/check-queue-event-writers.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { QUEUE_EVENTS_GUARD } from '../shared/lib/queue-events-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(QUEUE_EVENTS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
