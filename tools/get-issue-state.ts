#!/usr/bin/env node
// Check if a Linear issue is in a completed state
import { getIssueCompletionState } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const identifier: string | undefined = process.argv[2];

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
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error:', message);
    process.exit(1);
  }
}

main();
