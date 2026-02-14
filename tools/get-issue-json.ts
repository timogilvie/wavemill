#!/usr/bin/env node
// @ts-nocheck
import { getIssue } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

dotenv.config({ silent: true });

async function main() {
  const identifier = process.argv[2];

  if (!identifier) {
    console.error('Usage: npx tsx get-issue-json.ts HOK-671');
    process.exit(1);
  }

  try {
    const issue = await getIssue(identifier);
    console.log(JSON.stringify(issue, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
