#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3316, HOK-3449): fail on a wm:blocked write/clear or a
 * raw `gh pr comment` outside the merge-label reconciler and the merge-status
 * poster, and on a reconciler label write outside `wm:ready` / `wm:blocked`.
 *
 * Usage: npx tsx tools/check-merge-block-writers.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardsCli } from './lib/source-guard.ts';
import {
  MERGE_BLOCK_WRITERS_GUARD,
  RECONCILER_LABEL_SCOPE_GUARD,
} from '../shared/lib/merge-block-writers-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardsCli(
    [MERGE_BLOCK_WRITERS_GUARD, RECONCILER_LABEL_SCOPE_GUARD],
    process.argv[2] ?? defaultRepoRoot,
  );
}
