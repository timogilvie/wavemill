#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3322): fail on a private Ready remediation in-flight
 * decision outside the one disposition (shared/lib/ready-remediation-disposition.{ts,sh}).
 *
 * Usage: npx tsx tools/check-ready-disposition.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { READY_DISPOSITION_GUARD } from '../shared/lib/ready-disposition-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(READY_DISPOSITION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
