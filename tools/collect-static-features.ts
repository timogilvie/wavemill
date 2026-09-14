/**
 * collect-static-features — Thin CLI over `collectStaticFeatures`.
 *
 * This is the bare-checkout parity surface for HOK-2806: given a checkout
 * directory (and optionally a base ref or PR number), it emits the four S1
 * Static-group fields plus provenance as JSON. The output must match what
 * the wavemill post-completion collector produces for the same PR head.
 *
 * @example
 * ```sh
 * # Local checkout, diff against origin/main:
 * npx tsx tools/collect-static-features.ts --checkout . --base origin/main
 *
 * # PR head with CI-evidence build_ok fallback:
 * npx tsx tools/collect-static-features.ts --checkout . --pr 1234
 * ```
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { collectStaticFeatures } from '../shared/lib/static-features.ts';

runTool({
  name: 'collect-static-features',
  description:
    'Collect the S1 Static feature group (type_errors, lint_errors, build_ok, complexity_delta) from a checkout. HOK-2806.',
  options: {
    checkout: {
      type: 'string',
      description: 'Directory containing the candidate checkout (its HEAD is the candidate).',
    },
    base: {
      type: 'string',
      description: 'Base ref for the complexity diff (default: origin/main or main).',
    },
    pr: {
      type: 'string',
      description: 'PR number for CI-evidence fallback on build_ok.',
    },
    repo: {
      type: 'string',
      description: 'Repo directory for gh calls when different from --checkout.',
    },
    offline: {
      type: 'boolean',
      description: 'Skip network-touching operations (CI evidence, git fetch).',
    },
  },
  examples: [
    'npx tsx tools/collect-static-features.ts --checkout . --base origin/main',
    'npx tsx tools/collect-static-features.ts --checkout . --pr 1234',
  ],
  async run({ args }) {
    if (!args.checkout) {
      console.error('Error: --checkout is required.');
      process.exit(2);
    }
    const result = collectStaticFeatures({
      checkoutDir: args.checkout,
      baseRef: args.base,
      prNumber: args.pr,
      repoDir: args.repo ?? args.checkout,
      offline: args.offline === true,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  },
});
