#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3373): fail on a workflow-state write that bypasses
 * the settlement gate, a Linear state write outside the derived renderer,
 * and a `git -C` / `mkdir -p` of a task path outside the task-worktree
 * resolver. Spec: `shared/lib/settled-attempt-guard.ts`.
 *
 * Usage: npx tsx tools/check-settled-attempt.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { SETTLED_ATTEMPT_GUARD } from '../shared/lib/settled-attempt-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(SETTLED_ATTEMPT_GUARD, process.argv[2] ?? defaultRepoRoot);
}
