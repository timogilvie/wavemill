#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3329, enforced by HOK-3236): fail on private
 * test-world lifetime or tmux-resolution shapes outside the one primitive.
 *
 * Usage: npx tsx tools/check-test-world-lifetime.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { WORLD_LIFETIME_GUARD } from '../shared/lib/world-lifetime-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(WORLD_LIFETIME_GUARD, process.argv[2] ?? defaultRepoRoot);
}