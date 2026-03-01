#!/usr/bin/env -S npx tsx
// Check if a Linear issue is in a completed state
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssueCompletionState } from '../shared/lib/linear.js';

runTool({
  name: 'get-issue-state',
  description: 'Check if a Linear issue is completed or active',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'identifier',
    description: 'Issue identifier (e.g., HOK-123)',
    required: true,
  },
  examples: ['npx tsx tools/get-issue-state.ts HOK-123'],
  async run({ positional }) {
    const identifier = positional[0];

    const issue = await getIssueCompletionState(identifier);

    // Check if issue is completed or canceled
    const isCompleted = !!(issue.completedAt || issue.canceledAt);

    // Output simple boolean for shell scripts
    console.log(isCompleted ? 'completed' : 'active');
  },
});
