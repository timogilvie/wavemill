#!/usr/bin/env -S npx tsx
// Persist the route decision (HOK-3098) carried by a route artifact into a
// feature dir's routing.jsonl. Best-effort: always exits 0 so it can never
// block a launch.

import { readFileSync } from 'node:fs';
import { recordRouteDecisionFromArtifact } from '../shared/lib/route-decision.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'record-route-decision',
  description: 'Append the route decision from a route artifact to <feature-dir>/routing.jsonl',
  options: {
    'feature-dir': {
      type: 'string',
      description: 'Feature artifact directory that owns routing.jsonl',
    },
    'route-file': {
      type: 'string',
      description: 'Route artifact JSON (route.json or .post-expansion-route.json)',
    },
  },
  examples: [
    'npx tsx tools/record-route-decision.ts --feature-dir features/my-task --route-file /tmp/session-HOK-1-route.json',
  ],
  async run({ args }) {
    if (!args['feature-dir']) throw new Error('--feature-dir is required');
    if (!args['route-file']) throw new Error('--route-file is required');

    let artifact: unknown = null;
    try {
      artifact = JSON.parse(readFileSync(args['route-file'], 'utf-8'));
    } catch {
      console.log(JSON.stringify({ outcome: 'invalid' }));
      return;
    }
    const outcome = await recordRouteDecisionFromArtifact(args['feature-dir'], artifact);
    console.log(JSON.stringify({ outcome }));
  },
});
