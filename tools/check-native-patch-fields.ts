#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3500, enforced by HOK-3236): fail on a second
 * NativePatch payload field check outside the contract schema and its
 * residual runtime.
 *
 * Usage: npx tsx tools/check-native-patch-fields.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { NATIVE_PATCH_FIELDS_GUARD } from '../shared/lib/native-patch-fields-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(NATIVE_PATCH_FIELDS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
