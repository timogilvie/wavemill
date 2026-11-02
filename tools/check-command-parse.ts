#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3383): fail on any ad-hoc command parse inside the
 * native command substrate — a bare `argv[0]` read outside parseCommandArgv,
 * or a third-party shell tokeniser being imported.
 *
 * Usage: npx tsx tools/check-command-parse.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { COMMAND_PARSE_GUARD } from '../shared/lib/command-parse-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(COMMAND_PARSE_GUARD, process.argv[2] ?? defaultRepoRoot);
}
