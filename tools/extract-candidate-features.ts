#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { extractCandidateFeatures } from '../shared/lib/candidate-features.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'extract-candidate-features',
  description: 'Extract Arbiter candidate_features/v1 from a checkout and PR number',
  options: {
    checkout: { type: 'string', description: 'Candidate checkout directory' },
    pr: { type: 'string', description: 'GitHub pull request number' },
    'repo-dir': { type: 'string', description: 'Repository directory for GitHub evidence (default: checkout)' },
    'base-ref': { type: 'string', description: 'Base ref for checkout diff fallback' },
    offline: { type: 'boolean', description: 'Skip GitHub evidence collection' },
  },
  examples: [
    'npx tsx tools/extract-candidate-features.ts --checkout /path/to/worktree --pr 123',
    'npx tsx tools/extract-candidate-features.ts --checkout . --pr 123 --offline',
  ],
  async run({ args }) {
    const checkout = args.checkout as string | undefined;
    const pr = args.pr as string | undefined;
    if (!checkout) {
      throw new Error('--checkout is required');
    }
    if (!pr) {
      throw new Error('--pr is required');
    }

    const checkoutDir = resolve(checkout);
    const features = extractCandidateFeatures({
      checkoutDir,
      prNumber: pr,
      repoDir: args['repo-dir'] ? resolve(args['repo-dir'] as string) : checkoutDir,
      baseRef: args['base-ref'] as string | undefined,
      offline: Boolean(args.offline),
    });
    console.log(JSON.stringify(features, null, 2));
  },
});
