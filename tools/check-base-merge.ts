#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3385): fail on a `git fetch` / `git merge` /
 * `git rebase` instruction in an agent prompt surface, and on a mill-side
 * base merge outside the one primitive (`updateBranchWithBase`).
 *
 * Usage: npx tsx tools/check-base-merge.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { BASE_MERGE_GUARD } from '../shared/lib/base-merge-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(BASE_MERGE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
