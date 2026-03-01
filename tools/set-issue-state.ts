#!/usr/bin/env node
import { setIssueState } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const identifier: string | undefined = process.argv[2];
  const stateName: string | undefined = process.argv[3];

  if (!identifier || !stateName) {
    console.error('Usage: npx tsx set-issue-state.ts HOK-123 "In Progress"');
    process.exit(1);
  }

  try {
    const result = await setIssueState(identifier, stateName);

    if (result.success) {
      console.log(`✓ ${identifier} → ${stateName}`);
      console.log(`  ${result.issue.url}`);
    } else {
      console.error('Failed to update issue state');
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error:', message);
    process.exit(1);
  }
}

main();
