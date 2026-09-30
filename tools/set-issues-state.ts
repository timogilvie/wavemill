#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { setTaskIssuesState } from '../shared/lib/linear-write-gate.ts';

runTool({
  name: 'set-issues-state',
  description: 'Set the state of multiple Linear issues',
  options: {
    state: {
      type: 'string',
      description: 'State name',
      default: 'In Progress',
    },
  },
  positional: {
    name: 'identifiers...',
    description: 'One or more issue identifiers',
    required: true,
  },
  examples: [
    'npx tsx tools/set-issues-state.ts HOK-123 HOK-124',
    'npx tsx tools/set-issues-state.ts --state "Done" HOK-123 HOK-124',
  ],
  async run({ positional, args }) {
    if (!positional || positional.length === 0) {
      throw new Error('At least one issue identifier is required');
    }

    const stateName = args.state || 'In Progress';
    // Challengers are skipped; invalid/conflicting IDs are reported in
    // `failed` as non-retryable client errors (HOK-3115).
    const result = await setTaskIssuesState(positional, stateName);
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length > 0) {
      process.exit(1);
    }
  },
});
