#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3358): fail on a `challengeAborted` write outside the
 * one arm-termination recorder (`shared/lib/arm-termination.ts`). Spec:
 * `shared/lib/arm-termination-guard.ts`.
 *
 * Usage: npx tsx tools/check-arm-termination-recorder.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { ARM_TERMINATION_GUARD } from '../shared/lib/arm-termination-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(ARM_TERMINATION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
