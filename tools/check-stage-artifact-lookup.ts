import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STAGE_ARTIFACT_LOOKUP_GUARD } from '../shared/lib/stage-artifact-lookup-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  runGuardCli(STAGE_ARTIFACT_LOOKUP_GUARD, process.argv[2] ?? defaultRepoRoot);
}
