#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { setIssueState } from '../shared/lib/linear.js';

runTool({
  name: 'set-issue-state',
  description: 'Set the state of a Linear issue',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'identifier stateName',
    description: 'Issue identifier and state name',
    required: true,
  },
  examples: [
    'npx tsx tools/set-issue-state.ts HOK-123 "In Progress"',
    'npx tsx tools/set-issue-state.ts HOK-123 "Done"',
  ],
  async run({ positional }) {
    const [identifier, stateName] = positional;

    if (!identifier || !stateName) {
      console.error('Error: Both identifier and state name are required');
      process.exit(1);
    }

    const result = await setIssueState(identifier, stateName);

    if (result.success) {
      console.log(`✓ ${identifier} → ${stateName}`);
      console.log(`  ${result.issue.url}`);
    } else {
      console.error('Failed to update issue state');
      process.exit(1);
    }
  },
});
