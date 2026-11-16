#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3499, enforced by HOK-3236): fail on a second Release
 * Readiness field grammar outside the shared parser.
 *
 * Usage: npx tsx tools/check-release-readiness-grammar.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { RELEASE_READINESS_GUARD } from '../shared/lib/release-readiness-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(RELEASE_READINESS_GUARD, process.argv[2] ?? defaultRepoRoot);
}
