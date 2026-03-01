#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssueBasic, updateIssue } from '../shared/lib/linear.js';
import fs from "node:fs/promises";

runTool({
  name: 'update-issue',
  description: 'Update a Linear issue description from a file',
  options: {
    file: { type: 'string', description: 'File containing the description' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'identifier',
    description: 'Issue identifier (e.g., HOK-123)',
    required: true,
  },
  examples: [
    'npx tsx tools/update-issue.ts HOK-356 --file /tmp/expanded.md',
  ],
  async run({ args, positional }) {
    const identifier = positional[0];
    const filePath = args.file;

    if (!filePath) {
      console.error('Error: --file is required');
      process.exit(1);
    }

    // Read description from file
    const description = await fs.readFile(filePath, 'utf-8');

    if (!description.trim()) {
      console.error('Error: file is empty');
      process.exit(1);
    }

    // Fetch issue to get its internal ID
    console.log(`Fetching ${identifier}...`);
    const issue = await getIssueBasic(identifier);
    console.log(`Found: ${issue.identifier} - ${issue.title}`);

    // Update the issue
    console.log(`Updating description (${description.length} chars)...`);
    const result = await updateIssue(issue.id, { description });

    if (result.success) {
      console.log(`Updated: ${result.issue.url}`);
    } else {
      console.error('Update failed');
      process.exit(1);
    }
  },
});
