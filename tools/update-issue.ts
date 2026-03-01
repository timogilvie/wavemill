import '../shared/lib/env.js';
import { getIssueBasic, updateIssue } from '../shared/lib/linear.js';
import fs from "node:fs/promises";

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  const identifier: string | undefined = args[0];
  const fileIndex: number = args.indexOf('--file');
  const filePath: string | undefined = fileIndex >= 0 ? args[fileIndex + 1] : undefined;

  if (!identifier || !filePath) {
    console.error('Usage: npx tsx update-issue.ts HOK-356 --file /tmp/expanded.md');
    process.exit(1);
  }

  try {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error:', message);
    process.exit(1);
  }
}

main();
