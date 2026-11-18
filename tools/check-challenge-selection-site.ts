#!/usr/bin/env -S npx tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { CHALLENGE_SELECTION_SITE_GUARD } from '../shared/lib/challenge-selection-site-guard.ts';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  runGuardCli(CHALLENGE_SELECTION_SITE_GUARD, process.argv[2] ?? join(dirname(__filename), '..'));
}
