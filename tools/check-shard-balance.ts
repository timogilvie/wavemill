/**
 * check-shard-balance - Preflight enforcement for CI shard partitioning (HOK-2939).
 *
 * Thin CLI over shared/lib/shard-balance.ts. Reads the shell/unit/custom shard
 * counts straight from .github/workflows/ci.yml (so this check can never
 * disagree with the real matrix), the registered test lists from the runners'
 * arrays (the single registration source), and the checked-in weights
 * manifest, then fails when:
 *
 * - any registered test would be missing from or duplicated in the computed
 *   shard assignment (REQ-F1);
 * - the weights manifest is malformed, contains non-positive values, or
 *   references tests that no longer exist;
 * - any shard's estimated total exceeds 130% of the median shard estimate,
 *   unless a single named indivisible test alone exceeds the bound (REQ-F3),
 *   in which case the test is printed and the check passes.
 *
 * Runs in `npm run test:preflight`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkShardBalance, formatShardBalance } from '../shared/lib/shard-balance.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const repoDir = process.argv[2] ?? defaultRepoRoot;
  try {
    const result = checkShardBalance(repoDir);
    const message = formatShardBalance(result);
    if (!result.ok) {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  } catch (error) {
    console.error(`shard-balance: FAILED: ${(error as Error).message}`);
    process.exit(1);
  }
}
