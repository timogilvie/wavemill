#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3359): fail on a raw `tmux kill-window` / `tmux
 * kill-pane` / `agent_terminate_in_pane` call against a task window outside
 * the one stage-agent teardown (`shared/lib/stage-teardown.sh`
 * `stage_agent_teardown`). Spec: `shared/lib/stage-teardown-guard.ts`.
 *
 * Usage: npx tsx tools/check-stage-teardown.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STAGE_TEARDOWN_GUARD } from '../shared/lib/stage-teardown-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(STAGE_TEARDOWN_GUARD, process.argv[2] ?? defaultRepoRoot);
}
