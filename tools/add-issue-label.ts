#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssueForLabeling, getOrCreateLabel, addLabelsToIssue } from '../shared/lib/linear.ts';
import { linearWriteTargetOrSkip } from '../shared/lib/linear-write-gate.ts';

runTool({
  name: 'add-issue-label',
  description: 'Add a label to a Linear issue',
  options: {
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
    const [taskId, labelName] = positional;

    if (!taskId || !labelName) {
      throw new Error('Both issue identifier and label name are required');
    }

    // Challengers are a logged no-op; invalid/conflicting IDs throw (HOK-3115).
    const identifier = linearWriteTargetOrSkip(taskId);
    if (!identifier) return;

    // Get the issue to find its team ID
    const issue = await getIssueForLabeling(identifier);
    if (!issue) {
      throw new Error(`Issue not found: ${identifier}`);
    }

    const teamId = issue.team.id;

    // Get or create the label
    const label = await getOrCreateLabel(labelName, teamId);
    if (!label) {
      throw new Error(`Failed to get or create label: ${labelName}`);
    }

    // Get current label IDs
    const currentLabelIds = issue.labels.nodes.map(l => l.id);

    // Check if label is already added
    if (currentLabelIds.includes(label.id)) {
      console.log(`Label "${labelName}" already exists on ${identifier}`);
      return;
    }

    // Add the new label to the existing ones
    const updatedLabelIds = [...currentLabelIds, label.id];
    const result = await addLabelsToIssue(issue.id, updatedLabelIds);

    if (result.success) {
      console.log(`✓ Added label "${labelName}" to ${identifier}`);
    } else {
      throw new Error(`Failed to add label to ${identifier}`);
    }
  },
});
