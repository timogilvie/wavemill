#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3223): fail when a test or fixture hand-writes a
 * workflow-state `tasks: { ... }` literal instead of using the schema-validated
 * builders (tests/lib/task-builder.ts, tests/lib/state-fixtures.sh), or when
 * the seeded allowlist holds an entry that no longer needs it.
 *
 * Usage: npx tsx tools/check-test-task-literals.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTestTaskLiterals, formatTestTaskLiterals } from '../shared/lib/test-task-literal-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const result = checkTestTaskLiterals(process.argv[2] ?? defaultRepoRoot);
  const message = formatTestTaskLiterals(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
