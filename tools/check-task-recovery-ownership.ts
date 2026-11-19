#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3277): fail on a task-recovery decision or claim made
 * outside the canonical controller. Spec: `shared/lib/task-recovery-ownership-guard.ts`.
 *
 * Usage: npx tsx tools/check-task-recovery-ownership.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardsCli } from './lib/source-guard.ts';
import { TASK_RECOVERY_OWNERSHIP_GUARD, TASK_RECOVERY_WAKE_GUARD } from '../shared/lib/task-recovery-ownership-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardsCli([TASK_RECOVERY_OWNERSHIP_GUARD, TASK_RECOVERY_WAKE_GUARD], process.argv[2] ?? defaultRepoRoot);
}
