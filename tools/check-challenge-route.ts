#!/usr/bin/env -S npx tsx
/**
 * HOK-3156 — assert a challenge pair's arms differ in exactly the varied stage.
 *
 * Prints `{status, ok, variedStage, driftedFields, identicalAtVariedStage, ...}`
 * as JSON. Exit codes: 0 = one-variable (identical-at-stage is reported, not
 * fatal), 3 = route drift, 2 = inputs unreadable.
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { checkChallengeRoute } from '../shared/lib/challenge-route-check.ts';

runTool({
  name: 'check-challenge-route',
  description: 'Check that two challenge arms differ only at the varied stage (one-variable invariant).',
  options: {
    stage: { type: 'string', description: 'Varied stage (plan|implementation|review); defaults to the intent stage' },
    intent: { type: 'string', description: 'Sealed challenge intent file (supplies any side not given below)' },
    'intent-json': { type: 'string', description: 'Sealed challenge intent as inline JSON' },
    'primary-feature-dir': { type: 'string', description: 'Primary feature dir; its .phase-config.json is the primary route' },
    'challenger-feature-dir': { type: 'string', description: 'Challenger feature dir; its .phase-config.json is the challenger route' },
    'primary-routing': { type: 'string', description: 'Primary .routing-complete-shaped file' },
    'challenger-routing': { type: 'string', description: 'Challenger .routing-complete-shaped file' },
    'repo-dir': { type: 'string', description: 'Repository directory (model registry for alias equivalence)' },
  },
  async run({ args }) {
    const outcome = checkChallengeRoute({
      stage: args.stage as string | undefined,
      intentPath: args.intent as string | undefined,
      intentJson: args['intent-json'] as string | undefined,
      primaryFeatureDir: args['primary-feature-dir'] as string | undefined,
      challengerFeatureDir: args['challenger-feature-dir'] as string | undefined,
      primaryRoutingPath: args['primary-routing'] as string | undefined,
      challengerRoutingPath: args['challenger-routing'] as string | undefined,
      repoDir: (args['repo-dir'] as string | undefined) || process.cwd(),
    });
    if (outcome.status === 'unreadable') {
      console.log(JSON.stringify(outcome));
      process.exit(2);
    }
    console.log(JSON.stringify({ status: outcome.status, ...outcome.result, sources: outcome.sources }));
    process.exit(outcome.status === 'drift' ? 3 : 0);
  },
});
