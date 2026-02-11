#!/usr/bin/env node
// @ts-nocheck
import { getIssue, getOrCreateLabel, addLabelsToIssue } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

dotenv.config({ silent: true });

async function main() {
  const identifier = process.argv[2];
  const labelName = process.argv[3];

  if (!identifier || !labelName) {
    console.error('Usage: npx tsx add-issue-label.ts HOK-671 "Bug"');
    process.exit(1);
  }

  try {
    // Get the issue to find its team ID
    const issue = await getIssue(identifier);
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
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
