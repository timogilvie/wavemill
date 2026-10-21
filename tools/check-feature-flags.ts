#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3235): every `WAVEMILL_*` env token has an entry in
 * `docs/feature-flags.md` or in the seeded plumbing baseline
 * `tools/feature-flags-baseline.txt`; the open-shadow count stays at or under
 * {@link MAX_OPEN_SHADOWS}; shadow and expiring rows carry owner-issue,
 * removal-issue, added date and remove-by (at most 30 days out).
 *
 * Usage: npx tsx tools/check-feature-flags.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFeatureFlags, formatFeatureFlagResult } from '../shared/lib/feature-flag-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const result = checkFeatureFlags({ repoDir: process.argv[2] ?? defaultRepoRoot });
  const message = formatFeatureFlagResult(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
