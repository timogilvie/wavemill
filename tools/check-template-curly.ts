#!/usr/bin/env -S npx tsx
/**
 * Preflight guard: fail on a plain string literal that contains template
 * placeholder syntax (a template literal written with the wrong quotes).
 *
 * Usage: npx tsx tools/check-template-curly.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { TEMPLATE_CURLY_GUARD } from '../shared/lib/template-curly-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(TEMPLATE_CURLY_GUARD, process.argv[2] ?? defaultRepoRoot);
}
