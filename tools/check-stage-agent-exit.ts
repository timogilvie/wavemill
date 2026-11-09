#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3426): fail on any stage settle decision that reads the
 * pane descendant count (`agentProcessLive === false`) instead of the one
 * recorded exit fact (`TaskProgress.agentExited`).
 *
 * Usage: npx tsx tools/check-stage-agent-exit.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STAGE_AGENT_EXIT_GUARD } from '../shared/lib/stage-agent-exit-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(STAGE_AGENT_EXIT_GUARD, process.argv[2] ?? defaultRepoRoot);
}
