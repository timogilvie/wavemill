#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3457): fail when review scope guard refusals do not
 * record findings through writeMarker before exiting.
 *
 * Usage: npx tsx tools/check-scope-stop-record.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { scopeStopRecordGuard } from '../shared/lib/scope-stop-record-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

if (process.argv[1] === __filename) {
  runGuardCli(scopeStopRecordGuard, process.argv[2] ?? defaultRepoRoot);
}