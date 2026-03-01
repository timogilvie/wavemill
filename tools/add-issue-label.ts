#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssueForLabeling, getOrCreateLabel, addLabelsToIssue } from '../shared/lib/linear.js';

runTool({
  name: 'add-issue-label',
  description: 'Add a label to a Linear issue',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'identifier labelName',
    description: 'Issue identifier (e.g., HOK-123) and label name',
    required: true,
  },
  examples: [
    'npx tsx tools/add-issue-label.ts HOK-671 "Bug"',
    'npx tsx tools/add-issue-label.ts HOK-123 "Feature"',
  ],
  async run({ positional }) {
    const [identifier, labelName] = positional;

    if (!identifier || !labelName) {
      console.error('Error: Both issue identifier and label name are required');
      process.exit(1);
    }

    // Get the issue to find its team ID
    const issue = await getIssueForLabeling(identifier);
    if (!issue) {
      console.error(`Issue not found: ${identifier}`);
      process.exit(1);
    }

    const teamId = issue.team.id;

    // Get or create the label
    const label = await getOrCreateLabel(labelName, teamId);
    if (!label) {
      console.error(`Failed to get or create label: ${labelName}`);
      process.exit(1);
    }

    // Get current label IDs
    const currentLabelIds = issue.labels.nodes.map(l => l.id);

    // Check if label is already added
    if (currentLabelIds.includes(label.id)) {
      console.log(`Label "${labelName}" already exists on ${identifier}`);
      process.exit(0);
    }

    // Add the new label to the existing ones
    const updatedLabelIds = [...currentLabelIds, label.id];
    const result = await addLabelsToIssue(issue.id, updatedLabelIds);

    if (result.success) {
      console.log(`✓ Added label "${labelName}" to ${identifier}`);
    } else {
      console.error(`Failed to add label to ${identifier}`);
      process.exit(1);
    }
  },
});
