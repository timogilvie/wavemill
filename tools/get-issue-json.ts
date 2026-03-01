#!/usr/bin/env node
import { getIssue } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

// Hard process-level timeout — kills the entire process if npx/tsx startup
// or network hangs before the per-request AbortSignal fires.
const PROCESS_TIMEOUT_MS = 30_000;
setTimeout(() => {
  console.error(`Process timeout: issue fetch exceeded ${PROCESS_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, PROCESS_TIMEOUT_MS).unref();

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const identifier: string | undefined = process.argv[2];

  if (!identifier) {
    console.error('Usage: npx tsx get-issue-json.ts HOK-671');
    process.exit(1);
  }

  try {
    const issue = await getIssue(identifier);
    console.log(JSON.stringify(issue, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error:', message);
    process.exit(1);
  }
}

main();
