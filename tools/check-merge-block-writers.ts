#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3316): fail on a wm:blocked write/clear or a raw `gh pr comment` outside the merge-label reconciler and the merge-status poster.
 *
 * Usage: npx tsx tools/check-merge-block-writers.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { MERGE_BLOCK_WRITERS_GUARD } from '../shared/lib/merge-block-writers-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(MERGE_BLOCK_WRITERS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
