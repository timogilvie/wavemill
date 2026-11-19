#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3511, enforced by HOK-3236): fail on a private
 * model→{agent, provider} derivation or a `.phase-config.json` stage-block
 * write outside `writePersistedContract`.
 *
 * Usage: npx tsx tools/check-stage-executor.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STAGE_EXECUTOR_GUARD } from '../shared/lib/stage-executor-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(STAGE_EXECUTOR_GUARD, process.argv[2] ?? defaultRepoRoot);
}
