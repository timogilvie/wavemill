#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3338): fail when a site writes queue/CI/repair events
 * outside the one validated writer.
 *
 * Usage: npx tsx tools/check-queue-event-writers.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { QUEUE_EVENT_WRITER_GUARD } from '../shared/lib/queue-event-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(QUEUE_EVENT_WRITER_GUARD, process.argv[2] ?? defaultRepoRoot);
}
