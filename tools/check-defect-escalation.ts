#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3325): fail on any direct symptom-only issue creation
 * path outside the authorised seams.
 *
 * Usage: npx tsx tools/check-defect-escalation.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { DEFECT_ESCALATION_GUARD } from '../shared/lib/defect-escalation-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(DEFECT_ESCALATION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
