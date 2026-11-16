#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3382): fail when a native stage re-introduces a private
 * deadline for harness time, or spells the model-time budget with its retired
 * wall-clock name.
 *
 * Usage: npx tsx tools/check-native-harness-deadlines.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { NATIVE_HARNESS_DEADLINE_GUARD } from '../shared/lib/native-harness-deadline-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(NATIVE_HARNESS_DEADLINE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
