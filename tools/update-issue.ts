#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getIssueBasic, updateIssue } from '../shared/lib/linear.ts';
import { linearWriteTargetOrSkip } from '../shared/lib/linear-write-gate.ts';
import fs from "node:fs/promises";

runTool({
  name: 'update-issue',
  description: 'Update a Linear issue description from a file',
  options: {
    file: { type: 'string', description: 'File containing the description' },
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
    const filePath = args.file;

    if (!filePath) {
      throw new Error('--file is required');
    }

    // Challengers are a logged no-op; invalid/conflicting IDs throw (HOK-3115).
    const identifier = linearWriteTargetOrSkip(positional[0]);
    if (!identifier) return;

    // Read description from file
    const description = await fs.readFile(filePath, 'utf-8');

    if (!description.trim()) {
      throw new Error('file is empty');
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
      throw new Error('Update failed');
    }
  },
});
