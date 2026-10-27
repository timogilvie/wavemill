#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3237, enforced by HOK-3236): fail on a test that
 * asserts against the source text of `shared/lib/**` or `tools/**` production
 * code. Call the function and compare observable behaviour instead.
 *
 * Usage: npx tsx tools/check-source-text-assertions.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { SOURCE_TEXT_ASSERTIONS_GUARD } from '../shared/lib/source-text-assertions-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(SOURCE_TEXT_ASSERTIONS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
