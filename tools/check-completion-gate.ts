#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3514): fail when a native `.coding-complete` write path
 * bypasses `evaluateCodingCompletionGate`.
 *
 * Usage: npx tsx tools/check-completion-gate.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { COMPLETION_GATE_GUARD } from '../shared/lib/completion-gate-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(COMPLETION_GATE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
