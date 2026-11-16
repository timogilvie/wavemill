#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3453, enforced by HOK-3236): fail on a shell-written
 * Ready `queueState` outside `MERGE_QUEUE_STATES` (shared/lib/merge-queue.ts).
 *
 * Usage: npx tsx tools/check-queue-state.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { QUEUE_STATE_GUARD } from '../shared/lib/queue-state-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(QUEUE_STATE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
