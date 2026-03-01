#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklogForScoring } from '../shared/lib/linear.js';

// Hard process-level timeout
const PROCESS_TIMEOUT_MS = 30_000;
setTimeout(() => {
  console.error(`Process timeout: backlog fetch exceeded ${PROCESS_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, PROCESS_TIMEOUT_MS).unref();

runTool({
  name: 'list-backlog-json',
  description: 'Fetch Linear backlog and output as JSON',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'project',
    description: 'Project name (optional)',
  },
  examples: [
    'npx tsx tools/list-backlog-json.ts',
    'npx tsx tools/list-backlog-json.ts "My Project"',
  ],
  async run({ positional }) {
    const projectName = positional[0] || null;

    const backlog = await getBacklogForScoring(projectName);
    console.log(JSON.stringify(backlog, null, 2));
  },
});
