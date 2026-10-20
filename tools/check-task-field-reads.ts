#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3224): fail when shell or untyped TypeScript reads a
 * task-record field the workflow-state schema does not declare.
 *
 * Usage: npx tsx tools/check-task-field-reads.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTaskFieldReads, formatTaskFieldReads } from '../shared/lib/task-field-read-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  try {
    const result = checkTaskFieldReads(process.argv[2] ?? defaultRepoRoot);
    const message = formatTaskFieldReads(result);
    if (!result.ok) {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  } catch (err) {
    console.error(`check-task-field-reads: ${(err as Error).message}`);
    process.exit(1);
  }
}
