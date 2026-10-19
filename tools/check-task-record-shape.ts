#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3220): fail when a file other than
 * shared/lib/workflow-state.ts declares its own workflow-state task shape.
 *
 * Usage: npx tsx tools/check-task-record-shape.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTaskRecordShapes, formatTaskRecordShapes } from '../shared/lib/task-record-shape-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const result = checkTaskRecordShapes(process.argv[2] ?? defaultRepoRoot);
  const message = formatTaskRecordShapes(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
