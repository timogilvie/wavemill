#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssue } from '../shared/lib/linear.js';

runTool({
  name: 'get-issue',
  description: 'Fetch and display a Linear issue',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'identifier',
    description: 'Issue identifier (e.g., HOK-123)',
    required: true,
  },
  examples: [
    'npx tsx tools/get-issue.ts HOK-671',
    'npx tsx tools/get-issue.ts HOK-123',
  ],
  async run({ positional }) {
    const identifier = positional[0];

    if (!identifier) {
      console.error('Error: Issue identifier is required');
      process.exit(1);
    }

    const issue = await getIssue(identifier);

    console.log(`\n${issue.identifier}: ${issue.title}`);
    console.log(`State: ${issue.state?.name || 'Unknown'}`);
    console.log(`Priority: ${issue.priority || 'None'}`);
    console.log(`Assignee: ${issue.assignee?.name || 'Unassigned'}`);
    console.log(`Project: ${issue.project?.name || 'None'}`);
    console.log('Labels:', issue.labels?.nodes?.map((l) => l.name).join(', ') || 'None');

    if (issue.parent) {
      console.log(`Parent: ${issue.parent.identifier} - ${issue.parent.title}`);
    }

    console.log(`\nDescription:\n${issue.description || 'No description'}`);

    if (issue.children?.nodes?.length > 0) {
      console.log(`\nSub-tasks (${issue.children.nodes.length}):`);
      issue.children.nodes.forEach((child, i) => {
        console.log(`  ${i + 1}. ${child.identifier}: ${child.title} [${child.state?.name}]`);
        if (child.description) {
          const desc = child.description.length > 150
            ? child.description.substring(0, 150) + '...'
            : child.description;
          console.log(`     ${desc}`);
        }
      });
    }

    if (issue.comments?.nodes?.length > 0) {
      console.log(`\nComments (${issue.comments.nodes.length}):`);
      issue.comments.nodes.forEach((comment) => {
        console.log(`  [${comment.user?.name || 'Unknown'}] ${comment.body}`);
      });
    }
  },
});
