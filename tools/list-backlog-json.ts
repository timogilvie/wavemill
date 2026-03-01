#!/usr/bin/env node
import { getBacklogForScoring } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

// Hard process-level timeout — kills the entire process if npx/tsx startup
// or network hangs before the per-request AbortSignal fires.
const PROCESS_TIMEOUT_MS = 30_000;
setTimeout(() => {
  console.error(`Process timeout: backlog fetch exceeded ${PROCESS_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, PROCESS_TIMEOUT_MS).unref();

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const projectName: string | null = process.argv[2] || null;

  try {
    const backlog = await getBacklogForScoring(projectName);
    console.log(JSON.stringify(backlog, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error:', message);
    process.exit(1);
  }
}

main();
