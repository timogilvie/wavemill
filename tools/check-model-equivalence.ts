#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3321): fail when challenge code decides model identity
 * with raw string equality instead of challengeModelIdsEquivalent.
 *
 * Usage: npx tsx tools/check-model-equivalence.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { MODEL_EQUIVALENCE_GUARD } from '../shared/lib/model-equivalence-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(MODEL_EQUIVALENCE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
