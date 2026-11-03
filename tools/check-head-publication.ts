#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3370): fail on a branch publication outside the one
 * seam (`publishStageHead`) — a `git push` instruction in agent prompts or
 * mill code — and on raw head-SHA freshness comparisons outside the one
 * primitive (`change-identity.ts`).
 *
 * Usage: npx tsx tools/check-head-publication.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { HEAD_PUBLICATION_GUARD } from '../shared/lib/head-publication-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(HEAD_PUBLICATION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
