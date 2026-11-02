#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3374): fail on any reintroduction of command-name
 * background-work classification — the deleted HOK-3222 classifier symbols,
 * or controller-regex use / command matching / process IO / a second probe
 * inside the deriveAgentBackgroundWork body.
 *
 * Usage: npx tsx tools/check-agent-background-work.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { AGENT_BACKGROUND_WORK_GUARD } from '../shared/lib/agent-background-work-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(AGENT_BACKGROUND_WORK_GUARD, process.argv[2] ?? defaultRepoRoot);
}
