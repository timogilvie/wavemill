#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3423): fail on inbox membership or an attention
 * decision computed outside `deriveAttentionItems` (shared/lib/attention.ts),
 * or on a raw `.needs-attention` read outside the escalation module.
 *
 * Usage: npx tsx tools/check-attention.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { ATTENTION_GUARD } from '../shared/lib/attention-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(ATTENTION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
