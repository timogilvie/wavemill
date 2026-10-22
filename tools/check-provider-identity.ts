#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3143, enforced by HOK-3236): fail when executedModel is taken from the requested wire id.
 *
 * Usage: npx tsx tools/check-provider-identity.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { PROVIDER_IDENTITY_GUARD } from '../shared/lib/provider-identity-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(PROVIDER_IDENTITY_GUARD, process.argv[2] ?? defaultRepoRoot);
}
