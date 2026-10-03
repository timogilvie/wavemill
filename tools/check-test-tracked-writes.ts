import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTestTrackedWrites,
  formatTestTrackedWrites,
} from '../shared/lib/test-tracked-write-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const result = checkTestTrackedWrites(process.argv[2] ?? defaultRepoRoot);
  const message = formatTestTrackedWrites(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
