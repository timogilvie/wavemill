#!/usr/bin/env node
// @ts-nocheck
import { setIssueState } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const identifier = process.argv[2];
  const stateName = process.argv[3];

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
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
