#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3101/HOK-3374, enforced by HOK-3236): fail on a
 * private hook-TTL liveness check, and on any reintroduction of command-name
 * background-work classification inside deriveAgentBackgroundWork.
 *
 * Usage: npx tsx tools/check-hook-ttl.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { AGENT_BACKGROUND_WORK_GUARD, HOOK_TTL_GUARD } from '../shared/lib/hook-ttl-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const repoRoot = process.argv[2] ?? defaultRepoRoot;
  runGuardCli(HOOK_TTL_GUARD, repoRoot);
  runGuardCli(AGENT_BACKGROUND_WORK_GUARD, repoRoot);
}
