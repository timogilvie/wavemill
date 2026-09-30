#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { setIssueState } from '../shared/lib/linear.ts';
import { linearWriteTargetOrSkip } from '../shared/lib/linear-write-gate.ts';

runTool({
  name: 'set-issue-state',
  description: 'Set the state of a Linear issue',
  options: {
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
      throw new Error('Both identifier and state name are required');
    }

    // Challengers are a logged no-op; invalid/conflicting IDs throw (HOK-3115).
    const linearId = linearWriteTargetOrSkip(identifier);
    if (!linearId) return;

    const result = await setIssueState(linearId, stateName);

    if (result.success) {
      console.log(`✓ ${linearId} → ${stateName}`);
      console.log(`  ${result.issue.url}`);
    } else {
      throw new Error('Failed to update issue state');
    }
  },
});
