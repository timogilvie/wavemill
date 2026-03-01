#!/usr/bin/env -S npx tsx
// @ts-nocheck
// Check if a Linear issue is in a completed state
import { getIssueCompletionState } from '../shared/lib/linear.js';
import '../shared/lib/env.js';

async function main() {
  const identifier = process.argv[2];

  if (!identifier) {
    console.error('Usage: npx tsx get-issue-state.ts HOK-123');
    process.exit(1);
  }

  try {
    const issue = await getIssueCompletionState(identifier);

    // Check if issue is completed or canceled
    const isCompleted = !!(issue.completedAt || issue.canceledAt);

    // Output simple boolean for shell scripts
    console.log(isCompleted ? 'completed' : 'active');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
