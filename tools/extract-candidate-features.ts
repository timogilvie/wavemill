#!/usr/bin/env node

/**
 * CLI tool: Extract candidate features from a PR and checkout.
 *
 * Usage:
 *   npx tsx tools/extract-candidate-features.ts --checkout <dir> --pr <number>
 *
 * Outputs JSON to stdout containing the complete candidate_features/v1 object.
 *
 * @module tools/extract-candidate-features
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  extractCandidateFeatures,
  type ExtractCandidateFeaturesOptions,
} from '../shared/lib/candidate-features.ts';

runTool({
  name: 'extract-candidate-features',
  description: 'Extract candidate features (candidate_features/v1) from a PR and checkout',
  run: async ({ args, positional }) => {
    const checkout = args.checkout as string | undefined;
    const prNumber = args.pr as string | undefined;
    const baseRef = args['base-ref'] as string | undefined;

    if (!checkout) {
      console.error('Error: --checkout is required');
      process.exit(1);
    }

    if (!prNumber) {
      console.error('Error: --pr is required');
      process.exit(1);
    }

    const options: ExtractCandidateFeaturesOptions = {
      checkoutDir: checkout,
      prNumber,
      baseRef,
    };

    try {
      const features = await extractCandidateFeatures(options);
      console.log(JSON.stringify(features, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to extract candidate features: ${message}`);
      process.exit(1);
    }
  },
});
