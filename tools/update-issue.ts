// @ts-nocheck
import { getIssue, updateIssue } from '../shared/lib/linear.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const identifier = args[0];
  const fileIndex = args.indexOf('--file');
  const filePath = fileIndex >= 0 ? args[fileIndex + 1] : null;

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
    const issue = await getIssue(identifier);
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
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
