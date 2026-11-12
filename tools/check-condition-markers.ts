#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3172/HOK-3452): fail when code writes or reads the
 * eval-failure decision marker without going through its condition-keyed
 * helpers (eval_failure_decision_record / eval_failure_decision_current).
 *
 * Usage: npx tsx tools/check-condition-markers.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { CONDITION_MARKERS_GUARD } from '../shared/lib/condition-markers-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(CONDITION_MARKERS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
