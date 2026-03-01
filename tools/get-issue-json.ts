#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssue } from '../shared/lib/linear.js';

// Hard process-level timeout — kills the entire process if npx/tsx startup
// or network hangs before the per-request AbortSignal fires.
const PROCESS_TIMEOUT_MS = 30_000;
setTimeout(() => {
  console.error(`Process timeout: issue fetch exceeded ${PROCESS_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, PROCESS_TIMEOUT_MS).unref();

runTool({
  name: 'get-issue-json',
  description: 'Fetch a Linear issue and output as JSON',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'identifier',
    description: 'Issue identifier (e.g., HOK-123)',
    required: true,
  },
  examples: [
    'npx tsx tools/get-issue-json.ts HOK-671',
    'npx tsx tools/get-issue-json.ts HOK-123 | jq .',
  ],
  async run({ positional }) {
    const identifier = positional[0];

    if (!identifier) {
      console.error('Error: Issue identifier is required');
      process.exit(1);
    }

    const issue = await getIssue(identifier);
    console.log(JSON.stringify(issue, null, 2));
  },
});
